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
import type { AnilistItemLabelSource } from '../../types';
import { ANILIST_SOURCE_ID } from './anilistSource';
import { mediaTitleSearchParts, pickMediaTitle } from './mediaDisplayLabel';
import {
  characterNameSearchParts,
  personNameSearchParts,
  pickPersonName,
} from './personDisplayLabel';
import type { AnilistDbExecutor, SqlBindable } from './context';
import { PRODUCTION_CREDITS_ORDER_BY } from './graphQueries';
import {
  lastFavouritesRefreshKey,
  lastFullRefreshKey,
} from './meta';
import type {
  AnilistFavouriteType,
  AnilistMediaFormat,
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
  /** Production credits from `media_staff` (unfiltered; UI applies role filter). */
  productionStaff: Array<{
    staff: StaffRow;
    role: string;
    sortOrder: number;
  }>;
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

  const productionStaffRows = await db.exec(
    `
      SELECT st.*, ms.role, ms.sort_order
      FROM media_staff ms
      JOIN staff st ON st.id = ms.staff_id
      WHERE ms.media_id = ?
      ORDER BY ${PRODUCTION_CREDITS_ORDER_BY}
    `,
    [mediaId],
  );
  const productionStaff = productionStaffRows.map((r) => ({
    staff: rowToStaffRow(r),
    role: reqS(r.role),
    sortOrder: reqN(r.sort_order),
  }));

  return { media, studios, tags, characters, productionStaff };
}

export interface MediaCastExpansionStatus {
  mediaId: number;
  language: string;
  charactersFetchedAt: number | null;
  staffFetchedAt: number | null;
  charactersComplete: boolean;
  staffComplete: boolean;
}

