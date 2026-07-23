import type { MediaThemeSongRow } from './types';
import { ensureSpotifyAccessToken } from '../../../spotify/spotifyAuth';

type SpotifyTracksResponse = {
  tracks?: Array<{
    id: string;
    external_ids?: { isrc?: string | null };
  } | null>;
};

/**
 * Batch-fetch ISRC for Spotify track IDs. No-ops when no access token is
 * stored (stretch-2 OAuth). Called at theme-song save time.
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

  for (let offset = 0; offset < unique.length; offset += 50) {
    const chunk = unique.slice(offset, offset + 50);
    const url = `https://api.spotify.com/v1/tracks?ids=${chunk.join(',')}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      break;
    }
    const json = (await res.json()) as SpotifyTracksResponse;
    for (const track of json.tracks ?? []) {
      if (!track?.id) {
        continue;
      }
      const isrc = track.external_ids?.isrc;
      if (isrc) {
        out.set(track.id, isrc);
      }
    }
  }

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
