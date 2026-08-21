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
  setBumpChartBestMatchByTitle: (enabled: boolean) => void;
  setBumpChartIncludeExportImages: (enabled: boolean) => void;
  setBumpChartMalExportImages: (enabled: boolean) => void;
  setSeasonalScoresShowRepeats: (enabled: boolean) => void;
  setSeasonalScoresSpanAiringSeasons: (enabled: boolean) => void;
  setWeeklyCalendarShowUnscheduledColumn: (enabled: boolean) => void;
  setWeeklyCalendarShowThemeSongs: (enabled: boolean) => void;
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

  const setBumpChartBestMatchByTitle = (enabled: boolean): void => {
    saveToolsPreferences({ bumpChartBestMatchByTitle: enabled });
  };

  const setBumpChartIncludeExportImages = (enabled: boolean): void => {
    saveToolsPreferences({ bumpChartIncludeExportImages: enabled });
  };

  const setBumpChartMalExportImages = (enabled: boolean): void => {
    saveToolsPreferences({ bumpChartMalExportImages: enabled });
  };

  const setSeasonalScoresShowRepeats = (enabled: boolean): void => {
    saveToolsPreferences({ seasonalScoresShowRepeats: enabled });
  };

  const setSeasonalScoresSpanAiringSeasons = (enabled: boolean): void => {
    saveToolsPreferences({ seasonalScoresSpanAiringSeasons: enabled });
  };

  const setWeeklyCalendarShowUnscheduledColumn = (enabled: boolean): void => {
    saveToolsPreferences({ weeklyCalendarShowUnscheduledColumn: enabled });
  };

  const setWeeklyCalendarShowThemeSongs = (enabled: boolean): void => {
    saveToolsPreferences({ weeklyCalendarShowThemeSongs: enabled });
  };

  return {
    prefs,
    setProductionAllRoles,
    setBumpChartBestMatchByTitle,
    setBumpChartIncludeExportImages,
    setBumpChartMalExportImages,
    setSeasonalScoresShowRepeats,
    setSeasonalScoresSpanAiringSeasons,
    setWeeklyCalendarShowUnscheduledColumn,
    setWeeklyCalendarShowThemeSongs,
  };
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
