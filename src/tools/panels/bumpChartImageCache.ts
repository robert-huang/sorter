export type LoadedCanvasImage = {
  source: CanvasImageSource;
  dispose: () => void;
};

import {
  deleteDisposableCacheEntries,
  deleteDisposableCacheEntry,
  deleteOldestDisposableCacheFraction,
  enforceDisposableCacheBudget,
  getDisposableCacheStats,
  listDisposableCacheEntries,
  putDisposableCache,
} from '../../lib/disposableCacheDb';
import { registerDisposableCacheOwner } from '../../lib/disposableCacheRegistry';

export const BUMP_CHART_EXPORT_IMAGE_CACHE =
  'queue-sorter-bump-chart-mal-export-images-v1';
const IMAGE_METADATA_NAMESPACE = 'bump-image-blobs';
const IMAGE_CACHE_PREFIX = 'queue-sorter-bump-chart-mal-export-images-';
const MEMORY_MAX_ENTRIES = 32;
const MEMORY_MAX_BYTES = 16 * 1024 * 1024;
const PERSISTENT_MAX_ENTRIES = 200;
const PERSISTENT_MAX_BYTES = 50 * 1024 * 1024;

const memoryBlobCache = new Map<string, Blob>();
const pendingBlobLoads = new Map<string, Promise<ImageFetchResult>>();
const pinnedCacheKeys = new Map<string, number>();
let obsoleteNamespaceCleanup: Promise<void> | null = null;

type ImageFetchResult =
  | { kind: 'loaded'; blob: Blob }
  | { kind: 'stale-source' }
  | { kind: 'failed' };

export type BumpChartImageSource = {
  url: string;
  cacheKey: string;
};

export type LoadCachedCanvasImageOptions = {
  refreshStaleSource?: () => Promise<BumpChartImageSource | null>;
};

function pinCacheKey(cacheKey: string): void {
  pinnedCacheKeys.set(cacheKey, (pinnedCacheKeys.get(cacheKey) ?? 0) + 1);
}

function unpinCacheKey(cacheKey: string): void {
  const count = pinnedCacheKeys.get(cacheKey) ?? 0;
  if (count <= 1) {
    pinnedCacheKeys.delete(cacheKey);
  } else {
    pinnedCacheKeys.set(cacheKey, count - 1);
  }
}

function setMemoryBlob(cacheKey: string, blob: Blob): void {
  memoryBlobCache.delete(cacheKey);
  memoryBlobCache.set(cacheKey, blob);
  let bytes = [...memoryBlobCache.values()].reduce(
    (total, cachedBlob) => total + cachedBlob.size,
    0,
  );
  for (const [key, cachedBlob] of memoryBlobCache) {
    if (
      memoryBlobCache.size <= MEMORY_MAX_ENTRIES &&
      bytes <= MEMORY_MAX_BYTES
    ) {
      break;
    }
    if (pinnedCacheKeys.has(key)) {
      continue;
    }
    memoryBlobCache.delete(key);
    bytes -= cachedBlob.size;
  }
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}

async function cleanupObsoleteImageCaches(): Promise<void> {
  if (
    typeof caches === 'undefined' ||
    typeof caches.keys !== 'function' ||
    typeof caches.delete !== 'function'
  ) {
    return;
  }
  try {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(
          (name) =>
            name.startsWith(IMAGE_CACHE_PREFIX) &&
            name !== BUMP_CHART_EXPORT_IMAGE_CACHE,
        )
        .map((name) => caches.delete(name)),
    );
  } catch {
    // Cache Storage remains an optional optimization.
  }
}

async function openImageCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') {
    return null;
  }
  try {
    obsoleteNamespaceCleanup ??= cleanupObsoleteImageCaches();
    await obsoleteNamespaceCleanup;
    return await caches.open(BUMP_CHART_EXPORT_IMAGE_CACHE);
  } catch {
    return null;
  }
}

async function readCachedBlob(cacheKey: string): Promise<Blob | null> {
  const memoryBlob = memoryBlobCache.get(cacheKey);
  if (memoryBlob) {
    setMemoryBlob(cacheKey, memoryBlob);
    return memoryBlob;
  }

  const cache = await openImageCache();
  if (!cache) {
    return null;
  }
  try {
    const response = await cache.match(cacheKey);
    if (!response?.ok) {
      await deleteDisposableCacheEntry(IMAGE_METADATA_NAMESPACE, cacheKey);
      return null;
    }
    const blob = await response.blob();
    setMemoryBlob(cacheKey, blob);
    await putDisposableCache(
      IMAGE_METADATA_NAMESPACE,
      cacheKey,
      { contentType: blob.type },
      { byteLength: blob.size },
    );
    return blob;
  } catch {
    return null;
  }
}

