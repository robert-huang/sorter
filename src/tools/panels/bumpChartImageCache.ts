export type LoadedCanvasImage = {
  source: CanvasImageSource;
  dispose: () => void;
};

const BUMP_CHART_EXPORT_IMAGE_CACHE =
  'queue-sorter-bump-chart-mal-export-images-v1';

const memoryBlobCache = new Map<string, Blob>();
const pendingBlobLoads = new Map<string, Promise<Blob | null>>();

async function openImageCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') {
    return null;
  }
  try {
    return await caches.open(BUMP_CHART_EXPORT_IMAGE_CACHE);
  } catch {
    return null;
  }
}

async function readCachedBlob(cacheKey: string): Promise<Blob | null> {
  const memoryBlob = memoryBlobCache.get(cacheKey);
  if (memoryBlob) {
    return memoryBlob;
  }

  const cache = await openImageCache();
  if (!cache) {
    return null;
  }
  try {
    const response = await cache.match(cacheKey);
    if (!response?.ok) {
      return null;
    }
    const blob = await response.blob();
    memoryBlobCache.set(cacheKey, blob);
    return blob;
  } catch {
    return null;
  }
}

async function cacheBlob(cacheKey: string, blob: Blob): Promise<void> {
  memoryBlobCache.set(cacheKey, blob);
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
  } catch {
    // The in-memory cache still prevents duplicate requests this session.
  }
}

async function fetchImageBlob(
  src: string,
  cacheKey: string,
): Promise<Blob | null> {
  try {
    const response = await fetch(src, { mode: 'cors' });
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get('Content-Type') ?? '';
    if (contentType && !contentType.startsWith('image/')) {
      return null;
    }
    const blob = await response.blob();
    await cacheBlob(cacheKey, blob);
    return blob;
  } catch {
    return null;
  }
}

async function loadImageBlob(
  src: string,
  cacheKey: string,
): Promise<Blob | null> {
  const cachedBlob = await readCachedBlob(cacheKey);
  if (cachedBlob) {
    return cachedBlob;
  }

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
): Promise<LoadedCanvasImage | null> {
  const blob = await loadImageBlob(src, cacheKey);
  if (!blob) {
    return null;
  }
  try {
    return await decodeCanvasImage(blob);
  } catch {
    memoryBlobCache.delete(cacheKey);
    const cache = await openImageCache();
    await cache?.delete(cacheKey).catch(() => false);
    return null;
  }
}

export function _resetBumpChartImageMemoryCacheForTesting(): void {
  memoryBlobCache.clear();
  pendingBlobLoads.clear();
}
