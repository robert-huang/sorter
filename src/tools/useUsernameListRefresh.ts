import { useCallback, useState, type MouseEvent } from 'react';
import {
  bustToolsUserListCache,
  ensureUserAnimeListFresh,
  ensureUserFavouritesFresh,
} from '../lib/importers/anilist/toolsAnilistAccess';

export type UsernameListRefreshOptions = {
  /** Also re-import character + staff favourites into the source DB. */
  refreshFavourites?: boolean;
};

async function refreshUserListFromAnilist(
  username: string,
  refreshFavourites: boolean,
): Promise<void> {
  const handle = username.trim();
  if (!handle) {
    return;
  }
  await bustToolsUserListCache(handle);
  await ensureUserAnimeListFresh(handle, { forceRefresh: true });
  if (refreshFavourites) {
    await ensureUserFavouritesFresh(handle, 'CHARACTERS', { forceRefresh: true });
    await ensureUserFavouritesFresh(handle, 'STAFF', { forceRefresh: true });
  }
}

/** Refresh handler for Tools username fields (icon button or legacy right-click). */
export function useUsernameListRefresh(options?: UsernameListRefreshOptions) {
  const refreshFavourites = options?.refreshFavourites ?? false;
  const [refreshing, setRefreshing] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const runRefresh = useCallback(
    (username: string, disabled?: boolean) => {
      const handle = username.trim();
      if (!handle || disabled || refreshing) {
        return;
      }
      const scopeLabel = refreshFavourites ? 'list and favourites' : 'list';
      setRefreshing(true);
      setHint(`Re-fetching ${handle}'s ${scopeLabel}…`);
      void (async () => {
        try {
          await refreshUserListFromAnilist(handle, refreshFavourites);
          setHint(`Refreshed ${handle}'s ${scopeLabel}.`);
        } catch (err) {
          setHint(err instanceof Error ? err.message : 'Refresh failed.');
        } finally {
          setRefreshing(false);
          window.setTimeout(() => setHint(null), 4000);
        }
      })();
    },
    [refreshFavourites, refreshing],
  );

  /** Shared Credits still uses right-click on list username fields. */
  const onUsernameContextMenu = useCallback(
    (e: MouseEvent, username: string, disabled?: boolean) => {
      e.preventDefault();
      runRefresh(username, disabled);
    },
    [runRefresh],
  );

  return { hint, refreshing, refreshUsernameList: runRefresh, onUsernameContextMenu };
}
