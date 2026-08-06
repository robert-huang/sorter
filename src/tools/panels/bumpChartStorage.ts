import type { BumpChartItem } from './bumpChartLogic';
import {
  BUMP_WORKSPACE_STORE,
  STATE_METADATA_STORE,
  commitStateChanges,
  initializeStateStorage,
  readAllStateEntries,
  readStateRecord,
  stateStorageRecordKeys,
} from '../../lib/stateStorageDb';
import {
  isLegacyBumpChartManifest,
  isLegacyBumpChartSideSnapshot,
  isLegacyBumpChartWorkspace,
} from '../../lib/stateStorageValidation';
export const BUMP_CHART_SLOT_LIMIT = 20;

export type BumpChartImportTab =
  | 'single'
  | 'multiple'
  | 'anilist'
  | 'sortresults';

export type BumpChartSideSnapshot = {
  items: BumpChartItem[];
  hiddenItemIds: string[];
  preserveCustomLabels: boolean;
};

export type BumpChartWorkspaceSnapshot = {
  version: 1;
  view: 'staging' | 'chart';
  before: BumpChartSideSnapshot;
  after: BumpChartSideSnapshot;
  bestMatchByTitle: boolean;
  lastImportTab: BumpChartImportTab;
};

export type SavedBumpChartMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

type SavedBumpChartManifest = {
  version: 1;
  slots: SavedBumpChartMeta[];
};

type SavedBumpChartRecord = {
  version: 1;
  workspace: BumpChartWorkspaceSnapshot;
};

export type BumpChartStorageResult =
  | { ok: true }
  | { ok: false; error: string };

export type SaveNamedBumpChartResult =
  | { status: 'saved'; meta: SavedBumpChartMeta }
  | { status: 'exists'; meta: SavedBumpChartMeta }
  | { status: 'limit' }
  | { status: 'error'; error: string };

function parseSideSnapshot(value: unknown): BumpChartSideSnapshot | null {
  if (!isLegacyBumpChartSideSnapshot(value)) return null;
  const candidate = value as Partial<BumpChartSideSnapshot>;
  const hiddenItemIds = Array.isArray(candidate.hiddenItemIds)
    ? candidate.hiddenItemIds.filter(
        (id): id is string => typeof id === 'string',
      )
    : [];
  return {
    items: candidate.items!,
    hiddenItemIds,
    preserveCustomLabels: candidate.preserveCustomLabels === true,
  };
}

function parseWorkspaceSnapshot(
  value: unknown,
): BumpChartWorkspaceSnapshot | null {
  if (!isLegacyBumpChartWorkspace(value)) return null;
  const candidate = value as Partial<BumpChartWorkspaceSnapshot>;
  const before = parseSideSnapshot(candidate.before);
  const after = parseSideSnapshot(candidate.after);
  if (!before || !after) return null;
  const lastImportTab: BumpChartImportTab =
    candidate.lastImportTab === 'multiple' ||
    candidate.lastImportTab === 'anilist' ||
    candidate.lastImportTab === 'sortresults'
      ? candidate.lastImportTab
      : 'single';
  return {
    version: 1,
    view: candidate.view!,
    before,
    after,
    bestMatchByTitle: candidate.bestMatchByTitle !== false,
    lastImportTab,
  };
}

function parseManifest(value: unknown): SavedBumpChartManifest {
  if (!isLegacyBumpChartManifest(value)) return { version: 1, slots: [] };
  return { version: 1, slots: value.slots as SavedBumpChartMeta[] };
}

function storageError(error: unknown): string {
  const message =
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
      ? error.message
      : null;
  return message
    ? `Bump Chart storage failed: ${message}`
    : 'Bump Chart storage failed.';
}

function createSlotId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

let activeWorkspaceCache: BumpChartWorkspaceSnapshot | null = null;
let manifestCache: SavedBumpChartManifest = { version: 1, slots: [] };
const savedWorkspaceCache = new Map<string, BumpChartWorkspaceSnapshot>();
let hydrationPromise: Promise<void> | null = null;
let activeWorkspaceWriteQueue: Promise<void> = Promise.resolve();
let lastBumpChartOperation: Promise<unknown> = Promise.resolve();

export async function initializeBumpChartStorage(): Promise<void> {
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    await initializeStateStorage();
    activeWorkspaceCache =
      parseWorkspaceSnapshot(
        await readStateRecord<unknown>(BUMP_WORKSPACE_STORE, 'active'),
      ) ?? null;
    manifestCache = parseManifest(
      await readStateRecord<unknown>(
        STATE_METADATA_STORE,
        stateStorageRecordKeys.bumpManifest,
      ),
    );
    savedWorkspaceCache.clear();
    for (const [key, value] of await readAllStateEntries<unknown>(
      BUMP_WORKSPACE_STORE,
    )) {
      const id = String(key);
      if (id === 'active') continue;
      const record = value as Partial<SavedBumpChartRecord> | null;
      const workspace =
        record?.version === 1
          ? parseWorkspaceSnapshot(record.workspace)
          : parseWorkspaceSnapshot(value);
      if (workspace) savedWorkspaceCache.set(id, workspace);
    }
    const filteredSlots = manifestCache.slots.filter((slot) =>
      savedWorkspaceCache.has(slot.id),
    );
    if (filteredSlots.length !== manifestCache.slots.length) {
      manifestCache = { version: 1, slots: filteredSlots };
      await commitStateChanges([
        {
          type: 'put',
          store: STATE_METADATA_STORE,
          key: stateStorageRecordKeys.bumpManifest,
          value: manifestCache,
        },
      ]);
    }
  })();
  return hydrationPromise;
}

