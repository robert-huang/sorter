import { describe, expect, it } from 'vitest';
import {
  decodeSpotifyOAuthState,
  encodeSpotifyOAuthState,
  isSpotifyOAuthCallbackMessage,
} from '../spotifyAuth';

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
});
