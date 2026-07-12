import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListScreen } from '../ListScreen';
import { buildInsertionState, hideItem } from '../../lib/insertionSort';
import {
  hideItem as mergeHideItem,
  seedAsDoneMerge,
  seedFromSublists,
} from '../../lib/queueMergeSort';
import { activeRankingIds, rankingSlotIds } from '../../lib/sortPopulation';
import type { InsertionState, Item, SortState } from '../../lib/types';

// Bare createRoot/act harness — same style as StagedItemsPanel.test.tsx,
// no react-testing-library.

const A: Item = { id: 'a', label: 'A' };
const B: Item = { id: 'b', label: 'B' };
const C: Item = { id: 'c', label: 'C' };
const D: Item = { id: 'd', label: 'D' };
const E: Item = { id: 'e', label: 'E' };
const F: Item = { id: 'f', label: 'F' };
const X: Item = { id: 'x', label: 'X' };

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

/** Fill every ListScreen callback with a spy; override as needed per test. */
function makeProps(
  state: SortState,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    state,
    dbSyncRevision: 0,
    slotId: 'slot-1',
    slotName: 'My Sort',
    onRenameSlot: vi.fn(),
    onHide: vi.fn(),
    onUnhide: vi.fn(),
    onReorder: vi.fn(),
    onReorderInCurrentMerge: vi.fn(),
    onReorderInsertTarget: vi.fn(),
    onBreakApart: vi.fn(),
    onAddItem: vi.fn(),
    onAddItems: vi.fn(),
    onAppendPreRanked: vi.fn(),
    onAddSlotImports: vi.fn(),
    onManualInsert: vi.fn(),
    onForget: vi.fn(),
    onReorderInSorted: vi.fn(),
    onReturnToPending: vi.fn(),
    onDismissHidden: vi.fn(),
    onRestoreHidden: vi.fn(),
    onReinsertHidden: vi.fn(),
    onForgetHidden: vi.fn(),
    onEditItem: vi.fn(),
    ...overrides,
  };
}

function renderList(props: ReturnType<typeof makeProps>): void {
  act(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root.render(<ListScreen {...(props as any)} />);
  });
}

function byAria(label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
}

describe('ListScreen · insert-context LIST-tab controls (merge auto-insert)', () => {
  // K=1 into N=5 → auto-insert F into [a,b,c,d,e].
  function autoInsertState(): SortState {
    return seedFromSublists({ sublists: [[A, B, C, D, E], [F]], extras: [] });
  }

  it('drops the in-flight inserting item via the × in "Inserting"', () => {
    const onHide = vi.fn();
    renderList(makeProps(autoInsertState(), { onHide }));

    const btn = byAria('Remove F');
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    expect(onHide).toHaveBeenCalledWith('f');
  });

  it('removes a target row via its × (drops from the list being inserted into)', () => {
    const onHide = vi.fn();
    renderList(makeProps(autoInsertState(), { onHide }));

    const btn = byAria('Remove A');
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    expect(onHide).toHaveBeenCalledWith('a');
  });

  it('reorders a target row via ↓, passing absolute indices to swap', () => {
    const onReorderInsertTarget = vi.fn();
    renderList(makeProps(autoInsertState(), { onReorderInsertTarget }));

    // A is at absolute index 0; nudging it down swaps with B at index 1.
    const btn = byAria('Move A down');
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    expect(onReorderInsertTarget).toHaveBeenCalledWith(0, 1);
  });

  it('disables ↑ on the first target row and ↓ on the last', () => {
    renderList(makeProps(autoInsertState()));
    expect(byAria('Move A up')!.disabled).toBe(true);
    expect(byAria('Move E down')!.disabled).toBe(true);
  });
});

