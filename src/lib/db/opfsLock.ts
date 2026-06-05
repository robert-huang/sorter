/** Cross-tab Web Lock coordinating exclusive OPFS access (`client.ts`). */
export const OPFS_LOCK_NAME = 'sorter-opfs';

export const OPFS_LOCK_ACQUIRE_TIMEOUT_MS = 3000;

/** True when another browsing context on this origin already holds {@link OPFS_LOCK_NAME}. */
export async function queryIsOpfsLockHeld(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.locks?.query) {
    return false;
  }
  try {
    const state = await navigator.locks.query();
    return (state.held ?? []).some((lock) => lock.name === OPFS_LOCK_NAME);
  } catch {
    return false;
  }
}
