export type VaListImageMode = 'character' | 'staff';

export const VA_LIST_IMAGE_MODE_KEY = 'anime-to-anime-va-image-mode';

export function loadVaListImageMode(): VaListImageMode {
  try {
    const raw = localStorage.getItem(VA_LIST_IMAGE_MODE_KEY);
    if (raw === 'character' || raw === 'staff') {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return 'staff';
}

export function saveVaListImageMode(mode: VaListImageMode): void {
  try {
    localStorage.setItem(VA_LIST_IMAGE_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}
