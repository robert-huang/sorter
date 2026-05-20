import type {
  Item,
  ItemId,
  MergeProgress,
  SaveFile,
  SlotMeta,
  SlotsManifest,
  SortProgress,
} from './types';

// ---------- keys ----------

/** Legacy single-blob key. Read only by the migration path. */
const LEGACY_LOCAL_KEY = 'sorter:v1';

/** Manifest holding the list of slots + which one is active. */
export const MANIFEST_KEY = 'sorter:slots:v1';

/** Per-slot full save file lives here. */
export function slotBlobKey(id: string): string {
  return `sorter:slot:${id}:v1`;
}

export const SETTINGS_KEY = 'sorter:settings:v1';

/** Maximum number of slots kept in browser storage. When a mint would
 *  push us over the cap, `createSlot` evicts the oldest-`updatedAt` slot
 *  to make room and returns the evicted meta(s) so the UI can surface a
 *  toast / pre-flight confirm. The App layer is expected to prompt the
 *  user *before* calling createSlot at the cap so eviction is not a
 *  surprise; the eviction loop here is the unconditional safety net. */
export const SLOT_CAP = 30;

export const AUTOSAVE_DEBOUNCE_MS = 500;
export const AUTOSAVE_MAX_WAIT_MS = 10_000;
export const AUTOSAVE_MAX_COMPARISONS = 20;

// ---------- availability ----------

let cachedAvailability: boolean | null = null;

/**
 * Returns true when localStorage can be reliably used. False under file://
 * (where Chrome treats the origin as opaque and storage is unreliable) or
 * when a probe write/read throws (e.g. quota exhaustion, private mode).
 */
export function isAutosaveAvailable(): boolean {
  if (cachedAvailability !== null) return cachedAvailability;
  try {
    if (typeof window === 'undefined') {
      cachedAvailability = false;
      return false;
    }
    if (window.location.protocol === 'file:') {
      cachedAvailability = false;
      return false;
    }
    const probeKey = '__sorter_probe__';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    cachedAvailability = true;
  } catch {
    cachedAvailability = false;
  }
  return cachedAvailability;
}

/** Test-only escape hatch to re-read availability after toggling jsdom. */
export function _resetAvailabilityCache(): void {
  cachedAvailability = null;
}

// ---------- save file shape ----------

export interface AutosaveBlob {
  items: Record<ItemId, Item>;
  progress: SortProgress;
  undoRing: SortProgress[];
}

function buildSaveFile(blob: AutosaveBlob): SaveFile {
  return {
    version: 3,
    createdAt: new Date().toISOString(),
    items: blob.items,
    progress: blob.progress,
    undoRing: blob.undoRing,
  };
}

/**
 * Upgrade a parsed save's progress slice to the v3 shape.
 *  - v1 (no engine tag, no exile/Place fields) → engine='merge' with
 *    defaults for the exile/insert fields.
 *  - v2 (engine + old `currentPlacement` / `pendingPlacements`) → rename
 *    those fields to `currentManualInsert` / `pendingManualInserts`
 *    and add `currentAutoInsert: null`.
 *  - v3 (current shape) passes through.
 *
 * Lenient: works on arbitrary JSON shapes because the on-disk schema
 * predates strict typing. Returns a fresh object — caller may mutate.
 */
