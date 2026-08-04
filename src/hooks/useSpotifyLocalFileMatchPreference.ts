import { useEffect, useState } from 'react';
import {
  loadSpotifyLocalFileMatchMode,
  saveSpotifyLocalFileMatchMode,
  subscribeSpotifyLocalFileMatchMode,
  type SpotifyLocalFileMatchMode,
} from '../lib/spotify/spotifyLocalFileMatchPreferences';

export function useSpotifyLocalFileMatchPreference(): {
  mode: SpotifyLocalFileMatchMode;
  setMode: (mode: SpotifyLocalFileMatchMode) => void;
} {
  const [mode, setModeState] = useState<SpotifyLocalFileMatchMode>(
    loadSpotifyLocalFileMatchMode,
  );

  useEffect(
    () =>
      subscribeSpotifyLocalFileMatchMode(() => {
        setModeState(loadSpotifyLocalFileMatchMode());
      }),
    [],
  );

  return {
    mode,
    setMode: saveSpotifyLocalFileMatchMode,
  };
}
