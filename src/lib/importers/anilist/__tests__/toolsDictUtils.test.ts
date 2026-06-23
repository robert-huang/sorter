import { describe, expect, it } from 'vitest';
import { dictDiffs, dictIntersection } from '../toolsDictUtils';

describe('toolsDictUtils', () => {
  const a = { '1': 'a', '2': 'b', '3': 'c' };
  const b = { '2': 'b', '3': 'c', '4': 'd' };
  const c = { '3': 'c', '5': 'e' };

  it('dictIntersection returns keys in all dicts by default', () => {
    expect(dictIntersection([a, b, c])).toEqual(['3']);
  });

  it('dictIntersection supports minimum match threshold', () => {
    expect(dictIntersection([a, b, c], 2)).toEqual(['2', '3']);
  });

  it('dictDiffs returns per-dict unique keys preserving order', () => {
    expect(dictDiffs([a, b])).toEqual([['1'], ['4']]);
  });
});
