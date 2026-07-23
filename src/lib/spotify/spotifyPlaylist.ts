import { ensureSpotifyAccessToken } from './spotifyAuth';

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

type SpotifyPlaylistsResponse = {
  items?: Array<{ id?: string; name?: string } | null>;
  next?: string | null;
};

type SpotifyPlaylistTrackItem = {
  track?: {
    id?: string;
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
    localStorage.removeItem(PLAYLIST_CACHE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  emitPlaylistChange();
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

export function isPlaylistCacheStale(fetchedAt: number, now = Date.now()): boolean {
  return now - fetchedAt >= PLAYLIST_CACHE_STALE_MS;
}

async function fetchJson<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Spotify API ${res.status}: ${url}`);
  }
  return (await res.json()) as T;
}

export async function listUserSpotifyPlaylists(
  accessToken?: string | null,
): Promise<SpotifyPlaylistSummary[]> {
  const token = accessToken ?? (await ensureSpotifyAccessToken());
  if (!token) {
    return [];
  }

  const out: SpotifyPlaylistSummary[] = [];
  let url: string | null =
    'https://api.spotify.com/v1/me/playlists?limit=50';

  while (url) {
    const page: SpotifyPlaylistsResponse = await fetchJson<SpotifyPlaylistsResponse>(url, token);
    for (const item of page.items ?? []) {
      if (item?.id && item.name) {
        out.push({ id: item.id, name: item.name });
      }
    }
    url = page.next ?? null;
  }

  return out;
}

function parsePlaylistTrackItem(item: SpotifyPlaylistTrackItem): CachedPlaylistTrack | null {
  const trackId = item.track?.id;
  if (!trackId) {
    return null;
  }
  const linkedFromIds: string[] = [];
  if (item.linked_from?.id) {
    linkedFromIds.push(item.linked_from.id);
  }
  return {
    id: trackId,
    isrc: item.track?.external_ids?.isrc ?? null,
    linkedFromIds,
  };
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
  let url: string | null =
    `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`;

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

  const tracks = await fetchPlaylistTracks(selected.id);
  const cache: SpotifyPlaylistCache = {
    playlistId: selected.id,
    fetchedAt: Date.now(),
    tracks,
  };
  writePlaylistCache(cache);
  return cache;
}

/** Test-only reset. */
export function _clearSpotifyPlaylistForTesting(): void {
  try {
    localStorage.removeItem(PLAYLIST_STORAGE_KEY);
    localStorage.removeItem(PLAYLIST_CACHE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  emitPlaylistChange();
}
