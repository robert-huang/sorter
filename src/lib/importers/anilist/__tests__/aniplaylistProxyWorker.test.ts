import { afterEach, describe, expect, it, vi } from 'vitest';
// The deployed Cloudflare Worker intentionally stays plain JavaScript.
// @ts-expect-error No declaration file is needed for the worker entry point.
import worker from '../../../../../cloudflare/aniplaylist-algolia-proxy.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AniPlaylist and AniList image proxy', () => {
  it('returns AniList CDN images with canvas-safe CORS headers', async () => {
    const upstreamFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('image', {
        status: 200,
        headers: {
          'Cache-Control': 'max-age=2678400',
          'Content-Type': 'image/jpeg',
        },
      }),
    );
    const path = '/file/anilistcdn/media/anime/cover/large/test.jpg';

    const response = await worker.fetch(
      new Request(
        `https://worker.example/image?path=${encodeURIComponent(path)}`,
      ),
    );

    expect(upstreamFetch).toHaveBeenCalledWith(
      `https://s4.anilist.co${path}`,
      { headers: { Accept: 'image/*' } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(response.headers.get('Cache-Control')).toBe('max-age=2678400');
    expect(await response.text()).toBe('image');
  });

  it('rejects paths outside the AniList CDN file tree', async () => {
    const upstreamFetch = vi.spyOn(globalThis, 'fetch');

    const response = await worker.fetch(
      new Request(
        'https://worker.example/image?path=%2Ffile%2Fanilistcdn%2F..%2F..%2Fapi',
      ),
    );

    expect(response.status).toBe(400);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});
