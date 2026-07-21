/**
 * In-memory memo for live AniList lookups within a browser session.
 * Cleared on page reload — not persisted to IndexedDB or localStorage.
 */

import type { ToolsFetchOptions } from './toolsFetchPolicy';

export const TOOLS_SESSION_TTL_MS = 15 * 60 * 1000;

/** @deprecated Use {@link TOOLS_SESSION_TTL_MS}. */
export const FAVOURITES_SESSION_TTL_MS = TOOLS_SESSION_TTL_MS;

type TtlEntry = {
  value: unknown;
  expiresAt: number;
};

const store = new Map<string, unknown>();
const ttlStore = new Map<string, TtlEntry>();
const inflight = new Map<string, Promise<unknown>>();

export function sessionMemoDelete(key: string): void {
  store.delete(key);
  ttlStore.delete(key);
  inflight.delete(key);
}

/** Delete every memo entry whose key starts with `prefix`. */
export function sessionMemoDeletePrefix(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      sessionMemoDelete(key);
    }
  }
  for (const key of ttlStore.keys()) {
    if (key.startsWith(prefix)) {
      sessionMemoDelete(key);
    }
  }
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) {
      sessionMemoDelete(key);
    }
  }
}

/** Test-only: wipe all memoized entries. */
export function _clearSessionMemoForTesting(): void {
  store.clear();
  ttlStore.clear();
  inflight.clear();
}

/** Session-scoped read-through memo for async tool fetchers. */
export async function withSessionMemo<T>(
  key: string,
  fetcher: () => Promise<T>,
  options?: ToolsFetchOptions,
): Promise<T> {
  if (options?.forceRefresh) {
    sessionMemoDelete(key);
  }
  if (store.has(key)) {
    return store.get(key) as T;
  }
  const pending = inflight.get(key);
  if (pending) {
    return pending as Promise<T>;
  }
  const promise = fetcher()
    .then((value) => {
      store.set(key, value);
      inflight.delete(key);
      return value;
    })
    .catch((err) => {
      inflight.delete(key);
      throw err;
    });
  inflight.set(key, promise);
  return promise;
}

export type SessionTtlMemoOptions = {
  bust?: boolean;
};

/** Session memo with a TTL — used for favourites list reads during Analyze. */
export async function withSessionTtlMemo<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  options?: SessionTtlMemoOptions,
): Promise<T> {
  if (options?.bust) {
    sessionMemoDelete(key);
  }
  const cached = ttlStore.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value as T;
  }
  if (cached) {
    ttlStore.delete(key);
  }
  const pending = inflight.get(key);
  if (pending) {
    return pending as Promise<T>;
  }
  const promise = fetcher()
    .then((value) => {
      ttlStore.set(key, { value, expiresAt: Date.now() + ttlMs });
      inflight.delete(key);
      return value;
    })
    .catch((err) => {
      inflight.delete(key);
      throw err;
    });
  inflight.set(key, promise);
  return promise;
}
