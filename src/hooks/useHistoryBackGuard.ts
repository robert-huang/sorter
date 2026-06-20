import { useEffect, useRef } from 'react';

const GUARD_STATE = { historyBackGuard: true } as const;

/**
 * Intercept the browser Back button while `enabled`. Pushes a sentinel
 * history entry and re-pushes on `popstate` so the page stays put.
 * Optional `onBack` runs after each blocked back (e.g. confirm modal).
 */
export function useHistoryBackGuard(enabled: boolean, onBack?: () => void): void {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (typeof window === 'undefined' || !enabled) return undefined;

    let pushed = true;
    window.history.pushState(GUARD_STATE, '');

    const onPopState = (): void => {
      window.history.pushState(GUARD_STATE, '');
      onBackRef.current?.();
    };

    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      if (pushed) {
        pushed = false;
        window.history.back();
      }
    };
  }, [enabled]);
}
