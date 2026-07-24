import type { MediaThemeSongRow } from './types';
import { ensureSpotifyAccessToken } from '../../../spotify/spotifyAuth';
import { mergeTrackIsrcsIntoStore } from '../../../spotify/spotifyTrackIsrcStore';

type SpotifyTrackResponse = {
  id?: string;
  external_ids?: { isrc?: string | null };
};

/** Spotify removed batch `GET /tracks?ids=` in Feb 2026; fetch one track per request. */
const TRACK_FETCH_CONCURRENCY = 5;

async function fetchSpotifyTrackIsrc(
  trackId: string,
  token: string,
): Promise<{ id: string; isrc: string } | null> {
  const url = `https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
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
 * Called at theme-song save time.
 */
export async function fetchSpotifyIsrcByTrackIds(
  trackIds: readonly string[],
  accessToken?: string | null,
): Promise<Map<string, string>> {
  const token = accessToken ?? (await ensureSpotifyAccessToken());
  if (!token || trackIds.length === 0) {
    return new Map();
  }

  const unique = [...new Set(trackIds)];
  const out = new Map<string, string>();

  const rows = await mapWithConcurrency(unique, TRACK_FETCH_CONCURRENCY, (trackId) =>
    fetchSpotifyTrackIsrc(trackId, token),
  );
  for (const row of rows) {
    if (row) {
      out.set(row.id, row.isrc);
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
