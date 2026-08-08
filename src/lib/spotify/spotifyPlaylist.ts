import { spotifyApiFetch } from './spotifyApi';
import { ensureSpotifyAccessToken, getStoredSpotifyAuth } from './spotifyAuth';
import {
  applyTrackIsrcStoreToPlaylistTracks,
  hydrateTrackIsrcStore,
} from './spotifyTrackIsrcStore';
import {
  clearSpotifyPlaylistCaches,
  clearSpotifyPlaylistCachesExcept,
  measureSpotifyCacheDatabase,
  putSpotifyPlaylistCache,
  readAllSpotifyPlaylistCaches,
} from './spotifyPlaylistCacheDb';
import { registerDisposableCacheOwner } from '../disposableCacheRegistry';

export { formatSpotifyApiBanMessage, getSpotifyApiBannedUntil, SpotifyApiRateLimitedError } from './spotifyApi';

export const PLAYLIST_STORAGE_KEY = 'spotify:playlist:v1';
/** Legacy single-playlist blob — migrated into {@link PLAYLIST_CACHE_STORAGE_KEY} on read. */
export const LEGACY_PLAYLIST_CACHE_STORAGE_KEY = 'spotify:playlist-cache:v1';
/** Keyed by playlist id so switching playlists reuses prior refreshes. */
export const PLAYLIST_CACHE_STORAGE_KEY = 'spotify:playlist-cache:v2';

/** Stale hint only — no auto-refetch. */
export const PLAYLIST_CACHE_STALE_MS = 15 * 60 * 1000;
export const PLAYLIST_CACHE_METADATA_VERSION = 1;

export type StoredSpotifyPlaylist = {
  id: string;
  name: string;
};

export type CachedPlaylistTrackMetadata = {
  title: string;
  artists: string[];
  album: string | null;
  durationMs: number | null;
  /** One-based item number in the fetched playlist order. */
  playlistPosition: number;
};

export type CachedPlaylistTrack = {
  id: string;
  isrc: string | null;
  linkedFromIds: string[];
  metadata?: CachedPlaylistTrackMetadata;
};

export type CachedLocalPlaylistTrack = CachedPlaylistTrackMetadata & {
  /** Spotify's metadata-derived local URI; not a catalog track identifier. */
  uri: string | null;
};

export type SpotifyPlaylistCache = {
  playlistId: string;
  fetchedAt: number;
  /** Monotonic cache-content revision, including background ISRC updates. */
  revision?: number;
  tracks: CachedPlaylistTrack[];
  /** Local files have no Spotify id or ISRC, so their descriptive metadata is cached separately. */
  localTracks?: CachedLocalPlaylistTrack[];
  /** Schema marker for descriptive metadata on both catalog and local tracks. */
  metadataVersion?: number;
  /** Spotify-reported item count, including local files. */
  trackTotal?: number;
  /** Number of playlist items fetched, including local files stored in `localTracks`. */
  playlistItemsFetched?: number;
  /** The fetch reached Spotify's terminal short page without an API error. */
  paginationComplete?: boolean;
};

type SpotifyPlaylistSummary = {
  id: string;
  name: string;
};

type SpotifyPlaylistListItem = {
  id?: string;
  name?: string;
  owner?: { id?: string };
  collaborative?: boolean;
};

type SpotifyPlaylistsResponse = {
  items?: Array<SpotifyPlaylistListItem | null>;
  next?: string | null;
  total?: number;
  offset?: number;
  limit?: number;
};

type SpotifyPlaylistTrackObject = {
  id?: string | null;
  type?: string;
  name?: string | null;
  is_local?: boolean;
  uri?: string | null;
  duration_ms?: number | null;
  external_ids?: { isrc?: string | null };
  artists?: Array<{ name?: string | null } | null>;
  album?: { name?: string | null } | null;
};

type SpotifyPlaylistTrackItem = {
  is_local?: boolean;
  /** Legacy field (pre–Feb 2026). */
  track?: SpotifyPlaylistTrackObject | null;
  /** Current field (`GET /playlists/{id}/items`). */
  item?: SpotifyPlaylistTrackObject | null;
  linked_from?: { id?: string } | null;
};

type SpotifyPlaylistTracksResponse = {
  items?: SpotifyPlaylistTrackItem[];
  next?: string | null;
  total?: number;
};

