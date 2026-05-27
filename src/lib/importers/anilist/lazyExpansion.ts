/**
 * Per-media lazy character + staff expansion. Called from:
 *   - The Phase-D detail panel when it first opens for a media.
 *   - The per-entry refresh button (also in the detail panel).
 *
 * Differences from the list importer:
 *   - **No scrape lock.** Lazy expansion is single-request, user-triggered,
 *     and fast — gating it behind the scrape lock would dead-end the
 *     detail panel while a long ListPage import is running. The
 *     transport's sequential queue still serializes the actual HTTP
 *     traffic per tab.
 *   - **No autopush.** Per the plan, lazy expansion marks `anilist.sqlite`
 *     dirty (`onDirtyIncrement` hook) but never auto-pushes — Phase D's
 *     cloud panel surfaces "N pending changes" and a manual "Push now"
 *     button for the user to flush.
 *   - **Caps at 2 character pages (50 entries)**, staff at 1 page. Per
 *     the plan §A; a "Load more characters" affordance would lift the cap
 *     in a follow-up.
 *
 * Junction rebuild semantics: `DELETE FROM media_character WHERE
 * media_id = ?` cascades through `character_voice_actor` via the composite
 * FK, then fresh junction rows are re-INSERTed. A character/staff that
 * was previously cached but no longer appears for this media is dropped
 * from the junction; the parent `character` / `staff` rows stay (no
 * upward cascade), so favourites / other-media junctions referencing
 * them keep working.
 *
 * Pre-condition: the `media` row for `mediaId` must already exist (list
 * import or favourites import created it). The function does not upsert
 * `media` itself — the GraphQL response intentionally only fetches the
 * detail subgraph, not the media metadata, so we have no fresh field
 * values for `media` to upsert.
 */

import type { AnilistImportContext, SqlBindable } from './context';
import {
  mapCharacterRow,
  mapCharacterVoiceActorRows,
  mapMediaCharacterRows,
  mapStaffRow,
} from './mappers';
import { emitProgress } from './progress';
import { buildMediaDetailQuery } from './queries';
import type {
  AnilistMediaCharacterEdgeGql,
  AnilistMediaDetailResponse,
  AnilistMediaStaffEdgeGql,
  AnilistStaffGql,
  AnilistStaffLanguage,
  CharacterRow,
  CharacterVoiceActorRow,
  MediaCharacterRow,
  StaffRow,
} from './types';

export const DEFAULT_DETAIL_PER_PAGE = 25;
export const DEFAULT_CHARACTER_PAGE_CAP = 2;
export const DEFAULT_VOICE_ACTOR_LANGUAGE: AnilistStaffLanguage = 'JAPANESE';

export type ExpandAnilistMediaDetailOptions = {
  /** Per-page size for both characters and staff connections. */
  perPage?: number;
  /**
   * Max number of `characters` connection pages to fetch. v1 default 2
   * (50 entries) per AniList plan; bump if a "Load more" affordance lands.
   */
  charactersMaxPages?: number;
  /**
   * VA language to fetch from AniList and to persist in
   * `character_voice_actor.language`. Single source of truth — the value
   * is injected into the GraphQL `voiceActors(language: …)` filter via
   * `buildMediaDetailQuery` AND used as the row value passed to
   * `mapCharacterVoiceActorRows`, so the query and the DB write cannot
   * drift. v1 default: JAPANESE.
   */
  voiceActorLanguage?: AnilistStaffLanguage;
};

export type ExpandAnilistMediaDetailResult = {
  mediaId: number;
  /** Number of character connection pages we actually fetched (≤ cap). */
  characterPagesFetched: number;
  /** Number of `media_character` rows written after the rebuild. */
  charactersWritten: number;
  /** Number of `staff` rows touched by the staff connection's first page. */
  staffWritten: number;
  /** Number of `character_voice_actor` rows written (JP-only in v1). */
  voiceActorsWritten: number;
};

