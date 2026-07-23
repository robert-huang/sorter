/**
 * Spotify OAuth (authorization code + PKCE) for theme-song playlist matching.
 *
 * Tokens live in localStorage (`spotify:auth:v1`). Popup + hosted callback
 * page (same pattern as AniList sign-in).
 *
 * Env:
 *   - `VITE_SPOTIFY_CLIENT_ID` (required)
 *   - `VITE_SPOTIFY_CLIENT_SECRET` (required for token exchange in this build)
 *   - `VITE_SPOTIFY_OAUTH_CALLBACK_URL` (optional override)
 */

import { GITHUB_PAGES_URL } from '../appRoutes';

const ENV = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env) ?? {};
const SPOTIFY_CLIENT_ID: string = ENV.VITE_SPOTIFY_CLIENT_ID ?? '';
const SPOTIFY_CLIENT_SECRET: string = ENV.VITE_SPOTIFY_CLIENT_SECRET ?? '';
const CALLBACK_URL_OVERRIDE: string = ENV.VITE_SPOTIFY_OAUTH_CALLBACK_URL ?? '';

export const SPOTIFY_AUTH_STORAGE_KEY = 'spotify:auth:v1';
const OAUTH_PENDING_KEY = 'spotify:oauth:pending-nonce';
const PKCE_VERIFIER_KEY = 'spotify:pkce:verifier';

const AUTHORIZE_ENDPOINT = 'https://accounts.spotify.com/authorize';
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

/** Read private playlists + relinked track metadata. */
const SPOTIFY_SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-private',
].join(' ');

export const SPOTIFY_OAUTH_MESSAGE_TYPE = 'spotify-oauth-callback';
export const SPOTIFY_AUTH_CHANGED = 'spotify-auth-changed';

const POPUP_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

export type SpotifyOAuthState = {
  origin: string;
  nonce: string;
};

export type SpotifyOAuthCallbackMessage = {
  type: typeof SPOTIFY_OAUTH_MESSAGE_TYPE;
  code: string | null;
  error: string | null;
  nonce: string | null;
};

export type StoredSpotifyAuth = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  displayName: string | null;
  spotifyUserId: string | null;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type SpotifyProfile = {
  id?: string;
  display_name?: string | null;
};

const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SPOTIFY_AUTH_CHANGED));
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    s += String.fromCharCode(b);
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomString(byteLen: number): string {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

async function sha256(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hash);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await sha256(verifier);
  return base64UrlEncode(digest);
}

