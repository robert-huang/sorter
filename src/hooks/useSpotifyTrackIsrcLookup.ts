import { useEffect, useMemo, useState } from 'react';
import { mergeSpotifyTrackIdSources } from '../lib/importers/anilist/themeSongs/spotifyLinks';
import type { MediaThemeSongRow } from '../lib/importers/anilist/themeSongs/types';
import {
  ensureSpotifyAccessToken,
  ensureSpotifyAccountCountry,
  getStoredSpotifyAuth,
  subscribeSpotifyAuth,
} from '../lib/spotify/spotifyAuth';
import {
  ensureTrackIsrcsCached,
  getTrackIsrcStoreSnapshot,
} from '../lib/spotify/spotifyTrackIsrcStore';
import type { SpotifyTrackIsrcProgress } from '../lib/importers/anilist/themeSongs/spotifyIsrc';

const EMPTY_TRACK_IDS: string[] = [];

function collectThemeTrackIds(rows: readonly MediaThemeSongRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const trackId of mergeSpotifyTrackIdSources(row.spotifyTrackIds, row.spotifyUrl)) {
      ids.add(trackId);
    }
  }
  return [...ids];
}

/** Stable string key so callers can pass a fresh `[]` without retriggering effects. */
function themeTrackIdsKey(rows: readonly MediaThemeSongRow[]): string {
  const ids = collectThemeTrackIds(rows);
  if (ids.length === 0) {
    return '';
  }
  ids.sort();
  return ids.join(',');
}

export type SpotifyTrackIsrcLookup = {
  lookup: ReadonlyMap<string, string>;
  ready: boolean;
  progress: SpotifyTrackIsrcProgress | null;
  spotifyCountry: string | null;
};

/**
 * Lazily fetches Spotify ISRCs for theme-song track IDs when signed in.
 * Used so playlist matching can bridge alternate catalog IDs via ISRC.
 */
export function useSpotifyTrackIsrcLookup(
  rows: readonly MediaThemeSongRow[],
): SpotifyTrackIsrcLookup {
  const trackIdsKey = themeTrackIdsKey(rows);
  const trackIds = useMemo(
    () => (trackIdsKey.length === 0 ? EMPTY_TRACK_IDS : trackIdsKey.split(',')),
    [trackIdsKey],
  );
  const [lookup, setLookup] = useState(() => getTrackIsrcStoreSnapshot());
  const [ready, setReady] = useState(true);
  const [progress, setProgress] = useState<SpotifyTrackIsrcProgress | null>(null);
  const [spotifyCountry, setSpotifyCountry] = useState(
    () => getStoredSpotifyAuth()?.country ?? null,
  );
  const [authRevision, setAuthRevision] = useState(0);

  useEffect(
    () => subscribeSpotifyAuth(() => setAuthRevision((revision) => revision + 1)),
    [],
  );

  useEffect(() => {
    if (trackIdsKey.length === 0) {
      setLookup(getTrackIsrcStoreSnapshot());
      setSpotifyCountry(getStoredSpotifyAuth()?.country ?? null);
      setReady(true);
      setProgress(null);
      return;
    }

    let cancelled = false;
    setReady(false);
    setProgress(null);
    void (async () => {
      const token = await ensureSpotifyAccessToken();
      if (cancelled) {
        return;
      }
      if (!token) {
        setSpotifyCountry(null);
        setReady(true);
        setProgress(null);
        return;
      }
      const [map, country] = await Promise.all([
        ensureTrackIsrcsCached(trackIds, token, (nextProgress) => {
          if (!cancelled) {
            setProgress(nextProgress);
          }
        }),
        ensureSpotifyAccountCountry(token),
      ]);
      if (!cancelled) {
        setLookup(map);
        setSpotifyCountry(country);
        setReady(true);
        setProgress(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authRevision, trackIdsKey]);

  return { lookup, ready, progress, spotifyCountry };
}
