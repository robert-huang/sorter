import { useEffect, useState } from 'react';
import {
  loadThemeSongNameDisplayMode,
  saveThemeSongNameDisplayMode,
  subscribeThemeSongNameDisplayMode,
  type ThemeSongNameDisplayMode,
} from '../lib/spotify/themeSongDisplayPreferences';

export function useThemeSongDisplayPreferences(): {
  mode: ThemeSongNameDisplayMode;
  setMode: (mode: ThemeSongNameDisplayMode) => void;
} {
  const [mode, setModeState] = useState<ThemeSongNameDisplayMode>(() =>
    loadThemeSongNameDisplayMode(),
  );

  useEffect(() => {
    return subscribeThemeSongNameDisplayMode(() => {
      setModeState(loadThemeSongNameDisplayMode());
    });
  }, []);

  const setMode = (next: ThemeSongNameDisplayMode): void => {
    saveThemeSongNameDisplayMode(next);
  };

  return { mode, setMode };
}
