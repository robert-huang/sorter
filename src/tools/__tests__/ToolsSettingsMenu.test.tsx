import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceDbSyncControls } from '../../hooks/useSourceDbSync';
import { ToolsSettingsMenu } from '../ToolsSettingsMenu';
import {
  _clearToolsPreferencesForTesting,
  loadToolsPreferences,
  saveToolsPreferences,
} from '../toolsPreferences';

const DB_SYNC: SourceDbSyncControls = {
  autosaveAvailable: false,
  cloudStatus: 'unavailable',
  cloudActionError: null,
  onCloudSignIn: vi.fn(),
  onCloudPickFolder: vi.fn(),
  onCloudSignOut: vi.fn(),
  dbPushingIds: new Set(),
  dbPullingIds: new Set(),
  sourceDbErrors: {},
  dbSyncRevision: 0,
  dbSyncChange: { kind: 'all' },
  bumpSourceDbDirty: vi.fn(),
  refreshDbSyncRevision: vi.fn(),
  onDbPushSource: vi.fn(),
  onDbPullSource: vi.fn(),
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  localStorage.clear();
  _clearToolsPreferencesForTesting();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ToolsSettingsMenu', () => {
  it('explains and persists Best match by title', async () => {
    await act(async () => {
      root.render(
        <ToolsSettingsMenu
          activeTool="bump-chart"
          historyBackGuard={false}
          onToggleHistoryBackGuard={vi.fn()}
          dbSync={DB_SYNC}
        />,
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Settings"]')
        ?.click();
    });

    const toolSections = Array.from(
      container.querySelectorAll('.edit-item-advanced-title'),
    )
      .map((element) => element.textContent?.trim())
      .filter((label) =>
        ['Seasonal Scores', 'Weekly Calendar', 'Shared Staff', 'Bump Chart'].includes(
          label ?? '',
        ),
      );
    expect(toolSections).toEqual([
      'Seasonal Scores',
      'Weekly Calendar',
      'Shared Staff',
      'Bump Chart',
    ]);
    const settingsSections = Array.from(
      container.querySelectorAll<HTMLElement>('[data-tool-settings-section]'),
    );
    expect(
      settingsSections
        .filter((section) => section.classList.contains('active'))
        .map((section) => section.dataset.toolSettingsSection),
    ).toEqual(['bump-chart']);

    const findCheckbox = (label: string): HTMLInputElement | undefined =>
      Array.from(
        container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ).find((input) => input.closest('label')?.textContent?.includes(label));

    const showRepeatsCheckbox = findCheckbox('Show repeats');
    const spanAiringCheckbox = findCheckbox('Span airing seasons');
    const showThemeSongsCheckbox = findCheckbox('Show theme songs');
    const unknownAiringDayCheckbox = findCheckbox('Unknown Airing Day column');
    expect(showRepeatsCheckbox?.checked).toBe(false);
    expect(spanAiringCheckbox?.checked).toBe(false);
    expect(showThemeSongsCheckbox?.checked).toBe(false);
    expect(unknownAiringDayCheckbox?.checked).toBe(false);

    await act(async () => {
      showRepeatsCheckbox?.click();
      spanAiringCheckbox?.click();
      showThemeSongsCheckbox?.click();
      unknownAiringDayCheckbox?.click();
    });
    expect(loadToolsPreferences()).toMatchObject({
      seasonalScoresShowRepeats: true,
      seasonalScoresSpanAiringSeasons: true,
      weeklyCalendarShowThemeSongs: true,
      weeklyCalendarShowUnscheduledColumn: true,
    });

    expect(container.textContent).toContain('Bump Chart');
    const checkbox = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).find(
      (input) =>
        input.closest('label')?.textContent?.includes('Best match by title') ===
        true,
    );
    const label = checkbox?.closest('label');
    expect(checkbox?.checked).toBe(true);
    expect(label?.title).toContain('Exact logical IDs always match first');
    expect(
      container.querySelector('[aria-label="Best match by title help"]'),
    ).toBeNull();

    await act(async () => {
      checkbox?.click();
    });
    expect(loadToolsPreferences().bumpChartBestMatchByTitle).toBe(false);

    const bumpChartCheckboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).filter((input) =>
      [
        'Best match by title',
        'Include images in PNG exports',
        'Use MyAnimeList images in PNG exports',
      ].some((label) => input.closest('label')?.textContent?.includes(label)),
    );
    expect(
      bumpChartCheckboxes.map((input) => input.closest('label')?.textContent?.trim()),
    ).toEqual([
      'Best match by title',
      'Include images in PNG exports',
      'Use MyAnimeList images in PNG exports',
    ]);

    const includeImagesCheckbox = bumpChartCheckboxes[1];
    expect(includeImagesCheckbox?.checked).toBe(false);
    const malCheckbox = bumpChartCheckboxes[2];
    expect(malCheckbox?.checked).toBe(false);
    expect(malCheckbox?.disabled).toBe(true);

    await act(async () => {
      includeImagesCheckbox?.click();
    });
    expect(loadToolsPreferences().bumpChartIncludeExportImages).toBe(true);
    expect(malCheckbox?.disabled).toBe(false);

    await act(async () => {
      malCheckbox?.click();
    });
    expect(loadToolsPreferences().bumpChartMalExportImages).toBe(true);

    await act(async () => {
      includeImagesCheckbox?.click();
    });
    expect(malCheckbox?.disabled).toBe(true);
    expect(malCheckbox?.checked).toBe(true);
    expect(loadToolsPreferences().bumpChartMalExportImages).toBe(true);

    const databaseTab = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Database',
    );
    await act(async () => {
      databaseTab?.click();
    });
    expect(container.textContent).toContain('Advanced storage diagnostics');
  });

  it('fades every tool-specific section on tabs without their own settings', async () => {
    await act(async () => {
      root.render(
        <ToolsSettingsMenu
          activeTool="shared-credits"
          historyBackGuard={false}
          onToggleHistoryBackGuard={vi.fn()}
          dbSync={DB_SYNC}
        />,
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Settings"]')
        ?.click();
    });

    const settingsSections = Array.from(
      container.querySelectorAll<HTMLElement>('[data-tool-settings-section]'),
    );
    expect(settingsSections).toHaveLength(5);
    expect(settingsSections.every((section) => !section.classList.contains('active'))).toBe(
      true,
    );
    expect(
      container
        .querySelector('.settings-anilist-display-prefs')
        ?.closest('.tools-settings-section'),
    ).toBeNull();
    expect(container.querySelector('.settings-footer')?.closest('.tools-settings-section')).toBeNull();
  });

  it('right-click on Fit to 0–100 resets the scale to the defaults, even with no fit', async () => {
    saveToolsPreferences({ scoreComparisonTargetMean: 55, scoreComparisonTargetStdDev: 22 });
    await act(async () => {
      root.render(
        <ToolsSettingsMenu
          activeTool="score-comparison"
          historyBackGuard={false}
          onToggleHistoryBackGuard={vi.fn()}
          dbSync={DB_SYNC}
        />,
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Settings"]')
        ?.click();
    });

    const fitButton = container.querySelector<HTMLButtonElement>('.tools-settings-fit-button');
    expect(fitButton?.getAttribute('aria-disabled')).toBe('true');
    expect(fitButton?.title).toContain('Right-click to reset');

    await act(async () => {
      fitButton?.click();
    });
    expect(loadToolsPreferences()).toMatchObject({
      scoreComparisonTargetMean: 55,
      scoreComparisonTargetStdDev: 22,
    });

    await act(async () => {
      fitButton?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(loadToolsPreferences()).toMatchObject({
      scoreComparisonTargetMean: 70,
      scoreComparisonTargetStdDev: 15,
    });
  });
});
