import { describe, expect, it } from 'vitest';
import { backfillPinOrder, compareSlotsForList, nextPinOrder } from '../slotPinOrder';
import type { SlotMeta } from '../types';

function slot(id: string, updatedAt: string, overrides: Partial<SlotMeta> = {}): SlotMeta {
  return {
    id,
    name: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    totalItems: 1,
    comparisons: 0,
    done: false,
    ...overrides,
  };
}

const names = (slots: SlotMeta[]): string[] => slots.map((s) => s.id);

describe('slotPinOrder', () => {
  it('backfills legacy pinned slots in their old recency order', () => {
    const slots = [
      slot('old', '2026-01-01T00:00:00.000Z', { pinned: true }),
      slot('new', '2026-03-01T00:00:00.000Z', { pinned: true }),
      slot('mid', '2026-02-01T00:00:00.000Z', { pinned: true }),
      slot('loose', '2026-04-01T00:00:00.000Z'),
    ];
    const filled = backfillPinOrder(slots);
    expect(filled.map((s) => [s.id, s.pinOrder])).toEqual([
      ['old', 2],
      ['new', 0],
      ['mid', 1],
      ['loose', undefined],
    ]);
    expect(names(filled.slice().sort(compareSlotsForList))).toEqual(['new', 'mid', 'old', 'loose']);
  });

  it('places backfilled slots after already-ordered pins and drops stale orders', () => {
    const slots = [
      slot('ordered', '2026-01-01T00:00:00.000Z', { pinned: true, pinOrder: 4 }),
      slot('legacy', '2026-05-01T00:00:00.000Z', { pinned: true }),
      slot('unpinned', '2026-05-01T00:00:00.000Z', { pinOrder: 2 }),
    ];
    const filled = backfillPinOrder(slots);
    expect(filled.find((s) => s.id === 'legacy')?.pinOrder).toBe(5);
    expect('pinOrder' in filled.find((s) => s.id === 'unpinned')!).toBe(false);
    expect(nextPinOrder(filled)).toBe(6);
  });

  it('returns the same array when nothing needs backfilling', () => {
    const slots = [slot('a', '2026-01-01T00:00:00.000Z', { pinned: true, pinOrder: 0 })];
    expect(backfillPinOrder(slots)).toBe(slots);
  });

  it('keeps pinned slots in pin order regardless of recent use', () => {
    const slots = [
      slot('C', '2026-09-01T00:00:00.000Z', { pinned: true, pinOrder: 2 }),
      slot('A', '2026-01-01T00:00:00.000Z', { pinned: true, pinOrder: 0 }),
      slot('recent', '2026-10-01T00:00:00.000Z'),
      slot('B', '2026-05-01T00:00:00.000Z', { pinned: true, pinOrder: 1 }),
      slot('older', '2026-02-01T00:00:00.000Z'),
    ];
    expect(names(slots.sort(compareSlotsForList))).toEqual(['A', 'B', 'C', 'recent', 'older']);
  });
});
