import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SPOTIFY_AUTH_STORAGE_KEY,
  SPOTIFY_SCOPES,
  _clearSpotifyAuthForTesting,
  decodeSpotifyOAuthState,
  encodeSpotifyOAuthState,
  ensureSpotifyAccountCountry,
  getStoredSpotifyAuth,
  isSpotifyOAuthCallbackMessage,
} from '../spotifyAuth';
import { spotifyApiFetch } from '../spotifyApi';

vi.mock('../spotifyApi', () => ({
  clearSpotifyApiBans: vi.fn(),
  spotifyApiFetch: vi.fn(),
}));

afterEach(() => {
  _clearSpotifyAuthForTesting();
  vi.clearAllMocks();
});

describe('spotifyAuth helpers', () => {
  it('round-trips oauth state', () => {
    const state = { origin: 'http://localhost:5173', nonce: 'abc123' };
    const encoded = encodeSpotifyOAuthState(state);
    expect(decodeSpotifyOAuthState(encoded)).toEqual(state);
  });

  it('recognizes callback messages', () => {
    expect(
      isSpotifyOAuthCallbackMessage({
        type: 'spotify-oauth-callback',
        code: 'x',
        error: null,
        nonce: 'n',
      }),
    ).toBe(true);
    expect(isSpotifyOAuthCallbackMessage({ type: 'other' })).toBe(false);
  });

  it('hydrates and stores the account country for legacy auth state', async () => {
    localStorage.setItem(
      SPOTIFY_AUTH_STORAGE_KEY,
      JSON.stringify({
        accessToken: 'token',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 60_000,
        displayName: 'Robert',
        spotifyUserId: 'user',
        scope: SPOTIFY_SCOPES,
      }),
    );
    vi.mocked(spotifyApiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'user',
        display_name: 'Robert',
        country: 'ca',
      }),
    } as Response);

    await expect(ensureSpotifyAccountCountry('token')).resolves.toBe('CA');
    expect(getStoredSpotifyAuth()?.country).toBe('CA');
  });

  it.each([
    ['no recorded scope', undefined],
    ['read-only scope', 'playlist-read-private playlist-read-collaborative user-read-private'],
  ])('signs out a sign-in with %s so the user re-authorizes for playlist edits', (_, scope) => {
    localStorage.setItem(
      SPOTIFY_AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: 'token', refreshToken: 'r', expiresAt: Date.now() + 60_000, scope }),
    );
    localStorage.setItem('spotify:playlist:v1', '{"id":"pl"}');

    expect(getStoredSpotifyAuth()).toBeNull();
    expect(localStorage.getItem(SPOTIFY_AUTH_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('spotify:playlist:v1')).toBe('{"id":"pl"}');
  });

  it('keeps a sign-in that has every scope', () => {
    localStorage.setItem(
      SPOTIFY_AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: 'token', expiresAt: Date.now() + 60_000, scope: SPOTIFY_SCOPES }),
    );
    expect(getStoredSpotifyAuth()?.scope).toBe(SPOTIFY_SCOPES);
  });
});
