import type { ItemId } from '../lib/types';

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
