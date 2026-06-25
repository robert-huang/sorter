/**
 * localStorage-backed cross-session cache for tool fetchers. Used by
 * Franchise Scores to keep AniList relation graphs warm across sessions
 * (relations are stable — a 90d TTL avoids hammering AniList every visit).
 *
 * Layered with {@link withSessionTtlMemo}: that layer handles in-memory
 * dedup of concurrent calls within a single session and avoids
 * re-parsing JSON on every hit. This file handles the cross-session
 * persistence — its read is hit only on the FIRST request per key per
 * session (after which session memo serves the value directly).
 *
 * Storage is JSON-only (no Date / function values). Failures are
 * swallowed: a quota / security failure just means the value isn't
 * persisted — the session memo still serves it for the rest of the
 * tab's life.
 */

import { isAutosaveAvailable } from '../../storage';

const KEY_PREFIX = 'tools-cache:';

type StoredEntry<T> = {
  value: T;
  expiresAt: number;
};

function fullKey(key: string): string {
  return `${KEY_PREFIX}${key}`;
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
export function persistentCacheGet<T>(
  key: string,
): { hit: true; value: T } | { hit: false } {
  if (!isAutosaveAvailable()) return { hit: false };
  try {
    const raw = window.localStorage.getItem(fullKey(key));
    if (!raw) return { hit: false };
    const entry = JSON.parse(raw) as StoredEntry<T>;
    if (!entry || typeof entry.expiresAt !== 'number') {
      return { hit: false };
    }
    if (Date.now() >= entry.expiresAt) {
      window.localStorage.removeItem(fullKey(key));
      return { hit: false };
    }
    return { hit: true, value: entry.value };
  } catch {
    return { hit: false };
  }
}

export function persistentCacheSet<T>(
  key: string,
  value: T,
  ttlMs: number,
): void {
  if (!isAutosaveAvailable()) return;
  const entry: StoredEntry<T> = {
    value,
    expiresAt: Date.now() + ttlMs,
  };
  const payload = JSON.stringify(entry);
  try {
    window.localStorage.setItem(fullKey(key), payload);
  } catch {
    // Quota / security failure. Prune expired entries under our prefix
    // to make room and retry once. If still failing, swallow: the
    // in-memory session memo keeps serving the value for this tab.
    pruneExpiredEntries();
    try {
      window.localStorage.setItem(fullKey(key), payload);
    } catch {
      /* ignore */
    }
  }
}

export function persistentCacheDelete(key: string): void {
  if (!isAutosaveAvailable()) return;
  try {
    window.localStorage.removeItem(fullKey(key));
  } catch {
    /* ignore */
  }
}

/** Delete every persistent cache entry whose key starts with `prefix`. */
export function persistentCacheDeletePrefix(prefix: string): void {
  if (!isAutosaveAvailable()) return;
  const fullPrefix = fullKey(prefix);
  try {
    const toDelete: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(fullPrefix)) {
        toDelete.push(k);
      }
    }
    for (const k of toDelete) {
      window.localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

function pruneExpiredEntries(): void {
  if (!isAutosaveAvailable()) return;
  try {
    const now = Date.now();
    const toDelete: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k || !k.startsWith(KEY_PREFIX)) continue;
      try {
        const raw = window.localStorage.getItem(k);
        if (!raw) continue;
        const entry = JSON.parse(raw) as StoredEntry<unknown>;
        if (
          !entry ||
          typeof entry.expiresAt !== 'number' ||
          entry.expiresAt < now
        ) {
          toDelete.push(k);
        }
      } catch {
        toDelete.push(k);
      }
    }
    for (const k of toDelete) {
      window.localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
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
    persistentCacheDelete(key);
  } else {
    const hit = persistentCacheGet<T>(key);
    if (hit.hit) {
      return hit.value;
    }
  }
  const value = await fetcher();
  persistentCacheSet(key, value, ttlMs);
  return value;
}
