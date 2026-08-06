import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetBumpChartImageMemoryCacheForTesting,
  canvasImageFetchUrls,
  loadCachedCanvasImage,
} from '../panels/bumpChartImageCache';

const ANILIST_IMAGE =
  'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/cache-test.jpg';

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
  it('deduplicates requests and reuses the in-memory image blob', async () => {
    const proxyUrl = canvasImageFetchUrls(ANILIST_IMAGE)[0]!;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString() !== proxyUrl) {
        throw new Error('Unexpected image URL');
      }
      return new Response(new Blob(['image'], { type: 'image/jpeg' }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const createImageBitmap = stubImageDecoder();

    const [first, duplicate] = await Promise.all([
      loadCachedCanvasImage(ANILIST_IMAGE),
      loadCachedCanvasImage(ANILIST_IMAGE),
    ]);
    const reused = await loadCachedCanvasImage(ANILIST_IMAGE);

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
    const proxyUrl = canvasImageFetchUrls(ANILIST_IMAGE)[0]!;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString() !== proxyUrl) {
        throw new Error('Unexpected image URL');
      }
      return new Response(new Blob(['image'], { type: 'image/jpeg' }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    stubImageDecoder();

    const first = await loadCachedCanvasImage(ANILIST_IMAGE);
    first?.dispose();
    _resetBumpChartImageMemoryCacheForTesting();
    const restored = await loadCachedCanvasImage(ANILIST_IMAGE);
    restored?.dispose();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cache.put).toHaveBeenCalledOnce();
    expect(cache.match).toHaveBeenCalledTimes(2);
    expect(restored).not.toBeNull();
  });
});
