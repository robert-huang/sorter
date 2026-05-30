import { describe, expect, it } from 'vitest';
import { peekOverflowLabel } from '../compareScreenH';

describe('peekOverflowLabel', () => {
  it('formats the overflow tail with item count', () => {
    expect(peekOverflowLabel(1)).toBe('...1 item');
    expect(peekOverflowLabel(2)).toBe('...2 items');
    expect(peekOverflowLabel(12)).toBe('...12 items');
  });
});
