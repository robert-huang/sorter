/**
 * AniList per-type list importer (Scope B). One pass = one user × one
 * MediaType (`ANIME` or `MANGA`) per the plan's per-type design: the user
 * picks `Import Anime` or `Import Manga` independently so each type's
 * scrape-lock acquisition, request cost, and refresh cadence is isolated.
 *
 * `username` is a REQUIRED parameter — the importer is fully decoupled
 * from any notion of an "active" user, so a friend's list can be
 * imported into the same DB as your own. Each call:
 *
 *   1. Resolves `username` → AniList User.id via {@link RESOLVE_USER_QUERY}
 *      and upserts the `anilist_user` row, capturing the stable id.
 *      Unknown usernames raise {@link AnilistUnknownUserError}.
 *   2. Acquires the per-source scrape lock (NOT per-user — AniList rate
 *      limits by IP, so two users importing simultaneously would just
 *      throttle each other anyway).
 *   3. Paginates every page of the user's list into memory (no DB writes
 *      yet). Refreshes the scrape lock between pages so a long import
 *      doesn't go stale.
 *   4. Single transactional batch at the end (all writes scoped to
 *      `(anilist_user_id, type)`):
 *        a. DELETE every `media_list_entry` row for this user where the
 *           referenced media is of this type. Cascades to
 *           `media_custom_list_membership` via FK so memberships clear
 *           automatically.
 *        b. UPSERT `anilist_user` (id, name, fetched_at, updated_at) so
 *           renames are reflected.
 *        c. UPSERT parent metadata (studio, tag, media) deduped across
 *           the whole import.
 *        d. Junction rebuild: DELETE + INSERT `media_studio` /
 *           `media_tag` for every media we just imported so a
 *           tag/studio removed on AniList disappears locally.
 *        e. INSERT fresh `media_list_entry` rows.
 *        f. UPSERT every `custom_list` (user, name, type) tuple
 *           referenced by the imported entries.
 *        g. INSERT `media_custom_list_membership` rows.
 *        h. GC `custom_list` rows for this user/type that have no
 *           memberships (handles list renames + list deletions).
 *        i. Stamp `_meta.last_full_refresh:<USER_ID>:<TYPE>`.
 *   5. Fire `onAutoPushRequested` so the cloud panel can push the fresh
 *      `anilist.sqlite` to Drive.
 *   6. Release the scrape lock.
 *
 * **Why no mid-import checkpoint** (this is the design change that drove
 * the rewrite):
 *
 * AniList sorts `mediaList` by `UPDATED_TIME_DESC`. When the user adds
 * or edits an entry it jumps to the top of page 1 and shifts every
 * later entry down a slot. So "page 3" yesterday is a different set
 * of entries than "page 3" today. A page-level resume checkpoint
 * would either silently miss newly-changed entries or re-fetch entries
 * that just shifted down — neither is safe. The fix is to fetch
 * everything fresh on every import; the cost is small enough (≈9 req
 * for an average 600-entry user) that retry-from-scratch is the right
 * trade-off vs the data-correctness risk.
 *
 * The same property gives us "removed-from-list entries actually
 * disappear locally" for free — the wipe in step 4a clears stale rows
 * the new import doesn't re-INSERT.
 *
 * Media rows themselves are NOT deleted on wipe — they may still be
 * referenced by another user's `media_list_entry`, by `media_favourite`,
 * by `media_character`, or by other junctions. Garbage-collecting
 * orphaned media is left to a future sweep.
 */

import {
  acquireScrapeLock,
  refreshScrapeLock,
  releaseScrapeLock,
} from '../../db/syncManifest';
import { ANILIST_SOURCE_ID } from './anilistSource';
import type { AnilistImportContext, SqlBindable } from './context';
import { buildSetMetaStmt, lastFullRefreshKey } from './meta';
import { emitProgress } from './progress';
import {
  collectCustomListIdentities,
  mapAnilistUserRow,
  mapMediaListEntryRow,
  mapMediaRow,
  mapMediaStudioRows,
  mapMediaTagRows,
  mapStudioRows,
  mapTagRows,
} from './mappers';
import { LIST_PAGE_QUERY, RESOLVE_USER_QUERY } from './queries';
import type {
  AnilistListPageResponse,
  AnilistMediaListEntryGql,
  AnilistMediaType,
  AnilistUserResolveResponse,
  AnilistUserRow,
  MediaListEntryRow,
  MediaRow,
  StudioRow,
  TagRow,
} from './types';

export const DEFAULT_LIST_PAGE_SIZE = 50;

