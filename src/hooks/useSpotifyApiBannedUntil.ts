import { useLayoutEffect, useState } from 'react';
import { getSpotifyApiBannedUntil } from '../lib/spotify/spotifyApi';

/** Live `bannedUntil` from the Spotify API circuit breaker; null when not banned. */
export function useSpotifyApiBannedUntil(): number | null {
  const [bannedUntil, setBannedUntil] = useState<number | null>(() => getSpotifyApiBannedUntil());

  useLayoutEffect(() => {
    const tick = () => {
      setBannedUntil(getSpotifyApiBannedUntil());
    };
    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  return bannedUntil;
}
