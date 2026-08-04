import { useEffect, useMemo, useState } from 'react';
import {
  getActivePlaylistCache,
  hydrateSpotifyPlaylistCaches,
  subscribeSpotifyPlaylist,
  type SpotifyPlaylistCache,
} from './spotifyPlaylist';

/** Active playlist cache for matching — null when no playlist is selected. */
export function useSpotifyPlaylistCache(): SpotifyPlaylistCache | null {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    void hydrateSpotifyPlaylistCaches().catch(() => {
      // Matching remains unavailable until a later refresh retries hydration.
    });
    return subscribeSpotifyPlaylist(() => setRevision((n) => n + 1));
  }, []);

  return useMemo(() => {
    void revision;
    return getActivePlaylistCache();
  }, [revision]);
}
