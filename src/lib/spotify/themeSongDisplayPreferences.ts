/** Theme song title/artist display mode (gear → Spotify section). */

export type ThemeSongNameDisplayMode = 'english' | 'native';

const STORAGE_KEY = 'spotify:theme-song-display:v1';

export const THEME_SONG_DISPLAY_PREFS_CHANGED = 'theme-song-display-preferences-changed';

const DEFAULT_MODE: ThemeSongNameDisplayMode = 'english';

let cachedMode: ThemeSongNameDisplayMode | null = null;

const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(THEME_SONG_DISPLAY_PREFS_CHANGED));
  }
}

function normaliseMode(value: unknown): ThemeSongNameDisplayMode {
  return value === 'native' ? 'native' : 'english';
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) {
      return;
    }
    cachedMode = null;
    for (const listener of listeners) {
      listener();
    }
    window.dispatchEvent(new CustomEvent(THEME_SONG_DISPLAY_PREFS_CHANGED));
  });
}

export function loadThemeSongNameDisplayMode(): ThemeSongNameDisplayMode {
  if (cachedMode) {
    return cachedMode;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cachedMode = DEFAULT_MODE;
      return cachedMode;
    }
    cachedMode = normaliseMode(JSON.parse(raw));
    return cachedMode;
  } catch {
    cachedMode = DEFAULT_MODE;
    return cachedMode;
  }
}

export function saveThemeSongNameDisplayMode(mode: ThemeSongNameDisplayMode): ThemeSongNameDisplayMode {
  const next = normaliseMode(mode);
  cachedMode = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  emitChange();
  return next;
}

export function subscribeThemeSongNameDisplayMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset. */
export function _clearThemeSongDisplayPreferencesForTesting(): void {
  cachedMode = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