async function deletePersistentImageKeys(
  keys: readonly string[],
  strict = false,
): Promise<void> {
  const cache = await openImageCache();
  let cacheError: unknown = null;
  for (const key of keys) {
    memoryBlobCache.delete(key);
    try {
      await cache?.delete(key);
    } catch (error) {
      cacheError ??= error;
    }
  }
  try {
    await deleteDisposableCacheEntries(IMAGE_METADATA_NAMESPACE, keys);
  } catch (error) {
    if (strict) {
      throw error;
    }
  }
  if (strict && cacheError) {
    throw cacheError;
  }
}

async function enforcePersistentBudget(): Promise<void> {
  const removed = await enforceDisposableCacheBudget(
    IMAGE_METADATA_NAMESPACE,
    {
      maxEntries: PERSISTENT_MAX_ENTRIES,
      maxBytes: PERSISTENT_MAX_BYTES,
      retainKeys: new Set(pinnedCacheKeys.keys()),
    },
  );
  const cache = await openImageCache();
  await Promise.all(removed.map((key) => cache?.delete(key).catch(() => false)));
}

async function cacheBlob(cacheKey: string, blob: Blob): Promise<void> {
  setMemoryBlob(cacheKey, blob);
  const cache = await openImageCache();
  if (!cache) {
    return;
  }
  try {
    await cache.put(
      cacheKey,
      new Response(blob, {
        headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      }),
    );
    await putDisposableCache(
      IMAGE_METADATA_NAMESPACE,
      cacheKey,
      { contentType: blob.type },
      { byteLength: blob.size },
    );
    await enforcePersistentBudget();
  } catch (error) {
    if (!isQuotaError(error)) {
      return;
    }
    const removed = await deleteOldestDisposableCacheFraction(
      IMAGE_METADATA_NAMESPACE,
      0.25,
      new Set(pinnedCacheKeys.keys()),
    );
    await deletePersistentImageKeys(removed);
    try {
      await cache.put(
        cacheKey,
        new Response(blob, {
          headers: { 'Content-Type': blob.type || 'application/octet-stream' },
        }),
      );
      await putDisposableCache(
        IMAGE_METADATA_NAMESPACE,
        cacheKey,
        { contentType: blob.type },
        { byteLength: blob.size },
      );
    } catch {
      // The in-memory cache still prevents duplicate requests this session.
    }
  }
}

async function fetchImageBlob(
  src: string,
  cacheKey: string,
): Promise<ImageFetchResult> {
  try {
    const response = await fetch(src, { mode: 'cors' });
    if (!response.ok) {
      return [403, 404, 410].includes(response.status)
        ? { kind: 'stale-source' }
        : { kind: 'failed' };
    }
    const contentType = response.headers.get('Content-Type') ?? '';
    if (contentType && !contentType.startsWith('image/')) {
      return { kind: 'stale-source' };
    }
    const blob = await response.blob();
    await cacheBlob(cacheKey, blob);
    return { kind: 'loaded', blob };
  } catch {
    return { kind: 'failed' };
  }
}

async function fetchImageBlobDeduplicated(
  src: string,
  cacheKey: string,
): Promise<ImageFetchResult> {
  const pendingLoad = pendingBlobLoads.get(cacheKey);
  if (pendingLoad) {
    return pendingLoad;
  }

  const load = fetchImageBlob(src, cacheKey).finally(() => {
    pendingBlobLoads.delete(cacheKey);
  });
  pendingBlobLoads.set(cacheKey, load);
  return load;
}

