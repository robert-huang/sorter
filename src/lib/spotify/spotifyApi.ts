/**
 * Spotify Web API fetch with short-window retries and endpoint-scoped cooldowns.
 */

export const SPOTIFY_API_BANS_STORAGE_KEY = 'spotify:api-bans:v2';
export const LEGACY_SPOTIFY_API_BAN_STORAGE_KEY = 'spotify:api-ban:v1';

/** Max automatic retries after a short 429 (not counting the first attempt). */
export const SPOTIFY_API_MAX_RETRIES = 2;

/** Only honor Retry-After at or below this — larger values trip the breaker. */
export const SPOTIFY_API_MAX_RETRY_AFTER_SEC = 120;

/**
 * Local backoff when Retry-After is unavailable. This is explicitly our retry
 * delay, not an estimate of Spotify's actual cooldown.
 */
export const SPOTIFY_UNKNOWN_RETRY_BACKOFF_SEC = 60;

/** Default wait when a short 429 has no Retry-After (seconds). */
const SPOTIFY_DEFAULT_RETRY_AFTER_SEC = 5;
const SPOTIFY_API_ORIGIN = 'https://api.spotify.com';
const SPOTIFY_API_BASE = `${SPOTIFY_API_ORIGIN}/v1`;
const ENV = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env) ?? {};

export type SpotifyApiScope = 'tracks' | 'playlist-list' | 'playlist-items' | 'profile';

type SpotifyApiErrorBody = {
  error?: {
    status?: number;
    message?: string;
    reason?: string;
  };
};

export type SpotifyApiBan = {
  scope: SpotifyApiScope;
  bannedUntil: number;
  reason?: string | null;
  /** True only when this deadline came from Spotify's Retry-After header. */
  retryAfterKnown: boolean;
};

export class SpotifyApiRateLimitedError extends Error {
  readonly scope: SpotifyApiScope;
  readonly bannedUntil: number;
  readonly retryAfterSec: number | null;
  readonly retryAfterKnown: boolean;

  constructor(
    message: string,
    scope: SpotifyApiScope,
    bannedUntil: number,
    retryAfterSec: number | null,
    retryAfterKnown: boolean,
  ) {
    super(message);
    this.name = 'SpotifyApiRateLimitedError';
    this.scope = scope;
    this.bannedUntil = bannedUntil;
    this.retryAfterSec = retryAfterSec;
    this.retryAfterKnown = retryAfterKnown;
  }
}

type StoredBans = Partial<Record<SpotifyApiScope, Omit<SpotifyApiBan, 'scope'>>>;

