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
  _clearSpotifyPlaylistForTesting,
  _writePlaylistCacheForTesting,
  getPlaylistCache,
  type CachedPlaylistTrack,
} from '../spotifyPlaylist';
import {
  _setSpotifyPlaylistCachePersistenceForTesting,
  _setSpotifyTrackIsrcPersistenceForTesting,
} from '../spotifyPlaylistCacheDb';
import {
  _clearTrackIsrcStoreForTesting,
  applyTrackIsrcStoreToPlaylistTracks,
  mergeTrackIsrcsIntoStore,
} from '../spotifyTrackIsrcStore';
import {
  createPlaylistCachePersistence,
  createTrackIsrcPersistence,
} from './spotifyCachePersistenceTestUtils';

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

async function writePlaylistCacheForTest(
  playlistId: string,
  tracks: CachedPlaylistTrack[],
): Promise<void> {
  await _writePlaylistCacheForTesting({
    playlistId,
    fetchedAt: Date.now(),
    tracks,
  });
}

beforeEach(async () => {
  _setSpotifyPlaylistCachePersistenceForTesting(createPlaylistCachePersistence());
  _setSpotifyTrackIsrcPersistenceForTesting(createTrackIsrcPersistence());
  await Promise.all([
    _clearSpotifyPlaylistForTesting(),
    _clearTrackIsrcStoreForTesting(),
  ]);
});

afterEach(async () => {
  await Promise.all([
    _clearSpotifyPlaylistForTesting(),
    _clearTrackIsrcStoreForTesting(),
  ]);
  _setSpotifyPlaylistCachePersistenceForTesting(null);
  _setSpotifyTrackIsrcPersistenceForTesting(null);
  _resetPlaylistIsrcBackfillForTesting();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('applyTrackIsrcStoreToPlaylistTracks', () => {
  it('applies persisted ISRCs without calling Spotify', async () => {
    await mergeTrackIsrcsIntoStore(
      new Map([['6SrKLkuqWyKxSxzvtRWvX5', 'JPU901001861']]),
    );
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
    await writePlaylistCacheForTest('playlist-1', tracks);

    startPlaylistIsrcBackfill('playlist-1');

    await vi.runAllTimersAsync();

    expect(fetchSpotifyIsrcByTrackIds).toHaveBeenCalledTimes(2);
    const firstBatch = vi.mocked(fetchSpotifyIsrcByTrackIds).mock.calls[0]?.[0] ?? [];
    const secondBatch = vi.mocked(fetchSpotifyIsrcByTrackIds).mock.calls[1]?.[0] ?? [];
    expect(firstBatch).toHaveLength(PLAYLIST_ISRC_BACKFILL_BATCH_SIZE);
    expect(secondBatch).toHaveLength(5);
    expect(getPlaylistIsrcBackfillState().status).toBe('idle');

    expect(
      getPlaylistCache('playlist-1')?.tracks.every(
        (track) => track.isrc === 'USRC999',
      ),
    ).toBe(true);
  });

  it('automatically resumes from cached tracks after the track cooldown', async () => {
    await writePlaylistCacheForTest('playlist-1', [
      { id: 'missing-1', isrc: null, linkedFromIds: [] },
    ]);
    const now = Date.now();
    setSpotifyApiBan('tracks', now + 1_000, 'RATE_LIMITED', true, now);

    startPlaylistIsrcBackfill('playlist-1');
    await vi.advanceTimersByTimeAsync(0);

    expect(getPlaylistIsrcBackfillState().status).toBe('paused');
    expect(fetchSpotifyIsrcByTrackIds).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetchSpotifyIsrcByTrackIds).toHaveBeenCalledOnce();
    expect(fetchSpotifyIsrcByTrackIds).toHaveBeenCalledWith(['missing-1']);
    expect(getPlaylistIsrcBackfillState().status).toBe('idle');
  });
});
