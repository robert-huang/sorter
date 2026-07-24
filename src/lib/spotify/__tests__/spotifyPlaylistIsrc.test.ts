import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichPlaylistTracksWithIsrc } from '../spotifyPlaylist';
import { _clearTrackIsrcStoreForTesting } from '../spotifyTrackIsrcStore';
import type { CachedPlaylistTrack } from '../spotifyPlaylist';

vi.mock('../../importers/anilist/themeSongs/spotifyIsrc', () => ({
  fetchSpotifyIsrcByTrackIds: vi.fn(async (trackIds: readonly string[]) => {
    const out = new Map<string, string>();
    for (const id of trackIds) {
      if (id === '6SrKLkuqWyKxSxzvtRWvX5') {
        out.set(id, 'JPU901001861');
      }
    }
    return out;
  }),
}));

afterEach(() => {
  _clearTrackIsrcStoreForTesting();
  vi.clearAllMocks();
});

describe('enrichPlaylistTracksWithIsrc', () => {
  it('backfills missing playlist track ISRCs from Spotify', async () => {
    const tracks: CachedPlaylistTrack[] = [
      { id: '6SrKLkuqWyKxSxzvtRWvX5', isrc: null, linkedFromIds: [] },
      { id: 'track-with-isrc', isrc: 'USRC001', linkedFromIds: [] },
    ];

    const enriched = await enrichPlaylistTracksWithIsrc(tracks, 'token');

    expect(enriched[0]?.isrc).toBe('JPU901001861');
    expect(enriched[1]?.isrc).toBe('USRC001');
  });
});
