import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUMP_MANIFEST_BACKUP_KEY,
  STATE_METADATA_STORE,
  _resetStateStorageForTesting,
  commitStateChanges,
  readStateRecord,
  stateStorageRecordKeys,
} from '../../lib/stateStorageDb';
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
    version: 2,
    view: 'chart',
    columns: [
      {
        id: 'previous-1',
        kind: 'previous',
        items: [
          {
            item: { id: 'AAAAAAAAAAAAAA', label: 'Oldest' },
          },
        ],
        hiddenItemIds: [],
        preserveCustomLabels: false,
      },
      {
        id: 'previous-2',
        kind: 'previous',
        items: [
          {
            item: { id: 'gggggggggggggg', label: 'Previous' },
          },
        ],
        hiddenItemIds: ['gggggggggggggg'],
        preserveCustomLabels: true,
      },
      {
        id: 'current',
        kind: 'current',
        items: [
          {
            item: { id: 'QQQQQQQQQQQQQQ', label: 'Current' },
          },
        ],
        hiddenItemIds: [],
        preserveCustomLabels: true,
      },
    ],
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

  it('round-trips order names through active and named workspaces', async () => {
    const value = workspace(false);
    value.columns = value.columns.map((column, index) => ({
      ...column,
      name: ['Winter list', 'Spring list', 'Current list'][index],
    }));
    expect(await saveActiveBumpChartWorkspace(value)).toEqual({ ok: true });
    const saved = await saveNamedBumpChart('Named timeline', value);
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') {
      throw new Error('Named chart was not saved');
    }

    _resetBumpChartStorageCacheForTesting();
    await initializeBumpChartStorage();

    expect(loadActiveBumpChartWorkspace()?.columns.map(({ name }) => name)).toEqual(
      ['Winter list', 'Spring list', 'Current list'],
    );
    expect(
      loadSavedBumpChart(saved.meta.id)?.columns.map(({ name }) => name),
    ).toEqual(['Winter list', 'Spring list', 'Current list']);
  });

  it('defaults fields that were absent from an earlier v1 record', async () => {
    await _resetStateStorageForTesting();
    _resetBumpChartStorageCacheForTesting();
    localStorage.clear();
    const value = workspace();
    const before = value.columns[0]!;
    const after = value.columns[value.columns.length - 1]!;
    localStorage.setItem(
      ACTIVE_KEY,
      JSON.stringify({
        version: 1,
        view: 'staging',
        before: { items: before.items },
        after: { items: after.items },
      }),
    );
    await initializeBumpChartStorage();

    expect(loadActiveBumpChartWorkspace()).toEqual({
      version: 2,
      view: 'staging',
      columns: [
        {
          id: 'previous-1',
          kind: 'previous',
          items: before.items,
          hiddenItemIds: [],
          preserveCustomLabels: false,
        },
        {
          id: 'current',
          kind: 'current',
          items: after.items,
          hiddenItemIds: [],
          preserveCustomLabels: false,
        },
      ],
      bestMatchByTitle: true,
      lastImportTab: 'single',
    });
  });

  it('normalizes named v1 records to ordered v2 columns', async () => {
    const value = workspace();
    const before = value.columns[0]!;
    const after = value.columns[value.columns.length - 1]!;
    localStorage.setItem(
      'tools:bump-chart:saved-manifest:v1',
      JSON.stringify({
        version: 1,
        slots: [
          {
            id: 'legacy-slot',
            name: 'Legacy chart',
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }),
    );
    localStorage.setItem(
      'tools:bump-chart:saved:v1:legacy-slot',
      JSON.stringify({
        version: 1,
        workspace: {
          version: 1,
          view: 'chart',
          before,
          after,
          bestMatchByTitle: false,
          lastImportTab: 'multiple',
        },
      }),
    );

    await initializeBumpChartStorage();

    expect(loadSavedBumpChart('legacy-slot')).toEqual({
      version: 2,
      view: 'chart',
      columns: [
        { ...before, id: 'previous-1', kind: 'previous' },
        { ...after, id: 'current', kind: 'current' },
      ],
      bestMatchByTitle: false,
      lastImportTab: 'multiple',
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
      JSON.stringify({ ...workspace(), version: 3 }),
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
        columns: [
          { ...workspace().columns[0]!, items: [{ item: { id: 4 } }] },
          workspace().columns[workspace().columns.length - 1],
        ],
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

  it('recovers exact named-workspace metadata from independent records', async () => {
    const saved = await saveNamedBumpChart('Named timeline', workspace(false));
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') {
      throw new Error('Named chart was not saved');
    }
    localStorage.removeItem(BUMP_MANIFEST_BACKUP_KEY);
    await commitStateChanges([
      {
        type: 'put',
        store: STATE_METADATA_STORE,
        key: stateStorageRecordKeys.bumpManifest,
        value: 'corrupt-current',
      },
      {
        type: 'put',
        store: STATE_METADATA_STORE,
        key: stateStorageRecordKeys.bumpPreviousManifest,
        value: 'corrupt-previous',
      },
    ]);
    _resetBumpChartStorageCacheForTesting();

    await initializeBumpChartStorage();

    expect(listSavedBumpCharts()).toEqual([saved.meta]);
    expect(loadSavedBumpChart(saved.meta.id)).toEqual(workspace(false));
    expect(
      await readStateRecord(
        STATE_METADATA_STORE,
        stateStorageRecordKeys.bumpCorruptManifest,
      ),
    ).toMatchObject({ value: 'corrupt-current' });
  });

  it('recovers named charts when the IndexedDB metadata store is cleared', async () => {
    const saved = await saveNamedBumpChart('Cross-storage chart', workspace());
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') {
      throw new Error('Named chart was not saved');
    }
    expect(localStorage.getItem(BUMP_MANIFEST_BACKUP_KEY)).not.toBeNull();
    await commitStateChanges([
      { type: 'clear', store: STATE_METADATA_STORE },
    ]);
    _resetBumpChartStorageCacheForTesting();

    await initializeBumpChartStorage();

    expect(listSavedBumpCharts()).toEqual([saved.meta]);
    expect(loadSavedBumpChart(saved.meta.id)).toEqual(workspace());
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
