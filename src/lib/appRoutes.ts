/** Cross-page entry points (Vite `base` aware). */

export const GITHUB_REPO_URL = 'https://github.com/robert-huang/sorter';

export const GITHUB_PAGES_URL = 'https://robert-huang.github.io/sorter/';

export const SORTER_HOME_HREF = `${import.meta.env.BASE_URL}index.html`;

export const ANIME_TO_ANIME_HREF = `${import.meta.env.BASE_URL}anime-to-anime.html`;

export const TOOLS_HREF = `${import.meta.env.BASE_URL}tools.html`;

/**
 * Cross-app nav chip labels. Tab order is Sorter → A2A → Tools.
 * ⇤ / ⇥ mark end-to-end jumps (Sorter ↔ Tools). Plain ← / → are
 * one-step hops through A2A.
 */
export const NAV_TO_SORTER = '← Sorter';
export const NAV_TO_SORTER_END = '⇤ Sorter';
export const NAV_TO_A2A_FORWARD = 'A2A →';
export const NAV_TO_A2A_BACK = '← A2A';
export const NAV_TO_TOOLS = 'Tools →';
export const NAV_TO_TOOLS_END = 'Tools ⇥';

/** Page URL for sharing — uses whatever host/path the app is deployed on. */
export function currentPageUrl(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return `${window.location.origin}${window.location.pathname}`;
}
