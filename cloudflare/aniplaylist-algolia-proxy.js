/**
 * Cloudflare Worker — proxies AniPlaylist Algolia search with aniplaylist.com
 * referer (browser apps cannot set that header; Algolia blocks localhost/GH Pages).
 *
 * Deploy: `npx wrangler deploy cloudflare/aniplaylist-algolia-proxy.js`
 * Build: set `VITE_ANIPLAYLIST_PROXY_URL` (see scripts/worker-urls.mjs). Local prod-parity dev: `npm run dev:workers`.
 */

const ALGOLIA_URL = 'https://p4b7ht5p18-dsn.algolia.net/1/indexes/*/queries';
const ANIPLAYLIST_ORIGIN = 'https://aniplaylist.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Accept, x-algolia-application-id, x-algolia-api-key',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const upstream = await fetch(ALGOLIA_URL, {
      method: 'POST',
      headers: {
        Accept: request.headers.get('Accept') ?? '*/*',
        'Content-Type': request.headers.get('Content-Type') ?? 'application/json',
        'x-algolia-application-id': 'P4B7HT5P18',
        'x-algolia-api-key': 'cd90c9c918df8b42327310ade1f599bd',
        Origin: ANIPLAYLIST_ORIGIN,
        Referer: `${ANIPLAYLIST_ORIGIN}/`,
      },
      body: request.body,
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      },
    });
  },
};
