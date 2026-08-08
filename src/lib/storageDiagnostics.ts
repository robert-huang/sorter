import {
  BUMP_WORKSPACE_STORE,
  SORTER_SLOT_STORE,
  STATE_METADATA_STORE,
  readAllStateEntries,
} from './stateStorageDb';
import {
  clearAllDisposableCaches,
  clearDisposableCacheOwner,
  clearDisposableCacheOwners,
  getLastDisposableCacheCleanupResults,
  measureDisposableCacheOwners,
  type DisposableCacheCleanupResult,
} from './disposableCacheRegistry';
import { measureSpotifyCacheDatabase } from './spotify/spotifyPlaylistCacheDb';
import {
  estimateCataloguedLocalStorage,
  type LocalStorageOwnerStats,
} from './storageCatalog';
import { getLastQuotaErrorAt } from './storage';
import './storageCleanupOwners';

export type StorageStoreStats = {
  id: string;
  label: string;
  entries: number;
  bytes: number;
};

export type StorageDiagnostics = {
  collectedAt: number;
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
  localStorage: LocalStorageOwnerStats[];
  stores: StorageStoreStats[];
  lastCleanupError: string | null;
  lastQuotaErrorAt: string | null;
};

function estimateJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
}

async function measureStateStore(
  store: typeof SORTER_SLOT_STORE | typeof BUMP_WORKSPACE_STORE | typeof STATE_METADATA_STORE,
  label: string,
): Promise<StorageStoreStats> {
  const entries = await readAllStateEntries(store).catch(() => []);
  return {
    id: `state:${store}`,
    label,
    entries: entries.length,
    bytes: entries.reduce(
      (total, [key, value]) =>
        total + estimateJsonBytes(key) + estimateJsonBytes(value),
      0,
    ),
  };
}

export async function collectStorageDiagnostics(): Promise<StorageDiagnostics> {
  const estimatePromise: Promise<StorageEstimate> =
    typeof navigator !== 'undefined' && navigator.storage?.estimate
      ? navigator.storage.estimate().catch(() => ({} as StorageEstimate))
      : Promise.resolve({} as StorageEstimate);
  const persistedPromise =
    typeof navigator !== 'undefined' && navigator.storage?.persisted
      ? navigator.storage.persisted().catch(() => null)
      : Promise.resolve(null);

  const [estimate, persisted, cacheOwners, spotify, ...stateStores] =
    await Promise.all([
      estimatePromise,
      persistedPromise,
      measureDisposableCacheOwners(),
      measureSpotifyCacheDatabase().catch(() => ({
        playlistCaches: { entries: 0, bytes: 0 },
        trackIsrcs: { entries: 0, bytes: 0 },
      })),
      measureStateStore(SORTER_SLOT_STORE, 'Sorter slots'),
      measureStateStore(BUMP_WORKSPACE_STORE, 'Bump Chart workspaces'),
      measureStateStore(STATE_METADATA_STORE, 'Saved-state metadata'),
    ]);

  const cleanupError =
    getLastDisposableCacheCleanupResults().find((result) => !result.ok)?.error ??
    null;
  const cacheStores: StorageStoreStats[] = cacheOwners.map((owner) => ({
    id: `cache:${owner.id}`,
    label: owner.label,
    entries: owner.stats.entries,
    bytes: owner.stats.bytes,
  }));
  cacheStores.push({
    id: 'spotify:track-isrcs',
    label: 'Spotify track-to-ISRC mappings',
    entries: spotify.trackIsrcs.entries,
    bytes: spotify.trackIsrcs.bytes,
  });

  return {
    collectedAt: Date.now(),
    usage: typeof estimate.usage === 'number' ? estimate.usage : null,
    quota: typeof estimate.quota === 'number' ? estimate.quota : null,
    persisted,
    localStorage: estimateCataloguedLocalStorage(),
    stores: [...stateStores, ...cacheStores],
    lastCleanupError: cleanupError,
    lastQuotaErrorAt: getLastQuotaErrorAt(),
  };
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    return null;
  }
  return navigator.storage.persist().catch(() => false);
}

function assertCleanupSucceeded(
  results: readonly DisposableCacheCleanupResult[],
): void {
  const failed = results.find((result) => !result.ok);
  if (failed) {
    throw new Error(failed.error ?? 'Cache cleanup failed.');
  }
}

export async function clearImageCaches(): Promise<void> {
  assertCleanupSucceeded(
    await clearDisposableCacheOwners(['bump-images', 'bump-image-urls']),
  );
}

export async function clearToolsApiCaches(): Promise<void> {
  assertCleanupSucceeded(await clearDisposableCacheOwner('tools-api'));
}

export async function clearSpotifyCaches(): Promise<void> {
  assertCleanupSucceeded(await clearDisposableCacheOwner('spotify-playlists'));
}

export async function clearEveryDisposableCache(): Promise<void> {
  assertCleanupSucceeded(await clearAllDisposableCaches());
}
