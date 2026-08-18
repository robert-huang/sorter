import { fetchSpotifyIsrcByTrackIds } from '../importers/anilist/themeSongs/spotifyIsrc';
import { getSpotifyApiBannedUntil, isSpotifyApiBanned } from './spotifyApi';
import {
  applyIsrcMapToPlaylistTracks,
  applyTrackIsrcStoreToPlaylistTracks,
  hydrateTrackIsrcStore,
  listPlaylistTracksMissingIsrc,
} from './spotifyTrackIsrcStore';
import {
  getPlaylistCache,
  hydrateSpotifyPlaylistCaches,
  updatePlaylistCacheTracks,
} from './spotifyPlaylist';

/** Tracks per backfill iteration — each ID is a separate `GET /tracks/{id}` call. */
export const PLAYLIST_ISRC_BACKFILL_BATCH_SIZE = 5;

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
let resumeTimer: ReturnType<typeof setTimeout> | null = null;

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
  if (resumeTimer !== null) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  if (state.status !== 'idle') {
    setState({ status: 'idle', playlistId: null, total: 0, completed: 0 });
  }
}

function patchPlaylistCacheTracks(
  playlistId: string,
  tracks: ReturnType<typeof applyTrackIsrcStoreToPlaylistTracks>,
): Promise<boolean> {
  return updatePlaylistCacheTracks(playlistId, tracks);
}

/**
 * Fill missing playlist-track ISRCs in the background from the existing cache.
 * Applies the local track-ISRC store first, then batches Spotify API lookups.
 */
export function startPlaylistIsrcBackfill(playlistId: string): void {
  if (state.status === 'running' && state.playlistId === playlistId) {
    return;
  }

  if (resumeTimer !== null) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  const token = ++runToken;
  void runPlaylistIsrcBackfill(playlistId, token).catch(() => {
    setState({ status: 'idle', playlistId: null, total: 0, completed: 0 });
  });
}

function pauseUntilTrackCooldownEnds(
  playlistId: string,
  token: number,
  total: number,
  completed: number,
): void {
  setState({ status: 'paused', playlistId, total, completed });
  const bannedUntil = getSpotifyApiBannedUntil('tracks');
  const waitMs = Math.max(1_000, (bannedUntil ?? Date.now()) - Date.now() + 1_000);
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    if (token !== runToken) {
      return;
    }
    if (isSpotifyApiBanned('tracks')) {
      pauseUntilTrackCooldownEnds(playlistId, token, total, completed);
      return;
    }
    void runPlaylistIsrcBackfill(playlistId, token).catch(() => {
      setState({ status: 'idle', playlistId: null, total: 0, completed: 0 });
    });
  }, waitMs);
}

async function runPlaylistIsrcBackfill(
  playlistId: string,
  token: number,
): Promise<void> {
  await Promise.all([
    hydrateSpotifyPlaylistCaches(),
    hydrateTrackIsrcStore(),
  ]);
  const cache = getPlaylistCache(playlistId);
  if (!cache) {
    return;
  }

  let tracks = applyTrackIsrcStoreToPlaylistTracks(cache.tracks);
  if (!(await patchPlaylistCacheTracks(playlistId, tracks))) {
    return;
  }

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
    if (isSpotifyApiBanned('tracks')) {
      pauseUntilTrackCooldownEnds(
        playlistId,
        token,
        initialMissing,
        initialMissing - missing.length,
      );
      return;
    }

    const batch = missing.slice(0, PLAYLIST_ISRC_BACKFILL_BATCH_SIZE);
    // Resolve auth for each chunk so a long cooldown cannot resume with an expired token.
    const fetched = await fetchSpotifyIsrcByTrackIds(batch);
    if (token !== runToken) {
      return;
    }

    tracks = applyIsrcMapToPlaylistTracks(tracks, fetched);
    if (!(await patchPlaylistCacheTracks(playlistId, tracks))) {
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

    if (isSpotifyApiBanned('tracks')) {
      pauseUntilTrackCooldownEnds(
        playlistId,
        token,
        initialMissing,
        initialMissing - missing.length,
      );
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
