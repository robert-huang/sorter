import { describe, expect, it } from 'vitest';
import {
  adoptInsertFrameResult,
  applyInsertPick,
  getInsertPair,
  skipHiddenInsertProbes,
  visibleInsertWindowEndpoints,
} from '../binaryInsertion';
import {
  buildInsertionState,
  getPair as getInsertionPair,
  getPeekRightIds as getInsertionPeekRightIds,
  getRanking as getInsertionRanking,
  hideItem as hideInsertionItem,
  pickLeft as pickInsertionLeft,
  pickRight as pickInsertionRight,
} from '../insertionSort';
import {
  normalizeLoadedState,
} from '../engine';
import {
  getInsertContext,
} from '../../components/listScreenH';
import {
  getPair,
  getPeekRightIds,
  hideItem,
  pickLeft,
  pickRight,
  seedFromSublists,
} from '../queueMergeSort';
import type { InsertFrame, Item, ItemId, MergeState } from '../types';

const A: Item = { id: 'a', label: 'A' };
const B: Item = { id: 'b', label: 'B' };
const C: Item = { id: 'c', label: 'C' };
const D: Item = { id: 'd', label: 'D' };
const E: Item = { id: 'e', label: 'E' };
const F: Item = { id: 'f', label: 'F' };
const G: Item = { id: 'g', label: 'G' };
const H: Item = { id: 'h', label: 'H' };
const X: Item = { id: 'x', label: 'X' };
const Y: Item = { id: 'y', label: 'Y' };

function isDone(
  r: ReturnType<typeof skipHiddenInsertProbes>,
): r is { done: true; position: number } {
  return 'done' in r && r.done === true;
}

/** Stored frame.probe must index a visible target id, not a ghost slot. */
function expectStoredProbeVisible(
  frame: InsertFrame | null | undefined,
  target: readonly string[],
  hidden: readonly string[],
): void {
  if (!frame) return;
  const hiddenSet = new Set(hidden);
  expect(frame.probe).toBeGreaterThanOrEqual(0);
  expect(frame.probe).toBeLessThan(target.length);
  expect(hiddenSet.has(target[frame.probe]!)).toBe(false);
}

function runMergeUntil(
  initial: MergeState,
  desiredOrder: string[],
): MergeState {
  const rank = new Map(desiredOrder.map((id, i) => [id, i]));
  let s = initial;
  let safety = 500;
  while (!s.done && safety-- > 0) {
    const pair = getPair(s);
    if (!pair) break;
    const leftRank = rank.get(pair.leftId) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(pair.rightId) ?? Number.MAX_SAFE_INTEGER;
    s = leftRank <= rightRank ? pickLeft(s) : pickRight(s);
  }
  return s;
}

function runInsertionUntil(
  initial: ReturnType<typeof buildInsertionState>['state'],
  desiredOrder: string[],
) {
  const rank = new Map(desiredOrder.map((id, i) => [id, i]));
  let s = initial;
  let safety = 500;
  while (!s.done && safety-- > 0) {
    const pair = getInsertionPair(s);
    if (!pair) break;
    const leftRank = rank.get(pair.leftId) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(pair.rightId) ?? Number.MAX_SAFE_INTEGER;
    s = leftRank <= rightRank ? pickInsertionLeft(s) : pickInsertionRight(s);
  }
  return s;
}

describe('adoptInsertFrameResult', () => {
  it('returns a visible frame when the stored probe indexes a hidden id', () => {
    const sorted = ['a', 'b', 'hidden', 'd', 'e'];
    const hidden = new Set(['hidden']);
    const stalled: InsertFrame = { insertingId: 'x', lo: 2, hi: 4, probe: 2 };

    let donePosition: number | null = null;
    const frame = adoptInsertFrameResult(stalled, sorted, hidden, (pos) => {
      donePosition = pos;
    });
    expect(donePosition).toBeNull();
    expect(frame).not.toBeNull();
    expect(hidden.has(sorted[frame!.probe])).toBe(false);
    expect(getInsertPair(frame!, sorted)).not.toBeNull();
  });

  it('adopts after applyInsertPick when the raw next probe would be hidden', () => {
    const sorted = ['a', 'b', 'c', 'hidden', 'e'];
    const hidden = new Set(['hidden']);
    const afterPick = applyInsertPick(
      { insertingId: 'x', lo: 2, hi: 4, probe: 2 },
      'sorted',
      sorted.length,
    );
    expect(isDone(afterPick)).toBe(false);
    if (isDone(afterPick)) return;
    expect(sorted[afterPick.probe]).toBe('hidden');

    let donePosition: number | null = null;
    const frame = adoptInsertFrameResult(afterPick, sorted, hidden, (pos) => {
      donePosition = pos;
    });
    expect(donePosition).toBeNull();
    expect(frame).not.toBeNull();
    expect(hidden.has(sorted[frame!.probe])).toBe(false);
  });

  it('splices via onDone when every candidate in range is hidden', () => {
    const sorted = ['a', 'b', 'hidden', 'also-hidden', 'e'];
    const hidden = new Set(['hidden', 'also-hidden']);
    const frame: InsertFrame = { insertingId: 'x', lo: 2, hi: 3, probe: 2 };
    let donePosition: number | null = null;
    const next = adoptInsertFrameResult(frame, sorted, hidden, (pos) => {
      donePosition = pos;
    });
    expect(next).toBeNull();
    expect(donePosition).toBe(4);
  });
});

