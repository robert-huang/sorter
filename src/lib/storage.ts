import type {
  ConfirmationProgress,
  Item,
  ItemId,
  MergeProgress,
  SaveFile,
  SlotMeta,
  SlotsManifest,
  SortProgress,
} from './types';
import { normalizeConfirmationProgress } from './confirmationSort';
import { activeSortItemCount } from './sortPopulation';
import {
  ACTIVE_SORTER_SLOT_KEY,
  SORTER_SLOT_STORE,
  STATE_METADATA_STORE,
  commitStateChanges,
  getStateStorageStatus,
  initializeStateStorage,
  readAllStateEntries,
  readStateRecord,
  stateStorageRecordKeys,
  type StateStorageChange,
} from './stateStorageDb';
import {
  isLegacySorterManifest,
  isLegacySorterSaveFile,
} from './stateStorageValidation';
import { sweepExpiredDisposableCache } from './disposableCacheDb';
import { clearDisposableCachesUnderPressure } from './disposableCacheRegistry';
import './storageCleanupOwners';

// ---------- keys ----------

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
export const SLOT_CAP = 50;

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

/** Active sort population — used for slot-meta `totalItems`. */
function visibleItemCount(blob: Pick<AutosaveBlob, 'progress'>): number {
  return activeSortItemCount(blob.progress);
}

function buildSaveFile(blob: AutosaveBlob): SaveFile {
  return {
    version: 4,
    createdAt: new Date().toISOString(),
    items: blob.items,
    progress: blob.progress,
    undoRing: blob.undoRing,
  };
}

/**
 * Upgrade a parsed save's progress slice to the current merge shape.
 *
 * Strategy: shape-driven, not version-driven. Any merge blob missing a
 * field gets it default-filled. Insertion blobs pass through verbatim
 * (the insertion shape has been stable since v3).
 *
 * Legacy back-compat is deliberately minimal — older blobs (v1 with no
 * engine tag, v2 with the original "Place" vocabulary, v3 with the
 * `unplaced` field name) all get default-filled rather than translated.
 * Per-field consequences:
 *  - v1: no exile/insert fields at all → all default to empty/null. No
 *    data loss because v1 didn't have the concepts.
 *  - v2: legacy `pendingPlacements` / `currentPlacement` are dropped on
 *    load (mid-Place sessions silently lose their in-flight frame and
 *    queued items).
 *  - v3: legacy `unplaced` is dropped on load (any items sitting in the
 *    "to be inserted" bucket disappear).
 *
 * Acceptable losses for a personal-scale app — see the v4 schema notes
 * in types.ts. Lenient: works on arbitrary JSON shapes because the
 * on-disk schema predates strict typing. Returns a fresh object —
 * caller may mutate.
 */
function upgradeProgress(progress: unknown): SortProgress {
  if (!progress || typeof progress !== 'object') {
    // Fallback: a fresh empty merge state. Callers handle invalid data
    // upstream so this branch should be unreachable in practice.
    return defaultMergeProgress();
  }
  // Cast to a permissive shape: the on-disk schema is JSON.
  const p = progress as {
    engine?: string;
    queue?: unknown;
    current?: unknown;
    comparisons?: unknown;
    done?: unknown;
    hidden?: unknown;
    totalComparisonsEverNeeded?: unknown;
    toBeInserted?: unknown;
    pendingManualInserts?: unknown;
    currentManualInsert?: unknown;
    currentAutoInsert?: unknown;
  };
  if (p.engine === 'insertion') return progress as SortProgress;
  if (p.engine === 'confirmation') {
    return normalizeConfirmationProgress(progress as ConfirmationProgress);
  }
  // Current merge blob: engine + v4 field names.
  if (
    p.engine === 'merge' &&
    Array.isArray(p.toBeInserted) &&
    Array.isArray(p.pendingManualInserts) &&
    'currentAutoInsert' in p
  ) {
    return progress as SortProgress;
  }
  // Legacy fall-through: v1 (no engine), v2 (Place vocabulary), or
  // pre-v4 v3 (with `unplaced` instead of `toBeInserted`). All three
  // default-fill missing fields rather than translating; see the
  // function comment above for the acceptable-loss rationale.
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
    toBeInserted: (Array.isArray(p.toBeInserted)
      ? p.toBeInserted
      : []) as MergeProgress['toBeInserted'],
    pendingManualInserts: (Array.isArray(p.pendingManualInserts)
      ? p.pendingManualInserts
      : []) as MergeProgress['pendingManualInserts'],
    currentManualInsert: (p.currentManualInsert ?? null) as MergeProgress['currentManualInsert'],
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
    toBeInserted: [],
    pendingManualInserts: [],
    currentManualInsert: null,
    currentAutoInsert: null,
  };
}

// ---------- manifest CRUD ----------

function emptyManifest(): SlotsManifest {
  return { version: 1, activeId: null, slots: [] };
}

let manifestCache: SlotsManifest = emptyManifest();
const slotBlobCache = new Map<string, AutosaveBlob>();
let sorterStorageInitialized = false;
let stateWriteQueue: Promise<void> = Promise.resolve();

function queueStateWrite(
  changes: Parameters<typeof commitStateChanges>[0],
  id?: string,
): Promise<void> {
  stateWriteQueue = stateWriteQueue
    .then(() => commitStateChanges(changes, { scope: 'sorter', id }))
    .catch((error: unknown) => {
      console.warn('sorter state write failed', error);
      notifyError({
        reason:
          error instanceof DOMException && error.name === 'QuotaExceededError'
            ? 'quota'
            : 'other',
        attemptedAt: new Date().toISOString(),
        slotCount: manifestCache.slots.length,
      });
    });
  return stateWriteQueue;
}

function parseSlotFile(value: unknown): AutosaveBlob | null {
  if (!isLegacySorterSaveFile(value)) return null;
  const file = value as Partial<SaveFile>;
  return {
    items: file.items!,
    progress: upgradeProgress(file.progress!),
    undoRing: (file.undoRing ?? []).map(upgradeProgress),
  };
}

function sorterManifestRecord(manifest: SlotsManifest): Omit<SlotsManifest, 'activeId'> {
  return { version: 1, slots: manifest.slots };
}

