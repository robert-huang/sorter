/**
 * AniList OAuth (implicit grant) + multi-account localStorage store.
 *
 * Tokens live in localStorage (`anilist:accounts:v1`) — same XSS exposure
 * model as Google Drive cloud backup; acceptable for personal-scale use.
 *
 * Env:
 *   - `VITE_ANILIST_CLIENT_ID` (required)
 *   - `VITE_ANILIST_OAUTH_CALLBACK_URL` (optional override for the hosted
 *     callback page; default is the public GitHub Pages callback below)
 *
 * **Sign-in flow (popup + hosted callback):** Register ONE redirect URL on
 * your AniList API client — the callback page URL (default:
 * `https://robert-huang.github.io/sorter/anilist-oauth-callback.html`).
 * Uses implicit grant (`response_type=token`) so the JWT lands in the URL
 * hash — no call to `/oauth/token` (that endpoint is not CORS-enabled).
 *
 * Do not pass `redirect_uri` on the authorize request; AniList uses the URL
 * registered in developer settings (per their implicit-grant docs).
 */

import { GITHUB_PAGES_URL } from '../../appRoutes';
import { GraphQLError, HttpError, executeAnilistQuery } from './transport';

const ENV = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env) ?? {};
const ANILIST_CLIENT_ID: string = ENV.VITE_ANILIST_CLIENT_ID ?? '';
const CALLBACK_URL_OVERRIDE: string = ENV.VITE_ANILIST_OAUTH_CALLBACK_URL ?? '';

const STORAGE_KEY = 'anilist:accounts:v1';
const RETURN_URL_KEY = 'anilist:auth:return-url';
const OAUTH_PENDING_KEY = 'anilist:oauth:pending-nonce';

const AUTHORIZE_ENDPOINT = 'https://anilist.co/api/v2/oauth/authorize';

export const ANILIST_OAUTH_MESSAGE_TYPE = 'anilist-oauth-callback';

/** Fallback when JWT has no `exp` — AniList tokens are long-lived. */
const DEFAULT_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const POPUP_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export const ANILIST_ACCOUNTS_CHANGED = 'anilist-accounts-changed';

const VIEWER_QUERY = `
query Viewer {
  Viewer {
    id
    name
    avatar { large }
  }
}
`.trim();

export type AnilistAccountStatus = 'ok' | 'expired' | 'invalid';

export type AnilistOAuthCallbackMessage = {
  type: typeof ANILIST_OAUTH_MESSAGE_TYPE;
  accessToken: string | null;
  error: string | null;
  nonce: string | null;
};

export type AnilistOAuthState = {
  origin: string;
  nonce: string;
};

export type AnilistStoredAccount = {
  userId: number;
  /** Canonical username from Viewer after login. */
  userName: string;
  displayName?: string;
  avatarUrl?: string | null;
  accessToken: string;
  /** MS since epoch. */
  expiresAt: number;
  addedAt: number;
  status: AnilistAccountStatus;
};

export class AnilistAuthRequiredError extends Error {
  readonly userName: string;
  constructor(userName: string) {
    super(
      `AniList sign-in required for @${userName} — open the gear menu, Databases tab, and sign in again.`,
    );
    this.name = 'AnilistAuthRequiredError';
    this.userName = userName;
  }
}

type AccountStore = {
  accounts: AnilistStoredAccount[];
};

type ViewerPayload = {
  Viewer: {
    id: number;
    name: string;
    avatar: { large?: string | null } | null;
  } | null;
};

let cachedStore: AccountStore | null = null;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(ANILIST_ACCOUNTS_CHANGED));
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) {
      return;
    }
    cachedStore = null;
    emitChange();
  });
}

function readStore(): AccountStore {
  if (cachedStore) {
    return cachedStore;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cachedStore = { accounts: [] };
      return cachedStore;
    }
    const parsed = JSON.parse(raw) as Partial<AccountStore>;
    const accounts = Array.isArray(parsed.accounts)
      ? parsed.accounts.filter(isValidStoredAccount)
      : [];
    cachedStore = { accounts };
    return cachedStore;
  } catch {
    cachedStore = { accounts: [] };
    return cachedStore;
  }
}

