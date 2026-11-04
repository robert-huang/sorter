import { describe, expect, it } from 'vitest';
import {
  addItem,
  addItems,
  appendPreRanked,
  cancelSectionResort,
  dismissHidden,
  forgetHiddenItem,
  getPair,
  getRanking,
  hideItem,
  hideItemUnranked,
  moveFrozenItem,
  normalizeLoadedState,
  pickLeft,
  pickRight,
  reinsertHiddenItem,
  restoreHiddenItem,
  restoreProgress,
  returnToPending,
  rewriteIdInProgress,
  snapshotProgress,
  unhideItem,
} from '../engine';
import { seedSectionResort, type SectionResortMethod } from '../completedSortEditH';
import { seedAsDoneMerge } from '../queueMergeSort';
import { shuffledCopy } from '../shuffle';
import { activeRankingIds, hiddenSortIds } from '../sortPopulation';
import {
  appendVersionIfChanged,
  snapshotSortVersion,
  upsertLiveVersion,
} from '../sortVersions';
import type { Item, ItemId, MergeState, SortState, SortVersion } from '../types';

const METHODS: SectionResortMethod[] = ['merge', 'confirm'];
const OPTS = { shuffleAtStart: false };

function item(id: string): Item {
  return { id, label: id.toUpperCase() };
}

/** Finished slot ranked a, b, c, ... in that order. */
function finished(ids: string[], hidden: string[] = []): MergeState {
  const done = seedAsDoneMerge(ids.map(item));
  return { ...done, hidden: hidden.slice().sort(), comparisons: 7, totalComparisonsEverNeeded: 9 };
}

/** Answers every comparison so the result matches `target` (unknown ids sort last, by id). */
function oracle(target: ItemId[]) {
  const rank = (id: ItemId): number => {
    const i = target.indexOf(id);
    return i === -1 ? target.length + id.charCodeAt(0) : i;
  };
  return (s: SortState): SortState => {
    const pair = getPair(s);
    if (!pair) throw new Error('no pair while not done');
    let leftWins = rank(pair.leftId) <= rank(pair.rightId);
    // Confirmation's insert phase pairs (inserting, probe) but picks by visual side (probe, inserting).
    if (s.engine === 'confirmation' && s.phase === 'insert') leftWins = !leftWins;
    return leftWins ? pickLeft(s, OPTS) : pickRight(s, OPTS);
  };
}

function runTo(s: SortState, target: ItemId[], maxSteps = 500): SortState {
  const pick = oracle(target);
  let cur = s;
  for (let i = 0; i < maxSteps && !cur.done; i++) cur = pick(cur);
  if (!cur.done) throw new Error('sort did not finish');
  return cur;
}

function seed(
  s: SortState,
  start: number,
  end: number,
  method: SectionResortMethod,
  random?: () => number,
): SortState {
  const next = seedSectionResort(s, start, end, method, { ...OPTS, random });
  if (!next) throw new Error('seed returned null');
  return next;
}

/** Every catalog id is ranked or hidden, nothing ranked twice. */
function expectConsistent(s: SortState): void {
  expect(s.engine).toBe('merge');
  const order = (s as MergeState).queue.flat();
  expect(new Set(order).size).toBe(order.length);
  const hidden = new Set(s.hidden);
  for (const id of Object.keys(s.items)) {
    expect(order.includes(id) || hidden.has(id)).toBe(true);
  }
}

