import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useDragScroll } from '../useDragScroll';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

  if (typeof globalThis.PointerEvent === 'undefined') {
    class MockPointerEvent extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 0;
      }
    }
    globalThis.PointerEvent = MockPointerEvent as typeof PointerEvent;
  }
});

let container: HTMLDivElement;
let root: Root;

function DragScrollHarness(): React.ReactElement {
  const { ref, ...dragProps } = useDragScroll<HTMLDivElement>();
  return (
    <div ref={ref} className="tool-drag-scroll" {...dragProps}>
      <div data-testid="inner">content</div>
    </div>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function getScrollEl(): HTMLElement {
  const el = container.querySelector('.tool-drag-scroll');
  if (!(el instanceof HTMLElement)) {
    throw new Error('scroll container not found');
  }
  return el;
}

function pointer(
  type: string,
  target: EventTarget,
  clientX: number,
  clientY = 0,
  pointerId = 1,
): void {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    pointerId,
    button: 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    pointerType: 'mouse',
    isPrimary: true,
  });
  target.dispatchEvent(event);
}

describe('useDragScroll', () => {
  it('removes the dragging class when pointerup fires on window after an outside release', () => {
    act(() => {
      root.render(<DragScrollHarness />);
    });

    const el = getScrollEl();
    el.scrollLeft = 0;
    Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 1000 });
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 200 });

    pointer('pointerdown', el, 10);
    pointer('pointermove', el, 30);
    expect(el.classList.contains('is-drag-scroll-dragging')).toBe(true);

    act(() => {
      pointer('pointerup', window, 30);
    });

    expect(el.classList.contains('is-drag-scroll-dragging')).toBe(false);
  });

  it('removes the dragging class on lostpointercapture', () => {
    act(() => {
      root.render(<DragScrollHarness />);
    });

    const el = getScrollEl();
    pointer('pointerdown', el, 10);
    pointer('pointermove', el, 30);
    expect(el.classList.contains('is-drag-scroll-dragging')).toBe(true);

    act(() => {
      pointer('lostpointercapture', el, 30);
    });

    expect(el.classList.contains('is-drag-scroll-dragging')).toBe(false);
  });
});
