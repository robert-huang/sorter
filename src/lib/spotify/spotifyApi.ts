/**
 * Spotify Web API fetch with short-window 429 retries and a circuit breaker
 * for extended quota bans (QUOTA_EXCEEDED / large Retry-After).
 */

export const SPOTIFY_API_BAN_STORAGE_KEY = 'spotify:api-ban:v1';

/** Max automatic retries after a short 429 (not counting the first attempt). */
export const SPOTIFY_API_MAX_RETRIES = 2;

/** Only honor Retry-After at or below this — larger values trip the breaker. */
export const SPOTIFY_API_MAX_RETRY_AFTER_SEC = 120;

/** Default wait when Spotify 429s without Retry-After (seconds). */
const SPOTIFY_DEFAULT_RETRY_AFTER_SEC = 5;

type SpotifyApiErrorBody = {
  error?: {
    status?: number;
    message?: string;
    reason?: string;
  };
};

type StoredBan = {
  bannedUntil: number;
  reason?: string | null;
};

export class SpotifyApiRateLimitedError extends Error {
  readonly bannedUntil: number;
  readonly retryAfterSec: number | null;

  constructor(message: string, bannedUntil: number, retryAfterSec: number | null) {
    super(message);
    this.name = 'SpotifyApiRateLimitedError';
    this.bannedUntil = bannedUntil;
    this.retryAfterSec = retryAfterSec;
  }
}

function readStoredBan(): StoredBan | null {
  try {
    const raw = localStorage.getItem(SPOTIFY_API_BAN_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredBan>;
    if (typeof parsed.bannedUntil !== 'number') {
      return null;
    }
    return {
      bannedUntil: parsed.bannedUntil,
      reason: parsed.reason ?? null,
    };
  } catch {
    return null;
  }
}

function writeStoredBan(ban: StoredBan | null): void {
  try {
    if (!ban) {
      localStorage.removeItem(SPOTIFY_API_BAN_STORAGE_KEY);
      return;
    }
    localStorage.setItem(SPOTIFY_API_BAN_STORAGE_KEY, JSON.stringify(ban));
  } catch {
    /* ignore quota */
  }
}

/** Milliseconds until the Spotify API ban lifts, or null when not banned. */
export function getSpotifyApiBannedUntil(now = Date.now()): number | null {
  const ban = readStoredBan();
  if (!ban || ban.bannedUntil <= now) {
    if (ban) {
      writeStoredBan(null);
    }
    return null;
  }
  return ban.bannedUntil;
}

export function isSpotifyApiBanned(now = Date.now()): boolean {
  return getSpotifyApiBannedUntil(now) !== null;
}

export function setSpotifyApiBan(bannedUntil: number, reason?: string | null): void {
  writeStoredBan({ bannedUntil, reason: reason ?? null });
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

export function clearSpotifyApiBan(): void {
  writeStoredBan(null);
}

/** Test-only reset. */
export function _clearSpotifyApiBanForTesting(): void {
  clearSpotifyApiBan();
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
  bannedUntil: number,
  retryAfterSec: number | null,
): SpotifyApiRateLimitedError {
  const detail = body.error?.message ?? 'Too many requests';
  return new SpotifyApiRateLimitedError(
    `Spotify API rate limited: ${detail}`,
    bannedUntil,
    retryAfterSec,
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
  const bannedUntil = getSpotifyApiBannedUntil();
  if (bannedUntil !== null) {
    throw buildRateLimitError({}, bannedUntil, null);
  }

  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
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
      const banUntil =
        Date.now() + (retryAfterSec ?? SPOTIFY_API_MAX_RETRY_AFTER_SEC) * 1000;
      setSpotifyApiBan(banUntil, body.error?.reason ?? 'QUOTA_EXCEEDED');
      throw buildRateLimitError(body, banUntil, retryAfterSec);
    }

    if (attempt >= SPOTIFY_API_MAX_RETRIES) {
      throw new Error(
        `Spotify API 429${body.error?.message ? `: ${body.error.message}` : ''}: ${url}`,
      );
    }

    const waitSec = retryAfterSec ?? SPOTIFY_DEFAULT_RETRY_AFTER_SEC;
    await delay(computeSpotifyRetryWaitMs(waitSec));
    attempt += 1;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