export async function initializeSorterStorage(): Promise<void> {
  if (sorterStorageInitialized) return;
  await initializeStateStorage();

  const storedManifest = await readStateRecord<Partial<SlotsManifest>>(
    STATE_METADATA_STORE,
    stateStorageRecordKeys.sorterManifest,
  );
  const manifestWasCorrupt =
    storedManifest !== undefined && !isLegacySorterManifest(storedManifest);
  const activeId = localStorage.getItem(ACTIVE_SORTER_SLOT_KEY);
  manifestCache =
    isLegacySorterManifest(storedManifest)
      ? {
          version: 1,
          activeId,
          slots: storedManifest.slots,
        }
      : { ...emptyManifest(), activeId };

  slotBlobCache.clear();
  for (const [key, value] of await readAllStateEntries<unknown>(
    SORTER_SLOT_STORE,
  )) {
    const blob = parseSlotFile(value);
    if (blob) slotBlobCache.set(String(key), blob);
  }

  const legacySingle = await readStateRecord<unknown>(
    STATE_METADATA_STORE,
    stateStorageRecordKeys.legacySorterSingle,
  );
  const legacyBlob = parseSlotFile(legacySingle);
  if (legacyBlob && manifestCache.slots.length === 0) {
    const id = newSlotId();
    const now = new Date().toISOString();
    const file = legacySingle as Partial<SaveFile>;
    const meta: SlotMeta = {
      id,
      name: autoNameFromBlob(legacyBlob),
      createdAt: file.createdAt ?? now,
      updatedAt: now,
      totalItems: visibleItemCount(legacyBlob),
      comparisons: legacyBlob.progress.comparisons,
      done: legacyBlob.progress.done,
    };
    manifestCache = { version: 1, activeId: id, slots: [meta] };
    slotBlobCache.set(id, legacyBlob);
    localStorage.setItem(ACTIVE_SORTER_SLOT_KEY, id);
    await commitStateChanges(
      [
        {
          type: 'put',
          store: SORTER_SLOT_STORE,
          key: id,
          value: buildSaveFile(legacyBlob),
        },
        {
          type: 'put',
          store: STATE_METADATA_STORE,
          key: stateStorageRecordKeys.sorterManifest,
          value: sorterManifestRecord(manifestCache),
        },
        {
          type: 'delete',
          store: STATE_METADATA_STORE,
          key: stateStorageRecordKeys.legacySorterSingle,
        },
      ],
      { scope: 'sorter', id },
    );
  }

  const knownIds = new Set(slotBlobCache.keys());
  const validSlots = manifestCache.slots.filter((slot) => knownIds.has(slot.id));
  const originalSlotCount = validSlots.length;
  for (const id of knownIds) {
    if (!validSlots.some((slot) => slot.id === id)) {
      validSlots.push(synthesizeMetaFromBlob(id, slotBlobCache.get(id)!));
    }
  }
  if (validSlots.length !== manifestCache.slots.length) {
    manifestCache = { ...manifestCache, slots: validSlots };
    await commitStateChanges([
      {
        type: 'put',
        store: STATE_METADATA_STORE,
        key: stateStorageRecordKeys.sorterManifest,
        value: sorterManifestRecord(manifestCache),
      },
    ]);
  }
  if (manifestWasCorrupt) {
    lastRepairCount = validSlots.length;
  } else if (validSlots.length > originalSlotCount) {
    lastRepairCount = validSlots.length - originalSlotCount;
  }
  if (
    manifestCache.activeId &&
    !manifestCache.slots.some((slot) => slot.id === manifestCache.activeId)
  ) {
    manifestCache.activeId = null;
    localStorage.removeItem(ACTIVE_SORTER_SLOT_KEY);
  }
  currentActiveId = manifestCache.activeId;
  sorterStorageInitialized = true;
}

export async function refreshSorterStorageFromIndexedDb(): Promise<SlotsManifest> {
  sorterStorageInitialized = false;
  await initializeSorterStorage();
  return readManifest();
}

export async function flushStateStorageWrites(): Promise<void> {
  await stateWriteQueue;
}

export function isStatePersistenceAvailable(): boolean {
  return getStateStorageStatus().persistent;
}

/** Read a defensive copy of the manifest hydrated from IndexedDB. */
export function readManifest(): SlotsManifest {
  return {
    ...manifestCache,
    slots: [...manifestCache.slots],
  };
}

// ---------- manifest repair (corruption recovery) ----------

/**
 * One-shot notice for the App layer: how many slots were rebuilt by the
 * last `repairManifestIfCorrupt()` call, or null if no repair happened
 * since the last consume. Read + cleared via `consumeManifestRepairNotice`.
 */
let lastRepairCount: number | null = null;

/**
 * Synthesize a SlotMeta from a blob's contents. Used only by the repair
 * path — slots minted through the normal `createSlot` flow carry their
 * own (more accurate) timestamps. Sets createdAt = updatedAt = now since
 * the original timestamps were lost with the manifest.
 */
function synthesizeMetaFromBlob(id: string, blob: AutosaveBlob): SlotMeta {
  const now = new Date().toISOString();
  return {
    id,
    name: autoNameFromBlob(blob),
    createdAt: now,
    updatedAt: now,
    totalItems: visibleItemCount(blob),
    comparisons: blob.progress.comparisons,
    done: blob.progress.done,
  };
}

/**
 * Compatibility hook for callers that previously triggered repair after
 * boot. IndexedDB repair now runs as part of initializeSorterStorage().
 */
export function repairManifestIfCorrupt(): void {
  // IndexedDB repair runs during initializeSorterStorage().
}

/**
 * Read and clear the one-shot repair notice. Returns the number of
 * rebuilt slots from the most recent repair, or null if no repair has
 * happened since the last consume. App.tsx calls this once at boot to
 * decide whether to flash the recovery banner.
 */
export function consumeManifestRepairNotice(): number | null {
  const out = lastRepairCount;
  lastRepairCount = null;
  return out;
}

export function writeManifest(m: SlotsManifest): void {
  manifestCache = {
    ...m,
    slots: [...m.slots],
  };
  if (m.activeId) {
    localStorage.setItem(ACTIVE_SORTER_SLOT_KEY, m.activeId);
  } else {
    localStorage.removeItem(ACTIVE_SORTER_SLOT_KEY);
  }
  void queueStateWrite([
    {
      type: 'put',
      store: STATE_METADATA_STORE,
      key: stateStorageRecordKeys.sorterManifest,
      value: sorterManifestRecord(m),
    },
  ]);
}

// ---------- slot id ----------

