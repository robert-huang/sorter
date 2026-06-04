export type AnimeToAnimeTheme = 'light' | 'dark';

export const ANIME_TO_ANIME_THEME_KEY = 'anime-to-anime-theme';

export function loadAnimeToAnimeTheme(): AnimeToAnimeTheme {
  try {
    const raw = localStorage.getItem(ANIME_TO_ANIME_THEME_KEY);
    if (raw === 'light' || raw === 'dark') {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return 'dark';
}

export function saveAnimeToAnimeTheme(theme: AnimeToAnimeTheme): void {
  try {
    localStorage.setItem(ANIME_TO_ANIME_THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}

export function applyAnimeToAnimeTheme(theme: AnimeToAnimeTheme): void {
  document.documentElement.dataset.theme = theme;
}
