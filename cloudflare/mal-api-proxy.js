/**
 * Cloudflare Worker — proxies MyAnimeList API v2 with X-MAL-CLIENT-ID.
 * MAL does not send CORS headers, so browser apps cannot call it directly.
 *
 * Deploy: `npx wrangler deploy cloudflare/mal-api-proxy.js --name sorter-mal-proxy`
 * Set worker secret: `wrangler secret put MAL_CLIENT_ID --name sorter-mal-proxy`
 * Build: set `VITE_MAL_PROXY_URL` (see scripts/worker-urls.mjs). Local prod-parity dev: `npm run dev:workers`.
 */

const MAL_API_ORIGIN = 'https://api.myanimelist.net';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const clientId = env.MAL_CLIENT_ID?.trim();
    if (!clientId) {
      return new Response('MAL_CLIENT_ID not configured', { status: 500, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const malPath = url.pathname.replace(/^\/mal/, '') + url.search;
    const upstream = await fetch(`${MAL_API_ORIGIN}${malPath}`, {
      headers: {
        Accept: request.headers.get('Accept') ?? 'application/json',
        'X-MAL-CLIENT-ID': clientId,
      },
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