describe('hidden insert frame invariants (merge auto-insert)', () => {
  it('pickLeft does not stall when the next probe would be hidden', () => {
    let s = seedFromSublists({ sublists: [[A, B, C, D, E], [F]], extras: [] });
    s = hideItem(s, 'd');
    s = pickLeft(s);
    expect(getPair(s)).not.toBeNull();
    expectStoredProbeVisible(
      s.currentAutoInsert?.frame,
      s.currentAutoInsert!.target,
      s.hidden,
    );
  });

  it('drains the next pending insert when rank-aware start lands on a hidden probe', () => {
    const items: Item[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => ({
      id,
      label: id.toUpperCase(),
    }));
    let s = seedFromSublists({ sublists: [items, [X, Y]], extras: [] });
    s = hideItem(s, 'f');
    s = hideItem(s, 'g');
    // Oracle: X between e and f; Y after h (append).
    s = runMergeUntil(s, ['a', 'b', 'c', 'd', 'e', 'x', 'f', 'h', 'y', 'g']);
    expect(s.done).toBe(true);
    expect(s.currentAutoInsert).toBeNull();
    expect(s.queue[0]).toContain('x');
    expect(s.queue[0]).toContain('y');
    expect(s.hidden).toEqual(expect.arrayContaining(['f', 'g']));
    expect(s.queue[0]).not.toContain('f');
    expect(s.queue[0]).not.toContain('g');
  });

  it('keeps peek-right ids off hidden probes during auto-insert', () => {
    let s = seedFromSublists({ sublists: [[A, B, C, D, E], [F]], extras: [] });
    s = hideItem(s, 'd');
    const peek = getPeekRightIds(s, 3);
    expect(peek.every((id) => !s.hidden.includes(id))).toBe(true);
    expect(getPair(s)).not.toBeNull();
  });

  it('exposes insert context with a visible probe while endpoints are hidden', () => {
    let s = seedFromSublists({ sublists: [[A, B, C, D, E], [F]], extras: [] });
    s = hideItem(s, 'a');
    s = hideItem(s, 'e');
    const ctx = getInsertContext(s);
    expect(ctx).not.toBeNull();
    expect(ctx!.probeId).toBe('c');
    expect(s.hidden.includes(ctx!.probeId)).toBe(false);
    expect(getPair(s)).not.toBeNull();
    const ends = visibleInsertWindowEndpoints(
      s.currentAutoInsert!.frame!,
      s.currentAutoInsert!.target,
      new Set(s.hidden),
    );
    expect(s.hidden.includes(ends.loId!)).toBe(false);
    expect(s.hidden.includes(ends.hiId!)).toBe(false);
  });
});

describe('hidden insert frame invariants (merge manual-insert)', () => {
  it('pickRight does not stall when the next probe would be hidden', () => {
    const stalled: MergeState = {
      engine: 'merge',
      queue: [['a', 'b', 'c', 'f', 'hidden', 'e', 'h']],
      current: null,
      currentManualInsert: {
        insertingId: 'g',
        targetQueueIndex: 0,
        frame: { insertingId: 'g', lo: 2, hi: 6, probe: 2 },
      },
      currentAutoInsert: null,
      comparisons: 10,
      done: false,
      hidden: ['hidden'],
      totalComparisonsEverNeeded: 10,
      toBeInserted: [],
      pendingManualInserts: [],
      items: { a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H, hidden: { id: 'hidden', label: 'HIDDEN' } },
    };
    const resumed = pickRight(stalled);
    expect(getPair(resumed)).not.toBeNull();
    expectStoredProbeVisible(
      resumed.currentManualInsert?.frame,
      resumed.queue[0],
      resumed.hidden,
    );
  });
});

