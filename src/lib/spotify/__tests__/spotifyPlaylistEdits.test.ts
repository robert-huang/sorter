import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spotifyApiFetch } from '../spotifyApi';
import {
  SPOTIFY_PLAYLIST_EDIT_FORBIDDEN_MESSAGE,
  _clearSpotifyPlaylistForTesting,
  _writePlaylistCacheForTesting,
  getPlaylistCache,
  setSelectedSpotifyPlaylist,
  type CachedPlaylistTrack,
  type SpotifyPlaylistCache,
} from '../spotifyPlaylist';
import {
  SpotifyPlaylistPartialCreateError,
  createSpotifyPlaylistWithTracks,
  insertTracksIntoPlaylistCache,
  insertTracksIntoSelectedPlaylist,
  removeTrackFromSelectedPlaylist,
  removeTracksFromPlaylistCache,
  type NewPlaylistTrack,
} from '../spotifyPlaylistEdits';
import { _setSpotifyPlaylistCachePersistenceForTesting } from '../spotifyPlaylistCacheDb';
import { createPlaylistCachePersistence } from './spotifyCachePersistenceTestUtils';

vi.mock('../spotifyApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../spotifyApi')>()),
  spotifyApiFetch: vi.fn(),
}));
vi.mock('../spotifyAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../spotifyAuth')>()),
  ensureSpotifyAccessToken: vi.fn(async () => 'token'),
}));

const fetchMock = vi.mocked(spotifyApiFetch);

function track(id: string, position: number, linkedFromIds: string[] = []): CachedPlaylistTrack {
  return {
    id,
    isrc: null,
    linkedFromIds,
    metadata: { title: id, artists: [], album: null, durationMs: null, playlistPosition: position },
  };
}

function newTrack(id: string): NewPlaylistTrack {
  return { id, title: `Song ${id}`, artists: ['Artist'], isrc: null };
}

function positions(cache: SpotifyPlaylistCache): Record<string, number> {
  return Object.fromEntries([
    ...cache.tracks.map((t) => [t.id, t.metadata!.playlistPosition]),
    ...(cache.localTracks ?? []).map((t) => [t.title, t.playlistPosition]),
  ]);
}

/** #1..#5 with a local file at #4. */
const CACHE: SpotifyPlaylistCache = {
  playlistId: 'playlist-1',
  fetchedAt: 1,
  tracks: [track('a', 1), track('b', 2), track('c', 3), track('e', 5)],
  localTracks: [
    { uri: 'spotify:local:x', title: 'local', artists: [], album: null, durationMs: null, playlistPosition: 4 },
  ],
  trackTotal: 5,
};

function okResponse(body: unknown = { snapshot_id: 's' }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function requestBody(callIndex: number): unknown {
  const init = fetchMock.mock.calls[callIndex]?.[2];
  return JSON.parse(String(init?.body));
}

beforeEach(async () => {
  _setSpotifyPlaylistCachePersistenceForTesting(createPlaylistCachePersistence());
  await _clearSpotifyPlaylistForTesting();
  fetchMock.mockReset();
});

afterEach(async () => {
  await _clearSpotifyPlaylistForTesting();
  _setSpotifyPlaylistCachePersistenceForTesting(null);
});

describe('playlist cache position edits', () => {
  it('inserts after an anchor and shifts later tracks and local files', () => {
    const next = insertTracksIntoPlaylistCache(CACHE, [newTrack('n1'), newTrack('n2')], 3);
    expect(positions(next)).toEqual({ a: 1, b: 2, c: 3, n1: 4, n2: 5, local: 6, e: 7 });
    expect(next.trackTotal).toBe(7);
  });

  it('appends after the stored length when there is no anchor', () => {
    const next = insertTracksIntoPlaylistCache({ ...CACHE, trackTotal: 9 }, [newTrack('n1')]);
    expect(positions(next).n1).toBe(10);
    expect(positions(next).e).toBe(5);
    expect(next.trackTotal).toBe(10);
  });

  it('removes every copy and shifts later items up', () => {
    const cache = { ...CACHE, tracks: [...CACHE.tracks, track('b', 6)], trackTotal: 6 };
    const next = removeTracksFromPlaylistCache(cache, new Set(['spotify:track:b']));
    expect(positions(next)).toEqual({ a: 1, c: 2, local: 3, e: 4 });
    expect(next.trackTotal).toBe(4);
  });
});

describe('insertTracksIntoSelectedPlaylist', () => {
  beforeEach(async () => {
    setSelectedSpotifyPlaylist({ id: 'playlist-1', name: 'Anime OPs' });
    await _writePlaylistCacheForTesting(CACHE);
  });

  it('sends a 0-based position equal to the 1-based anchor and updates the cache', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    await insertTracksIntoSelectedPlaylist([newTrack('n1')], { afterPosition: 2 });

    expect(fetchMock.mock.calls[0]?.[0]).toContain('/playlists/playlist-1/items');
    expect(fetchMock.mock.calls[0]?.[2]?.method).toBe('POST');
    expect(requestBody(0)).toEqual({ uris: ['spotify:track:n1'], position: 2 });
    expect(positions(getPlaylistCache('playlist-1')!)).toMatchObject({ b: 2, n1: 3, c: 4 });
  });

  it('omits position when appending', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    await insertTracksIntoSelectedPlaylist([newTrack('n1')]);
    expect(requestBody(0)).toEqual({ uris: ['spotify:track:n1'] });
    expect(positions(getPlaylistCache('playlist-1')!).n1).toBe(6);
  });

  it('leaves the cache unchanged and explains a 403', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    await expect(insertTracksIntoSelectedPlaylist([newTrack('n1')])).rejects.toThrow(
      SPOTIFY_PLAYLIST_EDIT_FORBIDDEN_MESSAGE,
    );
    expect(getPlaylistCache('playlist-1')?.tracks).toHaveLength(4);
  });
});

