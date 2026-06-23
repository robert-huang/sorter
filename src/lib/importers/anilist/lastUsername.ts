/** Last AniList username successfully imported or used (A2A + START screen). */
export const ANILIST_LAST_USERNAME_LS_KEY = 'anilist:lastUsername';

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
  } catch {
    /* Best-effort — ignore private-mode / quota failures. */
  }
}

/** Use a saved form username, or fall back to the last import (A2A / START). */
export function withLastAnilistUsername(username: string): string {
  return username.trim() || readLastAnilistUsername();
}
