import { useEffect, useState } from 'react';
import {
  loadAnilistDisplayPreferences,
  saveAnilistDisplayPreferences,
  subscribeAnilistDisplayPreferences,
  type AnilistDisplayPreferences,
  type MediaTitleDisplayMode,
  type PersonNameDisplayMode,
} from '../lib/importers/anilist/displayPreferences';

export function useAnilistDisplayPreferences(): {
  prefs: AnilistDisplayPreferences;
  setMediaTitleMode: (mode: MediaTitleDisplayMode) => void;
  setPersonNameMode: (mode: PersonNameDisplayMode) => void;
  setCharacterNameMode: (mode: PersonNameDisplayMode) => void;
} {
  const [prefs, setPrefs] = useState<AnilistDisplayPreferences>(() =>
    loadAnilistDisplayPreferences(),
  );

  useEffect(() => {
    return subscribeAnilistDisplayPreferences(() => {
      setPrefs(loadAnilistDisplayPreferences());
    });
  }, []);

  const setMediaTitleMode = (mode: MediaTitleDisplayMode): void => {
    saveAnilistDisplayPreferences({ mediaTitleMode: mode });
  };

  const setPersonNameMode = (mode: PersonNameDisplayMode): void => {
    saveAnilistDisplayPreferences({ personNameMode: mode });
  };

  const setCharacterNameMode = (mode: PersonNameDisplayMode): void => {
    saveAnilistDisplayPreferences({ characterNameMode: mode });
  };

  return { prefs, setMediaTitleMode, setPersonNameMode, setCharacterNameMode };
}