function upgradeProgress(progress: unknown): SortProgress {
  if (!progress || typeof progress !== 'object') {
    // Fallback: a fresh empty merge state. Callers handle invalid data
    // upstream so this branch should be unreachable in practice.
    return defaultMergeProgress();
  }
  // Cast to a permissive shape: the on-disk schema is JSON, and we may
  // encounter any of v1/v2/v3 field-name conventions. The runtime checks
  // below disambiguate which shape we're holding.
  const p = progress as {
    engine?: string;
    queue?: unknown;
    current?: unknown;
    comparisons?: unknown;
    done?: unknown;
    hidden?: unknown;
    totalComparisonsEverNeeded?: unknown;
    unplaced?: unknown;
    // v2 (legacy) field names:
    pendingPlacements?: unknown;
    currentPlacement?: unknown;
    // v3 field names:
    pendingManualInserts?: unknown;
    currentManualInsert?: unknown;
    currentAutoInsert?: unknown;
  };
  // Insertion-engine progress shape is unchanged across v2 → v3.
  if (p.engine === 'insertion') return progress as SortProgress;
  // Detect a fully-v3 merge blob: it has the new field names present.
  if (
    p.engine === 'merge' &&
    Array.isArray(p.unplaced) &&
    Array.isArray(p.pendingManualInserts) &&
    'currentAutoInsert' in p
  ) {
    return progress as SortProgress;
  }
  // v2 merge blob: has engine='merge' + old Place field names.
  // v1 merge blob: missing engine and/or old Place fields.
  // Both upgrade through the same path — rename old → new where
  // present, default-fill where missing.
  const upgraded: MergeProgress = {
    engine: 'merge',
    queue: (Array.isArray(p.queue) ? p.queue : []) as MergeProgress['queue'],
    current: (p.current ?? null) as MergeProgress['current'],
    comparisons: typeof p.comparisons === 'number' ? p.comparisons : 0,
    done: !!p.done,
    hidden: (Array.isArray(p.hidden) ? p.hidden : []) as MergeProgress['hidden'],
    totalComparisonsEverNeeded:
      typeof p.totalComparisonsEverNeeded === 'number'
        ? p.totalComparisonsEverNeeded
        : 0,
    unplaced: (Array.isArray(p.unplaced) ? p.unplaced : []) as MergeProgress['unplaced'],
    pendingManualInserts: (Array.isArray(p.pendingManualInserts)
      ? p.pendingManualInserts
      : Array.isArray(p.pendingPlacements)
        ? p.pendingPlacements
        : []) as MergeProgress['pendingManualInserts'],
    currentManualInsert: (p.currentManualInsert ?? p.currentPlacement ?? null) as MergeProgress['currentManualInsert'],
    // v3 adds currentAutoInsert; v1/v2 didn't have it.
    currentAutoInsert: (p.currentAutoInsert ?? null) as MergeProgress['currentAutoInsert'],
  };
  return upgraded;
}

function defaultMergeProgress(): MergeProgress {
  return {
    engine: 'merge',
    queue: [],
    current: null,
    comparisons: 0,
    done: true,
    hidden: [],
    totalComparisonsEverNeeded: 0,
    unplaced: [],
    pendingManualInserts: [],
    currentManualInsert: null,
    currentAutoInsert: null,
  };
}

// ---------- manifest CRUD ----------

function emptyManifest(): SlotsManifest {
  return { version: 1, activeId: null, slots: [] };
}

/**
 * Read the manifest. Returns an empty manifest on miss or corrupt JSON.
 * Never throws.
 */
export function readManifest(): SlotsManifest {
  if (!isAutosaveAvailable()) return emptyManifest();
  try {
    const raw = window.localStorage.getItem(MANIFEST_KEY);
    if (!raw) return emptyManifest();
    const parsed = JSON.parse(raw) as SlotsManifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.slots)) {
      return emptyManifest();
    }
    return parsed;
  } catch {
    return emptyManifest();
  }
}

export function writeManifest(m: SlotsManifest): void {
  if (!isAutosaveAvailable()) return;
  try {
    window.localStorage.setItem(MANIFEST_KEY, JSON.stringify(m));
  } catch (err) {
    console.warn('manifest write failed', err);
  }
}

// ---------- slot id ----------

