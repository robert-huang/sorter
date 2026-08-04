import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initSort, seedAsDoneMerge } from '../../lib/queueMergeSort';
import type { Item, SortState } from '../../lib/types';
import { ConfirmSortConfirmModal } from '../ConfirmSortConfirmModal';
import { ResultScreen } from '../ResultScreen';

const A: Item = { id: 'a', label: 'A' };
const B: Item = { id: 'b', label: 'B' };

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function resultProps(state: SortState, onConfirmSort = vi.fn()) {
  return {
    state,
    dbSyncRevision: 0,
    slotName: 'Favourites',
    slotId: 'slot-1',
    onUnhide: vi.fn(),
    onRestoreHidden: vi.fn(),
    onForgetHidden: vi.fn(),
    onStartOver: vi.fn(),
    onConfirmSort,
    onAddOne: vi.fn(),
    onAddMany: vi.fn(),
    onAddPreRanked: vi.fn(),
    onAddSlotImports: vi.fn(),
  };
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === text,
  );
}

describe('ResultScreen Confirm sort entry point', () => {
  it('shows the completed-slot action with an explanatory tooltip', () => {
    const onConfirmSort = vi.fn();
    act(() => {
      root.render(
        <ResultScreen
          {...resultProps(seedAsDoneMerge([A, B]), onConfirmSort)}
        />,
      );
    });

    const button = buttonByText('Confirm sort');
    expect(button).toBeDefined();
    expect(button?.title).toContain('Start a new confirmation sort slot to verify this ranking from top to bottom');

    act(() => button?.click());
    expect(onConfirmSort).toHaveBeenCalledOnce();
  });

  it('does not show the action while the sort is unfinished', () => {
    act(() => {
      root.render(<ResultScreen {...resultProps(initSort([A, B]))} />);
    });

    expect(buttonByText('Confirm sort')).toBeUndefined();
  });
});

describe('ConfirmSortConfirmModal', () => {
  it('explains the new confirmation slot and confirms', () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        <ConfirmSortConfirmModal
          itemCount={2}
          slotName="Favourites"
          onConfirm={onConfirm}
          onCancel={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain('Favourites (confirm)');
    expect(container.textContent).toContain('binary-inserted');
    const confirmButton = buttonByText('Create confirmation slot');
    act(() => confirmButton?.click());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('can be cancelled without confirming', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        <ConfirmSortConfirmModal
          itemCount={2}
          slotName="Favourites"
          onConfirm={onConfirm}
          onCancel={onCancel}
        />,
      );
    });

    act(() => buttonByText('Cancel')?.click());
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