describe('removeTrackFromSelectedPlaylist', () => {
  beforeEach(async () => {
    setSelectedSpotifyPlaylist({ id: 'playlist-1', name: 'Anime OPs' });
    await _writePlaylistCacheForTesting({
      ...CACHE,
      tracks: [...CACHE.tracks, track('relinked', 6, ['original'])],
      trackTotal: 6,
    });
  });

  it('deletes by the stored (pre-relinking) uri and shifts positions', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    await removeTrackFromSelectedPlaylist({ trackIds: ['original'], isrcs: [] });
    expect(fetchMock.mock.calls[0]?.[2]?.method).toBe('DELETE');
    expect(requestBody(0)).toEqual({ items: [{ uri: 'spotify:track:original' }] });
    expect(getPlaylistCache('playlist-1')?.tracks.map((t) => t.id)).not.toContain('relinked');
  });

  it('removes all copies of a track', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    await _writePlaylistCacheForTesting({
      ...CACHE,
      tracks: [...CACHE.tracks, track('a', 6)],
      trackTotal: 6,
    });
    await expect(removeTrackFromSelectedPlaylist({ trackIds: ['a'], isrcs: [] })).resolves.toBe(2);
    expect(positions(getPlaylistCache('playlist-1')!)).toEqual({ b: 1, c: 2, local: 3, e: 4 });
  });

  it('leaves the cache unchanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await expect(removeTrackFromSelectedPlaylist({ trackIds: ['a'], isrcs: [] })).rejects.toThrow();
    expect(getPlaylistCache('playlist-1')?.tracks).toHaveLength(5);
  });
});

describe('createSpotifyPlaylistWithTracks', () => {
  const ids = Array.from({ length: 150 }, (_, i) => `t${i}`);

  it('creates the playlist then adds songs in chunks of 100, without selecting it', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ id: 'new-1', name: 'Fall' }))
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse());
    const progress: number[] = [];
    const result = await createSpotifyPlaylistWithTracks({
      name: 'Fall',
      isPublic: true,
      description: 'Weekly Calendar theme songs · Fall 2026',
      trackIds: ids,
      onProgress: (p) => progress.push(p.added),
    });

    expect(fetchMock.mock.calls[0]?.[0]).toContain('/me/playlists');
    expect(requestBody(0)).toEqual({
      name: 'Fall',
      public: true,
      description: 'Weekly Calendar theme songs · Fall 2026',
    });
    expect((requestBody(1) as { uris: string[] }).uris).toHaveLength(100);
    expect((requestBody(2) as { uris: string[] }).uris).toHaveLength(50);
    expect(progress).toEqual([0, 100, 150]);
    expect(result).toEqual({ id: 'new-1', name: 'Fall', added: 150 });
    expect(getPlaylistCache('new-1')).toBeNull();
  });

  it('reports how many songs were added when a chunk fails', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ id: 'new-1' }))
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(new Response('{}', { status: 500 }));
    const attempt = createSpotifyPlaylistWithTracks({
      name: 'Fall',
      isPublic: false,
      description: '',
      trackIds: ids,
    });
    await expect(attempt).rejects.toBeInstanceOf(SpotifyPlaylistPartialCreateError);
    await expect(attempt).rejects.toThrow('only added 100 of 150 songs');
  });
});