/** Thrown when another tab / call already holds the scrape lock for this source. */
export class AnilistScrapeLockHeldError extends Error {
  readonly sourceId: string;
  constructor(sourceId: string) {
    super(
      `AniList scrape already in progress for source '${sourceId}'. Wait for it to finish or close the other tab.`,
    );
    this.name = 'AnilistScrapeLockHeldError';
    this.sourceId = sourceId;
  }
}

/**
 * Thrown when AniList's `User(name:)` resolution returns `null`. The
 * caller passed a username AniList has no record of (typo, deleted
 * account, …). The importer aborts before acquiring the scrape lock
 * so the user can retry without waiting.
 */
export class AnilistUnknownUserError extends Error {
  readonly username: string;
  constructor(username: string) {
    super(`AniList has no user named '${username}'. Check the spelling and try again.`);
    this.name = 'AnilistUnknownUserError';
    this.username = username;
  }
}

export type ImportAnilistListOptions = {
  username: string;
  type: AnilistMediaType;
  /** Page size for the GraphQL query. Defaults to {@link DEFAULT_LIST_PAGE_SIZE}. */
  perPage?: number;
};

export type ImportAnilistListResult = {
  type: AnilistMediaType;
  /** AniList User.id resolved from the requested username. */
  anilistUserId: number;
  /** Username the importer ran against (echoed for caller bookkeeping). */
  username: string;
  /** Pages fetched during this import session. */
  pagesFetched: number;
  /** Total list entries written in the final wipe-and-rebuild batch. */
  entriesWritten: number;
};

// ──────────────────────────────────────────────────────────────────────
// SQL helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Build an UPSERT statement (`INSERT … ON CONFLICT(pk) DO UPDATE`) from a
 * column list. PK columns are excluded from the SET clause since updating
 * them to themselves would be a no-op (and SQLite forbids updating PK
 * columns in ON CONFLICT clauses anyway).
 */
function buildUpsertSql(table: string, pkCols: string[], allCols: string[]): string {
  const placeholders = allCols.map(() => '?').join(', ');
  const updates = allCols
    .filter((c) => !pkCols.includes(c))
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  return `INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT(${pkCols.join(', ')}) DO UPDATE SET ${updates}`;
}

const MEDIA_COLS = [
  'id',
  'type',
  'title_english',
  'title_romaji',
  'title_native',
  'cover_image',
  'format',
  'status',
  'episodes',
  'chapters',
  'start_year',
  'start_month',
  'start_day',
  'end_year',
  'end_month',
  'end_day',
  'season',
  'season_year',
  'mean_score',
  'favourites',
  'country_of_origin',
  'genres_json',
  'synonyms_json',
  'fetched_at',
  'updated_at',
] as const;

const MEDIA_LIST_ENTRY_COLS = [
  'anilist_user_id',
  'media_id',
  'score',
  'status',
  'repeat',
  'started_year',
  'started_month',
  'started_day',
  'completed_year',
  'completed_month',
  'completed_day',
  'anilist_created_at',
  'anilist_updated_at',
  'fetched_at',
  'updated_at',
] as const;

const ANILIST_USER_COLS = ['id', 'name', 'fetched_at', 'updated_at'] as const;
const CUSTOM_LIST_COLS = [
  'anilist_user_id',
  'name',
  'media_type',
  'fetched_at',
  'updated_at',
] as const;

export const MEDIA_UPSERT_SQL = buildUpsertSql('media', ['id'], [...MEDIA_COLS]);
export const STUDIO_UPSERT_SQL = buildUpsertSql('studio', ['id'], ['id', 'name', 'fetched_at']);
export const TAG_UPSERT_SQL = buildUpsertSql('tag', ['name'], ['name', 'fetched_at']);
export const ANILIST_USER_UPSERT_SQL = buildUpsertSql(
  'anilist_user',
  ['id'],
  [...ANILIST_USER_COLS],
);
export const CUSTOM_LIST_UPSERT_SQL = buildUpsertSql(
  'custom_list',
  ['anilist_user_id', 'name', 'media_type'],
  [...CUSTOM_LIST_COLS],
);
// Private to importer — favourites uses a different schema for its entries.
// Plain INSERT would also work (wipe runs first) but UPSERT keeps the
// statement reusable if a future revision drops the wipe.
const MEDIA_LIST_ENTRY_UPSERT_SQL = buildUpsertSql(
  'media_list_entry',
  ['anilist_user_id', 'media_id'],
  [...MEDIA_LIST_ENTRY_COLS],
);

