import {
  adoptInsertFrameResult,
  applyInsertPick,
  getInsertPair as getInsertPairPrimitive,
  getInsertPeekRightIds,
  countInsertPeekRightOverflow,
  insertComparisonsRemaining,
  reorderDisturbsInsertFrame,
  skipHiddenInsertProbes,
  startInsert,
  worstCaseInsertCost,
} from './binaryInsertion';
import type {
  ConfirmationProgress,
  ConfirmationState,
  InsertFrame,
  Item,
  ItemId,
} from './types';

// ---------- readers ----------

export function getCandidateId(state: ConfirmationState): ItemId | null {
  if (state.phase === 'insert' && state.insertFrame) {
    return state.insertFrame.insertingId;
  }
  return state.candidate;
}

export function getPair(
  state: ConfirmationState,
): { leftId: ItemId; rightId: ItemId } | null {
  if (state.done) return null;
  const hidden = new Set(state.hidden);

  if (state.phase === 'insert' && state.insertFrame) {
    if (hidden.has(state.insertFrame.insertingId)) return null;
    const skipped = skipHiddenInsertProbes(
      state.insertFrame,
      state.confirmed,
      hidden,
    );
    if ('done' in skipped) return null;
    return getInsertPairPrimitive(skipped, state.confirmed);
  }

  if (state.phase !== 'confirm' || !state.candidate) return null;
  if (hidden.has(state.candidate)) return null;
  const frontier = state.confirmed[state.confirmed.length - 1];
  if (!frontier || hidden.has(frontier)) return null;
  return { leftId: frontier, rightId: state.candidate };
}

export function getPeekRightIds(state: ConfirmationState, n = 3): ItemId[] {
  if (state.phase !== 'insert' || !state.insertFrame) return [];
  const hidden = new Set(state.hidden);
  if (hidden.has(state.insertFrame.insertingId)) return [];
  const skipped = skipHiddenInsertProbes(
    state.insertFrame,
    state.confirmed,
    hidden,
  );
  if ('done' in skipped) return [];
  return getInsertPeekRightIds(skipped, state.confirmed, hidden, n);
}

export function getPeekLeftIds(_state: ConfirmationState, _n = 3): ItemId[] {
  return [];
}

export function getPeekRightOverflowCount(
  state: ConfirmationState,
  labeledDepth: number,
): number {
  if (state.phase !== 'insert' || !state.insertFrame) return 0;
  const hidden = new Set(state.hidden);
  if (hidden.has(state.insertFrame.insertingId)) return 0;
  const skipped = skipHiddenInsertProbes(
    state.insertFrame,
    state.confirmed,
    hidden,
  );
  if ('done' in skipped) return 0;
  return countInsertPeekRightOverflow(
    skipped,
    state.confirmed,
    hidden,
    labeledDepth,
  );
}

export function getPeekLeftOverflowCount(
  _state: ConfirmationState,
  _labeledDepth: number,
): number {
  return 0;
}

/** Best-case remaining if every future item is a single left-click confirm. */
export function optimisticComparisonsRemaining(
  state: ConfirmationState,
): number {
  if (state.done) return 0;
  let m = state.queue.length;
  if (state.phase === 'confirm' && state.candidate) m += 1;
  return m;
}

export function comparisonsRemaining(state: ConfirmationState): number {
  if (state.done) return 0;
  return comparisonsRemainingFromProgress(state);
}

function comparisonsRemainingFromProgress(
  progress: ConfirmationProgress,
): number {
  if (progress.done) return 0;
  let total = 0;
  let confirmedLen = progress.confirmed.length;

  if (progress.phase === 'insert' && progress.insertFrame) {
    total += insertComparisonsRemaining(progress.insertFrame);
    confirmedLen += 1;
  } else if (progress.candidate) {
    total += 1;
  }

  const tail =
    progress.phase === 'insert'
      ? progress.queue.length
      : Math.max(0, progress.queue.length);
  for (let i = 0; i < tail; i++) {
    total += 1;
    total += worstCaseInsertCost(confirmedLen);
    confirmedLen += 1;
  }
  return total;
}

