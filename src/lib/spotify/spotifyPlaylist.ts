import { spotifyApiFetch } from './spotifyApi';
import { ensureSpotifyAccessToken, getStoredSpotifyAuth } from './spotifyAuth';
import { applyTrackIsrcStoreToPlaylistTracks } from './spotifyTrackIsrcStore';

export { formatSpotifyApiBanMessage, getSpotifyApiBannedUntil, SpotifyApiRateLimitedError } from './spotifyApi';

export const PLAYLIST_STORAGE_KEY = 'spotify:playlist:v1';
/** Legacy single-playlist blob — migrated into {@link PLAYLIST_CACHE_STORAGE_KEY} on read. */
export const LEGACY_PLAYLIST_CACHE_STORAGE_KEY = 'spotify:playlist-cache:v1';
/** Keyed by playlist id so switching playlists reuses prior refreshes. */
export const PLAYLIST_CACHE_STORAGE_KEY = 'spotify:playlist-cache:v2';

/** Stale hint only — no auto-refetch. */
export const PLAYLIST_CACHE_STALE_MS = 15 * 60 * 1000;

export type StoredSpotifyPlaylist = {
  id: string;
  name: string;
};

export type CachedPlaylistTrack = {
  id: string;
  isrc: string | null;
  linkedFromIds: string[];
};

