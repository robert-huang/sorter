import { depaginate } from '../../lib/importers/anilist/depaginate';
import { resolveAccessTokenForUsername } from '../../lib/importers/anilist/anilistAuth';
import {
  TOOLS_USER_ANIME_LIST_QUERY,
  TOOLS_WEEKLY_CALENDAR_SEASON_QUERY,
  TOOLS_WEEKLY_CALENDAR_WATCHING_QUERY,
} from '../../lib/importers/anilist/queries';
import { TOOLS_SEASONAL_LIST_STATUSES } from '../../lib/importers/anilist/toolsAnilistAccess';
import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import {
  getPersistentToolsCacheGeneration,
  persistentCacheDelete,
  persistentCacheDeletePrefix,
  persistentCacheGet,
  persistentCacheSet,
} from '../../lib/importers/anilist/toolsPersistentCache';
import {
  TOOLS_SESSION_TTL_MS,
  sessionMemoDelete,
  sessionMemoDeletePrefix,
  withSessionTtlMemo,
} from '../../lib/importers/anilist/toolsSessionMemo';
import type { AnilistMediaFormat } from '../../lib/importers/anilist/types';
import {
  listEntryDatesFromFuzzy,
  type ListEntryDates,
} from '../../lib/importers/anilist/listDateFilter';
import { pickMediaTitle } from './sharedCreditsLogic';
import {
  computeAiredEpisodeCount,
  formatAnilistSeasonLabel,
  formatAnilistSeasonRangeLabel,
  isAnilistSeasonBeforeCurrent,
  type AnilistSeasonAt,
  type WeeklyCalendarRawEntry,
} from './weeklyCalendarLogic';
import {
  normalizeSeasonalListScore,
  type SeasonalFuzzyDate,
} from './seasonalScoresLogic';

export type WeeklyCalendarFetchOptions = ToolsFetchOptions;

/** Finished seasons — airing metadata is stable enough to persist across sessions. */
const WEEKLY_CALENDAR_HISTORICAL_SEASON_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * User list snapshots (status/score/progress + watching rows) — live
 * AniList data that must include progress, so we cache the API response
 * in the disposable tools cache instead of the imported DB.
 */
const WEEKLY_CALENDAR_USER_LIST_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type GqlFuzzyDate = {
  year?: number | null;
  month?: number | null;
  day?: number | null;
} | null;

type GqlMedia = {
  id: number;
  title: {
    english?: string | null;
    romaji?: string | null;
    native?: string | null;
    userPreferred?: string | null;
  };
  coverImage?: { large?: string | null } | null;
  format?: AnilistMediaFormat | null;
  status?: string | null;
  episodes?: number | null;
  popularity?: number | null;
  startDate?: GqlFuzzyDate;
  endDate?: GqlFuzzyDate;
  nextAiringEpisode?: { airingAt?: number | null; episode?: number | null } | null;
  airingSchedule?: {
    nodes?: Array<{ airingAt?: number | null; episode?: number | null } | null> | null;
  } | null;
};

type SeasonFetchResult = { entries: WeeklyCalendarRawEntry[]; seasonLabel: string };

type UserListEntrySnapshot = {
  status: string | null;
  score: number | null;
  progress: number;
  listDates?: ListEntryDates;
};

export type UserListEntryMap = Map<number, UserListEntrySnapshot>;

type SerializedUserListEntryMap = Array<[number, UserListEntrySnapshot]>;

type GqlListEntryFields = {
  status?: string | null;
  score?: number | null;
  progress?: number | null;
  startedAt?: GqlFuzzyDate;
  completedAt?: GqlFuzzyDate;
};

function serializeUserListEntryMap(map: UserListEntryMap): SerializedUserListEntryMap {
  return [...map.entries()];
}

function deserializeUserListEntryMap(data: SerializedUserListEntryMap): UserListEntryMap {
  return new Map(data);
}

async function withWeeklyCalendarUserListCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  options?: WeeklyCalendarFetchOptions,
): Promise<T> {
  return withSessionTtlMemo(
    key,
    TOOLS_SESSION_TTL_MS,
    async () => {
      if (!options?.forceRefresh) {
        const hit = await persistentCacheGet<T>(key);
        if (hit.hit) {
          return hit.value;
        }
      }
      const cacheGeneration = getPersistentToolsCacheGeneration();
      const value = await fetcher();
      await persistentCacheSet(
        key,
        value,
        WEEKLY_CALENDAR_USER_LIST_TTL_MS,
        cacheGeneration,
      );
      return value;
    },
    { bust: options?.forceRefresh },
  );
}

function mapFuzzyDate(date: GqlFuzzyDate): SeasonalFuzzyDate | null {
  if (!date || date.year == null) {
    return null;
  }
  return {
    year: date.year,
    month: date.month ?? null,
    day: date.day ?? null,
  };
}

function pickWeeklyTitle(media: GqlMedia): string {
  const preferred = media.title.userPreferred?.trim();
  if (preferred) {
    return preferred;
  }
  return pickMediaTitle(media.title);
}

function pastAiringAtsFromMedia(media: GqlMedia): number[] {
  const nodes = media.airingSchedule?.nodes ?? [];
  return nodes
    .map((node) => node?.airingAt ?? null)
    .filter((at): at is number => at != null);
}

function mapMediaToRawEntry(
  media: GqlMedia,
  list: (Omit<GqlListEntryFields, 'startedAt' | 'completedAt'> & { listDates?: ListEntryDates }) | null,
): WeeklyCalendarRawEntry {
  const progress = list?.progress ?? 0;
  const nextEpisode = media.nextAiringEpisode?.episode ?? null;
  return {
    id: media.id,
    title: pickWeeklyTitle(media),
    coverImage: media.coverImage?.large ?? null,
    format: media.format ?? null,
    score: normalizeSeasonalListScore(list?.score),
    listStatus: list?.status ?? null,
    listDates: list?.listDates,
    progress,
    totalEpisodes: media.episodes ?? null,
    popularity: media.popularity ?? null,
    mediaStatus: media.status ?? null,
    startDate: mapFuzzyDate(media.startDate ?? null),
    endDate: mapFuzzyDate(media.endDate ?? null),
    nextAiringAt: media.nextAiringEpisode?.airingAt ?? null,
    nextAiringEpisodeNumber: nextEpisode,
    airedCount: computeAiredEpisodeCount(nextEpisode, progress),
    weekdayJs: null,
    airingTimeMinutes: null,
    inferredWeekday: false,
    pastAiringAts: pastAiringAtsFromMedia(media),
  };
}

async function fetchWatchingEntriesLive(
  username: string,
  signal?: AbortSignal,
): Promise<WeeklyCalendarRawEntry[]> {
  signal?.throwIfAborted();
  const accessToken = resolveAccessTokenForUsername(username) ?? undefined;
  const entries = await depaginate<
    {
      Page: {
        pageInfo: { hasNextPage: boolean };
        mediaList: Array<GqlListEntryFields & { media: GqlMedia }>;
      } | null;
    },
    GqlListEntryFields & { media: GqlMedia }
  >({
    query: TOOLS_WEEKLY_CALENDAR_WATCHING_QUERY,
    variables: {
      userName: username,
      statusIn: [...TOOLS_SEASONAL_LIST_STATUSES],
    },
    signal,
    accessToken,
    selectPage: (data) => ({
      nodes: data.Page?.mediaList ?? [],
      pageInfo: data.Page?.pageInfo ?? { hasNextPage: false },
    }),
  });

  return entries.map((entry) =>
    mapMediaToRawEntry(entry.media, {
      ...entry,
      listDates: listEntryDatesFromFuzzy(entry.startedAt, entry.completedAt),
    }),
  );
}

