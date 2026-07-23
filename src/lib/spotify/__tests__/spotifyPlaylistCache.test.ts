import { afterEach, describe, expect, it } from 'vitest';
import {
  PLAYLIST_CACHE_STORAGE_KEY,
  _clearSpotifyPlaylistForTesting,
  clearSelectedSpotifyPlaylist,
  getActivePlaylistCache,
  getPlaylistCache,
  getSelectedSpotifyPlaylist,
  setSelectedSpotifyPlaylist,
  type SpotifyPlaylistCache,
} from '../spotifyPlaylist';

const SAMPLE_CACHE: SpotifyPlaylistCache = {
  playlistId: 'playlist-1',
  fetchedAt: 1_700_000_000_000,
  tracks: [{ id: 'track-1', isrc: 'USRC001', linkedFromIds: [] }],
};

afterEach(() => {
  _clearSpotifyPlaylistForTesting();
});

describe('spotify playlist cache selection', () => {
  it('clearSelectedSpotifyPlaylist drops selection but keeps cached tracks', () => {
    setSelectedSpotifyPlaylist({ id: 'playlist-1', name: 'Anime OPs' });
    localStorage.setItem(PLAYLIST_CACHE_STORAGE_KEY, JSON.stringify(SAMPLE_CACHE));

    clearSelectedSpotifyPlaylist();

    expect(getSelectedSpotifyPlaylist()).toBeNull();
    expect(getPlaylistCache()).toEqual(SAMPLE_CACHE);
    expect(getActivePlaylistCache()).toBeNull();
  });

  it('getActivePlaylistCache returns cache only when selection matches', () => {
    localStorage.setItem(PLAYLIST_CACHE_STORAGE_KEY, JSON.stringify(SAMPLE_CACHE));

    expect(getActivePlaylistCache()).toBeNull();

    setSelectedSpotifyPlaylist({ id: 'playlist-1', name: 'Anime OPs' });
    expect(getActivePlaylistCache()).toEqual(SAMPLE_CACHE);

    setSelectedSpotifyPlaylist({ id: 'playlist-2', name: 'Other' });
    expect(getActivePlaylistCache()).toBeNull();
    expect(getPlaylistCache()).toEqual(SAMPLE_CACHE);
  });
});
