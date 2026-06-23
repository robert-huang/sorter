/**
 * DB-first AniList data access for Tools — prefers the shared source DB
 * when fresh (<90d), auto-refreshes stale graph data on normal runs, and
 * falls back to live GraphQL when the DB has no rows.
 */

import type { AnilistDbExecutor } from './context';
import { ensureMediaCastExpanded, ensureStaffFilmography } from './ensureGraph';
import {
  getProductionCreditsAtMedia,
  getStaffFilmographyFetchedAt,
  getVaCreditsAtMedia,
  hasStaffFilmography,
} from './graphQueries';
import { pickMediaTitle as pickMediaRowTitle } from './mediaDisplayLabel';
import { pickPersonName } from './personDisplayLabel';
import {
  getAnilistUserByName,
  getListedMediaCount,
  getMediaCastExpansionStatus,
  getMediaDetail,
  getStaffFilmography,
  type AnilistUserSummary,
} from './readQueries';
import { runAnilistImport } from './runners';
import type { ToolsFetchOptions } from './toolsFetchPolicy';
import { needsGraphDataRefresh } from './toolsFetchPolicy';
import { getToolsImportContext } from './toolsImportContext';
import { toolsCacheDelete } from './toolsCache';
import {
  formatStartDateKey,
  type StaffRoleMode,
  type StaffShowMap,
} from '../../../tools/panels/sharedCreditsLogic';
import {
  mergeRoleIntoMap,
  type CreditedEntityMap,
  type ProductionFilmographyShow,
  type ShowStaffBundle,
} from '../../../tools/panels/sharedStaffLogic';

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

export async function ensureStaffFilmographyFresh(
  staffId: number,
  options?: ToolsFetchOptions,
): Promise<void> {
  const ctx = getToolsImportContext();
  const fetchedAt = await getStaffFilmographyFetchedAt(ctx.db, staffId);
  const hasData = await hasStaffFilmography(ctx.db, staffId);
  const force =
    options?.forceRefresh ||
    !hasData ||
    needsGraphDataRefresh(fetchedAt, options);
  await ensureStaffFilmography(ctx, staffId, { force });
}

export async function ensureMediaCastFresh(
  mediaId: number,
  options?: ToolsFetchOptions,
): Promise<void> {
  const ctx = getToolsImportContext();
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

/**
 * Ensure the user's anime list exists in the source DB — imports when
 * missing, empty, stale (>90d), or force-refresh was requested.
 */
export async function ensureUserAnimeListFresh(
  username: string,
  options?: ToolsFetchOptions,
): Promise<AnilistUserSummary | null> {
  const handle = username.trim();
  if (!handle) {
    return null;
  }
  const ctx = getToolsImportContext();
  let user = await getAnilistUserByName(ctx.db, handle);
  const count = user ? await getListedMediaCount(ctx.db, user.id, 'ANIME') : 0;
  const needsImport =
    options?.forceRefresh ||
    !user ||
    count === 0 ||
    needsGraphDataRefresh(user.fetched_at, options);
  if (needsImport) {
    await runAnilistImport(handle, 'ANIME');
    user = await getAnilistUserByName(ctx.db, handle);
  }
  return user;
}

export async function readUserListMediaIdsFromDb(
  db: AnilistDbExecutor,
  anilistUserId: number,
  statuses: readonly string[],
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
        AND m.type = 'ANIME'
        AND mle.status IN (${placeholders})`,
    [anilistUserId, ...statuses],
  );
  return new Set(rows.map((r) => String(r.media_id)));
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
        roles: [...credit.productionRoles],
        startDate: mediaRowStartDateKey(credit.media),
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
        m.start_year,
        m.start_month,
        m.start_day,
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
      map[mediaId] = { title, roles: [], startDate };
    }
    const characterName =
      (row.character_name_full as string | null) ??
      (row.character_name_native as string | null) ??
      'Unknown';
    const characterRole = (row.character_role as string | null) ?? 'UNKNOWN';
    map[mediaId].roles.push(`${characterName} (${characterRole})`);
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
      );
    });
  }

  const voiceActors: CreditedEntityMap = {};
  const vaCredits = await getVaCreditsAtMedia(db, mediaId, 'JAPANESE');
  for (const row of vaCredits) {
    const roleDescr = `${row.characterRole || 'UNKNOWN'} ${pickPersonName(row.character)}`;
    mergeRoleIntoMap(
      voiceActors,
      row.staff.id,
      pickPersonName(row.staff),
      roleDescr,
      row.characterSortOrder,
    );
  }

  if (
    Object.keys(studios).length === 0 &&
    Object.keys(productionStaff).length === 0 &&
    Object.keys(voiceActors).length === 0
  ) {
    return null;
  }

  return {
    id: mediaId,
    title: title || pickMediaRowTitle(detail.media),
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
    });
  }
  return shows.length > 0 ? shows : null;
}

/** Bust tools-cache keys tied to a username (right-click on username field). */
export async function bustToolsUserListCache(username: string): Promise<void> {
  const handle = username.trim().toLowerCase();
  if (!handle) {
    return;
  }
  await toolsCacheDelete(`tools:consumed-media:${handle}`);
}