function newSlotId(): string {
  // 8 base36 chars is ~41 bits of entropy — collision risk is negligible
  // within a single browser profile that holds at most SLOT_CAP slots.
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

// ---------- active-slot pointer (module-level, mirrors manifest.activeId) ----------

let currentActiveId: string | null = null;

/**
 * Initialize the in-module active-slot pointer from the manifest. Call once
 * at App boot after migration so subsequent `scheduleAutosave` writes go to
 * the right slot.
 */
export function primeActiveSlot(): void {
  currentActiveId = readManifest().activeId;
}

// ---------- migration ----------

/**
 * If a legacy single-blob save (`sorter:v1`) exists and the new manifest
 * does not, convert it into a single active slot. Idempotent: subsequent
 * calls are no-ops once the manifest exists.
 */
export function migrateLegacyIfNeeded(): SlotsManifest {
  if (!isAutosaveAvailable()) return emptyManifest();
  const existingManifest = window.localStorage.getItem(MANIFEST_KEY);
  if (existingManifest) {
    // Already migrated (or freshly initialized via slot APIs).
    return readManifest();
  }
  const legacy = window.localStorage.getItem(LEGACY_LOCAL_KEY);
  if (!legacy) {
    const m = emptyManifest();
    writeManifest(m);
    return m;
  }
  try {
    const file = JSON.parse(legacy) as SaveFile;
    if (
      (file.version !== 1 && file.version !== 2 && file.version !== 3) ||
      !file.items ||
      !file.progress
    ) {
      // Corrupt legacy data — discard it cleanly.
      window.localStorage.removeItem(LEGACY_LOCAL_KEY);
      const m = emptyManifest();
      writeManifest(m);
      return m;
    }
    const id = newSlotId();
    const blob: AutosaveBlob = {
      items: file.items,
      progress: upgradeProgress(file.progress),
      undoRing: (file.undoRing ?? []).map(upgradeProgress),
    };
    const now = new Date().toISOString();
    const meta: SlotMeta = {
      id,
      name: autoNameFromBlob(blob),
      createdAt: file.createdAt ?? now,
      updatedAt: now,
      totalItems: Object.keys(blob.items).length,
      comparisons: blob.progress.comparisons,
      done: blob.progress.done,
    };
    window.localStorage.setItem(slotBlobKey(id), JSON.stringify(file));
    const m: SlotsManifest = { version: 1, activeId: id, slots: [meta] };
    writeManifest(m);
    window.localStorage.removeItem(LEGACY_LOCAL_KEY);
    return m;
  } catch {
    // Garbage in legacy slot; nuke it and start clean.
    try {
      window.localStorage.removeItem(LEGACY_LOCAL_KEY);
    } catch {
      /* ignore */
    }
    const m = emptyManifest();
    writeManifest(m);
    return m;
  }
}

// ---------- slot ops ----------

/**
 * Derive a default name from up to the first three item labels. Caller can
 * override with any string they like (e.g. file basename for imports).
 */
export function autoNameFromBlob(blob: AutosaveBlob): string {
  const labels = Object.values(blob.items).slice(0, 3).map((it) => it.label);
  const today = new Date().toISOString().slice(0, 10);
  if (labels.length === 0) return `Empty sort — ${today}`;
  return `${labels.join(' · ')} — ${today}`;
}

/**
 * Result of a slot mint. `evicted` is empty in the common case (we're
 * below cap) and lists the slot(s) the eviction loop removed when we
 * pushed past `SLOT_CAP`. The UI uses this to flash a "deleted X to
 * make room" toast — so that even if the pre-flight confirm was
 * suppressed (or skipped because we were exactly at cap), the user
 * still gets explicit feedback about the deletion.
 */
export interface CreateSlotResult {
  meta: SlotMeta;
  evicted: SlotMeta[];
}

/**
 * Persist a brand-new slot, prepend its meta, evict the oldest if we'd
 * exceed `SLOT_CAP`, and activate it. Returns the new meta plus any
 * evicted metas.
 *
 * Note: the App layer should pre-flight the cap with a confirm modal
 * (see `SlotCapConfirmModal`) so the user knows what's about to be
 * deleted *before* we mint. The eviction loop here remains the
 * unconditional safety net — e.g. if a future code path skips the
 * pre-flight, we still won't grow storage unbounded.
 */
export function createSlot(blob: AutosaveBlob, name: string): CreateSlotResult {
  // Flush any pending writes to the OUTGOING active slot before switching.
  flushAutosave();
  const id = newSlotId();
  const now = new Date().toISOString();
  const meta: SlotMeta = {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    totalItems: Object.keys(blob.items).length,
    comparisons: blob.progress.comparisons,
    done: blob.progress.done,
  };
  if (isAutosaveAvailable()) {
    try {
      window.localStorage.setItem(
        slotBlobKey(id),
        JSON.stringify(buildSaveFile(blob)),
      );
    } catch (err) {
      console.warn('createSlot blob write failed', err);
    }
  }
  const m = readManifest();
  m.slots.unshift(meta);
  // Evict oldest-updated entries past the cap. The just-created slot has
  // `now` as its updatedAt so it's safe even if everything is recent.
  const evicted: SlotMeta[] = [];
  while (m.slots.length > SLOT_CAP) {
    const oldest = m.slots
      .slice()
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
    if (!oldest || oldest.id === id) break; // never evict the slot we just made
    deleteSlotBlob(oldest.id);
    m.slots = m.slots.filter((s) => s.id !== oldest.id);
    evicted.push(oldest);
  }
  m.activeId = id;
  writeManifest(m);
  currentActiveId = id;
  // Reset the in-flight autosave bookkeeping so the next scheduleAutosave
  // call is treated as the first write for the new slot.
  resetAutosaveBookkeeping(blob.progress.comparisons);
  return { meta, evicted };
}

/**
 * Inspect the slot that *would* be evicted if a new slot were minted right
 * now. Returns null when we're below the cap. Used by the pre-flight
 * cap-confirm modal so the user sees the name + timestamp of what they're
 * about to lose before they click Continue. Always reads a fresh manifest
 * since slot writes can happen between renders.
 */
export function peekEvictionTarget(): SlotMeta | null {
  const m = readManifest();
  if (m.slots.length < SLOT_CAP) return null;
  const sorted = m.slots.slice().sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  return sorted[0] ?? null;
}

/**
 * Read the persisted blob for a given slot. Returns null on miss / corrupt.
 */
export function readSlotBlob(id: string): AutosaveBlob | null {
  if (!isAutosaveAvailable()) return null;
  try {
    const raw = window.localStorage.getItem(slotBlobKey(id));
    if (!raw) return null;
    const file = JSON.parse(raw) as SaveFile;
    if (file.version !== 1 && file.version !== 2 && file.version !== 3) return null;
    return {
      items: file.items,
      progress: upgradeProgress(file.progress),
      undoRing: (file.undoRing ?? []).map(upgradeProgress),
    };
  } catch {
    return null;
  }
}

/**
 * Switch the active slot. Flushes any pending autosave for the OUTGOING
 * slot first so we don't lose data. Pass `null` to deactivate (used when
 * the active slot is deleted; the next scheduleAutosave will no-op).
 *
 * Returns the updated manifest.
 */
export function setActiveSlot(id: string | null): SlotsManifest {
  flushAutosave();
  const m = readManifest();
  if (id !== null && !m.slots.some((s) => s.id === id)) {
    // Unknown id — defensive no-op, but caller should not do this.
    return m;
  }
  m.activeId = id;
  writeManifest(m);
  currentActiveId = id;
  const newSlot = id === null ? null : m.slots.find((s) => s.id === id);
  resetAutosaveBookkeeping(newSlot?.comparisons ?? 0);
  return m;
}

function deleteSlotBlob(id: string): void {
  if (!isAutosaveAvailable()) return;
  try {
    window.localStorage.removeItem(slotBlobKey(id));
  } catch {
    /* ignore */
  }
}

/**
 * Delete a slot's blob + manifest entry. If the deleted slot was active,
 * clear `activeId` so subsequent autosaves no-op until a new slot is
 * created or selected. Returns the updated manifest.
 */
export function deleteSlot(id: string): SlotsManifest {
  // If we're deleting the active slot, drop any pending autosave for it.
  if (currentActiveId === id) {
    cancelPendingAutosave();
  }
  deleteSlotBlob(id);
  const m = readManifest();
  m.slots = m.slots.filter((s) => s.id !== id);
  if (m.activeId === id) {
    m.activeId = null;
    currentActiveId = null;
  }
  writeManifest(m);
  return m;
}

/**
 * Rename a slot. No-op if id is unknown.
 */
export function renameSlot(id: string, name: string): SlotsManifest {
  const m = readManifest();
  const trimmed = name.trim() || `Untitled — ${new Date().toISOString().slice(0, 10)}`;
  let changed = false;
  m.slots = m.slots.map((s) => {
    if (s.id !== id) return s;
    changed = true;
    return { ...s, name: trimmed, updatedAt: new Date().toISOString() };
  });
  if (changed) writeManifest(m);
  return m;
}

/**
 * Patch arbitrary fields of a slot's meta. Used by the autosave path to
 * keep `updatedAt` / `comparisons` / `done` / `totalItems` fresh.
 */
export function updateSlotMeta(
  id: string,
  patch: Partial<Omit<SlotMeta, 'id' | 'createdAt'>>,
): SlotsManifest {
  const m = readManifest();
  m.slots = m.slots.map((s) => (s.id === id ? { ...s, ...patch } : s));
  writeManifest(m);
  return m;
}

// ---------- autosave (debounced with max-wait) ----------

let pendingBlob: AutosaveBlob | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastFlushTime = 0;
let comparisonsAtLastFlush = 0;

/**
 * Reset the debounced-write bookkeeping. After creating or switching to a
 * slot, the slot's persisted state IS already current (createSlot writes
 * synchronously; setActiveSlot is followed by a load), so we treat that
 * persisted state as "the last flush". Otherwise the very first
 * scheduleAutosave would always force-write — `now - 0` always exceeds the
 * 10 s max-wait, and `comparisons - 0` for a resumed slot can trivially
 * exceed the 20-comparison threshold.
 */
function resetAutosaveBookkeeping(initialComparisons = 0): void {
  pendingBlob = null;
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  lastFlushTime = Date.now();
  comparisonsAtLastFlush = initialComparisons;
}

function cancelPendingAutosave(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingBlob = null;
}

function performWrite(blob: AutosaveBlob): void {
  if (!isAutosaveAvailable()) return;
  if (currentActiveId === null) return;
  try {
    const file = buildSaveFile(blob);
    window.localStorage.setItem(slotBlobKey(currentActiveId), JSON.stringify(file));
    updateSlotMeta(currentActiveId, {
      updatedAt: file.createdAt,
      totalItems: Object.keys(blob.items).length,
      comparisons: blob.progress.comparisons,
      done: blob.progress.done,
    });
    lastFlushTime = Date.now();
    comparisonsAtLastFlush = blob.progress.comparisons;
  } catch (err) {
    console.warn('autosave write failed', err);
  }
}

function scheduleFlush(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (pendingBlob) performWrite(pendingBlob);
  }, AUTOSAVE_DEBOUNCE_MS);
}

