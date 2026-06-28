import { getPair } from '../lib/engine';
import type { InsertionState, ItemId, SortState } from '../lib/types';

export function mergeSliceLabel(base: string, count: number): string {
  return `${base} (${count})`;
}

/** Human-readable label when a hidden id has no `items` metadata. */
export function formatOrphanHiddenId(id: ItemId): string {
  return id.replace(/-/g, ' ');
}

/** Ids that occupy a visible ranking slot (sorted, pending, queue, etc.). */
export function rankingSlotIds(state: SortState): Set<ItemId> {
  const ranked = new Set<ItemId>();
  if (state.engine === 'insertion') {
    for (const id of state.sorted) ranked.add(id);
    for (const id of state.pending) ranked.add(id);
  } else {
    for (const sub of state.queue) {
      for (const id of sub) ranked.add(id);
    }
    for (const id of state.toBeInserted) ranked.add(id);
  }
  return ranked;
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
    };
  }

  if (state.currentAutoInsert?.frame) {
    const ai = state.currentAutoInsert;
    const frame = ai.frame;
    if (!frame) return null;
    return {
      kind: 'merge-auto',
      targetIds: [...ai.target],
      remainingIds: [pair.leftId, ...ai.pendingInserts],
      insertingId: pair.leftId,
      probeId: pair.rightId,
    };
  }

  return null;
}

function getInsertionEngineInsertContext(
  state: InsertionState,
  pair: { leftId: ItemId; rightId: ItemId },
): InsertContextView {
  return {
    kind: 'insertion',
    targetIds: [...state.sorted],
    remainingIds: [pair.leftId, ...state.pending],
    insertingId: pair.leftId,
    probeId: pair.rightId,
  };
}