export function mediaRowToParams(row: MediaRow): SqlBindable[] {
  return MEDIA_COLS.map((c) => row[c]);
}

function listEntryRowToParams(row: MediaListEntryRow): SqlBindable[] {
  return MEDIA_LIST_ENTRY_COLS.map((c) => row[c]);
}

function anilistUserRowToParams(row: AnilistUserRow): SqlBindable[] {
  return ANILIST_USER_COLS.map((c) => row[c]);
}

// ──────────────────────────────────────────────────────────────────────
// Final-batch builder (wipe + reinsert)
// ──────────────────────────────────────────────────────────────────────

type Statement = { sql: string; params: readonly SqlBindable[] };

/**
 * Dedup a list of `mediaList` entries by `media.id` keeping the FIRST
 * occurrence. See callers for why duplicates can happen (AniList
 * pagination-during-mutation) and why first-wins is the right tie-break.
 */
function dedupEntriesByMediaId(
  entries: AnilistMediaListEntryGql[],
): AnilistMediaListEntryGql[] {
  if (entries.length < 2) return entries;
  const seen = new Set<number>();
  const out: AnilistMediaListEntryGql[] = [];
  for (const e of entries) {
    if (seen.has(e.media.id)) continue;
    seen.add(e.media.id);
    out.push(e);
  }
  return out;
}

/**
 * Build the single transactional batch that wipes (user, type)'s list
 * entries and rewrites every row from the accumulated entries. Returns
 * statements in the order they must execute:
 *
 *   1. Upsert `anilist_user` so renames stick and the FK below resolves.
 *   2. Wipe `media_list_entry` for (user, type). Cascades to
 *      `media_custom_list_membership` via FK.
 *   3. Upsert studio / tag / media parents (deduped).
 *   4. Junction rebuild (`media_studio`, `media_tag`) for imported media.
 *   5. Insert fresh `media_list_entry` rows.
 *   6. Upsert `custom_list` rows for every (user, name, type) referenced.
 *   7. Insert `media_custom_list_membership` rows.
 *   8. GC orphan `custom_list` rows for this (user, type) — handles list
 *      renames and deletions on AniList side.
 *   9. Stamp `_meta.last_full_refresh:<USER_ID>:<TYPE>`.
 */
