import { describe, expect, it } from 'vitest';
import { parseLinesOnePerLine } from '../parseToolLines';

describe('parseLinesOnePerLine', () => {
  it('splits on newlines only', () => {
    expect(parseLinesOnePerLine('A\nB\nC')).toEqual(['A', 'B', 'C']);
  });

  it('does not split on commas', () => {
    expect(parseLinesOnePerLine('Foo, Bar')).toEqual(['Foo, Bar']);
  });

  it('trims and drops blank lines', () => {
    expect(parseLinesOnePerLine('  A \n\n B ')).toEqual(['A', 'B']);
  });
});
