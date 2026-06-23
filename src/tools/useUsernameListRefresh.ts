import { useCallback, useState, type MouseEvent } from 'react';
import { bustToolsUserListCache, ensureUserAnimeListFresh } from '../lib/importers/anilist/toolsAnilistAccess';

/** EndpointPicker-style right-click handler for Tools username fields. */
export function useUsernameListRefresh() {
  const [hint, setHint] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const onUsernameContextMenu = useCallback(
    (e: MouseEvent, username: string, disabled?: boolean) => {
      e.preventDefault();
      const handle = username.trim();
      if (!handle || disabled || refreshing) {
        return;
      }
      setRefreshing(true);
      setHint(`Re-fetching ${handle}'s list…`);
      void (async () => {
        try {
          await bustToolsUserListCache(handle);
          await ensureUserAnimeListFresh(handle, { forceRefresh: true });
          setHint(`Refreshed ${handle}'s list.`);
        } catch (err) {
          setHint(err instanceof Error ? err.message : 'List refresh failed.');
        } finally {
          setRefreshing(false);
          window.setTimeout(() => setHint(null), 4000);
        }
      })();
    },
    [refreshing],
  );

  return { hint, refreshing, onUsernameContextMenu };
}
