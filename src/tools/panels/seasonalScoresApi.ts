import { depaginate } from '../../lib/importers/anilist/depaginate';
import { TOOLS_USER_ANIME_LIST_QUERY } from '../../lib/importers/anilist/queries';
import { TOOLS_CACHE_TTL_MS, withToolsCache } from '../../lib/importers/anilist/toolsCache';
import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import {
  ensureUserAnimeListFresh,
  TOOLS_SEASONAL_LIST_STATUSES,
  toolsSeasonListCacheKey,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import { pickMediaTitle as pickMediaRowTitle } from '../../lib/importers/anilist/mediaDisplayLabel';
import { pickMediaTitle } from './sharedCreditsLogic';
import type { SeasonalShow } from './seasonalScoresLogic';

const SEASONAL_STATUSES = TOOLS_SEASONAL_LIST_STATUSES;

async function readSeasonalShowsFromDb(
  anilistUserId: number,
  statuses: readonly string[],
): Promise<SeasonalShow[] | null> {
  const ctx = getToolsImportContext();
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = await ctx.db.exec(
    `SELECT m.id, m.title_english, m.title_romaji, m.title_native,
            m.season, m.season_year, mle.score
       FROM media_list_entry mle
       JOIN media m ON m.id = mle.media_id
      WHERE mle.anilist_user_id = ?
        AND m.type = 'ANIME'
        AND mle.status IN (${placeholders})`,
    [anilistUserId, ...statuses],
  );
  if (rows.length === 0) {
    return null;
  }
  return rows.map((row) => ({
    id: Number(row.id),
    title: pickMediaRowTitle({
      id: Number(row.id),
      title_english: row.title_english as string | null,
      title_romaji: row.title_romaji as string | null,
      title_native: row.title_native as string | null,
    }),
    season: (row.season as string | null) ?? null,
    seasonYear: row.season_year != null ? Number(row.season_year) : null,
    score: row.score != null ? Number(row.score) : null,
    notes: null,
  }));
}

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
      const user = await ensureUserAnimeListFresh(username, options);
      if (user) {
        const fromDb = await readSeasonalShowsFromDb(user.id, SEASONAL_STATUSES);
        if (fromDb) {
          return fromDb;
        }
      }

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
