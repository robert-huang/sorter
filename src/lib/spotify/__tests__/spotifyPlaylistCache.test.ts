import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_PLAYLIST_CACHE_STORAGE_KEY,
  PLAYLIST_CACHE_METADATA_VERSION,
  PLAYLIST_CACHE_STORAGE_KEY,
  _clearSpotifyPlaylistForTesting,
  _resetSpotifyPlaylistCacheMemoryForTesting,
  _writePlaylistCacheForTesting,
  clearSelectedSpotifyPlaylist,
  countCachedPlaylistTracks,
  getActivePlaylistCache,
  getPlaylistCache,
  hydrateSpotifyPlaylistCaches,
  isPlaylistCacheIncomplete,
  getSelectedSpotifyPlaylist,
  listUserSpotifyPlaylists,
  mergeSelectedPlaylistIntoOptions,
  SPOTIFY_UNREGISTERED_USER_MESSAGE,
  setSelectedSpotifyPlaylist,
  type SpotifyPlaylistCache,
  updatePlaylistCacheTracks,
} from '../spotifyPlaylist';
import {
  _setSpotifyPlaylistCachePersistenceForTesting,
  type SpotifyPlaylistCachePersistence,
} from '../spotifyPlaylistCacheDb';
import { createPlaylistCachePersistence } from './spotifyCachePersistenceTestUtils';

const SAMPLE_CACHE: SpotifyPlaylistCache = {
  playlistId: 'playlist-1',
  fetchedAt: 1_700_000_000_000,
  tracks: [{ id: 'track-1', isrc: 'USRC001', linkedFromIds: [] }],
};

const SAMPLE_CACHE_2: SpotifyPlaylistCache = {
  playlistId: 'playlist-2',
  fetchedAt: 1_700_000_100_000,
  tracks: [{ id: 'track-2', isrc: 'USRC002', linkedFromIds: [] }],
};

function writePlaylistCacheStoreForTest(
  ...caches: readonly SpotifyPlaylistCache[]
): void {
  const store = Object.fromEntries(caches.map((cache) => [cache.playlistId, cache]));
  localStorage.setItem(PLAYLIST_CACHE_STORAGE_KEY, JSON.stringify(store));
}

let persistence: ReturnType<typeof createPlaylistCachePersistence>;

beforeEach(async () => {
  persistence = createPlaylistCachePersistence();
  _setSpotifyPlaylistCachePersistenceForTesting(persistence);
  await _clearSpotifyPlaylistForTesting();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await _clearSpotifyPlaylistForTesting();
  _setSpotifyPlaylistCachePersistenceForTesting(null);
});

