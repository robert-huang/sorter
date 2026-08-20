import type { CachedPlaylistTrack } from './spotifyPlaylist';
import { isSpotifyApiBanned } from './spotifyApi';
import {
  fetchSpotifyIsrcByTrackIds,
  type SpotifyTrackIsrcProgressCallback,
} from '../importers/anilist/themeSongs/spotifyIsrc';
import {
  clearSpotifyTrackIsrcs,
  putSpotifyTrackIsrcs,
  readAllSpotifyTrackIsrcs,
} from './spotifyPlaylistCacheDb';

export const TRACK_ISRC_STORAGE_KEY = 'spotify:track-isrc:v1';

type TrackIsrcStore = Record<string, string>;

function readLegacyStore(): TrackIsrcStore {
  try {
    const raw = localStorage.getItem(TRACK_ISRC_STORAGE_KEY);
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

let trackIsrcStore: TrackIsrcStore | null = null;
let trackIsrcHydration: Promise<void> | null = null;
let demandedTrackIds: string[] = [];

export type SpotifyTrackIsrcDemand = {
  total: number;
  missing: number;
};

let trackIsrcDemand: SpotifyTrackIsrcDemand = {
  total: 0,
  missing: 0,
};
const trackIsrcDemandListeners = new Set<() => void>();

function getMemoryStore(): TrackIsrcStore {
  if (!trackIsrcStore) {
    trackIsrcStore = readLegacyStore();
  }
  return trackIsrcStore;
}

function refreshTrackIsrcDemand(trackIds?: readonly string[]): void {
  if (trackIds) {
    demandedTrackIds = [...new Set(trackIds)];
  }
  const store = getMemoryStore();
  const next: SpotifyTrackIsrcDemand = {
    total: demandedTrackIds.length,
    missing: demandedTrackIds.filter((trackId) => !store[trackId]).length,
  };
  if (
    next.total === trackIsrcDemand.total &&
    next.missing === trackIsrcDemand.missing
  ) {
    return;
  }
  trackIsrcDemand = next;
  for (const listener of trackIsrcDemandListeners) {
    listener();
  }
}

export function getSpotifyTrackIsrcDemand(): SpotifyTrackIsrcDemand {
  return trackIsrcDemand;
}

export function subscribeSpotifyTrackIsrcDemand(
  listener: () => void,
): () => void {
  trackIsrcDemandListeners.add(listener);
  return () => {
    trackIsrcDemandListeners.delete(listener);
  };
}

function removeLegacyStore(): void {
  try {
    localStorage.removeItem(TRACK_ISRC_STORAGE_KEY);
  } catch {
    /* The durable cache is already saved; stale local data can be retried next load. */
  }
}

/** Hydrate the synchronous ISRC lookup snapshot and migrate its localStorage predecessor. */
export function hydrateTrackIsrcStore(): Promise<void> {
  if (trackIsrcHydration) {
    return trackIsrcHydration;
  }
  trackIsrcHydration = (async () => {
    const legacyStore = getMemoryStore();
    const durableRecords = await readAllSpotifyTrackIsrcs();
    const mergedStore: TrackIsrcStore = {};
    for (const record of durableRecords) {
      if (record.trackId && record.isrc) {
        mergedStore[record.trackId] = record.isrc;
      }
    }

    const migrationRecords = Object.entries(legacyStore)
      .filter(([trackId, isrc]) => mergedStore[trackId] !== isrc)
      .map(([trackId, isrc]) => ({ trackId, isrc }));
    await putSpotifyTrackIsrcs(migrationRecords);
    Object.assign(mergedStore, legacyStore);
    trackIsrcStore = mergedStore;
    removeLegacyStore();
  })().catch(() => {
    // The auxiliary ISRC index is best-effort; the current session keeps using memory.
    trackIsrcStore = getMemoryStore();
  });
  return trackIsrcHydration;
}

export function getCachedTrackIsrc(trackId: string): string | null {
  return getMemoryStore()[trackId] ?? null;
}

export function getTrackIsrcStoreSnapshot(): ReadonlyMap<string, string> {
  return new Map(Object.entries(getMemoryStore()));
}

export async function mergeTrackIsrcsIntoStore(
  isrcById: ReadonlyMap<string, string>,
): Promise<void> {
  if (isrcById.size === 0) {
    return;
  }
  await hydrateTrackIsrcStore();
  const store = getMemoryStore();
  const changedRecords: { trackId: string; isrc: string }[] = [];
  for (const [trackId, isrc] of isrcById) {
    if (store[trackId] !== isrc) {
      changedRecords.push({ trackId, isrc });
    }
  }
  if (changedRecords.length > 0) {
    try {
      await putSpotifyTrackIsrcs(changedRecords);
    } catch {
      // Playlist rows still retain fetched ISRCs even if this reusable index cannot persist.
    }
    for (const { trackId, isrc } of changedRecords) {
      store[trackId] = isrc;
    }
    refreshTrackIsrcDemand();
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
  const store = getMemoryStore();
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
  const missingTrackIds = new Set<string>();
  for (const track of tracks) {
    if (!track.isrc) {
      // Preserve first appearance in playlist order without scheduling duplicate lookups.
      missingTrackIds.add(track.id);
    }
  }
  return [...missingTrackIds];
}

/** Fetch missing ISRCs from Spotify and persist them in IndexedDB. */
export async function ensureTrackIsrcsCached(
  trackIds: readonly string[],
  accessToken?: string | null,
  onProgress?: SpotifyTrackIsrcProgressCallback,
): Promise<ReadonlyMap<string, string>> {
  await hydrateTrackIsrcStore();
  const store = getMemoryStore();
  const uniqueTrackIds = [...new Set(trackIds)];
  refreshTrackIsrcDemand(uniqueTrackIds);
  const missing = uniqueTrackIds.filter((id) => !store[id]);
  const cachedCount = uniqueTrackIds.length - missing.length;
  onProgress?.({ completed: cachedCount, total: uniqueTrackIds.length });
  if (missing.length > 0 && !isSpotifyApiBanned('tracks')) {
    const fetched = await fetchSpotifyIsrcByTrackIds(
      missing,
      accessToken,
      ({ completed }) => {
        onProgress?.({
          completed: cachedCount + completed,
          total: uniqueTrackIds.length,
        });
      },
    );
    await mergeTrackIsrcsIntoStore(fetched);
  }
  return getTrackIsrcStoreSnapshot();
}

/** Test-only reset. */
export async function _clearTrackIsrcStoreForTesting(): Promise<void> {
  try {
    localStorage.removeItem(TRACK_ISRC_STORAGE_KEY);
    await clearSpotifyTrackIsrcs();
  } catch {
    /* ignore */
  }
  trackIsrcStore = null;
  trackIsrcHydration = null;
  demandedTrackIds = [];
  trackIsrcDemand = { total: 0, missing: 0 };
  for (const listener of trackIsrcDemandListeners) {
    listener();
  }
}