function readStoredAuth(): StoredSpotifyAuth | null {
  try {
    const raw = localStorage.getItem(SPOTIFY_AUTH_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredSpotifyAuth>;
    if (!parsed.accessToken || typeof parsed.expiresAt !== 'number') {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken ?? '',
      expiresAt: parsed.expiresAt,
      displayName: parsed.displayName ?? null,
      spotifyUserId: parsed.spotifyUserId ?? null,
    };
  } catch {
    return null;
  }
}

function writeStoredAuth(auth: StoredSpotifyAuth): void {
  try {
    localStorage.setItem(SPOTIFY_AUTH_STORAGE_KEY, JSON.stringify(auth));
  } catch {
    /* ignore quota */
  }
  emitChange();
}

export function getStoredSpotifyAuth(): StoredSpotifyAuth | null {
  return readStoredAuth();
}

export function isSpotifyOAuthConfigured(): boolean {
  return SPOTIFY_CLIENT_ID.length > 0 && SPOTIFY_CLIENT_SECRET.length > 0;
}

export function getSpotifyOAuthCallbackUrl(): string {
  if (CALLBACK_URL_OVERRIDE) {
    return CALLBACK_URL_OVERRIDE;
  }
  const base = GITHUB_PAGES_URL.endsWith('/') ? GITHUB_PAGES_URL : `${GITHUB_PAGES_URL}/`;
  return `${base}spotify-oauth-callback.html`;
}

export function getSpotifyOAuthCallbackOrigin(): string {
  return new URL(getSpotifyOAuthCallbackUrl()).origin;
}

export function encodeSpotifyOAuthState(state: SpotifyOAuthState): string {
  return btoa(JSON.stringify(state))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function decodeSpotifyOAuthState(raw: string): SpotifyOAuthState | null {
  try {
    let padded = raw.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4 !== 0) {
      padded += '=';
    }
    const parsed = JSON.parse(atob(padded)) as Partial<SpotifyOAuthState>;
    if (typeof parsed.origin === 'string' && typeof parsed.nonce === 'string') {
      return { origin: parsed.origin, nonce: parsed.nonce };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function isSpotifyOAuthCallbackMessage(
  data: unknown,
): data is SpotifyOAuthCallbackMessage {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const row = data as Partial<SpotifyOAuthCallbackMessage>;
  return row.type === SPOTIFY_OAUTH_MESSAGE_TYPE;
}

function requireClientConfig(): { clientId: string; clientSecret: string } {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error(
      'Spotify sign-in is not configured: set VITE_SPOTIFY_CLIENT_ID and ' +
        `VITE_SPOTIFY_CLIENT_SECRET at build time. Register redirect URL ` +
        `${getSpotifyOAuthCallbackUrl()} in the Spotify developer dashboard.`,
    );
  }
  return { clientId: SPOTIFY_CLIENT_ID, clientSecret: SPOTIFY_CLIENT_SECRET };
}

async function exchangeAuthorizationCode(code: string, verifier: string): Promise<StoredSpotifyAuth> {
  const { clientId, clientSecret } = requireClientConfig();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getSpotifyOAuthCallbackUrl(),
    client_id: clientId,
    code_verifier: verifier,
    client_secret: clientSecret,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Spotify token exchange failed: ${json.error_description ?? json.error ?? res.status}`,
    );
  }
  return persistTokensFromResponse(json);
}

async function refreshAccessToken(refreshToken: string): Promise<StoredSpotifyAuth> {
  const { clientId, clientSecret } = requireClientConfig();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Spotify token refresh failed: ${json.error_description ?? json.error ?? res.status}`,
    );
  }
  const existing = readStoredAuth();
  if (!json.refresh_token && existing?.refreshToken) {
    json.refresh_token = existing.refreshToken;
  }
  return persistTokensFromResponse(json);
}

async function persistTokensFromResponse(json: TokenResponse): Promise<StoredSpotifyAuth> {
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  const auth: StoredSpotifyAuth = {
    accessToken: json.access_token!,
    refreshToken: json.refresh_token ?? readStoredAuth()?.refreshToken ?? '',
    expiresAt: Date.now() + expiresIn * 1000,
    displayName: readStoredAuth()?.displayName ?? null,
    spotifyUserId: readStoredAuth()?.spotifyUserId ?? null,
  };
  writeStoredAuth(auth);
  try {
    const profileRes = await fetch(`${API_BASE}/me`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (profileRes.ok) {
      const profile = (await profileRes.json()) as SpotifyProfile;
      auth.displayName = profile.display_name ?? null;
      auth.spotifyUserId = profile.id ?? null;
      writeStoredAuth(auth);
    }
  } catch {
    /* profile is optional */
  }
  return auth;
}

export async function ensureSpotifyAccessToken(now = Date.now()): Promise<string | null> {
  const stored = readStoredAuth();
  if (!stored) {
    return null;
  }
  if (stored.expiresAt > now + TOKEN_EXPIRY_BUFFER_MS) {
    return stored.accessToken;
  }
  if (!stored.refreshToken) {
    return null;
  }
  try {
    const refreshed = await refreshAccessToken(stored.refreshToken);
    return refreshed.accessToken;
  } catch {
    return null;
  }
}

export async function buildSpotifyPopupAuthorizeUrl(
  origin: string,
  nonce: string,
  verifier: string,
): Promise<string> {
  const { clientId } = requireClientConfig();
  const state = encodeSpotifyOAuthState({ origin, nonce });
  const challenge = await pkceChallenge(verifier);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: getSpotifyOAuthCallbackUrl(),
    scope: SPOTIFY_SCOPES,
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

export function signInToSpotify(): Promise<StoredSpotifyAuth> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Spotify sign-in requires a browser window'));
  }

  const nonce = randomString(16);
  const verifier = randomString(64);
  const origin = window.location.origin;

  try {
    sessionStorage.setItem(OAUTH_PENDING_KEY, nonce);
    sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  } catch {
    /* ignore */
  }

  return buildSpotifyPopupAuthorizeUrl(origin, nonce, verifier).then((authorizeUrl) => {
    const popup = window.open(
      authorizeUrl,
      'spotify-oauth',
      'popup,width=520,height=720,resizable=yes,scrollbars=yes',
    );
    if (!popup) {
      sessionStorage.removeItem(OAUTH_PENDING_KEY);
      sessionStorage.removeItem(PKCE_VERIFIER_KEY);
      throw new Error(
        'Could not open Spotify sign-in pop-up — allow pop-ups for this site, then try again.',
      );
    }

    const popupWindow = popup;

    return new Promise<StoredSpotifyAuth>((resolve, reject) => {
      const callbackOrigin = getSpotifyOAuthCallbackOrigin();
      let settled = false;

      const timeoutId = window.setTimeout(() => {
        finish(() => {
          reject(new Error('Spotify sign-in timed out — close the pop-up and try again.'));
        });
      }, POPUP_SIGN_IN_TIMEOUT_MS);

      const pollId = window.setInterval(() => {
        if (popupWindow.closed) {
          finish(() => {
            if (!settled) {
              reject(new Error('Spotify sign-in was cancelled (pop-up closed).'));
            }
          });
        }
      }, 500);

      function finish(next: () => void): void {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
        window.clearInterval(pollId);
        window.removeEventListener('message', onMessage);
        sessionStorage.removeItem(OAUTH_PENDING_KEY);
        sessionStorage.removeItem(PKCE_VERIFIER_KEY);
        try {
          popupWindow.close();
        } catch {
          /* ignore */
        }
        next();
      }

      function onMessage(event: MessageEvent): void {
        if (event.origin !== callbackOrigin) {
          return;
        }
        if (!isSpotifyOAuthCallbackMessage(event.data)) {
          return;
        }
        const expectedNonce = sessionStorage.getItem(OAUTH_PENDING_KEY);
        if (!expectedNonce || event.data.nonce !== expectedNonce) {
          return;
        }
        if (event.data.error) {
          finish(() => {
            reject(new Error(`Spotify sign-in failed: ${event.data.error}`));
          });
          return;
        }
        if (!event.data.code) {
          finish(() => {
            reject(new Error('Spotify sign-in failed: no authorization code returned'));
          });
          return;
        }
        const storedVerifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
        if (!storedVerifier) {
          finish(() => {
            reject(new Error('Spotify sign-in failed: PKCE verifier missing'));
          });
          return;
        }
        void exchangeAuthorizationCode(event.data.code, storedVerifier)
          .then((auth) => {
            finish(() => {
              resolve(auth);
            });
          })
          .catch((err) => {
            finish(() => {
              reject(err instanceof Error ? err : new Error('Spotify sign-in failed'));
            });
          });
      }

      window.addEventListener('message', onMessage);
    });
  });
}

export function signOutSpotify(): void {
  try {
    localStorage.removeItem(SPOTIFY_AUTH_STORAGE_KEY);
    localStorage.removeItem('spotify:playlist:v1');
    localStorage.removeItem('spotify:playlist-cache:v1');
  } catch {
    /* ignore */
  }
  emitChange();
}

export function subscribeSpotifyAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset. */
export function _clearSpotifyAuthForTesting(): void {
  try {
    localStorage.removeItem(SPOTIFY_AUTH_STORAGE_KEY);
    sessionStorage.removeItem(OAUTH_PENDING_KEY);
    sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  } catch {
    /* ignore */
  }
  emitChange();
}
