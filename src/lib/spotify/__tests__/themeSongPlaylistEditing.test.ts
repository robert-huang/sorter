import { describe, expect, it } from 'vitest';
import type { MediaThemeSongRow } from '../../importers/anilist/themeSongs/types';
import type { CachedPlaylistTrack, SpotifyPlaylistCache } from '../spotifyPlaylist';
import {
  addablePlaylistTracks,
  collectNewPlaylistSongs,
  planPlaylistInserts,
  themeRowCandidateTrackIds,
} from '../themeSongPlaylistEditing';

function makeRow(overrides: Partial<MediaThemeSongRow> = {}): MediaThemeSongRow {
  return {
    type: 'Opening',
    sortOrder: 0,
    displayTitle: 'Song',
    displayArtist: 'Artist',
    spotifyUrl: null,
    spotifyTrackIds: [],
    spotifyIsrc: null,
    hasResolvableTrackId: true,
    ...overrides,
  };
}

function track(id: string, position: number): CachedPlaylistTrack {
  return {
    id,
    isrc: null,
    linkedFromIds: [],
    metadata: { title: id, artists: [], album: null, durationMs: null, playlistPosition: position },
  };
}

function cacheWith(tracks: CachedPlaylistTrack[]): SpotifyPlaylistCache {
  return { playlistId: 'pl', fetchedAt: 1, revision: Math.random(), tracks, trackTotal: 20 };
}

describe('themeRowCandidateTrackIds', () => {
  it('puts the AniPlaylist-picked url id first', () => {
    const row = makeRow({
      spotifyUrl: 'https://open.spotify.com/track/picked',
      spotifyTrackIds: ['other', 'picked'],
    });
    expect(themeRowCandidateTrackIds(row)).toEqual(['picked', 'other']);
  });
});

describe('planPlaylistInserts', () => {
  const op1 = makeRow({ sortOrder: 1, spotifyTrackIds: ['op1'] });
  const op2 = makeRow({ sortOrder: 2, spotifyTrackIds: ['op2'] });
  const ed1 = makeRow({ type: 'Ending', sortOrder: 1, spotifyTrackIds: ['ed1'] });
  const ed2 = makeRow({ type: 'Ending', sortOrder: 2, spotifyTrackIds: ['ed2'] });
  const ins = makeRow({ type: 'Insert', spotifyTrackIds: ['ins'] });
  const show = [op1, op2, ed1, ed2, ins];
  const plan = (rowsToAdd: MediaThemeSongRow[], cache: SpotifyPlaylistCache) =>
    planPlaylistInserts(show, rowsToAdd, cache).map(({ afterPosition, tracks }) => ({
      afterPosition,
      ids: tracks.map((t) => t.id),
    }));

  it('puts a single song after the show song before it, not after the last one', () => {
    const cache = cacheWith([track('op1', 10), track('ed1', 11)]);
    expect(plan([op2], cache)).toEqual([{ afterPosition: 10, ids: ['op2'] }]);
  });

  it('puts a song that precedes every placed song just before the first one', () => {
    const cache = cacheWith([track('op2', 10), track('ed1', 11)]);
    expect(plan([op1], cache)).toEqual([{ afterPosition: 9, ids: ['op1'] }]);
  });

  it('splits a show add into slots, last position first', () => {
    const cache = cacheWith([track('op1', 10), track('ed1', 11)]);
    expect(plan(show, cache)).toEqual([
      { afterPosition: 11, ids: ['ed2', 'ins'] },
      { afterPosition: 10, ids: ['op2'] },
    ]);
  });

  it('appends when none of the show is on the playlist', () => {
    expect(plan([ed1, op1], cacheWith([track('x', 1)]))).toEqual([
      { afterPosition: undefined, ids: ['op1', 'ed1'] },
    ]);
  });
});

describe('addablePlaylistTracks', () => {
  it('orders OP, ED, insert, skips songs already on the playlist and repeats', () => {
    const rows = [
      makeRow({ type: 'Insert', spotifyTrackIds: ['ins'] }),
      makeRow({ type: 'Ending', spotifyTrackIds: ['ed'] }),
      makeRow({ spotifyTrackIds: ['op'] }),
      makeRow({ sortOrder: 1, spotifyTrackIds: ['on-list'] }),
      makeRow({ sortOrder: 2, spotifyTrackIds: ['op'] }),
      makeRow({ sortOrder: 3, spotifyTrackIds: [], hasResolvableTrackId: false }),
    ];
    const tracks = addablePlaylistTracks(rows, cacheWith([track('on-list', 3)]));
    expect(tracks.map((t) => t.id)).toEqual(['op', 'ed', 'ins']);
    expect(tracks[0]).toMatchObject({ title: 'Song', artists: ['Artist'] });
  });

  it('follows the local-file match mode for a song that is only on the playlist as a local file', () => {
    const rows = [makeRow({ spotifyTrackIds: ['op'] })];
    const cache: SpotifyPlaylistCache = {
      ...cacheWith([]),
      localTracks: [
        { uri: null, title: 'Song', artists: ['Artist'], album: null, durationMs: null, playlistPosition: 5 },
      ],
    };
    const ids = (mode: 'off' | 'local-first' | 'spotify-first'): string[] =>
      addablePlaylistTracks(rows, cache, { localFileMatchMode: mode }).map((t) => t.id);

    expect(ids('local-first')).toEqual([]);
    expect(ids('spotify-first')).toEqual(['op']);
    expect(ids('off')).toEqual(['op']);
  });
});

describe('collectNewPlaylistSongs', () => {
  it('keeps show order, includes inserts and unavailable songs, skips id-less and repeated rows', () => {
    const result = collectNewPlaylistSongs(
      [
        {
          rows: [
            makeRow({ type: 'Insert', spotifyTrackIds: ['a-ins'] }),
            makeRow({ spotifyTrackIds: ['a-op'], spotifyAvailableMarkets: ['JP'] }),
          ],
        },
        { rows: [makeRow({ spotifyTrackIds: [] })] },
        {
          rows: [
            makeRow({ type: 'Ending', spotifyTrackIds: ['b-ed'] }),
            makeRow({ spotifyTrackIds: ['a-op'] }),
          ],
        },
      ],
      'CA',
    );
    expect(result.trackIds).toEqual(['a-op', 'a-ins', 'b-ed']);
    expect(result.showCount).toBe(2);
    expect(result.unavailableCount).toBe(1);
  });
});
