import { afterEach, describe, expect, it, vi } from 'vitest';
// The deployed Cloudflare Worker intentionally stays plain JavaScript.
// @ts-expect-error No declaration file is needed for the worker entry point.
import worker from '../../../../../cloudflare/aniplaylist-algolia-proxy.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AniPlaylist Algolia proxy', () => {
  it('rejects the removed image route without fetching upstream', async () => {
    const upstreamFetch = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch(
      new Request('https://worker.example/image'),
    );

    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(405);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
      'POST, OPTIONS',
    );
  });

  it('forwards Algolia search POST requests', async () => {
    const upstreamFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"results":[]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const response = await worker.fetch(
      new Request('https://worker.example/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"requests":[]}',
      }),
    );

    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });
});
