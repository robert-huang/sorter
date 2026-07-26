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
import { CompareScreen } from '../CompareScreen';
import { seedFromSublists } from '../../lib/queueMergeSort';
import { seedConfirmation } from '../../lib/confirmationSort';
import type { Item } from '../../lib/types';

const A: Item = { id: 'a', label: 'A' };
const B: Item = { id: 'b', label: 'B' };
const C: Item = { id: 'c', label: 'C' };
const D: Item = { id: 'd', label: 'D' };
const E: Item = { id: 'e', label: 'E' };
const F: Item = { id: 'f', label: 'F' };

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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function byAria(label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
}

function sublistButtonByAria(label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `.compare-confirmation-list button[aria-label="${label}"]`,
  );
}

describe('CompareScreen · left-card remove during insert', () => {
  it('shows Remove on the left (inserting) card during auto-insert', () => {
    const state = seedFromSublists({
      sublists: [[A, B, C, D, E], [F]],
      extras: [],
    });
    const onHide = vi.fn();
    act(() => {
      root.render(
        <CompareScreen
          state={state}
          lastInteraction={null}
          onPickLeft={vi.fn()}
          onPickRight={vi.fn()}
          onHide={onHide}
          onUnhide={vi.fn()}
          onCancelManualInsert={vi.fn()}
          autoInsertEnabled
        />,
      );
    });

    const btn = byAria('Remove F');
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    expect(onHide).toHaveBeenCalledWith('f');
  });
});

describe('CompareScreen · confirmation sublist remove', () => {
  it('replaces ranking controls and Remove with Restore for a hidden item', () => {
    const state = {
      ...seedConfirmation([A, B]),
      hidden: [A.id],
    };
    const onUnhide = vi.fn();
    act(() => {
      root.render(
        <CompareScreen
          state={state}
          lastInteraction={null}
          onPickLeft={vi.fn()}
          onPickRight={vi.fn()}
          onHide={vi.fn()}
          onUnhide={onUnhide}
          onCancelManualInsert={vi.fn()}
          autoInsertEnabled
        />,
      );
    });

    expect(sublistButtonByAria('Move A up')).toBeNull();
    expect(sublistButtonByAria('Move A down')).toBeNull();
    expect(sublistButtonByAria('Re-confirm A')).toBeNull();
    expect(sublistButtonByAria('Remove A')).toBeNull();

    const restoreButton = sublistButtonByAria('Restore A');
    expect(restoreButton).not.toBeNull();
    act(() => restoreButton!.click());
    expect(onUnhide).toHaveBeenCalledWith('a');
  });
});
