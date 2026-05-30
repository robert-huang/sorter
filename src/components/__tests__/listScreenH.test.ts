import { describe, expect, it } from 'vitest';
import { mergeSliceLabel } from '../listScreenH';

describe('mergeSliceLabel', () => {
  it('appends the count in parentheses', () => {
    expect(mergeSliceLabel('Merged so far', 1)).toBe('Merged so far (1)');
    expect(mergeSliceLabel('Left remaining', 4)).toBe('Left remaining (4)');
  });
});
