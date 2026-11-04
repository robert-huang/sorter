import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedSectionResort } from '../../lib/completedSortEditH';
import { hideItem } from '../../lib/engine';
import { seedAsDoneMerge } from '../../lib/queueMergeSort';
import type { Item, SortState } from '../../lib/types';
import { ListScreen } from '../ListScreen';
import { ResultScreen } from '../ResultScreen';
import { nextRangeForClick, SectionResortModal } from '../SectionResortModal';

const ITEMS: Item[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
  id,
  label: id.toUpperCase(),
}));

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === text,
  );
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.section-resort-row'));
}

function summary(): string {
  return document.querySelector('.section-resort-summary')?.textContent ?? '';
}

function typeRank(id: string, value: string): void {
  const input = document.getElementById(id) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pressKey(id: string, key: string): void {
  const input = document.getElementById(id) as HTMLInputElement;
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('nextRangeForClick', () => {
  it('starts a new range on click and extends it on shift-click in either direction', () => {
    expect(nextRangeForClick(null, 3, false)).toEqual({ start: 3, end: 3 });
    expect(nextRangeForClick(null, 3, true)).toEqual({ start: 3, end: 3 });
    expect(nextRangeForClick({ start: 3, end: 3 }, 5, true)).toEqual({ start: 3, end: 5 });
    expect(nextRangeForClick({ start: 3, end: 5 }, 1, true)).toEqual({ start: 1, end: 5 });
    expect(nextRangeForClick({ start: 1, end: 5 }, 2, false)).toEqual({ start: 2, end: 2 });
  });
});

describe('SectionResortModal', () => {
  function renderModal(onStart = vi.fn(), onCancel = vi.fn()) {
    act(() => {
      root.render(<SectionResortModal ranking={ITEMS} onStart={onStart} onCancel={onCancel} />);
    });
    return { onStart, onCancel };
  }

  it('picks a range with click and shift-click and starts each method with it', () => {
    const { onStart } = renderModal();
    expect(rows()).toHaveLength(6);
    expect(buttonByText('Merge sort')?.disabled).toBe(true);
    expect(buttonByText('Confirm order')?.disabled).toBe(true);

    act(() => rows()[1]!.click());
    expect(summary()).toContain('Ranks 2–2 · 1 item');
    expect(summary()).toContain('pick at least 2');
    expect(buttonByText('Merge sort')?.disabled).toBe(true);

    act(() => rows()[4]!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(summary()).toContain('Ranks 2–5 · 4 items');
    expect(rows().filter((r) => r.classList.contains('selected'))).toHaveLength(4);
    expect((document.getElementById('section-resort-from') as HTMLInputElement).value).toBe('2');
    expect((document.getElementById('section-resort-to') as HTMLInputElement).value).toBe('5');

    act(() => buttonByText('Merge sort')!.click());
    expect(onStart).toHaveBeenLastCalledWith(1, 4, 'merge');
    act(() => buttonByText('Confirm order')!.click());
    expect(onStart).toHaveBeenLastCalledWith(1, 4, 'confirm');
  });

  it('rank inputs set the range, clamp, step with arrow keys and stay in sync with clicks', () => {
    const { onStart } = renderModal();
    typeRank('section-resort-from', '3');
    typeRank('section-resort-to', '99');
    expect(summary()).toContain('Ranks 3–6 · 4 items');
    pressKey('section-resort-from', 'ArrowDown');
    expect(summary()).toContain('Ranks 2–6');
    pressKey('section-resort-to', 'ArrowDown');
    expect(summary()).toContain('Ranks 2–5');
    typeRank('section-resort-to', '1');
    expect(summary()).toContain('Ranks 1–1');
    act(() => rows()[5]!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect((document.getElementById('section-resort-to') as HTMLInputElement).value).toBe('6');
    act(() => buttonByText('Merge sort')!.click());
    expect(onStart).toHaveBeenCalledWith(0, 5, 'merge');
  });

  it('cancel closes without starting', () => {
    const { onStart, onCancel } = renderModal();
    act(() => buttonByText('Cancel')!.click());
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onStart).not.toHaveBeenCalled();
  });
});

function resultProps(state: SortState, onStartSectionResort = vi.fn()) {
  return {
    state,
    dbSyncRevision: 0,
    onUnhide: vi.fn(),
    onRestoreHidden: vi.fn(),
    onForgetHidden: vi.fn(),
    onStartOver: vi.fn(),
    onConfirmSort: vi.fn(),
    onAddOne: vi.fn(),
    onAddMany: vi.fn(),
    onAddSlotImports: vi.fn(),
    onStartSectionResort,
    onCancelSectionResort: vi.fn(),
  };
}

describe('RESULT entry point', () => {
  it('sits between + Add items and Confirm sort and opens the picker', () => {
    const onStart = vi.fn();
    act(() => {
      root.render(<ResultScreen {...resultProps(seedAsDoneMerge(ITEMS), onStart)} />);
    });
    const labels = Array.from(container.querySelectorAll('.result-bottom button')).map((b) =>
      b.textContent?.trim(),
    );
    expect(labels.slice(0, 3)).toEqual(['+ Add items', 'Re-sort a section', 'Confirm sort']);
    act(() => buttonByText('Re-sort a section')!.click());
    act(() => rows()[0]!.click());
    act(() => rows()[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    act(() => buttonByText('Merge sort')!.click());
    expect(onStart).toHaveBeenCalledWith(0, 2, 'merge');
    expect(rows()).toHaveLength(0);
  });

  it('shows the re-sort label and Cancel while a section is in progress', () => {
    const s = seedSectionResort(seedAsDoneMerge(ITEMS), 1, 3, 'merge', {})!;
    const props = resultProps(s);
    act(() => root.render(<ResultScreen {...props} />));
    expect(container.textContent).toContain('Re-sorting ranks 2–4');
    act(() => buttonByText('Cancel re-sort')!.click());
    expect(props.onCancelSectionResort).toHaveBeenCalledOnce();
  });
});

function listProps(state: SortState, overrides: Record<string, unknown> = {}) {
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
    onForget: vi.fn(),
    onReorderInSorted: vi.fn(),
    onReturnToPending: vi.fn(),
    onDismissHidden: vi.fn(),
    onRestoreHidden: vi.fn(),
    onReinsertHidden: vi.fn(),
    onForgetHidden: vi.fn(),
    onEditItem: vi.fn(),
    onStartSectionResort: vi.fn(),
    onMoveFrozen: vi.fn(),
    onCancelSectionResort: vi.fn(),
    ...overrides,
  };
}

function frozenRowFor(label: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>('.section-frozen .queue-item-row')).find(
    (r) => r.querySelector('.label-cell')?.textContent === label,
  );
  if (!row) throw new Error(`no frozen row ${label}`);
  return row;
}

function rowButton(row: HTMLElement, title: string): HTMLButtonElement {
  const button = Array.from(row.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.title === title,
  );
  if (!button) throw new Error(`no button "${title}"`);
  return button;
}

describe('LIST during a section re-sort', () => {
  it('has the entry button next to + Add item(s) on a finished ranking', () => {
    const props = listProps(seedAsDoneMerge(ITEMS));
    act(() => root.render(<ListScreen {...props} />));
    const labels = Array.from(container.querySelectorAll('.add-buttons button')).map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).toEqual(['+ Add item(s)', 'Re-sort a section']);
    act(() => buttonByText('Re-sort a section')!.click());
    expect(rows()).toHaveLength(6);
  });

  it('shows dimmed frozen rows with move, ↻, remove and edit, moves stopping at the range', () => {
    const s = seedSectionResort(seedAsDoneMerge(ITEMS), 2, 3, 'merge', {})!;
    const props = listProps(s);
    act(() => root.render(<ListScreen {...props} />));
    expect(container.textContent).toContain('Re-sorting ranks 3–4');
    expect(buttonByText('Re-sort a section')).toBeUndefined();

    const a = frozenRowFor('A');
    const b = frozenRowFor('B');
    const e = frozenRowFor('E');
    const f = frozenRowFor('F');
    expect(a.querySelector('.rank')?.textContent).toBe('1.');
    expect(e.querySelector('.rank')?.textContent).toBe('5.');
    expect(rowButton(a, 'Nudge up').disabled).toBe(true);
    expect(rowButton(b, 'Nudge down').disabled).toBe(true);
    expect(rowButton(e, 'Nudge up').disabled).toBe(true);
    expect(rowButton(f, 'Nudge down').disabled).toBe(true);

    act(() => rowButton(a, 'Nudge down').click());
    expect(props.onMoveFrozen).toHaveBeenCalledWith('a', 1);
    act(() => rowButton(f, 'Move into the re-sort').click());
    expect(props.onReturnToPending).toHaveBeenCalledWith('f');
    act(() => e.querySelector<HTMLButtonElement>('button.icon-btn.danger')!.click());
    expect(props.onHide).toHaveBeenCalledWith('e');
    act(() => rowButton(b, 'Edit "B"').click());
    expect(document.body.textContent).toContain('Edit');

    act(() => buttonByText('Cancel re-sort')!.click());
    expect(props.onCancelSectionResort).toHaveBeenCalledOnce();
  });

  it('splits into the full ranking with a range slot on the left and the live re-sort on the right', () => {
    const s = seedSectionResort(seedAsDoneMerge(ITEMS), 2, 3, 'merge', {})!;
    act(() => root.render(<ListScreen {...listProps(s)} />));

    const left = container.querySelector('.section-resort-split .section-resort-full')!;
    const right = container.querySelector('.section-resort-split .section-live')!;
    expect(left.querySelector('.list-merge-context-heading')?.textContent).toBe(
      'Full ranking (6)',
    );
    const leftOrder = Array.from(
      left.querySelectorAll('.label-cell, .section-resort-slot-ranks'),
    ).map((el) => el.textContent);
    expect(leftOrder).toEqual(['A', 'B', 'Ranks 3–4', 'E', 'F']);
    expect(left.querySelector('.section-resort-slot')?.textContent).toContain(
      '2 items being re-sorted',
    );

    expect(right.querySelector('.list-merge-context-heading')?.textContent).toBe(
      'Re-sorting ranks 3–4',
    );
    expect(right.textContent).toContain('C');
    expect(right.textContent).toContain('D');
    expect(right.querySelector('.section-frozen')).toBeNull();
  });

  it('offers both Restore and Reinsert for a hidden frozen item', () => {
    let s = seedSectionResort(seedAsDoneMerge(ITEMS), 2, 3, 'merge', {})!;
    s = hideItem(s, 'a', {});
    const props = listProps(s);
    act(() => root.render(<ListScreen {...props} />));
    const hiddenRow = Array.from(
      container.querySelectorAll<HTMLElement>('.list-removed-during-sort .queue-item-row'),
    ).find((r) => r.querySelector('.label-cell')?.textContent?.startsWith('A'))!;
    act(() => rowButton(hiddenRow, 'Restore at its rank outside the re-sort').click());
    expect(props.onUnhide).toHaveBeenCalledWith('a');
    act(() => rowButton(hiddenRow, 'Move into the re-sort').click());
    expect(props.onReinsertHidden).toHaveBeenCalledWith('a');
  });
});
