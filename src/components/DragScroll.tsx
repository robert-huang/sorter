import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useDragScroll } from '../lib/hooks/useDragScroll';

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
};

function maxScrollLeft(el: HTMLElement): number {
  return Math.max(0, el.scrollWidth - el.clientWidth);
}

/** Scroll container that supports click-drag panning in any scroll direction. */
export function DragScroll({
  className,
  children,
  initialScrollEnd = false,
}: DragScrollProps) {
  const { ref, ...dragProps } = useDragScroll<HTMLDivElement>();
  const isFirstLayoutRef = useRef(true);
  const savedScrollRatioRef = useRef<number | null>(null);

  // useLayoutEffect runs after DOM commit (so scrollWidth is final) and
  // before paint. On first mount with `initialScrollEnd`, snap right.
  // On later passes, restore the user's prior scroll ratio so filter
  // toggles / relabels don't jolt them to either edge.
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
    } else if (savedScrollRatioRef.current != null) {
      const max = maxScrollLeft(el);
      el.scrollLeft = savedScrollRatioRef.current * max;
      savedScrollRatioRef.current = null;
    }

    return () => {
      const cleanupEl = ref.current;
      if (!cleanupEl) {
        return;
      }
      const max = maxScrollLeft(cleanupEl);
      savedScrollRatioRef.current = max > 0 ? cleanupEl.scrollLeft / max : 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref is stable; children drives restore
  }, [children, initialScrollEnd]);

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
