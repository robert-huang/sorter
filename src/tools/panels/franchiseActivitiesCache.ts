import {
  clearDisposableCacheNamespace,
  enforceDisposableCacheBudget,
  getDisposableCacheStats,
  putDisposableCache,
  readDisposableCache,
  sweepExpiredDisposableCache,
} from '../../lib/disposableCacheDb';
import { registerDisposableCacheOwner } from '../../lib/disposableCacheRegistry';
import type { FranchiseActivity } from './franchiseActivitiesLogic';

export const FRANCHISE_ACTIVITIES_CACHE_NAMESPACE = 'franchise-activities';
export const FRANCHISE_ACTIVITIES_CACHE_TTL_MS = 15 * 60 * 1000;
export const FRANCHISE_ACTIVITIES_CACHE_MAX_ENTRIES = 5_000;
export const FRANCHISE_ACTIVITIES_CACHE_MAX_BYTES = 25 * 1024 * 1024;

function activityCacheKey(username: string, mediaId: number): string {
  return `${username.trim().toLocaleLowerCase()}:${mediaId}`;
}

function isCachedActivity(value: unknown): value is FranchiseActivity {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const activity = value as Partial<FranchiseActivity>;
  return (
    typeof activity.id === 'number' &&
    typeof activity.status === 'string' &&
    typeof activity.createdAt === 'number' &&
    typeof activity.siteUrl === 'string' &&
    typeof activity.replyCount === 'number' &&
    !!activity.media &&
    typeof activity.media.id === 'number' &&
    typeof activity.media.title === 'string'
  );
}

export async function readFranchiseActivitiesCache(
  username: string,
  mediaId: number,
): Promise<{ hit: true; activities: FranchiseActivity[] } | { hit: false }> {
  const result = await readDisposableCache<unknown>(
    FRANCHISE_ACTIVITIES_CACHE_NAMESPACE,
    activityCacheKey(username, mediaId),
  );
  if (
    !result.hit ||
    !Array.isArray(result.value) ||
    !result.value.every(isCachedActivity)
  ) {
    return { hit: false };
  }
  return { hit: true, activities: result.value };
}

export async function writeFranchiseActivitiesCache(
  username: string,
  mediaId: number,
  activities: readonly FranchiseActivity[],
): Promise<void> {
  await putDisposableCache(
    FRANCHISE_ACTIVITIES_CACHE_NAMESPACE,
    activityCacheKey(username, mediaId),
    [...activities],
    { expiresAt: Date.now() + FRANCHISE_ACTIVITIES_CACHE_TTL_MS },
  );
}

export async function enforceFranchiseActivitiesCacheBudget(
  retainKeys: ReadonlySet<string> = new Set(),
): Promise<void> {
  await enforceDisposableCacheBudget(FRANCHISE_ACTIVITIES_CACHE_NAMESPACE, {
    maxEntries: FRANCHISE_ACTIVITIES_CACHE_MAX_ENTRIES,
    maxBytes: FRANCHISE_ACTIVITIES_CACHE_MAX_BYTES,
    retainKeys,
  });
}

export function franchiseActivitiesCacheKeys(
  username: string,
  mediaIds: readonly number[],
): Set<string> {
  return new Set(mediaIds.map((mediaId) => activityCacheKey(username, mediaId)));
}

export async function clearFranchiseActivitiesCache(): Promise<void> {
  await clearDisposableCacheNamespace(FRANCHISE_ACTIVITIES_CACHE_NAMESPACE);
}

registerDisposableCacheOwner({
  id: FRANCHISE_ACTIVITIES_CACHE_NAMESPACE,
  label: 'Franchise activity cache',
  deletionEffect: 'Activity timelines are fetched again from AniList when needed.',
  measure: () => getDisposableCacheStats(FRANCHISE_ACTIVITIES_CACHE_NAMESPACE),
  clear: clearFranchiseActivitiesCache,
  clearUnderPressure: async () => {
    await sweepExpiredDisposableCache(FRANCHISE_ACTIVITIES_CACHE_NAMESPACE);
    await clearFranchiseActivitiesCache();
  },
});