async function decodeCanvasImage(blob: Blob): Promise<LoadedCanvasImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, dispose: () => bitmap.close() };
    } catch {
      // Some browsers expose createImageBitmap but cannot decode every format.
    }
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Image decode failed.'));
      element.src = objectUrl;
    });
    return {
      source: image,
      dispose: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

export async function loadCachedCanvasImage(
  src: string,
  cacheKey = src,
  options: LoadCachedCanvasImageOptions = {},
): Promise<LoadedCanvasImage | null> {
  pinCacheKey(cacheKey);
  let pinnedCacheKey = cacheKey;
  let keepPinned = false;
  let refreshedSource = false;
  const movePin = (nextCacheKey: string): void => {
    if (nextCacheKey === pinnedCacheKey) {
      return;
    }
    pinCacheKey(nextCacheKey);
    unpinCacheKey(pinnedCacheKey);
    pinnedCacheKey = nextCacheKey;
  };
  const refreshSource = async (): Promise<BumpChartImageSource | null> => {
    if (refreshedSource || !options.refreshStaleSource) {
      return null;
    }
    refreshedSource = true;
    const refreshed = await options.refreshStaleSource();
    if (refreshed) {
      movePin(refreshed.cacheKey);
    }
    return refreshed;
  };
  const loadedImage = async (blob: Blob): Promise<LoadedCanvasImage> => {
    const decoded = await decodeCanvasImage(blob);
    keepPinned = true;
    const disposalCacheKey = pinnedCacheKey;
    let disposed = false;
    return {
      source: decoded.source,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        decoded.dispose();
        unpinCacheKey(disposalCacheKey);
      },
    };
  };
  try {
    const cachedBlob = await readCachedBlob(cacheKey);
    if (cachedBlob) {
      try {
        return await loadedImage(cachedBlob);
      } catch {
        await deletePersistentImageKeys([cacheKey]);
      }
    }

    let source = { url: src, cacheKey };
    while (true) {
      const fetched = await fetchImageBlobDeduplicated(
        source.url,
        source.cacheKey,
      );
      if (fetched.kind === 'stale-source') {
        const refreshed = await refreshSource();
        if (!refreshed) {
          return null;
        }
        source = refreshed;
        continue;
      }
      if (fetched.kind !== 'loaded') {
        return null;
      }
      try {
        return await loadedImage(fetched.blob);
      } catch {
        await deletePersistentImageKeys([source.cacheKey]);
        const refreshed = await refreshSource();
        if (!refreshed) {
          return null;
        }
        source = refreshed;
      }
    }
  } finally {
    if (!keepPinned) {
      unpinCacheKey(pinnedCacheKey);
    }
  }
}

export async function clearBumpChartImageCache(): Promise<void> {
  const entries = await listDisposableCacheEntries(IMAGE_METADATA_NAMESPACE);
  const removable = new Set(
    entries
      .map((entry) => entry.key)
      .filter((key) => !pinnedCacheKeys.has(key)),
  );
  const cache = await openImageCache();
  let enumerationError: unknown = null;
  if (cache && typeof cache.keys === 'function') {
    try {
      const requests = await cache.keys();
      for (const request of requests) {
        if (!pinnedCacheKeys.has(request.url)) {
          removable.add(request.url);
        }
      }
    } catch (error) {
      enumerationError = error;
    }
  }
  await deletePersistentImageKeys([...removable], true);
  if (enumerationError) {
    throw enumerationError;
  }
}

export async function measureBumpChartImageCache(): Promise<{
  entries: number;
  bytes: number;
}> {
  const cache = await openImageCache();
  if (cache && typeof cache.keys === 'function') {
    try {
      const requests = await cache.keys();
      const actualKeys = new Set(requests.map((request) => request.url));
      const metadata = await listDisposableCacheEntries(
        IMAGE_METADATA_NAMESPACE,
      );
      const metadataKeys = new Set(metadata.map((entry) => entry.key));
      for (const entry of metadata) {
        if (!actualKeys.has(entry.key)) {
          await deleteDisposableCacheEntry(IMAGE_METADATA_NAMESPACE, entry.key);
        }
      }
      for (const request of requests) {
        if (metadataKeys.has(request.url)) {
          continue;
        }
        const response = await cache.match(request);
        if (!response?.ok) {
          continue;
        }
        const blob = await response.blob();
        await putDisposableCache(
          IMAGE_METADATA_NAMESPACE,
          request.url,
          { contentType: blob.type },
          { byteLength: blob.size },
        );
      }
    } catch {
      // Metadata remains a useful best-effort estimate.
    }
  }
  return getDisposableCacheStats(IMAGE_METADATA_NAMESPACE);
}

export function _resetBumpChartImageMemoryCacheForTesting(): void {
  memoryBlobCache.clear();
  pendingBlobLoads.clear();
  pinnedCacheKeys.clear();
  obsoleteNamespaceCleanup = null;
}

registerDisposableCacheOwner({
  id: 'bump-images',
  label: 'Bump Chart image cache',
  deletionEffect: 'Images are fetched again from their resolved source URLs.',
  measure: measureBumpChartImageCache,
  clear: clearBumpChartImageCache,
  clearUnderPressure: async () => {
    await measureBumpChartImageCache();
    const removed = await deleteOldestDisposableCacheFraction(
      IMAGE_METADATA_NAMESPACE,
      0.25,
      new Set(pinnedCacheKeys.keys()),
    );
    await deletePersistentImageKeys(removed);
  },
});
