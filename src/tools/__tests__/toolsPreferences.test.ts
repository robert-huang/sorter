import { beforeEach, describe, expect, it } from 'vitest';
import {
  _clearToolsPreferencesForTesting,
  loadToolsPreferences,
  saveToolsPreferences,
} from '../toolsPreferences';

const STORAGE_KEY = 'anime-tools:preferences:v1';

beforeEach(() => {
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
});