describe('seedSectionResort', () => {
  const base = finished(['a', 'b', 'c', 'd', 'e', 'f']);

  it.each([
    ['start', 0, 2, [], ['d', 'e', 'f']],
    ['middle', 1, 3, ['a'], ['e', 'f']],
    ['end', 3, 5, ['a', 'b', 'c'], []],
    ['whole list', 0, 5, [], []],
  ])('splits the %s of the ranking', (_name, start, end, before, after) => {
    for (const method of METHODS) {
      const s = seed(base, start, end, method);
      expect(s.section?.before).toEqual(before);
      expect(s.section?.after).toEqual(after);
      expect(s.section?.startRank).toBe(start + 1);
      expect(s.section?.endRank).toBe(end + 1);
      expect(s.done).toBe(false);
      expect(getRanking(s)).toEqual([]);
    }
  });

  it('returns null for an unfinished sort, a 1-item range or an out-of-range index', () => {
    expect(seedSectionResort(base, 2, 2, 'merge', OPTS)).toBeNull();
    expect(seedSectionResort(base, 3, 2, 'merge', OPTS)).toBeNull();
    expect(seedSectionResort(base, -1, 2, 'merge', OPTS)).toBeNull();
    expect(seedSectionResort(base, 0, 6, 'merge', OPTS)).toBeNull();
    const inProgress = seed(base, 0, 2, 'merge');
    expect(seedSectionResort(inProgress, 0, 1, 'merge', OPTS)).toBeNull();
  });

  it('merge always shuffles the range, even when the slot setting is off', () => {
    const random = () => 0.3;
    const s = seed(base, 1, 4, 'merge', random) as MergeState;
    const expected = shuffledCopy(['b', 'c', 'd', 'e'].map(item), random).map((it) => it.id);
    const seen = [...(s.current ? [...s.current.left, ...s.current.right] : []), ...s.queue.flat()];
    expect(seen.sort()).toEqual(['b', 'c', 'd', 'e']);
    expect(expected).not.toEqual(['b', 'c', 'd', 'e']);
    const queueHeads = s.queue.map((sub) => sub[0]);
    const frontPair = s.current ? [s.current.left[0], s.current.right[0]] : [];
    expect([...frontPair, ...queueHeads]).toEqual(expected);
  });

  it('confirm walks the range in its current order', () => {
    const s = seed(base, 1, 4, 'confirm');
    expect(s.engine).toBe('confirmation');
    if (s.engine !== 'confirmation') return;
    expect([...s.confirmed, ...(s.candidate ? [s.candidate] : []), ...s.queue]).toEqual([
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it('uses visible ranks: hidden placeholders inside go to tailPlaceholders, outside stay put', () => {
    // Order a x b y c z d, with x, y, z hidden: visible ranks a b c d.
    const s0 = {
      ...seedAsDoneMerge(['a', 'x', 'b', 'y', 'c', 'z', 'd'].map(item)),
      hidden: ['x', 'y', 'z'],
    } as MergeState;
    const s = seed(s0, 1, 2, 'merge');
    expect(s.section?.before).toEqual(['a', 'x']);
    expect(s.section?.tailPlaceholders).toEqual(['y']);
    expect(s.section?.after).toEqual(['z', 'd']);
    expect(s.section?.originalOrder).toEqual(['a', 'x', 'b', 'y', 'c', 'z', 'd']);
    expect(s.section?.originalHidden).toEqual(['x', 'y', 'z']);
  });
});

describe('finishing a section re-sort', () => {
  const base = finished(['a', 'b', 'c', 'd', 'e', 'f']);

  it.each(METHODS)('%s: splices the new order back into the same ranks', (method) => {
    const s = runTo(seed(base, 1, 4, method), ['e', 'd', 'c', 'b']);
    expect(s.section).toBeUndefined();
    expect(getRanking(s)).toEqual(['a', 'e', 'd', 'c', 'b', 'f']);
    expectConsistent(s);
  });

  it.each(METHODS)('%s: whole list re-sort', (method) => {
    const target = ['f', 'a', 'e', 'b', 'd', 'c'];
    const s = runTo(seed(base, 0, 5, method), target);
    expect(getRanking(s)).toEqual(target);
  });

  it('confirm with nothing out of place costs n-1 comparisons and keeps the order', () => {
    const s = runTo(seed(base, 1, 4, 'confirm'), ['b', 'c', 'd', 'e']);
    expect(getRanking(s)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(s.comparisons).toBe(7 + 3);
  });

  it.each(METHODS)('%s: adds comparisons and totals to the slot counts', (method) => {
    const seeded = seed(base, 1, 4, method);
    const s = runTo(seeded, ['e', 'd', 'c', 'b']);
    expect(s.comparisons).toBeGreaterThan(7);
    expect(s.totalComparisonsEverNeeded).toBeGreaterThanOrEqual(9);
  });

  it('keeps hidden placeholders around the range in their original order', () => {
    const s0 = {
      ...seedAsDoneMerge(['a', 'x', 'b', 'y', 'c', 'w', 'z', 'd'].map(item)),
      hidden: ['w', 'x', 'y', 'z'],
    } as MergeState;
    for (const method of METHODS) {
      const s = runTo(seed(s0, 1, 2, method), ['c', 'b']) as MergeState;
      expect(s.queue[0]).toEqual(['a', 'x', 'c', 'b', 'y', 'w', 'z', 'd']);
      expect(s.hidden).toEqual(['w', 'x', 'y', 'z']);
    }
  });
});

describe('editing during a section re-sort', () => {
  const base = finished(['a', 'b', 'c', 'd', 'e', 'f']);

  it.each(METHODS)('%s: new items join the section', (method) => {
    let s = seed(base, 1, 3, method);
    s = addItem(s, item('n'), OPTS)!;
    s = addItems(s, [item('m'), item('o')], OPTS).state;
    const done = runTo(s, ['a', 'n', 'm', 'o', 'b', 'c', 'd', 'e', 'f']);
    expect(getRanking(done)).toEqual(['a', 'n', 'm', 'o', 'b', 'c', 'd', 'e', 'f']);
    expectConsistent(done);
  });

  it('a pre-ranked sublist joins the section', () => {
    let s = seed(base, 1, 3, 'merge');
    s = appendPreRanked(s as MergeState, [item('m'), item('n')], OPTS).state;
    const done = runTo(s, ['a', 'b', 'm', 'c', 'n', 'd', 'e', 'f']);
    expect(getRanking(done)).toEqual(['a', 'b', 'm', 'c', 'n', 'd', 'e', 'f']);
  });

  it.each(METHODS)('%s: adding a visible frozen item is skipped, not duplicated', (method) => {
    const s = seed(base, 1, 3, method);
    expect(addItem(s, item('a'), OPTS)).toBeNull();
    const result = addItems(s, [item('f'), item('n')], OPTS);
    expect(result.skipped).toEqual(['f']);
    const pre = appendPreRanked(seed(base, 1, 3, 'merge') as MergeState, [item('e')], OPTS);
    expect(pre.skipped).toEqual(['e']);
    const done = runTo(result.state, ['a', 'b', 'c', 'd', 'n', 'e', 'f']);
    expectConsistent(done);
    expect(getRanking(done).filter((id) => id === 'f')).toHaveLength(1);
  });

  it.each(METHODS)('%s: re-adding a hidden frozen item adds it fresh to the re-sort', (method) => {
    let s = seed(base, 1, 3, method);
    s = hideItem(s, 'e', OPTS);
    const result = addItems(s, [item('e')], OPTS);
    expect(result.restored).toEqual(['e']);
    expect(result.skipped).toEqual([]);
    expect(result.state.section?.after).toEqual(['f']);
    expect(result.state.hidden).not.toContain('e');
    expect(activeRankingIds(result.state).has('e')).toBe(true);

    const single = addItem(s, item('e'), OPTS)!;
    expect(single.section?.after).toEqual(['f']);
    expect(single.hidden).not.toContain('e');
    expect(activeRankingIds(single).has('e')).toBe(true);

    // The oracle ranks e first, so it lands at the top of the section, not back at rank 5.
    const done = runTo(result.state, ['a', 'e', 'b', 'c', 'd', 'f']);
    expect(getRanking(done)).toEqual(['a', 'e', 'b', 'c', 'd', 'f']);
    expectConsistent(done);
  });

  it('re-adding a hidden frozen item in a pre-ranked batch keeps its batch position', () => {
    let s = seed(base, 1, 3, 'merge');
    s = hideItem(s, 'a', OPTS);
    const result = appendPreRanked(s as MergeState, [item('x'), item('a')], OPTS);
    expect(result.restored).toEqual(['a']);
    expect(result.state.section?.before).toEqual([]);
    expect((result.state as MergeState).queue.some((sub) => sub.join() === 'x,a')).toBe(true);
  });

  // Same as a normal sort: merge drops a mid-sort hide's rank, confirm keeps it as a hidden placeholder.
  it.each(METHODS)('%s: an item hidden mid-sort ends up hidden', (method) => {
    let s = seed(base, 1, 4, method);
    s = oracle(['b', 'c', 'd', 'e'])(s);
    s = hideItem(s, 'c', OPTS);
    const done = runTo(s, ['b', 'd', 'e']) as MergeState;
    expect(done.hidden).toContain('c');
    expect(done.queue[0]!.includes('c')).toBe(method === 'confirm');
    expect(getRanking(done)).toEqual(['a', 'b', 'd', 'e', 'f']);
    expectConsistent(done);
    const restored = restoreHiddenItem(done, 'c', OPTS);
    expect(restored.done).toBe(method === 'confirm');
    expect(getRanking(runTo(restored, ['a', 'b', 'c', 'd', 'e', 'f']))).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
  });

  it.each(METHODS)('%s: several hidden mid-sort, including the item being compared', (method) => {
    let s = seed(base, 0, 5, method);
    const pair = getPair(s)!;
    s = hideItem(s, pair.leftId, OPTS);
    const other = ['a', 'b', 'c', 'd', 'e', 'f'].find(
      (id) => id !== pair.leftId && !s.hidden.includes(id),
    )!;
    s = hideItem(s, other, OPTS);
    const done = runTo(s, ['a', 'b', 'c', 'd', 'e', 'f']);
    expect(done.hidden).toEqual([pair.leftId, other].sort());
    expectConsistent(done);
  });

  it('hiding the last unsorted pair finishes and splices', () => {
    let s = seed(base, 1, 2, 'merge');
    s = hideItem(s, 'b', OPTS);
    expect(s.done).toBe(true);
    expect(s.section).toBeUndefined();
    expect(getRanking(s)).toEqual(['a', 'c', 'd', 'e', 'f']);
    expectConsistent(s);
  });
});

describe('frozen rows during a section re-sort', () => {
  const base = finished(['a', 'b', 'c', 'd', 'e', 'f', 'g']);

  it.each(METHODS)('%s: hide keeps the placeholder; restore and unhide put it back in place', (method) => {
    let s = seed(base, 2, 4, method);
    const comparisons = s.comparisons;
    s = hideItem(s, 'a', OPTS);
    expect(s.hidden).toContain('a');
    expect(s.section?.before).toEqual(['a', 'b']);
    for (const restore of [
      (x: SortState) => restoreHiddenItem(x, 'a', OPTS),
      (x: SortState) => unhideItem(x, 'a'),
      (x: SortState) => dismissHidden(x, 'a'),
    ]) {
      const back = restore(s);
      expect(back.hidden).not.toContain('a');
      expect(back.section?.before).toEqual(['a', 'b']);
      expect(back.comparisons).toBe(comparisons);
    }
  });

  it.each(METHODS)('%s: Reinsert and ↻ move a frozen item into the section once', (method) => {
    let s = seed(base, 2, 4, method);
    s = hideItem(s, 'a', OPTS);
    const viaReinsert = reinsertHiddenItem(s, 'a', OPTS);
    expect(viaReinsert.section?.before).toEqual(['b']);
    expect(viaReinsert.hidden).not.toContain('a');
    expect(activeRankingIds(viaReinsert).has('a')).toBe(true);
    const viaRow = returnToPending(seed(base, 2, 4, method), 'g', OPTS);
    expect(viaRow.section?.after).toEqual(['f']);
    for (const [state, target] of [
      [viaReinsert, ['b', 'c', 'd', 'a', 'e', 'f', 'g']],
      [viaRow, ['a', 'b', 'g', 'c', 'd', 'e', 'f']],
    ] as const) {
      const done = runTo(state, [...target]);
      expect(getRanking(done)).toEqual(target);
      expectConsistent(done);
    }
  });

  it('forget removes a hidden frozen item; unranked hide drops its rank', () => {
    let s = seed(base, 2, 4, 'merge');
    s = hideItem(s, 'f', OPTS);
    const forgotten = forgetHiddenItem(s, 'f', OPTS);
    expect(forgotten.section?.after).toEqual(['g']);
    expect(forgotten.hidden).not.toContain('f');
    expect(forgetHiddenItem(seed(base, 2, 4, 'merge'), 'f', OPTS).section?.after).toEqual([
      'f',
      'g',
    ]);
    const unranked = hideItemUnranked(seed(base, 2, 4, 'merge'), 'a', OPTS);
    expect(unranked.section?.before).toEqual(['b']);
    expect(unranked.hidden).toContain('a');
    const done = runTo(unranked, ['c', 'd', 'e']) as MergeState;
    expect(done.queue[0]).toEqual(['b', 'c', 'd', 'e', 'f', 'g']);
    expect(done.hidden).toContain('a');
  });

  it('moves swap within before / after and stop at the range boundary', () => {
    const s = seed(base, 2, 4, 'merge');
    expect(moveFrozenItem(s, 'a', 1).section?.before).toEqual(['b', 'a']);
    expect(moveFrozenItem(s, 'b', -1).section?.before).toEqual(['b', 'a']);
    expect(moveFrozenItem(s, 'b', 1)).toBe(s);
    expect(moveFrozenItem(s, 'a', -1)).toBe(s);
    expect(moveFrozenItem(s, 'f', -1)).toBe(s);
    expect(moveFrozenItem(s, 'g', 1)).toBe(s);
    expect(moveFrozenItem(s, 'f', 1).section?.after).toEqual(['g', 'f']);
    expect(moveFrozenItem(s, 'c', 1)).toBe(s);
    const done = runTo(moveFrozenItem(s, 'a', 1), ['c', 'd', 'e']);
    expect(getRanking(done)).toEqual(['b', 'a', 'c', 'd', 'e', 'f', 'g']);
  });

  it('moves skip hidden neighbours, and tail placeholders move with after', () => {
    // a x b | c d y e | f — visible ranks 3..5 are c d e; x hidden before, y hidden inside.
    const s0 = {
      ...seedAsDoneMerge(['a', 'x', 'b', 'c', 'd', 'y', 'e', 'f'].map(item)),
      hidden: ['x', 'y'],
    } as MergeState;
    const s = seed(s0, 2, 4, 'merge');
    expect(s.section?.tailPlaceholders).toEqual(['y']);
    expect(s.section?.after).toEqual(['f']);
    expect(moveFrozenItem(s, 'a', 1).section?.before).toEqual(['b', 'x', 'a']);
    expect(moveFrozenItem(s, 'b', 1)).toBe(s);
    expect(moveFrozenItem(s, 'f', -1)).toBe(s);
    const restoredTail = unhideItem(s, 'y');
    expect(moveFrozenItem(restoredTail, 'y', -1)).toBe(restoredTail);
    const moved = moveFrozenItem(restoredTail, 'y', 1);
    expect(moved.section?.tailPlaceholders).toEqual(['f']);
    expect(moved.section?.after).toEqual(['y']);
    const done = runTo(moved, ['c', 'd', 'e']) as MergeState;
    expect(done.queue[0]).toEqual(['a', 'x', 'b', 'c', 'd', 'e', 'f', 'y']);
  });

  it('add menu treats visible frozen ids as present and hidden frozen ids as restorable', () => {
    let s = seed(base, 2, 4, 'merge');
    s = hideItem(s, 'g', OPTS);
    const active = activeRankingIds(s);
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) expect(active.has(id)).toBe(true);
    expect(hiddenSortIds(s).has('g')).toBe(true);
  });
});

describe('undo, cancel and persistence', () => {
  const base = finished(['a', 'b', 'c', 'd', 'e'], []);

  it.each(METHODS)('%s: snapshots round-trip the section at every step', (method) => {
    let s = seed(base, 1, 3, method);
    const snaps = [snapshotProgress(s)];
    s = hideItem(s, 'a', OPTS);
    snaps.push(snapshotProgress(s));
    s = oracle(['b', 'c', 'd'])(s);
    snaps.push(snapshotProgress(s));
    for (const snap of snaps) {
      const restored = restoreProgress(s, snap);
      expect(restored.section).toEqual(snap.section);
      expect(snapshotProgress(restored)).toEqual(snap);
    }
    const beforeStart = restoreProgress(s, snapshotProgress(base));
    expect(beforeStart.section).toBeUndefined();
    expect(getRanking(beforeStart)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('a snapshot does not share arrays with the live section', () => {
    const s = seed(base, 1, 3, 'merge');
    const snap = snapshotProgress(s);
    snap.section!.before.push('zzz');
    expect(s.section?.before).toEqual(['a']);
  });

  it.each(METHODS)('%s: cancel returns the finished ranking, with added items in Hidden', (method) => {
    const original = finished(['a', 'b', 'c', 'd', 'e'], ['c']);
    let s = seed(original, 1, 2, method);
    s = addItem(s, item('n'), OPTS)!;
    s = hideItem(s, 'a', OPTS);
    s = moveFrozenItem(s, 'd', 1);
    s = oracle(['b', 'd', 'n'])(s);
    const cancelled = cancelSectionResort(s);
    expect(snapshotProgress(cancelled)).toEqual({
      ...snapshotProgress(original),
      hidden: ['c', 'n'],
    });
    expect(getRanking(cancelled)).toEqual(getRanking(original));
    expect(cancelled.items.n).toEqual(item('n'));
    expect(hiddenSortIds(cancelled).has('n')).toBe(true);
    expect(activeRankingIds(cancelled).has('n')).toBe(false);
    expectConsistent(cancelled);
  });

  it.each(METHODS)('%s: cancel puts items hidden or dismissed during the re-sort back at their rank', (method) => {
    const original = finished(['a', 'b', 'c', 'd', 'e', 'f']);
    let s = seed(original, 1, 4, method);
    s = hideItem(s, 'c', OPTS);
    s = hideItemUnranked(s, 'b', OPTS);
    s = forgetHiddenItem(s, 'b', OPTS);
    s = hideItem(s, 'f', OPTS);
    expect(s.section).toBeDefined();
    const cancelled = cancelSectionResort(s);
    expect(getRanking(cancelled)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(cancelled.hidden).toEqual([]);
  });

  it('cancel keeps a pre-ranked batch added during the re-sort, hidden', () => {
    let s = seed(finished(['a', 'b', 'c', 'd']), 0, 1, 'merge');
    s = appendPreRanked(s as MergeState, [item('x'), item('y')], OPTS).state;
    const cancelled = cancelSectionResort(s);
    expect(getRanking(cancelled)).toEqual(['a', 'b', 'c', 'd']);
    expect([...cancelled.hidden].sort()).toEqual(['x', 'y']);
    expectConsistent(cancelled);
  });

  it.each(METHODS)('%s: items waiting in To be inserted survive cancel and a finished re-sort', (method) => {
    const original: MergeState = {
      ...finished(['a', 'b', 'c', 'd'], ['x']),
      items: { ...finished(['a', 'b', 'c', 'd']).items, x: item('x') },
      toBeInserted: ['x'],
    };
    const s = seed(original, 1, 2, method);
    expect(s.section?.originalToBeInserted).toEqual(['x']);

    const cancelled = cancelSectionResort(s) as MergeState;
    expect(cancelled.toBeInserted).toEqual(['x']);
    expect(snapshotProgress(cancelled)).toEqual(snapshotProgress(original));

    const finishedResort = runTo(s, ['c', 'b']) as MergeState;
    expect(getRanking(finishedResort)).toEqual(['a', 'c', 'b', 'd']);
    expect(finishedResort.toBeInserted).toEqual(['x']);
    expect(finishedResort.hidden).toEqual(['x']);
  });

  it('a section saved before originalToBeInserted existed still cancels', () => {
    const s = seed(finished(['a', 'b', 'c']), 0, 1, 'merge');
    const { originalToBeInserted: _drop, ...legacy } = s.section!;
    void _drop;
    const loaded = normalizeLoadedState(
      JSON.parse(JSON.stringify({ ...s, section: legacy })) as SortState,
      OPTS,
    );
    expect(loaded.section).toEqual(legacy);
    const cancelled = cancelSectionResort(loaded) as MergeState;
    expect(getRanking(cancelled)).toEqual(['a', 'b', 'c']);
    expect(cancelled.toBeInserted).toEqual([]);
  });

  it.each(METHODS)('%s: save and reload mid-re-sort keeps the section and finishes', (method) => {
    let s = seed(base, 1, 3, method);
    s = oracle(['d', 'c', 'b'])(s);
    const loaded = normalizeLoadedState(JSON.parse(JSON.stringify(s)) as SortState, OPTS);
    expect(loaded.section).toEqual(s.section);
    expect(getRanking(runTo(loaded, ['d', 'c', 'b']))).toEqual(['a', 'd', 'c', 'b', 'e']);
  });

  it('a malformed section falls back to the ranking from before the re-sort', () => {
    const s = seed(base, 1, 3, 'merge');
    const broken = {
      ...s,
      section: { ...s.section, before: 'oops', startRank: undefined },
    } as unknown as SortState;
    const loaded = normalizeLoadedState(broken, OPTS);
    expect(loaded.done).toBe(true);
    expect(loaded.section).toBeUndefined();
    expect(getRanking(loaded)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('an unreadable section is dropped without crashing', () => {
    const s = seed(base, 1, 3, 'merge');
    const broken = { ...s, section: 42 } as unknown as SortState;
    const loaded = normalizeLoadedState(broken, OPTS);
    expect(loaded.section).toBeUndefined();
  });

  it('frozen ids that also sit in the live section, or have no item, are dropped from the frozen part', () => {
    const s = seed(base, 1, 3, 'merge');
    const overlapping = {
      ...s,
      section: { ...s.section!, before: ['a', 'b', 'ghost'] },
    } as SortState;
    const loaded = normalizeLoadedState(overlapping, OPTS);
    expect(loaded.section?.before).toEqual(['a']);
    const done = runTo(loaded, ['b', 'c', 'd']);
    expectConsistent(done);
    expect(getRanking(done)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('renaming an id rewrites the section', () => {
    const s = seed(base, 1, 3, 'merge');
    const progress = rewriteIdInProgress(snapshotProgress(s), 'a', 'a2');
    expect(progress.section?.before).toEqual(['a2']);
    expect(progress.section?.originalOrder[0]).toBe('a2');
  });
});

describe('versions around a section re-sort', () => {
  const ranked = (s: SortState) => ({ items: s.items, progress: snapshotProgress(s) });
  const clock = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n));

  it.each(METHODS)('%s: only appends versions and never changes earlier ones', (method) => {
    const original = finished(['a', 'b', 'c', 'd', 'e']);
    let versions: readonly SortVersion[] = appendVersionIfChanged([], ranked(original), clock(0));
    const older = JSON.parse(JSON.stringify(versions)) as SortVersion[];

    // App.startSectionResort: freeze, then reopen.
    versions = appendVersionIfChanged(versions, ranked(original), clock(1));
    let s = seed(original, 1, 3, method);
    versions = upsertLiveVersion(versions, ranked(original), clock(1));
    expect(versions).toHaveLength(1);

    const steps: ((x: SortState) => SortState)[] = [
      (x) => addItem(x, item('n'), OPTS)!,
      (x) => hideItem(x, 'a', OPTS),
      (x) => unhideItem(x, 'a'),
      oracle(['d', 'c', 'n', 'b']),
    ];
    for (const step of steps) {
      s = step(s);
      expect(snapshotSortVersion(ranked(s), clock(2).toISOString())).toBeNull();
      versions = upsertLiveVersion(versions, ranked(s), clock(2));
      expect(versions.slice(0, older.length)).toEqual(older);
    }
    const reloaded = normalizeLoadedState(JSON.parse(JSON.stringify(s)) as SortState, OPTS);
    const done = runTo(reloaded, ['d', 'c', 'n', 'b']);
    versions = appendVersionIfChanged(versions, ranked(done), clock(3));
    expect(versions).toHaveLength(2);
    expect(versions.slice(0, 1)).toEqual(older);
    expect(versions[1]!.rankedIds).toEqual(['a', 'd', 'c', 'n', 'b', 'e']);
  });

  it('cancel adds no version', () => {
    const original = finished(['a', 'b', 'c', 'd']);
    let versions = appendVersionIfChanged([], ranked(original), clock(0));
    const older = JSON.parse(JSON.stringify(versions)) as SortVersion[];
    const s = cancelSectionResort(seed(original, 0, 3, 'merge'));
    versions = appendVersionIfChanged(versions, ranked(s), clock(1));
    expect(versions).toEqual(older);
  });
});
