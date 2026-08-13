import { useEffect, useState } from 'react';

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function readReducedMotionPreference(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

/**
 * Tracks the OS/browser motion preference so animation-dependent UI can
 * bypass transitions instead of waiting for events CSS will never emit.
 */
export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    readReducedMotionPreference,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const updatePreference = (): void => {
      setPrefersReducedMotion(media.matches);
    };

    updatePreference();
    media.addEventListener('change', updatePreference);
    return () => media.removeEventListener('change', updatePreference);
  }, []);

  return prefersReducedMotion;
}