function readStoredBans(): StoredBans {
  try {
    // A global v1 cooldown cannot be safely assigned to any endpoint family.
    localStorage.removeItem(LEGACY_SPOTIFY_API_BAN_STORAGE_KEY);
    const raw = localStorage.getItem(SPOTIFY_API_BANS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as StoredBans;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function writeStoredBans(bans: StoredBans): void {
  try {
    if (Object.keys(bans).length === 0) {
      localStorage.removeItem(SPOTIFY_API_BANS_STORAGE_KEY);
      return;
    }
    localStorage.setItem(SPOTIFY_API_BANS_STORAGE_KEY, JSON.stringify(bans));
  } catch {
    /* ignore quota */
  }
}

export function getSpotifyApiBan(
  scope: SpotifyApiScope,
  now = Date.now(),
): SpotifyApiBan | null {
  const bans = readStoredBans();
  const ban = bans[scope];
  if (!ban || typeof ban.bannedUntil !== 'number' || ban.bannedUntil <= now) {
    if (ban) {
      delete bans[scope];
      writeStoredBans(bans);
    }
    return null;
  }
  return {
    scope,
    bannedUntil: ban.bannedUntil,
    reason: ban.reason ?? null,
    retryAfterKnown: ban.retryAfterKnown === true,
  };
}

/** Milliseconds until this endpoint family can be retried, or null when clear. */
export function getSpotifyApiBannedUntil(
  scope: SpotifyApiScope,
  now = Date.now(),
): number | null {
  return getSpotifyApiBan(scope, now)?.bannedUntil ?? null;
}

export function isSpotifyApiBanned(scope: SpotifyApiScope, now = Date.now()): boolean {
  return getSpotifyApiBan(scope, now) !== null;
}

/** Persist a cooldown, keeping the later deadline for this endpoint family. */
export function setSpotifyApiBan(
  scope: SpotifyApiScope,
  bannedUntil: number,
  reason?: string | null,
  retryAfterKnown = true,
  now = Date.now(),
): SpotifyApiBan {
  const bans = readStoredBans();
  const existing = bans[scope];
  const activeExisting =
    existing && existing.bannedUntil > now ? existing.bannedUntil : 0;
  const keepExisting = activeExisting >= bannedUntil;
  const merged: Omit<SpotifyApiBan, 'scope'> = {
    bannedUntil: Math.max(bannedUntil, activeExisting),
    reason: keepExisting ? existing?.reason ?? null : reason ?? null,
    retryAfterKnown: keepExisting
      ? existing?.retryAfterKnown === true
      : retryAfterKnown,
  };
  bans[scope] = merged;
  writeStoredBans(bans);
  return {
    scope,
    ...merged,
  };
}

function setBanFromRetryAfter(
  scope: SpotifyApiScope,
  retryAfterSec: number | null,
  reason?: string | null,
  now = Date.now(),
): SpotifyApiBan {
  const retryAfterKnown = retryAfterSec !== null;
  const waitSec = retryAfterSec ?? SPOTIFY_UNKNOWN_RETRY_BACKOFF_SEC;
  return setSpotifyApiBan(
    scope,
    now + waitSec * 1000,
    reason,
    retryAfterKnown,
    now,
  );
}

export function clearSpotifyApiBans(): void {
  try {
    localStorage.removeItem(SPOTIFY_API_BANS_STORAGE_KEY);
    localStorage.removeItem(LEGACY_SPOTIFY_API_BAN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function inferSpotifyApiScope(url: string): SpotifyApiScope {
  const pathname = new URL(url, SPOTIFY_API_BASE).pathname;
  if (/\/v1\/tracks\//.test(pathname)) {
    return 'tracks';
  }
  if (pathname === '/v1/me/playlists') {
    return 'playlist-list';
  }
  if (/\/v1\/playlists\/[^/]+\/items$/.test(pathname)) {
    return 'playlist-items';
  }
  return 'profile';
}

function isLocalSpotifyProxyAvailable(): boolean {
  if (ENV.DEV === 'true') {
    return true;
  }
  if (typeof window === 'undefined') {
    return false;
  }
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

/** Route Spotify Web API URLs through the configured proxy when available. */
export function resolveSpotifyApiRequestUrl(url: string): string {
  const parsed = new URL(url, SPOTIFY_API_BASE);
  if (parsed.origin !== SPOTIFY_API_ORIGIN) {
    return url;
  }

  const configuredProxy = ENV.VITE_SPOTIFY_PROXY_URL?.trim().replace(/\/$/, '');
  const proxyBase = configuredProxy || (isLocalSpotifyProxyAvailable() ? '/api/spotify' : '');
  if (!proxyBase) {
    return url;
  }
  return `${proxyBase}${parsed.pathname}${parsed.search}`;
}

export function formatSpotifyApiBanMessage(bannedUntil: number, now = Date.now()): string {
  const remainingMs = Math.max(0, bannedUntil - now);
  const remainingSec = Math.ceil(remainingMs / 1000);
  if (remainingSec >= 7200) {
    const hours = Math.ceil(remainingSec / 3600);
    return `Spotify API quota exceeded — try again in about ${hours} hour${hours === 1 ? '' : 's'}.`;
  }
  if (remainingSec >= 120) {
    const remainingMin = Math.ceil(remainingSec / 60);
    return `Spotify API rate limited — try again in about ${remainingMin} minute${remainingMin === 1 ? '' : 's'}.`;
  }
  return `Spotify API rate limited — try again in ${remainingSec}s.`;
}

/** Test-only reset. */
export function _clearSpotifyApiBanForTesting(): void {
  clearSpotifyApiBans();
}

export function parseRetryAfterSeconds(header: string | null): number | null {
  if (header === null) {
    return null;
  }
  const seconds = Number.parseInt(header, 10);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return seconds;
}

function isExtendedSpotifyBan(
  retryAfterSec: number | null,
  body: SpotifyApiErrorBody,
): boolean {
  if (body.error?.reason === 'QUOTA_EXCEEDED') {
    return true;
  }
  if (retryAfterSec !== null && retryAfterSec > SPOTIFY_API_MAX_RETRY_AFTER_SEC) {
    return true;
  }
  return false;
}

/** Base wait + up to 25% jitter so parallel workers do not retry in sync. */
export function computeSpotifyRetryWaitMs(retryAfterSec: number, random = Math.random): number {
  const baseMs = (retryAfterSec + 1) * 1000;
  const jitter = Math.floor(baseMs * 0.25 * random());
  return baseMs + jitter;
}

async function parseErrorBody(res: Response): Promise<SpotifyApiErrorBody> {
  try {
    return (await res.json()) as SpotifyApiErrorBody;
  } catch {
    return {};
  }
}

function buildRateLimitError(
  body: SpotifyApiErrorBody,
  ban: SpotifyApiBan,
  retryAfterSec: number | null,
): SpotifyApiRateLimitedError {
  const detail = body.error?.message ?? 'Too many requests';
  return new SpotifyApiRateLimitedError(
    `Spotify API rate limited: ${detail}`,
    ban.scope,
    ban.bannedUntil,
    retryAfterSec,
    ban.retryAfterKnown,
  );
}

/**
 * Authenticated Spotify API fetch. Throws {@link SpotifyApiRateLimitedError} when
 * quota-blocked or when retries are exhausted on a short 429.
 */
export async function spotifyApiFetch(
  url: string,
  accessToken: string,
  init?: RequestInit,
): Promise<Response> {
  const scope = inferSpotifyApiScope(url);
  const activeBan = getSpotifyApiBan(scope);
  if (activeBan) {
    throw buildRateLimitError({}, activeBan, null);
  }

  let attempt = 0;
  while (true) {
    const res = await fetch(resolveSpotifyApiRequestUrl(url), {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (res.status !== 429) {
      return res;
    }

    const body = await parseErrorBody(res);
    const retryAfterSec = parseRetryAfterSeconds(res.headers.get('Retry-After'));

    if (isExtendedSpotifyBan(retryAfterSec, body)) {
      const ban = setBanFromRetryAfter(
        scope,
        retryAfterSec,
        body.error?.reason ?? 'QUOTA_EXCEEDED',
      );
      throw buildRateLimitError(body, ban, retryAfterSec);
    }

    if (attempt >= SPOTIFY_API_MAX_RETRIES) {
      const ban = setBanFromRetryAfter(
        scope,
        retryAfterSec,
        body.error?.reason ?? 'RATE_LIMITED',
      );
      throw buildRateLimitError(body, ban, retryAfterSec);
    }

    const waitSec = retryAfterSec ?? SPOTIFY_DEFAULT_RETRY_AFTER_SEC;
    await delay(computeSpotifyRetryWaitMs(waitSec));
    attempt += 1;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
