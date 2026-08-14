import { beforeEach, describe, expect, it } from 'vitest';
import {
  _clearToolsPreferencesForTesting,
  loadToolsPreferences,
  saveToolsPreferences,
} from '../toolsPreferences';

const STORAGE_KEY = 'anime-tools:preferences:v1';

beforeEach(() => {
  localStorage.clear();
  _clearToolsPreferencesForTesting();
});

describe('tools preferences', () => {
  it('defaults Best Match by Title on for new and legacy preferences', () => {
    expect(loadToolsPreferences().bumpChartBestMatchByTitle).toBe(true);

    _clearToolsPreferencesForTesting();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ productionAllRoles: true }));
    expect(loadToolsPreferences()).toMatchObject({
      productionAllRoles: true,
      bumpChartBestMatchByTitle: true,
      bumpChartMalExportImages: false,
      seasonalScoresShowRepeats: false,
      seasonalScoresSpanAiringSeasons: false,
      weeklyCalendarShowUnscheduledColumn: false,
    });
  });

  it('persists Best Match by Title when disabled', () => {
    saveToolsPreferences({ bumpChartBestMatchByTitle: false });

    expect(loadToolsPreferences().bumpChartBestMatchByTitle).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({
      bumpChartBestMatchByTitle: false,
    });
  });

  it('defaults MAL export images off and persists the opt-in', () => {
    expect(loadToolsPreferences().bumpChartMalExportImages).toBe(false);

    saveToolsPreferences({ bumpChartMalExportImages: true });

    expect(loadToolsPreferences().bumpChartMalExportImages).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({
      bumpChartMalExportImages: true,
    });
  });

  it('persists Seasonal Scores and Weekly Calendar settings', () => {
    saveToolsPreferences({
      seasonalScoresShowRepeats: true,
      seasonalScoresSpanAiringSeasons: true,
      weeklyCalendarShowUnscheduledColumn: true,
    });

    expect(loadToolsPreferences()).toMatchObject({
      seasonalScoresShowRepeats: true,
      seasonalScoresSpanAiringSeasons: true,
      weeklyCalendarShowUnscheduledColumn: true,
    });
  });

  it('migrates settings previously saved in panel forms', () => {
    localStorage.setItem(
      'anime-tools-seasonal-scores-form',
      JSON.stringify({ spanAiringSeasons: true }),
    );
    localStorage.setItem(
      'anime-tools-weekly-calendar-form',
      JSON.stringify({ showUnscheduledColumn: true }),
    );

    expect(loadToolsPreferences()).toMatchObject({
      seasonalScoresSpanAiringSeasons: true,
      weeklyCalendarShowUnscheduledColumn: true,
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({
      seasonalScoresSpanAiringSeasons: true,
      weeklyCalendarShowUnscheduledColumn: true,
    });
  });
});
