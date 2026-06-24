import { readLastAnilistUsername } from '../lib/importers/anilist/lastUsername';

/** Default-fill an AniList username field from the last import, like A2A. */
export function withLastAnilistUsername(username: string): string {
  return username.trim() || readLastAnilistUsername();
}
