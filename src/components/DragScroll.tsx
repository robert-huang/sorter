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
  /**
   * Re-trigger the {@link initialScrollEnd} snap-to-right whenever this
   * value changes. Use when the chart contents change shape WITHOUT the
   * parent unmounting (e.g. Seasonal Scores: toggling Skip Empty / Only
   * #airing / switching season mode rebuilds the columns in place via
   * the form-watching effect, never going through `setResult(null)`).
   *
   * Omit (or pass a stable value) to preserve the user's scroll position
   * across re-renders — that's the right behavior for pure relabel
   * passes (display-language change) where the SAME chart is shown with
   * different labels and the user expects to stay where they were.
   */
  scrollEndKey?: string | number;
};

/** Scroll container that supports click-drag panning in any scroll direction. */
export function DragScroll({
  className,
  children,
  initialScrollEnd = false,
  scrollEndKey,
}: DragScrollProps) {
  const { ref, ...dragProps } = useDragScroll<HTMLDivElement>();

  // useLayoutEffect runs after DOM commit (so scrollWidth is final) and
  // before paint (so the user never sees the left-anchored frame first).
  // Re-runs on mount and on every `scrollEndKey` change — callers that
  // want pure mount-only behavior simply don't pass `scrollEndKey`, and
  // the deps array stays `[initialScrollEnd, undefined]` (constant after
  // mount).
  useLayoutEffect(() => {
    if (!initialScrollEnd) {
      return;
    }
    const el = ref.current;
    if (!el) {
      return;
    }
    el.scrollLeft = el.scrollWidth;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref is stable, intentional dep list
  }, [initialScrollEnd, scrollEndKey]);

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
