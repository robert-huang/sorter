import type { MediaThemeSongRow } from '../importers/anilist/themeSongs/types';
import type { SpotifyPlaylistCache } from './spotifyPlaylist';

export type PlaylistMatchStatus = 'in' | 'out' | 'unknown';

type PlaylistIndex = {
  trackIds: Set<string>;
  isrcs: Set<string>;
};

function buildPlaylistIndex(cache: SpotifyPlaylistCache): PlaylistIndex {
  const trackIds = new Set<string>();
  const isrcs = new Set<string>();
  for (const track of cache.tracks) {
    trackIds.add(track.id);
    for (const linkedId of track.linkedFromIds) {
      trackIds.add(linkedId);
    }
    if (track.isrc) {
      isrcs.add(track.isrc.toLowerCase());
    }
  }
  return { trackIds, isrcs };
}

/** Row-level aggregate for chart badges: red if any track is missing, green if any matched. */
export function aggregatePlaylistMatchForRows(
  rows: readonly MediaThemeSongRow[],
  cache: SpotifyPlaylistCache | null,
): PlaylistMatchStatus | null {
  if (!cache || rows.length === 0) {
    return null;
  }
  let anyIn = false;
  let anyOut = false;
  for (const row of rows) {
    const status = matchThemeRowToPlaylist(row, cache);
    if (status === 'out') {
      anyOut = true;
    } else if (status === 'in') {
      anyIn = true;
    }
  }
  if (anyOut) {
    return 'out';
  }
  if (anyIn) {
    return 'in';
  }
  return null;
}

export function matchThemeRowToPlaylist(
  row: MediaThemeSongRow,
  cache: SpotifyPlaylistCache | null,
): PlaylistMatchStatus {
  if (!cache || cache.tracks.length === 0) {
    return 'unknown';
  }

  const index = buildPlaylistIndex(cache);

  for (const trackId of row.spotifyTrackIds) {
    if (index.trackIds.has(trackId)) {
      return 'in';
    }
  }

  if (row.spotifyIsrc && index.isrcs.has(row.spotifyIsrc.toLowerCase())) {
    return 'in';
  }

  if (row.hasResolvableTrackId) {
    return 'out';
  }

  return 'unknown';
}

export function buildPlaylistIndexForTests(
  cache: SpotifyPlaylistCache,
): { trackIds: Set<string>; isrcs: Set<string> } {
  return buildPlaylistIndex(cache);
}
