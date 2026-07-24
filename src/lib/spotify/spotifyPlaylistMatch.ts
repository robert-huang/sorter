import type { MediaThemeSongRow } from '../importers/anilist/themeSongs/types';
import type { SpotifyPlaylistCache } from './spotifyPlaylist';

export type PlaylistMatchStatus = 'in' | 'out' | 'unknown';

/** Show-level aggregate over resolvable theme rows (unknown rows excluded). */
export type PlaylistAggregateStatus = 'in' | 'out' | 'mixed';

export type PlaylistMatchOptions = {
  /** Theme track ID → ISRC (lazy cache / persisted expansion). */
  trackIsrcById?: ReadonlyMap<string, string>;
  /** False while lazy theme ISRC fetches are still in flight. */
  isrcLookupReady?: boolean;
};

type PlaylistIndex = {
  trackIds: Set<string>;
  isrcs: Set<string>;
};

function normalizeIsrc(isrc: string): string {
  return isrc.toLowerCase();
}

function collectRowIsrcs(
  row: MediaThemeSongRow,
  trackIsrcById?: ReadonlyMap<string, string>,
): Set<string> {
  const isrcs = new Set<string>();
  if (row.spotifyIsrc) {
    isrcs.add(normalizeIsrc(row.spotifyIsrc));
  }
  for (const trackId of row.spotifyTrackIds) {
    const isrc = trackIsrcById?.get(trackId);
    if (isrc) {
      isrcs.add(normalizeIsrc(isrc));
    }
  }
  return isrcs;
}

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
  options?: PlaylistMatchOptions,
): PlaylistAggregateStatus | null {
  if (!cache || rows.length === 0) {
    return null;
  }
  let anyIn = false;
  let anyOut = false;
  let anyResolvable = false;
  for (const row of rows) {
    const status = matchThemeRowToPlaylist(row, cache, options);
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
  options?: PlaylistMatchOptions,
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

  const rowIsrcs = collectRowIsrcs(row, options?.trackIsrcById);
  for (const isrc of rowIsrcs) {
    if (index.isrcs.has(isrc)) {
      return 'in';
    }
  }

  if (row.hasResolvableTrackId) {
    if (options?.isrcLookupReady === false && rowIsrcs.size === 0) {
      return 'unknown';
    }
    return 'out';
  }

  return 'unknown';
}

export function buildPlaylistIndexForTests(
  cache: SpotifyPlaylistCache,
): { trackIds: Set<string>; isrcs: Set<string> } {
  return buildPlaylistIndex(cache);
}
