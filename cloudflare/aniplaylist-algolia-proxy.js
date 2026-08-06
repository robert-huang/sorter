/**
 * Cloudflare Worker — proxies AniPlaylist Algolia search and AniList CDN images.
 * Algolia needs an aniplaylist.com referer, while the image route supplies the
 * CORS headers required to draw AniList covers into an exportable canvas.
 *
 * Deploy: `npx wrangler deploy cloudflare/aniplaylist-algolia-proxy.js`
 * Build: set `VITE_ANIPLAYLIST_PROXY_URL` (see scripts/worker-urls.mjs). Local prod-parity dev: `npm run dev:workers`.
 */

const ALGOLIA_URL = 'https://p4b7ht5p18-dsn.algolia.net/1/indexes/*/queries';
const ANIPLAYLIST_ORIGIN = 'https://aniplaylist.com';
const ANILIST_IMAGE_ORIGIN = 'https://s4.anilist.co';
const ANILIST_IMAGE_PATH_PREFIX = '/file/anilistcdn/';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Accept, x-algolia-application-id, x-algolia-api-key',
};

async function proxyAnilistImage(url) {
  const path = url.searchParams.get('path');
  if (!path?.startsWith(ANILIST_IMAGE_PATH_PREFIX)) {
    return new Response('Invalid AniList image path', {
      status: 400,
      headers: CORS_HEADERS,
    });
  }
  const upstreamUrl = new URL(path, ANILIST_IMAGE_ORIGIN);
  if (!upstreamUrl.pathname.startsWith(ANILIST_IMAGE_PATH_PREFIX)) {
    return new Response('Invalid AniList image path', {
      status: 400,
      headers: CORS_HEADERS,
    });
  }
  const upstream = await fetch(upstreamUrl.toString(), {
    headers: { Accept: 'image/*' },
  });
  const contentType = upstream.headers.get('Content-Type') ?? '';
  if (!contentType.startsWith('image/')) {
    return new Response('AniList image unavailable', {
      status: upstream.ok ? 502 : upstream.status,
      headers: CORS_HEADERS,
    });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...CORS_HEADERS,
      'Cache-Control': upstream.headers.get('Cache-Control') ?? 'public, max-age=86400',
      'Content-Type': contentType,
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/image') {
      return proxyAnilistImage(url);
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
