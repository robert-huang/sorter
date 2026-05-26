/**
 * Read-only queries against `anilist.sqlite`. Drives the LIST filter
 * chips, the detail modal, and the start-screen import preview.
 *
 * Mirrors the [importer's](./importer.ts) dependency-injection seam
 * (`context.ts`): every function takes a {@link AnilistDbExecutor} so
 * tests can drive them against an in-memory connection without touching
 * the worker, while production callers go through the worker-mediated
 * client via {@link makeAnilistImportContext}.
 *
 * Stays read-only on purpose — no upserts, no _meta writes, no scrape
 * lock. Anything that mutates lives in `importer.ts` / `favourites.ts`
 * / `lazyExpansion.ts` so the dirty-vs-clean side of the read/write
 * split is visible from the file layout.
 */

import * as client from '../../db/client';
import type { DbRow } from '../../db/rpc';
import { ANILIST_SOURCE_ID } from './anilistSource';
import type { AnilistDbExecutor, SqlBindable } from './context';
import {
  lastFavouritesRefreshKey,
  lastFullRefreshKey,
} from './meta';
import type {
  AnilistFavouriteType,
  AnilistMediaType,
  CharacterRow,
  MediaListEntryRow,
  MediaRow,
  StaffRow,
  StudioRow,
} from './types';

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Render a `(?, ?, ?, ...)` placeholder list of the right cardinality. */
function placeholders(n: number): string {
  if (n === 0) return '';
  return new Array(n).fill('?').join(', ');
}

