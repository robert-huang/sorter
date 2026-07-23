import { useEffect, useMemo, useState } from 'react';
import {
  getPlaylistCache,
  getSelectedSpotifyPlaylist,
  subscribeSpotifyPlaylist,
  type SpotifyPlaylistCache,
} from './spotifyPlaylist';

/** Selected playlist cache, refreshed when the user picks a playlist or refreshes tracks. */
export function useSpotifyPlaylistCache(): SpotifyPlaylistCache | null {
  const [revision, setRevision] = useState(0);

  useEffect(() => subscribeSpotifyPlaylist(() => setRevision((n) => n + 1)), []);

  return useMemo(() => {
    void revision;
    const selected = getSelectedSpotifyPlaylist();
    const cache = getPlaylistCache();
    if (!selected || !cache || cache.playlistId !== selected.id) {
      return null;
    }
    return cache;
  }, [revision]);
}