async function fetchUserListEntryMapLive(
  username: string,
  signal?: AbortSignal,
): Promise<UserListEntryMap> {
  signal?.throwIfAborted();
  const accessToken = resolveAccessTokenForUsername(username) ?? undefined;
  const entries = await depaginate<
    {
      Page: {
        pageInfo: { hasNextPage: boolean };
        mediaList: Array<GqlListEntryFields & { media: { id: number } }>;
      } | null;
    },
    GqlListEntryFields & { media: { id: number } }
  >({
    query: TOOLS_USER_ANIME_LIST_QUERY,
    variables: {
      userName: username,
      statusIn: [...TOOLS_SEASONAL_LIST_STATUSES],
    },
    signal,
    accessToken,
    selectPage: (data) => ({
      nodes: data.Page?.mediaList ?? [],
      pageInfo: data.Page?.pageInfo ?? { hasNextPage: false },
    }),
  });

  const map: UserListEntryMap = new Map();
  for (const entry of entries) {
    map.set(entry.media.id, {
      status: entry.status ?? null,
      score: normalizeSeasonalListScore(entry.score),
      progress: entry.progress ?? 0,
      listDates: listEntryDatesFromFuzzy(entry.startedAt, entry.completedAt),
    });
  }
  return map;
}

async function fetchUserListEntryMapCached(
  username: string,
  signal?: AbortSignal,
  options?: WeeklyCalendarFetchOptions,
): Promise<UserListEntryMap> {
  const handle = username.trim().toLowerCase();
  const key = weeklyCalendarListMapCacheKey(handle);
  const serialized = await withWeeklyCalendarUserListCache(
    key,
    async () => serializeUserListEntryMap(await fetchUserListEntryMapLive(username, signal)),
    options,
  );
  return deserializeUserListEntryMap(serialized);
}

async function fetchSeasonMedia(
  season: string,
  seasonYear: number,
  signal?: AbortSignal,
): Promise<GqlMedia[]> {
  return depaginate<
    {
      Page: {
        pageInfo: { hasNextPage: boolean };
        media: GqlMedia[] | null;
      } | null;
    },
    GqlMedia
  >({
    query: TOOLS_WEEKLY_CALENDAR_SEASON_QUERY,
    variables: { season, seasonYear },
    signal,
    selectPage: (data) => ({
      nodes: data.Page?.media ?? [],
      pageInfo: data.Page?.pageInfo ?? { hasNextPage: false },
    }),
  });
}

async function fetchSeasonAiringEntriesLive(
  username: string,
  seasonSpec: AnilistSeasonAt,
  signal?: AbortSignal,
  options?: WeeklyCalendarFetchOptions,
): Promise<SeasonFetchResult> {
  signal?.throwIfAborted();
  const { season, year } = seasonSpec;
  const seasonLabel = formatAnilistSeasonLabel(seasonSpec);

  const [listMap, media] = await Promise.all([
    fetchUserListEntryMapCached(username, signal, options),
    fetchSeasonMedia(season, year, signal),
  ]);

  const entries: WeeklyCalendarRawEntry[] = media.map((item) =>
    mapMediaToRawEntry(item, listMap.get(item.id) ?? null),
  );

  return { entries, seasonLabel };
}

// Bump these when the cached list statuses or fields change (v5/v3/v4: DROPPED added).
export function weeklyCalendarWatchingCacheKey(handle: string): string {
  return `weekly-calendar:watching:v4:${handle}`;
}

function weeklyCalendarListMapCacheKey(handle: string): string {
  return `weekly-calendar:list-map:v3:${handle}`;
}

function weeklyCalendarSeasonCacheKey(handle: string, seasonSpec: AnilistSeasonAt): string {
  return `${weeklyCalendarSeasonCachePrefix(handle)}${seasonSpec.season}:${seasonSpec.year}`;
}

function weeklyCalendarSeasonCachePrefix(handle: string): string {
  return `weekly-calendar:season:v5:${handle}:`;
}

