import { describe, expect, it } from 'vitest';
import type { MediaThemeSongRow } from '../../importers/anilist/themeSongs/types';
import { aggregatePlaylistMatchForRows, matchThemeRowToPlaylist } from '../spotifyPlaylistMatch';
import type { SpotifyPlaylistCache } from '../spotifyPlaylist';

function makeRow(overrides: Partial<MediaThemeSongRow> = {}): MediaThemeSongRow {
  return {
    type: 'Opening',
    sortOrder: 0,
    displayTitle: 'Test Song',
    displayArtist: 'Artist',
    spotifyUrl: null,
    spotifyTrackIds: [],
    spotifyIsrc: null,
    hasResolvableTrackId: false,
    ...overrides,
  };
}

const cache: SpotifyPlaylistCache = {
  playlistId: 'pl1',
  fetchedAt: Date.now(),
  tracks: [
    { id: 'track-a', isrc: 'USRC111', linkedFromIds: ['track-b'] },
    { id: 'track-c', isrc: 'USRC222', linkedFromIds: [] },
  ],
};

describe('matchThemeRowToPlaylist', () => {
  it('matches direct track id', () => {
    const row = makeRow({ spotifyTrackIds: ['track-a'], hasResolvableTrackId: true });
    expect(matchThemeRowToPlaylist(row, cache)).toBe('in');
  });

  it('matches linked_from id', () => {
    const row = makeRow({ spotifyTrackIds: ['track-b'], hasResolvableTrackId: true });
    expect(matchThemeRowToPlaylist(row, cache)).toBe('in');
  });

  it('matches by isrc', () => {
    const row = makeRow({ spotifyIsrc: 'USRC222', hasResolvableTrackId: true });
    expect(matchThemeRowToPlaylist(row, cache)).toBe('in');
  });

  it('returns out when track id is resolvable but absent', () => {
    const row = makeRow({ spotifyTrackIds: ['missing'], hasResolvableTrackId: true });
    expect(matchThemeRowToPlaylist(row, cache)).toBe('out');
  });

  it('returns unknown without cache', () => {
    const row = makeRow({ spotifyTrackIds: ['track-a'], hasResolvableTrackId: true });
    expect(matchThemeRowToPlaylist(row, null)).toBe('unknown');
  });

  it('matches alternate spotify id via lazy track isrc lookup', () => {
    const row = makeRow({
      spotifyTrackIds: ['2ReLy6MAZB0lw65E7utuIt'],
      hasResolvableTrackId: true,
    });
    const connectCache: SpotifyPlaylistCache = {
      playlistId: 'pl1',
      fetchedAt: Date.now(),
      tracks: [{ id: '6SrKLkuqWyKxSxzvtRWvX5', isrc: 'JPU901001861', linkedFromIds: [] }],
    };
    const lookup = new Map([['2ReLy6MAZB0lw65E7utuIt', 'JPU901001861']]);
    expect(
      matchThemeRowToPlaylist(row, connectCache, {
        trackIsrcById: lookup,
        isrcLookupReady: true,
      }),
    ).toBe('in');
  });

  it('waits for lazy isrc lookup before reporting out', () => {
    const row = makeRow({
      spotifyTrackIds: ['2ReLy6MAZB0lw65E7utuIt'],
      hasResolvableTrackId: true,
    });
    expect(
      matchThemeRowToPlaylist(row, cache, {
        trackIsrcById: new Map(),
        isrcLookupReady: false,
      }),
    ).toBe('unknown');
  });

  it('matches track id parsed from spotifyUrl when spotifyTrackIds is empty', () => {
    const row = makeRow({
      spotifyTrackIds: [],
      spotifyUrl: 'https://open.spotify.com/track/1ZD4E53dzpTyjkcrYZcdQB',
      hasResolvableTrackId: true,
    });
    const houkiboshiCache: SpotifyPlaylistCache = {
      playlistId: '0DBQIhCzeRJ1jqRmSO2Xdr',
      fetchedAt: Date.now(),
      tracks: [{ id: '1ZD4E53dzpTyjkcrYZcdQB', isrc: null, linkedFromIds: [] }],
    };
    expect(matchThemeRowToPlaylist(row, houkiboshiCache)).toBe('in');
  });

  it('bridges Japan vs global Houkiboshi catalog ids via ISRC', () => {
    const sharedIsrc = 'JPCO02503650';
    const row = makeRow({
      spotifyTrackIds: ['1ZD4E53dzpTyjkcrYZcdQB', '6gYV0M8HLVwW6tKQfzv7Jk'],
      spotifyUrl: 'https://open.spotify.com/track/6gYV0M8HLVwW6tKQfzv7Jk',
      hasResolvableTrackId: true,
    });
    const playlistCache: SpotifyPlaylistCache = {
      playlistId: '0DBQIhCzeRJ1jqRmSO2Xdr',
      fetchedAt: Date.now(),
      tracks: [{ id: '1ZD4E53dzpTyjkcrYZcdQB', isrc: sharedIsrc, linkedFromIds: [] }],
    };
    expect(
      matchThemeRowToPlaylist(row, playlistCache, {
        trackIsrcById: new Map([
          ['6gYV0M8HLVwW6tKQfzv7Jk', sharedIsrc],
          ['1ZD4E53dzpTyjkcrYZcdQB', sharedIsrc],
        ]),
        isrcLookupReady: true,
      }),
    ).toBe('in');
  });

  it('reports out when only spotifyUrl has a track id', () => {
    const row = makeRow({
      spotifyTrackIds: [],
      spotifyUrl: 'https://open.spotify.com/track/missing-from-playlist',
      hasResolvableTrackId: false,
    });
    expect(matchThemeRowToPlaylist(row, cache)).toBe('out');
  });

  it('reports out when track is beyond a truncated 50-track playlist cache', () => {
    const row = makeRow({
      spotifyTrackIds: ['1ZD4E53dzpTyjkcrYZcdQB'],
      spotifyUrl: 'https://open.spotify.com/track/1ZD4E53dzpTyjkcrYZcdQB',
      hasResolvableTrackId: true,
    });
    const truncatedCache: SpotifyPlaylistCache = {
      playlistId: '0DBQIhCzeRJ1jqRmSO2Xdr',
      fetchedAt: Date.now(),
      tracks: Array.from({ length: 50 }, (_, index) => ({
        id: `filler-track-${index}`,
        isrc: null,
        linkedFromIds: [],
      })),
    };
    expect(matchThemeRowToPlaylist(row, truncatedCache)).toBe('out');
  });
});

