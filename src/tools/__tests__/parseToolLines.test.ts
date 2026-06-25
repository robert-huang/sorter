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

  it('strips a leading UTF-8 BOM (Excel/Notepad CSV export)', () => {
    expect(parseLinesOnePerLine('\ufeffA\nB')).toEqual(['A', 'B']);
  });

  it('handles CRLF line endings without leaving stray \\r', () => {
    expect(parseLinesOnePerLine('A\r\nB\r\nC')).toEqual(['A', 'B', 'C']);
  });

  it('returns an empty array for empty / whitespace-only input', () => {
    expect(parseLinesOnePerLine('')).toEqual([]);
    expect(parseLinesOnePerLine('   \n  \n')).toEqual([]);
    expect(parseLinesOnePerLine('\ufeff')).toEqual([]);
  });
});