function generateUuidV4(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // `getRandomValues` is available in older browsers where `randomUUID`
  // is missing, including non-HTTPS/file origins supported by this app.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

function newSlotId(reservedIds: ReadonlySet<string> = new Set()): string {
  let id: string;
  do {
    id = generateUuidV4();
  } while (reservedIds.has(id));
  return id;
}

// ---------- active-slot pointer (module-level, mirrors manifest.activeId) ----------

let currentActiveId: string | null = null;

/**
 * Initialize the in-module active-slot pointer from the manifest. Call once
 * at App boot after migration so subsequent `scheduleAutosave` writes go to
 * the right slot.
 */
export function primeActiveSlot(): void {
  currentActiveId = manifestCache.activeId;
}

// ---------- migration ----------

/**
 * Compatibility accessor for callers that previously triggered migration.
 * Legacy migration now runs before the sorter cache is hydrated.
 */
export function migrateLegacyIfNeeded(): SlotsManifest {
  return readManifest();
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

export interface CreateSlotOptions {
  /**
   * Whether the new slot becomes the active autosave target. Background
   * imports set this false so the currently loaded sort stays untouched.
   */
  activate?: boolean;
}

/**
 * Persist a brand-new slot, prepend its meta, evict the oldest if we'd
 * exceed `SLOT_CAP`, and activate it unless `options.activate` is false.
 *
 * Returns `{ meta, evicted }` on success; `null` if the durable blob
 * write fails (typically quota exhaustion). On failure we DO NOT
 * register the meta in the manifest — that prevents the "ghost slot"
 * bug where a meta points at a missing blob and the LIST tab shows an
 * un-openable row. Any slots evicted before the failed write are
 * persisted in the manifest because their blobs are gone regardless.
 *
 * In-memory-only environments (file://, private mode where
 * isAutosaveAvailable() is false) skip persistence entirely and return
 * a successful result so the app stays usable within the session.
 *
 * Note: the App layer should pre-flight the cap with a confirm modal
 * (see `SlotCapConfirmModal`) so the user knows what's about to be
 * deleted *before* we mint. The eviction loop here remains the
 * unconditional safety net — e.g. if a future code path skips the
 * pre-flight, we still won't grow storage unbounded.
 */
export function createSlot(
  blob: AutosaveBlob,
  name: string,
  options: CreateSlotOptions = {},
): CreateSlotResult | null {
  const activate = options.activate ?? true;
  // Flush pending writes before the manifest/blob transaction, even when
  // this is a background import that preserves the active pointer.
  flushAutosave();
  const id = newSlotId(new Set(readManifest().slots.map((slot) => slot.id)));
  const now = new Date().toISOString();
  const meta: SlotMeta = {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    totalItems: visibleItemCount(blob),
    comparisons: blob.progress.comparisons,
    done: blob.progress.done,
  };

  // Pre-evict to cap BEFORE the blob write so we free quota first; the
  // just-minted blob has a better chance of fitting. Eviction skips
  // pinned slots (see SlotMeta.pinned) — if every existing slot is
  // pinned we can still proceed (the blob write will fail loudly via
  // the quota path below rather than silently dropping a pinned slot).
  const m = readManifest();
  const evicted: SlotMeta[] = [];
  const changes: StateStorageChange[] = [];
  // We want at most SLOT_CAP entries AFTER we unshift the new meta, so
  // pre-evict down to (SLOT_CAP - 1).
  while (m.slots.length >= SLOT_CAP) {
    const oldest = m.slots
      .filter((s) => !s.pinned && (activate || s.id !== m.activeId))
      .slice()
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
    if (!oldest) break;
    slotBlobCache.delete(oldest.id);
    changes.push({
      type: 'delete',
      store: SORTER_SLOT_STORE,
      key: oldest.id,
    });
    m.slots = m.slots.filter((s) => s.id !== oldest.id);
    evicted.push(oldest);
  }

  slotBlobCache.set(id, blob);
  m.slots.unshift(meta);
  if (activate) {
    m.activeId = id;
  }
  manifestCache = m;
  if (activate) {
    localStorage.setItem(ACTIVE_SORTER_SLOT_KEY, id);
  }
  changes.push(
    {
      type: 'put',
      store: SORTER_SLOT_STORE,
      key: id,
      value: buildSaveFile(blob),
    },
    {
      type: 'put',
      store: STATE_METADATA_STORE,
      key: stateStorageRecordKeys.sorterManifest,
      value: sorterManifestRecord(m),
    },
  );
  void queueStateWrite(changes, id);
  if (activate) {
    currentActiveId = id;
    // Reset the in-flight autosave bookkeeping so the next scheduleAutosave
    // call is treated as the first write for the new slot.
    resetAutosaveBookkeeping(blob.progress.comparisons);
  }
  return { meta, evicted };
}

/**
 * Inspect the slot that *would* be evicted if a new slot were minted right
 * now. Returns null when we're below the cap OR when every existing slot
 * is pinned (in which case eviction can't free anything and the next
 * mint will likely fail at the blob-write step — caller should warn).
 * Used by the pre-flight cap-confirm modal so the user sees the name +
 * timestamp of what they're about to lose before they click Continue.
 * Always reads a fresh manifest since slot writes can happen between
 * renders.
 */
export function peekEvictionTarget(
  options: CreateSlotOptions = {},
): SlotMeta | null {
  const m = readManifest();
  if (m.slots.length < SLOT_CAP) return null;
  const activate = options.activate ?? true;
  const evictable = m.slots.filter(
    (s) => !s.pinned && (activate || s.id !== m.activeId),
  );
  if (evictable.length === 0) return null;
  const sorted = evictable.slice().sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  return sorted[0] ?? null;
}

/**
 * Returns true when the slot list is at cap AND every slot is pinned —
 * i.e. the next `createSlot` call will not be able to free room and the
 * caller should warn the user rather than letting the blob write fail
 * silently. Distinct from `peekEvictionTarget()` returning null (which
 * is also the below-cap case).
 */
export function isAtCapAndAllPinned(): boolean {
  const m = readManifest();
  if (m.slots.length < SLOT_CAP) return false;
  return m.slots.every((s) => s.pinned);
}

/**
 * Toggle a slot's pinned flag. Pinning excludes the slot from eviction
 * when the cap is hit. No-op for unknown id. Bumps `updatedAt` so the
 * sort order in the LIST tab moves the just-pinned slot to the top of
 * its updated-recent group (matches the user's mental model of "I just
 * touched this slot").
 */
export function pinSlot(id: string, pinned: boolean): SlotsManifest {
  const m = readManifest();
  let changed = false;
  m.slots = m.slots.map((s) => {
    if (s.id !== id) return s;
    if ((s.pinned ?? false) === pinned) return s;
    changed = true;
    return { ...s, pinned, updatedAt: new Date().toISOString() };
  });
  if (changed) writeManifest(m);
  return m;
}

/**
 * Read the persisted blob for a given slot. Returns null on miss / corrupt.
 */
export function readSlotBlob(id: string): AutosaveBlob | null {
  return slotBlobCache.get(id) ?? null;
}

/** Parse a raw SaveFile JSON string (e.g. from a `storage` event's `newValue`). */
export function parseSlotBlobRaw(raw: string | null): AutosaveBlob | null {
  if (!raw) return null;
  try {
    const file = JSON.parse(raw) as SaveFile;
    if (
      file.version !== 1 &&
      file.version !== 2 &&
      file.version !== 3 &&
      file.version !== 4
    ) {
      return null;
    }
    return {
      items: file.items,
      progress: upgradeProgress(file.progress),
      undoRing: (file.undoRing ?? []).map(upgradeProgress),
    };
  } catch {
    return null;
  }
}

/** Compare autosave payloads ignoring SaveFile wrapper metadata (`createdAt`). */
export function autosaveBlobsEqual(a: AutosaveBlob, b: AutosaveBlob): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * True when another tab rewrote this slot blob but the payload matches what
 * we already have in memory (zombie tab echo, canonical re-write, etc.).
 */
export function isHarmlessCrossTabSlotBlobWrite(
  memoryBlob: AutosaveBlob,
  diskRaw: string | null,
): boolean {
  const diskBlob = parseSlotBlobRaw(diskRaw);
  return diskBlob !== null && autosaveBlobsEqual(memoryBlob, diskBlob);
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
  slotBlobCache.delete(id);
  void queueStateWrite(
    [{ type: 'delete', store: SORTER_SLOT_STORE, key: id }],
    id,
  );
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
  const m = readManifest();
  m.slots = m.slots.filter((s) => s.id !== id);
  if (m.activeId === id) {
    m.activeId = null;
    currentActiveId = null;
  }
  manifestCache = m;
  if (m.activeId) {
    localStorage.setItem(ACTIVE_SORTER_SLOT_KEY, m.activeId);
  } else {
    localStorage.removeItem(ACTIVE_SORTER_SLOT_KEY);
  }
  slotBlobCache.delete(id);
  void queueStateWrite(
    [
      { type: 'delete', store: SORTER_SLOT_STORE, key: id },
      {
        type: 'put',
        store: STATE_METADATA_STORE,
        key: stateStorageRecordKeys.sorterManifest,
        value: sorterManifestRecord(m),
      },
    ],
    id,
  );
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

// ---------- cloud-meta helpers (tier 0b) ----------

/**
 * Per-slot cloud-sync metadata setters. Thin wrappers over
 * `updateSlotMeta` so callers don't have to remember the field names
 * and so the storage layer stays the single source of truth for the
 * meta shape. All are no-ops for unknown slot ids.
 *
 * These never trigger an autosave write — they patch the manifest only.
 * The companion cloud blob (the upload/download) is the cloud layer's
 * responsibility (`src/lib/cloud.ts`).
 */
export function setCloudOptIn(id: string, optIn: boolean): SlotsManifest {
  return updateSlotMeta(id, { cloudOptIn: optIn });
}

export function setCloudId(id: string, cloudId: string | undefined): SlotsManifest {
  return updateSlotMeta(id, { cloudId });
}

/**
 * First local slot bound to a Drive file id (`SlotMeta.cloudId`). If
 * duplicates exist (legacy bug), returns the first match in manifest order.
 */
export function findSlotByCloudId(cloudId: string): SlotMeta | undefined {
  return readManifest().slots.find((s) => s.cloudId === cloudId);
}

/** cloudId → local slot id for every slot with a cloud binding. */
export function buildLocalCloudSlotIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const slot of readManifest().slots) {
    if (slot.cloudId && !index.has(slot.cloudId)) {
      index.set(slot.cloudId, slot.id);
    }
  }
  return index;
}

/**
 * Stamp the post-Push metadata in one call so the manifest write is
 * atomic. Used by the push flow: on a successful upload we want to
 * record the new etag, the cloud-side updatedAt, and the local push
 * time together — partial state would confuse the 3-state indicator.
 */
export function setCloudPushed(
  id: string,
  patch: { cloudId: string; cloudEtag: string; cloudPushedAt: string; cloudUpdatedAt: string },
): SlotsManifest {
  return updateSlotMeta(id, patch);
}

/**
 * Stamp the authoritative cloud name and post-Pull metadata in one call. Distinct from
 * setCloudPushed because Pull updates `cloudUpdatedAt` from the
 * server-reported timestamp; we ALSO stamp `cloudPushedAt` to "now"
 * because the slot is now in sync with the cloud — the just-pulled
 * bytes ARE the cloud bytes — and the sync indicator derives state
 * from `updatedAt > cloudPushedAt`. Without this stamp a fresh pull
 * would render as "pending" until the user manually Pushed.
 *
 * `cloudPushedAt` is therefore better thought of as "last local↔cloud
 * sync timestamp" — it advances on Push (we just uploaded) AND Pull
 * (we just downloaded an authoritative copy). See `SlotMeta.cloudPushedAt`
 * docs in `types.ts`.
 */
export function setCloudPulled(
  id: string,
  patch: {
    cloudId: string;
    cloudEtag: string;
    cloudUpdatedAt: string;
    displayName: string;
  },
): SlotsManifest {
  const { displayName, ...cloudPatch } = patch;
  return updateSlotMeta(id, {
    ...cloudPatch,
    name: displayName,
    cloudPushedAt: new Date().toISOString(),
  });
}

/**
 * Replace a slot's persisted blob with an inbound payload — used by
 * the per-slot cloud Pull path so the same local slot id keeps its
 * cloudId binding (versus `adoptNewSession` from the cloud library
 * modal, which mints a fresh slot). Also stamps the meta fields the
 * autosave path would have stamped (`updatedAt`, `totalItems`,
 * `comparisons`, `done`) so the slot list shows correct counts
 * immediately.
 *
 * Cancels any pending autosave for the affected slot before writing
 * to avoid the autosave's old blob clobbering the pulled one when its
 * timer fires.
 *
 * Returns false on quota failure (caller surfaces a toast); true on
 * success. Does NOT fire `notifyAfterWrite` — the post-write seam is
 * specifically the autosave path's exit point, and a Pull is not an
 * autosave (the cloud-sync subscriber would otherwise immediately
 * re-Push what we just Pulled).
 */
export function replaceSlotBlob(id: string, blob: AutosaveBlob): boolean {
  if (currentActiveId === id) {
    cancelPendingAutosave();
  }
  if (!tryWriteSlotBlobAfterCachePurge(id, blob)) return false;
  const manifest = readManifest();
  manifest.slots = manifest.slots.map((slot) =>
    slot.id === id
      ? {
          ...slot,
          updatedAt: new Date().toISOString(),
          totalItems: visibleItemCount(blob),
          comparisons: blob.progress.comparisons,
          done: blob.progress.done,
        }
      : slot,
  );
  manifestCache = manifest;
  void queueStateWrite(
    [
      {
        type: 'put',
        store: SORTER_SLOT_STORE,
        key: id,
        value: buildSaveFile(blob),
      },
      {
        type: 'put',
        store: STATE_METADATA_STORE,
        key: stateStorageRecordKeys.sorterManifest,
        value: sorterManifestRecord(manifest),
      },
    ],
    id,
  );
  // Re-sync the in-memory autosave bookkeeping so the next
  // `scheduleAutosave` doesn't immediately force-write because it
  // sees a huge `comparisons - comparisonsAtLastFlush` delta.
  if (currentActiveId === id) {
    resetAutosaveBookkeeping(blob.progress.comparisons);
  }
  return true;
}

/**
 * After loading a slot into memory, persist the canonical blob when
 * deserialize-time normalization changed the on-disk shape (e.g.
 * insertion-done → merge-done). Writes without bumping `updatedAt` so
 * cloud-sync state is not disturbed, and resets autosave bookkeeping so
 * the next debounced write hits the no-op path instead of re-writing.
 *
 * Safe to call when disk already matches — only resets bookkeeping for
 * the active slot.
 */
export function persistCanonicalBlobOnLoad(
  id: string,
  blob: AutosaveBlob,
): void {
  const existing = readSlotBlob(id);
  if (existing && JSON.stringify(existing) === JSON.stringify(blob)) {
    if (currentActiveId === id) {
      resetAutosaveBookkeeping(blob.progress.comparisons);
    }
    return;
  }

  if (!existing) return;

  if (currentActiveId === id) {
    cancelPendingAutosave();
  }
  if (!tryWriteSlotBlob(id, blob)) {
    // Quota failure on a silent migration — leave the legacy blob;
    // autosave will retry with normal recovery paths on the next edit.
    return;
  }
  void queueStateWrite(
    [
      {
        type: 'put',
        store: SORTER_SLOT_STORE,
        key: id,
        value: buildSaveFile(blob),
      },
    ],
    id,
  );
  if (currentActiveId === id) {
    resetAutosaveBookkeeping(blob.progress.comparisons);
  }
}

/**
 * Wipe all cloud-sync metadata without changing local identity. Used by
 * Drive-side-delete recovery, where the cloud copy disappeared underneath
 * an otherwise unchanged local slot and the next Push should create a file.
 * Leaves `cloudOptIn` untouched — the user's opt-in preference
 * is what makes the slot eligible for that recovery Push.
 */
export function clearCloudBinding(id: string): SlotsManifest {
  return updateSlotMeta(id, {
    cloudId: undefined,
    cloudEtag: undefined,
    cloudPushedAt: undefined,
    cloudUpdatedAt: undefined,
  });
}

export interface UnlinkCloudSlotResult {
  manifest: SlotsManifest;
  newId: string;
}

/**
 * Turn a cloud-backed slot into an independent local slot. The payload and
 * user-facing metadata stay intact, while both the Drive binding and the old
 * logical slot id are retired. A later Push therefore creates a distinct
 * cloud file instead of reconnecting to the unlinked identity.
 */
export function unlinkCloudSlot(id: string): UnlinkCloudSlotResult | null {
  flushAutosave();
  const manifest = readManifest();
  const slotIndex = manifest.slots.findIndex((slot) => slot.id === id);
  const blob = readSlotBlob(id);
  if (slotIndex < 0 || !blob) return null;

  const newId = newSlotId(new Set(manifest.slots.map((slot) => slot.id)));
  const slot = manifest.slots[slotIndex];
  const detachedSlot: SlotMeta = {
    ...slot,
    id: newId,
    cloudOptIn: false,
    cloudId: undefined,
    cloudEtag: undefined,
    cloudPushedAt: undefined,
    cloudUpdatedAt: undefined,
  };

  manifest.slots = manifest.slots.map((entry) =>
    entry.id === id ? detachedSlot : entry,
  );
  if (manifest.activeId === id) {
    manifest.activeId = newId;
  }

  slotBlobCache.set(newId, blob);
  slotBlobCache.delete(id);
  manifestCache = manifest;
  if (manifest.activeId) {
    localStorage.setItem(ACTIVE_SORTER_SLOT_KEY, manifest.activeId);
  }

  void queueStateWrite(
    [
      {
        type: 'put',
        store: SORTER_SLOT_STORE,
        key: newId,
        value: buildSaveFile(blob),
      },
      { type: 'delete', store: SORTER_SLOT_STORE, key: id },
      {
        type: 'put',
        store: STATE_METADATA_STORE,
        key: stateStorageRecordKeys.sorterManifest,
        value: sorterManifestRecord(manifest),
      },
    ],
    newId,
  );

  if (currentActiveId === id) {
    currentActiveId = newId;
    resetAutosaveBookkeeping(blob.progress.comparisons);
  }
  return { manifest, newId };
}

/**
 * Compute the sync-metadata timestamps for a slot adopted from a cloud
 * pull (the "Browse cloud library" → Pull flow, which mints a fresh slot
 * via `createSlot`).
 *
 * A freshly-pulled copy IS the authoritative cloud copy, so two things
 * must hold that `createSlot`'s default `updatedAt = now` would break:
 *
 *  - It should read as "synced", not "local changes pending". The slot
 *    list derives that from `updatedAt > cloudPushedAt`, so the adopted
 *    `updatedAt` must not be later than `cloudPushedAt`.
 *  - It should sort by *when it was last worked on* (the Drive file's
 *    modified time) instead of the mint moment — otherwise it propels to
 *    the top of the list as "just now".
 *
 * Hence `updatedAt` = the cloud file's modified time, and `cloudPushedAt`
 * = "now" clamped up to the cloud date so the synced invariant survives
 * clock skew (a Drive timestamp ahead of the local clock).
 */
export function deriveAdoptedCloudSlotTimestamps(
  driveUpdatedAt: string,
  nowIso: string,
): { updatedAt: string; cloudPushedAt: string; cloudUpdatedAt: string } {
  const cloudPushedAt = driveUpdatedAt > nowIso ? driveUpdatedAt : nowIso;
  return { updatedAt: driveUpdatedAt, cloudPushedAt, cloudUpdatedAt: driveUpdatedAt };
}

// ---------- post-write notification registry (tier 0b seam) ----------

/**
 * Event-log seam fired after every successful autosave write to a
 * slot's blob. Phase 1 has no subscribers — this exists so the future
 * Tier 1 autosave-to-cloud layer can observe "a slot just changed
 * locally" without `storage.ts` needing to know anything about cloud.
 *
 * Policy (debounce / max-wait / "should we push") lives in the
 * subscriber, NOT here. The locked decision is that the cloud-flush
 * call site is imperative (`cloud.cloudFlushSlot(id)`) rather than
 * implicitly chained off this notify — but the notify is the cheapest
 * possible hook for a subscriber that wants to schedule its own flush.
 *
 * Subscriber-throws-are-isolated: a buggy subscriber must not break
 * the write path. We catch + warn and keep going.
 */
type PostWriteListener = (slotId: string) => void;

const postWriteListeners = new Set<PostWriteListener>();

export function subscribeAfterWrite(listener: PostWriteListener): () => void {
  postWriteListeners.add(listener);
  return () => {
    postWriteListeners.delete(listener);
  };
}

function notifyAfterWrite(slotId: string): void {
  for (const l of postWriteListeners) {
    try {
      l(slotId);
    } catch (err) {
      console.warn('post-write listener threw', err);
    }
  }
}

/** Test-only: drop all subscribers. Lets the cloud test suite reset
 *  the seam between cases without leaking listeners across test files. */
export function _clearPostWriteListeners(): void {
  postWriteListeners.clear();
}

// ---------- autosave (debounced with max-wait) ----------

let pendingBlob: AutosaveBlob | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastFlushTime = 0;
let comparisonsAtLastFlush = 0;

// ---------- autosave error surfacing ----------

/**
 * Describes the last terminal autosave failure (i.e. one that recovery
 * could not fix). Surfaced via `subscribeAutosaveError` so the UI can
 * render a banner. Cleared automatically on the next successful write.
 */
export interface AutosaveError {
  reason: 'quota' | 'other';
  attemptedAt: string; // ISO timestamp
  /** Number of localStorage slot keys present when the failure happened —
   *  surfaces "you have N saves; try deleting old ones" in the banner. */
  slotCount: number;
}

/**
 * Describes a successful auto-recovery during autosave. Surfaced via the
 * same subscriber so the UI can prompt the user about a side effect
 * (e.g. the in-memory undo ring being trimmed to match the on-disk one,
 * or an old slot being evicted). Distinct from `AutosaveError` because
 * recovery means the write SUCCEEDED — no banner is needed, just a
 * one-shot toast.
 */
export interface AutosaveRecovery {
  kind: 'trimmed-undo' | 'evicted-slot';
  /** Updated undoRing length when kind = 'trimmed-undo'; the App should
   *  truncate its in-memory ring to this length so future writes don't
   *  re-grow the on-disk ring back to its bloated size. */
  newUndoRingLen?: number;
  /** Evicted slot's meta when kind = 'evicted-slot'. */
  evicted?: SlotMeta;
}

export type AutosaveErrorListener = (
  err: AutosaveError | null,
  recovery?: AutosaveRecovery,
) => void;

let errorListener: AutosaveErrorListener | null = null;
let lastError: AutosaveError | null = null;
let lastQuotaErrorAt: string | null = null;

/**
 * Subscribe to autosave failure / recovery events. The listener fires
 *  - on terminal failure (passes `AutosaveError`, no recovery)
 *  - on successful auto-recovery (passes `null` error + `AutosaveRecovery`)
 *  - on first successful write after a prior error (passes `null` to clear)
 * Returns an unsubscribe function. Only one listener is supported — the
 * App registers it once at boot.
 */
export function subscribeAutosaveError(listener: AutosaveErrorListener): () => void {
  errorListener = listener;
  return () => {
    if (errorListener === listener) errorListener = null;
  };
}

export function getLastAutosaveError(): AutosaveError | null {
  return lastError;
}

export function getLastQuotaErrorAt(): string | null {
  return lastQuotaErrorAt;
}

function notifyError(
  err: AutosaveError | null,
  recovery?: AutosaveRecovery,
): void {
  lastError = err;
  if (errorListener) errorListener(err, recovery);
}

/**
 * Attempt to write the given slot blob to localStorage. Returns true on
 * success, false on any failure (quota, security policy, or anything
 * else localStorage may surface). We treat ALL failures as recoverable
 * — the recovery path in `performWrite` does the same fallbacks
 * regardless of the underlying browser-specific error name. The caller
 * is responsible for retry / recovery / error surfacing.
 */
function tryWriteSlotBlob(id: string, blob: AutosaveBlob): boolean {
  slotBlobCache.set(id, blob);
  return true;
}

function purgeDisposableLocalStorageCaches(): boolean {
  const keysToDelete: string[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith('tools-cache:')) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      window.localStorage.removeItem(key);
    }
  } catch {
    return false;
  }
  return keysToDelete.length > 0;
}

