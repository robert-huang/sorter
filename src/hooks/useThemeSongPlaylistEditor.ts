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
  themeRowPlaylistIdentity,
} from '../lib/spotify/themeSongPlaylistEditing';
import type { MediaThemeSongRow } from '../lib/importers/anilist/themeSongs/types';
import { useToolsPreferences } from './useToolsPreferences';

export type ThemeSongPlaylistEditor = {
  playlistName: string;
  allowRemove: boolean;
  /** Adds the rows' missing songs in show order beside the show's songs on the playlist, else at the end. */
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
      const inserts = planPlaylistInserts(showRows, rows, getPlaylistCache(), options);
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