export type FetchPlaylistTracksResult = {
  tracks: CachedPlaylistTrack[];
  localTracks: CachedLocalPlaylistTrack[];
  trackTotal: number | null;
  playlistItemsFetched: number;
  paginationComplete: boolean;
};

export const SPOTIFY_PLAYLIST_CHANGED = 'spotify-playlist-changed';

const listeners = new Set<() => void>();

function emitPlaylistChange(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SPOTIFY_PLAYLIST_CHANGED));
  }
}

export function subscribeSpotifyPlaylist(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSelectedSpotifyPlaylist(): StoredSpotifyPlaylist | null {
  try {
    const raw = localStorage.getItem(PLAYLIST_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredSpotifyPlaylist>;
    if (!parsed.id || !parsed.name) {
      return null;
    }
    return { id: parsed.id, name: parsed.name };
  } catch {
    return null;
  }
}

export function setSelectedSpotifyPlaylist(playlist: StoredSpotifyPlaylist): void {
  let stored = false;
  try {
    localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(playlist));
    stored = true;
  } catch {
    /* ignore */
  }
  if (stored) {
    playlistCleanupSelectedIds?.add(playlist.id);
  }
  emitPlaylistChange();
}

export function clearSelectedSpotifyPlaylist(): void {
  try {
    localStorage.removeItem(PLAYLIST_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  emitPlaylistChange();
}

/** Keep the stored selection visible when the playlist list API call fails. */
export function mergeSelectedPlaylistIntoOptions(
  playlists: readonly StoredSpotifyPlaylist[],
  selected: StoredSpotifyPlaylist | null,
): StoredSpotifyPlaylist[] {
  if (!selected) {
    return [...playlists];
  }
  if (playlists.some((playlist) => playlist.id === selected.id)) {
    return [...playlists];
  }
  return [selected, ...playlists];
}

type PlaylistCacheStore = Record<string, SpotifyPlaylistCache>;

function parseCachedPlaylistTrackMetadata(raw: unknown): CachedPlaylistTrackMetadata | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const parsed = raw as Partial<CachedPlaylistTrackMetadata>;
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  if (
    !title ||
    !Array.isArray(parsed.artists) ||
    !Number.isInteger(parsed.playlistPosition) ||
    (parsed.playlistPosition ?? 0) <= 0
  ) {
    return null;
  }
  return {
    title,
    artists: parsed.artists
      .filter((artist): artist is string => typeof artist === 'string')
      .map((artist) => artist.trim())
      .filter((artist) => artist.length > 0),
    album: typeof parsed.album === 'string' && parsed.album.trim() ? parsed.album.trim() : null,
    durationMs:
      typeof parsed.durationMs === 'number' && parsed.durationMs >= 0
        ? parsed.durationMs
        : null,
    playlistPosition: parsed.playlistPosition as number,
  };
}

function parseCachedLocalPlaylistTrack(raw: unknown): CachedLocalPlaylistTrack | null {
  const metadata = parseCachedPlaylistTrackMetadata(raw);
  if (!metadata) {
    return null;
  }
  const parsed = raw as Partial<CachedLocalPlaylistTrack>;
  return {
    uri: typeof parsed.uri === 'string' ? parsed.uri : null,
    ...metadata,
  };
}

function parseCachedPlaylistTrack(raw: unknown): CachedPlaylistTrack | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const parsed = raw as Partial<CachedPlaylistTrack>;
  if (typeof parsed.id !== 'string' || !Array.isArray(parsed.linkedFromIds)) {
    return null;
  }
  const metadata = parseCachedPlaylistTrackMetadata(parsed.metadata);
  return {
    id: parsed.id,
    isrc: typeof parsed.isrc === 'string' ? parsed.isrc : null,
    linkedFromIds: parsed.linkedFromIds.filter(
      (linkedId): linkedId is string => typeof linkedId === 'string',
    ),
    ...(metadata ? { metadata } : {}),
  };
}

function parsePlaylistCacheEntry(raw: unknown): SpotifyPlaylistCache | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const parsed = raw as Partial<SpotifyPlaylistCache>;
  if (!parsed.playlistId || typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.tracks)) {
    return null;
  }
  const localTracks = Array.isArray(parsed.localTracks)
    ? parsed.localTracks
        .map((track) => parseCachedLocalPlaylistTrack(track))
        .filter((track): track is CachedLocalPlaylistTrack => track !== null)
    : null;
  return {
    playlistId: parsed.playlistId,
    fetchedAt: parsed.fetchedAt,
    ...(typeof parsed.revision === 'number' ? { revision: parsed.revision } : {}),
    trackTotal: typeof parsed.trackTotal === 'number' ? parsed.trackTotal : undefined,
    playlistItemsFetched:
      typeof parsed.playlistItemsFetched === 'number' ? parsed.playlistItemsFetched : undefined,
    tracks: parsed.tracks
      .map((track) => parseCachedPlaylistTrack(track))
      .filter((track): track is CachedPlaylistTrack => track !== null),
    ...(localTracks ? { localTracks } : {}),
    ...(typeof parsed.metadataVersion === 'number'
      ? { metadataVersion: parsed.metadataVersion }
      : {}),
    ...(typeof parsed.paginationComplete === 'boolean'
      ? { paginationComplete: parsed.paginationComplete }
      : {}),
  };
}