export async function getMediaCastExpansionStatus(
  db: AnilistDbExecutor,
  mediaId: number,
): Promise<MediaCastExpansionStatus | null> {
  const rows = await db.exec(
    `SELECT media_id, language, characters_fetched_at, staff_fetched_at,
            characters_complete, staff_complete
       FROM media_cast_expansion WHERE media_id = ?`,
    [mediaId],
  );
  if (rows.length === 0) {
    return null;
  }
  const r = rows[0];
  return {
    mediaId: reqN(r.media_id),
    language: reqS(r.language),
    charactersFetchedAt: n(r.characters_fetched_at),
    staffFetchedAt: n(r.staff_fetched_at),
    charactersComplete: Number(r.characters_complete) === 1,
    staffComplete: Number(r.staff_complete) === 1,
  };
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
 * One media credit in a staff member's filmography, merged across the
 * two AniList edge types `expandStaffFilmography` persists:
 *   - production credits (`media_staff`, e.g. "Director"), and
 *   - voice-acting roles (`character_voice_actor` → the voiced character).
 * A single media can appear in both (e.g. a director who also voices a
 * cameo), so the two are folded into one row per media id.
 */
export interface StaffFilmographyCredit {
  media: MediaRow;
  /** Production roles from `media_staff`, deduped, in cache sort order. */
  productionRoles: string[];
  /** Characters this staff voiced in this media (display-name resolved). */
  voicedCharacters: Array<{ id: number; name: string }>;
}

export interface StaffFilmography {
  /** The staff row itself, or null when the id isn't cached locally. */
  staff: StaffRow | null;
  /** All cached media credits, sorted newest-first (see ordering below). */
  credits: StaffFilmographyCredit[];
  /**
   * `staff_filmography_expansion.fetched_at`, or null when the staff's
   * filmography has never been expanded. Drives the detail modal's
   * first-open expansion decision + the freshness line, mirroring the
   * media modal's `media_cast_expansion` timestamps.
   */
  fetchedAt: number | null;
}

/**
 * Order credits newest-first: `start_year` desc (unknown years sink to
 * the bottom), tie-broken by popularity (`favourites` desc) then title
 * for a stable, browseable list.
 */
function compareStaffFilmographyCredits(
  a: StaffFilmographyCredit,
  b: StaffFilmographyCredit,
): number {
  const ay = a.media.start_year;
  const by = b.media.start_year;
  if (ay !== by) {
    if (ay === null) return 1;
    if (by === null) return -1;
    return by - ay;
  }
  const af = a.media.favourites ?? -1;
  const bf = b.media.favourites ?? -1;
  if (af !== bf) return bf - af;
  return pickMediaTitle(a.media).localeCompare(pickMediaTitle(b.media));
}

/**
 * Full filmography payload for one staff id, read from the rows
 * `expandStaffFilmography` persists. Single function so the staff
 * detail modal renders from one Promise resolution, mirroring
 * {@link getMediaDetail}.
 *
 * Returns `staff: null` (not a null payload) when the staff row is
 * missing so the modal can still show the fallback name + offer a
 * Refresh — the credits/fetchedAt are independent of whether the
 * `staff` row itself was cached.
 */
export async function getStaffFilmography(
  db: AnilistDbExecutor,
  staffId: number,
): Promise<StaffFilmography> {
  const staffRows = await db.exec('SELECT * FROM staff WHERE id = ?', [staffId]);
  const staff = staffRows.length > 0 ? rowToStaffRow(staffRows[0]) : null;

  // Production credits: media_staff JOIN media (role per media).
  const prodRows = await db.exec(
    `
      SELECT m.*, ms.role AS staff_role
        FROM media_staff ms
        JOIN media m ON m.id = ms.media_id
       WHERE ms.staff_id = ?
       ORDER BY ms.sort_order ASC
    `,
    [staffId],
  );

  // Voice roles: character_voice_actor JOIN media + the voiced character.
  const voiceRows = await db.exec(
    `
      SELECT m.*,
             c.id          AS character_id,
             c.name_full   AS character_name_full,
             c.name_native AS character_name_native
        FROM character_voice_actor cva
        JOIN media m ON m.id = cva.media_id
        JOIN character c ON c.id = cva.character_id
       WHERE cva.staff_id = ?
    `,
    [staffId],
  );

  const byMedia = new Map<number, StaffFilmographyCredit>();
  const ensureCredit = (r: DbRow): StaffFilmographyCredit => {
    const media = rowToMediaRow(r);
    let credit = byMedia.get(media.id);
    if (!credit) {
      credit = { media, productionRoles: [], voicedCharacters: [] };
      byMedia.set(media.id, credit);
    }
    return credit;
  };

  for (const r of prodRows) {
    const credit = ensureCredit(r);
    const role = s(r.staff_role);
    if (role && !credit.productionRoles.includes(role)) {
      credit.productionRoles.push(role);
    }
  }
  for (const r of voiceRows) {
    const credit = ensureCredit(r);
    const characterId = reqN(r.character_id);
    if (!credit.voicedCharacters.some((c) => c.id === characterId)) {
      credit.voicedCharacters.push({
        id: characterId,
        name: pickPersonName(
          {
            id: characterId,
            name_full: s(r.character_name_full),
            name_native: s(r.character_name_native),
          },
          undefined,
          'Character',
        ),
      });
    }
  }

  const credits = Array.from(byMedia.values());
  credits.sort(compareStaffFilmographyCredits);

  const statusRows = await db.exec(
    'SELECT fetched_at FROM staff_filmography_expansion WHERE staff_id = ?',
    [staffId],
  );
  const fetchedAt = statusRows.length > 0 ? n(statusRows[0].fetched_at) : null;

  return { staff, credits, fetchedAt };
}

/**
 * Subset of `mediaIds` that have a media_list_entry for `anilistUserId`,
 * across ANY media type (anime or manga). Powers the staff detail
 * modal's "only items on my list" toggle. Empty input → empty set.
 */
export async function getMediaIdsInUserList(
  db: AnilistDbExecutor,
  anilistUserId: number,
  mediaIds: readonly number[],
): Promise<Set<number>> {
  const out = new Set<number>();
  if (mediaIds.length === 0) return out;
  const sql = `
    SELECT media_id FROM media_list_entry
    WHERE anilist_user_id = ?
      AND media_id IN (${placeholders(mediaIds.length)})
  `;
  const rows = await db.exec(sql, [
    anilistUserId,
    ...mediaIds,
  ] as readonly SqlBindable[]);
  for (const r of rows) out.add(reqN(r.media_id));
  return out;
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
 * Lookup a previously-imported user by their AniList handle. Used by
 * the start screen to decide whether the username typed into the
 * input already has a cached list — if it does, the UI can offer
 * "use cached" instead of forcing a full re-scrape.
 *
 * Uses COLLATE NOCASE on the comparison so 'Robert', 'robert', and
 * 'ROBERT' all resolve to the same DB row. AniList itself is
 * case-insensitive for username lookup (the resolveUser GraphQL
 * normalises), so the local index should match that behaviour —
 * otherwise typing 'robert' in lower-case wouldn't surface a
 * cache that was imported as 'Robert'.
 */
export async function getAnilistUserByName(
  db: AnilistDbExecutor,
  name: string,
): Promise<AnilistUserSummary | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const rows = await db.exec(
    'SELECT id, name, fetched_at FROM anilist_user WHERE name = ? COLLATE NOCASE LIMIT 1',
    [trimmed],
  );
  if (rows.length === 0) return null;
  return {
    id: reqN(rows[0].id),
    name: reqS(rows[0].name),
    fetched_at: reqN(rows[0].fetched_at),
  };
}

/**
 * Count of media_list_entry rows for a (user, type) combo. Cheaper
 * than `getListedMedia(...).length` because the UI only needs the
 * number for the "cached: N items, refreshed X ago" hint — we don't
 * want to drag all the rows over the worker boundary just to count
 * them on the main thread. The matching `JOIN media` lives here too
 * so a user with stale entries pointing at media rows that no longer
 * exist (cache eviction edge case) doesn't get an inflated count.
 */
export async function getListedMediaCount(
  db: AnilistDbExecutor,
  anilistUserId: number,
  type: AnilistMediaType,
): Promise<number> {
  const rows = await db.exec(
    `SELECT COUNT(*) AS n
       FROM media_list_entry mle
       JOIN media m ON m.id = mle.media_id
      WHERE mle.anilist_user_id = ? AND m.type = ?`,
    [anilistUserId, type],
  );
  if (rows.length === 0) return 0;
  return reqN(rows[0].n);
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
 * Lightweight, source-agnostic record of one favourited entity ready
 * to be turned into an `Item` by the UI. Returned by
 * `getFavouritesAsItems` so the AniList tab can ship favourites to
 * the staged-items panel as a sortable batch without re-deriving the
 * per-type column shape (image vs cover_image, name_full vs name) on
 * every render.
 *
 * `externalId` is the AniList stable id so the AniList LIST filter
 * chips and detail modal can opportunistically attach when the favourite
 * is a media entity (ANIME/MANGA). For CHARACTERS/STAFF/STUDIOS the
 * caller materialises a manual-source Item — the AniList chip module
 * is media-only — and the externalId stays in the synthetic Item id
 * so future cross-source modules can still navigate back to the
 * underlying row.
 */
export interface FavouriteAsItem {
  externalId: number;
  label: string;
  imageUrl: string | null;
  /** Set for ANIME/MANGA favourites so the UI can append `(FORMAT)`. */
  format?: AnilistMediaFormat | null;
  searchTokens?: readonly string[];
  anilistLabelSource?: AnilistItemLabelSource;
}

/**
 * Read one user's favourites of `type` as a flat, sort-order-ranked
 * list of `(externalId, label, imageUrl)` rows. Drives the "+ Add N
 * favourites to staged" action on the start screen — the favourites
 * cache is updated by `runAnilistFavourites`, and this is the only
 * way the UI surfaces that data as sortable items.
 *
 * Ordered by AniList's `sort_order` so the user's preferred
 * favourite order is preserved (favourite #1 lands at index 0). The
 * receiving sort engine doesn't currently treat favourites as a
 * pre-ranked sublist (a favourites batch is added as `kind: 'flat'`
 * by the AniList tab), but keeping the order stable means a future
 * "use favourite order as ranking" CTA can lean on it without
 * another schema change.
 *
 * Labels honour the user's AniList display preferences (media title /
 * person name mode) via `pickMediaTitle` / `pickPersonName`, defaulting
 * to romaji-first for titles — same resolver the StartScreen import
 * preview uses, so labels stay consistent whether the user added the
 * item via list-import or via favourites. `searchTokens` always carry
 * every stored variant (all titles + synonyms, or all name variants +
 * character alternatives) so search is independent of the chosen mode.
 */
export async function getFavouritesAsItems(
  db: AnilistDbExecutor,
  anilistUserId: number,
  type: AnilistFavouriteType,
): Promise<FavouriteAsItem[]> {
  switch (type) {
    case 'ANIME':
    case 'MANGA': {
      const rows = await db.exec(
        `SELECT m.id          AS id,
                m.title_romaji  AS title_romaji,
                m.title_english AS title_english,
                m.title_native  AS title_native,
                m.synonyms_json AS synonyms_json,
                m.cover_image   AS cover_image,
                m.format        AS format
           FROM media_favourite mf
           JOIN media m ON m.id = mf.media_id
          WHERE mf.anilist_user_id = ? AND m.type = ?
          ORDER BY mf.sort_order ASC`,
        [anilistUserId, type],
      );
      return rows.map((r) => {
        const id = reqN(r.id);
        const titleFields = {
          id,
          title_romaji: s(r.title_romaji),
          title_english: s(r.title_english),
          title_native: s(r.title_native),
        };
        const format = s(r.format) as AnilistMediaFormat | null;
        const anilistLabelSource: AnilistItemLabelSource = {
          kind: 'media',
          titleFields,
          format,
        };
        return {
          externalId: id,
          label: pickMediaTitle(titleFields),
          imageUrl: s(r.cover_image),
          format,
          searchTokens: mediaTitleSearchParts({
            ...titleFields,
            synonyms_json: s(r.synonyms_json),
          }),
          anilistLabelSource,
        };
      });
    }
    case 'CHARACTERS': {
      const rows = await db.exec(
        `SELECT c.id                             AS id,
                c.name_full                      AS name_full,
                c.name_native                    AS name_native,
                c.name_alternatives_json         AS name_alternatives_json,
                c.name_alternatives_spoiler_json AS name_alternatives_spoiler_json,
                c.image                          AS image
           FROM character_favourite cf
           JOIN character c ON c.id = cf.character_id
          WHERE cf.anilist_user_id = ?
          ORDER BY cf.sort_order ASC`,
        [anilistUserId],
      );
      return rows.map((r) => {
        const id = reqN(r.id);
        const nameFields = {
          id,
          name_full: s(r.name_full),
          name_native: s(r.name_native),
        };
        const anilistLabelSource: AnilistItemLabelSource = {
          kind: 'person',
          nameFields,
          fallbackLabel: 'Character',
        };
        return {
          externalId: id,
          label: pickPersonName(nameFields, undefined, 'Character'),
          imageUrl: s(r.image),
          // Search also matches alternative spellings / nicknames so a
          // character is findable by any alias, not just the display one.
          searchTokens: characterNameSearchParts({
            ...nameFields,
            name_alternatives_json: s(r.name_alternatives_json),
            name_alternatives_spoiler_json: s(r.name_alternatives_spoiler_json),
          }),
          anilistLabelSource,
        };
      });
    }
    case 'STAFF': {
      const rows = await db.exec(
        `SELECT s.id          AS id,
                s.name_full   AS name_full,
                s.name_native AS name_native,
                s.image       AS image
           FROM staff_favourite sf
           JOIN staff s ON s.id = sf.staff_id
          WHERE sf.anilist_user_id = ?
          ORDER BY sf.sort_order ASC`,
        [anilistUserId],
      );
      return rows.map((r) => {
        const id = reqN(r.id);
        const nameFields = {
          id,
          name_full: s(r.name_full),
          name_native: s(r.name_native),
        };
        const anilistLabelSource: AnilistItemLabelSource = {
          kind: 'person',
          nameFields,
          fallbackLabel: 'Staff',
        };
        return {
          externalId: id,
          label: pickPersonName(nameFields, undefined, 'Staff'),
          imageUrl: s(r.image),
          searchTokens: personNameSearchParts(nameFields),
          anilistLabelSource,
        };
      });
    }
    case 'STUDIOS': {
      // Studios have no image column in the AniList schema — the
      // staged-items panel renders a placeholder cover for items
      // without imageUrl, so returning null here is correct.
      const rows = await db.exec(
        `SELECT st.id   AS id,
                st.name AS name
           FROM studio_favourite sf
           JOIN studio st ON st.id = sf.studio_id
          WHERE sf.anilist_user_id = ?
          ORDER BY sf.sort_order ASC`,
        [anilistUserId],
      );
      return rows.map((r) => {
        const id = reqN(r.id);
        const label = reqS(r.name);
        return {
          externalId: id,
          label,
          imageUrl: null,
          searchTokens: [label],
        };
      });
    }
  }
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

/**
 * Inverse-set lookup used by the LIST tab's "list status" filter
 * chip. Returns the subset of `candidateMediaIds` that DO have a
 * media_list_entry for `anilistUserId` whose `status` is NOT in
 * `allowedStatuses`. The caller subtracts this from the candidate
 * set so items missing a list entry entirely (e.g. favourites-only
 * imports without a corresponding list row) still pass through —
 * the chip's UX is "exclude entries with the wrong status", not
 * "require a list entry".
 *
 * Returns an empty Set if either input is empty, so callers don't
 * have to short-circuit.
 */
export async function getMediaIdsWithDisallowedListStatus(
  db: AnilistDbExecutor,
  anilistUserId: number,
  allowedStatuses: readonly string[],
  candidateMediaIds: readonly number[],
): Promise<Set<number>> {
  const out = new Set<number>();
  if (candidateMediaIds.length === 0) return out;
  if (allowedStatuses.length === 0) return out;
  const sql = `
    SELECT media_id FROM media_list_entry
    WHERE anilist_user_id = ?
      AND media_id IN (${placeholders(candidateMediaIds.length)})
      AND status NOT IN (${placeholders(allowedStatuses.length)})
  `;
  const rows = await db.exec(sql, [
    anilistUserId,
    ...candidateMediaIds,
    ...allowedStatuses,
  ] as readonly SqlBindable[]);
  for (const r of rows) out.add(reqN(r.media_id));
  return out;
}

/**
 * Universe of voice actors whose `character_voice_actor` rows
 * intersect the given candidate media set. Powers the VA chip's
 * picker: instead of listing every staff row in the DB (often
 * tens of thousands), we only surface VAs that could actually
 * filter the current slot. Sorted by name for stable display.
 *
 * Empty input -> empty result (no rows, no SQL). The chip's "fetch
 * cast for all N shows" affordance is responsible for *expanding*
 * the cached cast set when the user wants more VAs to choose from.
 */
export interface VoiceActorOption {
  id: number;
  name: string;
  language: string | null;
  /** Every stored name variant (full + native) for mode-independent search. */
  searchTokens: readonly string[];
}

export async function getVoiceActorsForCandidates(
  db: AnilistDbExecutor,
  candidateMediaIds: readonly number[],
): Promise<VoiceActorOption[]> {
  if (candidateMediaIds.length === 0) return [];
  const sql = `
    SELECT DISTINCT s.id        AS id,
                    s.name_full AS name_full,
                    s.name_native AS name_native,
                    s.language_v2 AS language_v2
      FROM character_voice_actor cva
      JOIN staff s ON s.id = cva.staff_id
     WHERE cva.media_id IN (${placeholders(candidateMediaIds.length)})
     ORDER BY COALESCE(s.name_full, s.name_native, '') COLLATE NOCASE
  `;
  const rows = await db.exec(
    sql,
    candidateMediaIds as readonly SqlBindable[],
  );
  return rows.map((r) => {
    const nameFields = {
      id: reqN(r.id),
      name_full: s(r.name_full),
      name_native: s(r.name_native),
    };
    return {
      id: nameFields.id,
      name: pickPersonName(nameFields, undefined, 'Staff'),
      language: s(r.language_v2),
      searchTokens: personNameSearchParts(nameFields),
    };
  });
}

/**
 * Partition `candidateMediaIds` into those that already have at
 * least one cached `character_voice_actor` row (cast cached) and
 * those that don't. Drives the VA chip's "Fetch cast for all N
 * shows" affordance: we only re-run lazy expansion against the
 * uncached side.
 */
export async function getMediaIdsWithCachedCast(
  db: AnilistDbExecutor,
  candidateMediaIds: readonly number[],
): Promise<Set<number>> {
  const out = new Set<number>();
  if (candidateMediaIds.length === 0) return out;
  // EXISTS is cheaper than DISTINCT on the junction — the (media_id,
  // character_id, …) PK already lets the planner stop at the first
  // matching row per media_id.
  const sql = `
    SELECT DISTINCT cva.media_id AS media_id
      FROM character_voice_actor cva
     WHERE cva.media_id IN (${placeholders(candidateMediaIds.length)})
  `;
  const rows = await db.exec(
    sql,
    candidateMediaIds as readonly SqlBindable[],
  );
  for (const r of rows) out.add(reqN(r.media_id));
  return out;
}

// ---------------------------------------------------------------------
// Character / staff helpers (powers the per-entity filter chip modules).
//
// All of these are pure reads over already-cached rows (favourites
// import populates `character` / `staff` directly; `media_character`
// + `character_voice_actor` are populated by media imports + lazy
// detail expansions). Nothing here triggers a network fetch — chips
// that need richer data than the cache holds surface that to the user
// instead of silently fetching.
// ---------------------------------------------------------------------

/**
 * Fetch character rows by AniList id. Empty input → empty output.
 * Order is not guaranteed; callers reorder when they need a deterministic
 * sort (most chip discovery sorts client-side anyway).
 */
export async function getCharactersByIds(
  db: AnilistDbExecutor,
  ids: readonly number[],
): Promise<
  Array<{
    id: number;
    name_full: string | null;
    name_native: string | null;
    gender: string | null;
    favourites: number | null;
  }>
> {
  if (ids.length === 0) return [];
  const sql = `
    SELECT id, name_full, name_native, gender, favourites
      FROM character
     WHERE id IN (${placeholders(ids.length)})
  `;
  const rows = await db.exec(sql, ids as readonly SqlBindable[]);
  return rows.map((r) => ({
    id: reqN(r.id),
    name_full: s(r.name_full),
    name_native: s(r.name_native),
    gender: s(r.gender),
    favourites: r.favourites === null || r.favourites === undefined ? null : reqN(r.favourites),
  }));
}

/**
 * Fetch staff rows by AniList id. Mirrors `getCharactersByIds` but
 * also surfaces `language_v2` since staff filter chips include a
 * language picker.
 */
export async function getStaffByIds(
  db: AnilistDbExecutor,
  ids: readonly number[],
): Promise<
  Array<{
    id: number;
    name_full: string | null;
    name_native: string | null;
    gender: string | null;
    language_v2: string | null;
    favourites: number | null;
  }>
> {
  if (ids.length === 0) return [];
  const sql = `
    SELECT id, name_full, name_native, gender, language_v2, favourites
      FROM staff
     WHERE id IN (${placeholders(ids.length)})
  `;
  const rows = await db.exec(sql, ids as readonly SqlBindable[]);
  return rows.map((r) => ({
    id: reqN(r.id),
    name_full: s(r.name_full),
    name_native: s(r.name_native),
    gender: s(r.gender),
    language_v2: s(r.language_v2),
    favourites: r.favourites === null || r.favourites === undefined ? null : reqN(r.favourites),
  }));
}

/**
 * Lightweight `{id, title}` projection used by character-/staff-side
 * "appears in media" chips. Title falls back through romaji → english
 * → native (matching the StartScreen waterfall) so the chip dropdown
 * shows what the user expects to see.
 */
export interface MediaOption {
  id: number;
  title: string;
}

function rowToMediaOption(r: DbRow): MediaOption {
  const id = reqN(r.id);
  const title = pickMediaTitle({
    id,
    title_romaji: s(r.title_romaji),
    title_english: s(r.title_english),
    title_native: s(r.title_native),
  });
  return { id, title };
}

/**
 * Distinct media that any of `characterIds` appears in, across the
 * cached `media_character` junction. Powers the character chip's
 * "appears in media" dropdown. Empty input or no junction rows → [].
 * Sorted by title (NOCASE) so the chip menu is browseable.
 */
export async function getMediaAppearancesForCharacters(
  db: AnilistDbExecutor,
  characterIds: readonly number[],
): Promise<MediaOption[]> {
  if (characterIds.length === 0) return [];
  const sql = `
    SELECT DISTINCT m.id          AS id,
                    m.title_romaji  AS title_romaji,
                    m.title_english AS title_english,
                    m.title_native  AS title_native
      FROM media_character mc
      JOIN media m ON m.id = mc.media_id
     WHERE mc.character_id IN (${placeholders(characterIds.length)})
     ORDER BY COALESCE(m.title_romaji, m.title_english, m.title_native, '')
              COLLATE NOCASE
  `;
  const rows = await db.exec(sql, characterIds as readonly SqlBindable[]);
  return rows.map(rowToMediaOption);
}

/**
 * Distinct voice actors who voice ANY of `characterIds`, across all
 * cached `character_voice_actor` rows (any language). Used by the
 * character chip's voice-actor picker. Returns staff id + a display
 * name (honouring the person-name display preference, falling back to
 * "Staff #id") plus `searchTokens` carrying every stored name variant.
 */
export async function getVoiceActorsByCharacterIds(
  db: AnilistDbExecutor,
  characterIds: readonly number[],
): Promise<VoiceActorOption[]> {
  if (characterIds.length === 0) return [];
  const sql = `
    SELECT DISTINCT s.id          AS id,
                    s.name_full   AS name_full,
                    s.name_native AS name_native,
                    s.language_v2 AS language_v2
      FROM character_voice_actor cva
      JOIN staff s ON s.id = cva.staff_id
     WHERE cva.character_id IN (${placeholders(characterIds.length)})
     ORDER BY COALESCE(s.name_full, s.name_native, '') COLLATE NOCASE
  `;
  const rows = await db.exec(sql, characterIds as readonly SqlBindable[]);
  return rows.map((r) => {
    const nameFields = {
      id: reqN(r.id),
      name_full: s(r.name_full),
      name_native: s(r.name_native),
    };
    return {
      id: nameFields.id,
      name: pickPersonName(nameFields, undefined, 'Staff'),
      language: s(r.language_v2),
      searchTokens: personNameSearchParts(nameFields),
    };
  });
}

/**
 * Distinct media that any of `staffIds` has voiced a character in,
 * across cached `character_voice_actor` rows. Powers the staff chip's
 * "voiced in media" dropdown.
 */
export async function getMediaVoicedByStaff(
  db: AnilistDbExecutor,
  staffIds: readonly number[],
): Promise<MediaOption[]> {
  if (staffIds.length === 0) return [];
  const sql = `
    SELECT DISTINCT m.id          AS id,
                    m.title_romaji  AS title_romaji,
                    m.title_english AS title_english,
                    m.title_native  AS title_native
      FROM character_voice_actor cva
      JOIN media m ON m.id = cva.media_id
     WHERE cva.staff_id IN (${placeholders(staffIds.length)})
     ORDER BY COALESCE(m.title_romaji, m.title_english, m.title_native, '')
              COLLATE NOCASE
  `;
  const rows = await db.exec(sql, staffIds as readonly SqlBindable[]);
  return rows.map(rowToMediaOption);
}

/**
 * Subset of `characterIds` that appear in at least one of `mediaIds`
 * via `media_character`. Used by the character chip's appears-in
 * filter at compute time. Returns Set for O(1) membership.
 */
export async function getCharacterIdsAppearingInMedia(
  db: AnilistDbExecutor,
  characterIds: readonly number[],
  mediaIds: readonly number[],
): Promise<Set<number>> {
  const out = new Set<number>();
  if (characterIds.length === 0 || mediaIds.length === 0) return out;
  const sql = `
    SELECT DISTINCT character_id
      FROM media_character
     WHERE character_id IN (${placeholders(characterIds.length)})
       AND media_id IN (${placeholders(mediaIds.length)})
  `;
  const rows = await db.exec(sql, [
    ...characterIds,
    ...mediaIds,
  ] as readonly SqlBindable[]);
  for (const r of rows) out.add(reqN(r.character_id));
  return out;
}

/**
 * Subset of `characterIds` voiced by at least one of `staffIds` across
 * any cached character_voice_actor row. Powers the character chip's
 * voice-actor filter.
 */
export async function getCharacterIdsVoicedByStaff(
  db: AnilistDbExecutor,
  characterIds: readonly number[],
  staffIds: readonly number[],
): Promise<Set<number>> {
  const out = new Set<number>();
  if (characterIds.length === 0 || staffIds.length === 0) return out;
  const sql = `
    SELECT DISTINCT character_id
      FROM character_voice_actor
     WHERE character_id IN (${placeholders(characterIds.length)})
       AND staff_id IN (${placeholders(staffIds.length)})
  `;
  const rows = await db.exec(sql, [
    ...characterIds,
    ...staffIds,
  ] as readonly SqlBindable[]);
  for (const r of rows) out.add(reqN(r.character_id));
  return out;
}

/**
 * Discriminator for the favourites-table helpers below. Avoids passing
 * a raw table name around (which would invite a SQL injection footgun
 * and decouple the helper from the static schema).
 */
export type FavouriteRankEntity = 'CHARACTERS' | 'STAFF';

function favouriteTableFor(
  entity: FavouriteRankEntity,
): { table: string; entityIdCol: string } {
  if (entity === 'CHARACTERS') {
    return { table: 'character_favourite', entityIdCol: 'character_id' };
  }
  return { table: 'staff_favourite', entityIdCol: 'staff_id' };
}

/**
 * Total number of favourites of `entity` for `anilistUserId`. Drives
 * the favourite-rank chip's slider universe: "you have N favourites,
 * pick a range from 1 to N". 0 when the user has none cached (or no
 * user exists) — the chip surfaces that as a "(no favourites cached)"
 * empty state.
 */
export async function getFavouriteCount(
  db: AnilistDbExecutor,
  anilistUserId: number,
  entity: FavouriteRankEntity,
): Promise<number> {
  const { table } = favouriteTableFor(entity);
  const rows = await db.exec(
    `SELECT COUNT(*) AS n FROM ${table} WHERE anilist_user_id = ?`,
    [anilistUserId],
  );
  if (rows.length === 0) return 0;
  return reqN(rows[0]!.n);
}

/**
 * Look up each id's favourite rank for `anilistUserId`. Returned as
 * 1-INDEXED ranks (matching what users see in the chip: "top 50" =
 * ranks 1..50, not 0..49). Ids not in the favourites table are
 * omitted from the Map — callers treat absence as "not a favourite".
 *
 * AniList stores `favouriteOrder` 0-indexed and we cache it verbatim
 * in `sort_order`. The +1 happens once here so chip code never has to
 * remember which convention is which.
 */
export async function getFavouriteRanksForIds(
  db: AnilistDbExecutor,
  anilistUserId: number,
  entity: FavouriteRankEntity,
  ids: readonly number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  const { table, entityIdCol } = favouriteTableFor(entity);
  const sql = `
    SELECT ${entityIdCol} AS entity_id, sort_order
      FROM ${table}
     WHERE anilist_user_id = ?
       AND ${entityIdCol} IN (${placeholders(ids.length)})
  `;
  const rows = await db.exec(sql, [
    anilistUserId,
    ...ids,
  ] as readonly SqlBindable[]);
  for (const r of rows) {
    out.set(reqN(r.entity_id), reqN(r.sort_order) + 1);
  }
  return out;
}

/**
 * Subset of `staffIds` that have voiced any character in at least one
 * of `mediaIds`. Mirror of `getCharacterIdsAppearingInMedia` for the
 * staff filter module.
 */
export async function getStaffIdsVoicedInMedia(
  db: AnilistDbExecutor,
  staffIds: readonly number[],
  mediaIds: readonly number[],
): Promise<Set<number>> {
  const out = new Set<number>();
  if (staffIds.length === 0 || mediaIds.length === 0) return out;
  const sql = `
    SELECT DISTINCT staff_id
      FROM character_voice_actor
     WHERE staff_id IN (${placeholders(staffIds.length)})
       AND media_id IN (${placeholders(mediaIds.length)})
  `;
  const rows = await db.exec(sql, [
    ...staffIds,
    ...mediaIds,
  ] as readonly SqlBindable[]);
  for (const r of rows) out.add(reqN(r.staff_id));
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
  getListedMediaCount: (anilistUserId: number, type: AnilistMediaType) =>
    getListedMediaCount(defaultDb(), anilistUserId, type),
  getListEntriesByMediaIds: (
    anilistUserId: number,
    mediaIds: readonly number[],
  ) => getListEntriesByMediaIds(defaultDb(), anilistUserId, mediaIds),
  getMediaDetail: (mediaId: number) => getMediaDetail(defaultDb(), mediaId),
  hasMediaCharacters: (mediaId: number) =>
    hasMediaCharacters(defaultDb(), mediaId),
  getAnilistUserById: (anilistUserId: number) =>
    getAnilistUserById(defaultDb(), anilistUserId),
  getAnilistUserByName: (name: string) =>
    getAnilistUserByName(defaultDb(), name),
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
  getFavouritesAsItems: (
    anilistUserId: number,
    type: AnilistFavouriteType,
  ) => getFavouritesAsItems(defaultDb(), anilistUserId, type),
  getMediaIdsWithDisallowedListStatus: (
    anilistUserId: number,
    allowedStatuses: readonly string[],
    candidateMediaIds: readonly number[],
  ) =>
    getMediaIdsWithDisallowedListStatus(
      defaultDb(),
      anilistUserId,
      allowedStatuses,
      candidateMediaIds,
    ),
  getVoiceActorsForCandidates: (candidateMediaIds: readonly number[]) =>
    getVoiceActorsForCandidates(defaultDb(), candidateMediaIds),
  getMediaIdsWithCachedCast: (candidateMediaIds: readonly number[]) =>
    getMediaIdsWithCachedCast(defaultDb(), candidateMediaIds),
  getMediaCastExpansionStatus: (mediaId: number) =>
    getMediaCastExpansionStatus(defaultDb(), mediaId),
  getStaffFilmography: (staffId: number) =>
    getStaffFilmography(defaultDb(), staffId),
  getMediaIdsInUserList: (
    anilistUserId: number,
    mediaIds: readonly number[],
  ) => getMediaIdsInUserList(defaultDb(), anilistUserId, mediaIds),
  getFavouriteCount: (anilistUserId: number, entity: FavouriteRankEntity) =>
    getFavouriteCount(defaultDb(), anilistUserId, entity),
  getFavouriteRanksForIds: (
    anilistUserId: number,
    entity: FavouriteRankEntity,
    ids: readonly number[],
  ) => getFavouriteRanksForIds(defaultDb(), anilistUserId, entity, ids),
};
