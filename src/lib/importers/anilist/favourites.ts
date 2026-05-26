/**
 * Per-type favourites importer.
 *
 * One user action = one (user, type) pair, where `type` is
 * `ANIME` | `MANGA` | `CHARACTERS` | `STAFF` | `STUDIOS`. Driven from
 * a single dropdown-button in the source panel.
 *
 * Like the list importer, `username` is a required parameter — any
 * AniList user's favourites can be imported into the same DB. The
 * importer resolves username → User.id once at the start, upserts the
 * `anilist_user` row, and threads the id through every favourites
 * write so multiple users' lists coexist.
 *
 * Each call paginates `User.favourites.<connection>` at perPage 25,
 * accumulates all edges in memory, then wipe-and-rebuilds the
 * `<type>_favourite` table scoped to `(user, type)` inside a single
 * transaction.
 *
 * Why no mid-fetch checkpoint (vs the list importer):
 *   - Cost is small (~1-10 req per type for heavy curators) so retry-from-
 *     scratch is acceptable.
 *   - Wipe-and-rebuild contract: if the fetch is interrupted between
 *     pages, no DB writes happened — the DELETE only runs after every
 *     page succeeded. A second click starts fresh from page 1 with no
 *     stale state to repair.
 *
 * Auto-push fires on completion (favourites are typically a small delta
 * and the user just triggered the action, so silent push to Drive matches
 * intent).
 */

import {
  acquireScrapeLock,
  refreshScrapeLock,
  releaseScrapeLock,
} from '../../db/syncManifest';
import { ANILIST_SOURCE_ID } from './anilistSource';
import type { AnilistImportContext, SqlBindable } from './context';
import {
  ANILIST_USER_UPSERT_SQL,
  AnilistScrapeLockHeldError,
  AnilistUnknownUserError,
  MEDIA_UPSERT_SQL,
  STUDIO_UPSERT_SQL,
  TAG_UPSERT_SQL,
  mediaRowToParams,
} from './importer';
import {
  CHARACTER_UPSERT_SQL,
  STAFF_UPSERT_SQL,
  characterRowToParams,
  staffRowToParams,
} from './lazyExpansion';
import {
  mapAnilistUserRow,
  mapCharacterFavouriteRow,
  mapCharacterRow,
  mapMediaFavouriteRow,
  mapMediaRow,
  mapMediaStudioRows,
  mapMediaTagRows,
  mapStaffFavouriteRow,
  mapStaffRow,
  mapStudioFavouriteRow,
  mapStudioRows,
  mapTagRows,
} from './mappers';
import { buildSetMetaStmt, lastFavouritesRefreshKey } from './meta';
import { emitProgress } from './progress';
import {
  FAVOURITE_ANIME_QUERY,
  FAVOURITE_CHARACTERS_QUERY,
  FAVOURITE_MANGA_QUERY,
  FAVOURITE_STAFF_QUERY,
  FAVOURITE_STUDIOS_QUERY,
  RESOLVE_USER_QUERY,
} from './queries';
import type {
  AnilistCharacterGql,
  AnilistFavouriteEdge,
  AnilistFavouriteStudioNode,
  AnilistFavouriteType,
  AnilistFavouritesPageResponse,
  AnilistMediaGql,
  AnilistStaffGql,
  AnilistUserResolveResponse,
  AnilistUserRow,
} from './types';

export const DEFAULT_FAVOURITES_PAGE_SIZE = 25;

export type ImportAnilistFavouritesOptions = {
  username: string;
  type: AnilistFavouriteType;
  perPage?: number;
};

export type ImportAnilistFavouritesResult = {
  type: AnilistFavouriteType;
  /** AniList User.id resolved from the requested username. */
  anilistUserId: number;
  /** Username the importer ran against (echoed for caller bookkeeping). */
  username: string;
  pagesFetched: number;
  favouritesWritten: number;
};

// ──────────────────────────────────────────────────────────────────────
// Query dispatch — pulls the connection-specific query + accessor for the
// per-type edge array out of one switch so the orchestration is uniform.
// ──────────────────────────────────────────────────────────────────────

type FavouritesQueryDispatch<TNode> = {
  query: string;
  /** Pluck the edges array out of the typed response wrapper. */
  selectEdges: (
    response: AnilistFavouritesPageResponse<TNode> | null,
  ) => AnilistFavouriteEdge<TNode>[];
  /** Pluck `pageInfo.hasNextPage` out of the typed response wrapper. */
  selectHasNextPage: (
    response: AnilistFavouritesPageResponse<TNode> | null,
  ) => boolean;
};