export function getRanking(state: ConfirmationState): ItemId[] {
  if (!state.done) return [];
  const hidden = new Set(state.hidden);
  return state.confirmed.filter((id) => !hidden.has(id));
}

// ---------- snapshot ----------

export function snapshotProgress(
  state: ConfirmationState,
): ConfirmationProgress {
  return {
    engine: 'confirmation',
    confirmed: state.confirmed.slice(),
    queue: state.queue.slice(),
    candidate: state.candidate,
    phase: state.phase,
    insertFrame: state.insertFrame
      ? {
          insertingId: state.insertFrame.insertingId,
          lo: state.insertFrame.lo,
          hi: state.insertFrame.hi,
          probe: state.insertFrame.probe,
        }
      : null,
    comparisons: state.comparisons,
    done: state.done,
    hidden: state.hidden.slice(),
    totalComparisonsEverNeeded: state.totalComparisonsEverNeeded,
  };
}

export function restoreProgress(
  state: ConfirmationState,
  progress: ConfirmationProgress,
): ConfirmationState {
  return {
    ...progress,
    confirmed: progress.confirmed.slice(),
    queue: progress.queue.slice(),
    insertFrame: progress.insertFrame
      ? {
          insertingId: progress.insertFrame.insertingId,
          lo: progress.insertFrame.lo,
          hi: progress.insertFrame.hi,
          probe: progress.insertFrame.probe,
        }
      : null,
    hidden: progress.hidden.slice(),
    items: state.items,
  };
}

// ---------- seed ----------

export function seedConfirmation(items: Item[]): ConfirmationState {
  const itemsDict: Record<ItemId, Item> = {};
  for (const it of items) itemsDict[it.id] = it;

  if (items.length === 0) {
    const progress: ConfirmationProgress = {
      engine: 'confirmation',
      confirmed: [],
      queue: [],
      candidate: null,
      phase: 'confirm',
      insertFrame: null,
      comparisons: 0,
      done: true,
      hidden: [],
      totalComparisonsEverNeeded: 0,
    };
    return { ...progress, items: itemsDict };
  }

  if (items.length === 1) {
    const progress: ConfirmationProgress = {
      engine: 'confirmation',
      confirmed: [items[0].id],
      queue: [],
      candidate: null,
      phase: 'confirm',
      insertFrame: null,
      comparisons: 0,
      done: true,
      hidden: [],
      totalComparisonsEverNeeded: 0,
    };
    return { ...progress, items: itemsDict };
  }

  const progress: ConfirmationProgress = {
    engine: 'confirmation',
    confirmed: [items[0].id],
    queue: items.slice(2).map((it) => it.id),
    candidate: items[1].id,
    phase: 'confirm',
    insertFrame: null,
    comparisons: 0,
    done: false,
    hidden: [],
    totalComparisonsEverNeeded: 0,
  };
  progress.totalComparisonsEverNeeded =
    comparisonsRemainingFromProgress(progress);
  return { ...progress, items: itemsDict };
}

// ---------- internal transitions ----------

function bumpTotalComparisons(progress: ConfirmationProgress): void {
  const current = comparisonsRemainingFromProgress(progress);
  if (current > progress.totalComparisonsEverNeeded) {
    progress.totalComparisonsEverNeeded = current;
  }
}

function markDoneIfFinished(progress: ConfirmationProgress): void {
  if (
    progress.phase === 'confirm' &&
    progress.candidate === null &&
    progress.queue.length === 0 &&
    progress.insertFrame === null
  ) {
    progress.done = true;
  }
}

function advanceCandidate(progress: ConfirmationProgress): void {
  if (progress.queue.length === 0) {
    progress.candidate = null;
    markDoneIfFinished(progress);
    return;
  }
  progress.candidate = progress.queue[0];
  progress.queue = progress.queue.slice(1);
}

function spliceInsertAndResume(progress: ConfirmationProgress, position: number): void {
  const insertingId = progress.insertFrame!.insertingId;
  progress.confirmed = [
    ...progress.confirmed.slice(0, position),
    insertingId,
    ...progress.confirmed.slice(position),
  ];
  progress.insertFrame = null;
  progress.phase = 'confirm';
  progress.candidate = null;
  advanceCandidate(progress);
}

