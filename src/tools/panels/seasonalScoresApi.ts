import { depaginate } from '../../lib/importers/anilist/depaginate';
import { TOOLS_USER_ANIME_LIST_QUERY } from '../../lib/importers/anilist/queries';
import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import {
  TOOLS_SEASONAL_LIST_STATUSES,
  ensureUserAnimeListFresh,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import {
  TOOLS_SESSION_TTL_MS,
  withSessionTtlMemo,
} from '../../lib/importers/anilist/toolsSessionMemo';
import { pickMediaTitle } from './sharedCreditsLogic';
import { normalizeSeasonalListScore, type SeasonalShow } from './seasonalScoresLogic';

const SEASONAL_STATUSES = TOOLS_SEASONAL_LIST_STATUSES;

async function fetchUserSeasonalShowsLive(
  username: string,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<SeasonalShow[]> {
  signal?.throwIfAborted();
  await ensureUserAnimeListFresh(username, options);

  const entries = await depaginate<
    {
      Page: {
        pageInfo: { hasNextPage: boolean };
        mediaList: Array<{
          score?: number | null;
          notes?: string | null;
          media: {
            id: number;
            title: { english?: string | null; romaji?: string | null };
            coverImage?: { large?: string | null } | null;
            season?: string | null;
            seasonYear?: number | null;
          };
        }>;
      } | null;
    },
    {
      score?: number | null;
      notes?: string | null;
      media: {
        id: number;
        title: { english?: string | null; romaji?: string | null };
        coverImage?: { large?: string | null } | null;
        season?: string | null;
        seasonYear?: number | null;
      };
    }
  >({
    query: TOOLS_USER_ANIME_LIST_QUERY,
    variables: { userName: username, statusIn: [...SEASONAL_STATUSES] },
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
      title_native: (entry.media.title as { native?: string | null }).native ?? null,
    },
    coverImage: entry.media.coverImage?.large ?? null,
    season: entry.media.season ?? null,
    seasonYear: entry.media.seasonYear ?? null,
    score: normalizeSeasonalListScore(entry.score),
    notes: entry.notes ?? null,
  }));
}

/**
 * Seasonal scores need list-entry notes (#airing), which are not stored in the
 * DB — the live AniList list query supplies scores/notes/season fields. Results
 * are memoized in-session for {@link TOOLS_SESSION_TTL_MS}; force refresh busts
 * the memo and re-imports the DB list via {@link ensureUserAnimeListFresh}.
 */
export async function fetchUserSeasonalShows(
  username: string,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<SeasonalShow[]> {
  signal?.throwIfAborted();
  const handle = username.trim().toLowerCase();
  return withSessionTtlMemo(
    `seasonal:list:${handle}`,
    TOOLS_SESSION_TTL_MS,
    () => fetchUserSeasonalShowsLive(username, signal, options),
    { bust: options?.forceRefresh },
  );
}