function writeStore(store: AccountStore): void {
  cachedStore = store;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* ignore quota */
  }
  emitChange();
}

function isValidStoredAccount(value: unknown): value is AnilistStoredAccount {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const row = value as Partial<AnilistStoredAccount>;
  return (
    typeof row.userId === 'number' &&
    typeof row.userName === 'string' &&
    typeof row.accessToken === 'string' &&
    typeof row.expiresAt === 'number' &&
    typeof row.addedAt === 'number' &&
    (row.status === 'ok' || row.status === 'expired' || row.status === 'invalid')
  );
}

function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

function randomNonce(): string {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function redirectUri(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return `${window.location.origin}${window.location.pathname}`;
}

/**
 * Hosted callback page — register this exact URL on your AniList API client.
 * Local dev uses the same URL (popup postMessages back to localhost).
 */
export function getAnilistOAuthCallbackUrl(): string {
  if (CALLBACK_URL_OVERRIDE) {
    return CALLBACK_URL_OVERRIDE;
  }
  const base = GITHUB_PAGES_URL.endsWith('/') ? GITHUB_PAGES_URL : `${GITHUB_PAGES_URL}/`;
  return `${base}anilist-oauth-callback.html`;
}

export function getAnilistOAuthCallbackOrigin(): string {
  return new URL(getAnilistOAuthCallbackUrl()).origin;
}

export function encodeAnilistOAuthState(state: AnilistOAuthState): string {
  return btoa(JSON.stringify(state))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function decodeAnilistOAuthState(raw: string): AnilistOAuthState | null {
  try {
    let padded = raw.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4 !== 0) {
      padded += '=';
    }
    const parsed = JSON.parse(atob(padded)) as Partial<AnilistOAuthState>;
    if (typeof parsed.origin === 'string' && typeof parsed.nonce === 'string') {
      return { origin: parsed.origin, nonce: parsed.nonce };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function isAnilistOAuthCallbackMessage(
  data: unknown,
): data is AnilistOAuthCallbackMessage {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const row = data as Partial<AnilistOAuthCallbackMessage>;
  return row.type === ANILIST_OAUTH_MESSAGE_TYPE;
}

/** Parse `code` / `error` from an OAuth redirect query string. */
export function parseOAuthQueryParams(search: string): {
  authCode: string | null;
  error: string | null;
  state: string | null;
} {
  const trimmed = search.startsWith('?') ? search.slice(1) : search;
  if (!trimmed) {
    return { authCode: null, error: null, state: null };
  }
  const params = new URLSearchParams(trimmed);
  return {
    authCode: params.get('code'),
    error: params.get('error') ?? params.get('error_description'),
    state: params.get('state'),
  };
}

/** Parse `access_token` (+ optional `token_type`) from an OAuth hash fragment. */
export function parseOAuthHashParams(hash: string): {
  accessToken: string | null;
  tokenType: string | null;
  error: string | null;
} {
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!trimmed) {
    return { accessToken: null, tokenType: null, error: null };
  }
  const params = new URLSearchParams(trimmed);
  return {
    accessToken: params.get('access_token'),
    tokenType: params.get('token_type'),
    error: params.get('error') ?? params.get('error_description'),
  };
}

/** Decode JWT `exp` (seconds) → ms epoch. Returns null when missing/invalid. */
export function decodeJwtExpiresAtMs(token: string, addedAt: number): number {
  const parts = token.split('.');
  if (parts.length < 2) {
    return addedAt + DEFAULT_TOKEN_TTL_MS;
  }
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: number;
    };
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
      return payload.exp * 1000;
    }
  } catch {
    /* fall through */
  }
  return addedAt + DEFAULT_TOKEN_TTL_MS;
}

export function isAnilistAuthFailure(err: unknown): boolean {
  if (err instanceof HttpError && err.status === 401) {
    return true;
  }
  if (err instanceof GraphQLError) {
    return err.errors.some(
      (e) =>
        e.status === 401 ||
        /unauthorized|not authenticated|invalid token|access denied/i.test(e.message),
    );
  }
  return false;
}

