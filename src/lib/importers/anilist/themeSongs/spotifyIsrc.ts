import type { MediaThemeSongRow } from './types';
import {
  isSpotifyApiBanned,
  spotifyApiFetch,
  SpotifyApiRateLimitedError,
} from '../../../spotify/spotifyApi';
import { ensureSpotifyAccessToken } from '../../../spotify/spotifyAuth';
import {
  getCachedTrackIsrc,
  hydrateTrackIsrcStore,
  mergeTrackIsrcsIntoStore,
} from '../../../spotify/spotifyTrackIsrcStore';

type SpotifyTrackResponse = {
  id?: string;
  external_ids?: { isrc?: string | null };
};

/** Parallel `GET /tracks/{id}` lookups (batch `?ids=` removed Feb 2026). */
export const TRACK_FETCH_CONCURRENCY = 5;

export type SpotifyTrackIsrcProgress = {
  completed: number;
  total: number;
};

export type SpotifyTrackIsrcProgressCallback = (
  progress: SpotifyTrackIsrcProgress,
) => void;

async function fetchSpotifyTrackIsrc(
  trackId: string,
  token: string,
): Promise<{ id: string; isrc: string } | null> {
  if (isSpotifyApiBanned('tracks')) {
    return null;
  }
  const url = `https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`;
  let res: Response;
  try {
    res = await spotifyApiFetch(url, token);
  } catch (err) {
    if (err instanceof SpotifyApiRateLimitedError) {
      return null;
    }
    throw err;
  }
  if (!res.ok) {
    return null;
  }
  const track = (await res.json()) as SpotifyTrackResponse;
  if (!track.id) {
    return null;
  }
  const isrc = track.external_ids?.isrc;
  return isrc ? { id: track.id, isrc } : null;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      if (isSpotifyApiBanned('tracks')) {
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index]!);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Fetch ISRC for Spotify track IDs via `GET /tracks/{id}` (one request per track).
 * No-ops when no access token is stored.
 */
export async function fetchSpotifyIsrcByTrackIds(
  trackIds: readonly string[],
  accessToken?: string | null,
  onProgress?: SpotifyTrackIsrcProgressCallback,
): Promise<Map<string, string>> {
  const uniqueTrackIds = [...new Set(trackIds)];
  onProgress?.({ completed: 0, total: uniqueTrackIds.length });
  await hydrateTrackIsrcStore();
  const token = accessToken ?? (await ensureSpotifyAccessToken());
  if (!token || uniqueTrackIds.length === 0 || isSpotifyApiBanned('tracks')) {
    return new Map();
  }

  const out = new Map<string, string>();
  for (const trackId of uniqueTrackIds) {
    const cached = getCachedTrackIsrc(trackId);
    if (cached) {
      out.set(trackId, cached);
    }
  }
  onProgress?.({ completed: out.size, total: uniqueTrackIds.length });

  const uncached = uniqueTrackIds.filter((trackId) => !getCachedTrackIsrc(trackId));
  if (uncached.length > 0 && !isSpotifyApiBanned('tracks')) {
    let completed = out.size;
    const rows = await mapWithConcurrency(
      uncached,
      TRACK_FETCH_CONCURRENCY,
      async (trackId) => {
        try {
          return await fetchSpotifyTrackIsrc(trackId, token);
        } finally {
          completed += 1;
          onProgress?.({ completed, total: uniqueTrackIds.length });
        }
      },
    );
    for (const row of rows) {
      if (row) {
        out.set(row.id, row.isrc);
      }
    }
  }

  await mergeTrackIsrcsIntoStore(out);
  return out;
}

export async function enrichRowsWithSpotifyIsrc(
  rows: MediaThemeSongRow[],
): Promise<MediaThemeSongRow[]> {
  const allIds = rows.flatMap((r) => r.spotifyTrackIds);
  const isrcById = await fetchSpotifyIsrcByTrackIds(allIds);
  if (isrcById.size === 0) {
    return rows;
  }
  return rows.map((row) => {
    for (const id of row.spotifyTrackIds) {
      const isrc = isrcById.get(id);
      if (isrc) {
        return { ...row, spotifyIsrc: isrc };
      }
    }
    return row;
  });
}
