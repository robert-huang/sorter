import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SPOTIFY_API_BAN_STORAGE_KEY,
  SpotifyApiRateLimitedError,
  _clearSpotifyApiBanForTesting,
  computeSpotifyRetryWaitMs,
  getSpotifyApiBannedUntil,
  isSpotifyApiBanned,
  parseRetryAfterSeconds,
  setSpotifyApiBan,
  spotifyApiFetch,
} from '../spotifyApi';

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

afterEach(() => {
  _clearSpotifyApiBanForTesting();
  vi.restoreAllMocks();
});

describe('parseRetryAfterSeconds', () => {
  it('parses integer seconds', () => {
    expect(parseRetryAfterSeconds('30')).toBe(30);
  });

  it('returns null for invalid values', () => {
    expect(parseRetryAfterSeconds('nope')).toBeNull();
    expect(parseRetryAfterSeconds(null)).toBeNull();
  });
});

describe('computeSpotifyRetryWaitMs', () => {
  it('adds one second padding and jitter', () => {
    expect(computeSpotifyRetryWaitMs(5, () => 0)).toBe(6000);
    expect(computeSpotifyRetryWaitMs(5, () => 1)).toBe(7500);
  });
});

describe('spotifyApiFetch', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });

  it('short-circuits when a ban is active', async () => {
    const bannedUntil = Date.now() + 60_000;
    setSpotifyApiBan(bannedUntil, 'QUOTA_EXCEEDED');

    await expect(spotifyApiFetch('https://api.spotify.com/v1/tracks/x', 'token')).rejects.toBeInstanceOf(
      SpotifyApiRateLimitedError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sets a circuit breaker on QUOTA_EXCEEDED', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        429,
        { error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } },
        { 'Retry-After': '3600' },
      ),
    );

    await expect(
      spotifyApiFetch('https://api.spotify.com/v1/tracks/x', 'token'),
    ).rejects.toBeInstanceOf(SpotifyApiRateLimitedError);

    expect(isSpotifyApiBanned()).toBe(true);
    expect(getSpotifyApiBannedUntil()).toBeGreaterThan(Date.now());
  });

  it('retries a short 429 then succeeds', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(429, { error: { message: 'slow down' } }, { 'Retry-After': '2' }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ok' }));

    const promise = spotifyApiFetch('https://api.spotify.com/v1/tracks/x', 'token');
    await vi.advanceTimersByTimeAsync(4000);
    const res = await promise;

    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not retry when Retry-After exceeds the short window', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(429, { error: { message: 'Too many requests' } }, { 'Retry-After': '500' }),
    );

    await expect(
      spotifyApiFetch('https://api.spotify.com/v1/tracks/x', 'token'),
    ).rejects.toBeInstanceOf(SpotifyApiRateLimitedError);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(SPOTIFY_API_BAN_STORAGE_KEY)).not.toBeNull();
  });
});