export function listAnilistAccounts(): AnilistStoredAccount[] {
  return [...readStore().accounts];
}

export function getAnilistAccount(userId: number): AnilistStoredAccount | null {
  return readStore().accounts.find((a) => a.userId === userId) ?? null;
}

export function findAnilistAccountByName(username: string): AnilistStoredAccount | null {
  const key = normaliseUsername(username);
  if (!key) {
    return null;
  }
  return (
    readStore().accounts.find((a) => normaliseUsername(a.userName) === key) ?? null
  );
}

export function resolveAccessTokenForUsername(username: string): string | null {
  const account = findAnilistAccountByName(username);
  if (!account) {
    return null;
  }
  if (account.status === 'expired' || account.status === 'invalid') {
    throw new AnilistAuthRequiredError(account.userName);
  }
  if (Date.now() >= account.expiresAt) {
    markAnilistAccountExpired(account.userId);
    throw new AnilistAuthRequiredError(account.userName);
  }
  return account.accessToken;
}

/** Like {@link resolveAccessTokenForUsername} but throws when no account is stored. */
export function requireAccessTokenForUsername(username: string): string {
  const token = resolveAccessTokenForUsername(username);
  if (!token) {
    throw new AnilistAuthRequiredError(username.trim() || 'your account');
  }
  return token;
}

export function markAnilistAccountExpired(userId: number): void {
  const store = readStore();
  const idx = store.accounts.findIndex((a) => a.userId === userId);
  if (idx < 0) {
    return;
  }
  const next = [...store.accounts];
  next[idx] = { ...next[idx], status: 'expired' };
  writeStore({ accounts: next });
}

export function markAnilistAccountInvalid(userId: number): void {
  const store = readStore();
  const idx = store.accounts.findIndex((a) => a.userId === userId);
  if (idx < 0) {
    return;
  }
  const next = [...store.accounts];
  next[idx] = { ...next[idx], status: 'invalid' };
  writeStore({ accounts: next });
}

function upsertAccount(account: AnilistStoredAccount): void {
  const store = readStore();
  const without = store.accounts.filter((a) => a.userId !== account.userId);
  writeStore({ accounts: [...without, account] });
}

export function signOutAnilistAccount(userId: number): void {
  const store = readStore();
  writeStore({ accounts: store.accounts.filter((a) => a.userId !== userId) });
}

export function subscribeAnilistAccounts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isAnilistOAuthConfigured(): boolean {
  return ANILIST_CLIENT_ID.length > 0;
}

function requireClientId(): string {
  if (!ANILIST_CLIENT_ID) {
    throw new Error(
      'AniList sign-in is not configured: VITE_ANILIST_CLIENT_ID is empty. ' +
        `Register an API client at https://anilist.co/settings/developer ` +
        `(redirect URL: ${getAnilistOAuthCallbackUrl()}) and set the env var. ` +
        'See README "AniList accounts".',
    );
  }
  return ANILIST_CLIENT_ID;
}

/**
 * Implicit-grant authorize URL. `redirect_uri` is omitted — AniList uses the
 * URL registered in developer settings. Passing `redirect_uri` here with
 * `response_type=token` triggers `unsupported_grant_type`.
 */
