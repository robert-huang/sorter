import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
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
  scrollAnchorYearAttribute?: string;
};

type SavedScrollState = {
  ratio: number;
  anchor: ScrollAnchorSnapshot | null;
};

type AnchorConfig = {
  scrollAnchorSelector?: string;
  scrollAnchorAttribute: string;
  scrollAnchorYearAttribute: string;
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
  scrollAnchorYearAttribute = 'data-scroll-anchor-year',
}: DragScrollProps) {
  const { ref, ...dragProps } = useDragScroll<HTMLDivElement>();
  const isFirstLayoutRef = useRef(true);
  const savedScrollRef = useRef<SavedScrollState | null>(null);
  const anchorConfigRef = useRef<AnchorConfig>({
    scrollAnchorSelector,
    scrollAnchorAttribute,
    scrollAnchorYearAttribute,
  });
  anchorConfigRef.current = {
    scrollAnchorSelector,
    scrollAnchorAttribute,
    scrollAnchorYearAttribute,
  };

  const saveScrollState = useCallback((el: HTMLElement): void => {
    const {
      scrollAnchorSelector: selector,
      scrollAnchorAttribute: attribute,
      scrollAnchorYearAttribute: yearAttribute,
    } = anchorConfigRef.current;
    const max = maxScrollLeft(el);
    savedScrollRef.current = {
      ratio: max > 0 ? el.scrollLeft / max : 0,
      anchor:
        selector != null
          ? captureLeftmostVisibleScrollAnchor(el, selector, attribute, yearAttribute)
          : null,
    };
  }, []);

  // useLayoutEffect runs after DOM commit (so scrollWidth is final) and
  // before paint. On first mount with `initialScrollEnd`, snap right.
  // On later passes, restore the user's column anchor (by label) or scroll
  // ratio. Snapshot is taken at the end of each pass and on scroll — never
  // in effect cleanup, which runs after the next commit and would read the
  // new column DOM at the old scroll offset.
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
      const {
        scrollAnchorSelector: selector,
        scrollAnchorAttribute: attribute,
        scrollAnchorYearAttribute: yearAttribute,
      } = anchorConfigRef.current;

      const anchorRestored =
        saved.anchor != null &&
        selector != null &&
        restoreScrollAnchor(el, selector, saved.anchor, attribute, yearAttribute);

      if (!anchorRestored) {
        const max = maxScrollLeft(el);
        el.scrollLeft = saved.ratio * max;
      }
    }

    saveScrollState(el);

    const onScroll = (): void => {
      saveScrollState(el);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref is stable; children drives restore
  }, [children, initialScrollEnd, saveScrollState]);

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