// ──────────────────────────────────────────────────────────────────────
// SQL building blocks
// ──────────────────────────────────────────────────────────────────────

// character and staff used to share a column list, but the schemas
// have diverged:
//   - character gained name_alternatives_json / name_alternatives_spoiler_json
//   - staff gained language_v2
// so each table now has its own column tuple + upsert helper. The
// structural similarity is still useful for tests but no longer for
// code reuse.

export const CHARACTER_COLS = [
  'id',
  'name_full',
  'name_native',
  'name_alternatives_json',
  'name_alternatives_spoiler_json',
  'image',
  'age',
  'gender',
  'favourites',
  'fetched_at',
  'updated_at',
] as const;

export const STAFF_COLS = [
  'id',
  'name_full',
  'name_native',
  'image',
  'age',
  'gender',
  'language_v2',
  'favourites',
  'fetched_at',
  'updated_at',
] as const;

function buildPersonUpsertSql(table: string, cols: readonly string[]): string {
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols
    .filter((c) => c !== 'id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT(id) DO UPDATE SET ${updates}`;
}

export const CHARACTER_UPSERT_SQL = buildPersonUpsertSql('character', CHARACTER_COLS);
export const STAFF_UPSERT_SQL = buildPersonUpsertSql('staff', STAFF_COLS);

export function characterRowToParams(row: CharacterRow): SqlBindable[] {
  return CHARACTER_COLS.map((c) => row[c]);
}

export function staffRowToParams(row: StaffRow): SqlBindable[] {
  return STAFF_COLS.map((c) => row[c]);
}

// ──────────────────────────────────────────────────────────────────────
// Public entry
// ──────────────────────────────────────────────────────────────────────

export async function expandAnilistMediaDetail(
  ctx: AnilistImportContext,
  mediaId: number,
  options: ExpandAnilistMediaDetailOptions = {},
): Promise<ExpandAnilistMediaDetailResult | null> {
  const perPage = options.perPage ?? DEFAULT_DETAIL_PER_PAGE;
  const maxCharPages = options.charactersMaxPages ?? DEFAULT_CHARACTER_PAGE_CAP;
  const language = options.voiceActorLanguage ?? DEFAULT_VOICE_ACTOR_LANGUAGE;
  // Build the query once with the resolved language so both the GraphQL
  // filter and the row written by `mapCharacterVoiceActorRows` come from
  // the same `language` value — keeps the two in lock-step.
  const query = buildMediaDetailQuery({ voiceActorLanguage: language });

  // Accumulate across the (up to N) character pages. Staff is only taken
  // from the first call's response — the second character-page call also
  // returns staff page 1, which we redundantly drop to avoid double
  // upserting identical rows (no correctness impact, just noise).
  const allCharacterEdges: AnilistMediaCharacterEdgeGql[] = [];
  let staffEdges: AnilistMediaStaffEdgeGql[] = [];
  let characterPagesFetched = 0;
  let firstCallHappened = false;
  let hasNextCharPage = true;
  let nextCharPage = 1;

  while (hasNextCharPage && characterPagesFetched < maxCharPages) {
    const response = await ctx.executeQuery<AnilistMediaDetailResponse>(query, {
      id: mediaId,
      charactersPage: nextCharPage,
      staffPage: 1,
      perPage,
    });
    if (!response || !response.Media) {
      // 404 on a missing media id — return null so the caller can show
      // "media no longer exists on AniList" without throwing.
      if (!firstCallHappened) {
        return null;
      }
      // Subsequent page null is treated as "no more characters."
      break;
    }
    firstCallHappened = true;
    characterPagesFetched += 1;

    const charactersConn = response.Media.characters;
    if (charactersConn) {
      allCharacterEdges.push(...charactersConn.edges);
      hasNextCharPage = charactersConn.pageInfo.hasNextPage;
    } else {
      hasNextCharPage = false;
    }

    // Only adopt the staff edges from the first call to avoid the
    // double-fetch noise described above.
    if (characterPagesFetched === 1) {
      staffEdges = response.Media.staff?.edges ?? [];
    }

    emitProgress(ctx.onProgress, {
      kind: 'fetching-page',
      what: 'characters',
      page: nextCharPage,
      itemsSoFar: allCharacterEdges.length,
    });

    nextCharPage += 1;
  }

  // Build SQL row data from the accumulated edges.
  const now = ctx.now();
  const characterRows: CharacterRow[] = allCharacterEdges.map((e) =>
    mapCharacterRow(e.node, now),
  );
  // Staff rows = (a) staff connection nodes + (b) every VA inside character
  // edges. Dedup by id so we don't upsert the same row twice in one batch.
  const staffById = new Map<number, StaffRow>();
  for (const edge of staffEdges) {
    const row = mapStaffRow(edge.node, now);
    staffById.set(row.id, row);
  }
  for (const charEdge of allCharacterEdges) {
    for (const va of charEdge.voiceActors ?? []) {
      const row = mapStaffRow(va as AnilistStaffGql, now);
      staffById.set(row.id, row);
    }
  }

  const mediaCharacterRows: MediaCharacterRow[] = mapMediaCharacterRows(
    mediaId,
    allCharacterEdges,
  );
  const voiceActorRows: CharacterVoiceActorRow[] = mapCharacterVoiceActorRows(
    mediaId,
    allCharacterEdges,
    language,
  );

  // Build the rebuild transaction.
  const stmts: Array<{ sql: string; params: readonly SqlBindable[] }> = [];

  // Wipe junction (CVA rows cascade via composite FK).
  stmts.push({
    sql: 'DELETE FROM media_character WHERE media_id = ?',
    params: [mediaId],
  });

  // Parent metadata before junctions reference them.
  for (const row of characterRows) {
    stmts.push({ sql: CHARACTER_UPSERT_SQL, params: characterRowToParams(row) });
  }
  for (const row of staffById.values()) {
    stmts.push({ sql: STAFF_UPSERT_SQL, params: staffRowToParams(row) });
  }

  for (const mc of mediaCharacterRows) {
    stmts.push({
      sql: 'INSERT INTO media_character (media_id, character_id, role, sort_order) VALUES (?, ?, ?, ?)',
      params: [mc.media_id, mc.character_id, mc.role, mc.sort_order],
    });
  }
  for (const cva of voiceActorRows) {
    stmts.push({
      sql: 'INSERT INTO character_voice_actor (media_id, character_id, staff_id, language) VALUES (?, ?, ?, ?)',
      params: [cva.media_id, cva.character_id, cva.staff_id, cva.language],
    });
  }

  // Mark the attempt regardless of whether the response had any
  // characters or VAs. This is what the VoiceActorChip's "X/Y cast
  // cached" counter + the bulk-expand button read — without it, media
  // with empty cast (manga, non-Japanese VAs, etc.) would stay
  // "uncached" forever and the bulk-expand button would re-fetch the
  // same shows on every click. See migration 002 for the contract.
  // OR REPLACE so a future re-expansion (e.g. language refresh) bumps
  // fetched_at + language without erroring on the PK.
  stmts.push({
    sql: 'INSERT OR REPLACE INTO media_cast_expansion (media_id, language, fetched_at) VALUES (?, ?, ?)',
    params: [mediaId, language, now],
  });

  emitProgress(ctx.onProgress, { kind: 'writing', statements: stmts.length });
  await ctx.db.execBatch(stmts);

  if (ctx.onDirtyIncrement) {
    await ctx.onDirtyIncrement();
  }

  emitProgress(ctx.onProgress, { kind: 'done' });
  return {
    mediaId,
    characterPagesFetched,
    charactersWritten: mediaCharacterRows.length,
    staffWritten: staffById.size,
    voiceActorsWritten: voiceActorRows.length,
  };
}