function startInsertPhase(progress: ConfirmationProgress): void {
  const insertingId = progress.candidate;
  if (!insertingId) return;
  const hidden = new Set(progress.hidden);
  const res = startInsert(progress.confirmed, insertingId);
  const frame = adoptInsertFrameResult(res, progress.confirmed, hidden, (position) => {
    spliceInsertAndResume(progress, position);
  });
  if (frame) {
    progress.phase = 'insert';
    progress.insertFrame = frame;
    return;
  }
  // Zero-comparison insert (shouldn't happen with len>=1 confirmed, but be safe).
  if ('done' in res) {
    spliceInsertAndResume(progress, res.position);
  }
}

function applyConfirmPick(
  state: ConfirmationState,
  side: 'left' | 'right',
): ConfirmationState {
  if (state.phase !== 'confirm' || !state.candidate) return state;
  const next = snapshotProgress(state);
  next.comparisons += 1;
  if (side === 'left') {
    next.confirmed = [...next.confirmed, next.candidate!];
    next.candidate = null;
    advanceCandidate(next);
    bumpTotalComparisons(next);
    return { ...next, items: state.items };
  }
  if (side === 'right') {
    // Sole confirmed item + first comparison: prepend candidate as [2,1]
    // instead of a pointless binary-insert sub-phase.
    if (next.confirmed.length === 1) {
      next.confirmed = [next.candidate!, next.confirmed[0]];
      next.candidate = null;
      advanceCandidate(next);
      bumpTotalComparisons(next);
      return { ...next, items: state.items };
    }
    startInsertPhase(next);
    bumpTotalComparisons(next);
    return { ...next, items: state.items };
  }
  return state;
}

function applyInsertPickSide(
  state: ConfirmationState,
  side: 'left' | 'right',
): ConfirmationState {
  if (state.phase !== 'insert' || !state.insertFrame) return state;
  const hidden = new Set(state.hidden);
  if (hidden.has(state.insertFrame.insertingId)) return state;
  const visibleFrame = skipHiddenInsertProbes(
    state.insertFrame,
    state.confirmed,
    hidden,
  );
  if ('done' in visibleFrame) {
    const next = snapshotProgress(state);
    spliceInsertAndResume(next, visibleFrame.position);
    bumpTotalComparisons(next);
    return { ...next, items: state.items };
  }
  const next = snapshotProgress(state);
  next.insertFrame = visibleFrame;
  const picked = side === 'left' ? 'inserting' : 'sorted';
  const r = applyInsertPick(visibleFrame, picked, state.confirmed.length);
  next.comparisons += 1;
  let splicePosition: number | null = null;
  const frame = adoptInsertFrameResult(r, next.confirmed, hidden, (position) => {
    splicePosition = position;
  });
  if (splicePosition !== null) {
    spliceInsertAndResume(next, splicePosition);
    bumpTotalComparisons(next);
    return { ...next, items: state.items };
  }
  next.insertFrame = frame;
  bumpTotalComparisons(next);
  return { ...next, items: state.items };
}

export function pickLeft(state: ConfirmationState): ConfirmationState {
  if (state.phase === 'confirm') return applyConfirmPick(state, 'left');
  // Insert sub-phase: visual left is the probe (engine pair's rightId).
  return applyInsertPickSide(state, 'right');
}

export function pickRight(state: ConfirmationState): ConfirmationState {
  if (state.phase === 'confirm') return applyConfirmPick(state, 'right');
  // Insert sub-phase: visual right is the inserting candidate (engine pair's leftId).
  return applyInsertPickSide(state, 'left');
}

// ---------- list mutations ----------

