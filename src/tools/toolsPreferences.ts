/**
 * Global, persisted preferences for the Anime Tools surface (separate from
 * per-panel forms). Modeled on `displayPreferences.ts` — a tiny in-memory cache
 * with a pub/sub for cross-component reactivity and cross-tab sync via the
 * `storage` event.
 */

export type ToolsPreferences = {
  /**
   * When true, the Shared Staff compare chart lists every production credit
   * (Storyboard, Production Assistant, etc). When false (default), only the
   * core production roles defined in `staffRoleFilter#isKeyProductionRole`
   * are kept — matching the "key roles" default used by A2A.
   */
  productionAllRoles: boolean;
};

const STORAGE_KEY = 'anime-tools:preferences:v1';

const DEFAULT_PREFS: ToolsPreferences = {
  productionAllRoles: false,
};

let cached: ToolsPreferences | null = null;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

// Cross-tab sync: another tab writing the same key fires `storage` here
// (never in the tab that wrote it). Drop the cache so the next read re-parses,
// then notify subscribers. Guarded for non-browser (test/SSR) environments.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) {
      return;
    }
    cached = null;
    emitChange();
  });
}

export function loadToolsPreferences(): ToolsPreferences {
  if (cached) {
    return cached;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cached = { ...DEFAULT_PREFS };
      return cached;
    }
    const parsed = JSON.parse(raw) as Partial<ToolsPreferences>;
    cached = {
      productionAllRoles: parsed.productionAllRoles === true,
    };
    return cached;
  } catch {
    cached = { ...DEFAULT_PREFS };
    return cached;
  }
}

export function saveToolsPreferences(patch: Partial<ToolsPreferences>): ToolsPreferences {
  const next = { ...loadToolsPreferences(), ...patch };
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  emitChange();
  return next;
}

export function getProductionAllRoles(): boolean {
  return loadToolsPreferences().productionAllRoles;
}

export function subscribeToolsPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset. */
export function _clearToolsPreferencesForTesting(): void {
  cached = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