function readLegacyPlaylistCache(): SpotifyPlaylistCache | null {
  try {
    const raw = localStorage.getItem(LEGACY_PLAYLIST_CACHE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return parsePlaylistCacheEntry(JSON.parse(raw));
  } catch {
    return null;
  }
}

function readLegacyPlaylistCacheStore(): PlaylistCacheStore {
  try {
    const raw = localStorage.getItem(PLAYLIST_CACHE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const store: PlaylistCacheStore = {};
        for (const [playlistId, entry] of Object.entries(parsed)) {
          const cache = parsePlaylistCacheEntry(entry);
          if (cache) {
            store[playlistId] = cache;
          }
        }
        if (Object.keys(store).length > 0) {
          return store;
        }
      }
    }
  } catch {
    /* fall through to legacy migration */
  }

  const legacy = readLegacyPlaylistCache();
  if (!legacy) {
    return {};
  }
  return { [legacy.playlistId]: legacy };
}

let playlistCacheStore: PlaylistCacheStore | null = null;
let playlistCacheHydration: Promise<void> | null = null;
let playlistCleanupSelectedIds: Set<string> | null = null;
let playlistCleanupPromise: Promise<void> | null = null;

function getMemoryPlaylistCacheStore(): PlaylistCacheStore {
  if (!playlistCacheStore) {
    playlistCacheStore = readLegacyPlaylistCacheStore();
  }
  return playlistCacheStore;
}

function removeLegacyPlaylistCacheStorage(): void {
  try {
    localStorage.removeItem(PLAYLIST_CACHE_STORAGE_KEY);
    localStorage.removeItem(LEGACY_PLAYLIST_CACHE_STORAGE_KEY);
  } catch {
    /* The durable cache is already saved; stale local data can be retried next load. */
  }
}

function cacheRevision(cache: SpotifyPlaylistCache): number {
  return cache.revision ?? cache.fetchedAt;
}

/**
 * Hydrate the synchronous matching snapshot from IndexedDB, migrating legacy localStorage blobs.
 */
export function hydrateSpotifyPlaylistCaches(): Promise<void> {
  if (playlistCacheHydration) {
    return playlistCacheHydration;
  }
  playlistCacheHydration = (async () => {
    const legacyStore = getMemoryPlaylistCacheStore();
    const durableEntries = await readAllSpotifyPlaylistCaches();
    const mergedStore: PlaylistCacheStore = {};

    for (const rawEntry of durableEntries) {
      const cache = parsePlaylistCacheEntry(rawEntry);
      if (cache) {
        mergedStore[cache.playlistId] = cache;
      }
    }

    const migrations: Promise<void>[] = [];
    for (const cache of Object.values(legacyStore)) {
      const durable = mergedStore[cache.playlistId];
      if (!durable || cacheRevision(cache) > cacheRevision(durable)) {
        mergedStore[cache.playlistId] = cache;
        migrations.push(putSpotifyPlaylistCache(cache));
      }
    }
    await Promise.all(migrations);
    playlistCacheStore = mergedStore;
    removeLegacyPlaylistCacheStorage();
    emitPlaylistChange();
  })().catch((error: unknown) => {
    playlistCacheHydration = null;
    throw error;
  });
  return playlistCacheHydration;
}

