import type { SlotMeta } from './types';

function byRecency(a: SlotMeta, b: SlotMeta): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

/** Next `pinOrder` for a newly pinned slot: one past the highest in use. */
export function nextPinOrder(slots: readonly SlotMeta[]): number {
  let max = -1;
  for (const slot of slots) {
    if (slot.pinned && slot.pinOrder !== undefined) max = Math.max(max, slot.pinOrder);
  }
  return max + 1;
}

/**
 * Gives pinned slots without a `pinOrder` one after the existing ones, in recency order
 * (the order they showed before pin order existed), and drops it from unpinned slots.
 * Returns the input array when nothing changes.
 */
export function backfillPinOrder(slots: SlotMeta[]): SlotMeta[] {
  const missing = slots.filter((slot) => slot.pinned && slot.pinOrder === undefined).sort(byRecency);
  const stale = slots.some((slot) => !slot.pinned && slot.pinOrder !== undefined);
  if (missing.length === 0 && !stale) return slots;
  let next = nextPinOrder(slots);
  const assigned = new Map(missing.map((slot) => [slot.id, next++]));
  return slots.map((slot) => {
    if (!slot.pinned) {
      if (slot.pinOrder === undefined) return slot;
      const { pinOrder: _dropped, ...rest } = slot;
      return rest;
    }
    const order = assigned.get(slot.id);
    return order === undefined ? slot : { ...slot, pinOrder: order };
  });
}

/** Renumbers pinned slots 0..n-1 in their current order, so unpin/re-pin leaves no gaps. */
export function compactPinOrder(slots: SlotMeta[]): SlotMeta[] {
  const rank = new Map(
    slots
      .filter((slot) => slot.pinned)
      .sort(compareSlotsForList)
      .map((slot, index) => [slot.id, index]),
  );
  return slots.map((slot) => {
    const order = rank.get(slot.id);
    return order === undefined || slot.pinOrder === order ? slot : { ...slot, pinOrder: order };
  });
}

/** Pinned slots first in pin order, then everything else by most recent use. */
export function compareSlotsForList(a: SlotMeta, b: SlotMeta): number {
  const pa = a.pinned ? 1 : 0;
  const pb = b.pinned ? 1 : 0;
  if (pa !== pb) return pb - pa;
  if (a.pinned) {
    const oa = a.pinOrder ?? Number.POSITIVE_INFINITY;
    const ob = b.pinOrder ?? Number.POSITIVE_INFINITY;
    if (oa !== ob) return oa - ob;
  }
  return byRecency(a, b);
}
