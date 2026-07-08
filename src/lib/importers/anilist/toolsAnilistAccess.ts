/**
 * DB-first AniList data access for Tools — prefers the shared source DB
 * when fresh (<90d), auto-refreshes stale graph data on normal runs, and
 * falls back to live GraphQL when the DB has no rows.
 */

import type { AnilistDbExecutor, AnilistImportContext } from './context';
import { ensureMediaCastExpanded, ensureCharacterMedia, ensureStaffFilmography } from './ensureGraph';
import { repairListedMediaNullSource } from './lazyExpansion';
import {
  getCharacterMediaFetchedAt,
  getProductionCreditsAtMedia,
  getStaffFilmographyFetchedAt,
  getVaCreditsAtMedia,
  hasCharacterMediaExpansion,
  hasStaffFilmography,
} from './graphQueries';
import { pickMediaTitle as pickMediaRowTitle } from './mediaDisplayLabel';
import { characterDateOfBirthFromRow } from './mappers';
import { pickCharacterName, pickPersonName } from './personDisplayLabel';
import { runAnilistImport, runAnilistFavourites } from './runners';
import type { ToolsFetchOptions } from './toolsFetchPolicy';
import { needsGraphDataRefresh } from './toolsFetchPolicy';
import { getToolsImportContext } from './toolsImportContext';
import { favCharactersDobSchemaKey } from './meta';
import {
  getAnilistUserByName,
  getLastFavouritesRefresh,
  getListedMediaCount,
  getMediaCastExpansionStatus,
  getMediaDetail,
  getMeta,
  getStaffFilmography,
  type AnilistUserSummary,
} from './readQueries';
import type { AnilistFavouriteType } from './types';
import {
  formatStartDateKey,
  pickMediaTitle,
  type StaffRoleMode,
  type StaffShowMap,
} from '../../../tools/panels/sharedCreditsLogic';
import {
  normalizeSeasonalListScore,
  type SeasonalShow,
} from '../../../tools/panels/seasonalScoresLogic';
import {
  mergeRoleIntoMap,
  mergeVaRoleIntoMap,
  type CreditedEntityMap,
  type ProductionFilmographyShow,
  type ShowStaffBundle,
} from '../../../tools/panels/sharedStaffLogic';
import type {
  CharacterMediaEdge,
  FavouriteCharacterInput,
  FavouriteStaffInput,
  VaMediaEdge,
} from '../../../tools/panels/favouritesLogic';
import { countMainRoleVaCharacters } from '../../../tools/panels/favouritesLogic';

/** Statuses used by Shared Credits list filter (matches `TOOLS_USER_ANIME_LIST_QUERY`). */
export const TOOLS_USER_LIST_STATUSES = [
  'CURRENT',
  'REPEATING',
  'COMPLETED',
  'PAUSED',
  'DROPPED',
] as const;

/** Non-planning list entries — matches `TOOLS_USER_CONSUMED_MEDIA_QUERY` (`status_not: PLANNING`). */
export const TOOLS_CONSUMED_LIST_STATUSES = [...TOOLS_USER_LIST_STATUSES] as const;

/**
 * Statuses fetched by Seasonal Scores. PLANNING is always included so
 * the "Include Planning" checkbox can filter client-side instantly —
 * without it, toggling the checkbox forced a full re-fetch. The
 * planning rows are cheap to fetch and tiny relative to the rest of
 * the list, so the cost is negligible. `bucketShowsForSeason` does the
 * actual planning filter in seasonalScoresLogic.
 */
export const TOOLS_SEASONAL_LIST_STATUSES = [
  'COMPLETED',
  'CURRENT',
  'REPEATING',
  'PAUSED',
  'PLANNING',
] as const;

function mediaRowStartDateKey(media: {
  start_year: number | null;
  start_month: number | null;
  start_day: number | null;
}): string {
  return formatStartDateKey({
    year: media.start_year,
    month: media.start_month,
    day: media.start_day,
  });
}