describe('ListScreen · insert-context LIST-tab controls (insertion engine)', () => {
  // Mid-insert: X is binary-inserting into a frozen [a,b,c,d,e].
  function insertionState(): SortState {
    return buildInsertionState({
      sortedItems: [A, B, C, D, E],
      pendingItems: [X],
    }).state;
  }

  it('drops the in-flight inserting item via the × in "Inserting"', () => {
    const onHide = vi.fn();
    renderList(makeProps(insertionState(), { onHide }));

    const btn = byAria('Remove X');
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    expect(onHide).toHaveBeenCalledWith('x');
  });

  it('removes a target row via its × in "Inserting into"', () => {
    const onHide = vi.fn();
    renderList(makeProps(insertionState(), { onHide }));

    const btn = byAria('Remove A');
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    expect(onHide).toHaveBeenCalledWith('a');
  });

  it('reorders a target row via ↓ in "Inserting into"', () => {
    const onReorderInSorted = vi.fn();
    renderList(makeProps(insertionState(), { onReorderInSorted }));

    const btn = byAria('Move A down');
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    expect(onReorderInSorted).toHaveBeenCalledWith(0, 1);
  });

  it('pulls a target row back out via ↻ in "Inserting into"', () => {
    const onReturnToPending = vi.fn();
    renderList(makeProps(insertionState(), { onReturnToPending }));

    const sortedSection = container.querySelector('.list-merging');
    const reinsertBtn = sortedSection?.querySelector(
      'button[title="Pull this item back out and re-insert it (fresh binary search)"]',
    );
    expect(reinsertBtn).not.toBeNull();
    act(() => reinsertBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onReturnToPending).toHaveBeenCalledWith('a');
  });

  it('omits inline ↺ Restore on in-slot hidden rows while sort is active', () => {
    const hidden = hideItem(insertionState() as InsertionState, 'b');
    renderList(makeProps(hidden));

    expect(container.querySelectorAll('button[title="Restore"]')).toHaveLength(0);
    expect(container.textContent).toContain('↻ Reinsert');
  });

  it('shows ↺ Restore on hidden rows when the sort is done', () => {
    const base = buildInsertionState({
      sortedItems: [A, B, C],
      pendingItems: [],
    }).state;
    const done = hideItem(
      { ...base, done: true, pending: [], current: null } as InsertionState,
      'b',
    );
    renderList(makeProps(done));

    expect(container.querySelector('button[title="Restore"]')).not.toBeNull();
    const hiddenSection = container.querySelector('.list-removed-during-sort');
    expect(hiddenSection?.textContent).toContain('↺ Restore');
    expect(
      hiddenSection?.querySelector('button[title="Restore at old rank"]'),
    ).not.toBeNull();
    expect(
      hiddenSection?.querySelector('button[title="Pull out and binary-insert again"]'),
    ).toBeNull();
  });
});

describe('ListScreen · hidden panel on completed merge sort', () => {
  it('shows ↺ Restore (onUnhide) for in-ranking hidden rows when done', () => {
    const done = mergeHideItem(seedAsDoneMerge([A, B, C]), 'b');
    const onUnhide = vi.fn();
    const onReinsertHidden = vi.fn();
    renderList(
      makeProps(done, { onUnhide, onReinsertHidden }),
    );

    const hiddenSection = container.querySelector('.list-removed-during-sort');
    expect(hiddenSection?.textContent).toContain('↺ Restore');
    const restoreBtn = hiddenSection?.querySelector(
      'button[title="Restore at old rank"]',
    );
    expect(restoreBtn).not.toBeNull();
    act(() => restoreBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onUnhide).toHaveBeenCalledWith('b');
    expect(onReinsertHidden).not.toHaveBeenCalled();
  });
});

describe('ListScreen · to-be-inserted section (merge)', () => {
  const G: Item = { id: 'g', label: 'G' };

  it('removes a to-be-inserted row via × (onHide → Hidden items)', () => {
    const base = seedAsDoneMerge([A, B, C, D, E, F]);
    const s: SortState = {
      ...base,
      toBeInserted: ['g'],
      items: { ...base.items, g: G },
    };

    const onHide = vi.fn();
    renderList(makeProps(s, { onHide }));

    expect(container.textContent).toContain('To be inserted');
    const btn = byAria('Remove G');
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    expect(onHide).toHaveBeenCalledWith('g');
  });
});

describe('ListScreen · hidden panel during auto-insert', () => {
  it('↻ Reinsert calls onReinsertHidden for a probe not in rankingSlotIds', () => {
    const state = mergeHideItem(
      seedFromSublists({ sublists: [[A, B, C, D, E], [F]], extras: [] }),
      'c',
    );
    expect(state.currentAutoInsert).not.toBeNull();
    expect(rankingSlotIds(state).has('c')).toBe(false);
    expect(activeRankingIds(state).has('c')).toBe(true);

    const onReinsertHidden = vi.fn();
    const onRestoreHidden = vi.fn();
    renderList(
      makeProps(state, { onReinsertHidden, onRestoreHidden }),
    );

    const hiddenSection = container.querySelector('.list-removed-during-sort');
    const reinsertBtn = hiddenSection?.querySelector(
      'button[title="Pull out and binary-insert again"]',
    );
    expect(reinsertBtn).not.toBeNull();
    act(() => reinsertBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onReinsertHidden).toHaveBeenCalledWith('c');
    expect(onRestoreHidden).not.toHaveBeenCalled();
  });
});
