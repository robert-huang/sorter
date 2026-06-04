/**
 * UI-side humanizer for AniList importer progress events.
 *
 * Importers emit small structured events
 * ({@link import('../lib/importers/anilist/progress').AnilistProgressEvent}).
 * Every UI surface (StartScreen import bar, source panel buttons,
 * detail-modal refresh) needs to translate them to a short label —
 * pulled into one place so the wording stays consistent and tests
 * can rely on stable strings.
 */

import type { AnilistProgressEvent } from '../lib/importers/anilist/progress';

export function formatAnilistProgress(event: AnilistProgressEvent): string {
  switch (event.kind) {
    case 'resolving-user':
      return `Resolving "${event.username}"…`;
    case 'fetching-page': {
      const what = whatLabel(event.what);
      // 'page 1' is the first GraphQL page — keep humanized "page N"
      // language even though there's no known total page count yet
      // (AniList doesn't return a page total upfront for list pages).
      return `Fetching ${what} (page ${event.page} · ${event.itemsSoFar} item${
        event.itemsSoFar === 1 ? '' : 's'
      } so far)…`;
    }
    case 'writing':
      return `Writing ${event.statements} row${
        event.statements === 1 ? '' : 's'
      } to local cache…`;
    case 'done':
      return 'Done.';
  }
}

function whatLabel(
  what: 'list' | 'favourites' | 'characters' | 'staff' | 'filmography' | 'relations',
): string {
  switch (what) {
    case 'list':
      return 'list';
    case 'favourites':
      return 'favourites';
    case 'characters':
      return 'characters';
    case 'staff':
      return 'staff credits';
    case 'filmography':
      return 'filmography';
    case 'relations':
      return 'relations';
  }
}
