import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { getStoredSpotifyAuth, subscribeSpotifyAuth } from '../lib/spotify/spotifyAuth';
import {
  getPlaylistCache,
  getSelectedSpotifyPlaylist,
  subscribeSpotifyPlaylist,
} from '../lib/spotify/spotifyPlaylist';
import {
  insertTracksIntoSelectedPlaylist,
  removeTrackFromSelectedPlaylist,
} from '../lib/spotify/spotifyPlaylistEdits';
import type { PlaylistMatchOptions } from '../lib/spotify/spotifyPlaylistMatch';
import {
  planPlaylistInserts,
  showHasPlacedSongs,
  themeRowPlaylistIdentity,
} from '../lib/spotify/themeSongPlaylistEditing';
import {
  findPrequelPlaylistAnchor,
  type PrequelAnchorReads,
} from '../lib/spotify/prequelPlaylistAnchor';
import { productionReads } from '../lib/importers/anilist/readQueries';
import type { MediaThemeSongRow } from '../lib/importers/anilist/themeSongs/types';
import { useToolsPreferences } from './useToolsPreferences';

const cachedPrequelAnchorReads: PrequelAnchorReads = {
  prequelIds: async (mediaIds) => {
    const relations = await productionReads.getToolsMediaRelationsFromDbBatch(mediaIds);
    return new Map(
      [...relations].map(([id, { edges }]) => [
        id,
        edges.filter((edge) => edge.relationType === 'PREQUEL').map((edge) => edge.node.id),
      ]),
    );
  },
  themeRows: async (mediaIds) => {
    const payloads = await productionReads.getMediaThemeSongsExpansionsBatch(mediaIds);
    return new Map([...payloads].map(([id, payload]) => [id, payload.rows]));
  },
};

/** After the prequel's songs when the show has none on the playlist; a failed lookup just appends. */
async function emptyShowAfterPosition(
  showRows: readonly MediaThemeSongRow[],
  options: PlaylistMatchOptions,
): Promise<number | undefined> {
  const cache = getPlaylistCache();
  if (options.mediaId == null || showHasPlacedSongs(showRows, cache, options)) {
    return undefined;
  }
  try {
    return await findPrequelPlaylistAnchor(options.mediaId, cache, cachedPrequelAnchorReads, options);
  } catch {
    return undefined;
  }
}

export type ThemeSongPlaylistEditor = {
  playlistName: string;
  allowRemove: boolean;
  /** Adds the rows' missing songs in show order beside the show's songs on the playlist, else after its prequel's, else at the end. */
  addRows: (rows: readonly MediaThemeSongRow[]) => Promise<void>;
  removeRow: (row: MediaThemeSongRow) => Promise<void>;
};

export function useSelectedPlaylistName(): string | null {
  return useSyncExternalStore(
    subscribeSpotifyPlaylist,
    () => getSelectedSpotifyPlaylist()?.name ?? null,
  );
}

export function useSpotifySignedIn(): boolean {
  return useSyncExternalStore(subscribeSpotifyAuth, () => getStoredSpotifyAuth() != null);
}

/** Playlist editing for one show's theme songs; null when no playlist is selected or signed out. */
export function useThemeSongPlaylistEditor(
  showRows: readonly MediaThemeSongRow[],
  options: PlaylistMatchOptions,
): ThemeSongPlaylistEditor | null {
  const playlistName = useSelectedPlaylistName();
  const signedIn = useSpotifySignedIn();
  const { prefs } = useToolsPreferences();

  const addRows = useCallback(
    async (rows: readonly MediaThemeSongRow[]): Promise<void> => {
      const afterPrequel = await emptyShowAfterPosition(showRows, options);
      const inserts = planPlaylistInserts(showRows, rows, getPlaylistCache(), options, afterPrequel);
      if (inserts.length === 0) {
        throw new Error('Nothing to add: these songs have no Spotify track.');
      }
      for (const { tracks, afterPosition } of inserts) {
        await insertTracksIntoSelectedPlaylist(tracks, { afterPosition });
      }
    },
    [options, showRows],
  );

  const removeRow = useCallback(
    async (row: MediaThemeSongRow): Promise<void> => {
      await removeTrackFromSelectedPlaylist(themeRowPlaylistIdentity(row, options.trackIsrcById));
    },
    [options],
  );

  return useMemo(
    () =>
      playlistName && signedIn
        ? {
            playlistName,
            allowRemove: prefs.weeklyCalendarAllowPlaylistRemoval,
            addRows,
            removeRow,
          }
        : null,
    [addRows, playlistName, prefs.weeklyCalendarAllowPlaylistRemoval, removeRow, signedIn],
  );
}
