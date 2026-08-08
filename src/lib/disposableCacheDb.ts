const DATABASE_NAME = 'queue-sorter-disposable-cache';
const DATABASE_VERSION = 1;
const ENTRY_STORE = 'entries';
const NAMESPACE_INDEX = 'namespace';

export type DisposableCacheEntry<T = unknown> = {
  id: string;
  namespace: string;
  key: string;
  value: T;
  expiresAt: number | null;
  lastUsedAt: number;
  byteLength: number;
};

export type DisposableCacheReadResult<T> =
  | { hit: true; value: T }
  | { hit: false };

export type DisposableCacheStats = {
  entries: number;
  bytes: number;
};

export type DisposableCacheWriteOptions = {
  expiresAt?: number | null;
  byteLength?: number;
};

export type DisposableCacheBudget = {
  maxEntries: number;
  maxBytes: number;
  retainKeys?: ReadonlySet<string>;
};

let databasePromise: Promise<IDBDatabase> | null = null;

function entryId(namespace: string, key: string): string {
  return `${namespace}\u0000${key}`;
}

function estimateValueBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized == null
      ? 0
      : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return 0;
  }
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
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ENTRY_STORE)) {
        const store = database.createObjectStore(ENTRY_STORE, {
          keyPath: 'id',
        });
        store.createIndex(NAMESPACE_INDEX, 'namespace', { unique: false });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to open disposable cache.'));
    request.onblocked = () =>
      reject(new Error('Disposable cache database upgrade is blocked.'));
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
      reject(transaction.error ?? new Error('Disposable cache transaction failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Disposable cache transaction aborted.'));
  });
}

async function readEntry<T>(
  namespace: string,
  key: string,
): Promise<DisposableCacheEntry<T> | null> {
  const database = await openDatabase();
  return new Promise<DisposableCacheEntry<T> | null>((resolve, reject) => {
    const transaction = database.transaction(ENTRY_STORE, 'readonly');
    const request = transaction
      .objectStore(ENTRY_STORE)
      .get(entryId(namespace, key));
    request.onsuccess = () =>
      resolve((request.result as DisposableCacheEntry<T> | undefined) ?? null);
    request.onerror = () =>
      reject(request.error ?? new Error('Disposable cache read failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Disposable cache read aborted.'));
  });
}

async function touchEntry(namespace: string, key: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(ENTRY_STORE, 'readwrite');
  const store = transaction.objectStore(ENTRY_STORE);
  const request = store.get(entryId(namespace, key));
  request.onsuccess = () => {
    const entry = request.result as DisposableCacheEntry | undefined;
    if (entry) {
      store.put({ ...entry, lastUsedAt: Date.now() });
    }
  };
  await transactionComplete(transaction);
}

export async function readDisposableCache<T>(
  namespace: string,
  key: string,
): Promise<DisposableCacheReadResult<T>> {
  try {
    const entry = await readEntry<T>(namespace, key);
    if (!entry) {
      return { hit: false };
    }
    if (entry.expiresAt != null && Date.now() >= entry.expiresAt) {
      await deleteDisposableCacheEntry(namespace, key);
      return { hit: false };
    }
    if (Date.now() - entry.lastUsedAt >= 60_000) {
      void touchEntry(namespace, key).catch(() => {});
    }
    return { hit: true, value: entry.value };
  } catch {
    return { hit: false };
  }
}

export async function putDisposableCache<T>(
  namespace: string,
  key: string,
  value: T,
  options: DisposableCacheWriteOptions = {},
): Promise<boolean> {
  try {
    const database = await openDatabase();
    const transaction = database.transaction(ENTRY_STORE, 'readwrite');
    const now = Date.now();
    const entry: DisposableCacheEntry<T> = {
      id: entryId(namespace, key),
      namespace,
      key,
      value,
      expiresAt: options.expiresAt ?? null,
      lastUsedAt: now,
      byteLength: options.byteLength ?? estimateValueBytes(value),
    };
    transaction.objectStore(ENTRY_STORE).put(entry);
    await transactionComplete(transaction);
    return true;
  } catch {
    return false;
  }
}

export async function deleteDisposableCacheEntry(
  namespace: string,
  key: string,
): Promise<void> {
  try {
    await deleteDisposableCacheEntries(namespace, [key]);
  } catch {
    // Disposable persistence is best-effort.
  }
}

async function listDisposableCacheEntriesStrict<T = unknown>(
  namespace: string,
): Promise<Array<DisposableCacheEntry<T>>> {
  const database = await openDatabase();
  return new Promise<Array<DisposableCacheEntry<T>>>((resolve, reject) => {
    const transaction = database.transaction(ENTRY_STORE, 'readonly');
    const request = transaction
      .objectStore(ENTRY_STORE)
      .index(NAMESPACE_INDEX)
      .getAll(namespace);
    request.onsuccess = () =>
      resolve(request.result as Array<DisposableCacheEntry<T>>);
    request.onerror = () =>
      reject(request.error ?? new Error('Disposable cache listing failed.'));
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error('Disposable cache listing aborted.'),
      );
  });
}