describe('spotify playlist cache selection', () => {
  it('clearSelectedSpotifyPlaylist drops selection but keeps cached tracks', () => {
    setSelectedSpotifyPlaylist({ id: 'playlist-1', name: 'Anime OPs' });
    writePlaylistCacheStoreForTest(SAMPLE_CACHE);

    clearSelectedSpotifyPlaylist();

    expect(getSelectedSpotifyPlaylist()).toBeNull();
    expect(getPlaylistCache('playlist-1')).toEqual(SAMPLE_CACHE);
    expect(getActivePlaylistCache()).toBeNull();
  });

  it('getActivePlaylistCache returns cache only when selection matches', () => {
    writePlaylistCacheStoreForTest(SAMPLE_CACHE);

    expect(getActivePlaylistCache()).toBeNull();

    setSelectedSpotifyPlaylist({ id: 'playlist-1', name: 'Anime OPs' });
    expect(getActivePlaylistCache()).toEqual(SAMPLE_CACHE);

    setSelectedSpotifyPlaylist({ id: 'playlist-2', name: 'Other' });
    expect(getActivePlaylistCache()).toBeNull();
    expect(getPlaylistCache('playlist-1')).toEqual(SAMPLE_CACHE);
  });

  it('switching back to a previously cached playlist reuses its cache', () => {
    writePlaylistCacheStoreForTest(SAMPLE_CACHE, SAMPLE_CACHE_2);

    setSelectedSpotifyPlaylist({ id: 'playlist-1', name: 'Anime OPs' });
    expect(getActivePlaylistCache()).toEqual(SAMPLE_CACHE);

    setSelectedSpotifyPlaylist({ id: 'playlist-2', name: 'Other' });
    expect(getActivePlaylistCache()).toEqual(SAMPLE_CACHE_2);

    setSelectedSpotifyPlaylist({ id: 'playlist-1', name: 'Anime OPs' });
    expect(getActivePlaylistCache()).toEqual(SAMPLE_CACHE);
  });

  it('keeps multiple playlist caches in durable storage without localStorage pressure', async () => {
    await _writePlaylistCacheForTesting(SAMPLE_CACHE);
    await _writePlaylistCacheForTesting(SAMPLE_CACHE_2);
    const updatedTracks = [
      { id: 'track-updated', isrc: 'USRC003', linkedFromIds: [] },
    ];

    expect(await updatePlaylistCacheTracks('playlist-2', updatedTracks)).toBe(true);
    expect(getPlaylistCache('playlist-1')).not.toBeNull();
    expect(getPlaylistCache('playlist-2')?.tracks).toEqual(updatedTracks);
    expect(persistence.snapshot()).toHaveLength(2);
    expect(localStorage.getItem(PLAYLIST_CACHE_STORAGE_KEY)).toBeNull();
  });

  it('surfaces a durable cache write failure', async () => {
    const failingPersistence: SpotifyPlaylistCachePersistence = {
      ...persistence,
      put: async () => {
        throw new Error('Unable to save the Spotify playlist cache in IndexedDB.');
      },
    };
    _setSpotifyPlaylistCachePersistenceForTesting(failingPersistence);

    await expect(_writePlaylistCacheForTesting(SAMPLE_CACHE)).rejects.toThrow(
      'Unable to save the Spotify playlist cache in durable browser storage.',
    );
  });

  it('persists descriptive metadata for local playlist files', async () => {
    const cache: SpotifyPlaylistCache = {
      ...SAMPLE_CACHE,
      localTracks: [
        {
          uri: 'spotify:local:Younha:Bleach:Houkiboshi:248',
          title: 'Houkiboshi',
          artists: ['Younha'],
          album: 'Bleach',
          durationMs: 248_000,
          playlistPosition: 12,
        },
      ],
    };
    await _writePlaylistCacheForTesting(cache);

    expect(getPlaylistCache('playlist-1')?.localTracks).toEqual(cache.localTracks);
    expect(persistence.snapshot()[0]?.localTracks).toEqual(cache.localTracks);
  });

  it('persists descriptive metadata for Spotify catalog tracks', async () => {
    const metadata = {
      title: 'ウンディーネ',
      artists: ['Yui Makino'],
      album: 'ウンディーネ',
      durationMs: 345_426,
      playlistPosition: 1,
    };
    const cache: SpotifyPlaylistCache = {
      ...SAMPLE_CACHE,
      metadataVersion: PLAYLIST_CACHE_METADATA_VERSION,
      tracks: [{ ...SAMPLE_CACHE.tracks[0], metadata }],
    };
    await _writePlaylistCacheForTesting(cache);

    expect(getPlaylistCache('playlist-1')?.tracks[0]?.metadata).toEqual(metadata);
    expect(persistence.snapshot()[0]?.tracks[0]?.metadata).toEqual(metadata);
  });

  it('hydrates a 4,184-item mixed playlist after a page reload', async () => {
    const spotifyTrackCount = 3_430;
    const localTrackCount = 754;
    const largeCache: SpotifyPlaylistCache = {
      playlistId: 'playlist-large',
      fetchedAt: 1_700_000_200_000,
      tracks: Array.from({ length: spotifyTrackCount }, (_, index) => ({
        id: `track-${index}`,
        isrc: null,
        linkedFromIds: [],
      })),
      localTracks: Array.from({ length: localTrackCount }, (_, index) => ({
        uri: `spotify:local:Artist:Album:Local+${index}:90`,
        title: `Local ${index}`,
        artists: ['Artist'],
        album: 'Album',
        durationMs: 90_000,
        playlistPosition: spotifyTrackCount + index + 1,
      })),
      metadataVersion: PLAYLIST_CACHE_METADATA_VERSION,
      playlistItemsFetched: spotifyTrackCount + localTrackCount,
      paginationComplete: true,
    };
    await _writePlaylistCacheForTesting(largeCache);

    _resetSpotifyPlaylistCacheMemoryForTesting();
    await hydrateSpotifyPlaylistCaches();

    const hydrated = getPlaylistCache('playlist-large');
    expect(hydrated && countCachedPlaylistTracks(hydrated)).toBe(4_184);
    expect(hydrated?.paginationComplete).toBe(true);
    expect(localStorage.getItem(PLAYLIST_CACHE_STORAGE_KEY)).toBeNull();
  });

  it('migrates legacy v1 single-playlist cache into IndexedDB', async () => {
    localStorage.setItem(LEGACY_PLAYLIST_CACHE_STORAGE_KEY, JSON.stringify(SAMPLE_CACHE));
    setSelectedSpotifyPlaylist({ id: 'playlist-1', name: 'Anime OPs' });

    await hydrateSpotifyPlaylistCaches();

    expect(getActivePlaylistCache()).toEqual(SAMPLE_CACHE);
    expect(localStorage.getItem(LEGACY_PLAYLIST_CACHE_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(PLAYLIST_CACHE_STORAGE_KEY)).toBeNull();
    expect(persistence.snapshot()).toEqual([SAMPLE_CACHE]);
  });

  it('migrates the legacy v2 playlist map into IndexedDB', async () => {
    writePlaylistCacheStoreForTest(SAMPLE_CACHE, SAMPLE_CACHE_2);

    await hydrateSpotifyPlaylistCaches();

    expect(persistence.snapshot()).toEqual([SAMPLE_CACHE, SAMPLE_CACHE_2]);
    expect(localStorage.getItem(PLAYLIST_CACHE_STORAGE_KEY)).toBeNull();
  });
});

describe('mergeSelectedPlaylistIntoOptions', () => {
  it('prepends stored selection when the fetched list is empty', () => {
    const selected = { id: 'playlist-1', name: 'Anime OPs' };
    expect(mergeSelectedPlaylistIntoOptions([], selected)).toEqual([selected]);
  });

  it('does not duplicate when selection is already in the list', () => {
    const playlists = [
      { id: 'playlist-1', name: 'Anime OPs' },
      { id: 'playlist-2', name: 'Other' },
    ];
    expect(mergeSelectedPlaylistIntoOptions(playlists, playlists[0])).toEqual(playlists);
  });

  it('returns a copy when there is no selection', () => {
    const playlists = [{ id: 'playlist-2', name: 'Other' }];
    expect(mergeSelectedPlaylistIntoOptions(playlists, null)).toEqual(playlists);
    expect(mergeSelectedPlaylistIntoOptions(playlists, null)).not.toBe(playlists);
  });
});

describe('listUserSpotifyPlaylists errors', () => {
  it('explains how an unregistered development-app user gets access', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            status: 403,
            message:
              'The user is not registered for this application. Please check your settings on https://developer.spotify.com/dashboard.',
          },
        }),
        { status: 403 },
      ),
    );

    await expect(listUserSpotifyPlaylists('token')).rejects.toThrow(
      SPOTIFY_UNREGISTERED_USER_MESSAGE,
    );
  });

  it('recognizes the same Spotify restriction from a plain-text response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        'The user is not registered for this application. Please check the developer dashboard.',
        { status: 403 },
      ),
    );

    await expect(listUserSpotifyPlaylists('token')).rejects.toThrow(
      SPOTIFY_UNREGISTERED_USER_MESSAGE,
    );
  });
});

