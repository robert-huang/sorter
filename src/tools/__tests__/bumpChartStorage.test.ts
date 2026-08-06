import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetStateStorageForTesting } from '../../lib/stateStorageDb';
import type { BumpChartWorkspaceSnapshot } from '../panels/bumpChartStorage';
import {
  BUMP_CHART_SLOT_LIMIT,
  _resetBumpChartStorageCacheForTesting,
  deleteSavedBumpChart,
  initializeBumpChartStorage,
  listSavedBumpCharts,
  loadActiveBumpChartWorkspace,
  loadSavedBumpChart,
  saveActiveBumpChartWorkspace,
  saveNamedBumpChart,
} from '../panels/bumpChartStorage';

const ACTIVE_KEY = 'tools:bump-chart:workspace:v1';

function workspace(
  bestMatchByTitle = true,
): BumpChartWorkspaceSnapshot {
  return {
    version: 1,
    view: 'chart',
    before: {
      items: [
        {
          item: { id: 'AAAAAAAAAAAAAA', label: 'Before' },
        },
      ],
      hiddenItemIds: [],
      preserveCustomLabels: false,
    },
    after: {
      items: [
        {
          item: { id: 'QQQQQQQQQQQQQQ', label: 'After' },
        },
      ],
      hiddenItemIds: ['QQQQQQQQQQQQQQ'],
      preserveCustomLabels: true,
    },
    bestMatchByTitle,
    lastImportTab: 'anilist',
  };
}

beforeEach(async () => {
  localStorage.clear();
  await _resetStateStorageForTesting();
  _resetBumpChartStorageCacheForTesting();
  vi.restoreAllMocks();
});

describe('Bump Chart workspace storage', () => {
  it('round-trips the versioned active workspace', async () => {
    const value = workspace(false);
    expect(await saveActiveBumpChartWorkspace(value)).toEqual({ ok: true });
    expect(loadActiveBumpChartWorkspace()).toEqual(value);
    expect(localStorage.getItem(ACTIVE_KEY)).toBeNull();
  });

  it('defaults fields that were absent from an earlier v1 record', async () => {
    await _resetStateStorageForTesting();
    _resetBumpChartStorageCacheForTesting();
    localStorage.clear();
    const value = workspace();
    localStorage.setItem(
      ACTIVE_KEY,
      JSON.stringify({
        version: 1,
        view: 'staging',
        before: { items: value.before.items },
        after: { items: value.after.items },
      }),
    );
    await initializeBumpChartStorage();

    expect(loadActiveBumpChartWorkspace()).toEqual({
      version: 1,
      view: 'staging',
      before: {
        items: value.before.items,
        hiddenItemIds: [],
        preserveCustomLabels: false,
      },
      after: {
        items: value.after.items,
        hiddenItemIds: [],
        preserveCustomLabels: false,
      },
      bestMatchByTitle: true,
      lastImportTab: 'single',
    });
  });

  it('ignores malformed, corrupt, and unknown-version workspaces', async () => {
    await _resetStateStorageForTesting();
    localStorage.clear();
    localStorage.setItem(ACTIVE_KEY, '{bad json');
    await initializeBumpChartStorage();
    expect(loadActiveBumpChartWorkspace()).toBeNull();

    await _resetStateStorageForTesting();
    _resetBumpChartStorageCacheForTesting();
    localStorage.clear();
    localStorage.setItem(
      ACTIVE_KEY,
      JSON.stringify({ ...workspace(), version: 2 }),
    );
    await initializeBumpChartStorage();
    expect(loadActiveBumpChartWorkspace()).toBeNull();

    await _resetStateStorageForTesting();
    _resetBumpChartStorageCacheForTesting();
    localStorage.clear();
    localStorage.setItem(
      ACTIVE_KEY,
      JSON.stringify({
        ...workspace(),
        before: { items: [{ item: { id: 4 } }] },
      }),
    );
    await initializeBumpChartStorage();
    expect(loadActiveBumpChartWorkspace()).toBeNull();
  });

  it('requires explicit replacement for duplicate named charts', async () => {
    const original = await saveNamedBumpChart(
      'Season ranking',
      workspace(false),
    );
    expect(original.status).toBe('saved');
    if (original.status !== 'saved') {
      throw new Error('Named chart was not saved');
    }

    const duplicate = await saveNamedBumpChart(
      'season ranking',
      workspace(true),
    );
    expect(duplicate).toEqual({ status: 'exists', meta: original.meta });
    expect(loadSavedBumpChart(original.meta.id)?.bestMatchByTitle).toBe(false);

    const replaced = await saveNamedBumpChart(
      'season ranking',
      workspace(true),
      original.meta.id,
    );
    expect(replaced.status).toBe('saved');
    expect(listSavedBumpCharts()).toHaveLength(1);
    expect(loadSavedBumpChart(original.meta.id)?.bestMatchByTitle).toBe(true);

    expect(await deleteSavedBumpChart(original.meta.id)).toEqual({ ok: true });
    expect(listSavedBumpCharts()).toEqual([]);
    expect(loadSavedBumpChart(original.meta.id)).toBeNull();
  });

  it('enforces the slot cap without silently evicting a chart', async () => {
    for (let index = 0; index < BUMP_CHART_SLOT_LIMIT; index += 1) {
      expect(
        (await saveNamedBumpChart(`Chart ${index}`, workspace())).status,
      ).toBe('saved');
    }

    expect(await saveNamedBumpChart('One too many', workspace())).toEqual({
      status: 'limit',
    });
    expect(listSavedBumpCharts()).toHaveLength(BUMP_CHART_SLOT_LIMIT);
  });
});