function dispatchFor(
  type: AnilistFavouriteType,
): FavouritesQueryDispatch<AnilistMediaGql>
  | FavouritesQueryDispatch<AnilistCharacterGql>
  | FavouritesQueryDispatch<AnilistStaffGql>
  | FavouritesQueryDispatch<AnilistFavouriteStudioNode> {
  function makeDispatch<TNode>(
    query: string,
    connectionKey: string,
  ): FavouritesQueryDispatch<TNode> {
    return {
      query,
      selectEdges: (r) => r?.User?.favourites[connectionKey]?.edges ?? [],
      selectHasNextPage: (r) =>
        r?.User?.favourites[connectionKey]?.pageInfo.hasNextPage ?? false,
    };
  }
  switch (type) {
    case 'ANIME':
      return makeDispatch<AnilistMediaGql>(FAVOURITE_ANIME_QUERY, 'anime');
    case 'MANGA':
      return makeDispatch<AnilistMediaGql>(FAVOURITE_MANGA_QUERY, 'manga');
    case 'CHARACTERS':
      return makeDispatch<AnilistCharacterGql>(FAVOURITE_CHARACTERS_QUERY, 'characters');
    case 'STAFF':
      return makeDispatch<AnilistStaffGql>(FAVOURITE_STAFF_QUERY, 'staff');
    case 'STUDIOS':
      return makeDispatch<AnilistFavouriteStudioNode>(FAVOURITE_STUDIOS_QUERY, 'studios');
  }
}

// ──────────────────────────────────────────────────────────────────────
// Transaction builders (per type)
// ──────────────────────────────────────────────────────────────────────

type Statement = { sql: string; params: readonly SqlBindable[] };

/**
 * Dedup favourite edges by their node's stable id, keeping the FIRST
 * occurrence. Used by every per-type favourites transaction to keep
 * the various <type>_favourite PK constraints intact even when
 * AniList pagination overlaps (which it can do if the user
 * favourites/unfavourites mid-import).
 *
 * Generic over node type because all four favourite kinds (media,
 * character, staff, studio) carry a numeric `id` on the node.
 */
function dedupFavouriteEdgesByNodeId<N extends { id: number }>(
  edges: AnilistFavouriteEdge<N>[],
): AnilistFavouriteEdge<N>[] {
  if (edges.length < 2) return edges;
  const seen = new Set<number>();
  const out: AnilistFavouriteEdge<N>[] = [];
  for (const e of edges) {
    if (seen.has(e.node.id)) continue;
    seen.add(e.node.id);
    out.push(e);
  }
  return out;
}

/**
 * Statement that upserts the anilist_user row. Always the first
 * statement in every favourites transaction so the FK on the
 * <type>_favourite tables resolves on a fresh DB.
 */
function anilistUserUpsertStmt(user: AnilistUserRow): Statement {
  return {
    sql: ANILIST_USER_UPSERT_SQL,
    params: [user.id, user.name, user.fetched_at, user.updated_at],
  };
}

