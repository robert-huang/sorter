import { fetchSpotifyIsrcByTrackIds } from '../importers/anilist/themeSongs/spotifyIsrc';
import { isSpotifyApiBanned } from './spotifyApi';
import {
  applyIsrcMapToPlaylistTracks,
  applyTrackIsrcStoreToPlaylistTracks,
  listPlaylistTracksMissingIsrc,
} from './spotifyTrackIsrcStore';
import { getPlaylistCache, updatePlaylistCacheTracks } from './spotifyPlaylist';

/** Tracks fetched per background ISRC backfill iteration (Spotify batch max). */
export const PLAYLIST_ISRC_BACKFILL_BATCH_SIZE = 50;

/** Pause between batched ISRC API calls during background backfill. */
export const PLAYLIST_ISRC_BACKFILL_DELAY_MS = 250;

export type PlaylistIsrcBackfillStatus = 'idle' | 'running' | 'paused';

export type PlaylistIsrcBackfillState = {
  status: PlaylistIsrcBackfillStatus;
  playlistId: string | null;
  /** Tracks still missing ISRC when the current run started or last updated. */
  total: number;
  /** Tracks that now have ISRC since this run started. */
  completed: number;
};

export const SPOTIFY_PLAYLIST_ISRC_BACKFILL_CHANGED = 'spotify-playlist-isrc-backfill-changed';

const listeners = new Set<() => void>();

let state: PlaylistIsrcBackfillState = {
  status: 'idle',
  playlistId: null,
  total: 0,
  completed: 0,
};

let runToken = 0;

function emitState(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SPOTIFY_PLAYLIST_ISRC_BACKFILL_CHANGED));
  }
}

function setState(patch: Partial<PlaylistIsrcBackfillState>): void {
  state = { ...state, ...patch };
  emitState();
}

export function getPlaylistIsrcBackfillState(): PlaylistIsrcBackfillState {
  return state;
}

export function subscribePlaylistIsrcBackfill(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Cancel any in-flight background ISRC backfill. */
export function stopPlaylistIsrcBackfill(): void {
  runToken += 1;
  if (state.status !== 'idle') {
    setState({ status: 'idle', playlistId: null, total: 0, completed: 0 });
  }
}

function patchPlaylistCacheTracks(
  playlistId: string,
  tracks: ReturnType<typeof applyTrackIsrcStoreToPlaylistTracks>,
): boolean {
  return updatePlaylistCacheTracks(playlistId, tracks);
}

/**
 * Fill playlist-track ISRCs in the background after a playlist refresh.
 * Applies the local track-ISRC store first, then batches Spotify API lookups.
 */
export function startPlaylistIsrcBackfill(playlistId: string, accessToken: string): void {
  if (state.status === 'running' && state.playlistId === playlistId) {
    return;
  }

  const token = ++runToken;
  void runPlaylistIsrcBackfill(playlistId, accessToken, token);
}

async function runPlaylistIsrcBackfill(
  playlistId: string,
  accessToken: string,
  token: number,
): Promise<void> {
  const cache = getPlaylistCache();
  if (!cache || cache.playlistId !== playlistId) {
    return;
  }

  let tracks = applyTrackIsrcStoreToPlaylistTracks(cache.tracks);
  patchPlaylistCacheTracks(playlistId, tracks);

  let missing = listPlaylistTracksMissingIsrc(tracks);
  const initialMissing = missing.length;
  if (initialMissing === 0) {
    setState({ status: 'idle', playlistId: null, total: 0, completed: 0 });
    return;
  }

  setState({
    status: 'running',
    playlistId,
    total: initialMissing,
    completed: 0,
  });

  while (missing.length > 0 && token === runToken) {
    if (isSpotifyApiBanned()) {
      setState({ status: 'paused', playlistId, total: initialMissing, completed: initialMissing - missing.length });
      return;
    }

    const batch = missing.slice(0, PLAYLIST_ISRC_BACKFILL_BATCH_SIZE);
    const fetched = await fetchSpotifyIsrcByTrackIds(batch, accessToken);
    if (token !== runToken) {
      return;
    }

    tracks = applyIsrcMapToPlaylistTracks(tracks, fetched);
    if (!patchPlaylistCacheTracks(playlistId, tracks)) {
      setState({ status: 'idle', playlistId: null, total: 0, completed: 0 });
      return;
    }

    missing = listPlaylistTracksMissingIsrc(tracks);
    setState({
      status: 'running',
      playlistId,
      total: initialMissing,
      completed: initialMissing - missing.length,
    });

    if (missing.length === 0) {
      break;
    }

    if (isSpotifyApiBanned()) {
      setState({ status: 'paused', playlistId, total: initialMissing, completed: initialMissing - missing.length });
      return;
    }

    await delay(PLAYLIST_ISRC_BACKFILL_DELAY_MS);
  }

  if (token === runToken) {
    setState({ status: 'idle', playlistId: null, total: 0, completed: 0 });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Test-only reset. */
export function _resetPlaylistIsrcBackfillForTesting(): void {
  stopPlaylistIsrcBackfill();
  state = { status: 'idle', playlistId: null, total: 0, completed: 0 };
  emitState();
}