/** Clear every durable playlist cache while preserving the selected playlist. */
export async function clearPlaylistCache(): Promise<void> {
  if (playlistCacheHydration) {
    try {
      await playlistCacheHydration;
    } catch {
      // Clearing can retry IndexedDB directly after a failed hydration.
    }
  }
  await clearSpotifyPlaylistCaches();
  playlistCacheStore = {};
  playlistCacheHydration = Promise.resolve();
  removeLegacyPlaylistCacheStorage();
  emitPlaylistChange();
}

export async function clearNonSelectedSpotifyPlaylistCaches(): Promise<void> {
  if (playlistCleanupPromise) {
    return playlistCleanupPromise;
  }
  const cleanup = (async () => {
    try {
      await hydrateSpotifyPlaylistCaches();
    } catch {
      // Cleanup can still retry IndexedDB directly.
    }
    const currentStore = getMemoryPlaylistCacheStore();
    const initiallySelectedId = getSelectedSpotifyPlaylist()?.id ?? null;
    const protectedIds = new Set<string>();
    if (initiallySelectedId) {
      protectedIds.add(initiallySelectedId);
    }
    playlistCleanupSelectedIds = protectedIds;
    try {
      await clearSpotifyPlaylistCachesExcept(protectedIds);

      // A selection can change while the IndexedDB cursor is deleting entries.
      // Restore any cache it already passed before that playlist became protected.
      const restoredIds = new Set<string>(
        initiallySelectedId ? [initiallySelectedId] : [],
      );
      while (true) {
        const selectedId = getSelectedSpotifyPlaylist()?.id ?? null;
        if (selectedId) {
          protectedIds.add(selectedId);
        }
        const pendingIds = [...protectedIds].filter(
          (playlistId) => !restoredIds.has(playlistId),
        );
        if (pendingIds.length === 0) {
          break;
        }
        for (const playlistId of pendingIds) {
          const cache = currentStore[playlistId];
          if (cache) {
            await putSpotifyPlaylistCache(cache);
          }
          restoredIds.add(playlistId);
        }
      }
    } finally {
      playlistCleanupSelectedIds = null;
    }

    const selectedId = getSelectedSpotifyPlaylist()?.id ?? null;
    playlistCacheStore =
      selectedId && currentStore[selectedId]
        ? { [selectedId]: currentStore[selectedId] }
        : {};
    emitPlaylistChange();
  })().finally(() => {
    playlistCleanupPromise = null;
  });
  playlistCleanupPromise = cleanup;
  return cleanup;
}

registerDisposableCacheOwner({
  id: 'spotify-playlists',
  label: 'Spotify playlist cache',
  deletionEffect:
    'Non-selected playlists use the existing live cache-miss refetch path.',
  measure: async () => (await measureSpotifyCacheDatabase()).playlistCaches,
  clear: clearNonSelectedSpotifyPlaylistCaches,
  clearUnderPressure: clearNonSelectedSpotifyPlaylistCaches,
});

/** Selected playlist's track cache — null when nothing is selected or not cached yet. */
export function getActivePlaylistCache(): SpotifyPlaylistCache | null {
  const selected = getSelectedSpotifyPlaylist();
  if (!selected) {
    return null;
  }
  return getPlaylistCache(selected.id);
}

/** Cached tracks for a playlist — defaults to the currently selected playlist. */
export function getPlaylistCache(playlistId?: string): SpotifyPlaylistCache | null {
  const id = playlistId ?? getSelectedSpotifyPlaylist()?.id;
  if (!id) {
    return null;
  }
  return getMemoryPlaylistCacheStore()[id] ?? null;
}

async function writePlaylistCache(
  cache: SpotifyPlaylistCache,
): Promise<SpotifyPlaylistCache> {
  await hydrateSpotifyPlaylistCaches();
  const store = getMemoryPlaylistCacheStore();
  const previous = store[cache.playlistId];
  const previousRevision = previous?.revision ?? previous?.fetchedAt ?? 0;
  const revision = Math.max(Date.now(), previousRevision + 1, cache.revision ?? 0);
  const storedCache = { ...cache, revision };
  try {
    await putSpotifyPlaylistCache(storedCache);
  } catch {
    throw new Error(
      'Unable to save the Spotify playlist cache in durable browser storage.',
    );
  }
  store[cache.playlistId] = storedCache;
  emitPlaylistChange();
  return storedCache;
}

/** Test-only cache write entry point. */
export async function _writePlaylistCacheForTesting(
  cache: SpotifyPlaylistCache,
): Promise<SpotifyPlaylistCache> {
  return writePlaylistCache(cache);
}

