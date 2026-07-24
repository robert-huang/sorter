import type { MediaThemeSongRow } from './types';
import {
  isSpotifyApiBanned,
  spotifyApiFetch,
  SpotifyApiRateLimitedError,
} from '../../../spotify/spotifyApi';
import { ensureSpotifyAccessToken } from '../../../spotify/spotifyAuth';
import {
  getCachedTrackIsrc,
  mergeTrackIsrcsIntoStore,
} from '../../../spotify/spotifyTrackIsrcStore';

type SpotifyTrackResponse = {
  id?: string;
  external_ids?: { isrc?: string | null };
};

type SpotifyTracksBatchResponse = {
  tracks?: Array<SpotifyTrackResponse | null>;
};

/** Spotify allows up to 50 track IDs per `GET /tracks?ids=` request. */
export const SPOTIFY_TRACKS_BATCH_SIZE = 50;

const TRACK_FETCH_CONCURRENCY = 5;

async function fetchSpotifyTrackIsrc(
  trackId: string,
  token: string,
): Promise<{ id: string; isrc: string } | null> {
  if (isSpotifyApiBanned()) {
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

async function fetchSpotifyTrackIsrcBatch(
  trackIds: readonly string[],
  token: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (trackIds.length === 0 || isSpotifyApiBanned()) {
    return out;
  }

  const idsParam = trackIds.join(',');
  const url = `https://api.spotify.com/v1/tracks?ids=${encodeURIComponent(idsParam)}`;
  let res: Response;
  try {
    res = await spotifyApiFetch(url, token);
  } catch (err) {
    if (err instanceof SpotifyApiRateLimitedError) {
      return out;
    }
    throw err;
  }

  if (!res.ok) {
    const rows = await mapWithConcurrency(trackIds, TRACK_FETCH_CONCURRENCY, (trackId) =>
      fetchSpotifyTrackIsrc(trackId, token),
    );
    for (const row of rows) {
      if (row) {
        out.set(row.id, row.isrc);
      }
    }
    return out;
  }

  const body = (await res.json()) as SpotifyTracksBatchResponse;
  for (const track of body.tracks ?? []) {
    if (!track?.id) {
      continue;
    }
    const isrc = track.external_ids?.isrc;
    if (isrc) {
      out.set(track.id, isrc);
    }
  }
  return out;
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
      if (isSpotifyApiBanned()) {
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
 * Fetch ISRC for Spotify track IDs. No-ops when no access token is stored.
 * Batches up to {@link SPOTIFY_TRACKS_BATCH_SIZE} IDs per API call; falls back
 * to per-track requests when a batch fails.
 */
export async function fetchSpotifyIsrcByTrackIds(
  trackIds: readonly string[],
  accessToken?: string | null,
): Promise<Map<string, string>> {
  const token = accessToken ?? (await ensureSpotifyAccessToken());
  if (!token || trackIds.length === 0 || isSpotifyApiBanned()) {
    return new Map();
  }

  const out = new Map<string, string>();
  for (const trackId of trackIds) {
    const cached = getCachedTrackIsrc(trackId);
    if (cached) {
      out.set(trackId, cached);
    }
  }

  const uncached = [...new Set(trackIds)].filter((trackId) => !getCachedTrackIsrc(trackId));
  for (let offset = 0; offset < uncached.length; offset += SPOTIFY_TRACKS_BATCH_SIZE) {
    if (isSpotifyApiBanned()) {
      break;
    }
    const chunk = uncached.slice(offset, offset + SPOTIFY_TRACKS_BATCH_SIZE);
    const batch = await fetchSpotifyTrackIsrcBatch(chunk, token);
    for (const [trackId, isrc] of batch) {
      out.set(trackId, isrc);
    }
  }

  mergeTrackIsrcsIntoStore(out);
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
