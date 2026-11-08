/** Best-guess playlist spot for a show with no songs on the playlist: right after its prequel's. */
import type { MediaThemeSongRow } from '../importers/anilist/themeSongs/types';
import type { SpotifyPlaylistCache } from './spotifyPlaylist';
import { matchThemeRowToPlaylistDetails, type PlaylistMatchOptions } from './spotifyPlaylistMatch';
import { isPlaylistRemovable } from './themeSongPlaylistEditing';

/** How far back the prequel chain is walked looking for a show with songs on the playlist. */
export const PREQUEL_ANCHOR_MAX_HOPS = 5;

export type PrequelAnchorReads = {
  /** Prequel media ids per show, from relations already in the local DB. */
  prequelIds: (mediaIds: readonly number[]) => Promise<Map<number, number[]>>;
  /** Cached theme-song rows per show; shows without a cache entry are left out. */
  themeRows: (mediaIds: readonly number[]) => Promise<Map<number, readonly MediaThemeSongRow[]>>;
};

/** Last playlist position (1-based) holding one of `rows`' exact matches. */
export function lastPlaylistPosition(
  rows: readonly MediaThemeSongRow[],
  cache: SpotifyPlaylistCache | null,
  options?: PlaylistMatchOptions,
): number | undefined {
  let last: number | undefined;
  for (const row of rows) {
    const match = matchThemeRowToPlaylistDetails(row, cache, options);
    if (isPlaylistRemovable(match) && match.playlistPosition != null) {
      last = Math.max(last ?? 0, match.playlistPosition);
    }
  }
  return last;
}

/**
 * Walks prequels breadth-first (nearest first) using only cached relations and
 * theme songs, and returns the last playlist position of the nearest prequel
 * generation that has songs on the playlist. Example: S3 with S2 not on the
 * playlist but S1 at #4–#6 → 6. Undefined when nothing is found.
 */
export async function findPrequelPlaylistAnchor(
  mediaId: number,
  cache: SpotifyPlaylistCache | null,
  reads: PrequelAnchorReads,
  options?: PlaylistMatchOptions,
): Promise<number | undefined> {
  if (!cache) {
    return undefined;
  }
  const visited = new Set([mediaId]);
  let frontier = [mediaId];
  for (let hop = 0; hop < PREQUEL_ANCHOR_MAX_HOPS && frontier.length > 0; hop++) {
    const prequelsById = await reads.prequelIds(frontier);
    const generation = [...new Set(frontier.flatMap((id) => prequelsById.get(id) ?? []))].filter(
      (id) => !visited.has(id),
    );
    generation.forEach((id) => visited.add(id));
    if (generation.length === 0) {
      return undefined;
    }
    const rowsById = await reads.themeRows(generation);
    let anchor: number | undefined;
    for (const id of generation) {
      const position = lastPlaylistPosition(rowsById.get(id) ?? [], cache, { ...options, mediaId: id });
      if (position != null) {
        anchor = Math.max(anchor ?? 0, position);
      }
    }
    if (anchor != null) {
      return anchor;
    }
    frontier = generation;
  }
  return undefined;
}
