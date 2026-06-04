/**
 * Read paths for anime-to-anime adjacency and sorter graph UI.
 */

import type { AnilistDbExecutor, SqlBindable } from './context';
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

function rowToCharacterRow(r: Record<string, unknown>): CharacterRow {
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

export type VaCreditRow = {
  staff: StaffRow;
  character: CharacterRow;
  characterRole: string | null;
};

export type ProductionCreditRow = {
  staff: StaffRow;
  role: string;
};

export type AnimeFilmographyRow = {
  media: MediaRow;
  role: string;
};

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
      SELECT st.*, c.*, mc.role AS character_role
      FROM character_voice_actor cva
      JOIN staff st ON st.id = cva.staff_id
      JOIN character c ON c.id = cva.character_id
      JOIN media_character mc
        ON mc.media_id = cva.media_id AND mc.character_id = cva.character_id
      WHERE cva.media_id = ?${langFilter}
      ORDER BY st.name_full COLLATE NOCASE ASC, c.name_full COLLATE NOCASE ASC
    `,
    params,
  );
  return rows.map((r) => ({
    staff: rowToStaffRow(r),
    character: rowToCharacterRow(r),
    characterRole: s(r.character_role),
  }));
}

export async function getProductionCreditsAtMedia(
  db: AnilistDbExecutor,
  mediaId: number,
  roleMode: 'key' | 'all' = 'key',
): Promise<ProductionCreditRow[]> {
  const rows = await db.exec(
    `
      SELECT st.*, ms.role
      FROM media_staff ms
      JOIN staff st ON st.id = ms.staff_id
      WHERE ms.media_id = ?
      ORDER BY st.name_full COLLATE NOCASE ASC
    `,
    [mediaId],
  );
  const mapped = rows.map((r) => ({
    staff: rowToStaffRow(r),
    role: reqS(r.role),
  }));
  return filterProductionStaffRows(mapped, roleMode);
}

export async function getAnimeFilmographyForStaff(
  db: AnilistDbExecutor,
  staffId: number,
  roleMode: 'key' | 'all' = 'key',
): Promise<AnimeFilmographyRow[]> {
  const rows = await db.exec(
    `
      SELECT m.*, ms.role
      FROM media_staff ms
      JOIN media m ON m.id = ms.media_id
      WHERE ms.staff_id = ? AND m.type = 'ANIME'
      ORDER BY m.title_romaji COLLATE NOCASE ASC
    `,
    [staffId],
  );
  const mapped = rows.map((r) => ({
    media: rowToMediaRow(r),
    role: reqS(r.role),
  }));
  if (roleMode === 'all') {
    return mapped;
  }
  return filterProductionStaffRows(mapped, 'key');
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

/** Random anime from local cache matching optional filters. */
export async function pickRandomAnimeFromCache(
  db: AnilistDbExecutor,
  filters: {
    minScore?: number;
    seasonYearMin?: number;
    seasonYearMax?: number;
    formats?: readonly string[];
    country?: string;
  } = {},
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