/**
 * Schedule an autosave write for the currently-active slot. Coalesces rapid
 * calls into a single write 500ms after the last one. Forces an immediate
 * write if either:
 *  - >= 10s have passed since the last actual write, OR
 *  - >= 20 comparisons have happened since the last actual write.
 *
 * No-op if there is no active slot or autosave is unavailable.
 */
export function scheduleAutosave(blob: AutosaveBlob): void {
  if (!isAutosaveAvailable()) return;
  if (currentActiveId === null) return;
  pendingBlob = blob;
  const now = Date.now();
  const timeSinceFlush = now - lastFlushTime;
  const cmpsSinceFlush = blob.progress.comparisons - comparisonsAtLastFlush;
  if (
    timeSinceFlush >= AUTOSAVE_MAX_WAIT_MS ||
    cmpsSinceFlush >= AUTOSAVE_MAX_COMPARISONS
  ) {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    performWrite(blob);
    return;
  }
  scheduleFlush();
}

/**
 * Synchronously flush any pending autosave to the active slot's blob key.
 * Safe to call when nothing is pending or when there is no active slot.
 */
export function flushAutosave(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (pendingBlob) performWrite(pendingBlob);
}

/**
 * Read the active slot's blob, if any. Returns null when there is no
 * active slot or its blob is missing.
 */
