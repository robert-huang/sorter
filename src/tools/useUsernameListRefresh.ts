import { useCallback, useState } from 'react';
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

/** Refresh handler for Tools username fields (↻ button beside the input). */
export function useUsernameListRefresh(options?: UsernameListRefreshOptions) {
  const refreshFavourites = options?.refreshFavourites ?? false;
  const [refreshing, setRefreshing] = useState(false);

  const refreshUsernameList = useCallback(
    (username: string, disabled?: boolean) => {
      const handle = username.trim();
      if (!handle || disabled || refreshing) {
        return;
      }
      setRefreshing(true);
      void (async () => {
        try {
          await refreshUserListFromAnilist(handle, refreshFavourites);
        } finally {
          setRefreshing(false);
        }
      })();
    },
    [refreshFavourites, refreshing],
  );

  return { refreshing, refreshUsernameList };
}
