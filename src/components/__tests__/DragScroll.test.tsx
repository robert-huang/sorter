/**
 * DragScroll snap-to-right contract:
 *
 *   - `initialScrollEnd` on mount: container's `scrollLeft` is set to its
 *     `scrollWidth` so callers like Seasonal Scores anchor on the most
 *     recent season instead of the oldest.
 *   - Without `scrollEndKey`: subsequent re-renders preserve the user's
 *     scroll position (so a display-language relabel doesn't jolt them).
 *   - With `scrollEndKey`: a change to that key re-runs the snap. This
 *     covers Seasonal Scores' form-toggle path — Skip Empty / mode /
 *     custom season text rebuild the columns in place via the
 *     form-watching effect, never going through `setResult(null)`.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DragScroll } from '../DragScroll';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom does not compute scrollWidth from layout — stub it on the
  // prototype so the DragScroll layout effect has a value to assign.
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      const v = (this as HTMLElement & { __scrollWidth?: number }).__scrollWidth;
      return typeof v === 'number' ? v : 0;
    },
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function setStubScrollWidth(el: HTMLElement, value: number): void {
  (el as HTMLElement & { __scrollWidth?: number }).__scrollWidth = value;
}

function getScrollContainer(): HTMLElement {
  const el = container.querySelector('.tool-drag-scroll');
  if (!(el instanceof HTMLElement)) {
    throw new Error('DragScroll container not found');
  }
  return el;
}

describe('DragScroll initialScrollEnd', () => {
  it('snaps to the right edge on mount when initialScrollEnd is set', () => {
    // The layout effect reads scrollWidth at commit time; arrange the
    // stub via a setup callback that runs before the effect fires.
    act(() => {
      root.render(
        <DragScroll initialScrollEnd>
          <div ref={(node) => node && setStubScrollWidth(node.parentElement!, 800)}>
            content
          </div>
        </DragScroll>,
      );
    });
    expect(getScrollContainer().scrollLeft).toBe(800);
  });

  it('does NOT snap to right when initialScrollEnd is omitted', () => {
    act(() => {
      root.render(
        <DragScroll>
          <div ref={(node) => node && setStubScrollWidth(node.parentElement!, 800)}>
            content
          </div>
        </DragScroll>,
      );
    });
    expect(getScrollContainer().scrollLeft).toBe(0);
  });
});

describe('DragScroll scrollEndKey', () => {
  it('preserves scroll across re-renders when scrollEndKey is omitted', () => {
    act(() => {
      root.render(
        <DragScroll initialScrollEnd>
          <div ref={(node) => node && setStubScrollWidth(node.parentElement!, 1000)}>
            v1
          </div>
        </DragScroll>,
      );
    });
    const el = getScrollContainer();
    expect(el.scrollLeft).toBe(1000);

    // Simulate the user dragging back to the start, then a relabel
    // re-render with a different scrollWidth. Without scrollEndKey the
    // effect must NOT fire again.
    el.scrollLeft = 200;
    act(() => {
      root.render(
        <DragScroll initialScrollEnd>
          <div ref={(node) => node && setStubScrollWidth(node.parentElement!, 1400)}>
            v2 (relabeled)
          </div>
        </DragScroll>,
      );
    });
    expect(el.scrollLeft).toBe(200);
  });

  it('re-snaps to right when scrollEndKey changes', () => {
    let stubWidth = 1000;
    act(() => {
      root.render(
        <DragScroll initialScrollEnd scrollEndKey="key-a">
          <div ref={(node) => node && setStubScrollWidth(node.parentElement!, stubWidth)}>
            v1
          </div>
        </DragScroll>,
      );
    });
    const el = getScrollContainer();
    expect(el.scrollLeft).toBe(1000);

    // User scrolls back to look at older data.
    el.scrollLeft = 100;

    // Settings change rebuilds the chart in place — wider content, new key.
    stubWidth = 1400;
    act(() => {
      root.render(
        <DragScroll initialScrollEnd scrollEndKey="key-b">
          <div ref={(node) => node && setStubScrollWidth(node.parentElement!, stubWidth)}>
            v2 (wider — more columns)
          </div>
        </DragScroll>,
      );
    });
    expect(el.scrollLeft).toBe(1400);
  });

  it('does NOT re-snap when scrollEndKey stays the same', () => {
    act(() => {
      root.render(
        <DragScroll initialScrollEnd scrollEndKey="stable">
          <div ref={(node) => node && setStubScrollWidth(node.parentElement!, 1000)}>
            v1
          </div>
        </DragScroll>,
      );
    });
    const el = getScrollContainer();
    expect(el.scrollLeft).toBe(1000);

    el.scrollLeft = 300;
    act(() => {
      root.render(
        <DragScroll initialScrollEnd scrollEndKey="stable">
          <div ref={(node) => node && setStubScrollWidth(node.parentElement!, 1400)}>
            v2 (same shape, only labels changed)
          </div>
        </DragScroll>,
      );
    });
    expect(el.scrollLeft).toBe(300);
  });
});
