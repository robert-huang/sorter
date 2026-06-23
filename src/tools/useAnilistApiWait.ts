import { useEffect, useState } from 'react';
import { useAnilistWaitCountdown } from '../hooks/useAnilistWaitCountdown';
import {
  subscribeToWaitState,
  type AnilistWaitState,
} from '../lib/importers/anilist/transport';

/** Subscribe to AniList transport rate-limit waits for Tools panels. */
export function useAnilistApiWait(): {
  apiWait: AnilistWaitState | null;
  apiWaitSecondsLeft: number | null;
} {
  const [apiWait, setApiWait] = useState<AnilistWaitState | null>(null);
  const apiWaitSecondsLeft = useAnilistWaitCountdown(apiWait);

  useEffect(() => {
    return subscribeToWaitState(setApiWait);
  }, []);

  return { apiWait, apiWaitSecondsLeft };
}
