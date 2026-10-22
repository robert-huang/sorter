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
      readonly pointerType: string;

      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 0;
        this.pointerType = params.pointerType ?? '';
      }
    }
    globalThis.PointerEvent = MockPointerEvent as typeof PointerEvent;
  }
});

let container: HTMLDivElement;
let root: Root;

function DragScrollHarness({
  onDragChange,
}: {
  onDragChange?: (dragging: boolean) => void;
}): React.ReactElement {
  const { ref, ...dragProps } = useDragScroll<HTMLDivElement>(
    undefined,
    onDragChange,
  );
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
  pointerType = 'mouse',
): void {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    pointerId,
    button: 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    pointerType,
    isPrimary: true,
  });
  target.dispatchEvent(event);
}

describe('useDragScroll', () => {
  it('removes the dragging class when pointerup fires on window after an outside release', () => {
    const dragChanges: boolean[] = [];
    act(() => {
      root.render(
        <DragScrollHarness
          onDragChange={(dragging) => dragChanges.push(dragging)}
        />,
      );
    });

    const el = getScrollEl();
    el.scrollLeft = 0;
    Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 1000 });
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 200 });

    pointer('pointerdown', el, 10);
    pointer('pointermove', el, 30);
    expect(el.classList.contains('is-drag-scroll-dragging')).toBe(true);
    expect(dragChanges).toEqual([true]);

    act(() => {
      pointer('pointerup', window, 30);
    });

    expect(el.classList.contains('is-drag-scroll-dragging')).toBe(false);
    expect(dragChanges).toEqual([true, false]);
  });

  it('leaves touch panning to the browser', () => {
    const dragChanges: boolean[] = [];
    act(() => {
      root.render(
        <DragScrollHarness
          onDragChange={(dragging) => dragChanges.push(dragging)}
        />,
      );
    });

    const el = getScrollEl();
    el.scrollLeft = 100;
    pointer('pointerdown', el, 10, 0, 1, 'touch');
    pointer('pointermove', el, 60, 0, 1, 'touch');

    expect(el.classList.contains('is-drag-scroll-dragging')).toBe(false);
    expect(el.scrollLeft).toBe(100);
    expect(dragChanges).toEqual([]);
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
