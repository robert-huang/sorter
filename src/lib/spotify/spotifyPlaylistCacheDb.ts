import type { SpotifyPlaylistCache } from './spotifyPlaylist';

const DATABASE_NAME = 'queue-sorter-spotify';
const DATABASE_VERSION = 1;
const PLAYLIST_CACHE_STORE = 'playlistCaches';
const TRACK_ISRC_STORE = 'trackIsrcs';

export type SpotifyTrackIsrcRecord = {
  trackId: string;
  isrc: string;
};

export type SpotifyPlaylistCachePersistence = {
  readAll: () => Promise<SpotifyPlaylistCache[]>;
  put: (cache: SpotifyPlaylistCache) => Promise<void>;
  clear: () => Promise<void>;
};

let databasePromise: Promise<IDBDatabase> | null = null;
let persistenceOverride: SpotifyPlaylistCachePersistence | null = null;
let trackIsrcPersistenceOverride: {
  readAll: () => Promise<SpotifyTrackIsrcRecord[]>;
  putAll: (records: SpotifyTrackIsrcRecord[]) => Promise<void>;
  clear: () => Promise<void>;
} | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) {
    return databasePromise;
  }
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable.'));
  }
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PLAYLIST_CACHE_STORE)) {
        database.createObjectStore(PLAYLIST_CACHE_STORE, { keyPath: 'playlistId' });
      }
      if (!database.objectStoreNames.contains(TRACK_ISRC_STORE)) {
        database.createObjectStore(TRACK_ISRC_STORE, { keyPath: 'trackId' });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB.'));
    request.onblocked = () => reject(new Error('Spotify cache database upgrade is blocked.'));
  });
  databasePromise = opening.catch((error: unknown) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

async function readAllFromIndexedDb(): Promise<SpotifyPlaylistCache[]> {
  const database = await openDatabase();
  return new Promise<SpotifyPlaylistCache[]>((resolve, reject) => {
    const transaction = database.transaction(PLAYLIST_CACHE_STORE, 'readonly');
    const request = transaction.objectStore(PLAYLIST_CACHE_STORE).getAll();
    request.onsuccess = () => resolve(request.result as SpotifyPlaylistCache[]);
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to read Spotify playlist caches.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Spotify cache read transaction aborted.'));
  });
}

async function putInIndexedDb(cache: SpotifyPlaylistCache): Promise<void> {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PLAYLIST_CACHE_STORE, 'readwrite');
    transaction.objectStore(PLAYLIST_CACHE_STORE).put(cache);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Failed to save Spotify playlist cache.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Spotify cache write transaction aborted.'));
  });
}

async function clearIndexedDb(): Promise<void> {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PLAYLIST_CACHE_STORE, 'readwrite');
    transaction.objectStore(PLAYLIST_CACHE_STORE).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Failed to clear Spotify playlist caches.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Spotify cache clear transaction aborted.'));
  });
}

async function readAllTrackIsrcsFromIndexedDb(): Promise<SpotifyTrackIsrcRecord[]> {
  const database = await openDatabase();
  return new Promise<SpotifyTrackIsrcRecord[]>((resolve, reject) => {
    const transaction = database.transaction(TRACK_ISRC_STORE, 'readonly');
    const request = transaction.objectStore(TRACK_ISRC_STORE).getAll();
    request.onsuccess = () => resolve(request.result as SpotifyTrackIsrcRecord[]);
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to read Spotify track ISRC cache.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Spotify ISRC cache read transaction aborted.'));
  });
}

async function putTrackIsrcsInIndexedDb(records: SpotifyTrackIsrcRecord[]): Promise<void> {
  if (records.length === 0) {
    return;
  }
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(TRACK_ISRC_STORE, 'readwrite');
    const store = transaction.objectStore(TRACK_ISRC_STORE);
    for (const record of records) {
      store.put(record);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Failed to save Spotify track ISRC cache.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Spotify ISRC cache write transaction aborted.'));
  });
}

async function clearTrackIsrcsInIndexedDb(): Promise<void> {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(TRACK_ISRC_STORE, 'readwrite');
    transaction.objectStore(TRACK_ISRC_STORE).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Failed to clear Spotify track ISRC cache.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Spotify ISRC cache clear transaction aborted.'));
  });
}

function persistence(): SpotifyPlaylistCachePersistence {
  return (
    persistenceOverride ?? {
      readAll: readAllFromIndexedDb,
      put: putInIndexedDb,
      clear: clearIndexedDb,
    }
  );
}

export function readAllSpotifyPlaylistCaches(): Promise<SpotifyPlaylistCache[]> {
  return persistence().readAll();
}

export function putSpotifyPlaylistCache(cache: SpotifyPlaylistCache): Promise<void> {
  return persistence().put(cache);
}

export function clearSpotifyPlaylistCaches(): Promise<void> {
  return persistence().clear();
}

export function readAllSpotifyTrackIsrcs(): Promise<SpotifyTrackIsrcRecord[]> {
  return (trackIsrcPersistenceOverride?.readAll ?? readAllTrackIsrcsFromIndexedDb)();
}

export function putSpotifyTrackIsrcs(records: SpotifyTrackIsrcRecord[]): Promise<void> {
  return (trackIsrcPersistenceOverride?.putAll ?? putTrackIsrcsInIndexedDb)(records);
}

export function clearSpotifyTrackIsrcs(): Promise<void> {
  return (trackIsrcPersistenceOverride?.clear ?? clearTrackIsrcsInIndexedDb)();
}

/** Test-only persistence injection and connection reset. */
export function _setSpotifyPlaylistCachePersistenceForTesting(
  next: SpotifyPlaylistCachePersistence | null,
): void {
  persistenceOverride = next;
  void databasePromise?.then(
    (database) => database.close(),
    () => {},
  );
  databasePromise = null;
}

/** Test-only track-ISRC persistence injection and connection reset. */
export function _setSpotifyTrackIsrcPersistenceForTesting(
  next: typeof trackIsrcPersistenceOverride,
): void {
  trackIsrcPersistenceOverride = next;
  void databasePromise?.then(
    (database) => database.close(),
    () => {},
  );
  databasePromise = null;
}
