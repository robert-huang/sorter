/** Metadata-match precedence for Spotify playlist theme-song indicators. */

export type SpotifyLocalFileMatchMode = 'off' | 'local-first' | 'spotify-first';

const STORAGE_KEY = 'spotify:local-file-match:v1';

export const SPOTIFY_LOCAL_FILE_MATCH_CHANGED =
  'spotify-local-file-match-preferences-changed';

const DEFAULT_MODE: SpotifyLocalFileMatchMode = 'off';

let cachedMode: SpotifyLocalFileMatchMode | null = null;

const listeners = new Set<() => void>();

function normalizeMode(value: unknown): SpotifyLocalFileMatchMode {
  if (value === 'local-first' || value === 'spotify-first') {
    return value;
  }
  return DEFAULT_MODE;
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SPOTIFY_LOCAL_FILE_MATCH_CHANGED));
  }
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
    window.dispatchEvent(new CustomEvent(SPOTIFY_LOCAL_FILE_MATCH_CHANGED));
  });
}

export function loadSpotifyLocalFileMatchMode(): SpotifyLocalFileMatchMode {
  if (cachedMode) {
    return cachedMode;
  }
  try {
    cachedMode = normalizeMode(localStorage.getItem(STORAGE_KEY));
  } catch {
    cachedMode = DEFAULT_MODE;
  }
  return cachedMode;
}

export function saveSpotifyLocalFileMatchMode(
  mode: SpotifyLocalFileMatchMode,
): SpotifyLocalFileMatchMode {
  const next = normalizeMode(mode);
  cachedMode = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore quota */
  }
  emitChange();
  return next;
}

export function subscribeSpotifyLocalFileMatchMode(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset. */
export function _clearSpotifyLocalFileMatchPreferencesForTesting(): void {
  cachedMode = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