export async function listDisposableCacheEntries<T = unknown>(
  namespace: string,
): Promise<Array<DisposableCacheEntry<T>>> {
  try {
    return await listDisposableCacheEntriesStrict<T>(namespace);
  } catch {
    return [];
  }
}

export async function deleteDisposableCacheEntries(
  namespace: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  const database = await openDatabase();
  const transaction = database.transaction(ENTRY_STORE, 'readwrite');
  const store = transaction.objectStore(ENTRY_STORE);
  for (const key of keys) {
    store.delete(entryId(namespace, key));
  }
  await transactionComplete(transaction);
}

export async function clearDisposableCacheNamespace(
  namespace: string,
): Promise<void> {
  const entries = await listDisposableCacheEntriesStrict(namespace);
  if (entries.length === 0) {
    return;
  }
  await deleteDisposableCacheEntries(
    namespace,
    entries.map((entry) => entry.key),
  );
}

export async function deleteDisposableCachePrefix(
  namespace: string,
  prefix: string,
): Promise<void> {
  const entries = await listDisposableCacheEntries(namespace);
  const matching = entries.filter((entry) => entry.key.startsWith(prefix));
  if (matching.length === 0) {
    return;
  }
  try {
    const database = await openDatabase();
    const transaction = database.transaction(ENTRY_STORE, 'readwrite');
    const store = transaction.objectStore(ENTRY_STORE);
    for (const entry of matching) {
      store.delete(entry.id);
    }
    await transactionComplete(transaction);
  } catch {
    // Disposable persistence is best-effort.
  }
}

export async function sweepExpiredDisposableCache(
  namespace?: string,
): Promise<number> {
  const namespaces = namespace
    ? [namespace]
    : [
        ...new Set(
          (await listAllDisposableCacheEntries()).map((entry) => entry.namespace),
        ),
      ];
  let removed = 0;
  for (const currentNamespace of namespaces) {
    const entries = await listDisposableCacheEntries(currentNamespace);
    const expired = entries.filter(
      (entry) => entry.expiresAt != null && Date.now() >= entry.expiresAt,
    );
    for (const entry of expired) {
      await deleteDisposableCacheEntry(entry.namespace, entry.key);
      removed += 1;
    }
  }
  return removed;
}

async function listAllDisposableCacheEntries(): Promise<DisposableCacheEntry[]> {
  try {
    const database = await openDatabase();
    return await new Promise<DisposableCacheEntry[]>((resolve, reject) => {
      const transaction = database.transaction(ENTRY_STORE, 'readonly');
      const request = transaction.objectStore(ENTRY_STORE).getAll();
      request.onsuccess = () =>
        resolve(request.result as DisposableCacheEntry[]);
      request.onerror = () =>
        reject(request.error ?? new Error('Disposable cache listing failed.'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Disposable cache listing aborted.'));
    });
  } catch {
    return [];
  }
}

export async function getDisposableCacheStats(
  namespace: string,
): Promise<DisposableCacheStats> {
  const entries = await listDisposableCacheEntries(namespace);
  return {
    entries: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
  };
}

export async function enforceDisposableCacheBudget(
  namespace: string,
  budget: DisposableCacheBudget,
): Promise<string[]> {
  const entries = (await listDisposableCacheEntries(namespace)).sort(
    (left, right) => left.lastUsedAt - right.lastUsedAt,
  );
  let count = entries.length;
  let bytes = entries.reduce((total, entry) => total + entry.byteLength, 0);
  const removed: string[] = [];

  for (const entry of entries) {
    if (count <= budget.maxEntries && bytes <= budget.maxBytes) {
      break;
    }
    if (budget.retainKeys?.has(entry.key)) {
      continue;
    }
    await deleteDisposableCacheEntry(namespace, entry.key);
    count -= 1;
    bytes -= entry.byteLength;
    removed.push(entry.key);
  }
  return removed;
}

export async function deleteOldestDisposableCacheFraction(
  namespace: string,
  fraction: number,
  retainKeys?: ReadonlySet<string>,
): Promise<string[]> {
  const entries = (await listDisposableCacheEntries(namespace))
    .filter((entry) => !retainKeys?.has(entry.key))
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  const count = Math.max(1, Math.ceil(entries.length * fraction));
  const removed: string[] = [];
  for (const entry of entries.slice(0, count)) {
    await deleteDisposableCacheEntry(namespace, entry.key);
    removed.push(entry.key);
  }
  return removed;
}

export async function getAllDisposableCacheStats(): Promise<
  Record<string, DisposableCacheStats>
> {
  const entries = await listAllDisposableCacheEntries();
  const stats: Record<string, DisposableCacheStats> = {};
  for (const entry of entries) {
    const current = stats[entry.namespace] ?? { entries: 0, bytes: 0 };
    current.entries += 1;
    current.bytes += entry.byteLength;
    stats[entry.namespace] = current;
  }
  return stats;
}

/** Test-only connection and database reset. */
export async function _resetDisposableCacheDbForTesting(): Promise<void> {
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