export type SpotifyPlaylistCache = {
  playlistId: string;
  fetchedAt: number;
  tracks: CachedPlaylistTrack[];
  /** Spotify-reported item count, including local files. */
  trackTotal?: number;
  /** Number of playlist items fetched, including local files skipped from `tracks`. */
  playlistItemsFetched?: number;
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

type SpotifyPlaylistTrackItem = {
  /** Legacy field (pre–Feb 2026). */
  track?: {
    id?: string;
    type?: string;
    external_ids?: { isrc?: string | null };
  } | null;
  /** Current field (`GET /playlists/{id}/items`). */
  item?: {
    id?: string;
    type?: string;
    external_ids?: { isrc?: string | null };
  } | null;
  linked_from?: { id?: string } | null;
};

type SpotifyPlaylistTracksResponse = {
  items?: SpotifyPlaylistTrackItem[];
  next?: string | null;
  total?: number;
};

export type FetchPlaylistTracksResult = {
  tracks: CachedPlaylistTrack[];
  trackTotal: number | null;
  playlistItemsFetched: number;
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
  try {
    localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(playlist));
  } catch {
    /* ignore */
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

function parsePlaylistCacheEntry(raw: unknown): SpotifyPlaylistCache | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const parsed = raw as Partial<SpotifyPlaylistCache>;
  if (!parsed.playlistId || typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.tracks)) {
    return null;
  }
  return {
    playlistId: parsed.playlistId,
    fetchedAt: parsed.fetchedAt,
    trackTotal: typeof parsed.trackTotal === 'number' ? parsed.trackTotal : undefined,
    playlistItemsFetched:
      typeof parsed.playlistItemsFetched === 'number' ? parsed.playlistItemsFetched : undefined,
    tracks: parsed.tracks.filter(
      (t): t is CachedPlaylistTrack =>
        !!t && typeof t.id === 'string' && Array.isArray(t.linkedFromIds),
    ),
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

function readPlaylistCacheStore(): PlaylistCacheStore {
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

  const migrated: PlaylistCacheStore = { [legacy.playlistId]: legacy };
  writePlaylistCacheStore(migrated);
  try {
    localStorage.removeItem(LEGACY_PLAYLIST_CACHE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return migrated;
}

function writePlaylistCacheStore(store: PlaylistCacheStore): void {
  try {
    localStorage.setItem(PLAYLIST_CACHE_STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
}

export function clearPlaylistCache(): void {
  try {
    localStorage.removeItem(PLAYLIST_CACHE_STORAGE_KEY);
    localStorage.removeItem(LEGACY_PLAYLIST_CACHE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  emitPlaylistChange();
}

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
  return readPlaylistCacheStore()[id] ?? null;
}

function writePlaylistCache(cache: SpotifyPlaylistCache): void {
  const store = readPlaylistCacheStore();
  store[cache.playlistId] = cache;
  writePlaylistCacheStore(store);
  emitPlaylistChange();
}

/** Patch playlist track rows in cache (e.g. background ISRC backfill). */
export function updatePlaylistCacheTracks(
  playlistId: string,
  tracks: CachedPlaylistTrack[],
): boolean {
  const cache = getPlaylistCache(playlistId);
  if (!cache) {
    return false;
  }
  writePlaylistCache({ ...cache, tracks });
  return true;
}

function schedulePlaylistIsrcBackfill(playlistId: string, accessToken: string): void {
  void import('./spotifyPlaylistIsrcBackfill').then(({ startPlaylistIsrcBackfill }) => {
    startPlaylistIsrcBackfill(playlistId, accessToken);
  });
}

export function isPlaylistCacheStale(fetchedAt: number, now = Date.now()): boolean {
  return now - fetchedAt >= PLAYLIST_CACHE_STALE_MS;
}

/** True when fewer playlist items were fetched than Spotify reports (or a legacy cache hit 50). */
export function isPlaylistCacheIncomplete(cache: SpotifyPlaylistCache): boolean {
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

async function fetchJson<T>(url: string, accessToken: string): Promise<T> {
  const res = await spotifyApiFetch(url, accessToken);
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) {
        detail = `: ${body.error.message}`;
      }
    } catch {
      /* ignore non-JSON bodies */
    }
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

function resolvePlaylistTrackObject(
  item: SpotifyPlaylistTrackItem,
): { id: string; external_ids?: { isrc?: string | null } } | null {
  const candidate = item.item ?? item.track;
  if (!candidate?.id) {
    return null;
  }
  if (candidate.type && candidate.type !== 'track') {
    return null;
  }
  return { id: candidate.id, external_ids: candidate.external_ids };
}

function parsePlaylistTrackItem(item: SpotifyPlaylistTrackItem): CachedPlaylistTrack | null {
  const track = resolvePlaylistTrackObject(item);
  if (!track) {
    return null;
  }
  const linkedFromIds: string[] = [];
  if (item.linked_from?.id) {
    linkedFromIds.push(item.linked_from.id);
  }
  return {
    id: track.id,
    isrc: track.external_ids?.isrc ?? null,
    linkedFromIds,
  };
}

/** Exported for unit tests. */
export function parsePlaylistTrackItemForTesting(
  item: SpotifyPlaylistTrackItem,
): CachedPlaylistTrack | null {
  return parsePlaylistTrackItem(item);
}

export async function fetchPlaylistTracks(
  playlistId: string,
  accessToken?: string | null,
): Promise<FetchPlaylistTracksResult> {
  const token = accessToken ?? (await ensureSpotifyAccessToken());
  if (!token) {
    return { tracks: [], trackTotal: null, playlistItemsFetched: 0 };
  }

  const tracks: CachedPlaylistTrack[] = [];
  const fields =
    'total,items(item(id,type,external_ids),track(id,type,external_ids),linked_from(id))';
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
    if (typeof page.total === 'number' && trackTotal == null) {
      trackTotal = page.total;
    }
    const items = page.items ?? [];
    playlistItemsFetched += items.length;
    for (const item of items) {
      const parsed = parsePlaylistTrackItem(item);
      if (parsed) {
        tracks.push(parsed);
      }
    }
    if (items.length < pageSize) {
      break;
    }
    offset += pageSize;
  }

  return { tracks, trackTotal, playlistItemsFetched };
}

export async function refreshPlaylistCache(options?: {
  /** When true, re-fetch from Spotify even if a fresh cache exists. */
  force?: boolean;
}): Promise<SpotifyPlaylistCache | null> {
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

  const { tracks: rawTracks, trackTotal, playlistItemsFetched } = await fetchPlaylistTracks(
    selected.id,
    token,
  );
  const tracks = applyTrackIsrcStoreToPlaylistTracks(rawTracks);
  const cache: SpotifyPlaylistCache = {
    playlistId: selected.id,
    fetchedAt: Date.now(),
    tracks,
    playlistItemsFetched,
    ...(trackTotal != null ? { trackTotal } : {}),
  };
  writePlaylistCache(cache);
  schedulePlaylistIsrcBackfill(selected.id, token);
  return cache;
}

/** Test-only reset. */
export function _clearSpotifyPlaylistForTesting(): void {
  try {
    localStorage.removeItem(PLAYLIST_STORAGE_KEY);
    clearPlaylistCache();
  } catch {
    /* ignore */
  }
}