/** Patch playlist track rows in cache (e.g. background ISRC backfill). */
export async function updatePlaylistCacheTracks(
  playlistId: string,
  tracks: CachedPlaylistTrack[],
): Promise<boolean> {
  await hydrateSpotifyPlaylistCaches();
  const cache = getPlaylistCache(playlistId);
  if (!cache) {
    return false;
  }
  try {
    await writePlaylistCache({ ...cache, tracks });
    return true;
  } catch {
    return false;
  }
}

function schedulePlaylistIsrcBackfill(playlistId: string): void {
  void import('./spotifyPlaylistIsrcBackfill').then(({ startPlaylistIsrcBackfill }) => {
    startPlaylistIsrcBackfill(playlistId);
  });
}

export function isPlaylistCacheStale(fetchedAt: number, now = Date.now()): boolean {
  return now - fetchedAt >= PLAYLIST_CACHE_STALE_MS;
}

export function countCachedPlaylistTracks(cache: SpotifyPlaylistCache): number {
  return cache.tracks.length + (cache.localTracks?.length ?? 0);
}

/** True when a cache is truncated or predates local-file metadata retention. */
export function isPlaylistCacheIncomplete(cache: SpotifyPlaylistCache): boolean {
  if (
    !Array.isArray(cache.localTracks) ||
    cache.metadataVersion !== PLAYLIST_CACHE_METADATA_VERSION
  ) {
    return true;
  }
  if (cache.paginationComplete === true) {
    return false;
  }
  if (
    typeof cache.trackTotal === 'number' &&
    typeof cache.playlistItemsFetched === 'number' &&
    cache.playlistItemsFetched < cache.trackTotal
  ) {
    return true;
  }
  // Pagination regression (Jul 2026): `fields` filter dropped `next`, so caches capped at 50.
  if (cache.trackTotal == null && cache.playlistItemsFetched == null && cache.tracks.length === 50) {
    return true;
  }
  return false;
}

type SpotifyApiErrorBody = {
  error?: string | { message?: string };
  message?: string;
};

export const SPOTIFY_UNREGISTERED_USER_MESSAGE =
  'This Spotify account is not registered for this app. Ask the app owner to add your name and Spotify account email in Spotify Developer Dashboard → User Management, then sign out and sign in again.';

function readSpotifyErrorMessage(body: SpotifyApiErrorBody): string | null {
  if (typeof body.error === 'string') {
    return body.error;
  }
  if (body.error && typeof body.error.message === 'string') {
    return body.error.message;
  }
  return typeof body.message === 'string' ? body.message : null;
}

function isUnregisteredSpotifyUser(message: string | null): boolean {
  if (!message) {
    return false;
  }
  const normalized = message.toLowerCase();
  return (
    normalized.includes('user is not registered for this application') ||
    (normalized.includes('not registered') && normalized.includes('developer'))
  );
}

async function fetchJson<T>(url: string, accessToken: string): Promise<T> {
  const res = await spotifyApiFetch(url, accessToken);
  if (!res.ok) {
    let message: string | null = null;
    try {
      const raw = await res.text();
      try {
        message = readSpotifyErrorMessage(JSON.parse(raw) as SpotifyApiErrorBody);
      } catch {
        message = raw.trim() || null;
      }
    } catch {
      /* ignore unreadable bodies */
    }
    if (res.status === 403 && isUnregisteredSpotifyUser(message)) {
      throw new Error(SPOTIFY_UNREGISTERED_USER_MESSAGE);
    }
    const detail = message ? `: ${message}` : '';
    if (res.status === 403 && url.includes('/items')) {
      throw new Error(
        `Spotify API 403${detail} — playlist tracks are only available for playlists you own or collaborate on. Pick a different playlist.`,
      );
    }
    throw new Error(`Spotify API ${res.status}${detail}: ${url}`);
  }
  return (await res.json()) as T;
}

function playlistIsReadableByUser(
  playlist: SpotifyPlaylistListItem,
  spotifyUserId: string | null,
): boolean {
  if (!spotifyUserId) {
    return true;
  }
  if (playlist.owner?.id === spotifyUserId) {
    return true;
  }
  return playlist.collaborative === true;
}