export function reorderInConfirmed(
  state: ConfirmationState,
  confirmedIndex: number,
  direction: -1 | 1,
): ConfirmationState {
  if (confirmedIndex < 0 || confirmedIndex >= state.confirmed.length) return state;
  const target = confirmedIndex + direction;
  if (target < 0 || target >= state.confirmed.length) return state;

  const next = snapshotProgress(state);
  const newConfirmed = next.confirmed.slice();
  [newConfirmed[confirmedIndex], newConfirmed[target]] = [
    newConfirmed[target],
    newConfirmed[confirmedIndex],
  ];
  next.confirmed = newConfirmed;

  if (
    next.phase === 'insert' &&
    next.insertFrame &&
    reorderDisturbsInsertFrame(next.insertFrame, confirmedIndex, target)
  ) {
    const insertingId = next.insertFrame.insertingId;
    next.insertFrame = null;
    next.phase = 'confirm';
    next.candidate = insertingId;
    const res = startInsert(next.confirmed, insertingId);
    const hidden = new Set(next.hidden);
    const frame = adoptInsertFrameResult(res, next.confirmed, hidden, (position) => {
      spliceInsertAndResume(next, position);
    });
    if (frame) {
      next.phase = 'insert';
      next.insertFrame = frame;
    } else if ('done' in res) {
      spliceInsertAndResume(next, res.position);
    }
  }

  bumpTotalComparisons(next);
  return { ...next, items: state.items };
}

export function returnCandidateToQueue(
  state: ConfirmationState,
  id: ItemId,
): ConfirmationState {
  const idx = state.confirmed.indexOf(id);
  if (idx < 0) return state;
  const next = snapshotProgress(state);
  next.confirmed = [
    ...next.confirmed.slice(0, idx),
    ...next.confirmed.slice(idx + 1),
  ];
  if (next.done) next.done = false;

  if (next.phase === 'insert' && next.insertFrame) {
    next.insertFrame = null;
    next.phase = 'confirm';
  }

  next.queue = [...next.queue, id];
  if (next.candidate === null) {
    advanceCandidate(next);
  } else {
    next.queue = [next.candidate, ...next.queue];
    next.candidate = id;
  }

  bumpTotalComparisons(next);
  return { ...next, items: state.items };
}

// ---------- hide / unhide ----------

export function hideItem(
  state: ConfirmationState,
  id: ItemId,
): ConfirmationState {
  if (!state.items[id] || state.hidden.includes(id)) return state;
  const next = snapshotProgress(state);
  next.hidden = [...next.hidden, id].sort();

  if (next.insertFrame?.insertingId === id) {
    next.insertFrame = null;
    next.phase = 'confirm';
    next.candidate = null;
    advanceCandidate(next);
  } else if (next.candidate === id) {
    next.candidate = null;
    advanceCandidate(next);
  } else {
    const qi = next.queue.indexOf(id);
    if (qi >= 0) next.queue.splice(qi, 1);
  }

  // Mirror insertion engine: any hide during an active insert may advance
  // past a hidden probe or collapse the frame entirely.
  if (next.phase === 'insert' && next.insertFrame) {
    const hidden = new Set(next.hidden);
    if (hidden.has(next.insertFrame.insertingId)) {
      next.insertFrame = null;
      next.phase = 'confirm';
      next.candidate = null;
      advanceCandidate(next);
    } else {
      const skipped = skipHiddenInsertProbes(
        next.insertFrame,
        next.confirmed,
        hidden,
      );
      if ('done' in skipped) {
        spliceInsertAndResume(next, skipped.position);
      } else {
        next.insertFrame = skipped;
      }
    }
  }

  markDoneIfFinished(next);
  return { ...next, items: state.items };
}

export function unhideItem(state: ConfirmationState, id: ItemId): ConfirmationState {
  if (!state.hidden.includes(id)) return state;
  const next = snapshotProgress(state);
  next.hidden = next.hidden.filter((h) => h !== id);
  return { ...next, items: state.items };
}

export function dismissHidden(state: ConfirmationState, id: ItemId): ConfirmationState {
  if (!state.hidden.includes(id)) return state;
  const next = snapshotProgress(state);
  next.hidden = next.hidden.filter((h) => h !== id);
  return { ...next, items: state.items };
}

export function forgetHiddenItem(
  state: ConfirmationState,
  id: ItemId,
): ConfirmationState {
  return dismissHidden(state, id);
}

export function restoreHiddenItem(
  state: ConfirmationState,
  id: ItemId,
): ConfirmationState {
  return unhideItem(state, id);
}

export function getInsertFrame(state: ConfirmationState): InsertFrame | null {
  return state.phase === 'insert' ? state.insertFrame : null;
}
