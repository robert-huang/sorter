import {
  isBumpChartMeta,
  isLegacyBumpChartManifest,
  isLegacyBumpChartWorkspace,
  isLegacySavedBumpChartRecord,
  isLegacySorterManifest,
  isLegacySorterSaveFile,
  isSorterSlotMeta,
} from './stateStorageValidation';

const DATABASE_NAME = 'queue-sorter-state';
const DATABASE_VERSION = 1;

export const SORTER_SLOT_STORE = 'sorterSlots';
export const BUMP_WORKSPACE_STORE = 'bumpWorkspaces';
export const STATE_METADATA_STORE = 'metadata';

export const ACTIVE_SORTER_SLOT_KEY = 'sorter:active-slot-id:v1';
export const STATE_SCHEMA_KEY = 'sorter:state-schema:v1';
export const STATE_REVISION_KEY = 'sorter:state-revision:v1';
export const SORTER_MANIFEST_BACKUP_KEY = 'sorter:manifest-backup:v1';
export const BUMP_MANIFEST_BACKUP_KEY = 'sorter:bump-manifest-backup:v1';

const LEGACY_IMPORTED_KEY = 'legacyImported:v1';
const SORTER_MANIFEST_RECORD = 'sorterManifest';
const SORTER_PREVIOUS_MANIFEST_RECORD = 'sorterManifestPrevious';
const SORTER_CORRUPT_MANIFEST_RECORD = 'sorterManifestCorrupt';
const SORTER_SLOT_META_PREFIX = 'sorterSlotMeta:';
const BUMP_MANIFEST_RECORD = 'bumpManifest';
const BUMP_PREVIOUS_MANIFEST_RECORD = 'bumpManifestPrevious';
const BUMP_CORRUPT_MANIFEST_RECORD = 'bumpManifestCorrupt';
const BUMP_WORKSPACE_META_PREFIX = 'bumpWorkspaceMeta:';
const LEGACY_SORTER_SINGLE_RECORD = 'legacySorterSingle';

const LEGACY_SORTER_KEY = 'sorter:v1';
const LEGACY_SORTER_MANIFEST_KEY = 'sorter:slots:v1';
const LEGACY_BUMP_ACTIVE_KEY = 'tools:bump-chart:workspace:v1';
const LEGACY_BUMP_MANIFEST_KEY = 'tools:bump-chart:saved-manifest:v1';
const LEGACY_BUMP_SLOT_PREFIX = 'tools:bump-chart:saved:v1:';

export type StateStoreName =
  | typeof SORTER_SLOT_STORE
  | typeof BUMP_WORKSPACE_STORE
  | typeof STATE_METADATA_STORE;

export type StateStorageChange =
  | { type: 'put'; store: StateStoreName; key: IDBValidKey; value: unknown }
  | { type: 'delete'; store: StateStoreName; key: IDBValidKey }
  | { type: 'clear'; store: StateStoreName };

export type StateStorageStatus = {
  persistent: boolean;
  error: string | null;
};

const memoryStores: Record<StateStoreName, Map<IDBValidKey, unknown>> = {
  [SORTER_SLOT_STORE]: new Map(),
  [BUMP_WORKSPACE_STORE]: new Map(),
  [STATE_METADATA_STORE]: new Map(),
};

let databasePromise: Promise<IDBDatabase> | null = null;
let initializationPromise: Promise<StateStorageStatus> | null = null;
let memoryOnly = false;
let storageError: string | null = null;
let revisionSequence = 0;

class StateDatabaseBlockedError extends Error {
  constructor() {
    super('State database upgrade is blocked. Close other app tabs and retry.');
    this.name = 'StateDatabaseBlockedError';
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'IndexedDB is unavailable.';
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) {
    return databasePromise;
  }
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable.'));
  }

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let settled = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const store of [
        SORTER_SLOT_STORE,
        BUMP_WORKSPACE_STORE,
        STATE_METADATA_STORE,
      ]) {
        if (!database.objectStoreNames.contains(store)) {
          database.createObjectStore(store);
        }
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error('Failed to open state database.'));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new StateDatabaseBlockedError());
    };
  });
  databasePromise = opening.catch((error: unknown) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('State transaction failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('State transaction was aborted.'));
  });
}