export async function ensureStaffFilmographyFreshWithContext(
  ctx: AnilistImportContext,
  staffId: number,
  options?: ToolsFetchOptions,
): Promise<void> {
  const fetchedAt = await getStaffFilmographyFetchedAt(ctx.db, staffId);
  const hasData = await hasStaffFilmography(ctx.db, staffId);
  const force =
    options?.forceRefresh ||
    !hasData ||
    needsGraphDataRefresh(fetchedAt, options);
  await ensureStaffFilmography(ctx, staffId, { force });
}

export async function ensureStaffFilmographyFresh(
  staffId: number,
  options?: ToolsFetchOptions,
): Promise<void> {
  await ensureStaffFilmographyFreshWithContext(getToolsImportContext(), staffId, options);
}

export async function ensureCharacterMediaFresh(
  characterId: number,
  options?: ToolsFetchOptions,
): Promise<void> {
  const ctx = getToolsImportContext();
  const fetchedAt = await getCharacterMediaFetchedAt(ctx.db, characterId);
  const hasData = await hasCharacterMediaExpansion(ctx.db, characterId);
  const force =
    options?.forceRefresh ||
    !hasData ||
    needsGraphDataRefresh(fetchedAt, options);
  await ensureCharacterMedia(ctx, characterId, { force });
}

export async function ensureMediaCastFreshWithContext(
  ctx: AnilistImportContext,
  mediaId: number,
  options?: ToolsFetchOptions,
): Promise<void> {
  const status = await getMediaCastExpansionStatus(ctx.db, mediaId);
  const force =
    options?.forceRefresh ||
    !status ||
    !status.charactersComplete ||
    !status.staffComplete ||
    needsGraphDataRefresh(status.charactersFetchedAt, options) ||
    needsGraphDataRefresh(status.staffFetchedAt, options);
  await ensureMediaCastExpanded(ctx, mediaId, { force });
}

export async function ensureMediaCastFresh(
  mediaId: number,
  options?: ToolsFetchOptions,
): Promise<void> {
  await ensureMediaCastFreshWithContext(getToolsImportContext(), mediaId, options);
}

/**
 * Ensure the user's anime OR manga list exists in the source DB — imports
 * when missing, empty, stale (>90d), or force-refresh was requested.
 * Generic over MediaType so the Franchise Scores tool can refresh both
 * lists through the same code path.
 */
export async function ensureUserMediaListFresh(
  username: string,
  type: 'ANIME' | 'MANGA',
  options?: ToolsFetchOptions,
): Promise<AnilistUserSummary | null> {
  const handle = username.trim();
  if (!handle) {
    return null;
  }
  const ctx = getToolsImportContext();
  let user = await getAnilistUserByName(ctx.db, handle);
  const count = user ? await getListedMediaCount(ctx.db, user.id, type) : 0;
  const needsImport =
    options?.forceRefresh ||
    !user ||
    count === 0 ||
    needsGraphDataRefresh(user.fetched_at, options);
  if (needsImport) {
    await runAnilistImport(handle, type);
    user = await getAnilistUserByName(ctx.db, handle);
    if (user) {
      await repairListedMediaNullSource(ctx, user.id, { type });
    }
  }
  return user;
}

/** ANIME-typed alias preserved so existing callers don't need to thread a type arg. */
export function ensureUserAnimeListFresh(
  username: string,
  options?: ToolsFetchOptions,
): Promise<AnilistUserSummary | null> {
  return ensureUserMediaListFresh(username, 'ANIME', options);
}

/** MANGA-typed alias for symmetry with {@link ensureUserAnimeListFresh}. */
export function ensureUserMangaListFresh(
  username: string,
  options?: ToolsFetchOptions,
): Promise<AnilistUserSummary | null> {
  return ensureUserMediaListFresh(username, 'MANGA', options);
}