function tryWriteSlotBlobAfterCachePurge(
  id: string,
  blob: AutosaveBlob,
): boolean {
  if (tryWriteSlotBlob(id, blob)) {
    return true;
  }
  return purgeDisposableLocalStorageCaches() && tryWriteSlotBlob(id, blob);
}

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

/**
 * Public alias for `cancelPendingAutosave`. Used by the multi-tab
 * coordination path: when another tab writes to the active slot's blob,
 * this tab must drop its in-flight autosave WITHOUT writing it —
 * otherwise the pending flush would clobber the other tab's changes.
 * Caller should follow with `readSlotBlob` to re-sync in-memory state
 * to the now-canonical disk state.
 */
export function discardPendingAutosave(): void {
  cancelPendingAutosave();
}

function isQuotaStorageError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}

function sorterSlotAndManifestChanges(
  id: string,
  blob: AutosaveBlob,
  manifest: SlotsManifest,
): StateStorageChange[] {
  return [
    {
      type: 'put',
      store: SORTER_SLOT_STORE,
      key: id,
      value: buildSaveFile(blob),
    },
    {
      type: 'put',
      store: STATE_METADATA_STORE,
      key: stateStorageRecordKeys.sorterManifest,
      value: sorterManifestRecord(manifest),
    },
  ];
}

