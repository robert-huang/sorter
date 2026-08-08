/**
 * IndexedDB-backed cross-session cache for tool fetchers.
 *
 * Layered with {@link withSessionTtlMemo}: that layer handles in-memory
 * dedup of concurrent calls within a single session. This file handles
 * best-effort persistence across reloads.
 */

import {
  clearDisposableCacheNamespace,
  deleteDisposableCacheEntry,
  deleteDisposableCachePrefix,
  getDisposableCacheStats,
  listDisposableCacheEntries,
  putDisposableCache,
  readDisposableCache,
  sweepExpiredDisposableCache,
} from '../../disposableCacheDb';
import { registerDisposableCacheOwner } from '../../disposableCacheRegistry';
import { sessionMemoDeletePrefix } from './toolsSessionMemo';

const LEGACY_KEY_PREFIX = 'tools-cache:';
export const TOOLS_PERSISTENT_CACHE_NAMESPACE = 'tools-api';

type StoredEntry<T> = {
  value: T;
  expiresAt: number;
};

let migrationPromise: Promise<void> | null = null;
const sessionDeletedKeys = new Set<string>();
let cacheGeneration = 0;

function legacyKey(key: string): string {
  return `${LEGACY_KEY_PREFIX}${key}`;
}

function listLegacyKeys(): string[] {
  if (typeof localStorage === 'undefined') {
    return [];
  }
  const keys: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(LEGACY_KEY_PREFIX)) {
        keys.push(key);
      }
    }
  } catch {
    return [];
  }
  return keys;
}

async function migrateLegacyLocalStorage(): Promise<void> {
  if (migrationPromise) {
    return migrationPromise;
  }
  migrationPromise = (async () => {
    for (const fullKey of listLegacyKeys()) {
      let entry: StoredEntry<unknown> | null = null;
      try {
        const raw = localStorage.getItem(fullKey);
        entry = raw ? (JSON.parse(raw) as StoredEntry<unknown>) : null;
      } catch {
        // Corrupt disposable cache records are safe to remove.
      }
      if (
        !entry ||
        typeof entry.expiresAt !== 'number' ||
        Date.now() >= entry.expiresAt
      ) {
        try {
          localStorage.removeItem(fullKey);
        } catch {
          // Best-effort migration cleanup.
        }
        continue;
      }

      const key = fullKey.slice(LEGACY_KEY_PREFIX.length);
      const persisted = await putDisposableCache(
        TOOLS_PERSISTENT_CACHE_NAMESPACE,
        key,
        entry.value,
        { expiresAt: entry.expiresAt },
      );
      if (persisted) {
        try {
          localStorage.removeItem(fullKey);
        } catch {
          // A duplicate legacy cache is harmless and retried next session.
        }
      }
    }
  })().catch(() => {
    migrationPromise = null;
  });
  return migrationPromise;
}

/**
 * Return `{ hit: true, value }` when the entry exists and hasn't expired,
 * else `{ hit: false }`. Stale entries are evicted as a side effect.
 *
 * Returns an explicit discriminated union (not `T | null`) so callers can
 * cache a literal `null` value as a real hit — important for fetchers
 * that legitimately resolve to null (e.g. "this AniList id doesn't
 * exist") and shouldn't re-hit the network on every lookup.
 */
export async function persistentCacheGet<T>(
  key: string,
): Promise<{ hit: true; value: T } | { hit: false }> {
  if (sessionDeletedKeys.has(key)) {
    return { hit: false };
  }
  await migrateLegacyLocalStorage();
  if (sessionDeletedKeys.has(key)) {
    return { hit: false };
  }
  return readDisposableCache<T>(TOOLS_PERSISTENT_CACHE_NAMESPACE, key);
}

export async function persistentCacheSet<T>(
  key: string,
  value: T,
  ttlMs: number,
  expectedGeneration = cacheGeneration,
): Promise<void> {
  await migrateLegacyLocalStorage();
  if (expectedGeneration !== cacheGeneration) {
    return;
  }
  const persisted = await putDisposableCache(
    TOOLS_PERSISTENT_CACHE_NAMESPACE,
    key,
    value,
    {
    expiresAt: Date.now() + ttlMs,
    },
  );
  if (expectedGeneration !== cacheGeneration) {
    await deleteDisposableCacheEntry(TOOLS_PERSISTENT_CACHE_NAMESPACE, key);
    return;
  }
  if (persisted) {
    sessionDeletedKeys.delete(key);
  }
}

