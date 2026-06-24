import { useEffect, useState } from 'react';
import { subscribeAnilistDisplayPreferences } from '../lib/importers/anilist/displayPreferences';

/** Bumps when AniList title/name display preferences change — tools panels
 *  use this to relabel in-memory results without re-fetching. */
export function useToolsDisplayLabelRevision(): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    return subscribeAnilistDisplayPreferences(() => {
      setRevision((value) => value + 1);
    });
  }, []);

  return revision;
}