describe('isPlaylistCacheIncomplete', () => {
  it('includes local files in the displayed cached-track count', () => {
    const cache: SpotifyPlaylistCache = {
      ...SAMPLE_CACHE,
      localTracks: [
        {
          uri: 'spotify:local:Artist:Album:Local+Track:90',
          title: 'Local Track',
          artists: ['Artist'],
          album: 'Album',
          durationMs: 90_000,
          playlistPosition: 2,
        },
      ],
    };

    expect(countCachedPlaylistTracks(cache)).toBe(2);
  });

  it('flags legacy 50-track caches without trackTotal', () => {
    const cache: SpotifyPlaylistCache = {
      playlistId: 'pl1',
      fetchedAt: Date.now(),
      tracks: Array.from({ length: 50 }, (_, index) => ({
        id: `track-${index}`,
        isrc: null,
        linkedFromIds: [],
      })),
    };
    expect(isPlaylistCacheIncomplete(cache)).toBe(true);
  });

  it('is complete when all reported playlist items were fetched', () => {
    const cache: SpotifyPlaylistCache = {
      playlistId: 'pl1',
      fetchedAt: Date.now(),
      trackTotal: 50,
      playlistItemsFetched: 50,
      localTracks: [],
      metadataVersion: PLAYLIST_CACHE_METADATA_VERSION,
      tracks: Array.from({ length: 50 }, (_, index) => ({
        id: `track-${index}`,
        isrc: null,
        linkedFromIds: [],
      })),
    };
    expect(isPlaylistCacheIncomplete(cache)).toBe(false);
  });

  it('does not treat cached local files as missing playlist items', () => {
    const cache: SpotifyPlaylistCache = {
      playlistId: 'pl1',
      fetchedAt: Date.now(),
      trackTotal: 52,
      playlistItemsFetched: 52,
      metadataVersion: PLAYLIST_CACHE_METADATA_VERSION,
      localTracks: [
        {
          uri: 'spotify:local:Artist:Album:Local+One:90',
          title: 'Local One',
          artists: ['Artist'],
          album: 'Album',
          durationMs: 90_000,
          playlistPosition: 51,
        },
        {
          uri: 'spotify:local:Artist:Album:Local+Two:95',
          title: 'Local Two',
          artists: ['Artist'],
          album: 'Album',
          durationMs: 95_000,
          playlistPosition: 52,
        },
      ],
      tracks: Array.from({ length: 50 }, (_, index) => ({
        id: `track-${index}`,
        isrc: null,
        linkedFromIds: [],
      })),
    };
    expect(isPlaylistCacheIncomplete(cache)).toBe(false);
  });

  it('treats a terminal 4,184-item mixed fetch as complete despite a stale reported total', () => {
    const spotifyTrackCount = 3_430;
    const localTrackCount = 754;
    const cache: SpotifyPlaylistCache = {
      playlistId: 'pl-large',
      fetchedAt: Date.now(),
      trackTotal: spotifyTrackCount + localTrackCount + 1,
      playlistItemsFetched: spotifyTrackCount + localTrackCount,
      paginationComplete: true,
      metadataVersion: PLAYLIST_CACHE_METADATA_VERSION,
      tracks: Array.from({ length: spotifyTrackCount }, (_, index) => ({
        id: `track-${index}`,
        isrc: null,
        linkedFromIds: [],
      })),
      localTracks: Array.from({ length: localTrackCount }, (_, index) => ({
        uri: `spotify:local:Artist:Album:Local+Track+${index}:90`,
        title: `Local Track ${index}`,
        artists: ['Artist'],
        album: 'Album',
        durationMs: 90_000,
        playlistPosition: spotifyTrackCount + index + 1,
      })),
    };

    expect(countCachedPlaylistTracks(cache)).toBe(4_184);
    expect(isPlaylistCacheIncomplete(cache)).toBe(false);
  });

  it('flags when fewer playlist items were fetched than Spotify reports', () => {
    const cache: SpotifyPlaylistCache = {
      playlistId: 'pl1',
      fetchedAt: Date.now(),
      trackTotal: 120,
      playlistItemsFetched: 50,
      tracks: Array.from({ length: 50 }, (_, index) => ({
        id: `track-${index}`,
        isrc: null,
        linkedFromIds: [],
      })),
    };
    expect(isPlaylistCacheIncomplete(cache)).toBe(true);
  });

  it('flags a pre-local-metadata cache for a one-time refresh', () => {
    const cache: SpotifyPlaylistCache = {
      playlistId: 'pl1',
      fetchedAt: Date.now(),
      trackTotal: 52,
      tracks: Array.from({ length: 50 }, (_, index) => ({
        id: `track-${index}`,
        isrc: null,
        linkedFromIds: [],
      })),
    };
    expect(isPlaylistCacheIncomplete(cache)).toBe(true);
  });

  it('flags a cache without catalog metadata for a one-time refresh', () => {
    const cache: SpotifyPlaylistCache = {
      ...SAMPLE_CACHE,
      trackTotal: 1,
      playlistItemsFetched: 1,
      localTracks: [],
    };

    expect(isPlaylistCacheIncomplete(cache)).toBe(true);
  });
});