function queueAutosavePersistence(
  id: string,
  blob: AutosaveBlob,
  manifest: SlotsManifest,
): void {
  stateWriteQueue = stateWriteQueue
    .then(async () => {
      let persistedBlob = blob;
      let persistedManifest = manifest;
      let recovery: AutosaveRecovery | undefined;
      try {
        await commitStateChanges(
          sorterSlotAndManifestChanges(id, persistedBlob, persistedManifest),
          { scope: 'sorter', id },
        );
      } catch (firstError) {
        if (!isQuotaStorageError(firstError)) throw firstError;
        lastQuotaErrorAt = new Date().toISOString();
        await sweepExpiredDisposableCache();
        await clearDisposableCachesUnderPressure();
        purgeDisposableLocalStorageCaches();

        try {
          await commitStateChanges(
            sorterSlotAndManifestChanges(id, persistedBlob, persistedManifest),
            { scope: 'sorter', id },
          );
          slotBlobCache.set(id, persistedBlob);
          notifyError(null);
          notifyAfterWrite(id);
          return;
        } catch (retryError) {
          if (!isQuotaStorageError(retryError)) throw retryError;
        }

        const trimmedUndo = blob.undoRing.slice(-QUOTA_RECOVERY_UNDO_KEEP);
        if (trimmedUndo.length < blob.undoRing.length) {
          persistedBlob = { ...blob, undoRing: trimmedUndo };
          try {
            await commitStateChanges(
              sorterSlotAndManifestChanges(
                id,
                persistedBlob,
                persistedManifest,
              ),
              { scope: 'sorter', id },
            );
            recovery = {
              kind: 'trimmed-undo',
              newUndoRingLen: trimmedUndo.length,
            };
          } catch (trimError) {
            if (!isQuotaStorageError(trimError)) throw trimError;
          }
        }

        if (!recovery) {
          const evicted = persistedManifest.slots
            .filter((slot) => slot.id !== id && !slot.pinned)
            .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
          if (!evicted) throw firstError;
          persistedManifest = {
            ...persistedManifest,
            slots: persistedManifest.slots.filter(
              (slot) => slot.id !== evicted.id,
            ),
          };
          await commitStateChanges(
            [
              {
                type: 'delete',
                store: SORTER_SLOT_STORE,
                key: evicted.id,
              },
              ...sorterSlotAndManifestChanges(
                id,
                persistedBlob,
                persistedManifest,
              ),
            ],
            { scope: 'sorter', id },
          );
          slotBlobCache.delete(evicted.id);
          manifestCache = persistedManifest;
          recovery = { kind: 'evicted-slot', evicted };
        }
      }

      slotBlobCache.set(id, persistedBlob);
      notifyError(null, recovery);
      notifyAfterWrite(id);
    })
    .catch((error: unknown) => {
      const attemptedAt = new Date().toISOString();
      if (isQuotaStorageError(error)) {
        lastQuotaErrorAt = attemptedAt;
      }
      notifyError({
        reason: isQuotaStorageError(error) ? 'quota' : 'other',
        attemptedAt,
        slotCount: manifestCache.slots.length,
      });
    });
}

