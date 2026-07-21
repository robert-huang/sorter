import { describe, expect, it } from 'vitest';
import {
  confirmationAnimKinds,
  enginePickToVisualSide,
  insertingItemLanded,
  peekOverflowLabel,
  swapsInsertCompareSides,
  visualComparePair,
  visualPeekSides,
} from '../compareScreenH';

describe('peekOverflowLabel', () => {
  it('formats the overflow tail with item count', () => {
    expect(peekOverflowLabel(1)).toBe('...1 item');
    expect(peekOverflowLabel(2)).toBe('...2 items');
    expect(peekOverflowLabel(12)).toBe('...12 items');
  });
});

describe('insert compare display helpers', () => {
  const pair = { leftId: 'inserting', rightId: 'probe' };

  it('swaps sides for insert modes only', () => {
    expect(swapsInsertCompareSides('merging')).toBe(false);
    expect(swapsInsertCompareSides('confirming')).toBe(false);
    expect(swapsInsertCompareSides('inserting')).toBe(true);
    expect(swapsInsertCompareSides('manual-insert')).toBe(true);
    expect(swapsInsertCompareSides('auto-insert')).toBe(true);
  });

  it('maps engine pair to probe-left / inserting-right', () => {
    expect(visualComparePair(pair, false)).toEqual(pair);
    expect(visualComparePair(pair, true)).toEqual({
      leftId: 'probe',
      rightId: 'inserting',
    });
  });

  it('maps engine pick side to visual side when swapped', () => {
    expect(enginePickToVisualSide('left', false)).toBe('left');
    expect(enginePickToVisualSide('right', true)).toBe('left');
    expect(enginePickToVisualSide('left', true)).toBe('right');
  });

  it('maps engine peek decks to visual sides when swapped', () => {
    expect(
      visualPeekSides([], ['probe-next'], true),
    ).toEqual({ left: ['probe-next'], right: [] });
    expect(
      visualPeekSides([], ['probe-next'], false),
    ).toEqual({ left: [], right: ['probe-next'] });
  });

  it('detects when an inserting item just landed', () => {
    const prev = { rightId: 'inserting' };
    expect(insertingItemLanded('inserting', prev, 'next')).toBe(true);
    expect(insertingItemLanded('insert', prev, 'next')).toBe(true);
    expect(insertingItemLanded('inserting', prev, 'inserting')).toBe(false);
    expect(insertingItemLanded('inserting', prev, null)).toBe(true);
    expect(insertingItemLanded('confirm', prev, null)).toBe(false);
  });

  it('picks confirmation compare animation kinds', () => {
    const prev = { leftId: 'a', rightId: 'b' };
    expect(
      confirmationAnimKinds(prev, { leftId: 'b', rightId: 'c' }, 'confirm', 'confirm', null),
    ).toEqual({ left: 'pop', right: 'pop' });
    expect(
      confirmationAnimKinds(prev, { leftId: 'p1', rightId: 'b' }, 'confirm', 'insert', 'b'),
    ).toEqual({ left: 'pop', right: 'none' });
    expect(
      confirmationAnimKinds(
        { leftId: 'p1', rightId: 'b' },
        { leftId: 'p2', rightId: 'b' },
        'insert',
        'insert',
        'b',
      ),
    ).toEqual({ left: 'deck', right: 'none' });
    expect(
      confirmationAnimKinds(
        { leftId: 'p1', rightId: 'b' },
        { leftId: 'p2', rightId: 'c' },
        'insert',
        'insert',
        'c',
      ),
    ).toEqual({ left: 'deck', right: 'pop' });
  });
});
