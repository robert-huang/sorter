import { describe, expect, it } from 'vitest';
import { formatDocumentTitle } from '../documentTitleH';
import { getCompareProgress } from '../engine';
import type { MergeState } from '../types';

describe('formatDocumentTitle', () => {
  it('shows checkmark when state.done is true', () => {
    const state: MergeState = {
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
