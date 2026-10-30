import { useCallback, useEffect, useRef, useState } from 'react';

/** How long the failure "x" shows before the indicator returns to its dot. */
export const PLAYLIST_EDIT_FAILED_MS = 2000;

export type PlaylistEditPhase = 'idle' | 'busy' | 'failed';

/**
 * Busy/failed state for one right-click playlist edit. Success has no phase of
 * its own: the playlist cache update re-renders the indicator.
 */
export function usePlaylistEditAction(): {
  phase: PlaylistEditPhase;
  /** Last failure message; kept until the next attempt so the tooltip can explain it. */
  error: string | null;
  run: (action: () => Promise<unknown>) => void;
} {
  const [phase, setPhase] = useState<PlaylistEditPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const run = useCallback((action: () => Promise<unknown>) => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setError(null);
    setPhase('busy');
    void action().then(
      () => {
        busyRef.current = false;
        if (mountedRef.current) setPhase('idle');
      },
      (failure: unknown) => {
        busyRef.current = false;
        if (!mountedRef.current) return;
        setError(failure instanceof Error ? failure.message : 'Playlist edit failed.');
        setPhase('failed');
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          if (mountedRef.current) setPhase('idle');
        }, PLAYLIST_EDIT_FAILED_MS);
      },
    );
  }, []);

  return { phase, error, run };
}
