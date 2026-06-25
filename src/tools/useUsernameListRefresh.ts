import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ensureUserAnimeListFresh,
  ensureUserFavouritesFresh,
  ensureUserMangaListFresh,
} from '../lib/importers/anilist/toolsAnilistAccess';
import { bustFavouritesSessionMemo } from './panels/favouritesApi';

export type UsernameListRefreshOptions = {
  /** Also re-import character + staff favourites into the source DB. */
  refreshFavourites?: boolean;
  /** Also re-import the user's MANGA list (Franchise Scores reads both). */
  refreshManga?: boolean;
  /**
   * Called after the import(s) finish, before `refreshing` flips back to
   * false. Used by panels that maintain their own session memos (e.g.
   * Franchise Scores) to bust them so the next run re-fetches.
   */
  onAfterRefresh?: (username: string) => void | Promise<void>;
};

async function refreshUserListFromAnilist(
  username: string,
  refreshFavourites: boolean,
  refreshManga: boolean,
  onAfterRefresh?: (username: string) => void | Promise<void>,
): Promise<void> {
  const handle = username.trim();
  if (!handle) {
    return;
  }
  await ensureUserAnimeListFresh(handle, { forceRefresh: true });
  if (refreshManga) {
    await ensureUserMangaListFresh(handle, { forceRefresh: true });
  }
  if (refreshFavourites) {
    await ensureUserFavouritesFresh(handle, 'CHARACTERS', { forceRefresh: true });
    await ensureUserFavouritesFresh(handle, 'STAFF', { forceRefresh: true });
    // The favourites Analyze path memoizes the DB read for 15min. Without
    // busting here, the next Analyze would still serve the pre-refresh
    // list even though SQLite has the new rows.
    bustFavouritesSessionMemo(handle);
  }
  if (onAfterRefresh) {
    await onAfterRefresh(handle);
  }
}

/** Refresh handler for Tools username fields (↻ button beside the input). */
export function useUsernameListRefresh(options?: UsernameListRefreshOptions) {
  const refreshFavourites = options?.refreshFavourites ?? false;
  const refreshManga = options?.refreshManga ?? false;
  const onAfterRefresh = options?.onAfterRefresh;
  const [refreshing, setRefreshing] = useState(false);
  // Avoid setting state after the panel unmounts; the refresh keeps
  // running (no abort wired in yet) but at least we don't warn / leak.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshUsernameList = useCallback(
    (username: string, disabled?: boolean) => {
      const handle = username.trim();
      if (!handle || disabled || refreshing) {
        return;
      }
      setRefreshing(true);
      void (async () => {
        try {
          await refreshUserListFromAnilist(
            handle,
            refreshFavourites,
            refreshManga,
            onAfterRefresh,
          );
        } finally {
          if (mountedRef.current) {
            setRefreshing(false);
          }
        }
      })();
    },
    [refreshFavourites, refreshManga, onAfterRefresh, refreshing],
  );

  return { refreshing, refreshUsernameList };
}
