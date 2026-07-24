import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_SPOTIFY_API_BAN_STORAGE_KEY,
  SPOTIFY_API_BANS_STORAGE_KEY,
  SPOTIFY_UNKNOWN_RETRY_BACKOFF_SEC,
  SpotifyApiRateLimitedError,
  _clearSpotifyApiBanForTesting,
  computeSpotifyRetryWaitMs,
  getSpotifyApiBan,
  getSpotifyApiBannedUntil,
  inferSpotifyApiScope,
  isSpotifyApiBanned,
  parseRetryAfterSeconds,
  resolveSpotifyApiRequestUrl,
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
  vi.useRealTimers();
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

describe('setSpotifyApiBan', () => {
  it('keeps the later bannedUntil within one endpoint scope', () => {
    const now = Date.now();
    setSpotifyApiBan('tracks', now + 120_000, 'RATE_LIMITED');
    setSpotifyApiBan('tracks', now + 4_500_000, 'QUOTA_EXCEEDED');

    expect(getSpotifyApiBannedUntil('tracks', now)).toBe(now + 4_500_000);
    expect(getSpotifyApiBannedUntil('playlist-list', now)).toBeNull();
  });

  it('drops the legacy global cooldown instead of applying it to every endpoint', () => {
    localStorage.setItem(
      LEGACY_SPOTIFY_API_BAN_STORAGE_KEY,
      JSON.stringify({ bannedUntil: Date.now() + 60_000 }),
    );

    expect(getSpotifyApiBan('tracks')).toBeNull();
    expect(localStorage.getItem(LEGACY_SPOTIFY_API_BAN_STORAGE_KEY)).toBeNull();
  });
});

describe('Spotify API routing', () => {
  it('infers independent endpoint scopes', () => {
    expect(inferSpotifyApiScope('https://api.spotify.com/v1/tracks/abc')).toBe('tracks');
    expect(inferSpotifyApiScope('https://api.spotify.com/v1/me/playlists')).toBe(
      'playlist-list',
    );
    expect(inferSpotifyApiScope('https://api.spotify.com/v1/playlists/abc/items')).toBe(
      'playlist-items',
    );
    expect(inferSpotifyApiScope('https://api.spotify.com/v1/me')).toBe('profile');
  });

  it('uses the configured proxy before the localhost fallback', () => {
    const proxyBase =
      import.meta.env.VITE_SPOTIFY_PROXY_URL?.replace(/\/$/, '') || '/api/spotify';
    expect(
      resolveSpotifyApiRequestUrl('https://api.spotify.com/v1/tracks/abc?market=CA'),
    ).toBe(`${proxyBase}/v1/tracks/abc?market=CA`);
  });
});

describe('spotifyApiFetch', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });

  it('blocks only the endpoint scope that received the 429', async () => {
    const bannedUntil = Date.now() + 60_000;
    setSpotifyApiBan('tracks', bannedUntil, 'QUOTA_EXCEEDED');

    await expect(spotifyApiFetch('https://api.spotify.com/v1/tracks/x', 'token')).rejects.toBeInstanceOf(
      SpotifyApiRateLimitedError,
    );
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { items: [] }));
    await expect(
      spotifyApiFetch('https://api.spotify.com/v1/me/playlists', 'token'),
    ).resolves.toHaveProperty('status', 200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps playlist listing and playlist items cooldowns independent', async () => {
    setSpotifyApiBan('playlist-list', Date.now() + 60_000, 'RATE_LIMITED');
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { items: [] }));

    await expect(
      spotifyApiFetch('https://api.spotify.com/v1/me/playlists', 'token'),
    ).rejects.toBeInstanceOf(SpotifyApiRateLimitedError);
    await expect(
      spotifyApiFetch('https://api.spotify.com/v1/playlists/abc/items', 'token'),
    ).resolves.toHaveProperty('status', 200);
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

    expect(isSpotifyApiBanned('tracks')).toBe(true);
    expect(getSpotifyApiBannedUntil('tracks')).toBeGreaterThan(Date.now());
    expect(isSpotifyApiBanned('playlist-list')).toBe(false);
  });

  it('uses a marked local backoff when Retry-After is unavailable', async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(429, {
        error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' },
      }),
    );

    await expect(
      spotifyApiFetch('https://api.spotify.com/v1/tracks/x', 'token'),
    ).rejects.toBeInstanceOf(SpotifyApiRateLimitedError);

    expect(getSpotifyApiBan('tracks', now)).toEqual({
      scope: 'tracks',
      bannedUntil: now + SPOTIFY_UNKNOWN_RETRY_BACKOFF_SEC * 1000,
      reason: 'QUOTA_EXCEEDED',
      retryAfterKnown: false,
    });
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
  });

  it('sets a short ban when short 429 retries are exhausted', async () => {
    vi.useFakeTimers();
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(429, { error: { message: 'slow down' } }, { 'Retry-After': '3' }),
      )
      .mockResolvedValueOnce(
        jsonResponse(429, { error: { message: 'slow down' } }, { 'Retry-After': '3' }),
      )
      .mockResolvedValueOnce(
        jsonResponse(429, { error: { message: 'slow down' } }, { 'Retry-After': '3' }),
      );

    const promise = spotifyApiFetch('https://api.spotify.com/v1/tracks/x', 'token');
    const expectation = expect(promise).rejects.toBeInstanceOf(SpotifyApiRateLimitedError);
    await vi.runAllTimersAsync();
    await expectation;
    const bannedUntil = getSpotifyApiBannedUntil('tracks');
    expect(bannedUntil).not.toBeNull();
    const remainingSec = Math.ceil((bannedUntil! - Date.now()) / 1000);
    expect(remainingSec).toBe(3);
  });

  it('does not retry when Retry-After exceeds the short window', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(429, { error: { message: 'Too many requests' } }, { 'Retry-After': '500' }),
    );

    await expect(
      spotifyApiFetch('https://api.spotify.com/v1/tracks/x', 'token'),
    ).rejects.toBeInstanceOf(SpotifyApiRateLimitedError);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(SPOTIFY_API_BANS_STORAGE_KEY)).not.toBeNull();
    expect(getSpotifyApiBan('tracks')?.retryAfterKnown).toBe(true);
  });
});
