import { describe, expect, it } from 'vitest';
import { ANIPLAYLIST_PROXY_URL, MAL_PROXY_URL } from '../../../../../scripts/worker-urls.mjs';

const WORKERS_LIVE = process.env.WORKERS_LIVE === '1';

/**
 * Smoke-test deployed Cloudflare workers (same URLs as `npm run dev:workers`).
 * Run: `WORKERS_LIVE=1 npm run test:workers`
 */
describe.skipIf(!WORKERS_LIVE)('deployed Cloudflare worker proxies', () => {
  it('MAL worker returns theme fields for a known anime', async () => {
    const res = await fetch(
      `${MAL_PROXY_URL}/v2/anime/38993?fields=opening_themes,ending_themes`,
      { headers: { Accept: 'application/json' } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      opening_themes?: unknown[];
      ending_themes?: unknown[];
    };
    expect((body.opening_themes ?? []).length).toBeGreaterThan(0);
    expect((body.ending_themes ?? []).length).toBeGreaterThan(0);
  });

  it('AniPlaylist worker accepts Algolia search POST', async () => {
    const res = await fetch(ANIPLAYLIST_PROXY_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          {
            indexName: 'songs_prod',
            params: 'query=zero+centimeter&hitsPerPage=1&page=0',
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results?: Array<{ hits?: unknown[] }> };
    expect((body.results?.[0]?.hits ?? []).length).toBeGreaterThan(0);
  });
});
