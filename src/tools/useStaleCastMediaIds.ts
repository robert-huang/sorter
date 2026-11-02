import { useEffect, useState } from 'react';
import {
  findStaleCastMediaIds,
  findStaleStaffFilmographyIds,
} from '../lib/importers/anilist/toolsAnilistAccess';
import { useToolsPreferences } from '../hooks/useToolsPreferences';

type StaleIdsOptions = {
  /** Check even when highlighting is off (for tools that show a stale-data warning). */
  ignoreHighlightSetting?: boolean;
};

/**
 * Ids among `ids` whose cached AniList data is over 90 days old, or an empty set
 * when the global "Highlight stale data" setting is off. Any change to
 * `revision` re-checks (e.g. after a refresh or DB sync).
 */
function useStaleIds(
  ids: readonly number[],
  revision: unknown,
  findStale: (ids: readonly number[]) => Promise<number[]>,
  options?: StaleIdsOptions,
): ReadonlySet<number> {
  const { highlightStaleCast } = useToolsPreferences().prefs;
  const enabled = highlightStaleCast || !!options?.ignoreHighlightSetting;
  const [stale, setStale] = useState<ReadonlySet<number>>(() => new Set());
  const key = ids.join(',');

  useEffect(() => {
    if (!enabled || key === '') {
      setStale(new Set());
      return;
    }
    let cancelled = false;
    void findStale(key.split(',').map(Number))
      .then((found) => {
        if (!cancelled) setStale(new Set(found));
      })
      .catch(() => {
        if (!cancelled) setStale(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, findStale, key, revision]);

  return stale;
}

/** Shows whose cast (characters / staff) cache is stale. */
export function useStaleCastMediaIds(
  mediaIds: readonly number[],
  revision: unknown = 0,
  options?: StaleIdsOptions,
): ReadonlySet<number> {
  return useStaleIds(mediaIds, revision, findStaleCastMediaIds, options);
}

/** Staff whose filmography (credits / voiced characters) cache is stale. */
export function useStaleStaffIds(
  staffIds: readonly number[],
  revision: unknown = 0,
  options?: StaleIdsOptions,
): ReadonlySet<number> {
  return useStaleIds(staffIds, revision, findStaleStaffFilmographyIds, options);
}
