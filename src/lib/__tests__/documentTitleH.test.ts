import { describe, expect, it, vi } from 'vitest';
import { formatDocumentTitle, scheduleDocumentTitle } from '../documentTitleH';
import { getCompareProgress } from '../engine';
import type { MergeState } from '../types';

const doneState: MergeState = {
  engine: 'merge',
  queue: [['a']],
  current: null,
  comparisons: 290,
  done: true,
  hidden: [],
  totalComparisonsEverNeeded: 235,
  toBeInserted: [],
  pendingManualInserts: [],
  currentManualInsert: null,
  currentAutoInsert: null,
  items: { a: { id: 'a', label: 'A' } },
};

describe('scheduleDocumentTitle', () => {
  it('updates the title on the next animation frame', () => {
    let callback: FrameRequestCallback | undefined;
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((next) => {
        callback = next;
        return 17;
      });
    const cancelFrame = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {});
    document.title = 'Old title';

    const cancel = scheduleDocumentTitle('New title');

    expect(requestFrame).toHaveBeenCalledOnce();
    expect(document.title).toBe('Old title');
    callback?.(0);
    expect(document.title).toBe('New title');

    cancel();
    expect(cancelFrame).toHaveBeenCalledWith(17);
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it('forces a mutation when reasserting the current title', () => {
    let callback: FrameRequestCallback | undefined;
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((next) => {
        callback = next;
        return 18;
      });
    document.title = 'Current title';
    const titleSetter = vi.spyOn(document, 'title', 'set');

    scheduleDocumentTitle('Current title');
    callback?.(0);

    expect(titleSetter).toHaveBeenNthCalledWith(1, '');
    expect(titleSetter).toHaveBeenNthCalledWith(2, 'Current title');
    expect(document.title).toBe('Current title');

    titleSetter.mockRestore();
    requestFrame.mockRestore();
  });
});

describe('formatDocumentTitle', () => {
  it('shows checkmark when state.done is true', () => {
    const state = doneState;
    expect(getCompareProgress(state, { autoInsertEnabled: true }).pct).toBe(100);
    expect(formatDocumentTitle(state, 'My sort', { autoInsertEnabled: true })).toBe(
      'My sort ✓ — Sorter',
    );
  });

  it('shows forecast percent while in progress', () => {
    const state: MergeState = {
      engine: 'merge',
      queue: [['a']],
      current: null,
      comparisons: 289,
      done: false,
      hidden: [],
      totalComparisonsEverNeeded: 235,
      toBeInserted: [],
      pendingManualInserts: [],
      currentManualInsert: null,
      currentAutoInsert: {
        target: ['a'],
        pendingInserts: [],
        sourceSublist: ['b'],
        frame: {
          insertingId: 'b',
          lo: 0,
          hi: 0,
          probe: 0,
        },
        lastInsertedPosition: null,
      },
      items: {
        a: { id: 'a', label: 'A' },
        b: { id: 'b', label: 'B' },
      },
    };
    const { pct } = getCompareProgress(state, { autoInsertEnabled: true });
    expect(pct).toBeLessThan(100);
    expect(formatDocumentTitle(state, 'My sort', { autoInsertEnabled: true })).toBe(
      `My sort (${pct}%) — Sorter`,
    );
  });
});
