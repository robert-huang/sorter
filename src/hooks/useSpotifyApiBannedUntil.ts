import { useLayoutEffect, useState } from 'react';
import {
  getSpotifyApiBan,
  type SpotifyApiBan,
  type SpotifyApiScope,
} from '../lib/spotify/spotifyApi';

/** Live cooldown for one Spotify endpoint family; null when that family is clear. */
export function useSpotifyApiBan(scope: SpotifyApiScope): SpotifyApiBan | null {
  const [ban, setBan] = useState<SpotifyApiBan | null>(() => getSpotifyApiBan(scope));

  useLayoutEffect(() => {
    const tick = () => {
      // getSpotifyApiBan returns a fresh value so known countdowns re-render each second.
      setBan(getSpotifyApiBan(scope));
    };
    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [scope]);

  return ban;
}