export async function persistentCacheDelete(key: string): Promise<void> {
  sessionDeletedKeys.add(key);
  await migrateLegacyLocalStorage();
  await deleteDisposableCacheEntry(TOOLS_PERSISTENT_CACHE_NAMESPACE, key);
  try {
    localStorage.removeItem(legacyKey(key));
  } catch {
    // Best-effort legacy cleanup.
  }
}

/** Delete every persistent cache entry whose key starts with `prefix`. */
export async function persistentCacheDeletePrefix(prefix: string): Promise<void> {
  await migrateLegacyLocalStorage();
  const entries = await listDisposableCacheEntries(
    TOOLS_PERSISTENT_CACHE_NAMESPACE,
  );
  for (const entry of entries) {
    if (entry.key.startsWith(prefix)) {
      sessionDeletedKeys.add(entry.key);
    }
  }
  await deleteDisposableCachePrefix(TOOLS_PERSISTENT_CACHE_NAMESPACE, prefix);
  const fullPrefix = legacyKey(prefix);
  try {
    const toDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(fullPrefix)) {
        toDelete.push(k);
      }
    }
    for (const k of toDelete) {
      localStorage.removeItem(k);
    }
  } catch {
    // Best-effort legacy cleanup.
  }
}

export async function persistentCacheKeys(prefix = ''): Promise<string[]> {
  await migrateLegacyLocalStorage();
  const entries = await listDisposableCacheEntries(
    TOOLS_PERSISTENT_CACHE_NAMESPACE,
  );
  return entries
    .map((entry) => entry.key)
    .filter((key) => key.startsWith(prefix));
}

export async function sweepExpiredPersistentCache(): Promise<number> {
  await migrateLegacyLocalStorage();
  return sweepExpiredDisposableCache(TOOLS_PERSISTENT_CACHE_NAMESPACE);
}

export async function clearPersistentToolsCache(): Promise<void> {
  cacheGeneration += 1;
  await migrateLegacyLocalStorage();
  await clearDisposableCacheNamespace(TOOLS_PERSISTENT_CACHE_NAMESPACE);
  for (const key of listLegacyKeys()) {
    try {
      localStorage.removeItem(key);
    } catch {
      throw new Error('Failed to clear the legacy tools cache.');
    }
  }
  sessionDeletedKeys.clear();
  sessionMemoDeletePrefix('');
}

export function getPersistentToolsCacheGeneration(): number {
  return cacheGeneration;
}

export function _resetPersistentToolsCacheForTesting(): void {
  migrationPromise = null;
  sessionDeletedKeys.clear();
  cacheGeneration = 0;
}

export type PersistentCacheOptions = {
  bust?: boolean;
};

/**
 * Read-through localStorage cache with TTL. On miss (or bust), runs the
 * fetcher and persists the result. On read failure or quota exhaustion,
 * still returns the live result — the cache layer is best-effort.
 */
export async function withPersistentTtlCache<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  options?: PersistentCacheOptions,
): Promise<T> {
  if (options?.bust) {
    await persistentCacheDelete(key);
  } else {
    const hit = await persistentCacheGet<T>(key);
    if (hit.hit) {
      return hit.value;
    }
  }
  const generation = getPersistentToolsCacheGeneration();
  const value = await fetcher();
  await persistentCacheSet(key, value, ttlMs, generation);
  return value;
}

registerDisposableCacheOwner({
  id: 'tools-api',
  label: 'Tools/API cache',
  deletionEffect: 'Tool responses are fetched again from AniList when needed.',
  measure: () => getDisposableCacheStats(TOOLS_PERSISTENT_CACHE_NAMESPACE),
  clear: clearPersistentToolsCache,
  clearUnderPressure: async () => {
    await sweepExpiredPersistentCache();
    await clearPersistentToolsCache();
  },
});
