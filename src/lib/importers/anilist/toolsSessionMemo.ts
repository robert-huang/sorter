/**
 * In-memory memo for live AniList lookups within a browser session.
 * Cleared on page reload — not persisted to IndexedDB or localStorage.
 */

import type { ToolsFetchOptions } from './toolsFetchPolicy';

const store = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

export function sessionMemoDelete(key: string): void {
  store.delete(key);
  inflight.delete(key);
}

/** Test-only: wipe all memoized entries. */
export function _clearSessionMemoForTesting(): void {
  store.clear();
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
