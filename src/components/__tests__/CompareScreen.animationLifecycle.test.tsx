import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { CompareScreen, type LastInteraction } from '../CompareScreen';
import { COMPARE_EXIT_FALLBACK_MS } from '../compareScreenH';
import { REDUCED_MOTION_QUERY } from '../usePrefersReducedMotion';
import { pickLeft } from '../../lib/engine';
import { seedConfirmation } from '../../lib/confirmationSort';
import { seedFromSublists } from '../../lib/queueMergeSort';
import type { Item, SortState } from '../../lib/types';

const A: Item = { id: 'a', label: 'A' };
const B: Item = { id: 'b', label: 'B' };
const C: Item = { id: 'c', label: 'C' };
const D: Item = { id: 'd', label: 'D' };

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function mockReducedMotion(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      expect(query).toBe(REDUCED_MOTION_QUERY);
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as unknown as MediaQueryList;
    }),
  );
}

function renderCompare(
  state: SortState,
  lastInteraction: LastInteraction,
): void {
  root.render(
    <CompareScreen
      state={state}
      lastInteraction={lastInteraction}
      onPickLeft={vi.fn()}
      onPickRight={vi.fn()}
      onHide={vi.fn()}
      onUnhide={vi.fn()}
      onCancelManualInsert={vi.fn()}
      autoInsertEnabled
    />,
  );
}

function regularStates(): [SortState, SortState] {
  const before = seedFromSublists({
    sublists: [[A], [B], [C], [D]],
    extras: [],
  });
  return [before, pickLeft(before)];
}

function confirmationStates(): [SortState, SortState] {
  const before = seedConfirmation([A, B, C, D]);
  return [before, pickLeft(before)];
}

function renderTransition(before: SortState, after: SortState): void {
  act(() => renderCompare(before, null));
  act(() =>
    renderCompare(after, {
      kind: 'pick',
      side: 'left',
    }),
  );
}

function expectTransitionFinished(): void {
  expect(container.querySelector('.compare-overlay')).toBeNull();
  expect(container.querySelector('.compare-slot--hidden')).toBeNull();
}

describe('CompareScreen animation lifecycle', () => {
  it('bypasses the regular-sort overlay when reduced motion is active', () => {
    mockReducedMotion(true);
    renderTransition(...regularStates());

    expectTransitionFinished();
  });

  it('bypasses the confirmation-sort overlay when reduced motion is active', () => {
    mockReducedMotion(true);
    renderTransition(...confirmationStates());

    expectTransitionFinished();
  });

  it('releases a regular-sort overlay when animation events never arrive', () => {
    mockReducedMotion(false);
    renderTransition(...regularStates());
    expect(container.querySelector('.compare-overlay')).not.toBeNull();

    act(() => vi.advanceTimersByTime(COMPARE_EXIT_FALLBACK_MS));

    expectTransitionFinished();
  });

  it('releases a confirmation-sort overlay when animation events never arrive', () => {
    mockReducedMotion(false);
    renderTransition(...confirmationStates());
    expect(container.querySelector('.compare-overlay')).not.toBeNull();

    act(() => vi.advanceTimersByTime(COMPARE_EXIT_FALLBACK_MS));

    expectTransitionFinished();
  });

  it('treats animation cancellation as normal overlay completion', () => {
    mockReducedMotion(false);
    renderTransition(...regularStates());
    const overlay = container.querySelector('.compare-overlay');
    const left = overlay?.querySelector('.exiting-left');
    const right = overlay?.querySelector('.exiting-right');
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();

    act(() => {
      const leftCancel = new Event('animationcancel', { bubbles: true });
      Object.defineProperty(leftCancel, 'animationName', {
        value: 'cardSlideOutLeft',
      });
      left!.dispatchEvent(leftCancel);

      const rightCancel = new Event('animationcancel', { bubbles: true });
      Object.defineProperty(rightCancel, 'animationName', {
        value: 'cardSlideOutRight',
      });
      right!.dispatchEvent(rightCancel);
    });

    expectTransitionFinished();
  });
});
