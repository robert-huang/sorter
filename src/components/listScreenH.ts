import type { ItemId, MergeState } from '../lib/types';
import { getInsertPair } from '../lib/binaryInsertion';

export function mergeSliceLabel(base: string, count: number): string {
  return `${base} (${count})`;
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
  if (!pendingRunIds || pendingRunIds.length !== pending.length) {
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

/**
 * During merge-engine auto- or manual-insert, the LIST tab can show the
 * full target sublist and the remaining incoming items instead of only
 * the active A/B pair. Returns null when not in an active insert frame.
 */
export interface InsertMergeContextView {
  /** Larger sublist (or queue target) being merged into. */
  targetIds: ItemId[];
  /** Smaller sublist still to land: active insert first, then queued. */
  remainingIds: ItemId[];
  insertingId: ItemId;
  probeId: ItemId;
}

export function getInsertMergeContext(
  state: MergeState,
): InsertMergeContextView | null {
  if (state.engine !== 'merge') return null;

  if (state.currentManualInsert?.frame) {
    const mi = state.currentManualInsert;
    const frame = mi.frame;
    if (!frame) return null;
    const target = state.queue[mi.targetQueueIndex];
    if (!target) return null;
    const pair = getInsertPair(frame, target);
    if (!pair) return null;
    return {
      targetIds: [...target],
      remainingIds: [pair.leftId],
      insertingId: pair.leftId,
      probeId: pair.rightId,
    };
  }

  if (state.currentAutoInsert?.frame) {
    const ai = state.currentAutoInsert;
    const frame = ai.frame;
    if (!frame) return null;
    const pair = getInsertPair(frame, ai.target);
    if (!pair) return null;
    return {
      targetIds: [...ai.target],
      remainingIds: [pair.leftId, ...ai.pendingInserts],
      insertingId: pair.leftId,
      probeId: pair.rightId,
    };
  }

  return null;
}
