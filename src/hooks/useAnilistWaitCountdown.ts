import { useLayoutEffect, useState } from 'react';
import type { AnilistWaitState } from '../lib/importers/anilist/transport';

/** Seconds until retry, rounded up; 0 when the wait window has elapsed. */
export function anilistWaitSecondsRemaining(
  deadlineMs: number,
  nowMs: number = Date.now(),
): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

/**
 * Live countdown for {@link AnilistWaitState} from the AniList transport.
 * `retryInMs` is fixed when the wait starts; this ticks down each second.
 */
export function useAnilistWaitCountdown(wait: AnilistWaitState | null): number | null {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!wait) {
      setSecondsLeft(null);
      return;
    }

    const deadlineMs = Date.now() + wait.retryInMs;
    const tick = () => {
      setSecondsLeft(anilistWaitSecondsRemaining(deadlineMs));
    };

    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => window.clearInterval(intervalId);
  }, [wait?.attempt, wait?.retryInMs]);

  return secondsLeft;
}
