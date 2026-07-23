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
});

describe('aggregatePlaylistMatchForRows', () => {
  it('returns out when any row is missing from the playlist', () => {
    const rows = [
      makeRow({ spotifyTrackIds: ['track-a'], hasResolvableTrackId: true }),
      makeRow({ spotifyTrackIds: ['missing'], hasResolvableTrackId: true }),
    ];
    expect(aggregatePlaylistMatchForRows(rows, cache)).toBe('out');
  });

  it('returns in when all resolvable rows match and none are out', () => {
    const rows = [
      makeRow({ spotifyTrackIds: ['track-a'], hasResolvableTrackId: true }),
      makeRow({ spotifyIsrc: null, spotifyTrackIds: [], hasResolvableTrackId: false }),
    ];
    expect(aggregatePlaylistMatchForRows(rows, cache)).toBe('in');
  });

  it('returns null when every row is unknown', () => {
    const rows = [makeRow({ hasResolvableTrackId: false })];
    expect(aggregatePlaylistMatchForRows(rows, cache)).toBeNull();
  });
});