export function readActiveSlot(): AutosaveBlob | null {
  const m = readManifest();
  if (!m.activeId) return null;
  return readSlotBlob(m.activeId);
}

// ---------- explicit JSON download / upload ----------

function timestampForFilename(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

export function downloadSave(blob: AutosaveBlob): void {
  const file = buildSaveFile(blob);
  const json = JSON.stringify(file, null, 2);
  const blobObj = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blobObj);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sorter-${timestampForFilename()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function loadSaveFromFile(file: File): Promise<AutosaveBlob> {
  const text = await file.text();
  const parsed = JSON.parse(text) as SaveFile;
  if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) {
    throw new Error(`Unsupported save file version: ${parsed.version}`);
  }
  if (!parsed.items || !parsed.progress) {
    throw new Error('Save file is missing required fields.');
  }
  return {
    items: parsed.items,
    progress: upgradeProgress(parsed.progress),
    undoRing: (parsed.undoRing ?? []).map(upgradeProgress),
  };
}

// ---------- small settings ----------

export type ThemeName = 'light' | 'dark';

export interface Settings {
  /**
   * "Don't ask again" for the SlotDeleteConfirmModal (per-row trashcan +
   * toolbar "Delete this slot"). Kept under its legacy name for
   * backward-compat — older builds wrote this key when the modal was
   * still called the "reset" confirm.
   */
  suppressResetConfirm?: boolean;
  /**
   * "Don't ask again" for the RESULT-tab "Start over" confirm. Distinct
   * from suppressResetConfirm because the two actions are independent
   * (start-over keeps items + the slot; delete-slot wipes both).
   */
  suppressStartOverConfirm?: boolean;
  theme?: ThemeName;
  /** When true, header shows "· ~M left" after the "Comparison #N" stat. */
  showEstimatedRemaining?: boolean;
  /**
   * When true (default), the merge engine may swap a popped queue pair
   * for binary insertion when the pair is skewed enough that insertion
   * beats the full merge (see `shouldAutoInsert` in queueMergeSort.ts).
   *
   * Stored as `undefined` until the user explicitly toggles, so existing
   * saves keep the new behavior on. Set to `false` to force classic
   * merge on every pair.
   */
  autoInsertEnabled?: boolean;
}

export function readSettings(): Settings {
  if (!isAutosaveAvailable()) return {};
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as Settings) : {};
  } catch {
    return {};
  }
}

export function writeSettings(s: Settings): void {
  if (!isAutosaveAvailable()) return;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Merge-update settings; returns the new full Settings object actually persisted. */
export function updateSettings(patch: Partial<Settings>): Settings {
  const merged = { ...readSettings(), ...patch };
  writeSettings(merged);
  return merged;
}
