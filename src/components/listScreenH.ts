import { getPair } from '../lib/engine';
import {
  skipHiddenInsertProbes,
} from '../lib/binaryInsertion';
import type { InsertFrame, InsertionState, ItemId, SortState } from '../lib/types';
import {
  listHeaderItemCount,
  activeRankingIds,
  rankingSlotIds,
} from '../lib/sortPopulation';

export { listHeaderItemCount, activeRankingIds, rankingSlotIds };

export function mergeSliceLabel(base: string, count: number): string {
  return `${base} (${count})`;
}

/** Human-readable label when a hidden id has no `items` metadata. */
export function formatOrphanHiddenId(id: ItemId): string {
  return id.replace(/-/g, ' ');
}

/**
 * Hidden ids that no longer appear in any ranking list row — e.g. removed
 * from pending during insertion, or exiled from merge without landing in
 * `toBeInserted`. These only show up in the header count unless we render
 * a dedicated "removed" section.
 */
export function hiddenIdsNotInRanking(state: SortState): ItemId[] {
  const slots = rankingSlotIds(state);
  return state.hidden.filter((id) => !slots.has(id));
}

/** Rank label for a hidden id still sitting in a ranking list row. */
export function rankLabelForHiddenId(state: SortState, id: ItemId): string {
  if (state.engine === 'insertion') {
    const i = state.sorted.indexOf(id);
    if (i >= 0) return `${i + 1}.`;
  } else if (state.done && state.queue.length === 1) {
    const i = state.queue[0].indexOf(id);
    if (i >= 0) return `${i + 1}.`;
  } else {
    for (let qi = 0; qi < state.queue.length; qi++) {
      const i = state.queue[qi].indexOf(id);
      if (i >= 0) return `${qi + 1}:${i + 1}`;
    }
  }
  return '—';
}

export type InsertionPendingGroupKind = 'flat' | 'preranked' | 'extras';

export interface InsertionPendingGroup {
  kind: InsertionPendingGroupKind;
  /** Engine run id when `kind === 'preranked'`. */
  runId?: number;
  ids: ItemId[];
}

/**
 * Split insertion-mode `pending[]` into display groups. When
 * `pendingRunIds` is present (seeded via `seedInsertionFromSublists`),
 * multi-item runs render as pre-ranked sublist blocks; trailing
 * singleton runs collapse into one extras bucket. Without run metadata
 * the whole pending list stays flat (legacy / flat-from-scratch path).
 */
export function groupInsertionPending(
  pending: ItemId[],
  pendingRunIds: number[] | undefined,
): InsertionPendingGroup[] {
  if (pending.length === 0) return [];
  if (!pendingRunIds) {
    return [{ kind: 'flat', ids: [...pending] }];
  }
  if (pendingRunIds.length !== pending.length) {
    // Length divergence means the sublist sublist UI is going to disappear
    // and the user has no signal as to why. Warn loudly in the console
    // so a regression is at least debuggable.
    console.warn(
      `[insertion] pendingRunIds length (${pendingRunIds.length}) does not match pending length (${pending.length}); flattening sublist groups.`,
    );
    return [{ kind: 'flat', ids: [...pending] }];
  }

  const raw: { runId: number; ids: ItemId[] }[] = [];
  for (let i = 0; i < pending.length; i++) {
    const rid = pendingRunIds[i];
    const tail = raw[raw.length - 1];
    if (tail && tail.runId === rid) {
      tail.ids.push(pending[i]);
    } else {
      raw.push({ runId: rid, ids: [pending[i]] });
    }
  }

  const out: InsertionPendingGroup[] = [];
  const singletonIds: ItemId[] = [];
  for (const g of raw) {
    if (g.ids.length >= 2) {
      out.push({ kind: 'preranked', runId: g.runId, ids: g.ids });
    } else {
      singletonIds.push(g.ids[0]);
    }
  }
  if (singletonIds.length > 0) {
    out.push({ kind: 'extras', ids: singletonIds });
  }
  return out;
}

/** True when this insertion sort was seeded from multiple pre-ranked sublists. */
export function insertionSortFromSublists(
  pendingRunIds: number[] | undefined,
): boolean {
  return pendingRunIds !== undefined;
}

export type InsertContextKind = 'insertion' | 'merge-manual' | 'merge-auto';

/**
 * During any binary-insert compare (insertion engine, merge auto-insert, or
 * merge manual-insert), the LIST tab can show the full target list and the
 * remaining incoming items instead of only the active A/B pair.
 */
