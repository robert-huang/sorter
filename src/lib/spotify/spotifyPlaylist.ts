import { spotifyApiFetch } from './spotifyApi';
import { ensureSpotifyAccessToken, getStoredSpotifyAuth } from './spotifyAuth';
import { applyTrackIsrcStoreToPlaylistTracks } from './spotifyTrackIsrcStore';

export { formatSpotifyApiBanMessage, getSpotifyApiBannedUntil, SpotifyApiRateLimitedError } from './spotifyApi';

export const PLAYLIST_STORAGE_KEY = 'spotify:playlist:v1';
export const PLAYLIST_CACHE_STORAGE_KEY = 'spotify:playlist-cache:v1';

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

export function clearPlaylistCache(): void {
  try {
    localStorage.removeItem(PLAYLIST_CACHE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  emitPlaylistChange();
}

/** Selected playlist's track cache — null when nothing is selected or ids do not match. */
export function getActivePlaylistCache(): SpotifyPlaylistCache | null {
  const selected = getSelectedSpotifyPlaylist();
  const cache = getPlaylistCache();
  if (!selected || !cache || cache.playlistId !== selected.id) {
    return null;
  }
  return cache;
}

export function getPlaylistCache(): SpotifyPlaylistCache | null {
  try {
    const raw = localStorage.getItem(PLAYLIST_CACHE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<SpotifyPlaylistCache>;
    if (!parsed.playlistId || typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.tracks)) {
      return null;
    }
    return {
      playlistId: parsed.playlistId,
      fetchedAt: parsed.fetchedAt,
      tracks: parsed.tracks.filter(
        (t): t is CachedPlaylistTrack =>
          !!t && typeof t.id === 'string' && Array.isArray(t.linkedFromIds),
      ),
    };
  } catch {
    return null;
  }
}

function writePlaylistCache(cache: SpotifyPlaylistCache): void {
  try {
    localStorage.setItem(PLAYLIST_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
  emitPlaylistChange();
}

/** Patch playlist track rows in cache (e.g. background ISRC backfill). */
export function updatePlaylistCacheTracks(
  playlistId: string,
  tracks: CachedPlaylistTrack[],
): boolean {
  const cache = getPlaylistCache();
  if (!cache || cache.playlistId !== playlistId) {
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
): Promise<CachedPlaylistTrack[]> {
  const token = accessToken ?? (await ensureSpotifyAccessToken());
  if (!token) {
    return [];
  }

  const tracks: CachedPlaylistTrack[] = [];
  const fields =
    'items(item(id,type,external_ids),track(id,type,external_ids),linked_from(id))';
  const base =
    `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items` +
    `?limit=50&additional_types=track&fields=${encodeURIComponent(fields)}`;
  let url: string | null = base;

  while (url) {
    const page: SpotifyPlaylistTracksResponse = await fetchJson<SpotifyPlaylistTracksResponse>(
      url,
      token,
    );
    for (const item of page.items ?? []) {
      const parsed = parsePlaylistTrackItem(item);
      if (parsed) {
        tracks.push(parsed);
      }
    }
    url = page.next ?? null;
  }

  return tracks;
}

export async function refreshPlaylistCache(options?: {
  /** When true, re-fetch from Spotify even if a fresh cache exists. */
  force?: boolean;
}): Promise<SpotifyPlaylistCache | null> {
  const selected = getSelectedSpotifyPlaylist();
  if (!selected) {
    return null;
  }

  const existing = getPlaylistCache();
  if (
    !options?.force &&
    existing &&
    existing.playlistId === selected.id &&
    !isPlaylistCacheStale(existing.fetchedAt)
  ) {
    return existing;
  }

  const token = await ensureSpotifyAccessToken();
  if (!token) {
    return null;
  }

  const rawTracks = await fetchPlaylistTracks(selected.id, token);
  const tracks = applyTrackIsrcStoreToPlaylistTracks(rawTracks);
  const cache: SpotifyPlaylistCache = {
    playlistId: selected.id,
    fetchedAt: Date.now(),
    tracks,
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
