import { describe, expect, it } from 'vitest';
import { formatDocumentTitle, pickDocumentTitleState } from '../documentTitleH';
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

const inProgressState: MergeState = {
  ...doneState,
  comparisons: 90,
  done: false,
};

describe('pickDocumentTitleState', () => {
  it('keeps a completed in-memory session over a stale in-progress candidate', () => {
    expect(pickDocumentTitleState(inProgressState, doneState)).toBe(doneState);
  });

  it('keeps a further-along in-progress session', () => {
    const ahead: MergeState = { ...inProgressState, comparisons: 120 };
    const behind: MergeState = { ...inProgressState, comparisons: 90 };
    expect(pickDocumentTitleState(behind, ahead)).toBe(ahead);
  });

  it('accepts a candidate that advances the committed session', () => {
    const next: MergeState = { ...inProgressState, comparisons: 120 };
    expect(pickDocumentTitleState(next, inProgressState)).toBe(next);
  });

  it('keeps a completed committed title over a later stale in-progress candidate', () => {
    const stale: MergeState = { ...doneState, comparisons: 289, done: false };
    expect(pickDocumentTitleState(stale, doneState)).toBe(doneState);
  });

  it('accepts an intentional undo to a lower comparison count', () => {
    const restored: MergeState = { ...inProgressState, comparisons: 89 };
    expect(pickDocumentTitleState(restored, inProgressState, true)).toBe(restored);
  });

  it('accepts an intentional undo from completed to in progress', () => {
    expect(pickDocumentTitleState(inProgressState, doneState, true)).toBe(
      inProgressState,
    );
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
