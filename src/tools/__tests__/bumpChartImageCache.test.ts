import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetBumpChartImageMemoryCacheForTesting,
  loadCachedCanvasImage,
} from '../panels/bumpChartImageCache';

const MAL_IMAGE = 'https://cdn.myanimelist.net/images/anime/4/19644.jpg';
const ENTITY_CACHE_KEY =
  'https://queue-sorter.invalid/bump-mal-export/v1/anilist%3A1';

beforeEach(() => {
  _resetBumpChartImageMemoryCacheForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubImageDecoder(): ReturnType<typeof vi.fn> {
  const createImageBitmap = vi.fn(async () => ({
    width: 100,
    height: 150,
    close: vi.fn(),
  }));
  vi.stubGlobal('createImageBitmap', createImageBitmap);
  return createImageBitmap;
}

describe('Bump Chart export image cache', () => {
  it('deduplicates direct CORS requests and reuses the in-memory blob', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString() !== MAL_IMAGE) {
        throw new Error('Unexpected image URL');
      }
      return new Response(new Blob(['image'], { type: 'image/jpeg' }), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const createImageBitmap = stubImageDecoder();

    const [first, duplicate] = await Promise.all([
      loadCachedCanvasImage(MAL_IMAGE, ENTITY_CACHE_KEY),
      loadCachedCanvasImage(MAL_IMAGE, ENTITY_CACHE_KEY),
    ]);
    const reused = await loadCachedCanvasImage(MAL_IMAGE, ENTITY_CACHE_KEY);

    expect(first).not.toBeNull();
    expect(duplicate).not.toBeNull();
    expect(reused).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(createImageBitmap).toHaveBeenCalledTimes(3);

    first?.dispose();
    duplicate?.dispose();
    reused?.dispose();
  });

  it('reuses a persistent cached blob after the memory cache is reset', async () => {
    let storedResponse: Response | null = null;
    const cache = {
      match: vi.fn(async () => storedResponse?.clone()),
      put: vi.fn(async (_key: RequestInfo | URL, response: Response) => {
        storedResponse = response.clone();
      }),
      delete: vi.fn(async () => {
        storedResponse = null;
        return true;
      }),
    };
    vi.stubGlobal('caches', {
      open: vi.fn(async () => cache),
    });
    const fetchMock = vi.fn(async () => {
      return new Response(new Blob(['image'], { type: 'image/jpeg' }), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    stubImageDecoder();

    const first = await loadCachedCanvasImage(MAL_IMAGE, ENTITY_CACHE_KEY);
    first?.dispose();
    _resetBumpChartImageMemoryCacheForTesting();
    const restored = await loadCachedCanvasImage(MAL_IMAGE, ENTITY_CACHE_KEY);
    restored?.dispose();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cache.put).toHaveBeenCalledOnce();
    expect(cache.match).toHaveBeenCalledTimes(2);
    expect(restored).not.toBeNull();
  });

  it('rejects a successful non-image response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('<html>blocked</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }),
    );
    stubImageDecoder();

    await expect(
      loadCachedCanvasImage(MAL_IMAGE, ENTITY_CACHE_KEY),
    ).resolves.toBeNull();
  });
});
