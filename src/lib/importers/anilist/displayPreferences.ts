/** User-facing title/name display modes for cached AniList data. */

export type MediaTitleDisplayMode = 'native' | 'english' | 'romaji';

export type PersonNameDisplayMode = 'full' | 'native';

export type AnilistDisplayPreferences = {
  mediaTitleMode: MediaTitleDisplayMode;
  personNameMode: PersonNameDisplayMode;
};

const STORAGE_KEY = 'anilist:display-preferences:v1';

export const ANILIST_DISPLAY_PREFS_CHANGED = 'anilist-display-preferences-changed';

const DEFAULT_PREFS: AnilistDisplayPreferences = {
  mediaTitleMode: 'romaji',
  personNameMode: 'full',
};

function normaliseMediaTitleMode(value: unknown): MediaTitleDisplayMode {
  if (value === 'english' || value === 'native') {
    return value;
  }
  return 'romaji';
}

let cachedPrefs: AnilistDisplayPreferences | null = null;

const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(ANILIST_DISPLAY_PREFS_CHANGED));
  }
}

// Cross-tab sync: another tab writing the same key fires a `storage`
// event here (never in the tab that wrote it). Drop our cached copy so
// the next read re-parses localStorage, then notify subscribers so the
// UI relabels. Guarded for non-browser (test/SSR) environments.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) {
      return;
    }
    cachedPrefs = null;
    for (const listener of listeners) {
      listener();
    }
    window.dispatchEvent(new CustomEvent(ANILIST_DISPLAY_PREFS_CHANGED));
  });
}

export function loadAnilistDisplayPreferences(): AnilistDisplayPreferences {
  if (cachedPrefs) {
    return cachedPrefs;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cachedPrefs = { ...DEFAULT_PREFS };
      return cachedPrefs;
    }
    const parsed = JSON.parse(raw) as Partial<AnilistDisplayPreferences>;
    cachedPrefs = {
      mediaTitleMode: normaliseMediaTitleMode(parsed.mediaTitleMode),
      personNameMode: parsed.personNameMode === 'native' ? 'native' : 'full',
    };
    return cachedPrefs;
  } catch {
    cachedPrefs = { ...DEFAULT_PREFS };
    return cachedPrefs;
  }
}

export function saveAnilistDisplayPreferences(
  patch: Partial<AnilistDisplayPreferences>,
): AnilistDisplayPreferences {
  const next = { ...loadAnilistDisplayPreferences(), ...patch };
  cachedPrefs = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  emitChange();
  return next;
}

export function getMediaTitleDisplayMode(): MediaTitleDisplayMode {
  return loadAnilistDisplayPreferences().mediaTitleMode;
}

export function getPersonNameDisplayMode(): PersonNameDisplayMode {
  return loadAnilistDisplayPreferences().personNameMode;
}

export function subscribeAnilistDisplayPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset. */
export function _clearAnilistDisplayPreferencesForTesting(): void {
  cachedPrefs = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
