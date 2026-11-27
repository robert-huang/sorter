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
      weeklyCalendarShowThemeSongs: false,
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
      weeklyCalendarShowThemeSongs: true,
    });

    expect(loadToolsPreferences()).toMatchObject({
      seasonalScoresShowRepeats: true,
      seasonalScoresSpanAiringSeasons: true,
      weeklyCalendarShowUnscheduledColumn: true,
      weeklyCalendarShowThemeSongs: true,
    });
  });

  it('migrates settings previously saved in panel forms', () => {
    localStorage.setItem(
      'anime-tools-seasonal-scores-form',
      JSON.stringify({ spanAiringSeasons: true }),
    );
    localStorage.setItem(
      'anime-tools-weekly-calendar-form',
      JSON.stringify({
        showUnscheduledColumn: true,
        showThemeSongs: true,
      }),
    );

    expect(loadToolsPreferences()).toMatchObject({
      seasonalScoresSpanAiringSeasons: true,
      weeklyCalendarShowUnscheduledColumn: true,
      weeklyCalendarShowThemeSongs: true,
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({
      seasonalScoresSpanAiringSeasons: true,
      weeklyCalendarShowUnscheduledColumn: true,
      weeklyCalendarShowThemeSongs: true,
    });
  });

  it('migrates Weekly Calendar week start and time zone from the panel form', () => {
    localStorage.setItem(
      'anime-tools-weekly-calendar-form',
      JSON.stringify({ weekStartDay: 'SUNDAY', timezone: 'pacific' }),
    );

    expect(loadToolsPreferences()).toMatchObject({
      weeklyCalendarWeekStartDay: 'SUNDAY',
      weeklyCalendarTimezone: 'pacific',
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({
      weeklyCalendarWeekStartDay: 'SUNDAY',
      weeklyCalendarTimezone: 'pacific',
    });
  });

  it('migrates week start and time zone into existing preferences, ignoring invalid values', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ productionAllRoles: true }));
    localStorage.setItem(
      'anime-tools-weekly-calendar-form',
      JSON.stringify({ weekStartDay: 'FUNDAY', timezone: 'utc' }),
    );

    expect(loadToolsPreferences()).toMatchObject({
      productionAllRoles: true,
      weeklyCalendarWeekStartDay: 'MONDAY',
      weeklyCalendarTimezone: 'utc',
    });

    saveToolsPreferences({ weeklyCalendarWeekStartDay: 'SATURDAY' });
    _clearToolsPreferencesForTesting();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ weeklyCalendarWeekStartDay: 'SATURDAY', weeklyCalendarTimezone: 'local' }),
    );
    expect(loadToolsPreferences()).toMatchObject({
      weeklyCalendarWeekStartDay: 'SATURDAY',
      weeklyCalendarTimezone: 'local',
    });
  });
});
