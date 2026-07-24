import type { CachedPlaylistTrack } from './spotifyPlaylist';
import { isSpotifyApiBanned } from './spotifyApi';
import { fetchSpotifyIsrcByTrackIds } from '../importers/anilist/themeSongs/spotifyIsrc';

const STORAGE_KEY = 'spotify:track-isrc:v1';

type TrackIsrcStore = Record<string, string>;

function readStore(): TrackIsrcStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const out: TrackIsrcStore = {};
    for (const [trackId, isrc] of Object.entries(parsed)) {
      if (typeof trackId === 'string' && typeof isrc === 'string' && isrc.length > 0) {
        out[trackId] = isrc;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(store: TrackIsrcStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* ignore quota */
  }
}

export function getCachedTrackIsrc(trackId: string): string | null {
  return readStore()[trackId] ?? null;
}

export function getTrackIsrcStoreSnapshot(): ReadonlyMap<string, string> {
  return new Map(Object.entries(readStore()));
}

export function mergeTrackIsrcsIntoStore(isrcById: ReadonlyMap<string, string>): void {
  if (isrcById.size === 0) {
    return;
  }
  const store = readStore();
  let changed = false;
  for (const [trackId, isrc] of isrcById) {
    if (store[trackId] !== isrc) {
      store[trackId] = isrc;
      changed = true;
    }
  }
  if (changed) {
    writeStore(store);
  }
}

export function applyIsrcMapToPlaylistTracks(
  tracks: readonly CachedPlaylistTrack[],
  isrcById: ReadonlyMap<string, string>,
): CachedPlaylistTrack[] {
  if (isrcById.size === 0) {
    return [...tracks];
  }
  return tracks.map((track) => {
    const isrc = track.isrc ?? isrcById.get(track.id) ?? null;
    return isrc === track.isrc ? track : { ...track, isrc };
  });
}

/** Apply persisted track→ISRC mappings without hitting Spotify. */
export function applyTrackIsrcStoreToPlaylistTracks(
  tracks: readonly CachedPlaylistTrack[],
): CachedPlaylistTrack[] {
  const store = readStore();
  if (Object.keys(store).length === 0) {
    return [...tracks];
  }
  const isrcById = new Map<string, string>();
  for (const track of tracks) {
    const isrc = store[track.id];
    if (isrc) {
      isrcById.set(track.id, isrc);
    }
  }
  return applyIsrcMapToPlaylistTracks(tracks, isrcById);
}

export function listPlaylistTracksMissingIsrc(tracks: readonly CachedPlaylistTrack[]): string[] {
  return tracks.filter((track) => !track.isrc).map((track) => track.id);
}

/** Fetch missing ISRCs from Spotify and persist in localStorage. */
export async function ensureTrackIsrcsCached(
  trackIds: readonly string[],
  accessToken?: string | null,
): Promise<ReadonlyMap<string, string>> {
  const store = readStore();
  const missing = [...new Set(trackIds)].filter((id) => !store[id]);
  if (missing.length > 0 && !isSpotifyApiBanned()) {
    const fetched = await fetchSpotifyIsrcByTrackIds(missing, accessToken);
    mergeTrackIsrcsIntoStore(fetched);
  }
  return getTrackIsrcStoreSnapshot();
}

/** Test-only reset. */
export function _clearTrackIsrcStoreForTesting(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
