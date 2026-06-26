export type ScrollAnchorSnapshot = {
  key: string;
  /** Anchor element left edge minus container left edge, in viewport coords. */
  offsetInViewport: number;
  /** Calendar year for cross-granularity restore (e.g. Fall 2026 → 2026). */
  year: number | null;
};

function isPartiallyVisibleInContainer(
  elementRect: DOMRect,
  containerRect: DOMRect,
): boolean {
  return elementRect.right > containerRect.left && elementRect.left < containerRect.right;
}

/** Parse a trailing four-digit year from labels like `Fall 2026` or `2026`. */
export function parseScrollAnchorYear(key: string): number | null {
  const match = key.match(/(\d{4})\s*$/);
  return match ? Number(match[1]) : null;
}

export function isYearOnlyScrollAnchorKey(key: string): boolean {
  return /^\d{4}$/.test(key);
}

function readAnchorYear(
  element: HTMLElement,
  key: string,
  yearAttribute: string,
): number | null {
  const raw = element.getAttribute(yearAttribute);
  if (raw != null && raw !== '' && !Number.isNaN(Number(raw))) {
    return Number(raw);
  }
  return parseScrollAnchorYear(key);
}

function scrollToAnchorAtOffset(
  container: HTMLElement,
  anchor: HTMLElement,
  offsetInViewport: number,
): void {
  const delta =
    anchor.getBoundingClientRect().left -
    container.getBoundingClientRect().left -
    offsetInViewport;
  container.scrollLeft += delta;
}

function findExactScrollAnchor(
  container: HTMLElement,
  selector: string,
  key: string,
  attribute: string,
): HTMLElement | null {
  const escapedKey =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(key)
      : key.replace(/"/g, '\\"');
  return container.querySelector<HTMLElement>(`${selector}[${attribute}="${escapedKey}"]`);
}

function findScrollAnchorByYear(
  container: HTMLElement,
  selector: string,
  snapshot: ScrollAnchorSnapshot,
  yearAttribute: string,
): HTMLElement | null {
  if (snapshot.year == null) {
    return null;
  }

  const yearMatches = container.querySelectorAll<HTMLElement>(
    `${selector}[${yearAttribute}="${snapshot.year}"]`,
  );
  if (yearMatches.length === 1) {
    return yearMatches[0] ?? null;
  }
  if (yearMatches.length > 1 && isYearOnlyScrollAnchorKey(snapshot.key)) {
    // All (Years) → All (Seasons): land on the first season column for that year.
    return yearMatches[0] ?? null;
  }
  return null;
}

/**
 * Capture the leftmost partially-visible anchored child so a horizontal
 * scroller can restore the same column after content rebuilds.
 */
export function captureLeftmostVisibleScrollAnchor(
  container: HTMLElement,
  selector: string,
  attribute = 'data-scroll-anchor',
  yearAttribute = 'data-scroll-anchor-year',
): ScrollAnchorSnapshot | null {
  const containerRect = container.getBoundingClientRect();
  let best: {
    key: string;
    offsetInViewport: number;
    year: number | null;
    left: number;
  } | null = null;

  for (const element of container.querySelectorAll<HTMLElement>(selector)) {
    const key = element.getAttribute(attribute);
    if (!key) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (!isPartiallyVisibleInContainer(rect, containerRect)) {
      continue;
    }
    if (!best || rect.left < best.left) {
      best = {
        key,
        offsetInViewport: rect.left - containerRect.left,
        year: readAnchorYear(element, key, yearAttribute),
        left: rect.left,
      };
    }
  }

  return best
    ? {
        key: best.key,
        offsetInViewport: best.offsetInViewport,
        year: best.year,
      }
    : null;
}

/** Scroll so `snapshot`'s anchor sits at the same viewport offset as before. */
export function restoreScrollAnchor(
  container: HTMLElement,
  selector: string,
  snapshot: ScrollAnchorSnapshot,
  attribute = 'data-scroll-anchor',
  yearAttribute = 'data-scroll-anchor-year',
): boolean {
  const anchor =
    findExactScrollAnchor(container, selector, snapshot.key, attribute) ??
    findScrollAnchorByYear(container, selector, snapshot, yearAttribute);
  if (!anchor) {
    return false;
  }

  scrollToAnchorAtOffset(container, anchor, snapshot.offsetInViewport);
  return true;
}
