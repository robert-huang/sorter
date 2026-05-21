import { describe, expect, it } from 'vitest';
import { shuffledCopy } from '../shuffle';

describe('shuffledCopy', () => {
  it('returns a copy unchanged for length 0 or 1', () => {
    expect(shuffledCopy([])).toEqual([]);
    expect(shuffledCopy([1])).toEqual([1]);
  });

  it('permutes elements without mutating the input', () => {
    const input = [1, 2, 3, 4];
    const out = shuffledCopy(input, () => 0);
    expect(input).toEqual([1, 2, 3, 4]);
    expect(out).toEqual([2, 3, 4, 1]);
  });
});
