import { useEffect, useState } from 'react';
import {
  loadToolsPreferences,
  saveToolsPreferences,
  subscribeToolsPreferences,
  type ToolsPreferences,
} from '../tools/toolsPreferences';

export function useToolsPreferences(): {
  prefs: ToolsPreferences;
  setProductionAllRoles: (enabled: boolean) => void;
} {
  const [prefs, setPrefs] = useState<ToolsPreferences>(() => loadToolsPreferences());

  useEffect(() => {
    return subscribeToolsPreferences(() => {
      setPrefs(loadToolsPreferences());
    });
  }, []);

  const setProductionAllRoles = (enabled: boolean): void => {
    saveToolsPreferences({ productionAllRoles: enabled });
  };

  return { prefs, setProductionAllRoles };
}

/** Bumps when tools preferences change — panels use this to re-derive
 *  in-memory results without re-fetching. */
export function useToolsPreferencesRevision(): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    return subscribeToolsPreferences(() => {
      setRevision((value) => value + 1);
    });
  }, []);

  return revision;
}
