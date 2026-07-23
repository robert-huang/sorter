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
  persistentCacheGet,
  persistentCacheSet,
} from '../../lib/importers/anilist/toolsPersistentCache';
import {
  TOOLS_SESSION_TTL_MS,
  sessionMemoDelete,
  withSessionTtlMemo,
} from '../../lib/importers/anilist/toolsSessionMemo';
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
const WEEKLY_CALENDAR_HISTORICAL_SEASON_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
  list: {
    status?: string | null;
    score?: number | null;
    progress?: number | null;
  } | null,
): WeeklyCalendarRawEntry {
  const progress = list?.progress ?? 0;
  const nextEpisode = media.nextAiringEpisode?.episode ?? null;
  return {
    id: media.id,
    title: pickWeeklyTitle(media),
    coverImage: media.coverImage?.large ?? null,
    score: normalizeSeasonalListScore(list?.score),
    listStatus: list?.status ?? null,
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
        mediaList: Array<{
          status?: string | null;
          score?: number | null;
          progress?: number | null;
          media: GqlMedia;
        }>;
      } | null;
    },
    {
      status?: string | null;
      score?: number | null;
      progress?: number | null;
      media: GqlMedia;
    }
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

  return entries.map((entry) => mapMediaToRawEntry(entry.media, entry));
}

export type UserListEntryMap = Map<
  number,
  { status: string | null; score: number | null; progress: number }
>;

async function fetchUserListEntryMap(
  username: string,
  signal?: AbortSignal,
): Promise<UserListEntryMap> {
  signal?.throwIfAborted();
  const accessToken = resolveAccessTokenForUsername(username) ?? undefined;
  const entries = await depaginate<
    {
      Page: {
        pageInfo: { hasNextPage: boolean };
        mediaList: Array<{
          status?: string | null;
          score?: number | null;
          progress?: number | null;
          media: { id: number };
        }>;
      } | null;
    },
    {
      status?: string | null;
      score?: number | null;
      progress?: number | null;
      media: { id: number };
    }
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
  const key = `weekly-calendar:list-map:${handle}`;
  return withSessionTtlMemo(
    key,
    TOOLS_SESSION_TTL_MS,
    () => fetchUserListEntryMap(username, signal),
    { bust: options?.forceRefresh },
  );
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

function weeklyCalendarSeasonCacheKey(handle: string, seasonSpec: AnilistSeasonAt): string {
  return `weekly-calendar:season:v2:${handle}:${seasonSpec.season}:${seasonSpec.year}`;
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
        const hit = persistentCacheGet<SeasonFetchResult>(cacheKey);
        if (hit.hit) {
          return hit.value;
        }
      }
      const result = await fetchSeasonAiringEntriesLive(username, seasonSpec, signal, options);
      if (historical) {
        persistentCacheSet(cacheKey, result, WEEKLY_CALENDAR_HISTORICAL_SEASON_TTL_MS);
      }
      return result;
    },
    { bust: options?.forceRefresh },
  );
}

/** Bust session memo for user-list-derived weekly calendar data only. */
export function bustWeeklyCalendarUserListMemo(username: string): void {
  const handle = username.trim().toLowerCase();
  if (!handle) {
    return;
  }
  sessionMemoDelete(`weekly-calendar:watching:${handle}`);
  sessionMemoDelete(`weekly-calendar:list-map:${handle}`);
}

export async function fetchWeeklyCalendarWatchingEntries(
  username: string,
  signal?: AbortSignal,
  options?: WeeklyCalendarFetchOptions,
): Promise<WeeklyCalendarRawEntry[]> {
  const handle = username.trim().toLowerCase();
  const key = `weekly-calendar:watching:${handle}`;
  return withSessionTtlMemo(
    key,
    TOOLS_SESSION_TTL_MS,
    () => fetchWatchingEntriesLive(username, signal),
    { bust: options?.forceRefresh },
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
