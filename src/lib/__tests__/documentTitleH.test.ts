import { describe, expect, it } from 'vitest';
import { formatDocumentTitle, shouldAdvanceTitleState } from '../documentTitleH';
import { getCompareProgress } from '../engine';
import type { MergeState } from '../types';

const done290: MergeState = {
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

const penult289: MergeState = {
  ...done290,
  done: false,
  comparisons: 289,
  currentAutoInsert: done290.currentAutoInsert,
};

describe('shouldAdvanceTitleState', () => {
  it('blocks stale render one comparison behind a done pick', () => {
    expect(shouldAdvanceTitleState(penult289, done290)).toBe(false);
  });

  it('allows committed completion to catch up', () => {
    expect(shouldAdvanceTitleState(done290, penult289)).toBe(true);
    expect(shouldAdvanceTitleState(done290, done290)).toBe(false);
  });

  it('allows leaving completed via add-item (same comparisons, not done)', () => {
    const reopened = { ...done290, done: false };
    expect(shouldAdvanceTitleState(reopened, done290)).toBe(true);
  });
});

describe('formatDocumentTitle', () => {
  it('shows checkmark when state.done is true', () => {
    expect(getCompareProgress(done290, { autoInsertEnabled: true }).pct).toBe(100);
    expect(formatDocumentTitle(done290, 'My sort', { autoInsertEnabled: true })).toBe(
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
