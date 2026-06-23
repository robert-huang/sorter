import { depaginate } from '../../lib/importers/anilist/depaginate';
import { TOOLS_USER_ANIME_LIST_QUERY } from '../../lib/importers/anilist/queries';
import { TOOLS_CACHE_TTL_MS, withToolsCache } from '../../lib/importers/anilist/toolsCache';
import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import {
  TOOLS_SEASONAL_LIST_STATUSES,
  toolsSeasonListCacheKey,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import { pickMediaTitle } from './sharedCreditsLogic';
import type { SeasonalShow } from './seasonalScoresLogic';

const SEASONAL_STATUSES = TOOLS_SEASONAL_LIST_STATUSES;

/**
 * Seasonal scores need list-entry notes (#airing). Those are not stored in the
 * production DB, so this path always uses the live AniList list query behind
 * the 15-minute tools TTL cache — never DB reads.
 */
export async function fetchUserSeasonalShows(
  username: string,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<SeasonalShow[]> {
  const key = toolsSeasonListCacheKey(username);
  return withToolsCache(
    key,
    TOOLS_CACHE_TTL_MS.userList,
    async () => {
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
        season: entry.media.season ?? null,
        seasonYear: entry.media.seasonYear ?? null,
        score: entry.score ?? null,
        notes: entry.notes ?? null,
      }));
    },
    options,
  );
}
