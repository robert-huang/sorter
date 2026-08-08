import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLAYLIST_CACHE_METADATA_VERSION,
  _clearSpotifyPlaylistForTesting,
  _writePlaylistCacheForTesting,
  clearNonSelectedSpotifyPlaylistCaches,
  getPlaylistCache,
  refreshPlaylistCache,
  setSelectedSpotifyPlaylist,
  type SpotifyPlaylistCache,
} from '../spotifyPlaylist';
import { spotifyApiFetch } from '../spotifyApi';
import { _setSpotifyPlaylistCachePersistenceForTesting } from '../spotifyPlaylistCacheDb';
import { createPlaylistCachePersistence } from './spotifyCachePersistenceTestUtils';

vi.mock('../spotifyApi', () => ({
  spotifyApiFetch: vi.fn(),
}));

vi.mock('../spotifyAuth', () => ({
  ensureSpotifyAccessToken: vi.fn(async () => 'access-token'),
  getStoredSpotifyAuth: vi.fn(() => ({ spotifyUserId: 'spotify-user' })),
}));

vi.mock('../spotifyTrackIsrcStore', () => ({
  hydrateTrackIsrcStore: vi.fn(async () => {}),
  applyTrackIsrcStoreToPlaylistTracks: vi.fn((tracks) => tracks),
}));

vi.mock('../spotifyPlaylistIsrcBackfill', () => ({
  startPlaylistIsrcBackfill: vi.fn(),
}));

const FRESH_CACHE: SpotifyPlaylistCache = {
  playlistId: 'playlist-1',
  fetchedAt: Date.now(),
  tracks: [{ id: 'cached-track', isrc: 'USRC001', linkedFromIds: [] }],
  localTracks: [],
  metadataVersion: PLAYLIST_CACHE_METADATA_VERSION,
  playlistItemsFetched: 1,
  trackTotal: 1,
  paginationComplete: true,
};

function mockLivePlaylistTrack(trackId: string): void {
  vi.mocked(spotifyApiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        total: 1,
        items: [
          {
            item: {
              id: trackId,
              type: 'track',
              name: 'Live track',
              artists: [{ name: 'Artist' }],
              album: { name: 'Album' },
              duration_ms: 90_000,
              external_ids: { isrc: 'USRC002' },
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
}

beforeEach(async () => {
  _setSpotifyPlaylistCachePersistenceForTesting(
    createPlaylistCachePersistence(),
  );
  await _clearSpotifyPlaylistForTesting();
  vi.mocked(spotifyApiFetch).mockReset();
});

afterEach(async () => {
  await _clearSpotifyPlaylistForTesting();
  _setSpotifyPlaylistCachePersistenceForTesting(null);
  vi.clearAllMocks();
});

describe('Spotify playlist cache refresh behavior', () => {
  it('reuses a fresh selected cache unless force refresh is requested', async () => {
    await _writePlaylistCacheForTesting(FRESH_CACHE);
    setSelectedSpotifyPlaylist({ id: 'playlist-1', name: 'Anime OPs' });
    mockLivePlaylistTrack('live-track');

    const reused = await refreshPlaylistCache();
    const refreshed = await refreshPlaylistCache({ force: true });

    expect(reused?.tracks[0]?.id).toBe('cached-track');
    expect(refreshed?.tracks[0]?.id).toBe('live-track');
    expect(spotifyApiFetch).toHaveBeenCalledOnce();
  });

  it('performs the normal live cache-miss refetch after non-selected cleanup', async () => {
    await _writePlaylistCacheForTesting(FRESH_CACHE);
    await _writePlaylistCacheForTesting({
      ...FRESH_CACHE,
      playlistId: 'playlist-2',
      tracks: [{ id: 'old-track', isrc: null, linkedFromIds: [] }],
    });
    setSelectedSpotifyPlaylist({ id: 'playlist-1', name: 'Anime OPs' });
    await clearNonSelectedSpotifyPlaylistCaches();
    expect(getPlaylistCache('playlist-2')).toBeNull();
    setSelectedSpotifyPlaylist({ id: 'playlist-2', name: 'Other' });
    mockLivePlaylistTrack('refetched-track');

    const refetched = await refreshPlaylistCache();

    expect(refetched?.playlistId).toBe('playlist-2');
    expect(refetched?.tracks[0]?.id).toBe('refetched-track');
    expect(spotifyApiFetch).toHaveBeenCalledOnce();
  });
});
