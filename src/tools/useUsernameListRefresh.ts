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

/** EndpointPicker-style right-click handler for Tools username fields. */
export function useUsernameListRefresh(options?: UsernameListRefreshOptions) {
  const refreshFavourites = options?.refreshFavourites ?? false;
  const [hint, setHint] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const onUsernameContextMenu = useCallback(
    (e: MouseEvent, username: string, disabled?: boolean) => {
      e.preventDefault();
      const handle = username.trim();
      if (!handle || disabled || refreshing) {
        return;
      }
      const scopeLabel = refreshFavourites ? 'list and favourites' : 'list';
      setRefreshing(true);
      setHint(`Re-fetching ${handle}'s ${scopeLabel}…`);
      void (async () => {
        try {
          await bustToolsUserListCache(handle);
          await ensureUserAnimeListFresh(handle, { forceRefresh: true });
          if (refreshFavourites) {
            await ensureUserFavouritesFresh(handle, 'CHARACTERS', { forceRefresh: true });
            await ensureUserFavouritesFresh(handle, 'STAFF', { forceRefresh: true });
          }
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

  return { hint, refreshing, onUsernameContextMenu };
}
