import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useDragScroll } from '../lib/hooks/useDragScroll';
import {
  captureLeftmostVisibleScrollAnchor,
  restoreScrollAnchor,
  type ScrollAnchorSnapshot,
} from '../lib/scrollAnchor';

type DragScrollProps = {
  className?: string;
  children: ReactNode;
  /**
   * When true, scroll the container all the way to its right edge on the
   * first layout pass only. Opt-in because most consumers want the natural
   * left-anchored start; Seasonal Scores opts in so a freshly loaded chart
   * begins on the most recent season instead of the oldest.
   */
  initialScrollEnd?: boolean;
  /**
   * When set, preserve the leftmost visible matching child's viewport
   * position across content updates (e.g. season columns after a filter
   * toggle). Falls back to scroll-ratio preservation when the anchor is
   * missing after the rebuild.
   */
  scrollAnchorSelector?: string;
  scrollAnchorAttribute?: string;
};

type SavedScrollState = {
  ratio: number;
  anchor: ScrollAnchorSnapshot | null;
};

function maxScrollLeft(el: HTMLElement): number {
  return Math.max(0, el.scrollWidth - el.clientWidth);
}

/** Scroll container that supports click-drag panning in any scroll direction. */
export function DragScroll({
  className,
  children,
  initialScrollEnd = false,
  scrollAnchorSelector,
  scrollAnchorAttribute = 'data-scroll-anchor',
}: DragScrollProps) {
  const { ref, ...dragProps } = useDragScroll<HTMLDivElement>();
  const isFirstLayoutRef = useRef(true);
  const savedScrollRef = useRef<SavedScrollState | null>(null);

  // useLayoutEffect runs after DOM commit (so scrollWidth is final) and
  // before paint. On first mount with `initialScrollEnd`, snap right.
  // On later passes, restore the user's column anchor or scroll ratio.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }

    if (isFirstLayoutRef.current) {
      isFirstLayoutRef.current = false;
      if (initialScrollEnd) {
        el.scrollLeft = maxScrollLeft(el) || el.scrollWidth;
      }
    } else if (savedScrollRef.current != null) {
      const saved = savedScrollRef.current;
      savedScrollRef.current = null;

      const anchorRestored =
        saved.anchor != null &&
        scrollAnchorSelector != null &&
        restoreScrollAnchor(
          el,
          scrollAnchorSelector,
          saved.anchor,
          scrollAnchorAttribute,
        );

      if (!anchorRestored) {
        const max = maxScrollLeft(el);
        el.scrollLeft = saved.ratio * max;
      }
    }

    return () => {
      const cleanupEl = ref.current;
      if (!cleanupEl) {
        return;
      }

      const max = maxScrollLeft(cleanupEl);
      const ratio = max > 0 ? cleanupEl.scrollLeft / max : 0;
      const anchor =
        scrollAnchorSelector != null
          ? captureLeftmostVisibleScrollAnchor(
              cleanupEl,
              scrollAnchorSelector,
              scrollAnchorAttribute,
            )
          : null;
      savedScrollRef.current = { ratio, anchor };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref is stable; children drives restore
  }, [children, initialScrollEnd, scrollAnchorAttribute, scrollAnchorSelector]);

  return (
    <div
      ref={ref}
      className={['tool-drag-scroll', className].filter(Boolean).join(' ')}
      {...dragProps}
    >
      {children}
    </div>
  );
}
