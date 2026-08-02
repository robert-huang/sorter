import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import {
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
import type { SeasonalShow } from './seasonalScoresLogic';

export type SeasonalScoresFetchOptions = ToolsFetchOptions;

/** Bust the in-session seasonal list memo after a username ↻ refresh. */
export function bustSeasonalSessionMemo(username: string): void {
  const handle = username.trim().toLowerCase();
  if (!handle) {
    return;
  }
  sessionMemoDelete(`seasonal:list:${handle}`);
}

async function fetchUserSeasonalShowsResolved(
  username: string,
  signal?: AbortSignal,
  options?: SeasonalScoresFetchOptions,
): Promise<SeasonalShow[]> {
  signal?.throwIfAborted();
  const user = await ensureUserAnimeListFresh(username, options);
  const ctx = getToolsImportContext();
  if (user) {
    let fromDb = await readUserSeasonalShowsFromDb(ctx.db, user.id);
    if (await listedMediaNeedsSourceRepair(ctx.db, user.id)) {
      await repairListedMediaNullSource(ctx, user.id, { type: 'ANIME' });
      fromDb = await readUserSeasonalShowsFromDb(ctx.db, user.id);
    }
    return fromDb;
  }
  return [];
}

/**
 * Seasonal scores read list-entry notes and scores from the shared SQLite
 * import. Normal Compare clicks therefore do not re-fetch a completed list;
 * the username refresh control or right-click Compare forces a fresh import.
 *
 * Always fetched with PLANNING included; the "Include Planning"
 * checkbox is a client-side filter (see `bucketShowsForSeason`) so
 * toggling it is instant instead of triggering another network round
 * trip. Results are memoized in-session for {@link TOOLS_SESSION_TTL_MS}.
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
  return shows;
}
