/**
 * Cross-session cache of free-text tool queries → the AniList entity they
 * resolved to (Shared Staff show titles, Shared Credits staff names), so
 * re-running a Compare doesn't re-search AniList for every line.
 */

import {
  persistentCacheGet,
  withPersistentTtlCache,
} from '../lib/importers/anilist/toolsPersistentCache';
import { withSessionTtlMemo } from '../lib/importers/anilist/toolsSessionMemo';

/**
 * 30 days: a title → id match rarely changes, but popularity-sorted
 * searches can drift when a newer sequel overtakes the original. The
 * per-row refresh button covers anything sooner.
 */
export const QUERY_MATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type QueryMatch = {
  id: number;
  /** Display label at resolve time. */
  title: string;
  coverImage: string | null;
};

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function showQueryKey(query: string, sortByPopularity: boolean): string {
  const sort = sortByPopularity ? 'POPULARITY_DESC' : 'SEARCH_MATCH';
  return `shared-staff:query:${normalizeQuery(query)}:${sort}`;
}

export function staffQueryKey(query: string): string {
  return `shared-credits:query:${normalizeQuery(query)}`;
}

/** Cache-only lookup; never hits AniList. Null = nothing cached ("new"). */
export async function readCachedQueryMatch(key: string): Promise<QueryMatch | null> {
  const hit = await persistentCacheGet<QueryMatch>(key);
  return hit.hit ? hit.value : null;
}

/** Read-through: cached match, else `search()` and persist it for {@link QUERY_MATCH_TTL_MS}. */
export function resolveQueryMatch(
  key: string,
  search: () => Promise<QueryMatch>,
  options?: { forceRefresh?: boolean },
): Promise<QueryMatch> {
  const bust = options?.forceRefresh === true;
  return withSessionTtlMemo(
    key,
    QUERY_MATCH_TTL_MS,
    () => withPersistentTtlCache(key, QUERY_MATCH_TTL_MS, search, { bust }),
    { bust },
  );
}
