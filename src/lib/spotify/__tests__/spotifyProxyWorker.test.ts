import { afterEach, describe, expect, it, vi } from 'vitest';
// The deployed Cloudflare Worker intentionally stays plain JavaScript.
// @ts-expect-error No declaration file is needed for the worker entry point.
import worker from '../../../../cloudflare/spotify-api-proxy.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Spotify API proxy', () => {
  it('forwards allowed requests and exposes Retry-After', async () => {
    const upstreamFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { status: 429 } }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '442',
        },
      }),
    );

    const response = await worker.fetch(
      new Request('https://worker.example/spotify/v1/tracks/abc123?market=CA', {
        headers: { Authorization: 'Bearer test-token' },
      }),
    );

    expect(upstreamFetch).toHaveBeenCalledWith(
      'https://api.spotify.com/v1/tracks/abc123?market=CA',
      {
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer test-token',
        },
      },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('442');
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Retry-After');
  });

  it('rejects paths outside the Spotify allowlist', async () => {
    const upstreamFetch = vi.spyOn(globalThis, 'fetch');

    const response = await worker.fetch(
      new Request('https://worker.example/spotify/v1/search?q=test', {
        headers: { Authorization: 'Bearer test-token' },
      }),
    );

    expect(response.status).toBe(403);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('preserves conditional request caching headers', async () => {
    const upstreamFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 304,
        headers: {
          'Cache-Control': 'private, max-age=0',
          ETag: '"playlist-version"',
        },
      }),
    );

    const response = await worker.fetch(
      new Request('https://worker.example/spotify/v1/me/playlists', {
        headers: {
          Authorization: 'Bearer test-token',
          'If-None-Match': '"playlist-version"',
        },
      }),
    );

    expect(upstreamFetch).toHaveBeenCalledWith('https://api.spotify.com/v1/me/playlists', {
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer test-token',
        'If-None-Match': '"playlist-version"',
      },
    });
    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe('"playlist-version"');
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=0');
  });
});