export async function listUserSpotifyPlaylists(
  accessToken?: string | null,
): Promise<SpotifyPlaylistSummary[]> {
  const token = accessToken ?? (await ensureSpotifyAccessToken());
  if (!token) {
    return [];
  }

  const spotifyUserId = getStoredSpotifyAuth()?.spotifyUserId ?? null;
  const out: SpotifyPlaylistSummary[] = [];
  const pageSize = 50;
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  // Paginate with explicit offset — Spotify's `next` URL may point at removed endpoints and
  // the API does not expose the user's custom sidebar sort order (order is preserved as returned).
  while (offset < total) {
    const url =
      `https://api.spotify.com/v1/me/playlists?limit=${pageSize}&offset=${offset}`;
    const page: SpotifyPlaylistsResponse = await fetchJson<SpotifyPlaylistsResponse>(url, token);
    const items = page.items ?? [];
    if (typeof page.total === 'number') {
      total = page.total;
    }
    for (const item of items) {
      if (!item?.id || !item.name) {
        continue;
      }
      if (!playlistIsReadableByUser(item, spotifyUserId)) {
        continue;
      }
      out.push({ id: item.id, name: item.name });
    }
    if (items.length < pageSize) {
      break;
    }
    offset += pageSize;
  }

  return out;
}

function resolvePlaylistTrackObject(item: SpotifyPlaylistTrackItem): SpotifyPlaylistTrackObject | null {
  const candidate = item.item ?? item.track;
  if (!candidate) {
    return null;
  }
  return candidate;
}

function resolveSpotifyCatalogTrackObject(
  item: SpotifyPlaylistTrackItem,
): SpotifyPlaylistTrackObject & { id: string } | null {
  const candidate = resolvePlaylistTrackObject(item);
  if (!candidate?.id) {
    return null;
  }
  if (candidate.type && candidate.type !== 'track') {
    return null;
  }
  return { ...candidate, id: candidate.id };
}

function parsePlaylistTrackMetadata(
  track: SpotifyPlaylistTrackObject,
  playlistPosition: number,
): CachedPlaylistTrackMetadata | null {
  const title = track.name?.trim() ?? '';
  if (!title) {
    return null;
  }
  return {
    title,
    artists: [
      ...new Set(
        (track.artists ?? [])
          .map((artist) => artist?.name?.trim() ?? '')
          .filter((name) => name.length > 0),
      ),
    ],
    album: track.album?.name?.trim() || null,
    durationMs:
      typeof track.duration_ms === 'number' && track.duration_ms >= 0
        ? track.duration_ms
        : null,
    playlistPosition,
  };
}

function parsePlaylistTrackItem(
  item: SpotifyPlaylistTrackItem,
  playlistPosition?: number,
): CachedPlaylistTrack | null {
  const track = resolveSpotifyCatalogTrackObject(item);
  if (!track) {
    return null;
  }
  const linkedFromIds: string[] = [];
  if (item.linked_from?.id) {
    linkedFromIds.push(item.linked_from.id);
  }
  const metadata =
    playlistPosition != null ? parsePlaylistTrackMetadata(track, playlistPosition) : null;
  return {
    id: track.id,
    isrc: track.external_ids?.isrc ?? null,
    linkedFromIds,
    ...(metadata ? { metadata } : {}),
  };
}

function parseLocalPlaylistTrackItem(
  item: SpotifyPlaylistTrackItem,
  playlistPosition: number,
): CachedLocalPlaylistTrack | null {
  const track = resolvePlaylistTrackObject(item);
  if (!track || (track.type && track.type !== 'track')) {
    return null;
  }
  const isLocal =
    item.is_local === true ||
    track.is_local === true ||
    track.uri?.startsWith('spotify:local:') === true;
  const metadata = parsePlaylistTrackMetadata(track, playlistPosition);
  if (!isLocal || !metadata) {
    return null;
  }
  return {
    uri: track.uri ?? null,
    ...metadata,
  };
}

/** Exported for unit tests. */
export function parsePlaylistTrackItemForTesting(
  item: SpotifyPlaylistTrackItem,
): CachedPlaylistTrack | null {
  return parsePlaylistTrackItem(item);
}

/** Exported for unit tests. */
export function parseLocalPlaylistTrackItemForTesting(
  item: SpotifyPlaylistTrackItem,
  playlistPosition: number,
): CachedLocalPlaylistTrack | null {
  return parseLocalPlaylistTrackItem(item, playlistPosition);
}

