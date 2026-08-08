import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDisposableCacheDbForTesting } from '../../lib/disposableCacheDb';
import {
  _resetBumpChartImageMemoryCacheForTesting,
  clearBumpChartImageCache,
  loadCachedCanvasImage,
  measureBumpChartImageCache,
} from '../panels/bumpChartImageCache';

const MAL_IMAGE = 'https://cdn.myanimelist.net/images/anime/4/19644.jpg';
const REFRESHED_MAL_IMAGE =
  'https://cdn.myanimelist.net/images/anime/4/refreshed.jpg';
const ENTITY_CACHE_KEY =
  'https://queue-sorter.invalid/bump-mal-export/v1/anilist%3A1';

beforeEach(async () => {
  await _resetDisposableCacheDbForTesting();
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

  it('reconciles and explicitly clears persistent images written before metadata tracking', async () => {
    let storedResponse: Response | null = new Response(
      new Blob(['legacy-image'], { type: 'image/jpeg' }),
      { status: 200 },
    );
    const request = new Request(ENTITY_CACHE_KEY);
    const cache = {
      keys: vi.fn(async () => (storedResponse ? [request] : [])),
      match: vi.fn(async () => storedResponse?.clone()),
      delete: vi.fn(async () => {
        storedResponse = null;
        return true;
      }),
    };
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) });

    await expect(measureBumpChartImageCache()).resolves.toEqual({
      entries: 1,
      bytes: 13,
    });
    await clearBumpChartImageCache();

    expect(cache.delete).toHaveBeenCalledWith(ENTITY_CACHE_KEY);
    await expect(measureBumpChartImageCache()).resolves.toEqual({
      entries: 0,
      bytes: 0,
    });
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

  it('deletes a corrupt cached blob and retries the mapped URL immediately', async () => {
    const cache = {
      match: vi.fn(async () =>
        new Response(new Blob(['corrupt'], { type: 'image/jpeg' }), {
          status: 200,
        }),
      ),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => true),
    };
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
    const fetchMock = vi.fn(async () =>
      new Response(new Blob(['valid'], { type: 'image/jpeg' }), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const createImageBitmap = vi
      .fn()
      .mockRejectedValueOnce(new Error('corrupt image'))
      .mockResolvedValueOnce({
        width: 100,
        height: 150,
        close: vi.fn(),
      });
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => {
        throw new Error('fallback decode failed');
      }),
      revokeObjectURL: vi.fn(),
    });

    const loaded = await loadCachedCanvasImage(MAL_IMAGE, ENTITY_CACHE_KEY);

    expect(loaded).not.toBeNull();
    expect(cache.delete).toHaveBeenCalledWith(ENTITY_CACHE_KEY);
    expect(fetchMock).toHaveBeenCalledWith(MAL_IMAGE, { mode: 'cors' });
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    loaded?.dispose();
  });

  it.each([403, 404, 410])(
    'refreshes a stale mapping once after an HTTP %s response',
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(
          new Response(new Blob(['image'], { type: 'image/jpeg' }), {
            status: 200,
            headers: { 'Content-Type': 'image/jpeg' },
          }),
        );
      vi.stubGlobal('fetch', fetchMock);
      stubImageDecoder();
      const refreshStaleSource = vi.fn(async () => ({
        url: REFRESHED_MAL_IMAGE,
        cacheKey: ENTITY_CACHE_KEY,
      }));

      const loaded = await loadCachedCanvasImage(
        MAL_IMAGE,
        ENTITY_CACHE_KEY,
        { refreshStaleSource },
      );

      expect(loaded).not.toBeNull();
      expect(refreshStaleSource).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenNthCalledWith(1, MAL_IMAGE, { mode: 'cors' });
      expect(fetchMock).toHaveBeenNthCalledWith(2, REFRESHED_MAL_IMAGE, {
        mode: 'cors',
      });
      loaded?.dispose();
    },
  );

  it('refreshes a stale mapping once after a non-image response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('<html>expired</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Blob(['image'], { type: 'image/jpeg' }), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    stubImageDecoder();
    const refreshStaleSource = vi.fn(async () => ({
      url: REFRESHED_MAL_IMAGE,
      cacheKey: ENTITY_CACHE_KEY,
    }));

    const loaded = await loadCachedCanvasImage(MAL_IMAGE, ENTITY_CACHE_KEY, {
      refreshStaleSource,
    });

    expect(loaded).not.toBeNull();
    expect(refreshStaleSource).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    loaded?.dispose();
  });

  it('refreshes once when a successful payload cannot be decoded as an image', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('<html>expired</html>', {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Blob(['image'], { type: 'image/jpeg' }), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'createImageBitmap',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('not an image'))
        .mockResolvedValueOnce({
          width: 100,
          height: 150,
          close: vi.fn(),
        }),
    );
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => {
        throw new Error('fallback decode failed');
      }),
      revokeObjectURL: vi.fn(),
    });
    const refreshStaleSource = vi.fn(async () => ({
      url: REFRESHED_MAL_IMAGE,
      cacheKey: ENTITY_CACHE_KEY,
    }));

    const loaded = await loadCachedCanvasImage(MAL_IMAGE, ENTITY_CACHE_KEY, {
      refreshStaleSource,
    });

    expect(loaded).not.toBeNull();
    expect(refreshStaleSource).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    loaded?.dispose();
  });

  it('does not invalidate a mapping after a transient network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network unavailable');
      }),
    );
    const refreshStaleSource = vi.fn();

    await expect(
      loadCachedCanvasImage(MAL_IMAGE, ENTITY_CACHE_KEY, {
        refreshStaleSource,
      }),
    ).resolves.toBeNull();

    expect(refreshStaleSource).not.toHaveBeenCalled();
  });
});
