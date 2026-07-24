import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSpotifyIsrcByTrackIds } from '../../importers/anilist/themeSongs/spotifyIsrc';
import {
  PLAYLIST_ISRC_BACKFILL_BATCH_SIZE,
  _resetPlaylistIsrcBackfillForTesting,
  getPlaylistIsrcBackfillState,
  startPlaylistIsrcBackfill,
} from '../spotifyPlaylistIsrcBackfill';
import { setSpotifyApiBan } from '../spotifyApi';
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
}));

function writePlaylistCacheForTest(playlistId: string, tracks: CachedPlaylistTrack[]): void {
  localStorage.setItem(
    PLAYLIST_CACHE_STORAGE_KEY,
    JSON.stringify({
      [playlistId]: { playlistId, fetchedAt: Date.now(), tracks },
    }),
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

  it('backfills missing playlist ISRCs in small chunks', async () => {
    const tracks: CachedPlaylistTrack[] = Array.from(
      { length: PLAYLIST_ISRC_BACKFILL_BATCH_SIZE + 5 },
      (_, i) => ({
        id: `missing-${i}`,
        isrc: null,
        linkedFromIds: [],
      }),
    );
    writePlaylistCacheForTest('playlist-1', tracks);

    startPlaylistIsrcBackfill('playlist-1');

    await vi.runAllTimersAsync();

    expect(fetchSpotifyIsrcByTrackIds).toHaveBeenCalledTimes(2);
    const firstBatch = vi.mocked(fetchSpotifyIsrcByTrackIds).mock.calls[0]?.[0] ?? [];
    const secondBatch = vi.mocked(fetchSpotifyIsrcByTrackIds).mock.calls[1]?.[0] ?? [];
    expect(firstBatch).toHaveLength(PLAYLIST_ISRC_BACKFILL_BATCH_SIZE);
    expect(secondBatch).toHaveLength(5);
    expect(getPlaylistIsrcBackfillState().status).toBe('idle');

    const store = JSON.parse(localStorage.getItem(PLAYLIST_CACHE_STORAGE_KEY) ?? '{}') as {
      'playlist-1'?: { tracks: CachedPlaylistTrack[] };
    };
    expect(store['playlist-1']?.tracks.every((track) => track.isrc === 'USRC999')).toBe(true);
  });

  it('automatically resumes from cached tracks after the track cooldown', async () => {
    writePlaylistCacheForTest('playlist-1', [
      { id: 'missing-1', isrc: null, linkedFromIds: [] },
    ]);
    const now = Date.now();
    setSpotifyApiBan('tracks', now + 1_000, 'RATE_LIMITED', true, now);

    startPlaylistIsrcBackfill('playlist-1');

    expect(getPlaylistIsrcBackfillState().status).toBe('paused');
    expect(fetchSpotifyIsrcByTrackIds).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetchSpotifyIsrcByTrackIds).toHaveBeenCalledOnce();
    expect(fetchSpotifyIsrcByTrackIds).toHaveBeenCalledWith(['missing-1']);
    expect(getPlaylistIsrcBackfillState().status).toBe('idle');
  });
});