export async function fetchPlaylistTracks(
  playlistId: string,
  accessToken?: string | null,
): Promise<FetchPlaylistTracksResult> {
  const token = accessToken ?? (await ensureSpotifyAccessToken());
  if (!token) {
    return {
      tracks: [],
      localTracks: [],
      trackTotal: null,
      playlistItemsFetched: 0,
      paginationComplete: false,
    };
  }

  const tracks: CachedPlaylistTrack[] = [];
  const localTracks: CachedLocalPlaylistTrack[] = [];
  const fields =
    'total,items(is_local,item(id,type,name,is_local,uri,duration_ms,external_ids,artists(name),album(name)),track(id,type,name,is_local,uri,duration_ms,external_ids,artists(name),album(name)),linked_from(id))';
  const pageSize = 50;
  let offset = 0;
  let trackTotal: number | null = null;
  let playlistItemsFetched = 0;

  // Paginate with explicit offset — a `fields` filter omits `next`, and Spotify's
  // `next` URL may point at removed endpoints anyway (see listUserSpotifyPlaylists).
  while (true) {
    const url =
      `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items` +
      `?limit=${pageSize}&offset=${offset}&additional_types=track&fields=${encodeURIComponent(fields)}`;
    const page: SpotifyPlaylistTracksResponse = await fetchJson<SpotifyPlaylistTracksResponse>(
      url,
      token,
    );
    if (typeof page.total === 'number') {
      // Large playlists take many requests to read and can change mid-fetch.
      // The latest page total describes the final snapshot more accurately
      // than a stale first-page total.
      trackTotal = page.total;
    }
    const items = page.items ?? [];
    playlistItemsFetched += items.length;
    for (const [index, item] of items.entries()) {
      const localTrack = parseLocalPlaylistTrackItem(item, offset + index + 1);
      if (localTrack) {
        localTracks.push(localTrack);
        continue;
      }
      const parsed = parsePlaylistTrackItem(item, offset + index + 1);
      if (parsed) {
        tracks.push(parsed);
      }
    }
    if (items.length < pageSize) {
      break;
    }
    offset += pageSize;
  }

  return {
    tracks,
    localTracks,
    trackTotal,
    playlistItemsFetched,
    paginationComplete: true,
  };
}

export async function refreshPlaylistCache(options?: {
  /** When true, re-fetch from Spotify even if a fresh cache exists. */
  force?: boolean;
}): Promise<SpotifyPlaylistCache | null> {
  await Promise.all([
    hydrateSpotifyPlaylistCaches(),
    hydrateTrackIsrcStore(),
  ]);
  const selected = getSelectedSpotifyPlaylist();
  if (!selected) {
    return null;
  }

  const existing = getPlaylistCache(selected.id);
  if (
    !options?.force &&
    existing &&
    !isPlaylistCacheStale(existing.fetchedAt) &&
    !isPlaylistCacheIncomplete(existing)
  ) {
    return existing;
  }

  const token = await ensureSpotifyAccessToken();
  if (!token) {
    return null;
  }

  const {
    tracks: rawTracks,
    localTracks,
    trackTotal,
    playlistItemsFetched,
    paginationComplete,
  } = await fetchPlaylistTracks(selected.id, token);
  const tracks = applyTrackIsrcStoreToPlaylistTracks(rawTracks);
  const cache: SpotifyPlaylistCache = {
    playlistId: selected.id,
    fetchedAt: Date.now(),
    tracks,
    localTracks,
    metadataVersion: PLAYLIST_CACHE_METADATA_VERSION,
    playlistItemsFetched,
    paginationComplete,
    ...(trackTotal != null ? { trackTotal } : {}),
  };
  const storedCache = await writePlaylistCache(cache);
  schedulePlaylistIsrcBackfill(selected.id);
  return storedCache;
}

/** Test-only reset. */
export async function _clearSpotifyPlaylistForTesting(): Promise<void> {
  try {
    localStorage.removeItem(PLAYLIST_STORAGE_KEY);
    await clearPlaylistCache();
  } catch {
    /* ignore */
  }
  playlistCacheStore = null;
  playlistCacheHydration = null;
  playlistCleanupSelectedIds = null;
  playlistCleanupPromise = null;
}

/** Test-only simulation of a page reload without clearing durable data. */
export function _resetSpotifyPlaylistCacheMemoryForTesting(): void {
  playlistCacheStore = null;
  playlistCacheHydration = null;
  playlistCleanupSelectedIds = null;
  playlistCleanupPromise = null;
}
