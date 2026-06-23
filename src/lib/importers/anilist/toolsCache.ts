/**
 * IndexedDB-backed TTL cache for Tools live AniList fetches — mirrors the CLI
 * `.cache/*.json` memoization in anilisttools. Falls back to localStorage when
 * IndexedDB is unavailable.
 */

const DB_NAME = 'sorter-tools-cache';
const STORE_NAME = 'entries';
const DB_VERSION = 1;
const LS_PREFIX = 'sorter-tools-cache:';

/** TTLs matching anilisttools `@cache(..., max_age=…)`. */
export const TOOLS_CACHE_TTL_MS = {
  staffRoles: 30 * 24 * 60 * 60 * 1000,
  staffSearch: 60 * 24 * 60 * 60 * 1000,
  characterVa: 90 * 24 * 60 * 60 * 1000,
  userList: 15 * 60 * 1000,
  showMetadata: 30 * 24 * 60 * 60 * 1000,
} as const;

type CacheRecord = {
  value: string;
  expiresAt: number;
};

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => resolve(null);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
    });
  }
  return dbPromise;
}

function lsGet(key: string): CacheRecord | null {
  try {
    const raw = localStorage.getItem(`${LS_PREFIX}${key}`);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as CacheRecord;
  } catch {
    return null;
  }
}

function lsSet(key: string, record: CacheRecord): void {
  try {
    localStorage.setItem(`${LS_PREFIX}${key}`, JSON.stringify(record));
  } catch {
    /* quota — ignore */
  }
}

function lsDelete(key: string): void {
  try {
    localStorage.removeItem(`${LS_PREFIX}${key}`);
  } catch {
    /* ignore */
  }
}

async function idbGet(key: string): Promise<CacheRecord | null> {
  const db = await openDb();
  if (!db) {
    return lsGet(key);
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve((req.result as CacheRecord | undefined) ?? null);
    req.onerror = () => resolve(lsGet(key));
  });
}

async function idbSet(key: string, record: CacheRecord): Promise<void> {
  const db = await openDb();
  if (!db) {
    lsSet(key, record);
    return;
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      lsSet(key, record);
      resolve();
    };
    tx.objectStore(STORE_NAME).put(record, key);
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    lsDelete(key);
    return;
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      lsDelete(key);
      resolve();
    };
    tx.objectStore(STORE_NAME).delete(key);
  });
}

export async function toolsCacheGet<T>(key: string): Promise<T | null> {
  const record = await idbGet(key);
  if (!record) {
    return null;
  }
  if (record.expiresAt <= Date.now()) {
    await idbDelete(key);
    return null;
  }
  try {
    return JSON.parse(record.value) as T;
  } catch {
    await idbDelete(key);
    return null;
  }
}

export async function toolsCacheSet<T>(
  key: string,
  value: T,
  maxAgeMs: number,
): Promise<void> {
  const record: CacheRecord = {
    value: JSON.stringify(value),
    expiresAt: Date.now() + maxAgeMs,
  };
  await idbSet(key, record);
}

export async function toolsCacheDelete(key: string): Promise<void> {
  await idbDelete(key);
}

export type ToolsCacheOptions = {
  forceRefresh?: boolean;
};

/** Read-through cache wrapper for async tool fetchers. */
export async function withToolsCache<T>(
  key: string,
  maxAgeMs: number,
  fetcher: () => Promise<T>,
  options?: ToolsCacheOptions,
): Promise<T> {
  if (options?.forceRefresh) {
    await toolsCacheDelete(key);
  }
  const cached = await toolsCacheGet<T>(key);
  if (cached !== null) {
    return cached;
  }
  const value = await fetcher();
  await toolsCacheSet(key, value, maxAgeMs);
  return value;
}

/** Test-only: wipe all cached entries. */
export async function _clearToolsCacheForTesting(): Promise<void> {
  const db = await openDb();
  if (db) {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.objectStore(STORE_NAME).clear();
    });
  }
  if (typeof localStorage !== 'undefined') {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k?.startsWith(LS_PREFIX)) {
        toRemove.push(k);
      }
    }
    for (const k of toRemove) {
      localStorage.removeItem(k);
    }
  }
  dbPromise = null;
}
