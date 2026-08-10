import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceDbSyncControls } from '../../hooks/useSourceDbSync';
import { ToolsSettingsMenu } from '../ToolsSettingsMenu';
import {
  _clearToolsPreferencesForTesting,
  loadToolsPreferences,
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
});