export async function refreshBumpChartStorage(): Promise<void> {
  hydrationPromise = null;
  await initializeBumpChartStorage();
}

export function loadActiveBumpChartWorkspace(): BumpChartWorkspaceSnapshot | null {
  return activeWorkspaceCache;
}

export async function saveActiveBumpChartWorkspace(
  workspace: BumpChartWorkspaceSnapshot,
): Promise<BumpChartStorageResult> {
  activeWorkspaceCache = workspace;
  const operation = (async (): Promise<BumpChartStorageResult> => {
    await initializeBumpChartStorage();
    activeWorkspaceCache = workspace;
    let result: BumpChartStorageResult = { ok: true };
    activeWorkspaceWriteQueue = activeWorkspaceWriteQueue.then(async () => {
      try {
        await commitStateChanges(
          [
            {
              type: 'put',
              store: BUMP_WORKSPACE_STORE,
              key: 'active',
              value: workspace,
            },
          ],
          { scope: 'bump', id: 'active' },
        );
      } catch (error) {
        result = { ok: false, error: storageError(error) };
      }
    });
    await activeWorkspaceWriteQueue;
    return result;
  })();
  lastBumpChartOperation = operation;
  return operation;
}

export function listSavedBumpCharts(): SavedBumpChartMeta[] {
  return [...manifestCache.slots].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadSavedBumpChart(
  id: string,
): BumpChartWorkspaceSnapshot | null {
  return savedWorkspaceCache.get(id) ?? null;
}

export async function saveNamedBumpChart(
  name: string,
  workspace: BumpChartWorkspaceSnapshot,
  replaceId?: string,
): Promise<SaveNamedBumpChartResult> {
  await initializeBumpChartStorage();
  const trimmedName = name.trim();
  if (!trimmedName) {
    return { status: 'error', error: 'Enter a chart name.' };
  }
  const manifest = manifestCache;
  const duplicate = manifest.slots.find(
    (slot) => slot.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase(),
  );
  if (duplicate && duplicate.id !== replaceId) {
    return { status: 'exists', meta: duplicate };
  }
  if (!duplicate && manifest.slots.length >= BUMP_CHART_SLOT_LIMIT) {
    return { status: 'limit' };
  }

  const now = Date.now();
  const existing =
    duplicate ?? manifest.slots.find((slot) => slot.id === replaceId);
  const meta: SavedBumpChartMeta = {
    id: existing?.id ?? createSlotId(),
    name: trimmedName,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  try {
    const nextManifest: SavedBumpChartManifest = {
      version: 1,
      slots: [meta, ...manifest.slots.filter((slot) => slot.id !== meta.id)],
    };
    const operation = commitStateChanges(
      [
        {
          type: 'put',
          store: BUMP_WORKSPACE_STORE,
          key: meta.id,
          value: { version: 1, workspace } satisfies SavedBumpChartRecord,
        },
        {
          type: 'put',
          store: STATE_METADATA_STORE,
          key: stateStorageRecordKeys.bumpManifest,
          value: nextManifest,
        },
      ],
      { scope: 'bump', id: meta.id },
    );
    lastBumpChartOperation = operation;
    await operation;
    savedWorkspaceCache.set(meta.id, workspace);
    manifestCache = nextManifest;
    return { status: 'saved', meta };
  } catch (error) {
    return { status: 'error', error: storageError(error) };
  }
}

export async function deleteSavedBumpChart(
  id: string,
): Promise<BumpChartStorageResult> {
  await initializeBumpChartStorage();
  const manifest = manifestCache;
  try {
    const nextManifest: SavedBumpChartManifest = {
      version: 1,
      slots: manifest.slots.filter((slot) => slot.id !== id),
    };
    const operation = commitStateChanges(
      [
        { type: 'delete', store: BUMP_WORKSPACE_STORE, key: id },
        {
          type: 'put',
          store: STATE_METADATA_STORE,
          key: stateStorageRecordKeys.bumpManifest,
          value: nextManifest,
        },
      ],
      { scope: 'bump', id },
    );
    lastBumpChartOperation = operation;
    await operation;
    savedWorkspaceCache.delete(id);
    manifestCache = nextManifest;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: storageError(error) };
  }
}

export async function _clearBumpChartStorageForTesting(): Promise<void> {
  _resetBumpChartStorageCacheForTesting();
  await initializeStateStorage();
  await commitStateChanges([
    { type: 'clear', store: BUMP_WORKSPACE_STORE },
    {
      type: 'put',
      store: STATE_METADATA_STORE,
      key: stateStorageRecordKeys.bumpManifest,
      value: manifestCache,
    },
  ]);
}

export function _resetBumpChartStorageCacheForTesting(): void {
  activeWorkspaceCache = null;
  manifestCache = { version: 1, slots: [] };
  savedWorkspaceCache.clear();
  hydrationPromise = null;
  activeWorkspaceWriteQueue = Promise.resolve();
  lastBumpChartOperation = Promise.resolve();
}

export async function flushBumpChartStorageWrites(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await Promise.resolve();
    const active = activeWorkspaceWriteQueue;
    const operation = lastBumpChartOperation;
    await Promise.allSettled([active, operation]);
    if (
      active === activeWorkspaceWriteQueue &&
      operation === lastBumpChartOperation
    ) {
      return;
    }
  }
}
