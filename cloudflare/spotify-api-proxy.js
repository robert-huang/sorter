/**
 * Cloudflare Worker — restricted Spotify Web API proxy.
 *
 * Spotify sends Retry-After on 429 responses but does not expose it to browser
 * JavaScript. This proxy forwards that header with the required CORS exposure.
 *
 * Deploy: `npx wrangler deploy cloudflare/spotify-api-proxy.js --name sorter-spotify-proxy`
 * Build: set `VITE_SPOTIFY_PROXY_URL` to the worker URL ending in `/spotify`.
 */

const SPOTIFY_API_ORIGIN = 'https://api.spotify.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Accept, Authorization, Content-Type, If-Modified-Since, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag, Last-Modified, Retry-After',
};

const PLAYLIST_ITEMS_PATH = /^\/v1\/playlists\/[0-9A-Za-z]+\/items$/;

/** Endpoints per method: reads, plus the playlist add/remove/create writes. */
function isAllowedSpotifyRequest(method, pathname) {
  if (method === 'GET') {
    return (
      pathname === '/v1/me' ||
      pathname === '/v1/me/playlists' ||
      PLAYLIST_ITEMS_PATH.test(pathname) ||
      /^\/v1\/tracks\/[0-9A-Za-z]+$/.test(pathname)
    );
  }
  if (method === 'POST') {
    return pathname === '/v1/me/playlists' || PLAYLIST_ITEMS_PATH.test(pathname);
  }
  if (method === 'DELETE') {
    return PLAYLIST_ITEMS_PATH.test(pathname);
  }
  return false;
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const authorization = request.headers.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) {
      return new Response('Authorization required', { status: 401, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const spotifyPath = url.pathname.replace(/^\/spotify/, '');
    if (!isAllowedSpotifyRequest(request.method, spotifyPath)) {
      return new Response('Spotify endpoint not allowed', {
        status: 403,
        headers: CORS_HEADERS,
      });
    }

    const upstreamUrl = `${SPOTIFY_API_ORIGIN}${spotifyPath}${url.search}`;
    const upstreamHeaders = {
      Accept: request.headers.get('Accept') ?? 'application/json',
      Authorization: authorization,
    };
    const ifNoneMatch = request.headers.get('If-None-Match');
    const ifModifiedSince = request.headers.get('If-Modified-Since');
    if (ifNoneMatch) {
      upstreamHeaders['If-None-Match'] = ifNoneMatch;
    }
    if (ifModifiedSince) {
      upstreamHeaders['If-Modified-Since'] = ifModifiedSince;
    }
    const isWrite = request.method !== 'GET';
    if (isWrite) {
      upstreamHeaders['Content-Type'] = request.headers.get('Content-Type') ?? 'application/json';
    }
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      ...(isWrite ? { body: await request.text() } : {}),
    });

    const headers = new Headers({
      ...CORS_HEADERS,
      'Cache-Control': upstream.headers.get('Cache-Control') ?? 'private, max-age=0',
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
    });
    for (const headerName of ['ETag', 'Last-Modified', 'Retry-After']) {
      const value = upstream.headers.get(headerName);
      if (value) {
        headers.set(headerName, value);
      }
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  },
};