export function buildAnilistPopupAuthorizeUrl(origin: string, nonce: string): string {
  const state = encodeAnilistOAuthState({ origin, nonce });
  const params = new URLSearchParams({
    client_id: requireClientId(),
    response_type: 'token',
    state,
  });
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

/**
 * Open AniList in a popup; the hosted callback page returns the token via
 * postMessage. Same redirect URL works for localhost and production.
 */
export function signInToAnilist(): Promise<AnilistStoredAccount> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('AniList sign-in requires a browser window'));
  }

  const nonce = randomNonce();
  const origin = window.location.origin;
  const authorizeUrl = buildAnilistPopupAuthorizeUrl(origin, nonce);

  try {
    sessionStorage.setItem(OAUTH_PENDING_KEY, nonce);
  } catch {
    /* ignore */
  }

  // Do NOT pass noopener — the callback page needs window.opener to postMessage.
  const popup = window.open(
    authorizeUrl,
    'anilist-oauth',
    'popup,width=520,height=720,resizable=yes,scrollbars=yes',
  );
  if (!popup) {
    sessionStorage.removeItem(OAUTH_PENDING_KEY);
    throw new Error(
      'Could not open AniList sign-in pop-up — allow pop-ups for this site, then try again.',
    );
  }

  const popupWindow = popup;

  return new Promise((resolve, reject) => {
    const callbackOrigin = getAnilistOAuthCallbackOrigin();
    let settled = false;

    const timeoutId = window.setTimeout(() => {
      finish(() => {
        reject(new Error('AniList sign-in timed out — close the pop-up and try again.'));
      });
    }, POPUP_SIGN_IN_TIMEOUT_MS);

    const pollId = window.setInterval(() => {
      if (popupWindow.closed) {
        finish(() => {
          if (!settled) {
            reject(new Error('AniList sign-in was cancelled (pop-up closed).'));
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
      if (!isAnilistOAuthCallbackMessage(event.data)) {
        return;
      }
      const expectedNonce = sessionStorage.getItem(OAUTH_PENDING_KEY);
      if (!expectedNonce || event.data.nonce !== expectedNonce) {
        return;
      }
      if (event.data.error) {
        finish(() => {
          reject(new Error(`AniList sign-in failed: ${event.data.error}`));
        });
        return;
      }
      if (!event.data.accessToken) {
        finish(() => {
          reject(new Error('AniList sign-in failed: no access token returned'));
        });
        return;
      }
      void registerAnilistAccountFromToken(event.data.accessToken)
        .then((account) => {
          finish(() => {
            resolve(account);
          });
        })
        .catch((err) => {
          finish(() => {
            reject(err instanceof Error ? err : new Error('AniList sign-in failed'));
          });
        });
    }

    window.addEventListener('message', onMessage);
  });
}

export async function registerAnilistAccountFromToken(
  accessToken: string,
): Promise<AnilistStoredAccount> {
  const data = await executeAnilistQuery<ViewerPayload>(VIEWER_QUERY, {}, { accessToken });
  const viewer = data?.Viewer;
  if (!viewer?.name) {
    throw new Error('AniList sign-in failed: token was rejected (Viewer query returned no user)');
  }

  const now = Date.now();
  const account: AnilistStoredAccount = {
    userId: viewer.id,
    userName: viewer.name,
    displayName: viewer.name,
    avatarUrl: viewer.avatar?.large ?? null,
    accessToken,
    expiresAt: decodeJwtExpiresAtMs(accessToken, now),
    addedAt: now,
    status: 'ok',
  };
  upsertAccount(account);
  return account;
}

/**
 * Same-window redirect when the app URL itself is registered as redirect URI.
 * The popup + hosted callback flow is preferred for local dev.
 */
export async function handleAnilistAuthRedirect(): Promise<AnilistStoredAccount | null> {
  if (typeof window === 'undefined') {
    return null;
  }
  const { accessToken, error } = parseOAuthHashParams(window.location.hash);
  if (!accessToken && !error) {
    return null;
  }

  const cleanUrl = () => {
    const returnPath = sessionStorage.getItem(RETURN_URL_KEY);
    sessionStorage.removeItem(RETURN_URL_KEY);
    const target =
      returnPath && returnPath.length > 0
        ? `${window.location.origin}${returnPath}`
        : `${window.location.origin}${window.location.pathname}`;
    window.history.replaceState(null, '', target);
  };

  if (error || !accessToken) {
    cleanUrl();
    throw new Error(`AniList sign-in failed: ${error ?? 'no access token in redirect'}`);
  }

  const account = await registerAnilistAccountFromToken(accessToken);
  cleanUrl();
  return account;
}

/** Test-only reset. */
export function _clearAnilistAccountsForTesting(): void {
  cachedStore = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(RETURN_URL_KEY);
    sessionStorage.removeItem(OAUTH_PENDING_KEY);
  } catch {
    /* ignore */
  }
}
