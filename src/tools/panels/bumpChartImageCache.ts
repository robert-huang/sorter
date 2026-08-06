type LoadedCanvasImage = {
  source: CanvasImageSource;
  dispose: () => void;
};

const ANILIST_IMAGE_HOST = 's4.anilist.co';
const BUMP_CHART_IMAGE_CACHE = 'queue-sorter-bump-chart-images-v1';

const memoryBlobCache = new Map<string, Blob>();
const pendingBlobLoads = new Map<string, Promise<Blob | null>>();

export function canvasImageFetchUrls(
  src: string,
  configuredProxyUrl = import.meta.env.VITE_ANIPLAYLIST_PROXY_URL?.trim() ?? '',
  useLocalProxy = import.meta.env.DEV,
): string[] {
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(src);
  } catch {
    return [src];
  }
  if (sourceUrl.hostname !== ANILIST_IMAGE_HOST) {
    return [src];
  }

  const sourcePath = `${sourceUrl.pathname}${sourceUrl.search}`;
  const fetchUrls: string[] = [];
  if (configuredProxyUrl) {
    try {
      const proxyUrl = new URL(configuredProxyUrl);
      const basePath = proxyUrl.pathname.replace(/\/+$/, '');
      proxyUrl.pathname = `${basePath}/image`;
      proxyUrl.search = '';
      proxyUrl.hash = '';
      proxyUrl.searchParams.set('path', sourcePath);
      fetchUrls.push(proxyUrl.toString());
    } catch {
      // Fall through to the local proxy when a development override is invalid.
    }
  }
  if (useLocalProxy) {
    fetchUrls.push(`/api/anilist-image${sourcePath}`);
  }
  // AniList's CDN omits CORS headers, so a direct request cannot produce an
  // exportable canvas image when a CORS-safe proxy is available.
  return fetchUrls.length > 0 ? fetchUrls : [src];
}

async function openImageCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') {
    return null;
  }
  try {
    return await caches.open(BUMP_CHART_IMAGE_CACHE);
  } catch {
    return null;
  }
}

async function readCachedBlob(src: string): Promise<Blob | null> {
  const memoryBlob = memoryBlobCache.get(src);
  if (memoryBlob) {
    return memoryBlob;
  }

  const cache = await openImageCache();
  if (!cache) {
    return null;
  }
  try {
    const response = await cache.match(src);
    if (!response?.ok) {
      return null;
    }
    const blob = await response.blob();
    memoryBlobCache.set(src, blob);
    return blob;
  } catch {
    return null;
  }
}

async function cacheBlob(src: string, blob: Blob): Promise<void> {
  memoryBlobCache.set(src, blob);
  const cache = await openImageCache();
  if (!cache) {
    return;
  }
  try {
    await cache.put(
      src,
      new Response(blob, {
        headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      }),
    );
  } catch {
    // The in-memory cache still prevents duplicate requests this session.
  }
}

async function fetchImageBlob(src: string): Promise<Blob | null> {
  for (const fetchUrl of canvasImageFetchUrls(src)) {
    try {
      const response = await fetch(fetchUrl, { mode: 'cors' });
      if (!response.ok) {
        continue;
      }
      const blob = await response.blob();
      await cacheBlob(src, blob);
      return blob;
    } catch {
      // Try the next CORS-safe source.
    }
  }
  return null;
}

async function loadImageBlob(src: string): Promise<Blob | null> {
  const cachedBlob = await readCachedBlob(src);
  if (cachedBlob) {
    return cachedBlob;
  }

  const pendingLoad = pendingBlobLoads.get(src);
  if (pendingLoad) {
    return pendingLoad;
  }

  const load = fetchImageBlob(src).finally(() => {
    pendingBlobLoads.delete(src);
  });
  pendingBlobLoads.set(src, load);
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
): Promise<LoadedCanvasImage | null> {
  const blob = await loadImageBlob(src);
  if (!blob) {
    return null;
  }
  try {
    return await decodeCanvasImage(blob);
  } catch {
    memoryBlobCache.delete(src);
    const cache = await openImageCache();
    await cache?.delete(src).catch(() => false);
    return null;
  }
}

export function _resetBumpChartImageMemoryCacheForTesting(): void {
  memoryBlobCache.clear();
  pendingBlobLoads.clear();
}
