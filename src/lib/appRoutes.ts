/** Cross-page entry points (Vite `base` aware). */

export const SORTER_HOME_HREF = `${import.meta.env.BASE_URL}index.html`;

export const ANIME_TO_ANIME_HREF = `${import.meta.env.BASE_URL}anime-to-anime.html`;

/** Page URL for sharing — uses whatever host/path the app is deployed on. */
export function currentPageUrl(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return `${window.location.origin}${window.location.pathname}`;
}
