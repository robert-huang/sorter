export type ScrollAnchorSnapshot = {
  key: string;
  /** Anchor element left edge minus container left edge, in viewport coords. */
  offsetInViewport: number;
};

function isPartiallyVisibleInContainer(
  elementRect: DOMRect,
  containerRect: DOMRect,
): boolean {
  return elementRect.right > containerRect.left && elementRect.left < containerRect.right;
}

/**
 * Capture the leftmost partially-visible anchored child so a horizontal
 * scroller can restore the same column after content rebuilds.
 */
export function captureLeftmostVisibleScrollAnchor(
  container: HTMLElement,
  selector: string,
  attribute = 'data-scroll-anchor',
): ScrollAnchorSnapshot | null {
  const containerRect = container.getBoundingClientRect();
  let best: { key: string; offsetInViewport: number; left: number } | null = null;

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
        left: rect.left,
      };
    }
  }

  return best ? { key: best.key, offsetInViewport: best.offsetInViewport } : null;
}

/** Scroll so `snapshot`'s anchor sits at the same viewport offset as before. */
export function restoreScrollAnchor(
  container: HTMLElement,
  selector: string,
  snapshot: ScrollAnchorSnapshot,
  attribute = 'data-scroll-anchor',
): boolean {
  const escapedKey =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(snapshot.key)
      : snapshot.key.replace(/"/g, '\\"');
  const anchor = container.querySelector<HTMLElement>(
    `${selector}[${attribute}="${escapedKey}"]`,
  );
  if (!anchor) {
    return false;
  }

  const delta =
    anchor.getBoundingClientRect().left -
    container.getBoundingClientRect().left -
    snapshot.offsetInViewport;
  container.scrollLeft += delta;
  return true;
}