function buildMediaFavouritesTransaction(
  edges: AnilistFavouriteEdge<AnilistMediaGql>[],
  anilistUser: AnilistUserRow,
  mediaType: 'ANIME' | 'MANGA',
  now: number,
): Statement[] {
  // Dedup edges by node.id BEFORE anything else. Same reasoning as
  // the list importer: pagination overlap during AniList mutations
  // can yield two edges with the same favourite node, which would
  // blow PK constraints on `media_favourite`, `media_studio` /
  // `media_tag` (per-media junctions inserted twice). Favourites
  // can't legitimately appear twice on a user's list.
  edges = dedupFavouriteEdgesByNodeId(edges);

  const stmts: Statement[] = [];

  stmts.push(anilistUserUpsertStmt(anilistUser));

  // Scope the wipe to (user, media.type) — refreshing anime favs must
  // not nuke manga favs OR another user's anime favs.
  stmts.push({
    sql:
      'DELETE FROM media_favourite ' +
      'WHERE anilist_user_id = ? ' +
      '  AND media_id IN (SELECT id FROM media WHERE type = ?)',
    params: [anilistUser.id, mediaType],
  });

  // Dedup parent metadata in case the same studio/tag appears across favs
  const studios = new Map<number, ReturnType<typeof mapStudioRows>[number]>();
  const tags = new Map<string, ReturnType<typeof mapTagRows>[number]>();

  for (const edge of edges) {
    for (const s of mapStudioRows(edge.node, now)) studios.set(s.id, s);
    for (const t of mapTagRows(edge.node, now)) tags.set(t.name, t);
  }
  for (const s of studios.values()) {
    stmts.push({ sql: STUDIO_UPSERT_SQL, params: [s.id, s.name, s.fetched_at] });
  }
  for (const t of tags.values()) {
    stmts.push({ sql: TAG_UPSERT_SQL, params: [t.name, t.fetched_at] });
  }

  // Upsert media rows for each favourite (seeds rows for favourites the
  // user has never had on their list — plan §B side-effect). Reuse the
  // importer's row→params helper so the column list stays in one place.
  for (const edge of edges) {
    const row = mapMediaRow(edge.node, now);
    stmts.push({ sql: MEDIA_UPSERT_SQL, params: mediaRowToParams(row) });
  }

  // Rebuild junctions for every favourited media. Same per-media DELETE +
  // INSERT pattern as the list importer — preserves "tag removed on
  // AniList between imports" cleanup. Junctions are global (no user
  // dim), so cross-user wipe is intentional.
  const affectedIds = edges.map((e) => e.node.id);
  if (affectedIds.length > 0) {
    const placeholders = affectedIds.map(() => '?').join(', ');
    stmts.push({
      sql: `DELETE FROM media_studio WHERE media_id IN (${placeholders})`,
      params: affectedIds,
    });
    stmts.push({
      sql: `DELETE FROM media_tag WHERE media_id IN (${placeholders})`,
      params: affectedIds,
    });
  }
  for (const edge of edges) {
    for (const ms of mapMediaStudioRows(edge.node)) {
      stmts.push({
        sql: 'INSERT INTO media_studio (media_id, studio_id, sort_order) VALUES (?, ?, ?)',
        params: [ms.media_id, ms.studio_id, ms.sort_order],
      });
    }
    for (const mt of mapMediaTagRows(edge.node)) {
      stmts.push({
        sql: 'INSERT INTO media_tag (media_id, tag_name, rank) VALUES (?, ?, ?)',
        params: [mt.media_id, mt.tag_name, mt.rank],
      });
    }
  }

  // Insert fresh media_favourite rows.
  for (const edge of edges) {
    const row = mapMediaFavouriteRow(edge, anilistUser.id, now);
    stmts.push({
      sql:
        'INSERT INTO media_favourite (anilist_user_id, media_id, sort_order, fetched_at) ' +
        'VALUES (?, ?, ?, ?)',
      params: [row.anilist_user_id, row.media_id, row.sort_order, row.fetched_at],
    });
  }

  return stmts;
}

function buildCharacterFavouritesTransaction(
  edges: AnilistFavouriteEdge<AnilistCharacterGql>[],
  anilistUser: AnilistUserRow,
  now: number,
): Statement[] {
  edges = dedupFavouriteEdgesByNodeId(edges);
  const stmts: Statement[] = [];
  stmts.push(anilistUserUpsertStmt(anilistUser));
  stmts.push({
    sql: 'DELETE FROM character_favourite WHERE anilist_user_id = ?',
    params: [anilistUser.id],
  });
  for (const edge of edges) {
    const charRow = mapCharacterRow(edge.node, now);
    stmts.push({ sql: CHARACTER_UPSERT_SQL, params: characterRowToParams(charRow) });
    const favRow = mapCharacterFavouriteRow(edge, anilistUser.id, now);
    stmts.push({
      sql:
        'INSERT INTO character_favourite (anilist_user_id, character_id, sort_order, fetched_at) ' +
        'VALUES (?, ?, ?, ?)',
      params: [
        favRow.anilist_user_id,
        favRow.character_id,
        favRow.sort_order,
        favRow.fetched_at,
      ],
    });
  }
  return stmts;
}

function buildStaffFavouritesTransaction(
  edges: AnilistFavouriteEdge<AnilistStaffGql>[],
  anilistUser: AnilistUserRow,
  now: number,
): Statement[] {
  edges = dedupFavouriteEdgesByNodeId(edges);
  const stmts: Statement[] = [];
  stmts.push(anilistUserUpsertStmt(anilistUser));
  stmts.push({
    sql: 'DELETE FROM staff_favourite WHERE anilist_user_id = ?',
    params: [anilistUser.id],
  });
  for (const edge of edges) {
    const staffRow = mapStaffRow(edge.node, now);
    stmts.push({ sql: STAFF_UPSERT_SQL, params: staffRowToParams(staffRow) });
    const favRow = mapStaffFavouriteRow(edge, anilistUser.id, now);
    stmts.push({
      sql:
        'INSERT INTO staff_favourite (anilist_user_id, staff_id, sort_order, fetched_at) ' +
        'VALUES (?, ?, ?, ?)',
      params: [favRow.anilist_user_id, favRow.staff_id, favRow.sort_order, favRow.fetched_at],
    });
  }
  return stmts;
}