function buildListImportStatements(
  entries: AnilistMediaListEntryGql[],
  anilistUser: AnilistUserRow,
  type: AnilistMediaType,
  now: number,
): Statement[] {
  // Dedup by media.id BEFORE anything else. Every downstream loop
  // (parent metadata, junctions, list entries, custom-list memberships)
  // assumes one row per media; a duplicate would blow PK / UNIQUE
  // constraints on `media_list_entry`, `media_studio`, `media_tag`,
  // and `media_custom_list_membership` simultaneously.
  //
  // Duplicates can arrive from:
  //   - Pagination overlap during AniList list mutations (UPDATED_TIME_DESC
  //     re-orders entries between pages while the importer is mid-fetch).
  //   - A retry path that re-injected an in-flight page.
  // Keep FIRST occurrence — earlier pages are the most recently updated
  // snapshot in AniList's UPDATED_TIME_DESC ordering.
  entries = dedupEntriesByMediaId(entries);

  const stmts: Statement[] = [];

  // 1. Upsert the user row first so the FK on media_list_entry resolves
  //    on a freshly-installed DB. Refreshing name covers AniList renames.
  stmts.push({
    sql: ANILIST_USER_UPSERT_SQL,
    params: anilistUserRowToParams(anilistUser),
  });

  // 2. Wipe (user, type) entries. Scoped via the media table so an
  //    anime refresh never touches manga rows, and via anilist_user_id
  //    so importing your list doesn't nuke a friend's. Runs even when
  //    entries is empty — captures the "user cleared their list" case.
  stmts.push({
    sql:
      'DELETE FROM media_list_entry ' +
      'WHERE anilist_user_id = ? ' +
      '  AND media_id IN (SELECT id FROM media WHERE type = ?)',
    params: [anilistUser.id, type],
  });

  if (entries.length === 0) {
    // No parents / junctions / inserts to write. Still GC orphan custom
    // lists (in case the user cleared their list AND deleted lists) and
    // stamp the refresh time so the panel reflects "we ran the import."
    stmts.push(buildCustomListGcStatement(anilistUser.id, type));
    const stampStmt = buildSetMetaStmt(lastFullRefreshKey(anilistUser.id, type), now);
    stmts.push({ sql: stampStmt.sql, params: stampStmt.params ?? [] });
    return stmts;
  }

  // 3. Parent metadata — dedup before insert so a studio shared by ten
  //    media yields one UPSERT instead of ten.
  const studios = new Map<number, StudioRow>();
  const tags = new Map<string, TagRow>();
  const media = new Map<number, MediaRow>();

  for (const entry of entries) {
    const m = entry.media;
    media.set(m.id, mapMediaRow(m, now));
    for (const s of mapStudioRows(m, now)) studios.set(s.id, s);
    for (const t of mapTagRows(m, now)) tags.set(t.name, t);
  }

  for (const s of studios.values()) {
    stmts.push({ sql: STUDIO_UPSERT_SQL, params: [s.id, s.name, s.fetched_at] });
  }
  for (const t of tags.values()) {
    stmts.push({ sql: TAG_UPSERT_SQL, params: [t.name, t.fetched_at] });
  }
  for (const m of media.values()) {
    stmts.push({ sql: MEDIA_UPSERT_SQL, params: mediaRowToParams(m) });
  }

  // 4. Junction rebuild — wipe-then-rewrite per affected media so a
  //    tag/studio removed on AniList disappears locally. These
  //    junctions are global (no user dim), so wiping is safe across
  //    users: if another user also has this media, their next import
  //    will re-INSERT the same junction rows.
  const affectedIds = [...media.keys()];
  const placeholders = affectedIds.map(() => '?').join(', ');
  stmts.push({
    sql: `DELETE FROM media_studio WHERE media_id IN (${placeholders})`,
    params: affectedIds,
  });
  stmts.push({
    sql: `DELETE FROM media_tag WHERE media_id IN (${placeholders})`,
    params: affectedIds,
  });
  for (const entry of entries) {
    for (const ms of mapMediaStudioRows(entry.media)) {
      stmts.push({
        sql: 'INSERT INTO media_studio (media_id, studio_id, sort_order) VALUES (?, ?, ?)',
        params: [ms.media_id, ms.studio_id, ms.sort_order],
      });
    }
    for (const mt of mapMediaTagRows(entry.media)) {
      stmts.push({
        sql: 'INSERT INTO media_tag (media_id, tag_name, rank) VALUES (?, ?, ?)',
        params: [mt.media_id, mt.tag_name, mt.rank],
      });
    }
  }

  // 5. Fresh list entries (parents + user are upserted above, so FKs
  //    are safe).
  for (const entry of entries) {
    const row = mapMediaListEntryRow(entry, anilistUser.id, now);
    stmts.push({
      sql: MEDIA_LIST_ENTRY_UPSERT_SQL,
      params: listEntryRowToParams(row),
    });
  }

  // 6. Custom lists — upsert every (user, name, type) triple this
  //    import touched. UPSERT (not plain INSERT) so existing rows from
  //    previous imports stick around with updated fetched/updated_at.
  //    Orphans get GC'd in step 8.
  const identities = collectCustomListIdentities(entries, anilistUser.id);
  for (const ident of identities) {
    stmts.push({
      sql: CUSTOM_LIST_UPSERT_SQL,
      params: [ident.anilist_user_id, ident.name, ident.media_type, now, now],
    });
  }

  // 7. Memberships — wipe in step 2 cascaded these away (FK to
  //    media_list_entry), so we INSERT fresh. The FK back to
  //    custom_list (added in step 6) resolves because we just upserted
  //    every name we're about to reference.
  //
  //    `customLists` is dedupped per-entry — the AniList field is
  //    user-curated so duplicate names within one entry shouldn't
  //    happen, but the `media_custom_list_membership` PK is
  //    (anilist_user_id, media_id, custom_list_name, media_type) and
  //    a duplicate would blow the whole transaction.
  for (const entry of entries) {
    const seenNames = new Set<string>();
    for (const name of entry.customLists ?? []) {
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      stmts.push({
        sql:
          'INSERT INTO media_custom_list_membership ' +
          '(anilist_user_id, media_id, custom_list_name, media_type) ' +
          'VALUES (?, ?, ?, ?)',
        params: [anilistUser.id, entry.media.id, name, entry.media.type],
      });
    }
  }

  // 8. GC orphan custom_list rows for this (user, type). A list with
  //    zero memberships means either the user renamed/deleted it on
  //    AniList, OR they removed every entry from it. Either way the
  //    chip should disappear from the UI.
  stmts.push(buildCustomListGcStatement(anilistUser.id, type));

  // 9. Stamp full-refresh time inside the same transaction so the wipe
  //    + writes + stamp commit atomically.
  const stampStmt = buildSetMetaStmt(lastFullRefreshKey(anilistUser.id, type), now);
  stmts.push({ sql: stampStmt.sql, params: stampStmt.params ?? [] });

  return stmts;
}

