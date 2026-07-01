import { depaginate } from '../../lib/importers/anilist/depaginate';
import { findAnilistAccountByName, resolveAccessTokenForUsername } from '../../lib/importers/anilist/anilistAuth';
import { TOOLS_USER_ANIME_LIST_QUERY } from '../../lib/importers/anilist/queries';
import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import {
  TOOLS_SEASONAL_LIST_STATUSES,
  ensureUserAnimeListFresh,
  readUserSeasonalShowsFromDb,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import { repairListedMediaNullSource, listedMediaNeedsSourceRepair } from '../../lib/importers/anilist/lazyExpansion';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import {
  TOOLS_SESSION_TTL_MS,
  sessionMemoDelete,
  withSessionTtlMemo,
} from '../../lib/importers/anilist/toolsSessionMemo';
import { pickMediaTitle } from './sharedCreditsLogic';
import {
  normalizeSeasonalListScore,
  type SeasonalFuzzyDate,
  type SeasonalShow,
} from './seasonalScoresLogic';

export type SeasonalScoresFetchOptions = ToolsFetchOptions;

/** Bust the in-session seasonal list memo after a username ↻ refresh. */
export function bustSeasonalSessionMemo(username: string): void {
  const handle = username.trim().toLowerCase();
  if (!handle) {
    return;
  }
  sessionMemoDelete(`seasonal:list:${handle}`);
}

type GqlFuzzyDate = {
  year?: number | null;
  month?: number | null;
  day?: number | null;
} | null;

type SeasonalListMedia = {
  id: number;
  title: { english?: string | null; romaji?: string | null; native?: string | null };
  coverImage?: { large?: string | null } | null;
  source?: string | null;
  season?: string | null;
  seasonYear?: number | null;
  startDate?: GqlFuzzyDate;
  endDate?: GqlFuzzyDate;
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

async function fetchUserSeasonalShowsLive(
  username: string,
  signal?: AbortSignal,
): Promise<SeasonalShow[]> {
  signal?.throwIfAborted();
  let accessToken: string | undefined;
  accessToken = resolveAccessTokenForUsername(username) ?? undefined;

  const entries = await depaginate<
    {
      Page: {
        pageInfo: { hasNextPage: boolean };
        mediaList: Array<{
          status?: string | null;
          score?: number | null;
          notes?: string | null;
          media: SeasonalListMedia;
        }>;
      } | null;
    },
    {
      status?: string | null;
      score?: number | null;
      notes?: string | null;
      media: SeasonalListMedia;
    }
  >({
    query: TOOLS_USER_ANIME_LIST_QUERY,
    variables: { userName: username, statusIn: [...TOOLS_SEASONAL_LIST_STATUSES] },
    signal,
    accessToken,
    selectPage: (data) => ({
      nodes: data.Page?.mediaList ?? [],
      pageInfo: data.Page?.pageInfo ?? { hasNextPage: false },
    }),
  });

  return entries.map((entry) => ({
    id: entry.media.id,
    title: pickMediaTitle(entry.media.title),
    titleSource: {
      id: entry.media.id,
      title_english: entry.media.title.english ?? null,
      title_romaji: entry.media.title.romaji ?? null,
      title_native: entry.media.title.native ?? null,
    },
    coverImage: entry.media.coverImage?.large ?? null,
    source: (entry.media.source as SeasonalShow['source']) ?? null,
    season: entry.media.season ?? null,
    seasonYear: entry.media.seasonYear ?? null,
    startDate: mapFuzzyDate(entry.media.startDate ?? null),
    endDate: mapFuzzyDate(entry.media.endDate ?? null),
    score: normalizeSeasonalListScore(entry.score),
    notes: entry.notes ?? null,
    listStatus: entry.status ?? null,
  }));
}

async function fetchUserSeasonalShowsResolved(
  username: string,
  signal?: AbortSignal,
  options?: SeasonalScoresFetchOptions,
): Promise<SeasonalShow[]> {
  signal?.throwIfAborted();
  const user = await ensureUserAnimeListFresh(username, options);
  const ctx = getToolsImportContext();
  const hasAccount = findAnilistAccountByName(username) !== null;
  if (user) {
    let fromDb = await readUserSeasonalShowsFromDb(ctx.db, user.id);
    if (await listedMediaNeedsSourceRepair(ctx.db, user.id)) {
      await repairListedMediaNullSource(ctx, user.id, { type: 'ANIME' });
      fromDb = await readUserSeasonalShowsFromDb(ctx.db, user.id);
    }
    if (fromDb.length > 0 || hasAccount) {
      return fromDb;
    }
  }
  if (hasAccount) {
    return [];
  }
  return fetchUserSeasonalShowsLive(username, signal);
}

/**
 * Seasonal scores read list-entry notes and scores from the imported DB when
 * available (authenticated import via MediaListCollection). Live
 * `Page.mediaList` is the fallback for unauthenticated third-party usernames.
 *
 * Always fetched with PLANNING included; the "Include Planning"
 * checkbox is a client-side filter (see `bucketShowsForSeason`) so
 * toggling it is instant instead of triggering another network round
 * trip. Results are memoized in-session for {@link TOOLS_SESSION_TTL_MS};
 * force refresh busts the memo and re-imports the DB list via
 * {@link ensureUserAnimeListFresh}.
 */
export async function fetchUserSeasonalShows(
  username: string,
  signal?: AbortSignal,
  options?: SeasonalScoresFetchOptions,
): Promise<SeasonalShow[]> {
  signal?.throwIfAborted();
  const handle = username.trim().toLowerCase();
  const key = `seasonal:list:${handle}`;
  const shows = await withSessionTtlMemo(
    key,
    TOOLS_SESSION_TTL_MS,
    () => fetchUserSeasonalShowsResolved(username, signal, options),
    { bust: options?.forceRefresh },
  );
  // Don't lock the user into an empty result for 15m. An empty array is most
  // often a transient `executeAnilistQuery` → `data: null` short-circuit (rate
  // limit recovery, partial response). Busting the memo lets the next click
  // retry the live query without needing a fresh tab or right-click refresh.
  // Legitimately-empty lists pay one extra request on each retry — acceptable.
  if (shows.length === 0) {
    sessionMemoDelete(key);
  }
  return shows;
}
