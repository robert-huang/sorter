import { depaginate } from '../../lib/importers/anilist/depaginate';
import { resolveAccessTokenForUsername } from '../../lib/importers/anilist/anilistAuth';
import { isGraphTimestampStale } from '../../lib/importers/anilist/graphConstants';
import { TOOLS_STATS_LIST_QUERY } from '../../lib/importers/anilist/queries';
import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import {
  ensureMediaCastFreshBatch,
  ensureMediaStudiosFreshBatch,
  readShowStaffBundleFromDb,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import {
  TOOLS_SESSION_TTL_MS,
  sessionMemoDelete,
  withSessionTtlMemo,
} from '../../lib/importers/anilist/toolsSessionMemo';
import { pickMediaTitle } from './sharedCreditsLogic';
import { pickCharacterName, pickPersonName } from '../../lib/importers/anilist/personDisplayLabel';
import {
  getMediaCastExpansionStatus,
  getMediaDetail,
  type MediaCastExpansionStatus,
} from '../../lib/importers/anilist/readQueries';
import {
  getProductionCreditsAtMedia,
  getVaCreditsAtMedia,
} from '../../lib/importers/anilist/graphQueries';
import type {
  StatsCachedData,
  StatsEntry,
  StatsMediaTag,
  StatsMediaType,
  StatsStaffCredit,
  StatsStudioLink,
  StatsVaCredit,
} from './statsLogic';
import {
  normalizeCharacterRoleForStats,
  mapStatsStudioLinks,
  type StatsStartDate,
} from './statsLogic';
import { normalizeSeasonalListScore } from './seasonalScoresLogic';

export type StatsFetchProgress = {
  phase: 'list' | 'cast';
  index: number;
  total: number;
};

export type StatsFetchOptions = ToolsFetchOptions & {
  onProgress?: (progress: StatsFetchProgress) => void;
  signal?: AbortSignal;
};

export function bustStatsSessionMemo(username: string, mediaType: StatsMediaType): void {
  const handle = username.trim().toLowerCase();
  if (!handle) {
    return;
  }
  sessionMemoDelete(`stats:list:${handle}:${mediaType}`);
}

type GqlStatsListMedia = {
  id: number;
  title: { english?: string | null; romaji?: string | null; native?: string | null };
  coverImage?: { large?: string | null } | null;
  format?: string | null;
  status?: string | null;
  episodes?: number | null;
  chapters?: number | null;
  volumes?: number | null;
  duration?: number | null;
  meanScore?: number | null;
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
};

type GqlStatsListEntry = {
  status?: string | null;
  score?: number | null;
  progress?: number | null;
  progressVolumes?: number | null;
  repeat?: number | null;
  notes?: string | null;
  media: GqlStatsListMedia;
};

function parseGenresJson(json: string | null | undefined): string[] {
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
}

function isStatsCastExpansionStale(status: MediaCastExpansionStatus): boolean {
  if (!status.charactersComplete && !status.staffComplete) {
    return false;
  }
  return (
    isGraphTimestampStale(status.charactersFetchedAt) ||
    isGraphTimestampStale(status.staffFetchedAt)
  );
}

export async function countStaleStatsCastMedia(mediaIds: readonly number[]): Promise<number> {
  if (mediaIds.length === 0) {
    return 0;
  }
  const ctx = getToolsImportContext();
  let count = 0;
  for (const mediaId of mediaIds) {
    const status = await getMediaCastExpansionStatus(ctx.db, mediaId);
    if (status && isStatsCastExpansionStale(status)) {
      count += 1;
    }
  }
  return count;
}

function emptyStatsStartDate(): StatsStartDate {
  return { year: null, month: null, day: null };
}

function mapStatsStartDate(
  raw?: { year?: number | null; month?: number | null; day?: number | null } | null,
): StatsStartDate {
  if (!raw) {
    return emptyStatsStartDate();
  }
  return {
    year: raw.year ?? null,
    month: raw.month ?? null,
    day: raw.day ?? null,
  };
}

function startDateFromMediaRow(media: {
  start_year: number | null;
  start_month: number | null;
  start_day: number | null;
}): StatsStartDate {
  return {
    year: media.start_year,
    month: media.start_month,
    day: media.start_day,
  };
}

async function readMediaMetadataFromDb(
  mediaIds: readonly number[],
  signal?: AbortSignal,
): Promise<
  Map<
    number,
    {
      genres: string[];
      tags: StatsMediaTag[];
      studios: StatsStudioLink[];
      meanScore: number | null;
      format: string | null;
      status: string | null;
      episodes: number | null;
      chapters: number | null;
      volumes: number | null;
      startDate: StatsStartDate;
    }
  >
> {
  const ctx = getToolsImportContext();
  const out = new Map<
    number,
    {
      genres: string[];
      tags: StatsMediaTag[];
      studios: StatsStudioLink[];
      meanScore: number | null;
      format: string | null;
      status: string | null;
      episodes: number | null;
      chapters: number | null;
      volumes: number | null;
      startDate: StatsStartDate;
    }
  >();
  for (const mediaId of mediaIds) {
    signal?.throwIfAborted();
    const detail = await getMediaDetail(ctx.db, mediaId);
    if (!detail) {
      continue;
    }
    const studios: StatsStudioLink[] = mapStatsStudioLinks(
      detail.studios.map(({ studio, sortOrder, isMain }) => ({
        studioId: studio.id,
        studioName: studio.name,
        isMain,
        sortOrder,
      })),
    );
    out.set(mediaId, {
      genres: parseGenresJson(detail.media.genres_json),
      tags: detail.tags.map((t) => ({ name: t.name, rank: t.rank })),
      studios,
      meanScore: detail.media.mean_score,
      format: detail.media.format,
      status: detail.media.status,
      episodes: detail.media.episodes,
      chapters: detail.media.chapters,
      volumes: null,
      startDate: startDateFromMediaRow(detail.media),
    });
  }
  return out;
}

async function readStaffCreditsForMedia(mediaId: number): Promise<StatsStaffCredit[]> {
  const ctx = getToolsImportContext();
  const rows = await getProductionCreditsAtMedia(ctx.db, mediaId, 'all');
  const credits: StatsStaffCredit[] = [];
  for (const row of rows) {
    for (const role of row.roles) {
      credits.push({
        staffId: row.staff.id,
        staffName: pickPersonName(row.staff),
        staffImage: row.staff.image,
        staffGender: row.staff.gender,
        role,
      });
    }
  }
  return credits;
}

async function readVaCreditsForMedia(mediaId: number): Promise<StatsVaCredit[]> {
  const ctx = getToolsImportContext();
  const rows = await getVaCreditsAtMedia(ctx.db, mediaId, 'JAPANESE');
  return rows.map((row) => ({
    staffId: row.staff.id,
    staffName: pickPersonName(row.staff),
    staffImage: row.staff.image,
    staffGender: row.staff.gender,
    characterId: row.character.id,
    characterName: pickCharacterName(row.character),
    characterRole: normalizeCharacterRoleForStats(row.characterRole),
  }));
}

async function attachCastToEntries(
  entries: StatsEntry[],
  options?: StatsFetchOptions,
): Promise<StatsEntry[]> {
  const mediaIds = entries.map((e) => e.mediaId);
  await ensureMediaCastFreshBatch(mediaIds, options);
  const ctx = getToolsImportContext();
  const out: StatsEntry[] = [];
  let index = 0;
  for (const entry of entries) {
    options?.signal?.throwIfAborted();
    index += 1;
    options?.onProgress?.({ phase: 'cast', index, total: entries.length });
    const bundle = await readShowStaffBundleFromDb(ctx.db, entry.mediaId, entry.title);
    const staffCredits = bundle
      ? Object.entries(bundle.productionStaff).flatMap(([staffId, meta]) =>
          meta.roles.map((role) => ({
            staffId: Number(staffId),
            staffName: meta.name,
            staffImage: meta.image ?? null,
            staffGender: null,
            role,
          })),
        )
      : await readStaffCreditsForMedia(entry.mediaId);
    const vaCredits = bundle
      ? Object.entries(bundle.voiceActors).flatMap(([staffId, meta]) =>
          meta.roles.map((roleDescr, idx) => {
            const roleMatch = roleDescr.match(/^(MAIN|SUPPORTING|BACKGROUND)\s/);
            const characterRole = normalizeCharacterRoleForStats(roleMatch?.[1] ?? null);
            const characterName = roleDescr.replace(/^(MAIN|SUPPORTING|BACKGROUND)\s+/, '');
            const characterId = meta.roleCharacterIds?.[idx] ?? 0;
            return {
              staffId: Number(staffId),
              staffName: meta.name,
              staffImage: meta.image ?? null,
              staffGender: null,
              characterId,
              characterName,
              characterRole,
            };
          }),
        )
      : await readVaCreditsForMedia(entry.mediaId);
    out.push({
      ...entry,
      staffCredits,
      vaCredits,
    });
  }
  return out;
}

async function fetchStatsListLive(
  username: string,
  mediaType: StatsMediaType,
  signal?: AbortSignal,
): Promise<GqlStatsListEntry[]> {
  signal?.throwIfAborted();
  const accessToken = resolveAccessTokenForUsername(username) ?? undefined;
  return depaginate<
    {
      Page: {
        pageInfo: { hasNextPage: boolean };
        mediaList: GqlStatsListEntry[];
      } | null;
    },
    GqlStatsListEntry
  >({
    query: TOOLS_STATS_LIST_QUERY,
    variables: { userName: username, type: mediaType },
    signal,
    accessToken,
    selectPage: (data) => ({
      nodes: data.Page?.mediaList ?? [],
      pageInfo: data.Page?.pageInfo ?? { hasNextPage: false },
    }),
  });
}

function mapGqlEntry(entry: GqlStatsListEntry, mediaType: StatsMediaType): StatsEntry {
  const media = entry.media;
  return {
    mediaId: media.id,
    title: pickMediaTitle(media.title),
    titleSource: {
      id: media.id,
      title_english: media.title.english ?? null,
      title_romaji: media.title.romaji ?? null,
      title_native: media.title.native ?? null,
    },
    coverImage: media.coverImage?.large ?? null,
    mediaType,
    format: (media.format as StatsEntry['format']) ?? null,
    mediaStatus: (media.status as StatsEntry['mediaStatus']) ?? null,
    listStatus: entry.status ?? 'CURRENT',
    score: normalizeSeasonalListScore(entry.score),
    repeat: entry.repeat ?? null,
    notes: entry.notes ?? null,
    progress: entry.progress ?? 0,
    progressVolumes: entry.progressVolumes ?? null,
    episodes: media.episodes ?? null,
    chapters: media.chapters ?? null,
    volumes: media.volumes ?? null,
    duration: media.duration ?? null,
    meanScore: media.meanScore ?? null,
    genres: [],
    tags: [],
    studios: [],
    staffCredits: [],
    vaCredits: [],
    startDate: mapStatsStartDate(media.startDate),
  };
}

async function buildStatsEntries(
  username: string,
  mediaType: StatsMediaType,
  options?: StatsFetchOptions,
): Promise<StatsEntry[]> {
  options?.signal?.throwIfAborted();
  options?.onProgress?.({ phase: 'list', index: 0, total: 1 });
  const liveEntries = await fetchStatsListLive(username, mediaType, options?.signal);
  options?.signal?.throwIfAborted();
  const baseEntries = liveEntries.map((entry) => mapGqlEntry(entry, mediaType));
  const mediaIds = baseEntries.map((entry) => entry.mediaId);
  await ensureMediaStudiosFreshBatch(mediaIds, options);
  options?.signal?.throwIfAborted();
  const meta = await readMediaMetadataFromDb(mediaIds, options?.signal);
  const merged = baseEntries.map((entry) => {
    const db = meta.get(entry.mediaId);
    if (!db) {
      return entry;
    }
    return {
      ...entry,
      meanScore: entry.meanScore ?? db.meanScore,
      format: entry.format ?? (db.format as StatsEntry['format']),
      mediaStatus: entry.mediaStatus ?? (db.status as StatsEntry['mediaStatus']),
      episodes: entry.episodes ?? db.episodes,
      chapters: entry.chapters ?? db.chapters,
      volumes: entry.volumes ?? db.volumes,
      genres: db.genres,
      tags: db.tags,
      studios: db.studios,
      startDate: db.startDate,
    };
  });
  return merged;
}

export async function fetchStatsData(
  username: string,
  mediaType: StatsMediaType,
  options?: StatsFetchOptions,
): Promise<StatsCachedData> {
  options?.signal?.throwIfAborted();
  const handle = username.trim();
  if (!handle) {
    throw new Error('Username is required.');
  }
  const memoKey = `stats:list:${handle.toLowerCase()}:${mediaType}`;
  if (options?.forceRefresh) {
    sessionMemoDelete(memoKey);
  }
  const entries = await withSessionTtlMemo(
    memoKey,
    TOOLS_SESSION_TTL_MS,
    () => buildStatsEntries(handle, mediaType, options),
    options?.forceRefresh ? { bust: true } : undefined,
  );
  return {
    username: handle,
    mediaType,
    entries,
    castExpanded: false,
  };
}

function statsEntriesLookUnexpanded(entries: readonly StatsEntry[]): boolean {
  if (entries.length === 0) {
    return false;
  }
  return entries.every((entry) => entry.staffCredits.length === 0 && entry.vaCredits.length === 0);
}

export function statsCachedNeedsCast(cached: StatsCachedData): boolean {
  if (cached.castExpanded) {
    return false;
  }
  return statsEntriesLookUnexpanded(cached.entries);
}

export async function expandStatsCast(
  cached: StatsCachedData,
  options?: StatsFetchOptions,
): Promise<StatsCachedData> {
  const entries = await attachCastToEntries(cached.entries, options);
  const staleCastMediaCount = await countStaleStatsCastMedia(entries.map((e) => e.mediaId));
  return { ...cached, entries, castExpanded: true, staleCastMediaCount };
}