async function readPersistentRecord<T>(
  store: StateStoreName,
  key: IDBValidKey,
): Promise<T | undefined> {
  const database = await openDatabase();
  return new Promise<T | undefined>((resolve, reject) => {
    const transaction = database.transaction(store, 'readonly');
    const request = transaction.objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () =>
      reject(request.error ?? new Error('State read failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('State read was aborted.'));
  });
}

async function commitPersistentChanges(
  changes: readonly StateStorageChange[],
): Promise<void> {
  if (changes.length === 0) return;
  const database = await openDatabase();
  const storeNames = [...new Set(changes.map((change) => change.store))];
  const transaction = database.transaction(storeNames, 'readwrite');
  for (const change of changes) {
    const store = transaction.objectStore(change.store);
    if (change.type === 'put') {
      store.put(change.value, change.key);
    } else if (change.type === 'delete') {
      store.delete(change.key);
    } else {
      store.clear();
    }
  }
  await transactionComplete(transaction);
}

function commitMemoryChanges(changes: readonly StateStorageChange[]): void {
  for (const change of changes) {
    const store = memoryStores[change.store];
    if (change.type === 'put') {
      store.set(change.key, structuredClone(change.value));
    } else if (change.type === 'delete') {
      store.delete(change.key);
    } else {
      store.clear();
    }
  }
}

function mirrorCommittedManifests(
  changes: readonly StateStorageChange[],
): void {
  for (const change of changes) {
    if (
      change.type !== 'put' ||
      change.store !== STATE_METADATA_STORE
    ) {
      continue;
    }
    try {
      if (
        change.key === SORTER_MANIFEST_RECORD &&
        isLegacySorterManifest(change.value)
      ) {
        localStorage.setItem(
          SORTER_MANIFEST_BACKUP_KEY,
          JSON.stringify(change.value),
        );
      } else if (
        change.key === BUMP_MANIFEST_RECORD &&
        isLegacyBumpChartManifest(change.value)
      ) {
        localStorage.setItem(
          BUMP_MANIFEST_BACKUP_KEY,
          JSON.stringify(change.value),
        );
      }
    } catch {
      // IndexedDB is authoritative; the cross-storage mirror is best effort.
    }
  }
}

function parseLocalJson(key: string): unknown | undefined {
  const raw = localStorage.getItem(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function collectLegacyChanges(): {
  changes: StateStorageChange[];
  activeSorterId: string | null;
  cleanupKeys: string[];
} {
  const changes: StateStorageChange[] = [];
  const cleanupKeys: string[] = [];
  let activeSorterId: string | null = null;

  const sorterManifest = parseLocalJson(LEGACY_SORTER_MANIFEST_KEY);
  if (isLegacySorterManifest(sorterManifest)) {
    const activeId = (sorterManifest as { activeId?: unknown }).activeId;
    activeSorterId = typeof activeId === 'string' ? activeId : null;
    changes.push({
      type: 'put',
      store: STATE_METADATA_STORE,
      key: SORTER_MANIFEST_RECORD,
      value: sorterManifest,
    });
    for (const slot of sorterManifest.slots) {
      if (!isSorterSlotMeta(slot)) continue;
      changes.push({
        type: 'put',
        store: STATE_METADATA_STORE,
        key: `${SORTER_SLOT_META_PREFIX}${slot.id}`,
        value: slot,
      });
    }
    cleanupKeys.push(LEGACY_SORTER_MANIFEST_KEY);
  }

  const legacySingle = parseLocalJson(LEGACY_SORTER_KEY);
  if (isLegacySorterSaveFile(legacySingle)) {
    changes.push({
      type: 'put',
      store: STATE_METADATA_STORE,
      key: LEGACY_SORTER_SINGLE_RECORD,
      value: legacySingle,
    });
    cleanupKeys.push(LEGACY_SORTER_KEY);
  }

  const bumpActive = parseLocalJson(LEGACY_BUMP_ACTIVE_KEY);
  if (isLegacyBumpChartWorkspace(bumpActive)) {
    changes.push({
      type: 'put',
      store: BUMP_WORKSPACE_STORE,
      key: 'active',
      value: bumpActive,
    });
    cleanupKeys.push(LEGACY_BUMP_ACTIVE_KEY);
  }

  const bumpManifest = parseLocalJson(LEGACY_BUMP_MANIFEST_KEY);
  if (isLegacyBumpChartManifest(bumpManifest)) {
    changes.push({
      type: 'put',
      store: STATE_METADATA_STORE,
      key: BUMP_MANIFEST_RECORD,
      value: bumpManifest,
    });
    for (const slot of bumpManifest.slots) {
      if (!isBumpChartMeta(slot)) continue;
      changes.push({
        type: 'put',
        store: STATE_METADATA_STORE,
        key: `${BUMP_WORKSPACE_META_PREFIX}${slot.id}`,
        value: slot,
      });
    }
    cleanupKeys.push(LEGACY_BUMP_MANIFEST_KEY);
  }

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key) continue;
    const sorterMatch = key.match(/^sorter:slot:([^:]+):v1$/);
    if (sorterMatch) {
      const value = parseLocalJson(key);
      if (isLegacySorterSaveFile(value)) {
        changes.push({
          type: 'put',
          store: SORTER_SLOT_STORE,
          key: sorterMatch[1],
          value,
        });
        cleanupKeys.push(key, `sorter:slot:${sorterMatch[1]}:writer:v1`);
      }
      continue;
    }
    if (key.startsWith(LEGACY_BUMP_SLOT_PREFIX)) {
      const value = parseLocalJson(key);
      if (isLegacySavedBumpChartRecord(value)) {
        changes.push({
          type: 'put',
          store: BUMP_WORKSPACE_STORE,
          key: key.slice(LEGACY_BUMP_SLOT_PREFIX.length),
          value,
        });
        cleanupKeys.push(key);
      }
    }
  }

  return { changes, activeSorterId, cleanupKeys };
}

function finishLegacyCleanup(
  activeSorterId: string | null,
  cleanupKeys: readonly string[],
): void {
  if (activeSorterId) {
    localStorage.setItem(ACTIVE_SORTER_SLOT_KEY, activeSorterId);
  }
  localStorage.setItem(STATE_SCHEMA_KEY, '1');
  for (const key of cleanupKeys) {
    localStorage.removeItem(key);
  }
}

async function migrateLegacyPayloads(): Promise<void> {
  const legacy = collectLegacyChanges();
  const alreadyImported = await readPersistentRecord<boolean>(
    STATE_METADATA_STORE,
    LEGACY_IMPORTED_KEY,
  );
  if (!alreadyImported) {
    await commitPersistentChanges([
      ...legacy.changes,
      {
        type: 'put',
        store: STATE_METADATA_STORE,
        key: LEGACY_IMPORTED_KEY,
        value: true,
      },
    ]);
    mirrorCommittedManifests(legacy.changes);
  }
  finishLegacyCleanup(legacy.activeSorterId, legacy.cleanupKeys);
}

function hydrateLegacyMemoryFallback(): void {
  const legacy = collectLegacyChanges();
  commitMemoryChanges(legacy.changes);
  const activeId =
    legacy.activeSorterId ?? localStorage.getItem(ACTIVE_SORTER_SLOT_KEY);
  if (activeId) {
    localStorage.setItem(ACTIVE_SORTER_SLOT_KEY, activeId);
  }
}

export async function initializeStateStorage(): Promise<StateStorageStatus> {
  if (initializationPromise) {
    return initializationPromise;
  }
  initializationPromise = (async () => {
    try {
      let openError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await openDatabase();
          openError = undefined;
          break;
        } catch (error) {
          openError = error;
          if (!(error instanceof StateDatabaseBlockedError) || attempt === 2) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
        }
      }
      if (openError) throw openError;
      await migrateLegacyPayloads();
      memoryOnly = false;
      storageError = null;
    } catch (error) {
      memoryOnly = true;
      storageError = errorMessage(error);
      hydrateLegacyMemoryFallback();
    }
    return { persistent: !memoryOnly, error: storageError };
  })();
  return initializationPromise;
}

