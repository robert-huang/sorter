import { depaginate } from '../../lib/importers/anilist/depaginate';
import { TOOLS_USER_ANIME_LIST_QUERY } from '../../lib/importers/anilist/queries';
import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import {
  TOOLS_SEASONAL_LIST_STATUSES,
  ensureUserAnimeListFresh,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import {
  TOOLS_SESSION_TTL_MS,
  sessionMemoDelete,
  withSessionTtlMemo,
} from '../../lib/importers/anilist/toolsSessionMemo';
import { pickMediaTitle } from './sharedCreditsLogic';
import { normalizeSeasonalListScore, type SeasonalShow } from './seasonalScoresLogic';

export type SeasonalScoresFetchOptions = ToolsFetchOptions;

async function fetchUserSeasonalShowsLive(
  username: string,
  signal?: AbortSignal,
  options?: SeasonalScoresFetchOptions,
): Promise<SeasonalShow[]> {
  signal?.throwIfAborted();
  await ensureUserAnimeListFresh(username, options);

  const entries = await depaginate<
    {
      Page: {
        pageInfo: { hasNextPage: boolean };
        mediaList: Array<{
          status?: string | null;
          score?: number | null;
          notes?: string | null;
          media: {
            id: number;
            title: { english?: string | null; romaji?: string | null; native?: string | null };
            coverImage?: { large?: string | null } | null;
            season?: string | null;
            seasonYear?: number | null;
          };
        }>;
      } | null;
    },
    {
      status?: string | null;
      score?: number | null;
      notes?: string | null;
      media: {
        id: number;
        title: { english?: string | null; romaji?: string | null; native?: string | null };
        coverImage?: { large?: string | null } | null;
        season?: string | null;
        seasonYear?: number | null;
      };
    }
  >({
    query: TOOLS_USER_ANIME_LIST_QUERY,
    variables: { userName: username, statusIn: [...TOOLS_SEASONAL_LIST_STATUSES] },
    signal,
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
    season: entry.media.season ?? null,
    seasonYear: entry.media.seasonYear ?? null,
    score: normalizeSeasonalListScore(entry.score),
    notes: entry.notes ?? null,
    listStatus: entry.status ?? null,
  }));
}

/**
 * Seasonal scores need list-entry notes (#airing) and scores, which are
 * NOT stored in the DB — the live AniList list query is the source of
 * truth here (the DB only has score/status; notes aren't persisted).
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
    () => fetchUserSeasonalShowsLive(username, signal, options),
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