/**
 * Delete custom_list rows for (user, type) that have zero memberships.
 * Runs as the last data-write step of every import so renames /
 * deletions on the AniList side don't leave stale empty chips in the UI.
 *
 * Note that this is scoped per (user, type), not per user: an "ANIME"
 * import doesn't GC a user's MANGA custom lists.
 */
function buildCustomListGcStatement(anilistUserId: number, type: AnilistMediaType): Statement {
  return {
    sql:
      'DELETE FROM custom_list ' +
      'WHERE anilist_user_id = ? AND media_type = ? AND NOT EXISTS (' +
      '  SELECT 1 FROM media_custom_list_membership ' +
      '  WHERE anilist_user_id = custom_list.anilist_user_id ' +
      '    AND custom_list_name = custom_list.name ' +
      '    AND media_type = custom_list.media_type)',
    params: [anilistUserId, type],
  };
}

// ──────────────────────────────────────────────────────────────────────
// Public entry
// ──────────────────────────────────────────────────────────────────────

export async function importAnilistList(
  ctx: AnilistImportContext,
  options: ImportAnilistListOptions,
): Promise<ImportAnilistListResult> {
  const { username, type } = options;
  const perPage = options.perPage ?? DEFAULT_LIST_PAGE_SIZE;

  // Resolve username → User.id BEFORE acquiring the scrape lock so a
  // typo doesn't tie up the lock for the duration of the GraphQL
  // request. The transport has its own rate-limit handling, so this
  // single request can't go faster than AniList allows even outside
  // the lock.
  emitProgress(ctx.onProgress, { kind: 'resolving-user', username });
  const resolveResponse = await ctx.executeQuery<AnilistUserResolveResponse>(
    RESOLVE_USER_QUERY,
    { username },
  );
  if (!resolveResponse?.User) {
    throw new AnilistUnknownUserError(username);
  }
  const anilistUserRow = mapAnilistUserRow(resolveResponse.User, ctx.now());

  const acquired = acquireScrapeLock(ANILIST_SOURCE_ID, ctx.now());
  if (!acquired) {
    throw new AnilistScrapeLockHeldError(ANILIST_SOURCE_ID);
  }
  const lockToken = acquired.token;

  try {
    // Accumulate every page in memory. Per the wipe-and-rebuild
    // contract, no DB writes happen until every page has been fetched
    // successfully — a mid-import error leaves the local DB untouched.
    const accumulated: AnilistMediaListEntryGql[] = [];
    let page = 1;
    let pagesFetched = 0;

    while (true) {
      const response = await ctx.executeQuery<AnilistListPageResponse>(LIST_PAGE_QUERY, {
        username,
        type,
        page,
        perPage,
      });
      pagesFetched += 1;

      const pageData = response?.Page;
      const entries = pageData?.mediaList ?? [];
      accumulated.push(...entries);
      emitProgress(ctx.onProgress, {
        kind: 'fetching-page',
        what: 'list',
        page,
        itemsSoFar: accumulated.length,
      });

      refreshScrapeLock(ANILIST_SOURCE_ID, lockToken, ctx.now());

      if (!pageData?.pageInfo?.hasNextPage) {
        break;
      }
      page += 1;
    }

    const now = ctx.now();
    // Dedup at the import boundary so `entriesWritten` reflects the
    // true row count after dedup (pagination overlap can yield the same
    // media id on two pages — see `dedupEntriesByMediaId`). The same
    // dedup is applied again inside `buildListImportStatements` as a
    // defensive measure for any direct callers, but here it's a no-op
    // since `dedupedEntries` is already unique.
    const dedupedEntries = dedupEntriesByMediaId(accumulated);
    const stmts = buildListImportStatements(dedupedEntries, anilistUserRow, type, now);
    emitProgress(ctx.onProgress, { kind: 'writing', statements: stmts.length });
    await ctx.db.execBatch(stmts);

    if (ctx.onAutoPushRequested) {
      await ctx.onAutoPushRequested();
    }

    emitProgress(ctx.onProgress, { kind: 'done' });
    return {
      type,
      anilistUserId: anilistUserRow.id,
      username,
      pagesFetched,
      entriesWritten: dedupedEntries.length,
    };
  } finally {
    releaseScrapeLock(ANILIST_SOURCE_ID, lockToken);
  }
}
