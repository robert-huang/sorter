import type { MediaThemeSongRow } from '../importers/anilist/themeSongs/types';
import type { SpotifyPlaylistCache } from './spotifyPlaylist';

export type PlaylistMatchStatus = 'in' | 'out' | 'unknown';

/** Show-level aggregate over resolvable theme rows (unknown rows excluded). */
export type PlaylistAggregateStatus = 'in' | 'out' | 'mixed';

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

/**
 * Show-level aggregate for chart badges. Only rows with a resolvable Spotify
 * link count (in/out); rows without a link are ignored. Mixed when some match
 * and some do not.
 */
export function aggregatePlaylistMatchForRows(
  rows: readonly MediaThemeSongRow[],
  cache: SpotifyPlaylistCache | null,
): PlaylistAggregateStatus | null {
  if (!cache || rows.length === 0) {
    return null;
  }
  let anyIn = false;
  let anyOut = false;
  let anyResolvable = false;
  for (const row of rows) {
    const status = matchThemeRowToPlaylist(row, cache);
    if (status === 'unknown') {
      continue;
    }
    anyResolvable = true;
    if (status === 'out') {
      anyOut = true;
    } else if (status === 'in') {
      anyIn = true;
    }
  }
  if (!anyResolvable) {
    return null;
  }
  if (anyIn && anyOut) {
    return 'mixed';
  }
  if (anyOut) {
    return 'out';
  }
  return 'in';
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
