/**
 * Read paths for anime-to-anime adjacency and sorter graph UI.
 */

import { formatCharacterCastCredit } from './castRoleDisplay';
import type { AnilistDbExecutor, SqlBindable } from './context';
import { compareMediaByReleaseDateDesc } from './mediaSort';
import {
  compareProductionStaffByRolePriority,
  sortProductionRolesByPriority,
} from './productionRolePriority';
import { filterProductionStaffRows } from './staffRoleFilter';
import type { CharacterRow, MediaRow, StaffRow } from './types';

function placeholders(n: number): string {
  if (n === 0) return '';
  return new Array(n).fill('?').join(', ');
}

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

function rowToMediaRow(r: Record<string, unknown>): MediaRow {
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

function rowToStaffRow(r: Record<string, unknown>): StaffRow {
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

/** Staff row from a JOIN that aliases staff columns with an `st_` prefix. */
function rowToStaffRowPrefixed(r: Record<string, unknown>): StaffRow {
  return {
    id: reqN(r.st_id),
    name_full: s(r.st_name_full),
    name_native: s(r.st_name_native),
    image: s(r.st_image),
    age: s(r.st_age),
    gender: s(r.st_gender),
    language_v2: s(r.st_language_v2),
    favourites: n(r.st_favourites),
    fetched_at: reqN(r.st_fetched_at),
    updated_at: reqN(r.st_updated_at),
  };
}

/** Character row from a JOIN that aliases character columns with a `ch_` prefix. */
function rowToCharacterRowPrefixed(r: Record<string, unknown>): CharacterRow {
  return {
    id: reqN(r.ch_id),
    name_full: s(r.ch_name_full),
    name_native: s(r.ch_name_native),
    name_alternatives_json: s(r.ch_name_alternatives_json),
    name_alternatives_spoiler_json: s(r.ch_name_alternatives_spoiler_json),
    image: s(r.ch_image),
    age: s(r.ch_age),
    gender: s(r.ch_gender),
    favourites: n(r.ch_favourites),
    fetched_at: reqN(r.ch_fetched_at),
    updated_at: reqN(r.ch_updated_at),
  };
}

export type VaCreditRow = {
  staff: StaffRow;
  character: CharacterRow;
  /** MAIN | SUPPORTING | BACKGROUND from `media_character.role`. */
  characterRole: string | null;
  /** AniList cast edge order (`ROLE`, `RELEVANCE`, `ID`) cached at import. */
  characterSortOrder: number;
};

/** SQL `ORDER BY` for voice credits — role bucket, then AniList edge order. */
export const VA_CREDITS_ORDER_BY = `
  CASE mc.role
    WHEN 'MAIN' THEN 0
    WHEN 'SUPPORTING' THEN 1
    WHEN 'BACKGROUND' THEN 2
    ELSE 3
  END,
  mc.sort_order ASC,
  st.name_full COLLATE NOCASE ASC,
  c.id ASC
`;

export type ProductionCreditRow = {
  staff: StaffRow;
  roles: readonly string[];
};

/** SQL `ORDER BY` for production credits on a show — AniList edge order. */
export const PRODUCTION_CREDITS_ORDER_BY = `
  ms.sort_order ASC,
  ms.role COLLATE NOCASE ASC,
  st.id ASC
`;

export type AnimeFilmographyCreditKind = 'voice' | 'production';

export type AnimeFilmographyRow = {
  media: MediaRow;
  /** Voice: one line per character. Production: all staff roles on this show. */
  roles: readonly string[];
  creditKind: AnimeFilmographyCreditKind;
};

type AnimeFilmographyRowCore = Pick<AnimeFilmographyRow, 'media' | 'roles'>;

function sortFilmographyByReleaseDate(
  rows: AnimeFilmographyRowCore[],
  creditKind: AnimeFilmographyCreditKind,
): AnimeFilmographyRow[] {
  return [...rows]
    .sort((a, b) => compareMediaByReleaseDateDesc(a.media, b.media))
    .map((row) => ({ ...row, creditKind }));
}

function groupProductionCreditsByStaff(
  rows: readonly { staff: StaffRow; role: string; sortOrder: number }[],
): ProductionCreditRow[] {
  const order: number[] = [];
  const byId = new Map<number, { staff: StaffRow; roles: string[]; minSortOrder: number }>();

  for (const row of rows) {
    let entry = byId.get(row.staff.id);
    if (!entry) {
      entry = { staff: row.staff, roles: [], minSortOrder: row.sortOrder };
      byId.set(row.staff.id, entry);
      order.push(row.staff.id);
    } else {
      entry.minSortOrder = Math.min(entry.minSortOrder, row.sortOrder);
    }
    if (!entry.roles.includes(row.role)) {
      entry.roles.push(row.role);
    }
  }

  order.sort((a, b) => {
    const ae = byId.get(a)!;
    const be = byId.get(b)!;
    return compareProductionStaffByRolePriority(
      { roles: ae.roles, minSortOrder: ae.minSortOrder, staffId: a },
      { roles: be.roles, minSortOrder: be.minSortOrder, staffId: b },
    );
  });

  return order.map((id) => {
    const entry = byId.get(id)!;
    return {
      staff: entry.staff,
      roles: sortProductionRolesByPriority(entry.roles),
    };
  });
}

function groupVoiceFilmographyByMedia(
  rows: AnimeFilmographyRowCore[],
): AnimeFilmographyRowCore[] {
  const order: number[] = [];
  const byId = new Map<number, { media: MediaRow; roles: string[] }>();

  for (const row of rows) {
    let entry = byId.get(row.media.id);
    if (!entry) {
      entry = { media: row.media, roles: [] };
      byId.set(row.media.id, entry);
      order.push(row.media.id);
    }
    for (const role of row.roles) {
      if (!entry.roles.includes(role)) {
        entry.roles.push(role);
      }
    }
  }

  return order.map((id) => {
    const entry = byId.get(id)!;
    return { media: entry.media, roles: entry.roles };
  });
}

function groupProductionFilmographyByMedia(
  rows: readonly { media: MediaRow; role: string; sortOrder: number }[],
): AnimeFilmographyRowCore[] {
  const order: number[] = [];
  const byId = new Map<
    number,
    { media: MediaRow; roles: string[]; minSortOrder: number }
  >();

  for (const row of rows) {
    let entry = byId.get(row.media.id);
    if (!entry) {
      entry = { media: row.media, roles: [], minSortOrder: row.sortOrder };
      byId.set(row.media.id, entry);
      order.push(row.media.id);
    } else {
      entry.minSortOrder = Math.min(entry.minSortOrder, row.sortOrder);
    }
    if (!entry.roles.includes(row.role)) {
      entry.roles.push(row.role);
    }
  }

  order.sort((a, b) => {
    const ao = byId.get(a)!.minSortOrder;
    const bo = byId.get(b)!.minSortOrder;
    if (ao !== bo) {
      return ao - bo;
    }
    return a - b;
  });

  return order.map((id) => {
    const entry = byId.get(id)!;
    return { media: entry.media, roles: entry.roles };
  });
}

export type MediaRelationRow = {
  media: MediaRow;
  relationType: string;
};

export async function getVaCreditsAtMedia(
  db: AnilistDbExecutor,
  mediaId: number,
  language?: string,
): Promise<VaCreditRow[]> {
  const params: SqlBindable[] = [mediaId];
  let langFilter = '';
  if (language) {
    langFilter = ' AND cva.language = ?';
    params.push(language);
  }
  const rows = await db.exec(
    `
      SELECT
        st.id AS st_id,
        st.name_full AS st_name_full,
        st.name_native AS st_name_native,
        st.image AS st_image,
        st.age AS st_age,
        st.gender AS st_gender,
        st.language_v2 AS st_language_v2,
        st.favourites AS st_favourites,
        st.fetched_at AS st_fetched_at,
        st.updated_at AS st_updated_at,
        c.id AS ch_id,
        c.name_full AS ch_name_full,
        c.name_native AS ch_name_native,
        c.name_alternatives_json AS ch_name_alternatives_json,
        c.name_alternatives_spoiler_json AS ch_name_alternatives_spoiler_json,
        c.image AS ch_image,
        c.age AS ch_age,
        c.gender AS ch_gender,
        c.favourites AS ch_favourites,
        c.fetched_at AS ch_fetched_at,
        c.updated_at AS ch_updated_at,
        mc.role AS character_role,
        mc.sort_order AS character_sort_order
      FROM character_voice_actor cva
      JOIN staff st ON st.id = cva.staff_id
      JOIN character c ON c.id = cva.character_id
      JOIN media_character mc
        ON mc.media_id = cva.media_id AND mc.character_id = cva.character_id
      WHERE cva.media_id = ?${langFilter}
      ORDER BY ${VA_CREDITS_ORDER_BY}
    `,
    params,
  );
  return rows.map((r) => ({
    staff: rowToStaffRowPrefixed(r),
    character: rowToCharacterRowPrefixed(r),
    characterRole: s(r.character_role),
    characterSortOrder: Number(r.character_sort_order ?? 0),
  }));
}

export async function getProductionCreditsAtMedia(
  db: AnilistDbExecutor,
  mediaId: number,
  roleMode: 'key' | 'all' = 'key',
): Promise<ProductionCreditRow[]> {
  const rows = await db.exec(
    `
      SELECT st.*, ms.role, ms.sort_order
      FROM media_staff ms
      JOIN staff st ON st.id = ms.staff_id
      WHERE ms.media_id = ?
      ORDER BY ${PRODUCTION_CREDITS_ORDER_BY}
    `,
    [mediaId],
  );
  const mapped = rows.map((r) => ({
    staff: rowToStaffRow(r),
    role: reqS(r.role),
    sortOrder: Number(r.sort_order ?? 0),
  }));
  return groupProductionCreditsByStaff(filterProductionStaffRows(mapped, roleMode));
}

async function getVoiceAnimeFilmographyForStaff(
  db: AnilistDbExecutor,
  staffId: number,
): Promise<AnimeFilmographyRowCore[]> {
  const rows = await db.exec(
    `
      SELECT
        m.*,
        c.name_full AS ch_name_full,
        c.name_native AS ch_name_native,
        mc.role AS character_role,
        mc.sort_order AS character_sort_order
      FROM character_voice_actor cva
      JOIN media m ON m.id = cva.media_id AND m.type = 'ANIME'
      JOIN character c ON c.id = cva.character_id
      LEFT JOIN media_character mc
        ON mc.media_id = cva.media_id AND mc.character_id = cva.character_id
      WHERE cva.staff_id = ?
    `,
    [staffId],
  );
  const perCharacter = rows.map((r) => {
    const characterName = s(r.ch_name_full) ?? s(r.ch_name_native);
    return {
      media: rowToMediaRow(r),
      roles: [formatCharacterCastCredit(characterName, s(r.character_role))],
      sortOrder: Number(r.character_sort_order ?? 0),
      roleKey: vaCreditRoleSortKeyFromDb(s(r.character_role)),
    };
  });
  perCharacter.sort((a, b) => {
    if (a.roleKey !== b.roleKey) {
      return a.roleKey - b.roleKey;
    }
    if (a.sortOrder !== b.sortOrder) {
      return a.sortOrder - b.sortOrder;
    }
    return a.roles[0].localeCompare(b.roles[0]);
  });
  return groupVoiceFilmographyByMedia(
    perCharacter.map(({ media, roles }) => ({ media, roles })),
  );
}

function vaCreditRoleSortKeyFromDb(role: string | null): number {
  if (role === 'MAIN') return 0;
  if (role === 'SUPPORTING') return 1;
  if (role === 'BACKGROUND') return 2;
  return 3;
}

async function getProductionAnimeFilmographyForStaff(
  db: AnilistDbExecutor,
  staffId: number,
  roleMode: 'key' | 'all',
): Promise<AnimeFilmographyRowCore[]> {
  const rows = await db.exec(
    `
      SELECT m.*, ms.role, ms.sort_order
      FROM media_staff ms
      JOIN media m ON m.id = ms.media_id
      WHERE ms.staff_id = ? AND m.type = 'ANIME'
      ORDER BY ms.sort_order ASC, ms.role COLLATE NOCASE ASC
    `,
    [staffId],
  );
  const mapped = rows.map((r) => ({
    media: rowToMediaRow(r),
    role: reqS(r.role),
    sortOrder: Number(r.sort_order ?? 0),
  }));
  return groupProductionFilmographyByMedia(filterProductionStaffRows(mapped, roleMode));
}

/**
 * Staff anime credits — character (VA) roles first, then production/staff roles,
 * each block sorted by show start date descending (AniList default). Pure
 * production staff have no CVA rows; VAs can list the same show twice (acted + sang).
 */
export async function getAnimeFilmographyForStaff(
  db: AnilistDbExecutor,
  staffId: number,
  roleMode: 'key' | 'all' = 'key',
): Promise<AnimeFilmographyRow[]> {
  const voice = sortFilmographyByReleaseDate(
    await getVoiceAnimeFilmographyForStaff(db, staffId),
    'voice',
  );
  const production = sortFilmographyByReleaseDate(
    await getProductionAnimeFilmographyForStaff(db, staffId, roleMode),
    'production',
  );

  if (voice.length === 0) {
    return production;
  }
  return [...voice, ...production];
}

export async function searchAnimeInCache(
  db: AnilistDbExecutor,
  query: string,
  limit = 20,
): Promise<MediaRow[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const needle = `%${trimmed.toLowerCase()}%`;
  const rows = await db.exec(
    `
      SELECT * FROM media
      WHERE type = 'ANIME'
        AND (
          lower(coalesce(title_romaji, '')) LIKE ?
          OR lower(coalesce(title_english, '')) LIKE ?
          OR lower(coalesce(title_native, '')) LIKE ?
          OR lower(coalesce(synonyms_json, '')) LIKE ?
        )
      ORDER BY title_romaji COLLATE NOCASE ASC
      LIMIT ?
    `,
    [needle, needle, needle, needle, limit],
  );
  return rows.map((r) => rowToMediaRow(r));
}

export async function getMediaRelations(
  db: AnilistDbExecutor,
  fromMediaId: number,
): Promise<MediaRelationRow[]> {
  const rows = await db.exec(
    `
      SELECT m.*, mr.relation_type
      FROM media_relation mr
      JOIN media m ON m.id = mr.to_media_id
      WHERE mr.from_media_id = ? AND m.type = 'ANIME'
      ORDER BY m.title_romaji COLLATE NOCASE ASC
    `,
    [fromMediaId],
  );
  return rows.map((r) => ({
    media: rowToMediaRow(r),
    relationType: reqS(r.relation_type),
  }));
}

export async function hasStaffFilmography(
  db: AnilistDbExecutor,
  staffId: number,
): Promise<boolean> {
  const rows = await db.exec(
    'SELECT 1 FROM staff_filmography_expansion WHERE staff_id = ? LIMIT 1',
    [staffId],
  );
  return rows.length > 0;
}

export async function getStaffFilmographyFetchedAt(
  db: AnilistDbExecutor,
  staffId: number,
): Promise<number | null> {
  const rows = await db.exec(
    'SELECT fetched_at FROM staff_filmography_expansion WHERE staff_id = ?',
    [staffId],
  );
  if (rows.length === 0) {
    return null;
  }
  return n(rows[0].fetched_at);
}

export type AnimeCacheStats = {
  totalMedia: number;
  animeCount: number;
  mangaCount: number;
};

export async function getAnimeCacheStats(db: AnilistDbExecutor): Promise<AnimeCacheStats> {
  const rows = await db.exec(`
    SELECT
      COUNT(*) AS total_media,
      SUM(CASE WHEN type = 'ANIME' THEN 1 ELSE 0 END) AS anime_count,
      SUM(CASE WHEN type = 'MANGA' THEN 1 ELSE 0 END) AS manga_count
    FROM media
  `);
  if (rows.length === 0) {
    return { totalMedia: 0, animeCount: 0, mangaCount: 0 };
  }
  const r = rows[0];
  return {
    totalMedia: Number(r.total_media ?? 0),
    animeCount: Number(r.anime_count ?? 0),
    mangaCount: Number(r.manga_count ?? 0),
  };
}

export type AnimeRandomPickFilters = {
  minScore?: number;
  seasonYearMin?: number;
  seasonYearMax?: number;
  formats?: readonly string[];
  country?: string;
};

export function hasAnimeRandomFilters(filters: AnimeRandomPickFilters = {}): boolean {
  return (
    filters.minScore !== undefined ||
    filters.seasonYearMin !== undefined ||
    filters.seasonYearMax !== undefined ||
    Boolean(filters.country) ||
    (filters.formats !== undefined && filters.formats.length > 0)
  );
}

/** User-facing reason when {@link pickRandomAnimeFromCache} returns null. */
export function describeAnimeRandomPickFailure(params: {
  stats: AnimeCacheStats;
  storageMode: 'opfs' | 'memory';
  filters?: AnimeRandomPickFilters;
}): string {
  const { stats, storageMode, filters = {} } = params;

  if (storageMode === 'memory') {
    return (
      'This tab cannot see your saved AniList database — another Sorter tab has the local file open. ' +
      'Close other Sorter tabs, reload this page, then try Random from cache again.'
    );
  }

  if (stats.totalMedia === 0) {
    return (
      'No titles in this browser’s AniList cache. On the main Sorter page, open START → AniList and import lists or favourites.'
    );
  }

  if (stats.animeCount === 0) {
    return `Your cache has ${stats.totalMedia} title(s) but none are anime. Import an anime list or favourite anime on START → AniList.`;
  }

  if (hasAnimeRandomFilters(filters)) {
    return 'No anime in cache match the current filters. Broaden filters or import more anime.';
  }

  return 'No anime found in cache. Try reloading the page.';
}

/** Random anime from local cache matching optional filters. */
export async function pickRandomAnimeFromCache(
  db: AnilistDbExecutor,
  filters: AnimeRandomPickFilters = {},
): Promise<MediaRow | null> {
  const clauses = [`type = 'ANIME'`];
  const params: SqlBindable[] = [];
  if (filters.minScore !== undefined) {
    clauses.push('mean_score >= ?');
    params.push(filters.minScore);
  }
  if (filters.seasonYearMin !== undefined) {
    clauses.push('season_year >= ?');
    params.push(filters.seasonYearMin);
  }
  if (filters.seasonYearMax !== undefined) {
    clauses.push('season_year <= ?');
    params.push(filters.seasonYearMax);
  }
  if (filters.country) {
    clauses.push('country_of_origin = ?');
    params.push(filters.country);
  }
  if (filters.formats && filters.formats.length > 0) {
    clauses.push(`format IN (${placeholders(filters.formats.length)})`);
    params.push(...filters.formats);
  }
  const sql = `
    SELECT * FROM media
    WHERE ${clauses.join(' AND ')}
    ORDER BY RANDOM()
    LIMIT 1
  `;
  const rows = await db.exec(sql, params);
  if (rows.length === 0) {
    return null;
  }
  return rowToMediaRow(rows[0]);
}

export interface UserListRandomPickOptions {
  /**
   * Drop `PLANNING` entries so only anime the user has actually
   * started/finished (CURRENT / COMPLETED / PAUSED / DROPPED / REPEATING)
   * are eligible. The A2A picker passes this on.
   */
  excludePlanning?: boolean;
}

/**
 * Pick one random ANIME from a specific user's cached list, scoped to
 * `media_list_entry` rows for `anilistUserId`. Mirrors
 * {@link pickRandomAnimeFromCache} but joins the per-user list table so
 * the universe is "what this user has on their AniList list" rather than
 * "everything in the local cache". Returns null when the user has no
 * eligible entries cached.
 */
export async function pickRandomAnimeFromUserListCache(
  db: AnilistDbExecutor,
  anilistUserId: number,
  options: UserListRandomPickOptions = {},
): Promise<MediaRow | null> {
  const clauses = [`m.type = 'ANIME'`, 'mle.anilist_user_id = ?'];
  const params: SqlBindable[] = [anilistUserId];
  if (options.excludePlanning) {
    clauses.push(`mle.status != 'PLANNING'`);
  }
  const sql = `
    SELECT m.*
      FROM media m
      JOIN media_list_entry mle ON mle.media_id = m.id
     WHERE ${clauses.join(' AND ')}
     ORDER BY RANDOM()
     LIMIT 1
  `;
  const rows = await db.exec(sql, params);
  if (rows.length === 0) {
    return null;
  }
  return rowToMediaRow(rows[0]);
}