/**
 * Trimmed undo-ring length used by the quota-recovery fallback. Chosen
 * to keep enough history that a casual mid-comparison undo still works
 * (5 entries ≈ 5 clicks back), while being small enough to materially
 * shrink the on-disk blob when storage is full. Surfaced via the
 * `AutosaveRecovery.newUndoRingLen` notification so App.tsx can mirror
 * the trim in memory (otherwise the next autosave just re-grows the
 * ring and we hit quota again).
 */
const QUOTA_RECOVERY_UNDO_KEEP = 5;

/**
 * Commit a successful write's side effects: bump the slot's meta,
 * reset the in-flight bookkeeping, and clear any prior quota error.
 * Pulled out of performWrite so the recovery paths share the same
 * post-write housekeeping.
 */
function commitWriteSuccess(blob: AutosaveBlob, recovery?: AutosaveRecovery): void {
  if (currentActiveId === null) return;
  const writtenId = currentActiveId;
  const now = new Date().toISOString();
  const manifest = readManifest();
  manifest.slots = manifest.slots.map((slot) =>
    slot.id === writtenId
      ? {
          ...slot,
          updatedAt: now,
          totalItems: visibleItemCount(blob),
          comparisons: blob.progress.comparisons,
          done: blob.progress.done,
        }
      : slot,
  );
  manifestCache = manifest;
  queueAutosavePersistence(writtenId, blob, manifest);
  lastFlushTime = Date.now();
  comparisonsAtLastFlush = blob.progress.comparisons;
  if (recovery) {
    notifyError(null, recovery);
  }
}

/**
 * Persist the given autosave blob to the active slot.
 *
 * On quota exhaustion we purge disposable tool caches, then attempt two
 * user-data recovery stages before giving up:
 *  1. Trim the on-disk undoRing to the last `QUOTA_RECOVERY_UNDO_KEEP`
 *     entries and retry. The UI mirrors the trim so subsequent writes
 *     don't re-bloat back to quota.
 *  2. Evict the oldest non-pinned non-active slot and retry. The UI
 *     receives a `kind: 'evicted-slot'` recovery notification so it
 *     can flash a toast naming what was deleted.
 * If both recoveries fail, surface a terminal AutosaveError so the
 * banner appears.
 *
 * Always clears `pendingBlob` on entry so a follow-up `flushAutosave`
 * doesn't re-run the same write (this was a latent duplicate-write bug
 * in the force-flush + flushAutosave sequence — the force-flush path
 * in `scheduleAutosave` wrote synchronously but left `pendingBlob`
 * set, so the next `flushAutosave` from the caller re-issued the same
 * blob to localStorage).
 */
