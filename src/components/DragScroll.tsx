import { useLayoutEffect, type ReactNode } from 'react';
import { useDragScroll } from '../lib/hooks/useDragScroll';

type DragScrollProps = {
  className?: string;
  children: ReactNode;
  /**
   * When true, scroll the container all the way to its right edge after
   * mount. Opt-in because most consumers want the natural left-anchored
   * start; Seasonal Scores opts in so the chart begins on the most recent
   * season instead of the oldest.
   */
  initialScrollEnd?: boolean;
};

/** Scroll container that supports click-drag panning in any scroll direction. */
export function DragScroll({ className, children, initialScrollEnd = false }: DragScrollProps) {
  const { ref, ...dragProps } = useDragScroll<HTMLDivElement>();

  // useLayoutEffect runs after DOM commit (so scrollWidth is final) and
  // before paint (so the user never sees the left-anchored frame first).
  // Empty deps: only on mount — re-derivations of the same result (form
  // toggles, relabel) should preserve the user's scroll position. A fresh
  // run unmounts the parent (setResult(null) → null branch) so a new mount
  // naturally re-applies this.
  useLayoutEffect(() => {
    if (!initialScrollEnd) {
      return;
    }
    const el = ref.current;
    if (!el) {
      return;
    }
    el.scrollLeft = el.scrollWidth;
  }, []);

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
