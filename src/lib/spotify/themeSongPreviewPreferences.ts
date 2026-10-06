const STORAGE_KEY = 'theme-song-preview:volume:v1';
const DEFAULT_VOLUME = 0.1;

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_VOLUME;
  }
  return Math.min(1, Math.max(0, value));
}

export function getThemeSongPreviewVolume(): number {
  if (typeof localStorage === 'undefined') {
    return DEFAULT_VOLUME;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_VOLUME;
    }
    return clampVolume(Number(raw));
  } catch {
    return DEFAULT_VOLUME;
  }
}

export function setThemeSongPreviewVolume(volume: number): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, String(clampVolume(volume)));
  } catch {
    // Best-effort persistence.
  }
}

export const THEME_SONG_PREVIEW_DEFAULT_VOLUME = DEFAULT_VOLUME;
