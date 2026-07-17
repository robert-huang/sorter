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
  TOOLS_SESSION_TTL_MS,
  sessionMemoDelete,
  withSessionTtlMemo,
} from '../../lib/importers/anilist/toolsSessionMemo';
import type { AnilistMediaStatus } from '../../lib/importers/anilist/types';
import { pickMediaTitle } from './sharedCreditsLogic';
import {
  computeAiredEpisodeCount,
  formatAnilistSeasonLabel,
  isWeeklyCalendarAiringMediaStatus,
  resolveWeeklyCalendarSeasonSpec,
  type AnilistSeasonAt,
  type WeeklyCalendarRawEntry,
  type WeeklyCalendarSeasonScope,
  WEEKLY_CALENDAR_AIRING_MEDIA_STATUSES,
} from './weeklyCalendarLogic';
import {
  normalizeSeasonalListScore,
  type SeasonalFuzzyDate,
} from './seasonalScoresLogic';

export type WeeklyCalendarFetchOptions = ToolsFetchOptions;

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

  return entries
    .map((entry) => mapMediaToRawEntry(entry.media, entry))
    .filter((entry) => isWeeklyCalendarAiringMediaStatus(entry.mediaStatus));
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

async function fetchSeasonMediaByStatus(
  season: string,
  seasonYear: number,
  status: AnilistMediaStatus,
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
    variables: { season, seasonYear, status },
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
): Promise<{ entries: WeeklyCalendarRawEntry[]; seasonLabel: string }> {
  signal?.throwIfAborted();
  const { season, year } = seasonSpec;
  const seasonLabel = formatAnilistSeasonLabel(seasonSpec);

  const [listMap, releasing, upcoming] = await Promise.all([
    fetchUserListEntryMap(username, signal),
    fetchSeasonMediaByStatus(season, year, 'RELEASING', signal),
    fetchSeasonMediaByStatus(season, year, 'NOT_YET_RELEASED', signal),
  ]);

  const byId = new Map<number, GqlMedia>();
  for (const media of [...releasing, ...upcoming]) {
    byId.set(media.id, media);
  }

  const entries: WeeklyCalendarRawEntry[] = [];
  for (const media of byId.values()) {
    if (!isWeeklyCalendarAiringMediaStatus(media.status)) {
      continue;
    }
    const list = listMap.get(media.id) ?? null;
    entries.push(mapMediaToRawEntry(media, list));
  }

  return { entries, seasonLabel };
}

export function bustWeeklyCalendarSessionMemo(username: string): void {
  const handle = username.trim().toLowerCase();
  if (!handle) {
    return;
  }
  sessionMemoDelete(`weekly-calendar:watching:${handle}`);
  for (const scope of ['current', 'next'] as const) {
    sessionMemoDelete(`weekly-calendar:season:${handle}:${scope}`);
  }
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
  seasonScope: Exclude<WeeklyCalendarSeasonScope, 'watching'>,
  signal?: AbortSignal,
  options?: WeeklyCalendarFetchOptions,
): Promise<{ entries: WeeklyCalendarRawEntry[]; seasonLabel: string }> {
  const handle = username.trim().toLowerCase();
  const key = `weekly-calendar:season:${handle}:${seasonScope}`;
  const seasonSpec = resolveWeeklyCalendarSeasonSpec(seasonScope);
  if (!seasonSpec) {
    throw new Error('Season scope is required.');
  }
  return withSessionTtlMemo(
    key,
    TOOLS_SESSION_TTL_MS,
    () => fetchSeasonAiringEntriesLive(username, seasonSpec, signal),
    { bust: options?.forceRefresh },
  );
}

export { WEEKLY_CALENDAR_AIRING_MEDIA_STATUSES };
