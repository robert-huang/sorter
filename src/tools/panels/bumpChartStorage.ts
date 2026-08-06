import type { BumpChartItem } from './bumpChartLogic';

const ACTIVE_WORKSPACE_KEY = 'tools:bump-chart:workspace:v1';
const SAVED_MANIFEST_KEY = 'tools:bump-chart:saved-manifest:v1';
const SAVED_SLOT_PREFIX = 'tools:bump-chart:saved:v1:';
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
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Partial<BumpChartSideSnapshot>;
  if (
    !Array.isArray(candidate.items) ||
    candidate.items.some(
      (entry) =>
        !entry ||
        typeof entry !== 'object' ||
        !entry.item ||
        typeof entry.item.id !== 'string' ||
        typeof entry.item.label !== 'string',
    )
  ) {
    return null;
  }
  const hiddenItemIds = Array.isArray(candidate.hiddenItemIds)
    ? candidate.hiddenItemIds.filter(
        (id): id is string => typeof id === 'string',
      )
    : [];
  return {
    items: candidate.items,
    hiddenItemIds,
    preserveCustomLabels: candidate.preserveCustomLabels === true,
  };
}

function parseWorkspaceSnapshot(
  value: unknown,
): BumpChartWorkspaceSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Partial<BumpChartWorkspaceSnapshot>;
  const before = parseSideSnapshot(candidate.before);
  const after = parseSideSnapshot(candidate.after);
  if (
    candidate.version !== 1 ||
    (candidate.view !== 'staging' && candidate.view !== 'chart') ||
    !before ||
    !after
  ) {
    return null;
  }
  const lastImportTab: BumpChartImportTab =
    candidate.lastImportTab === 'multiple' ||
    candidate.lastImportTab === 'anilist' ||
    candidate.lastImportTab === 'sortresults'
      ? candidate.lastImportTab
      : 'single';
  return {
    version: 1,
    view: candidate.view,
    before,
    after,
    bestMatchByTitle: candidate.bestMatchByTitle !== false,
    lastImportTab,
  };
}

function readManifest(): SavedBumpChartManifest {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(SAVED_MANIFEST_KEY) ?? '',
    ) as Partial<SavedBumpChartManifest>;
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.slots) ||
      parsed.slots.some(
        (slot) =>
          !slot ||
          typeof slot.id !== 'string' ||
          typeof slot.name !== 'string' ||
          typeof slot.createdAt !== 'number' ||
          typeof slot.updatedAt !== 'number',
      )
    ) {
      return { version: 1, slots: [] };
    }
    return { version: 1, slots: parsed.slots };
  } catch {
    return { version: 1, slots: [] };
  }
}

function slotKey(id: string): string {
  return `${SAVED_SLOT_PREFIX}${id}`;
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

export function loadActiveBumpChartWorkspace(): BumpChartWorkspaceSnapshot | null {
  try {
    const raw = localStorage.getItem(ACTIVE_WORKSPACE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    return parseWorkspaceSnapshot(parsed);
  } catch {
    return null;
  }
}

export function saveActiveBumpChartWorkspace(
  workspace: BumpChartWorkspaceSnapshot,
): BumpChartStorageResult {
  try {
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify(workspace));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: storageError(error) };
  }
}

export function listSavedBumpCharts(): SavedBumpChartMeta[] {
  return [...readManifest().slots].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadSavedBumpChart(
  id: string,
): BumpChartWorkspaceSnapshot | null {
  try {
    const raw = localStorage.getItem(slotKey(id));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<SavedBumpChartRecord>;
    return parsed.version === 1
      ? parseWorkspaceSnapshot(parsed.workspace)
      : null;
  } catch {
    return null;
  }
}

export function saveNamedBumpChart(
  name: string,
  workspace: BumpChartWorkspaceSnapshot,
  replaceId?: string,
): SaveNamedBumpChartResult {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return { status: 'error', error: 'Enter a chart name.' };
  }
  const manifest = readManifest();
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
  let previousRecord: string | null = null;
  let wroteRecord = false;
  try {
    previousRecord = localStorage.getItem(slotKey(meta.id));
    localStorage.setItem(
      slotKey(meta.id),
      JSON.stringify({ version: 1, workspace } satisfies SavedBumpChartRecord),
    );
    wroteRecord = true;
    localStorage.setItem(
      SAVED_MANIFEST_KEY,
      JSON.stringify({
        version: 1,
        slots: [meta, ...manifest.slots.filter((slot) => slot.id !== meta.id)],
      } satisfies SavedBumpChartManifest),
    );
    return { status: 'saved', meta };
  } catch (error) {
    try {
      if (wroteRecord) {
        if (previousRecord == null) {
          localStorage.removeItem(slotKey(meta.id));
        } else {
          localStorage.setItem(slotKey(meta.id), previousRecord);
        }
      }
    } catch {
      // Keep the original storage failure as the actionable error.
    }
    return { status: 'error', error: storageError(error) };
  }
}

export function deleteSavedBumpChart(id: string): BumpChartStorageResult {
  const manifest = readManifest();
  try {
    localStorage.setItem(
      SAVED_MANIFEST_KEY,
      JSON.stringify({
        version: 1,
        slots: manifest.slots.filter((slot) => slot.id !== id),
      } satisfies SavedBumpChartManifest),
    );
    localStorage.removeItem(slotKey(id));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: storageError(error) };
  }
}

export function _clearBumpChartStorageForTesting(): void {
  try {
    listSavedBumpCharts().forEach((slot) =>
      localStorage.removeItem(slotKey(slot.id)),
    );
    localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
    localStorage.removeItem(SAVED_MANIFEST_KEY);
  } catch {
    /* ignore */
  }
}
