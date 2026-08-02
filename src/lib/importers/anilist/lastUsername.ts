/**
 * Last successfully used AniList username. Every successful shared-runner
 * import updates it: anime lists, manga lists, and all favourite types
 * (anime, manga, characters, staff, and studios), regardless of whether the
 * import was started from Sorter, A2A, or a Tools panel. Successful cache-only
 * Start/A2A selections and Adaptation Scores runs also update it. Non-AniList
 * import sources do not. This global value is only the cross-app fallback and
 * last-imported account; each Tools panel persists its own username separately.
 */
export const ANILIST_LAST_USERNAME_LS_KEY = 'anilist:lastUsername';

const lastUsernameListeners = new Set<() => void>();

export function readLastAnilistUsername(): string {
  try {
    return localStorage.getItem(ANILIST_LAST_USERNAME_LS_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeLastAnilistUsername(username: string): void {
  try {
    localStorage.setItem(ANILIST_LAST_USERNAME_LS_KEY, username);
    for (const listener of lastUsernameListeners) {
      listener();
    }
  } catch {
    /* Best-effort — ignore private-mode / quota failures. */
  }
}

export function subscribeLastAnilistUsername(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === ANILIST_LAST_USERNAME_LS_KEY) {
      listener();
    }
  };
  lastUsernameListeners.add(listener);
  window.addEventListener('storage', onStorage);
  return () => {
    lastUsernameListeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** Use a saved form username, or fall back to the last explicitly remembered username. */
export function withLastAnilistUsername(username: string): string {
  return username.trim() || readLastAnilistUsername();
}
