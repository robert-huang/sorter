import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSpotifyIsrcByTrackIds } from '../../importers/anilist/themeSongs/spotifyIsrc';
import {
  PLAYLIST_ISRC_BACKFILL_BATCH_SIZE,
  _resetPlaylistIsrcBackfillForTesting,
  getPlaylistIsrcBackfillState,
  startPlaylistIsrcBackfill,
} from '../spotifyPlaylistIsrcBackfill';
import {
  PLAYLIST_CACHE_STORAGE_KEY,
  type CachedPlaylistTrack,
} from '../spotifyPlaylist';
import {
  _clearTrackIsrcStoreForTesting,
  applyTrackIsrcStoreToPlaylistTracks,
  mergeTrackIsrcsIntoStore,
} from '../spotifyTrackIsrcStore';

vi.mock('../../importers/anilist/themeSongs/spotifyIsrc', () => ({
  fetchSpotifyIsrcByTrackIds: vi.fn(async (trackIds: readonly string[]) => {
    const out = new Map<string, string>();
    for (const id of trackIds) {
      if (id === '6SrKLkuqWyKxSxzvtRWvX5') {
        out.set(id, 'JPU901001861');
      } else if (id.startsWith('missing-')) {
        out.set(id, 'USRC999');
      }
    }
    return out;
  }),
  SPOTIFY_TRACKS_BATCH_SIZE: 50,
}));

function writePlaylistCacheForTest(playlistId: string, tracks: CachedPlaylistTrack[]): void {
  localStorage.setItem(
    PLAYLIST_CACHE_STORAGE_KEY,
    JSON.stringify({ playlistId, fetchedAt: Date.now(), tracks }),
  );
}

afterEach(() => {
  _clearTrackIsrcStoreForTesting();
  _resetPlaylistIsrcBackfillForTesting();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('applyTrackIsrcStoreToPlaylistTracks', () => {
  it('applies persisted ISRCs without calling Spotify', () => {
    mergeTrackIsrcsIntoStore(new Map([['6SrKLkuqWyKxSxzvtRWvX5', 'JPU901001861']]));
    const tracks: CachedPlaylistTrack[] = [
      { id: '6SrKLkuqWyKxSxzvtRWvX5', isrc: null, linkedFromIds: [] },
      { id: 'track-with-isrc', isrc: 'USRC001', linkedFromIds: [] },
    ];

    const enriched = applyTrackIsrcStoreToPlaylistTracks(tracks);

    expect(enriched[0]?.isrc).toBe('JPU901001861');
    expect(enriched[1]?.isrc).toBe('USRC001');
  });
});

describe('startPlaylistIsrcBackfill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('backfills missing playlist ISRCs in batches of 50', async () => {
    const tracks: CachedPlaylistTrack[] = Array.from(
      { length: PLAYLIST_ISRC_BACKFILL_BATCH_SIZE + 5 },
      (_, i) => ({
        id: `missing-${i}`,
        isrc: null,
        linkedFromIds: [],
      }),
    );
    writePlaylistCacheForTest('playlist-1', tracks);

    startPlaylistIsrcBackfill('playlist-1', 'token');

    await vi.runAllTimersAsync();

    expect(fetchSpotifyIsrcByTrackIds).toHaveBeenCalledTimes(2);
    const firstBatch = vi.mocked(fetchSpotifyIsrcByTrackIds).mock.calls[0]?.[0] ?? [];
    const secondBatch = vi.mocked(fetchSpotifyIsrcByTrackIds).mock.calls[1]?.[0] ?? [];
    expect(firstBatch).toHaveLength(PLAYLIST_ISRC_BACKFILL_BATCH_SIZE);
    expect(secondBatch).toHaveLength(5);
    expect(getPlaylistIsrcBackfillState().status).toBe('idle');

    const cache = JSON.parse(localStorage.getItem(PLAYLIST_CACHE_STORAGE_KEY) ?? '{}') as {
      tracks: CachedPlaylistTrack[];
    };
    expect(cache.tracks.every((track) => track.isrc === 'USRC999')).toBe(true);
  });
});
