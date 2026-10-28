import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 4;

const HIDDEN_STYLE: CSSProperties = { position: 'fixed', top: 0, left: 0, visibility: 'hidden' };

/**
 * Viewport-fixed placement for a popover menu so it escapes `overflow`
 * clipping (e.g. a menu inside a scrolling table header). Opens below the
 * anchor, flips above when there's no room, and clamps into the viewport.
 * Returns undefined when disabled so callers keep their CSS positioning.
 */
export function useFloatingMenuStyle(
  enabled: boolean,
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>(HIDDEN_STYLE);

  useLayoutEffect(() => {
    if (!enabled || !open) {
      setStyle(HIDDEN_STYLE);
      return;
    }
    const place = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const a = anchor.getBoundingClientRect();
      const m = menu.getBoundingClientRect();
      let top = a.bottom + ANCHOR_GAP;
      const flippedTop = a.top - ANCHOR_GAP - m.height;
      if (top + m.height > window.innerHeight - VIEWPORT_MARGIN && flippedTop >= VIEWPORT_MARGIN) {
        top = flippedTop;
      }
      const maxLeft = window.innerWidth - VIEWPORT_MARGIN - m.width;
      const left = Math.max(VIEWPORT_MARGIN, Math.min(a.left, maxLeft));
      setStyle({ position: 'fixed', top, left, margin: 0 });
    };
    place();
    window.addEventListener('resize', place);
    // Capture so scrolling any ancestor (table body, page) keeps it attached.
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [enabled, open, anchorRef, menuRef]);

  return enabled ? style : undefined;
}
