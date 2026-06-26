/**
 * DragScroll scroll contract:
 *
 *   - `initialScrollEnd` on first layout: container's `scrollLeft` is set to
 *     its max scroll so Seasonal Scores anchors on the most recent season.
 *   - Subsequent re-renders restore the user's scroll ratio so filter toggles,
 *     relabels, and column content changes don't jolt them to either edge.
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
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      const v = (this as HTMLElement & { __clientWidth?: number }).__clientWidth;
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

describe('DragScroll scroll preservation', () => {
  it('preserves scroll ratio across re-renders after the user pans', () => {
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
    expect(el.scrollLeft).toBe(280);
  });

  it('does NOT re-snap to the right when only chart content changes', () => {
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

    el.scrollLeft = 300;
    act(() => {
      root.render(
        <DragScroll initialScrollEnd>
          <div ref={(node) => node && setStubScrollWidth(node.parentElement!, 1400)}>
            v2 (wider — more columns)
          </div>
        </DragScroll>,
      );
    });
    expect(el.scrollLeft).toBe(420);
  });

  it('snaps to the right again only after a fresh mount', () => {
    act(() => {
      root.render(
        <DragScroll initialScrollEnd>
          <div ref={(node) => node && setStubScrollWidth(node.parentElement!, 1000)}>
            v1
          </div>
        </DragScroll>,
      );
    });
    getScrollContainer().scrollLeft = 100;

    act(() => {
      root.unmount();
    });

    const remountContainer = document.createElement('div');
    document.body.appendChild(remountContainer);
    const remountRoot = createRoot(remountContainer);
    act(() => {
      remountRoot.render(
        <DragScroll initialScrollEnd>
          <div ref={(node) => node && setStubScrollWidth(node.parentElement!, 1200)}>
            fresh load
          </div>
        </DragScroll>,
      );
    });
    const remounted = remountContainer.querySelector('.tool-drag-scroll');
    expect(remounted instanceof HTMLElement && remounted.scrollLeft).toBe(1200);
    act(() => {
      remountRoot.unmount();
    });
    remountContainer.remove();
  });

  it('keeps the same anchored column visible when the anchor still exists', () => {
    act(() => {
      root.render(
        <DragScroll initialScrollEnd scrollAnchorSelector="[data-scroll-anchor]">
          <div style={{ display: 'flex' }}>
            <div
              data-scroll-anchor="Spring 2020"
              ref={(node) => {
                if (node) {
                  setStubScrollWidth(node.parentElement!.parentElement!, 1000);
                  node.getBoundingClientRect = () => mockRect(120, 100);
                }
              }}
            >
              Spring
            </div>
            <div
              data-scroll-anchor="Summer 2020"
              ref={(node) => {
                if (node) {
                  node.getBoundingClientRect = () => mockRect(260, 100);
                }
              }}
            >
              Summer
            </div>
          </div>
        </DragScroll>,
      );
    });

    const el = getScrollContainer();
    el.getBoundingClientRect = () => mockRect(0, 400);
    el.scrollLeft = 100;

    act(() => {
      root.render(
        <DragScroll initialScrollEnd scrollAnchorSelector="[data-scroll-anchor]">
          <div style={{ display: 'flex' }}>
            <div
              data-scroll-anchor="Spring 2020"
              ref={(node) => {
                if (node) {
                  setStubScrollWidth(node.parentElement!.parentElement!, 1400);
                  node.getBoundingClientRect = () => mockRect(220, 100);
                }
              }}
            >
              Spring (taller)
            </div>
            <div
              data-scroll-anchor="Summer 2020"
              ref={(node) => {
                if (node) {
                  node.getBoundingClientRect = () => mockRect(360, 100);
                }
              }}
            >
              Summer
            </div>
          </div>
        </DragScroll>,
      );
    });

    expect(el.scrollLeft).toBe(200);
  });
});

function mockRect(left: number, width: number): DOMRect {
  return {
    left,
    right: left + width,
    top: 0,
    bottom: 100,
    width,
    height: 100,
    x: left,
    y: 0,
    toJSON() {
      return {};
    },
  };
}
