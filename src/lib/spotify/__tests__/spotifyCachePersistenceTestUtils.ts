import type { SpotifyPlaylistCache } from '../spotifyPlaylist';
import type {
  SpotifyPlaylistCachePersistence,
  SpotifyTrackIsrcRecord,
} from '../spotifyPlaylistCacheDb';

export function createPlaylistCachePersistence(
  initialCaches: readonly SpotifyPlaylistCache[] = [],
): SpotifyPlaylistCachePersistence & {
  snapshot: () => SpotifyPlaylistCache[];
} {
  const caches = new Map(
    initialCaches.map((cache) => [cache.playlistId, structuredClone(cache)]),
  );
  return {
    readAll: async () =>
      [...caches.values()].map((cache) => structuredClone(cache)),
    put: async (cache) => {
      caches.set(cache.playlistId, structuredClone(cache));
    },
    clear: async () => {
      caches.clear();
    },
    deleteExcept: async (playlistIds) => {
      for (const playlistId of caches.keys()) {
        if (!playlistIds.has(playlistId)) {
          caches.delete(playlistId);
        }
      }
    },
    snapshot: () =>
      [...caches.values()].map((cache) => structuredClone(cache)),
  };
}

export function createTrackIsrcPersistence(
  initialRecords: readonly SpotifyTrackIsrcRecord[] = [],
): {
  readAll: () => Promise<SpotifyTrackIsrcRecord[]>;
  putAll: (records: SpotifyTrackIsrcRecord[]) => Promise<void>;
  clear: () => Promise<void>;
  snapshot: () => SpotifyTrackIsrcRecord[];
} {
  const recordsByTrackId = new Map(
    initialRecords.map((record) => [record.trackId, { ...record }]),
  );
  return {
    readAll: async () =>
      [...recordsByTrackId.values()].map((record) => ({ ...record })),
    putAll: async (records) => {
      for (const record of records) {
        recordsByTrackId.set(record.trackId, { ...record });
      }
    },
    clear: async () => {
      recordsByTrackId.clear();
    },
    snapshot: () =>
      [...recordsByTrackId.values()].map((record) => ({ ...record })),
  };
}