export interface InsertContextView {
  kind: InsertContextKind;
  /** Target list being inserted into. */
  targetIds: ItemId[];
  /** Items still to land: active insert first, then queued. */
  remainingIds: ItemId[];
  insertingId: ItemId;
  probeId: ItemId;
  /** Absolute `[lo, hi]` into `targetIds` after probe-skip (undecided window). */
  windowLo: number;
  windowHi: number;
  /** merge-auto: full smaller sublist in original order (for LIST panel). */
  sourceSublistIds?: ItemId[];
  /** merge-auto: sublist pairs still waiting in the merge queue. */
  queueSublistCount?: number;
}

function insertContextWindowFields(
  frame: InsertFrame,
  targetIds: ItemId[],
  hidden: ItemId[],
): Pick<InsertContextView, 'windowLo' | 'windowHi'> {
  const hiddenSet = new Set(hidden);
  const effective = skipHiddenInsertProbes(frame, targetIds, hiddenSet);
  if ('done' in effective) {
    return { windowLo: frame.lo, windowHi: frame.hi };
  }
  return { windowLo: effective.lo, windowHi: effective.hi };
}

/**
 * Label for an insertion gap (0 = before first item, n = after last).
 * `lo` marks the earliest slot still in play; `hi` the latest.
 */
export function insertContextGapLabel(
  gap: number,
  windowLo: number,
  windowHi: number,
): string | null {
  const isLo = gap === windowLo;
  const isHi = gap === windowHi + 1;
  if (isLo && isHi) return 'lo · hi';
  if (isLo) return 'lo';
  if (isHi) return 'hi';
  return null;
}

export function getInsertContext(state: SortState): InsertContextView | null {
  const pair = getPair(state);
  if (!pair) return null;

  if (state.engine === 'insertion') {
    return getInsertionEngineInsertContext(state, pair);
  }

  if (state.current) return null;

  if (state.currentManualInsert?.frame) {
    const mi = state.currentManualInsert;
    const frame = mi.frame;
    if (!frame) return null;
    const target = state.queue[mi.targetQueueIndex];
    if (!target) return null;
    return {
      kind: 'merge-manual',
      targetIds: [...target],
      remainingIds: [pair.leftId, ...state.pendingManualInserts],
      insertingId: pair.leftId,
      probeId: pair.rightId,
      ...insertContextWindowFields(frame, target, state.hidden),
    };
  }

  if (state.currentAutoInsert?.frame) {
    const ai = state.currentAutoInsert;
    const frame = ai.frame;
    if (!frame) return null;
    const sourceSublistIds =
      ai.sourceSublist ??
      [frame.insertingId, ...ai.pendingInserts];
    return {
      kind: 'merge-auto',
      targetIds: [...ai.target],
      remainingIds: [pair.leftId, ...ai.pendingInserts],
      sourceSublistIds,
      queueSublistCount: state.queue.length,
      insertingId: pair.leftId,
      probeId: pair.rightId,
      ...insertContextWindowFields(frame, ai.target, state.hidden),
    };
  }

  return null;
}

function getInsertionEngineInsertContext(
  state: InsertionState,
  pair: { leftId: ItemId; rightId: ItemId },
): InsertContextView {
  const frame = state.current!;
  return {
    kind: 'insertion',
    targetIds: [...state.sorted],
    remainingIds: [pair.leftId, ...state.pending],
    insertingId: pair.leftId,
    probeId: pair.rightId,
    ...insertContextWindowFields(frame, state.sorted, state.hidden),
  };
}

/** Heading for the right-hand INSERTING panel in {@link InsertContextSection}. */
export function insertContextInsertingLabel(
  ctx: InsertContextView,
  visibleRemainingCount: number,
): string {
  if (ctx.kind === 'merge-auto' && ctx.sourceSublistIds) {
    const n = ctx.sourceSublistIds.length;
    const m = Math.max(1, ctx.sourceSublistIds.indexOf(ctx.insertingId) + 1);
    const k = ctx.queueSublistCount ?? 0;
    const queueLabel = k === 1 ? '1 sublist in queue' : `${k} sublists in queue`;
    return `Inserting (${m} of ${n} · ${queueLabel})`;
  }
  return mergeSliceLabel('Inserting', visibleRemainingCount);
}

export type AutoInsertSourceRowState = 'inserting' | 'queued' | 'done';

/** Row state for merge-auto source sublist items in the INSERTING panel. */
export function autoInsertSourceRowState(
  ctx: InsertContextView,
  id: ItemId,
): AutoInsertSourceRowState {
  if (id === ctx.insertingId) return 'inserting';
  if (ctx.remainingIds.includes(id)) return 'queued';
  return 'done';
}

