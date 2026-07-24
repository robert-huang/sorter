import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSpotifyIsrcByTrackIds, SPOTIFY_TRACKS_BATCH_SIZE } from '../../importers/anilist/themeSongs/spotifyIsrc';
import { spotifyApiFetch } from '../spotifyApi';
import { _clearTrackIsrcStoreForTesting, mergeTrackIsrcsIntoStore } from '../spotifyTrackIsrcStore';

vi.mock('../spotifyApi', () => ({
  isSpotifyApiBanned: vi.fn(() => false),
  spotifyApiFetch: vi.fn(),
  SpotifyApiRateLimitedError: class SpotifyApiRateLimitedError extends Error {},
}));

vi.mock('../spotifyAuth', () => ({
  ensureSpotifyAccessToken: vi.fn(async () => 'token'),
}));

afterEach(() => {
  _clearTrackIsrcStoreForTesting();
  vi.clearAllMocks();
});

describe('fetchSpotifyIsrcByTrackIds batching', () => {
  beforeEach(() => {
    vi.mocked(spotifyApiFetch).mockImplementation(async (url: string) => {
      const ids = new URL(url).searchParams.get('ids')?.split(',') ?? [];
      return {
        ok: true,
        json: async () => ({
          tracks: ids.map((id) => ({
            id,
            external_ids: { isrc: `ISRC-${id}` },
          })),
        }),
      } as Response;
    });
  });

  it('requests up to 50 track IDs per batch call', async () => {
    const trackIds = Array.from({ length: SPOTIFY_TRACKS_BATCH_SIZE + 10 }, (_, i) => `track-${i}`);

    const result = await fetchSpotifyIsrcByTrackIds(trackIds, 'token');

    expect(spotifyApiFetch).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(SPOTIFY_TRACKS_BATCH_SIZE + 10);
    expect(result.get('track-0')).toBe('ISRC-track-0');
    expect(result.get(`track-${SPOTIFY_TRACKS_BATCH_SIZE}`)).toBe(`ISRC-track-${SPOTIFY_TRACKS_BATCH_SIZE}`);
  });

  it('skips API calls for IDs already in the local store', async () => {
    mergeTrackIsrcsIntoStore(new Map([['cached-track', 'USRC111']]));

    const result = await fetchSpotifyIsrcByTrackIds(['cached-track', 'new-track'], 'token');

    expect(spotifyApiFetch).toHaveBeenCalledTimes(1);
    expect(result.get('cached-track')).toBe('USRC111');
    expect(result.get('new-track')).toBe('ISRC-new-track');
  });

  it('falls back to per-track requests when a batch call fails', async () => {
    vi.mocked(spotifyApiFetch).mockImplementation(async (url: string) => {
      if (url.includes('/tracks?ids=')) {
        return { ok: false, status: 404 } as Response;
      }
      const trackId = url.split('/tracks/')[1] ?? '';
      return {
        ok: true,
        json: async () => ({
          id: trackId,
          external_ids: { isrc: `SINGLE-${trackId}` },
        }),
      } as Response;
    });

    const result = await fetchSpotifyIsrcByTrackIds(['a', 'b'], 'token');

    expect(result.get('a')).toBe('SINGLE-a');
    expect(result.get('b')).toBe('SINGLE-b');
    expect(spotifyApiFetch).toHaveBeenCalledTimes(3);
  });
});
