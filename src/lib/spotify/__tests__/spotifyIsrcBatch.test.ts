import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSpotifyIsrcByTrackIds } from '../../importers/anilist/themeSongs/spotifyIsrc';
import { spotifyApiFetch } from '../spotifyApi';
import { _setSpotifyTrackIsrcPersistenceForTesting } from '../spotifyPlaylistCacheDb';
import {
  TRACK_ISRC_STORAGE_KEY,
  _clearTrackIsrcStoreForTesting,
  getCachedTrackIsrc,
  hydrateTrackIsrcStore,
  mergeTrackIsrcsIntoStore,
} from '../spotifyTrackIsrcStore';
import { createTrackIsrcPersistence } from './spotifyCachePersistenceTestUtils';

vi.mock('../spotifyApi', () => ({
  isSpotifyApiBanned: vi.fn(() => false),
  spotifyApiFetch: vi.fn(),
  SpotifyApiRateLimitedError: class SpotifyApiRateLimitedError extends Error {},
}));

vi.mock('../spotifyAuth', () => ({
  ensureSpotifyAccessToken: vi.fn(async () => 'token'),
}));

afterEach(async () => {
  await _clearTrackIsrcStoreForTesting();
  _setSpotifyTrackIsrcPersistenceForTesting(null);
  vi.clearAllMocks();
});

describe('fetchSpotifyIsrcByTrackIds', () => {
  let trackPersistence: ReturnType<typeof createTrackIsrcPersistence>;

  beforeEach(async () => {
    trackPersistence = createTrackIsrcPersistence();
    _setSpotifyTrackIsrcPersistenceForTesting(trackPersistence);
    await _clearTrackIsrcStoreForTesting();
    vi.mocked(spotifyApiFetch).mockImplementation(async (url: string) => {
      const trackId = url.split('/tracks/')[1]?.split('?')[0] ?? '';
      return {
        ok: true,
        json: async () => ({
          id: trackId,
          external_ids: { isrc: `ISRC-${trackId}` },
        }),
      } as Response;
    });
  });

  it('fetches each uncached track via GET /tracks/{id}', async () => {
    const result = await fetchSpotifyIsrcByTrackIds(['track-a', 'track-b'], 'token');

    expect(spotifyApiFetch).toHaveBeenCalledTimes(2);
    expect(spotifyApiFetch).toHaveBeenCalledWith(
      'https://api.spotify.com/v1/tracks/track-a',
      'token',
    );
    expect(spotifyApiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/tracks?ids='),
      expect.anything(),
    );
    expect(result.get('track-a')).toBe('ISRC-track-a');
    expect(result.get('track-b')).toBe('ISRC-track-b');
  });

  it('skips API calls for IDs already in the local store', async () => {
    await mergeTrackIsrcsIntoStore(new Map([['cached-track', 'USRC111']]));

    const result = await fetchSpotifyIsrcByTrackIds(['cached-track', 'new-track'], 'token');

    expect(spotifyApiFetch).toHaveBeenCalledTimes(1);
    expect(result.get('cached-track')).toBe('USRC111');
    expect(result.get('new-track')).toBe('ISRC-new-track');
  });

  it('migrates the legacy localStorage ISRC map into durable storage', async () => {
    localStorage.setItem(
      TRACK_ISRC_STORAGE_KEY,
      JSON.stringify({ 'cached-track': 'USRC111' }),
    );

    await hydrateTrackIsrcStore();

    expect(getCachedTrackIsrc('cached-track')).toBe('USRC111');
    expect(trackPersistence.snapshot()).toEqual([
      { trackId: 'cached-track', isrc: 'USRC111' },
    ]);
    expect(localStorage.getItem(TRACK_ISRC_STORAGE_KEY)).toBeNull();
  });
});
