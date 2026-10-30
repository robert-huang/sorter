/** Theme-song rules for right-click playlist edits (which rows, which track, where). */
import { THEME_SONG_TYPE_ORDER, type MediaThemeSongRow } from '../importers/anilist/themeSongs/types';
import {
  isSpotifyUnavailableInMarket,
  parseSpotifyTrackIdFromUrl,
} from '../importers/anilist/themeSongs/spotifyLinks';
import type { SpotifyPlaylistCache } from './spotifyPlaylist';
import type { NewPlaylistTrack, PlaylistTrackIdentity } from './spotifyPlaylistEdits';
import {
  matchThemeRowToPlaylistDetails,
  type PlaylistMatchOptions,
  type PlaylistMatchResult,
} from './spotifyPlaylistMatch';

/** Exact "not on playlist" rows; metadata matches may already be there as another edition. */
export function isPlaylistAddable(match: PlaylistMatchResult): boolean {
  return match.status === 'out' && match.metadataMatch == null;
}

/** Exact id/ISRC matches only: a metadata match has no known track to delete. */
export function isPlaylistRemovable(match: PlaylistMatchResult): boolean {
  return match.status === 'in' && match.metadataMatch == null;
}

/** The AniPlaylist-picked edition (from `spotifyUrl`) first, then the other ids. */
export function themeRowCandidateTrackIds(row: MediaThemeSongRow): string[] {
  const fromUrl = row.spotifyUrl ? parseSpotifyTrackIdFromUrl(row.spotifyUrl) : null;
  return [...new Set([...(fromUrl ? [fromUrl] : []), ...row.spotifyTrackIds])];
}

export function themeRowPlaylistIdentity(
  row: MediaThemeSongRow,
  trackIsrcById?: ReadonlyMap<string, string>,
): PlaylistTrackIdentity {
  const trackIds = themeRowCandidateTrackIds(row);
  const isrcs = new Set<string>();
  if (row.spotifyIsrc) {
    isrcs.add(row.spotifyIsrc);
  }
  for (const id of trackIds) {
    const isrc = trackIsrcById?.get(id);
    if (isrc) {
      isrcs.add(isrc);
    }
  }
  return { trackIds, isrcs: [...isrcs] };
}

export function themeRowNewPlaylistTrack(
  row: MediaThemeSongRow,
  trackIsrcById?: ReadonlyMap<string, string>,
): NewPlaylistTrack | null {
  const id = themeRowCandidateTrackIds(row)[0];
  if (!id) {
    return null;
  }
  return {
    id,
    title: row.displayTitle,
    artists: row.displayArtist ? [row.displayArtist] : [],
    isrc: trackIsrcById?.get(id) ?? row.spotifyIsrc ?? null,
  };
}

/** Rows sorted OP, ED, insert, then by their own order. */
export function sortThemeRowsForPlaylist(rows: readonly MediaThemeSongRow[]): MediaThemeSongRow[] {
  return [...rows].sort(
    (a, b) =>
      THEME_SONG_TYPE_ORDER.indexOf(a.type) - THEME_SONG_TYPE_ORDER.indexOf(b.type) ||
      a.sortOrder - b.sortOrder,
  );
}

export type PlaylistInsert = {
  /** 1-based position to insert after (0 = start); undefined appends. */
  afterPosition?: number;
  tracks: NewPlaylistTrack[];
};

/**
 * Where each added song goes, keeping the show's OP, ED, insert order next to
 * its songs already on the playlist. Example: OP1 at #10 and ED1 at #11, so
 * OP2 goes after #10. Songs ahead of every placed one go just before the first;
 * a show with nothing on the playlist is appended. Inserts are returned
 * last-position first, so running them in order never shifts a later anchor.
 */
export function planPlaylistInserts(
  showRows: readonly MediaThemeSongRow[],
  rowsToAdd: readonly MediaThemeSongRow[],
  cache: SpotifyPlaylistCache | null,
  options?: PlaylistMatchOptions,
): PlaylistInsert[] {
  const adding = new Set(rowsToAdd);
  const rows = sortThemeRowsForPlaylist([...new Set([...showRows, ...rowsToAdd])]);
  const seen = new Set<string>();
  const groups: Array<{ previous?: number; tracks: NewPlaylistTrack[] }> = [];
  let firstPlaced: number | undefined;
  let previous: number | undefined;
  for (const row of rows) {
    const match = matchThemeRowToPlaylistDetails(row, cache, options);
    if (isPlaylistRemovable(match) && match.playlistPosition != null) {
      previous = match.playlistPosition;
      firstPlaced ??= previous;
      continue;
    }
    if (!adding.has(row) || !isPlaylistAddable(match)) {
      continue;
    }
    const track = themeRowNewPlaylistTrack(row, options?.trackIsrcById);
    if (!track || seen.has(track.id)) {
      continue;
    }
    seen.add(track.id);
    const group = groups[groups.length - 1];
    if (group && group.previous === previous) {
      group.tracks.push(track);
    } else {
      groups.push({ previous, tracks: [track] });
    }
  }
  const inserts = groups.map(({ previous: anchor, tracks }, index) => ({
    index,
    afterPosition: anchor ?? (firstPlaced != null ? firstPlaced - 1 : undefined),
    tracks,
  }));
  inserts.sort(
    (a, b) => (b.afterPosition ?? Infinity) - (a.afterPosition ?? Infinity) || b.index - a.index,
  );
  return inserts.map(({ afterPosition, tracks }) => ({ afterPosition, tracks }));
}

export type NewPlaylistSongs = {
  trackIds: string[];
  showCount: number;
  unavailableCount: number;
};

/**
 * Songs for a new playlist, in show order then OP, ED, insert. Rows without a
 * Spotify track and repeated ids are skipped; market-unavailable songs are kept.
 */
export function collectNewPlaylistSongs(
  shows: ReadonlyArray<{ rows: readonly MediaThemeSongRow[] }>,
  spotifyCountry?: string | null,
): NewPlaylistSongs {
  const seen = new Set<string>();
  const trackIds: string[] = [];
  let showCount = 0;
  let unavailableCount = 0;
  for (const { rows } of shows) {
    let showAdded = false;
    for (const row of sortThemeRowsForPlaylist(rows)) {
      const id = themeRowCandidateTrackIds(row)[0];
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      trackIds.push(id);
      showAdded = true;
      if (isSpotifyUnavailableInMarket(row.spotifyAvailableMarkets, spotifyCountry)) {
        unavailableCount += 1;
      }
    }
    if (showAdded) showCount += 1;
  }
  return { trackIds, showCount, unavailableCount };
}

/** Tracks to add for `rows`, skipping ones already on the playlist and duplicate ids. */
export function addablePlaylistTracks(
  rows: readonly MediaThemeSongRow[],
  cache: SpotifyPlaylistCache | null,
  options?: PlaylistMatchOptions,
): NewPlaylistTrack[] {
  const seen = new Set<string>();
  const tracks: NewPlaylistTrack[] = [];
  for (const row of sortThemeRowsForPlaylist(rows)) {
    if (!isPlaylistAddable(matchThemeRowToPlaylistDetails(row, cache, options))) {
      continue;
    }
    const track = themeRowNewPlaylistTrack(row, options?.trackIsrcById);
    if (track && !seen.has(track.id)) {
      seen.add(track.id);
      tracks.push(track);
    }
  }
  return tracks;
}
