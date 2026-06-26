import { describe, expect, it } from 'vitest';
import { parseLinesOnePerLine, stripFranchiseFormatSuffix } from '../parseToolLines';

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

  it('strips trailing franchise-format suffixes so a franchise clipboard payload is usable as-is', () => {
    // Mirrors buildFranchiseClipboardText output: one "Title (FORMAT)"
    // per line. Pasting this into any title-driven tool should "just work".
    const pasted = [
      'Bakemonogatari (TV)',
      'Kizumonogatari I: Tekketsu-hen (MOVIE)',
      'Bakemonogatari (MANGA)',
      'Owarimonogatari (ANIME)',
    ].join('\n');
    expect(parseLinesOnePerLine(pasted)).toEqual([
      'Bakemonogatari',
      'Kizumonogatari I: Tekketsu-hen',
      'Bakemonogatari',
      'Owarimonogatari',
    ]);
  });

  it('leaves parenthesized year/era suffixes alone', () => {
    // These are real AniList title fragments — stripping any trailing
    // (...) would corrupt them. Only the format-token whitelist matches.
    expect(parseLinesOnePerLine('Steins;Gate (2011)\nFate/stay night (2006)')).toEqual([
      'Steins;Gate (2011)',
      'Fate/stay night (2006)',
    ]);
  });
});

describe('stripFranchiseFormatSuffix', () => {
  it('strips exactly the trailing (FORMAT) when FORMAT is a known token', () => {
    expect(stripFranchiseFormatSuffix('Foo (TV)')).toBe('Foo');
    expect(stripFranchiseFormatSuffix('Foo (TV_SHORT)')).toBe('Foo');
    expect(stripFranchiseFormatSuffix('Foo (ONE_SHOT)')).toBe('Foo');
    expect(stripFranchiseFormatSuffix('Foo Bar Baz (MOVIE)')).toBe('Foo Bar Baz');
  });

  it('leaves non-format parentheticals alone', () => {
    expect(stripFranchiseFormatSuffix('Steins;Gate (2011)')).toBe('Steins;Gate (2011)');
    expect(stripFranchiseFormatSuffix('Show (Director\'s Cut)')).toBe(
      "Show (Director's Cut)",
    );
  });

  it('only strips the suffix, not an internal parenthetical', () => {
    expect(stripFranchiseFormatSuffix('Show (TV) Special')).toBe('Show (TV) Special');
  });

  it('requires whitespace before the suffix so glued tokens are left intact', () => {
    // No franchise output produces this shape; if it ever appears it's
    // more likely a real title than a format suffix.
    expect(stripFranchiseFormatSuffix('Show(TV)')).toBe('Show(TV)');
  });

  it('is idempotent', () => {
    const once = stripFranchiseFormatSuffix('Foo (TV)');
    expect(stripFranchiseFormatSuffix(once)).toBe(once);
  });
});