function buildStudioFavouritesTransaction(
  edges: AnilistFavouriteEdge<AnilistFavouriteStudioNode>[],
  anilistUser: AnilistUserRow,
  now: number,
): Statement[] {
  edges = dedupFavouriteEdgesByNodeId(edges);
  const stmts: Statement[] = [];
  stmts.push(anilistUserUpsertStmt(anilistUser));
  stmts.push({
    sql: 'DELETE FROM studio_favourite WHERE anilist_user_id = ?',
    params: [anilistUser.id],
  });
  for (const edge of edges) {
    stmts.push({
      sql:
        'INSERT INTO studio (id, name, fetched_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET name = excluded.name, fetched_at = excluded.fetched_at',
      params: [edge.node.id, edge.node.name, now],
    });
    const favRow = mapStudioFavouriteRow(edge, anilistUser.id, now);
    stmts.push({
      sql:
        'INSERT INTO studio_favourite (anilist_user_id, studio_id, sort_order, fetched_at) ' +
        'VALUES (?, ?, ?, ?)',
      params: [favRow.anilist_user_id, favRow.studio_id, favRow.sort_order, favRow.fetched_at],
    });
  }
  return stmts;
}

// ──────────────────────────────────────────────────────────────────────
// Public entry
// ──────────────────────────────────────────────────────────────────────

export async function importAnilistFavourites(
  ctx: AnilistImportContext,
  options: ImportAnilistFavouritesOptions,
): Promise<ImportAnilistFavouritesResult> {
  const { username, type } = options;
  const perPage = options.perPage ?? DEFAULT_FAVOURITES_PAGE_SIZE;

  // Resolve username → User.id BEFORE acquiring the scrape lock so a
  // typo doesn't tie up the lock. Same pattern as the list importer.
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
    // Per the wipe-and-rebuild contract, all pages must succeed before
    // any DB write happens. Accumulate edges in memory first.
    const dispatch = dispatchFor(type);
    const accumulated: AnilistFavouriteEdge<unknown>[] = [];
    let page = 1;
    let pagesFetched = 0;

    while (true) {
      const response = await ctx.executeQuery<AnilistFavouritesPageResponse<unknown>>(
        dispatch.query,
        { username, page, perPage },
      );
      pagesFetched += 1;
      // Use unknown so the switch below can re-type per `type` branch.
      const edges = (
        dispatch as FavouritesQueryDispatch<unknown>
      ).selectEdges(response);
      accumulated.push(...edges);
      emitProgress(ctx.onProgress, {
        kind: 'fetching-page',
        what: 'favourites',
        page,
        itemsSoFar: accumulated.length,
      });
      refreshScrapeLock(ANILIST_SOURCE_ID, lockToken, ctx.now());

      const hasNext = (
        dispatch as FavouritesQueryDispatch<unknown>
      ).selectHasNextPage(response);
      if (!hasNext) {
        break;
      }
      page += 1;
    }

    // Build the per-(user, type) rebuild transaction using the now-
    // known concrete type. Cast is safe because we only entered each
    // branch when the dispatch was for that node type.
    const now = ctx.now();
    let stmts: Statement[];
    switch (type) {
      case 'ANIME':
      case 'MANGA':
        stmts = buildMediaFavouritesTransaction(
          accumulated as AnilistFavouriteEdge<AnilistMediaGql>[],
          anilistUserRow,
          type,
          now,
        );
        break;
      case 'CHARACTERS':
        stmts = buildCharacterFavouritesTransaction(
          accumulated as AnilistFavouriteEdge<AnilistCharacterGql>[],
          anilistUserRow,
          now,
        );
        break;
      case 'STAFF':
        stmts = buildStaffFavouritesTransaction(
          accumulated as AnilistFavouriteEdge<AnilistStaffGql>[],
          anilistUserRow,
          now,
        );
        break;
      case 'STUDIOS':
        stmts = buildStudioFavouritesTransaction(
          accumulated as AnilistFavouriteEdge<AnilistFavouriteStudioNode>[],
          anilistUserRow,
          now,
        );
        break;
    }

    // Stamp the per-(user, type) refresh time inside the same
    // transaction so the wipe + writes + stamp commit atomically.
    const stampStmt = buildSetMetaStmt(lastFavouritesRefreshKey(anilistUserRow.id, type), now);
    stmts.push({ sql: stampStmt.sql, params: stampStmt.params ?? [] });

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
      favouritesWritten: accumulated.length,
    };
  } finally {
    releaseScrapeLock(ANILIST_SOURCE_ID, lockToken);
  }
}