describe('aggregatePlaylistMatchForRows', () => {
  it('returns mixed when some resolvable rows match and some do not', () => {
    const rows = [
      makeRow({ spotifyTrackIds: ['track-a'], hasResolvableTrackId: true }),
      makeRow({ spotifyTrackIds: ['missing'], hasResolvableTrackId: true }),
    ];
    expect(aggregatePlaylistMatchForRows(rows, cache)).toBe('mixed');
  });

  it('returns in when all resolvable rows match', () => {
    const rows = [
      makeRow({ spotifyTrackIds: ['track-a'], hasResolvableTrackId: true }),
      makeRow({ spotifyIsrc: null, spotifyTrackIds: [], hasResolvableTrackId: false }),
    ];
    expect(aggregatePlaylistMatchForRows(rows, cache)).toBe('in');
  });

  it('returns out when every resolvable row is missing from the playlist', () => {
    const rows = [
      makeRow({ spotifyTrackIds: ['missing'], hasResolvableTrackId: true }),
      makeRow({ spotifyTrackIds: ['also-missing'], hasResolvableTrackId: true }),
    ];
    expect(aggregatePlaylistMatchForRows(rows, cache)).toBe('out');
  });

  it('returns null when every row is unknown', () => {
    const rows = [makeRow({ hasResolvableTrackId: false })];
    expect(aggregatePlaylistMatchForRows(rows, cache)).toBeNull();
  });

  it('houkiboshi show is mixed when ED is on playlist and OP is not', () => {
    const playlistCache: SpotifyPlaylistCache = {
      playlistId: '0DBQIhCzeRJ1jqRmSO2Xdr',
      fetchedAt: Date.now(),
      tracks: [{ id: '6gYV0M8HLVwW6tKQfzv7Jk', isrc: 'JPCO02503650', linkedFromIds: [] }],
    };
    const rows = [
      makeRow({
        type: 'Opening',
        spotifyTrackIds: ['6nmRFTaSwwoZ2e2Q45Pa9l'],
        hasResolvableTrackId: true,
      }),
      makeRow({
        type: 'Ending',
        spotifyTrackIds: ['1ZD4E53dzpTyjkcrYZcdQB', '6gYV0M8HLVwW6tKQfzv7Jk'],
        spotifyUrl: 'https://open.spotify.com/track/6gYV0M8HLVwW6tKQfzv7Jk',
        hasResolvableTrackId: true,
      }),
    ];
    expect(aggregatePlaylistMatchForRows(rows, playlistCache)).toBe('mixed');
    expect(matchThemeRowToPlaylist(rows[1]!, playlistCache)).toBe('in');
    expect(matchThemeRowToPlaylist(rows[0]!, playlistCache)).toBe('out');
  });
});
