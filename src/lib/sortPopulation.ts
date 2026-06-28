import type { ItemId, SortProgress, SortState } from './types';

/** Ids that occupy a visible ranking slot (sorted, pending, queue, etc.). */
export function rankingSlotIds(state: SortProgress): Set<ItemId> {
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
 * Count of items participating in the sort right now — ranking slots plus
 * any in-flight insert ids. Ignores stale `items` catalog entries left
 * over after dismiss / forget.
 */
export function activeSortItemCount(state: SortProgress): number {
  const ids = rankingSlotIds(state);
  if (state.engine === 'insertion') {
    if (state.current) ids.add(state.current.insertingId);
  } else {
    if (state.currentManualInsert) {
      ids.add(state.currentManualInsert.insertingId);
    }
    const ai = state.currentAutoInsert;
    if (ai) {
      for (const id of ai.target) ids.add(id);
      for (const id of ai.pendingInserts) ids.add(id);
      if (ai.frame) ids.add(ai.frame.insertingId);
    }
  }
  return ids.size;
}

/** LIST header alias — same count, accepts full in-memory state. */
export function listHeaderItemCount(state: SortState): number {
  return activeSortItemCount(state);
}
