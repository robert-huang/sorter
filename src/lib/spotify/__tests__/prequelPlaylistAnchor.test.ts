import { describe, expect, it, vi } from 'vitest';
import type { MediaThemeSongRow } from '../../importers/anilist/themeSongs/types';
import type { CachedPlaylistTrack, SpotifyPlaylistCache } from '../spotifyPlaylist';
import { findPrequelPlaylistAnchor, type PrequelAnchorReads } from '../prequelPlaylistAnchor';
import { planPlaylistInserts } from '../themeSongPlaylistEditing';

function row(trackId: string, type: MediaThemeSongRow['type'] = 'Opening'): MediaThemeSongRow {
  return {
    type,
    sortOrder: 1,
    displayTitle: trackId,
    displayArtist: 'Artist',
    spotifyUrl: null,
    spotifyTrackIds: [trackId],
    spotifyIsrc: null,
    hasResolvableTrackId: true,
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

/** `prequels`: show → its prequels; `songs`: show → cached theme-song track ids. */
function reads(
  prequels: Record<number, number[]>,
  songs: Record<number, string[]>,
): PrequelAnchorReads {
  return {
    prequelIds: vi.fn(async (ids: readonly number[]) =>
      new Map(ids.map((id) => [id, prequels[id] ?? []])),
    ),
    themeRows: vi.fn(async (ids: readonly number[]) =>
      new Map(ids.filter((id) => songs[id]).map((id) => [id, songs[id]!.map((t) => row(t))])),
    ),
  };
}

describe('findPrequelPlaylistAnchor', () => {
  const cache = cacheWith([track('s1op', 4), track('s1ed', 6), track('other', 5), track('s2op', 9)]);

  it("returns the direct prequel's last song on the playlist", async () => {
    await expect(
      findPrequelPlaylistAnchor(3, cache, reads({ 3: [2] }, { 2: ['s2op'] })),
    ).resolves.toBe(9);
    await expect(
      findPrequelPlaylistAnchor(2, cache, reads({ 2: [1] }, { 1: ['s1op', 's1ed'] })),
    ).resolves.toBe(6);
  });

  it('walks back past a prequel with no songs on the playlist or no cached songs', async () => {
    const r = reads({ 4: [3], 3: [2], 2: [1] }, { 3: ['missing'], 1: ['s1op', 's1ed'] });
    await expect(findPrequelPlaylistAnchor(4, cache, r)).resolves.toBe(6);
  });

  it('prefers the nearest generation over an older one further down the playlist', async () => {
    const r = reads({ 3: [2], 2: [1] }, { 2: ['s1op'], 1: ['s2op'] });
    await expect(findPrequelPlaylistAnchor(3, cache, r)).resolves.toBe(4);
  });

  it('is undefined with no prequel, no cache, or a relation cycle', async () => {
    await expect(findPrequelPlaylistAnchor(1, cache, reads({}, {}))).resolves.toBeUndefined();
    await expect(
      findPrequelPlaylistAnchor(2, null, reads({ 2: [1] }, { 1: ['s1op'] })),
    ).resolves.toBeUndefined();
    const cycle = reads({ 1: [2], 2: [1] }, {});
    await expect(findPrequelPlaylistAnchor(1, cache, cycle)).resolves.toBeUndefined();
    expect(cycle.prequelIds).toHaveBeenCalledTimes(2);
  });
});

describe('planPlaylistInserts with a prequel anchor', () => {
  const op = row('op');
  const ed = row('ed', 'Ending');

  it('puts a show with nothing on the playlist after the anchor', () => {
    const inserts = planPlaylistInserts([op, ed], [op, ed], cacheWith([track('x', 1)]), undefined, 6);
    expect(inserts.map((i) => [i.afterPosition, i.tracks.map((t) => t.id)])).toEqual([[6, ['op', 'ed']]]);
  });

  it("ignores the anchor once any of the show's songs is on the playlist", () => {
    const inserts = planPlaylistInserts([op, ed], [ed], cacheWith([track('op', 12)]), undefined, 6);
    expect(inserts.map((i) => i.afterPosition)).toEqual([12]);
  });
});
