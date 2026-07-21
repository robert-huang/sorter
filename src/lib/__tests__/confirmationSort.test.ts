import { describe, expect, it } from 'vitest';
import {
  getPair,
  hideItem,
  optimisticComparisonsRemaining,
  pickLeft,
  pickRight,
  restoreProgress,
  seedConfirmation,
  snapshotProgress,
} from '../confirmationSort';
import type { ConfirmationProgress, Item } from '../types';
import { selectUndoSnapshot } from '../engine';

const item = (id: string, label: string): Item => ({ id, label });

describe('confirmationSort', () => {
  it('seeds [1..3] with confirmed=[1], candidate=2, queue=[3]', () => {
    const s = seedConfirmation([item('1', '1'), item('2', '2'), item('3', '3')]);
    expect(s.confirmed).toEqual(['1']);
    expect(s.candidate).toBe('2');
    expect(s.queue).toEqual(['3']);
    expect(s.phase).toBe('confirm');
    expect(getPair(s)).toEqual({ leftId: '1', rightId: '2' });
    expect(optimisticComparisonsRemaining(s)).toBe(2);
  });

  it('all left picks on a correct list finish in n-1 comparisons', () => {
    const items = ['1', '2', '3', '4'].map((id) => item(id, id));
    let s = seedConfirmation(items);
    expect(optimisticComparisonsRemaining(s)).toBe(3);
    while (!s.done) {
      s = pickLeft(s);
    }
    expect(s.confirmed).toEqual(['1', '2', '3', '4']);
    expect(s.comparisons).toBe(3);
  });

  it('first right pick prepends candidate when only one item is confirmed', () => {
    const items = ['1', '2', '3'].map((id) => item(id, id));
    let s = seedConfirmation(items);
    s = pickRight(s);
    expect(s.phase).toBe('confirm');
    expect(s.insertFrame).toBeNull();
    expect(s.confirmed).toEqual(['2', '1']);
    expect(s.candidate).toBe('3');
    expect(s.comparisons).toBe(1);
  });

  it('right pick on item 6 inserts into confirmed prefix', () => {
    const ids = ['1', '2', '3', '4', '5', '6', '7'];
    const items = ids.map((id) => item(id, id));
    let s = seedConfirmation(items);
    for (let i = 0; i < 4; i++) s = pickLeft(s);
    expect(s.confirmed).toEqual(['1', '2', '3', '4', '5']);
    expect(s.candidate).toBe('6');
    s = pickRight(s);
    expect(s.phase).toBe('insert');
    expect(s.insertFrame?.insertingId).toBe('6');
    while (s.phase === 'insert') {
      const p = getPair(s);
      expect(p).not.toBeNull();
      s = p!.leftId === '6' ? pickRight(s) : pickLeft(s);
    }
    expect(s.confirmed.indexOf('6')).toBeLessThan(s.confirmed.indexOf('4'));
    expect(s.candidate).toBe('7');
  });

  it('undo skips stacked insert frames at the same comparison depth', () => {
    const items = ['1', '2', '3', '4', '5'].map((id) => item(id, id));
    let s = seedConfirmation(items);
    for (let i = 0; i < 3; i++) s = pickLeft(s);
    s = pickRight(s);
    expect(s.phase).toBe('insert');
    expect(s.comparisons).toBe(4);

    const confirmSnap: ConfirmationProgress = {
      ...(snapshotProgress(s) as ConfirmationProgress),
      phase: 'confirm',
      insertFrame: null,
      comparisons: 3,
      candidate: '5',
    };
    const ring: ConfirmationProgress[] = [
      confirmSnap,
      snapshotProgress(s) as ConfirmationProgress,
      snapshotProgress(s) as ConfirmationProgress,
      snapshotProgress({
        ...s,
        confirmed: [...s.confirmed].reverse(),
      }) as ConfirmationProgress,
    ];

    const selected = selectUndoSnapshot(s, ring);
    expect(selected?.snapshot.engine).toBe('confirmation');
    if (selected?.snapshot.engine !== 'confirmation') {
      throw new Error('expected confirmation snapshot');
    }
    expect(selected.snapshot.phase).toBe('confirm');
    expect(selected.snapshot.comparisons).toBe(3);
  });

  it('hiding the current insert probe advances the frame', () => {
    const items = ['1', '2', '3', '4', '5'].map((id) => item(id, id));
    let s = seedConfirmation(items);
    for (let i = 0; i < 3; i++) s = pickLeft(s);
    s = pickRight(s);
    const before = getPair(s);
    expect(before).not.toBeNull();
    const probeId = before!.rightId;

    s = hideItem(s, probeId);
    expect(s.phase).toBe('insert');
    expect(s.hidden).toContain(probeId);
    const after = getPair(s);
    expect(after).not.toBeNull();
    expect(after!.rightId).not.toBe(probeId);
    expect(s.hidden.includes(after!.rightId)).toBe(false);
  });

  it('restoreProgress restores a confirm-phase snapshot from insert', () => {
    const items = ['1', '2', '3', '4'].map((id) => item(id, id));
    let s = seedConfirmation(items);
    for (let i = 0; i < 2; i++) s = pickLeft(s);
    const snap = snapshotProgress(s);
    s = pickRight(s);
    expect(s.phase).toBe('insert');
    const restored = restoreProgress(s, snap as ConfirmationProgress);
    expect(restored.phase).toBe('confirm');
    expect(restored.insertFrame).toBeNull();
    expect(restored.comparisons).toBe(2);
  });
});