export function getStateStorageStatus(): StateStorageStatus {
  return { persistent: !memoryOnly, error: storageError };
}

export async function readStateRecord<T>(
  store: StateStoreName,
  key: IDBValidKey,
): Promise<T | undefined> {
  await initializeStateStorage();
  if (memoryOnly) {
    const value = memoryStores[store].get(key);
    return value === undefined ? undefined : structuredClone(value as T);
  }
  return readPersistentRecord<T>(store, key);
}

export async function readAllStateEntries<T>(
  store: StateStoreName,
): Promise<Array<[IDBValidKey, T]>> {
  await initializeStateStorage();
  if (memoryOnly) {
    return [...memoryStores[store].entries()].map(([key, value]) => [
      key,
      structuredClone(value as T),
    ]);
  }
  const database = await openDatabase();
  return new Promise<Array<[IDBValidKey, T]>>((resolve, reject) => {
    const transaction = database.transaction(store, 'readonly');
    const objectStore = transaction.objectStore(store);
    const keysRequest = objectStore.getAllKeys();
    const valuesRequest = objectStore.getAll();
    transaction.oncomplete = () => {
      resolve(
        keysRequest.result.map((key, index) => [
          key,
          valuesRequest.result[index] as T,
        ]),
      );
    };
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('State list failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('State list was aborted.'));
  });
}

export async function commitStateChanges(
  changes: readonly StateStorageChange[],
  revision?: { scope: 'sorter' | 'bump'; id?: string },
): Promise<void> {
  await initializeStateStorage();
  const injectedError = commitErrorsForTesting.shift();
  if (injectedError) {
    throw injectedError;
  }
  if (memoryOnly) {
    commitMemoryChanges(changes);
    return;
  }
  await commitPersistentChanges(changes);
  mirrorCommittedManifests(changes);
  if (revision) {
    revisionSequence += 1;
    try {
      localStorage.setItem(
        STATE_REVISION_KEY,
        JSON.stringify({
          ...revision,
          source: getStateWriterId(),
          revision: `${Date.now()}:${revisionSequence}`,
        }),
      );
    } catch {
      // The durable transaction succeeded; a missed cross-tab hint is safer
      // than reporting the persisted user data as failed.
    }
  }
}

let commitErrorsForTesting: unknown[] = [];

export function _setStateStorageCommitErrorsForTesting(
  errors: readonly unknown[],
): void {
  commitErrorsForTesting = [...errors];
}

export function getStateWriterId(): string {
  const key = 'sorter:state-writer-id:v1';
  try {
    let value = sessionStorage.getItem(key);
    if (!value) {
      value =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(key, value);
    }
    return value;
  } catch {
    return 'unknown';
  }
}

export async function _resetStateStorageForTesting(): Promise<void> {
  await _restartStateStorageForTesting();
  const database = await databasePromise?.catch(() => null);
  database?.close();
  databasePromise = null;
  if (typeof indexedDB !== 'undefined') {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(DATABASE_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }
}

export async function _restartStateStorageForTesting(): Promise<void> {
  const database = await databasePromise?.catch(() => null);
  database?.close();
  databasePromise = null;
  initializationPromise = null;
  memoryOnly = false;
  storageError = null;
  revisionSequence = 0;
  commitErrorsForTesting = [];
  for (const store of Object.values(memoryStores)) {
    store.clear();
  }
}

export const stateStorageRecordKeys = {
  sorterManifest: SORTER_MANIFEST_RECORD,
  sorterPreviousManifest: SORTER_PREVIOUS_MANIFEST_RECORD,
  sorterCorruptManifest: SORTER_CORRUPT_MANIFEST_RECORD,
  sorterSlotMeta: (id: string) => `${SORTER_SLOT_META_PREFIX}${id}`,
  bumpManifest: BUMP_MANIFEST_RECORD,
  bumpPreviousManifest: BUMP_PREVIOUS_MANIFEST_RECORD,
  bumpCorruptManifest: BUMP_CORRUPT_MANIFEST_RECORD,
  bumpWorkspaceMeta: (id: string) => `${BUMP_WORKSPACE_META_PREFIX}${id}`,
  legacySorterSingle: LEGACY_SORTER_SINGLE_RECORD,
} as const;
