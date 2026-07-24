import { afterEach, describe, expect, it } from 'vitest';
import {
  PLAYLIST_CACHE_STORAGE_KEY,
  _clearSpotifyPlaylistForTesting,
  clearSelectedSpotifyPlaylist,
  getActivePlaylistCache,
  getPlaylistCache,
  getSelectedSpotifyPlaylist,
  mergeSelectedPlaylistIntoOptions,
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