// SQLite returns INTEGER columns as `number` and TEXT as `string` (or
// `null` for both when the column is nullable). The row cast helpers
// below pin those expectations so call sites can lean on the typed row
// without spreading `as` casts around the codebase.
function n(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}
function s(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
function reqN(v: unknown): number {
  if (v === null || v === undefined) {
    throw new Error('expected non-null number column');
  }
  return Number(v);
}
function reqS(v: unknown): string {
  if (v === null || v === undefined) {
    throw new Error('expected non-null text column');
  }
  return String(v);
}

function rowToMediaRow(r: DbRow): MediaRow {
  return {
    id: reqN(r.id),
    type: reqS(r.type) as MediaRow['type'],
    title_english: s(r.title_english),
    title_romaji: s(r.title_romaji),
    title_native: s(r.title_native),
    cover_image: s(r.cover_image),
    format: s(r.format) as MediaRow['format'],
    status: s(r.status) as MediaRow['status'],
    episodes: n(r.episodes),
    chapters: n(r.chapters),
    start_year: n(r.start_year),
    start_month: n(r.start_month),
    start_day: n(r.start_day),
    end_year: n(r.end_year),
    end_month: n(r.end_month),
    end_day: n(r.end_day),
    season: s(r.season) as MediaRow['season'],
    season_year: n(r.season_year),
    mean_score: n(r.mean_score),
    favourites: n(r.favourites),
    country_of_origin: s(r.country_of_origin),
    genres_json: s(r.genres_json),
    synonyms_json: s(r.synonyms_json),
    fetched_at: reqN(r.fetched_at),
    updated_at: reqN(r.updated_at),
  };
}

function rowToMediaListEntryRow(r: DbRow): MediaListEntryRow {
  return {
    anilist_user_id: reqN(r.anilist_user_id),
    media_id: reqN(r.media_id),
    score: n(r.score),
    status: reqS(r.status) as MediaListEntryRow['status'],
    repeat: n(r.repeat),
    started_year: n(r.started_year),
    started_month: n(r.started_month),
    started_day: n(r.started_day),
    completed_year: n(r.completed_year),
    completed_month: n(r.completed_month),
    completed_day: n(r.completed_day),
    anilist_created_at: n(r.anilist_created_at),
    anilist_updated_at: n(r.anilist_updated_at),
    fetched_at: reqN(r.fetched_at),
    updated_at: reqN(r.updated_at),
  };
}

function rowToCharacterRow(r: DbRow): CharacterRow {
  return {
    id: reqN(r.id),
    name_full: s(r.name_full),
    name_native: s(r.name_native),
    name_alternatives_json: s(r.name_alternatives_json),
    name_alternatives_spoiler_json: s(r.name_alternatives_spoiler_json),
    image: s(r.image),
    age: s(r.age),
    gender: s(r.gender),
    favourites: n(r.favourites),
    fetched_at: reqN(r.fetched_at),
    updated_at: reqN(r.updated_at),
  };
}

function rowToStaffRow(r: DbRow): StaffRow {
  return {
    id: reqN(r.id),
    name_full: s(r.name_full),
    name_native: s(r.name_native),
    image: s(r.image),
    age: s(r.age),
    gender: s(r.gender),
    language_v2: s(r.language_v2),
    favourites: n(r.favourites),
    fetched_at: reqN(r.fetched_at),
    updated_at: reqN(r.updated_at),
  };
}

function rowToStudioRow(r: DbRow): StudioRow {
  return {
    id: reqN(r.id),
    name: reqS(r.name),
    fetched_at: reqN(r.fetched_at),
  };
}

// ---------------------------------------------------------------------
// Public read API
// ---------------------------------------------------------------------

/**
 * Fetch full media rows by AniList id. Returns an empty array if the
 * input list is empty so callers don't need to short-circuit. Order of
 * the output is not guaranteed (SQLite chooses) — callers that need
 * the input order should reorder on `id` themselves.
 */
export async function getMediaByIds(
  db: AnilistDbExecutor,
  ids: readonly number[],
): Promise<MediaRow[]> {
  if (ids.length === 0) return [];
  const sql = `SELECT * FROM media WHERE id IN (${placeholders(ids.length)})`;
  const rows = await db.exec(sql, ids as readonly SqlBindable[]);
  return rows.map(rowToMediaRow);
}

/**
 * Fetch every media row of `type` that has a media_list_entry for the
 * given AniList user. Used by the StartScreen import preview to render
 * the post-import filterable list. Ordered by AniList's updated_at
 * descending so the most recently-touched entries float to the top
 * (matches AniList's own list ordering).
 */
export async function getListedMedia(
  db: AnilistDbExecutor,
  anilistUserId: number,
  type: AnilistMediaType,
): Promise<MediaRow[]> {
  const sql = `
    SELECT m.*
    FROM media m
    JOIN media_list_entry mle
      ON mle.media_id = m.id
      AND mle.anilist_user_id = ?
    WHERE m.type = ?
    ORDER BY COALESCE(mle.anilist_updated_at, mle.updated_at) DESC
  `;
  const rows = await db.exec(sql, [anilistUserId, type]);
  return rows.map(rowToMediaRow);
}

/**
 * Fetch the media_list_entry rows for a given user, keyed by media id.
 * Used by the start-screen preview + detail panel to show the user's
 * own status/score/dates alongside the media metadata.
 */
export async function getListEntriesByMediaIds(
  db: AnilistDbExecutor,
  anilistUserId: number,
  mediaIds: readonly number[],
): Promise<Map<number, MediaListEntryRow>> {
  const out = new Map<number, MediaListEntryRow>();
  if (mediaIds.length === 0) return out;
  const sql = `
    SELECT * FROM media_list_entry
    WHERE anilist_user_id = ?
      AND media_id IN (${placeholders(mediaIds.length)})
  `;
  const rows = await db.exec(sql, [
    anilistUserId,
    ...mediaIds,
  ] as readonly SqlBindable[]);
  for (const r of rows) {
    const row = rowToMediaListEntryRow(r);
    out.set(row.media_id, row);
  }
  return out;
}

/**
 * Full detail-panel payload for one media id: the row itself, ordered
 * studios, ordered tags with rank, characters + their voice actors,
 * and credited staff. Single function so the detail modal renders
 * from one Promise resolution.
 *
 * Returns null when the media doesn't exist locally (shouldn't happen
 * during normal use — the caller is always opening a panel for an item
 * already in their slot — but cleanly signals "media row missing"
 * rather than silently rendering an empty shell).
 */
export interface MediaDetail {
  media: MediaRow;
  studios: Array<{ studio: StudioRow; sortOrder: number }>;
  tags: Array<{ name: string; rank: number }>;
  characters: Array<{
    character: CharacterRow;
    role: string | null;
    sortOrder: number;
    voiceActors: StaffRow[];
  }>;
  staff: StaffRow[];
}

export async function getMediaDetail(
  db: AnilistDbExecutor,
  mediaId: number,
): Promise<MediaDetail | null> {
  const mediaRows = await db.exec('SELECT * FROM media WHERE id = ?', [mediaId]);
  if (mediaRows.length === 0) return null;
  const media = rowToMediaRow(mediaRows[0]);

  // Studios — ordered by sort_order ascending so the rendered list
  // mirrors the order AniList returns.
  const studioRows = await db.exec(
    `
      SELECT s.id, s.name, s.fetched_at, ms.sort_order
      FROM media_studio ms
      JOIN studio s ON s.id = ms.studio_id
      WHERE ms.media_id = ?
      ORDER BY ms.sort_order ASC
    `,
    [mediaId],
  );
  const studios = studioRows.map((r) => ({
    studio: rowToStudioRow(r),
    sortOrder: reqN(r.sort_order),
  }));

  // Tags — by rank desc so the most relevant tag shows first.
  const tagRows = await db.exec(
    `
      SELECT tag_name, rank
      FROM media_tag
      WHERE media_id = ?
      ORDER BY rank DESC, tag_name ASC
    `,
    [mediaId],
  );
  const tags = tagRows.map((r) => ({
    name: reqS(r.tag_name),
    rank: reqN(r.rank),
  }));

  // Characters + their VAs. One JOIN per character to keep the SQL
  // simple; the per-character VA fetch is a second query keyed on
  // (media_id, character_id) so we don't fan out a huge cartesian
  // join on small lists.
  const characterRows = await db.exec(
    `
      SELECT c.*, mc.role, mc.sort_order
      FROM media_character mc
      JOIN character c ON c.id = mc.character_id
      WHERE mc.media_id = ?
      ORDER BY mc.sort_order ASC
    `,
    [mediaId],
  );
  const characters: MediaDetail['characters'] = [];
  for (const r of characterRows) {
    const character = rowToCharacterRow(r);
    const role = s(r.role);
    const sortOrder = reqN(r.sort_order);
    const vaRows = await db.exec(
      `
        SELECT st.*
        FROM character_voice_actor cva
        JOIN staff st ON st.id = cva.staff_id
        WHERE cva.media_id = ? AND cva.character_id = ?
        ORDER BY cva.language ASC
      `,
      [mediaId, character.id],
    );
    characters.push({
      character,
      role,
      sortOrder,
      voiceActors: vaRows.map(rowToStaffRow),
    });
  }

  // Staff — currently the schema doesn't have a media_staff junction
  // (the lazy-expansion query writes character_voice_actor rows
  // instead — see lazyExpansion.ts). For v1 we return an empty staff
  // list here so the detail modal can still render the section with
  // a "no staff credited yet" placeholder; a future schema addition
  // (`media_staff(media_id, staff_id, role)`) plus an importer update
  // can populate it without changing this function's signature.
  const staff: StaffRow[] = [];

  return { media, studios, tags, characters, staff };
}

/**
 * True when at least one media_character row exists for the media id.
 * Drives the detail modal's first-open decision: if false, the modal
 * triggers `expandAnilistMediaDetail` and shows a spinner; if true,
 * it just renders the cached rows.
 */
export async function hasMediaCharacters(
  db: AnilistDbExecutor,
  mediaId: number,
): Promise<boolean> {
  const rows = await db.exec(
    'SELECT 1 FROM media_character WHERE media_id = ? LIMIT 1',
    [mediaId],
  );
  return rows.length > 0;
}

/**
 * AniList user resolved by their stable id (the one the importer
 * captures via `RESOLVE_USER_QUERY`). Used by the gear-menu source
 * panel + StartScreen import preview to render the captured username
 * alongside the per-type refresh timestamps after a successful
 * import.
 */
export interface AnilistUserSummary {
  id: number;
  name: string;
  fetched_at: number;
}

export async function getAnilistUserById(
  db: AnilistDbExecutor,
  anilistUserId: number,
): Promise<AnilistUserSummary | null> {
  const rows = await db.exec(
    'SELECT id, name, fetched_at FROM anilist_user WHERE id = ? LIMIT 1',
    [anilistUserId],
  );
  if (rows.length === 0) return null;
  return {
    id: reqN(rows[0].id),
    name: reqS(rows[0].name),
    fetched_at: reqN(rows[0].fetched_at),
  };
}

/**
 * Latest AniList user known to the local DB, ordered by `fetched_at`
 * descending. Used as the StartScreen + source-panel default-fill so
 * a returning user sees their most-recent username without retyping
 * — matches the "captured at import time" decision (the value isn't
 * persisted as a setting, but the last imported user is always
 * recoverable from the DB itself).
 */
export async function getLatestAnilistUser(
  db: AnilistDbExecutor,
): Promise<AnilistUserSummary | null> {
  const rows = await db.exec(
    'SELECT id, name, fetched_at FROM anilist_user ORDER BY fetched_at DESC LIMIT 1',
  );
  if (rows.length === 0) return null;
  return {
    id: reqN(rows[0].id),
    name: reqS(rows[0].name),
    fetched_at: reqN(rows[0].fetched_at),
  };
}

/**
 * Read a single `_meta` value as a string or null. Public reader for
 * the per-user / per-type timestamps the importers stamp; renders the
 * "anime list refreshed Xd ago" labels in the source panel.
 */
export async function getMeta(
  db: AnilistDbExecutor,
  key: string,
): Promise<string | null> {
  const rows = await db.exec('SELECT value FROM _meta WHERE key = ?', [key]);
  if (rows.length === 0) return null;
  return s(rows[0].value);
}

/**
 * Read `last_full_refresh:<USER>:<TYPE>` as epoch-ms. Returns null
 * when the user has never refreshed this list type.
 */
export async function getLastFullRefresh(
  db: AnilistDbExecutor,
  anilistUserId: number,
  type: AnilistMediaType,
): Promise<number | null> {
  const value = await getMeta(db, lastFullRefreshKey(anilistUserId, type));
  if (value === null) return null;
  const ms = Number(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Read `last_favourites_refresh:<USER>:<TYPE>` as epoch-ms. Returns
 * null when the user has never refreshed this favourites type. Driven
 * by the per-type favourites dropdown in the source panel.
 */
export async function getLastFavouritesRefresh(
  db: AnilistDbExecutor,
  anilistUserId: number,
  type: AnilistFavouriteType,
): Promise<number | null> {
  const value = await getMeta(db, lastFavouritesRefreshKey(anilistUserId, type));
  if (value === null) return null;
  const ms = Number(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Convenience subset: the AniList ids the user has favourited at the
 * media level. Used by the LIST filter chip "favourited?". Scoped by
 * user so a shared DB doesn't mix Alice's and Bob's favourites.
 */
export async function getFavouritedMediaIds(
  db: AnilistDbExecutor,
  anilistUserId: number,
  mediaIds: readonly number[],
): Promise<Set<number>> {
  const out = new Set<number>();
  if (mediaIds.length === 0) return out;
  const sql = `
    SELECT media_id FROM media_favourite
    WHERE anilist_user_id = ? AND media_id IN (${placeholders(mediaIds.length)})
  `;
  const rows = await db.exec(sql, [
    anilistUserId,
    ...mediaIds,
  ] as readonly SqlBindable[]);
  for (const r of rows) out.add(reqN(r.media_id));
  return out;
}

// ---------------------------------------------------------------------
// Production-default helpers
//
// Wrap the worker-mediated client so UI surfaces don't need to thread
// an AnilistImportContext just to read. Tests still go through the
// db-injection path; these are sugar for the runtime case.
// ---------------------------------------------------------------------

function defaultDb(): AnilistDbExecutor {
  return {
    exec: (sql, params) =>
      client.exec(ANILIST_SOURCE_ID, sql, params ? [...params] : undefined),
    execBatch: (statements) =>
      client.execBatch(
        ANILIST_SOURCE_ID,
        statements.map((s) => ({
          sql: s.sql,
          params: s.params ? [...s.params] : undefined,
        })),
      ),
  };
}

export const productionReads = {
  getMediaByIds: (ids: readonly number[]) => getMediaByIds(defaultDb(), ids),
  getListedMedia: (anilistUserId: number, type: AnilistMediaType) =>
    getListedMedia(defaultDb(), anilistUserId, type),
  getListEntriesByMediaIds: (
    anilistUserId: number,
    mediaIds: readonly number[],
  ) => getListEntriesByMediaIds(defaultDb(), anilistUserId, mediaIds),
  getMediaDetail: (mediaId: number) => getMediaDetail(defaultDb(), mediaId),
  hasMediaCharacters: (mediaId: number) =>
    hasMediaCharacters(defaultDb(), mediaId),
  getAnilistUserById: (anilistUserId: number) =>
    getAnilistUserById(defaultDb(), anilistUserId),
  getLatestAnilistUser: () => getLatestAnilistUser(defaultDb()),
  getLastFullRefresh: (anilistUserId: number, type: AnilistMediaType) =>
    getLastFullRefresh(defaultDb(), anilistUserId, type),
  getLastFavouritesRefresh: (
    anilistUserId: number,
    type: AnilistFavouriteType,
  ) => getLastFavouritesRefresh(defaultDb(), anilistUserId, type),
  getFavouritedMediaIds: (
    anilistUserId: number,
    mediaIds: readonly number[],
  ) => getFavouritedMediaIds(defaultDb(), anilistUserId, mediaIds),
};
