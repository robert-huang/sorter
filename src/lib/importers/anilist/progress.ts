/**
 * Progress events emitted by the AniList importers so the UI can show
 * "fetching page 3 of your list…" / "writing 412 rows…" instead of an
 * inscrutable spinner. Importers were going dark for 5–30s on bigger
 * lists, which felt like the app had hung.
 *
 * Design notes:
 *
 *   - Events are descriptive enough for a humanized label without the
 *     UI knowing which importer is running ('list' / 'favourites' /
 *     'characters' distinguishes the pagination context).
 *   - `kind: 'writing'` carries the statement count for batches that
 *     touch hundreds of rows — gives a sense of "size of the commit"
 *     when the SQLite write itself is slow on big imports.
 *   - `kind: 'done'` is emitted last so the UI can reset its label
 *     even if the caller forgets to clear progress state on the
 *     resolve side. (Importers also still throw on failure — callers
 *     should reset progress in their finally block too.)
 *   - Reporter is synchronous to keep the hot loop tight; UI bridges
 *     wrap state updates in setTimeout(0) if they need batching.
 */

export type AnilistProgressEvent =
  | { kind: 'resolving-user'; username: string }
  | {
      kind: 'fetching-page';
      /** Which paginated connection is being fetched. */
      what: 'list' | 'favourites' | 'characters' | 'staff' | 'filmography' | 'relations' | 'theme-songs';
      /** 1-based page number being fetched. */
      page: number;
      /** Total items accumulated so far INCLUDING this page's results
       *  (i.e. report after the page resolves). */
      itemsSoFar: number;
    }
  | { kind: 'writing'; statements: number }
  | { kind: 'done' };

export type AnilistProgressReporter = (event: AnilistProgressEvent) => void;

/** Tiny helper so importer call sites stay one-liners and skip the
 *  undefined check in the hot pagination loop. */
export function emitProgress(
  reporter: AnilistProgressReporter | undefined,
  event: AnilistProgressEvent,
): void {
  if (reporter) reporter(event);
}