async function fetchSeasonAiringEntriesCached(
  username: string,
  seasonSpec: AnilistSeasonAt,
  signal?: AbortSignal,
  options?: WeeklyCalendarFetchOptions,
): Promise<SeasonFetchResult> {
  const handle = username.trim().toLowerCase();
  const cacheKey = weeklyCalendarSeasonCacheKey(handle, seasonSpec);
  const historical = isAnilistSeasonBeforeCurrent(seasonSpec);

  return withSessionTtlMemo(
    cacheKey,
    TOOLS_SESSION_TTL_MS,
    async () => {
      if (historical && !options?.forceRefresh) {
        const hit = await persistentCacheGet<SeasonFetchResult>(cacheKey);
        if (hit.hit) {
          return hit.value;
        }
      }
      const cacheGeneration = getPersistentToolsCacheGeneration();
      const result = await fetchSeasonAiringEntriesLive(username, seasonSpec, signal, options);
      if (historical) {
        await persistentCacheSet(
          cacheKey,
          result,
          WEEKLY_CALENDAR_HISTORICAL_SEASON_TTL_MS,
          cacheGeneration,
        );
      }
      return result;
    },
    { bust: options?.forceRefresh },
  );
}

/** Bust session + localStorage cache for user-list-derived weekly calendar data. */
export async function bustWeeklyCalendarUserListMemo(username: string): Promise<void> {
  const handle = username.trim().toLowerCase();
  if (!handle) {
    return;
  }
  const watchingKey = weeklyCalendarWatchingCacheKey(handle);
  const listMapKey = weeklyCalendarListMapCacheKey(handle);
  const seasonPrefix = weeklyCalendarSeasonCachePrefix(handle);
  sessionMemoDelete(watchingKey);
  sessionMemoDelete(listMapKey);
  // Season fetches bake list progress into cached entries; bust those too
  // when the username ↻ refresh re-imports list progress from AniList.
  sessionMemoDeletePrefix(seasonPrefix);
  await Promise.all([
    persistentCacheDelete(watchingKey),
    persistentCacheDelete(listMapKey),
    persistentCacheDeletePrefix(seasonPrefix),
  ]);
}

export async function fetchWeeklyCalendarWatchingEntries(
  username: string,
  signal?: AbortSignal,
  options?: WeeklyCalendarFetchOptions,
): Promise<WeeklyCalendarRawEntry[]> {
  const handle = username.trim().toLowerCase();
  const key = weeklyCalendarWatchingCacheKey(handle);
  return withWeeklyCalendarUserListCache(
    key,
    () => fetchWatchingEntriesLive(username, signal),
    options,
  );
}

export async function fetchWeeklyCalendarSeasonEntries(
  username: string,
  seasonSpec: AnilistSeasonAt,
  signal?: AbortSignal,
  options?: WeeklyCalendarFetchOptions,
): Promise<SeasonFetchResult> {
  return fetchSeasonAiringEntriesCached(username, seasonSpec, signal, options);
}

export async function fetchWeeklyCalendarSeasonsEntries(
  username: string,
  seasonSpecs: readonly AnilistSeasonAt[],
  signal?: AbortSignal,
  options?: WeeklyCalendarFetchOptions,
): Promise<SeasonFetchResult> {
  if (seasonSpecs.length === 0) {
    return { entries: [], seasonLabel: '' };
  }
  if (seasonSpecs.length === 1) {
    return fetchSeasonAiringEntriesCached(username, seasonSpecs[0]!, signal, options);
  }

  const results = await Promise.all(
    seasonSpecs.map((spec) =>
      fetchSeasonAiringEntriesCached(username, spec, signal, options),
    ),
  );

  const byId = new Map<number, WeeklyCalendarRawEntry>();
  for (const result of results) {
    for (const entry of result.entries) {
      byId.set(entry.id, entry);
    }
  }

  const minSpec = seasonSpecs[0]!;
  const maxSpec = seasonSpecs[seasonSpecs.length - 1]!;
  return {
    entries: [...byId.values()],
    seasonLabel: formatAnilistSeasonRangeLabel(minSpec, maxSpec),
  };
}