function performWrite(blob: AutosaveBlob, options?: { touchLastUsed?: boolean }): void {
  if (currentActiveId === null) return;
  pendingBlob = null;

  // No-op write skip: when the autosave-on-state-change effect fires
  // because state/undoRing got rebound to identical content (e.g. the
  // user clicked a slot to load it, or a Pull just replaced the blob
  // and the inbound bytes match the in-memory state), the blob is
  // bit-identical to what's already on disk. Without this check, we
  // would still go through `tryWriteSlotBlob` + `commitWriteSuccess`,
  // which bumps `updatedAt` to "now" and makes the cloud-sync indicator
  // flip from green to yellow even though nothing changed. Skipping
  // both the setItem and the meta bump keeps `updatedAt` stable and
  // avoids a phantom "pending" state.
  //
  // We compare on the AutosaveBlob shape, not on the SaveFile wrapper
  // string, because `buildSaveFile` stamps a fresh `createdAt` on every
  // call — raw-string comparison would never match. `readSlotBlob`
  // parses the on-disk blob back into the same AutosaveBlob shape, so
  // JSON-stringifying both sides compares only the user-visible content
  // (items + progress + undoRing) which is what `updatedAt` semantics
  // actually represent.
  //
  // Bookkeeping: we still update `lastFlushTime` and
  // `comparisonsAtLastFlush` so subsequent scheduleAutosave calls treat
  // this moment as "the last successful flush" — otherwise they'd
  // immediately force-write again on the 10s / 20-comparison threshold
  // and re-run this same no-op check at high cadence. We do NOT call
  // `notifyAfterWrite` (no write happened, no subscriber needs to
  // refresh) and we do NOT call `notifyError(null, ...)` because there
  // was nothing to clear/recover from.
  const existing = readSlotBlob(currentActiveId);
  if (existing && JSON.stringify(existing) === JSON.stringify(blob)) {
    lastFlushTime = Date.now();
    comparisonsAtLastFlush = blob.progress.comparisons;
    // Toolbar Save: user explicitly touched this slot — bump recency even
    // when the blob is unchanged. Autosave skips the meta bump here.
    if (options?.touchLastUsed) {
      commitWriteSuccess(blob);
    }
    return;
  }

  if (tryWriteSlotBlobAfterCachePurge(currentActiveId, blob)) {
    commitWriteSuccess(blob);
    return;
  }

  // First retry: trim the undoRing (only useful if it actually has
  // surplus entries — otherwise skip straight to eviction).
  if (blob.undoRing.length > QUOTA_RECOVERY_UNDO_KEEP) {
    const trimmed: AutosaveBlob = {
      ...blob,
      undoRing: blob.undoRing.slice(-QUOTA_RECOVERY_UNDO_KEEP),
    };
    if (tryWriteSlotBlob(currentActiveId, trimmed)) {
      commitWriteSuccess(trimmed, {
        kind: 'trimmed-undo',
        newUndoRingLen: trimmed.undoRing.length,
      });
      return;
    }
  }

  // Second retry: evict the oldest non-pinned non-active slot.
  const m = readManifest();
  const evictable = m.slots
    .filter((s) => !s.pinned && s.id !== currentActiveId)
    .slice()
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  if (evictable.length > 0) {
    const victim = evictable[0];
    deleteSlotBlob(victim.id);
    m.slots = m.slots.filter((s) => s.id !== victim.id);
    writeManifest(m);
    // After eviction, try the trimmed blob first (if we trimmed above)
    // — it's strictly smaller so it has a better chance of fitting.
    const candidateBlob: AutosaveBlob =
      blob.undoRing.length > QUOTA_RECOVERY_UNDO_KEEP
        ? { ...blob, undoRing: blob.undoRing.slice(-QUOTA_RECOVERY_UNDO_KEEP) }
        : blob;
    if (tryWriteSlotBlob(currentActiveId, candidateBlob)) {
      commitWriteSuccess(candidateBlob, {
        kind: 'evicted-slot',
        evicted: victim,
        newUndoRingLen:
          candidateBlob.undoRing.length === blob.undoRing.length
            ? undefined
            : candidateBlob.undoRing.length,
      });
      return;
    }
  }

  // All recovery exhausted — surface a terminal error so the UI banner
  // appears and the user can pin / delete slots to free room manually.
  console.warn('autosave write failed; all recovery exhausted');
  notifyError({
    reason: 'quota',
    attemptedAt: new Date().toISOString(),
    slotCount: m.slots.length,
  });
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
export async function flushAutosave(): Promise<void> {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (pendingBlob) performWrite(pendingBlob);
  await flushStateStorageWrites();
}

/**
 * Toolbar Save: persist the active slot immediately and always bump its
 * `updatedAt` so it sorts to the top of the slot list — even when the
 * blob matches what's already on disk. Autosave deliberately skips that
 * meta bump on no-op writes.
 */
export function saveNow(blob: AutosaveBlob): void {
  if (currentActiveId === null) return;
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingBlob = null;
  performWrite(blob, { touchLastUsed: true });
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
  if (
    parsed.version !== 1 &&
    parsed.version !== 2 &&
    parsed.version !== 3 &&
    parsed.version !== 4
  ) {
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

// ---------- bulk archive (all slots in one file) ----------

/**
 * Bundled archive shape for "Backup all slots" / "Restore from backup".
 * A single JSON envelope holding the manifest + every slot blob, so the
 * user can save their entire sorter state to one file before clearing
 * browser data or migrating to a new machine.
 *
 * `archiveVersion` is independent of the per-slot `SaveFile.version` —
 * archive shape can evolve without breaking individual slot loads, and
 * individual slots remain importable as standalone `.json` files via
 * `loadSaveFromFile` regardless of what archive version produced them.
 */
export interface SlotArchive {
  archiveVersion: 1;
  exportedAt: string;
  manifest: SlotsManifest;
  /** id -> blob. Keys must match `manifest.slots[i].id`. */
  blobs: Record<string, AutosaveBlob>;
}

export interface ImportAllResult {
  imported: number;
  skipped: number;
  /**
   * When a merge-mode import collided with an existing slot id, the
   * imported blob was reassigned a fresh id. This array reports the
   * rename so the UI can fold the rename count into the import toast.
   */
  renamedIds: Array<{ from: string; to: string }>;
  /** Populated on terminal failure; on-disk state was NOT touched. */
  error?: string;
}

/**
 * Bundle every slot into a single JSON archive string. Reads the
 * manifest, then each slot's blob; slots whose blob is missing from
 * disk are silently dropped from the archive (the resulting manifest
 * inside the archive is trimmed to match, so the importer never sees
 * a "ghost meta" pointing at a non-existent blob).
 *
 * Returns the JSON string; the caller is responsible for triggering
 * the actual file download. Returns a valid (but empty-payload)
 * archive when there are no slots to back up — the caller decides
 * whether to disable the button or download an empty file.
 */
export function exportAllSlots(): string {
  const manifest = readManifest();
  const blobs: Record<string, AutosaveBlob> = {};
  const survivingSlots: SlotMeta[] = [];
  for (const meta of manifest.slots) {
    const blob = readSlotBlob(meta.id);
    if (!blob) continue;
    blobs[meta.id] = blob;
    survivingSlots.push(meta);
  }
  const trimmedManifest: SlotsManifest = {
    version: 1,
    activeId:
      manifest.activeId && blobs[manifest.activeId] ? manifest.activeId : null,
    slots: survivingSlots,
  };
  const archive: SlotArchive = {
    archiveVersion: 1,
    exportedAt: new Date().toISOString(),
    manifest: trimmedManifest,
    blobs,
  };
  return JSON.stringify(archive, null, 2);
}

/**
 * Trigger a browser download of the bundled archive. Filename embeds the
 * timestamp so successive backups don't overwrite each other. Sibling of
 * `downloadSave` (single slot) — split so callers can drive the byte
 * generation separately from the DOM side effect (useful in tests).
 */
export function downloadAllSlots(): void {
  const json = exportAllSlots();
  const blobObj = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blobObj);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sorter-backup-${timestampForFilename()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Import every slot from a `SlotArchive` JSON string. Two modes:
 *
 * - `'merge'`: add archive slots to the existing set. If an archive
 *   slot's id collides with an existing slot id, mint a fresh id for
 *   the import (the existing slot keeps its id) and report the rename
 *   in `renamedIds`. Respects `SLOT_CAP` — returns an error without
 *   touching disk if the merged total would exceed cap. Active-slot
 *   pointer is NOT touched (user keeps their current working slot).
 *   The `pinned` flag from archive metas is preserved verbatim.
 *
 * - `'replace'`: wipe every existing slot blob + the manifest, then
 *   write archive blobs + manifest. Destructive — caller is responsible
 *   for a confirm-modal pre-flight. Active-slot pointer adopts the
 *   archive's `activeId` when its blob made it through validation;
 *   otherwise null. Hard-caps at `SLOT_CAP` so an oversized archive
 *   can't corrupt the manifest (excess slots are skipped, not silently
 *   dropped — the count appears in `skipped`).
 *
 * Crash safety: the manifest write is the FINAL durable step in both
 * modes. A mid-import crash leaves on-disk slot blobs partially
 * populated but the manifest reflects either the pre-import state
 * (merge, since we don't write manifest until everything succeeds) or
 * an empty state (replace, after the wipe). `repairManifestIfCorrupt`
 * on the next boot rebuilds a coherent view from whatever blobs
 * survived.
 *
 * In-memory-only environments (file:// / private mode) return an error
 * — there's no persistence to import into.
 */
export function importAllSlots(
  json: string,
  mode: 'merge' | 'replace' = 'merge',
): ImportAllResult {
  // -------- parse + envelope validation --------
  let archive: SlotArchive;
  try {
    const parsed = JSON.parse(json) as Partial<SlotArchive>;
    if (parsed.archiveVersion !== 1) {
      return {
        imported: 0,
        skipped: 0,
        renamedIds: [],
        error: `Unsupported archive version: ${String(parsed.archiveVersion)}`,
      };
    }
    if (
      !parsed.manifest ||
      typeof parsed.manifest !== 'object' ||
      !Array.isArray(parsed.manifest.slots) ||
      !parsed.blobs ||
      typeof parsed.blobs !== 'object'
    ) {
      return {
        imported: 0,
        skipped: 0,
        renamedIds: [],
        error: 'Archive is missing required fields.',
      };
    }
    archive = parsed as SlotArchive;
  } catch {
    return {
      imported: 0,
      skipped: 0,
      renamedIds: [],
      error: 'Archive is not valid JSON.',
    };
  }

  // -------- per-blob validation (lenient: bad ones are skipped) --------
  // Validate every blob in the archive UP FRONT so we know the real
  // import size before mutating any on-disk state. This is what lets
  // the merge cap check be accurate (`existing + valid <= SLOT_CAP`)
  // rather than counting bad blobs that would never make it.
  const validImports: Array<{ meta: SlotMeta; blob: AutosaveBlob }> = [];
  let skipped = 0;
  for (const meta of archive.manifest.slots) {
    const raw = archive.blobs[meta.id] as Partial<AutosaveBlob> | undefined;
    if (!raw || typeof raw !== 'object' || !raw.items || !raw.progress) {
      skipped++;
      continue;
    }
    // Normalize through upgradeProgress so any v1/v2 progress in the
    // archive becomes v3 on import. (The export side serializes the
    // current in-memory blob, which is always v3, but archives from
    // older builds — or hand-edited ones — might carry older shapes.)
    let normalized: AutosaveBlob;
    try {
      normalized = {
        items: raw.items,
        progress: upgradeProgress(raw.progress),
        undoRing: Array.isArray(raw.undoRing)
          ? raw.undoRing.map(upgradeProgress)
          : [],
      };
    } catch {
      skipped++;
      continue;
    }
    validImports.push({ meta, blob: normalized });
  }

  if (mode === 'replace') {
    return applyReplaceImport(archive, validImports, skipped);
  }
  return applyMergeImport(validImports, skipped);
}

/**
 * Replace-mode import: wipe everything, then write archive contents.
 * Hard-caps at SLOT_CAP so an oversized archive can't corrupt the
 * manifest — extra slots are dropped from the END of the archive's
 * slot list (preserving the order the archive was exported in).
 */
function applyReplaceImport(
  archive: SlotArchive,
  validImports: Array<{ meta: SlotMeta; blob: AutosaveBlob }>,
  initialSkipped: number,
): ImportAllResult {
  let skipped = initialSkipped;
  const accepted = validImports.slice(0, SLOT_CAP);
  skipped += validImports.length - accepted.length;

  // Wipe phase: cancel any in-flight autosave for the OUTGOING active
  // slot (we're about to delete its blob), then delete every existing
  // slot blob. We do this before writing new blobs so storage quota
  // is freed first — important when the archive is large.
  cancelPendingAutosave();
  slotBlobCache.clear();
  const survivedMetas: SlotMeta[] = [];
  const changes: StateStorageChange[] = [
    { type: 'clear', store: SORTER_SLOT_STORE },
  ];
  for (const { meta, blob } of accepted) {
    slotBlobCache.set(meta.id, blob);
    survivedMetas.push(meta);
    changes.push({
      type: 'put',
      store: SORTER_SLOT_STORE,
      key: meta.id,
      value: buildSaveFile(blob),
    });
  }
  const activeId =
    archive.manifest.activeId &&
    survivedMetas.some((s) => s.id === archive.manifest.activeId)
      ? archive.manifest.activeId
      : null;
  const newManifest: SlotsManifest = {
    version: 1,
    activeId,
    slots: survivedMetas,
  };
  manifestCache = newManifest;
  if (activeId) {
    localStorage.setItem(ACTIVE_SORTER_SLOT_KEY, activeId);
  } else {
    localStorage.removeItem(ACTIVE_SORTER_SLOT_KEY);
  }
  changes.push({
    type: 'put',
    store: STATE_METADATA_STORE,
    key: stateStorageRecordKeys.sorterManifest,
    value: sorterManifestRecord(newManifest),
  });
  void queueStateWrite(changes);
  currentActiveId = activeId;
  // Bookkeeping for autosave: the active slot (if any) just got its
  // blob written fresh from the archive, so treat that as "the last
  // flush" — the next scheduleAutosave shouldn't immediately force-write.
  const adoptedComparisons =
    activeId !== null
      ? (accepted.find((a) => a.meta.id === activeId)?.blob.progress
          .comparisons ?? 0)
      : 0;
  resetAutosaveBookkeeping(adoptedComparisons);
  return {
    imported: survivedMetas.length,
    skipped,
    renamedIds: [],
  };
}

/**
 * Merge-mode import: add archive slots to the existing set, renaming
 * any colliding ids. Aborts BEFORE touching disk if the merged total
 * would exceed `SLOT_CAP` — caller can either delete some slots and
 * retry, or switch to replace mode.
 */
function applyMergeImport(
  validImports: Array<{ meta: SlotMeta; blob: AutosaveBlob }>,
  initialSkipped: number,
): ImportAllResult {
  let skipped = initialSkipped;
  const existing = readManifest();
  if (existing.slots.length + validImports.length > SLOT_CAP) {
    return {
      imported: 0,
      skipped: 0,
      renamedIds: [],
      error:
        `Cannot import — would exceed the ${SLOT_CAP}-slot cap ` +
        `(have ${existing.slots.length}, archive adds ${validImports.length}). ` +
        `Delete some slots first or use Replace instead.`,
    };
  }

  const existingIds = new Set(existing.slots.map((s) => s.id));
  const renamedIds: Array<{ from: string; to: string }> = [];
  const importedMetas: SlotMeta[] = [];
  const changes: StateStorageChange[] = [];
  for (const { meta, blob } of validImports) {
    let targetId = meta.id;
    if (existingIds.has(targetId)) {
      // Mint a fresh id so we don't clobber the existing slot's blob.
      // Loop guards against the (vanishingly rare) case where the new
      // id collides with something already taken.
      do {
        targetId = newSlotId();
      } while (existingIds.has(targetId));
      renamedIds.push({ from: meta.id, to: targetId });
    }
    existingIds.add(targetId);
    slotBlobCache.set(targetId, blob);
    changes.push({
      type: 'put',
      store: SORTER_SLOT_STORE,
      key: targetId,
      value: buildSaveFile(blob),
    });
    // Preserve every meta field except the (possibly-renamed) id —
    // including `pinned`, `updatedAt`, `createdAt`, etc. updatedAt is
    // kept verbatim so the imported slots don't artificially bubble
    // to the top of the LIST tab (the list sorts pinned-first then by
    // updatedAt, so imported slots slot into their natural recency
    // position alongside the user's existing slots).
    importedMetas.push({ ...meta, id: targetId });
  }

  // Prepend imported slots in the manifest. SlotList sorts pinned-first
  // then by updatedAt at render time, so the visual order is driven by
  // recency — but if anything ever iterates `manifest.slots` directly
  // for "most-recent-import" semantics, the prepend gives a sensible
  // default ordering.
  const newManifest: SlotsManifest = {
    version: 1,
    activeId: existing.activeId, // keep user's current working slot
    slots: [...importedMetas, ...existing.slots],
  };
  manifestCache = newManifest;
  changes.push({
    type: 'put',
    store: STATE_METADATA_STORE,
    key: stateStorageRecordKeys.sorterManifest,
    value: sorterManifestRecord(newManifest),
  });
  void queueStateWrite(changes);
  return {
    imported: importedMetas.length,
    skipped,
    renamedIds,
  };
}

// ---------- small settings ----------

export type ThemeName = 'light' | 'dark';

export interface Settings {
  /**
   * "Don't ask again" for the SlotDeleteConfirmModal (the per-row trashcan
   * in the gear-menu slot list). Kept under its legacy name for
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
  /**
   * "Don't ask again" for edits to a completed sort (add items, pre-ranked
   * append, etc.). When set, skip the modal and always mint a new slot
   * (the completed slot stays untouched).
   */
  suppressCompletedSortEditConfirm?: boolean;
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
  /**
   * When true, intercept the browser Back button while work is at risk
   * (sort in progress, START draft, A2A round). Default off.
   */
  historyBackGuard?: boolean;
  /** Shared ordering for every Google Drive slot browser. */
  cloudSlotSortKey?: 'title' | 'date';
  cloudSlotSortDirection?: 'asc' | 'desc';
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

export function _resetSorterStorageCacheForTesting(): void {
  cancelPendingAutosave();
  manifestCache = emptyManifest();
  slotBlobCache.clear();
  sorterStorageInitialized = false;
  stateWriteQueue = Promise.resolve();
  currentActiveId = null;
  lastRepairCount = null;
  lastError = null;
  lastQuotaErrorAt = null;
  lastFlushTime = 0;
  comparisonsAtLastFlush = 0;
}