describe('hidden insert frame invariants (insertion engine)', () => {
  it('pickRight does not stall when the next probe would be hidden', () => {
    let s = buildInsertionState({
      sortedItems: [A, B, C, D, E],
      pendingItems: [X],
    }).state;
    s = hideInsertionItem(s, 'd');
    expect(getInsertionPair(s)!.rightId).toBe('c');
    s = pickInsertionRight(s);
    expect(getInsertionPair(s)).not.toBeNull();
    expectStoredProbeVisible(s.current, s.sorted, s.hidden);
  });

  it('drains the next pending item when rank-aware start lands on a hidden probe', () => {
    const items = [A, B, C, D, E, F, G, H];
    let s = buildInsertionState({
      sortedItems: items,
      pendingItems: [X, Y],
      pendingRunIds: [0, 0],
    }).state;
    s = hideInsertionItem(s, 'f');
    s = hideInsertionItem(s, 'g');
    s = runInsertionUntil(s, ['a', 'b', 'c', 'd', 'e', 'x', 'f', 'h', 'y', 'g']);
    expect(s.done).toBe(true);
    expect(getInsertionRanking(s)).toContain('x');
    expect(getInsertionRanking(s)).toContain('y');
    expect(s.hidden).toEqual(expect.arrayContaining(['f', 'g']));
    expect(getInsertionRanking(s)).not.toContain('f');
    expect(getInsertionRanking(s)).not.toContain('g');
  });

  it('keeps peek-right ids off hidden probes', () => {
    let s = buildInsertionState({
      sortedItems: [A, B, C, D, E],
      pendingItems: [X],
    }).state;
    s = hideInsertionItem(s, 'd');
    const peek = getInsertionPeekRightIds(s, 3);
    expect(peek.every((id) => !s.hidden.includes(id))).toBe(true);
  });
});

describe('hidden insert frame invariants (load repair)', () => {
  it('normalizeLoadedState repairs a stored frame pointing at a hidden probe', () => {
    const target = ['a', 'b', 'c', 'd', 'hidden-probe', 'e'];
    const stalled: MergeState = {
      engine: 'merge',
      queue: [],
      current: null,
      currentManualInsert: null,
      currentAutoInsert: {
        target,
        pendingInserts: ['p2'],
        sourceSublist: ['below-100', 'p2'],
        frame: {
          insertingId: 'below-100',
          lo: 3,
          hi: 4,
          probe: 4,
        },
        lastInsertedPosition: null,
      },
      comparisons: 9,
      done: false,
      hidden: ['hidden-probe'],
      totalComparisonsEverNeeded: 9,
      toBeInserted: [],
      pendingManualInserts: [],
      items: {
        a: A,
        b: B,
        c: C,
        d: D,
        e: E,
        'hidden-probe': { id: 'hidden-probe', label: 'HP' },
        'below-100': { id: 'below-100', label: 'B100' },
        p2: { id: 'p2', label: 'P2' },
      },
    };
    expect(getPair(stalled)).toBeNull();

    const loaded = normalizeLoadedState(stalled);
    if (loaded.engine !== 'merge') return;
    expect(getPair(loaded)).not.toBeNull();
    const ai = loaded.currentAutoInsert;
    if (ai?.frame) {
      expectStoredProbeVisible(ai.frame, ai.target, loaded.hidden);
    } else {
      expect(ai?.target).toContain('below-100');
      expect(ai?.pendingInserts).toContain('p2');
    }
  });
});

describe('visibleInsertWindowEndpoints with ghost slots', () => {
  it('never returns hidden ids for lo/hi tags', () => {
    const frame: InsertFrame = { insertingId: 'x', lo: 0, hi: 4, probe: 2 };
    const sorted: ItemId[] = ['hidden-lo', 'b', 'c', 'hidden-hi', 'e'];
    const hidden = new Set(['hidden-lo', 'hidden-hi']);
    const ends = visibleInsertWindowEndpoints(frame, sorted, hidden);
    expect(ends.loId).toBe('b');
    expect(ends.hiId).toBe('e');
    expect(hidden.has(ends.loId!)).toBe(false);
    expect(hidden.has(ends.hiId!)).toBe(false);
  });
});
