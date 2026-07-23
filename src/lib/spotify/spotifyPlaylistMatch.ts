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
