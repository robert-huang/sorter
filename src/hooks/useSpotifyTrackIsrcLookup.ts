import { useEffect, useMemo, useState } from 'react';
import type { MediaThemeSongRow } from '../lib/importers/anilist/themeSongs/types';
import { ensureSpotifyAccessToken } from '../lib/spotify/spotifyAuth';
import {
  ensureTrackIsrcsCached,
  getTrackIsrcStoreSnapshot,
} from '../lib/spotify/spotifyTrackIsrcStore';

function collectThemeTrackIds(rows: readonly MediaThemeSongRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const trackId of row.spotifyTrackIds) {
      ids.add(trackId);
    }
  }
  return [...ids];
}

export type SpotifyTrackIsrcLookup = {
  lookup: ReadonlyMap<string, string>;
  ready: boolean;
};

/**
 * Lazily fetches Spotify ISRCs for theme-song track IDs when signed in.
 * Used so playlist matching can bridge alternate catalog IDs via ISRC.
 */
export function useSpotifyTrackIsrcLookup(
  rows: readonly MediaThemeSongRow[],
): SpotifyTrackIsrcLookup {
  const trackIds = useMemo(() => collectThemeTrackIds(rows), [rows]);
  const trackIdsKey = trackIds.join(',');
  const [lookup, setLookup] = useState(() => getTrackIsrcStoreSnapshot());
  const [ready, setReady] = useState(true);

  useEffect(() => {
    if (trackIds.length === 0) {
      setLookup(getTrackIsrcStoreSnapshot());
      setReady(true);
      return;
    }

    let cancelled = false;
    setReady(false);
    void (async () => {
      const token = await ensureSpotifyAccessToken();
      if (cancelled) {
        return;
      }
      if (!token) {
        setReady(true);
        return;
      }
      const map = await ensureTrackIsrcsCached(trackIds, token);
      if (!cancelled) {
        setLookup(map);
        setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [trackIdsKey, trackIds]);

  return { lookup, ready };
}