async function getFavouriteRowCount(
  db: AnilistDbExecutor,
  anilistUserId: number,
  type: Extract<AnilistFavouriteType, 'CHARACTERS' | 'STAFF'>,
): Promise<number> {
  const table = type === 'CHARACTERS' ? 'character_favourite' : 'staff_favourite';
  const rows = await db.exec(
    `SELECT COUNT(*) AS count FROM ${table} WHERE anilist_user_id = ?`,
    [anilistUserId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function needsCharacterFavouritesDobBackfill(
  db: AnilistDbExecutor,
  anilistUserId: number,
): Promise<boolean> {
  const flag = await getMeta(db, favCharactersDobSchemaKey(anilistUserId));
  if (flag === '1') {
    return false;
  }
  const count = await getFavouriteRowCount(db, anilistUserId, 'CHARACTERS');
  return count > 0;
}

/**
 * Ensure the user's character or staff favourites exist in the source DB —
 * imports when missing, empty, stale (>90d), force-refresh was requested,
 * or character favourites predate birth-date schema.
 */
export async function ensureUserFavouritesFresh(
  username: string,
  type: Extract<AnilistFavouriteType, 'CHARACTERS' | 'STAFF'>,
  options?: ToolsFetchOptions,
): Promise<AnilistUserSummary | null> {
  const handle = username.trim();
  if (!handle) {
    return null;
  }
  const ctx = getToolsImportContext();
  let user = await getAnilistUserByName(ctx.db, handle);
  const count = user ? await getFavouriteRowCount(ctx.db, user.id, type) : 0;
  const lastRefresh = user
    ? await getLastFavouritesRefresh(ctx.db, user.id, type)
    : null;
  const needsDobBackfill =
    type === 'CHARACTERS' &&
    user != null &&
    (await needsCharacterFavouritesDobBackfill(ctx.db, user.id));
  const needsImport =
    options?.forceRefresh ||
    !user ||
    count === 0 ||
    needsGraphDataRefresh(lastRefresh, options) ||
    needsDobBackfill;
  if (needsImport) {
    await runAnilistFavourites(handle, type);
    user = await getAnilistUserByName(ctx.db, handle);
  }
  return user;
}

export async function readFavouriteCharactersFromDb(
  db: AnilistDbExecutor,
  anilistUserId: number,
): Promise<FavouriteCharacterInput[] | null> {
  const rows = await db.exec(
    `
      SELECT c.id,
             c.name_full,
             c.name_native,
             c.name_alternatives_json,
             c.name_alternatives_spoiler_json,
             c.gender,
             c.favourites,
             c.birth_year,
             c.birth_month,
             c.birth_day
        FROM character_favourite cf
        JOIN character c ON c.id = cf.character_id
       WHERE cf.anilist_user_id = ?
       ORDER BY cf.sort_order ASC
    `,
    [anilistUserId],
  );
  if (rows.length === 0) {
    return null;
  }
  return rows.map((row) => ({
    id: Number(row.id),
    name: {
      full: (row.name_full as string | null) ?? '',
      native: (row.name_native as string | null) ?? null,
      alternative: parseJsonStringArray(row.name_alternatives_json as string | null),
      alternativeSpoiler: parseJsonStringArray(
        row.name_alternatives_spoiler_json as string | null,
      ),
    },
    gender: (row.gender as string | null) ?? null,
    favourites: row.favourites != null ? Number(row.favourites) : null,
    dateOfBirth: characterDateOfBirthFromRow({
      birth_year: row.birth_year != null ? Number(row.birth_year) : null,
      birth_month: row.birth_month != null ? Number(row.birth_month) : null,
      birth_day: row.birth_day != null ? Number(row.birth_day) : null,
    }),
  }));
}

export async function readFavouriteStaffFromDb(
  db: AnilistDbExecutor,
  anilistUserId: number,
): Promise<FavouriteStaffInput[] | null> {
  const rows = await db.exec(
    `
      SELECT s.id,
             s.name_full,
             s.name_native,
             s.gender,
             s.favourites,
             s.image
        FROM staff_favourite sf
        JOIN staff s ON s.id = sf.staff_id
       WHERE sf.anilist_user_id = ?
       ORDER BY sf.sort_order ASC
    `,
    [anilistUserId],
  );
  if (rows.length === 0) {
    return null;
  }
  return rows.map((row) => ({
    id: Number(row.id),
    name: {
      full: (row.name_full as string | null) ?? '',
      native: (row.name_native as string | null) ?? null,
    },
    gender: (row.gender as string | null) ?? null,
    favourites: row.favourites != null ? Number(row.favourites) : null,
    image: (row.image as string | null)
      ? { large: row.image as string }
      : null,
  }));
}

/** Character media + JP voice cast from cached `media_character` / `character_voice_actor`. */
export async function readCharacterVoiceEdgesFromDb(
  db: AnilistDbExecutor,
  characterId: number,
): Promise<CharacterMediaEdge[] | null> {
  const rows = await db.exec(
    `
      SELECT m.id,
             m.title_romaji,
             m.title_english,
             m.title_native,
             m.synonyms_json,
             m.type,
             m.format,
             m.cover_image,
             mc.role AS character_role,
             st.id AS staff_id,
             st.name_full AS staff_name_full,
             st.name_native AS staff_name_native,
             st.image AS staff_image
        FROM media_character mc
        JOIN media m ON m.id = mc.media_id
        LEFT JOIN character_voice_actor cva
          ON cva.media_id = mc.media_id
         AND cva.character_id = mc.character_id
         AND cva.language = 'JAPANESE'
        LEFT JOIN staff st ON st.id = cva.staff_id
       WHERE mc.character_id = ?
       ORDER BY m.id ASC, st.id ASC
    `,
    [characterId],
  );
  if (rows.length === 0) {
    return null;
  }

  const byMedia = new Map<number, CharacterMediaEdge>();
  for (const row of rows) {
    const mediaId = Number(row.id);
    let edge = byMedia.get(mediaId);
    if (!edge) {
      edge = {
        node: {
          id: mediaId,
          title: {
            romaji: (row.title_romaji as string | null) ?? null,
            native: (row.title_native as string | null) ?? null,
            english: (row.title_english as string | null) ?? null,
          },
          synonyms: parseJsonStringArray(row.synonyms_json as string | null),
          type: (row.type as string) ?? 'ANIME',
          format: (row.format as string | null) ?? null,
          coverImage: (row.cover_image as string | null)
            ? { large: row.cover_image as string }
            : null,
        },
        characterRole: (row.character_role as string | null) ?? 'UNKNOWN',
        voiceActors: [],
      };
      byMedia.set(mediaId, edge);
    }
    if (row.staff_id != null) {
      const staffId = Number(row.staff_id);
      if (!edge.voiceActors.some((va) => va.id === staffId)) {
        edge.voiceActors.push({
          id: staffId,
          name: {
            full: (row.staff_name_full as string | null) ?? '',
            native: (row.staff_name_native as string | null) ?? null,
          },
          image: (row.staff_image as string | null)
            ? { large: row.staff_image as string }
            : null,
        });
      }
    }
  }
  return [...byMedia.values()];
}

/** Staff VA filmography edges from cached `character_voice_actor` (JP only). */
export async function readVaCharacterEdgesFromDb(
  db: AnilistDbExecutor,
  staffId: number,
): Promise<VaMediaEdge[] | null> {
  const rows = await db.exec(
    `
      SELECT cva.media_id,
             cva.character_id,
             mc.role AS character_role
        FROM character_voice_actor cva
        JOIN media_character mc
          ON mc.media_id = cva.media_id
         AND mc.character_id = cva.character_id
       WHERE cva.staff_id = ?
         AND cva.language = 'JAPANESE'
       ORDER BY cva.media_id ASC, cva.character_id ASC
    `,
    [staffId],
  );
  if (rows.length === 0) {
    return null;
  }

  const byMediaRole = new Map<
    string,
    { mediaId: number; characterRole: string; characterIds: number[] }
  >();
  for (const row of rows) {
    const mediaId = Number(row.media_id);
    const characterId = Number(row.character_id);
    const characterRole = (row.character_role as string | null) ?? 'UNKNOWN';
    const key = `${mediaId}:${characterRole}`;
    let entry = byMediaRole.get(key);
    if (!entry) {
      entry = { mediaId, characterRole, characterIds: [] };
      byMediaRole.set(key, entry);
    }
    entry.characterIds.push(characterId);
  }

  return [...byMediaRole.values()].map(({ mediaId, characterRole, characterIds }) => ({
    node: { id: mediaId },
    characterRole,
    characters: characterIds.map((id) => ({ id })),
  }));
}

/**
 * Main-role VA total on consumed media: characters this VA voices where the
 * character's best `media_character.role` on your list is MAIN (includes manga).
 */
export async function countVaMainRoleCharactersOnConsumedMediaFromDb(
  db: AnilistDbExecutor,
  staffId: number,
  consumedMediaIds: ReadonlySet<number>,
): Promise<number> {
  if (consumedMediaIds.size === 0) {
    return 0;
  }
  const mediaIds = [...consumedMediaIds];
  const mediaPlaceholders = mediaIds.map(() => '?').join(', ');
  const voicedRows = await db.exec(
    `
      SELECT DISTINCT character_id
        FROM character_voice_actor
       WHERE staff_id = ?
         AND language = 'JAPANESE'
         AND media_id IN (${mediaPlaceholders})
    `,
    [staffId, ...mediaIds],
  );
  const voicedCharacterIds = new Set(
    voicedRows.map((row) => Number(row.character_id)),
  );
  if (voicedCharacterIds.size === 0) {
    return 0;
  }
  const characterIds = [...voicedCharacterIds];
  const characterPlaceholders = characterIds.map(() => '?').join(', ');
  const roleRows = await db.exec(
    `
      SELECT character_id, role
        FROM media_character
       WHERE character_id IN (${characterPlaceholders})
         AND media_id IN (${mediaPlaceholders})
    `,
    [...characterIds, ...mediaIds],
  );
  return countMainRoleVaCharacters(
    voicedCharacterIds,
    roleRows.map((row) => ({
      characterId: Number(row.character_id),
      role: (row.role as string | null) ?? null,
    })),
  );
}

/** Staff avatar URLs from the local DB (populated by cast/filmography imports). */
export async function readStaffImagesFromDb(
  db: AnilistDbExecutor,
  staffIds: number[],
): Promise<Record<number, string | null>> {
  if (staffIds.length === 0) {
    return {};
  }
  const placeholders = staffIds.map(() => '?').join(', ');
  const rows = await db.exec(
    `SELECT id, image FROM staff WHERE id IN (${placeholders})`,
    staffIds,
  );
  const out: Record<number, string | null> = {};
  for (const row of rows) {
    out[Number(row.id)] = (row.image as string | null) ?? null;
  }
  return out;
}

/**
 * Full list entries (media_id + status + score) for a user, filtered by
 * media type. Franchise Scores reads this for both ANIME and MANGA to
 * stamp watched/scored status onto each franchise node. Returns an
 * empty array when the user has no entries of this type (so callers
 * can distinguish "empty list" from "user missing"); use the
 * surrounding `ensureUserMediaListFresh` to populate the table first.
 */
export async function readUserMediaListEntriesFromDb(
  db: AnilistDbExecutor,
  anilistUserId: number,
  type: 'ANIME' | 'MANGA',
): Promise<
  Array<{
    mediaId: number;
    status: string | null;
    score: number | null;
    startedYear: number | null;
    startedMonth: number | null;
    startedDay: number | null;
  }>
> {
  const rows = await db.exec(
    `SELECT mle.media_id, mle.status, mle.score,
            mle.started_year, mle.started_month, mle.started_day
       FROM media_list_entry mle
       JOIN media m ON m.id = mle.media_id
      WHERE mle.anilist_user_id = ?
        AND m.type = ?`,
    [anilistUserId, type],
  );
  return rows.map((row) => ({
    mediaId: Number(row.media_id),
    status: (row.status as string | null) ?? null,
    // SQL `score` is stored as the raw AniList score (0 = unrated); the
    // caller normalizes via `normalizeSeasonalListScore` so 0 → null.
    score: row.score != null ? Number(row.score) : null,
    startedYear: row.started_year != null ? Number(row.started_year) : null,
    startedMonth: row.started_month != null ? Number(row.started_month) : null,
    startedDay: row.started_day != null ? Number(row.started_day) : null,
  }));
}

export async function readUserListMediaIdsFromDb(
  db: AnilistDbExecutor,
  anilistUserId: number,
  statuses: readonly string[],
  mediaType: 'ANIME' | 'MANGA' = 'ANIME',
): Promise<Set<string>> {
  if (statuses.length === 0) {
    return new Set();
  }
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = await db.exec(
    `SELECT mle.media_id
       FROM media_list_entry mle
       JOIN media m ON m.id = mle.media_id
      WHERE mle.anilist_user_id = ?
        AND m.type = ?
        AND mle.status IN (${placeholders})`,
    [anilistUserId, mediaType, ...statuses],
  );
  return new Set(rows.map((r) => String(r.media_id)));
}

/**
 * Seasonal scores source after authenticated import — list entry notes and
 * hidden custom-list entries live here, not in `Page.mediaList`.
 */
export async function readUserSeasonalShowsFromDb(
  db: AnilistDbExecutor,
  anilistUserId: number,
): Promise<SeasonalShow[]> {
  const placeholders = TOOLS_SEASONAL_LIST_STATUSES.map(() => '?').join(', ');
  const rows = await db.exec(
    `SELECT m.id,
            m.title_english,
            m.title_romaji,
            m.title_native,
            m.cover_image,
            m.season,
            m.season_year,
            m.source,
            m.start_year,
            m.start_month,
            m.start_day,
            m.end_year,
            m.end_month,
            m.end_day,
            mle.status,
            mle.score,
            mle.notes
       FROM media_list_entry mle
       JOIN media m ON m.id = mle.media_id
      WHERE mle.anilist_user_id = ?
        AND m.type = 'ANIME'
        AND mle.status IN (${placeholders})`,
    [anilistUserId, ...TOOLS_SEASONAL_LIST_STATUSES],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    title: pickMediaTitle({
      english: (row.title_english as string | null) ?? null,
      romaji: (row.title_romaji as string | null) ?? null,
      native: (row.title_native as string | null) ?? null,
    }),
    titleSource: {
      id: Number(row.id),
      title_english: (row.title_english as string | null) ?? null,
      title_romaji: (row.title_romaji as string | null) ?? null,
      title_native: (row.title_native as string | null) ?? null,
    },
    coverImage: (row.cover_image as string | null) ?? null,
    season: (row.season as string | null) ?? null,
    seasonYear: row.season_year != null ? Number(row.season_year) : null,
    source: (row.source as SeasonalShow['source']) ?? null,
    startDate:
      row.start_year != null
        ? {
            year: Number(row.start_year),
            month: row.start_month != null ? Number(row.start_month) : null,
            day: row.start_day != null ? Number(row.start_day) : null,
          }
        : null,
    endDate:
      row.end_year != null
        ? {
            year: Number(row.end_year),
            month: row.end_month != null ? Number(row.end_month) : null,
            day: row.end_day != null ? Number(row.end_day) : null,
          }
        : null,
    score: normalizeSeasonalListScore(
      row.score != null ? Number(row.score) : null,
    ),
    notes: (row.notes as string | null) ?? null,
    listStatus: (row.status as string | null) ?? null,
  }));
}

export async function readStaffShowMapFromDb(
  db: AnilistDbExecutor,
  staffId: number,
  roleMode: StaffRoleMode,
): Promise<StaffShowMap | null> {
  const filmography = await getStaffFilmography(db, staffId);
  if (filmography.credits.length === 0 && roleMode === 'production') {
    return null;
  }

  if (roleMode === 'production') {
    const map: StaffShowMap = {};
    for (const credit of filmography.credits) {
      if (credit.productionRoles.length === 0) {
        continue;
      }
      const mediaId = String(credit.media.id);
      map[mediaId] = {
        title: pickMediaRowTitle(credit.media),
        roles: credit.productionRoles.map((role) => ({
          label: role,
          labelSource: { kind: 'production', staffRole: role },
        })),
        startDate: mediaRowStartDateKey(credit.media),
        coverImage: credit.media.cover_image,
        titleSource: {
          id: credit.media.id,
          title_english: credit.media.title_english,
          title_romaji: credit.media.title_romaji,
          title_native: credit.media.title_native,
        },
      };
    }
    return Object.keys(map).length > 0 ? map : null;
  }

  const voiceRows = await db.exec(
    `
      SELECT
        m.id,
        m.title_english,
        m.title_romaji,
        m.title_native,
        m.cover_image,
        m.start_year,
        m.start_month,
        m.start_day,
        c.id AS character_id,
        c.name_full AS character_name_full,
        c.name_native AS character_name_native,
        mc.role AS character_role
      FROM character_voice_actor cva
      JOIN media m ON m.id = cva.media_id
      JOIN character c ON c.id = cva.character_id
      LEFT JOIN media_character mc
        ON mc.media_id = cva.media_id AND mc.character_id = cva.character_id
      WHERE cva.staff_id = ?
    `,
    [staffId],
  );

  if (voiceRows.length === 0) {
    return null;
  }

  const map: StaffShowMap = {};
  for (const row of voiceRows) {
    const mediaId = String(row.id);
    const title = pickMediaRowTitle({
      id: Number(row.id),
      title_english: row.title_english as string | null,
      title_romaji: row.title_romaji as string | null,
      title_native: row.title_native as string | null,
    } as Parameters<typeof pickMediaRowTitle>[0]);
    const startDate = mediaRowStartDateKey({
      start_year: row.start_year as number | null,
      start_month: row.start_month as number | null,
      start_day: row.start_day as number | null,
    });
    if (!map[mediaId]) {
      map[mediaId] = {
        title,
        roles: [],
        startDate,
        coverImage: (row.cover_image as string | null) ?? null,
        titleSource: {
          id: Number(row.id),
          title_english: (row.title_english as string | null) ?? null,
          title_romaji: (row.title_romaji as string | null) ?? null,
          title_native: (row.title_native as string | null) ?? null,
        },
      };
    }
    const characterName = pickCharacterName(
      {
        id: Number(row.character_id ?? 0),
        name_full: (row.character_name_full as string | null) ?? null,
        name_native: (row.character_name_native as string | null) ?? null,
      },
      undefined,
      'Character',
    );
    const characterRole = (row.character_role as string | null) ?? 'UNKNOWN';
    const characterId = row.character_id != null ? Number(row.character_id) : undefined;
    map[mediaId].roles.push({
      label: `${characterName} (${characterRole})`,
      characterId: characterId && characterId > 0 ? characterId : undefined,
      labelSource: {
        kind: 'voice',
        characterId: characterId ?? 0,
        characterNameFull: (row.character_name_full as string | null) ?? null,
        characterNameNative: (row.character_name_native as string | null) ?? null,
        characterRole,
      },
    });
  }
  return map;
}

export async function readShowStaffBundleFromDb(
  db: AnilistDbExecutor,
  mediaId: number,
  title: string,
): Promise<ShowStaffBundle | null> {
  const detail = await getMediaDetail(db, mediaId);
  if (!detail) {
    return null;
  }

  const studios: CreditedEntityMap = {};
  for (const { studio, sortOrder } of detail.studios) {
    mergeRoleIntoMap(
      studios,
      studio.id,
      studio.name,
      sortOrder === 0 ? 'Main' : 'Supporting',
    );
  }

  const productionStaff: CreditedEntityMap = {};
  const prodCredits = await getProductionCreditsAtMedia(db, mediaId, 'all');
  for (const row of prodCredits) {
    row.roles.forEach((role, roleIndex) => {
      mergeRoleIntoMap(
        productionStaff,
        row.staff.id,
        pickPersonName(row.staff),
        role,
        roleIndex,
        row.staff.image,
      );
    });
  }

  const voiceActors: CreditedEntityMap = {};
  const vaCredits = await getVaCreditsAtMedia(db, mediaId, 'JAPANESE');
  for (const row of vaCredits) {
    const roleDescr = `${row.characterRole || 'UNKNOWN'} ${pickCharacterName(row.character)}`;
    mergeVaRoleIntoMap(
      voiceActors,
      row.staff.id,
      pickPersonName(row.staff),
      row.character.id,
      roleDescr,
      row.characterSortOrder,
      row.staff.image,
    );
  }

  if (
    Object.keys(studios).length === 0 &&
    Object.keys(productionStaff).length === 0 &&
    Object.keys(voiceActors).length === 0
  ) {
    return null;
  }

  // Prefer DB-derived title so display-pref changes (eng/romaji/native) honor
  // the new mode on rebuild. Fall back to the passed `title` (typically the
  // user's typed search) only when DB lacks all title fields for this media.
  return {
    id: mediaId,
    title: pickMediaRowTitle(detail.media, undefined, title || undefined),
    coverImage: detail.media.cover_image,
    studios,
    productionStaff,
    voiceActors,
  };
}

export async function readProductionFilmographyFromDb(
  db: AnilistDbExecutor,
  staffId: number,
): Promise<ProductionFilmographyShow[] | null> {
  const filmography = await getStaffFilmography(db, staffId);
  const shows: ProductionFilmographyShow[] = [];
  for (const credit of filmography.credits) {
    if (credit.productionRoles.length === 0) {
      continue;
    }
    shows.push({
      id: credit.media.id,
      title: pickMediaRowTitle(credit.media),
      roles: [...credit.productionRoles],
      titleSource: {
        id: credit.media.id,
        title_english: credit.media.title_english,
        title_romaji: credit.media.title_romaji,
        title_native: credit.media.title_native,
      },
      coverImage: credit.media.cover_image,
    });
  }
  return shows.length > 0 ? shows : null;
}

export async function readConsumedMediaIdsFromDb(
  db: AnilistDbExecutor,
  anilistUserId: number,
): Promise<Set<number> | null> {
  const [animeIds, mangaIds] = await Promise.all([
    readUserListMediaIdsFromDb(db, anilistUserId, TOOLS_CONSUMED_LIST_STATUSES, 'ANIME'),
    readUserListMediaIdsFromDb(db, anilistUserId, TOOLS_CONSUMED_LIST_STATUSES, 'MANGA'),
  ]);
  const merged = new Set([...animeIds, ...mangaIds].map((id) => Number(id)));
  return merged.size > 0 ? merged : null;
}

function parseJsonStringArray(json: string | null | undefined): string[] | null {
  if (!json) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const values = parsed.filter((entry): entry is string => typeof entry === 'string' && !!entry);
    return values.length > 0 ? values : null;
  } catch {
    return null;
  }
}
