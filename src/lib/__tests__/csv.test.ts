import { describe, expect, it } from 'vitest';
import {
  canonicalKey,
  dedupRows,
  looksLikeHeader,
  mergeIntoExisting,
  PAPA_COMMA_CSV_OPTIONS,
  parseCsvRows,
  parseExtrasText,
  parseSources,
  type RawRow,
} from '../csv';
import type { Item } from '../types';

describe('canonicalKey', () => {
  it('trims and lowercases', () => {
    expect(canonicalKey('  The Mind  ')).toBe('the-mind');
    expect(canonicalKey('INCEPTION')).toBe('inception');
  });
  it('replaces each non-letter/non-digit with a dash (edge runs stripped)', () => {
    expect(canonicalKey("It's a Wonderful Life!!")).toBe(
      'it-s-a-wonderful-life',
    );
  });
  it('falls back to "item" for empty/garbage input', () => {
    expect(canonicalKey('')).toBe('item');
    expect(canonicalKey('   ')).toBe('item');
    expect(canonicalKey('!!')).toBe('item');
  });
  it('preserves diacritics via NFKC (Café stays distinct from caf)', () => {
    // Pre-fix behavior stripped the é (Café → 'caf', colliding with the
    // word "Caf"). NFKC + Unicode letter class keeps the accent.
    expect(canonicalKey('Cafe')).toBe('cafe');
    expect(canonicalKey('Café')).toBe('café');
    expect(canonicalKey('Café')).not.toBe(canonicalKey('Cafe'));
  });
  it('keeps CJK characters as letters (each title gets its own id)', () => {
    expect(canonicalKey('君の膵臓をたべたい')).toBe('君の膵臓をたべたい');
    expect(canonicalKey('物語シリーズ')).toBe('物語シリーズ');
    // Two distinct CJK labels must produce two distinct ids — guards
    // against the regression where every all-CJK label collapsed to
    // the literal fallback 'item'.
    expect(canonicalKey('君の膵臓をたべたい')).not.toBe(
      canonicalKey('物語シリーズ'),
    );
  });
  it('NFKC-normalizes full-width Latin and digits to ASCII', () => {
    // ＣＬＡＮＮＡＤ (fullwidth) → CLANNAD (ASCII) → 'clannad'; the ` ~`
    // between sections is TWO non-letter chars so it becomes `--`.
    expect(canonicalKey('ＣＬＡＮＮＡＤ ~After Story~')).toBe(
      'clannad--after-story',
    );
    expect(canonicalKey('進撃の巨人２')).toBe('進撃の巨人2');
    // Roman numerals decompose: Ⅱ → 'II', then lowercase.
    expect(canonicalKey('傷物語〈Ⅱ熱血篇〉')).toBe('傷物語-ii熱血篇');
  });
  it('distinguishes punctuation-run lengths (Kaguya-sama fix)', () => {
    // The motivating regression: ～ (single) vs ？～ (pair) MUST produce
    // distinct ids. Under a previous collapsing variant, both would
    // become 'foo-bar'.
    expect(canonicalKey('foo~bar')).toBe('foo-bar');
    expect(canonicalKey('foo?~bar')).toBe('foo--bar');
    expect(canonicalKey('foo~bar')).not.toBe(canonicalKey('foo?~bar'));
    // Kaguya-sama S1 vs S2 — concrete instance of the same shape.
    expect(canonicalKey('かぐや様は告らせたい～天才たちの恋愛頭脳戦～')).not.toBe(
      canonicalKey('かぐや様は告らせたい？～天才たちの恋愛頭脳戦～'),
    );
  });
});

describe('looksLikeHeader', () => {
  it('detects standard headers', () => {
    expect(looksLikeHeader(['item', 'url', 'image'])).toBe(true);
    expect(looksLikeHeader(['Label', 'Link', 'Picture'])).toBe(true);
    expect(looksLikeHeader(['title'])).toBe(true);
    expect(looksLikeHeader(['name', '', ''])).toBe(true);
  });
  it('rejects when col 1 is data-like', () => {
    expect(looksLikeHeader(['Pit', '', ''])).toBe(false);
    expect(looksLikeHeader(['The Mind'])).toBe(false);
  });
  it('rejects when col 2 is data-like', () => {
    expect(looksLikeHeader(['item', 'https://example.com', ''])).toBe(false);
  });
  it('rejects when col 3 is data-like', () => {
    expect(looksLikeHeader(['item', 'url', 'https://example.com/pic.png'])).toBe(false);
  });
});

describe('parseCsvRows', () => {
  it('parses basic CSV without header', () => {
    const r = parseCsvRows('A\nB\nC', 'test', false);
    expect(r.rows.map((x) => x.label)).toEqual(['A', 'B', 'C']);
  });
  it('skips the header row when requested', () => {
    const r = parseCsvRows('ITEM\nA\nB', 'test', true);
    expect(r.rows.map((x) => x.label)).toEqual(['A', 'B']);
  });
  it('returns detectedHeader regardless of skipHeader', () => {
    const r = parseCsvRows('ITEM,URL\nA,https://x', 'test', false);
    expect(r.detectedHeader).toBe(true);
    // Header row included as data: commas join because neither cell is a URL.
    expect(r.rows.map((x) => x.label)).toEqual(['ITEM, URL', 'A']);
    expect(r.commaInLabel.length).toBe(1);
    expect(r.commaInLabel[0].rowNumber).toBe(1);
  });
  it('parses URL and IMAGE columns', () => {
    const r = parseCsvRows('A,https://x,https://y', 'test', false);
    expect(r.rows[0]).toMatchObject({
      label: 'A',
      url: 'https://x',
      imageUrl: 'https://y',
    });
  });
  it('skips empty rows and trims labels', () => {
    const r = parseCsvRows('  A  \n\n  B  ', 'test', false);
    expect(r.rows.map((x) => x.label)).toEqual(['A', 'B']);
  });
  it('handles quoted fields with commas inside', () => {
    const r = parseCsvRows('"Pit, the game",https://x,', 'test', false);
    expect(r.rows[0].label).toBe('Pit, the game');
    expect(r.rows[0].url).toBe('https://x');
  });
  it('does not split semicolons in title-only rows (comma delimiter only)', () => {
    const r = parseCsvRows('Steins;Gate (TV)', 'test', false);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].label).toBe('Steins;Gate (TV)');
    expect(r.commaInLabel).toEqual([]);
    expect(r.rows[0].url).toBeUndefined();
  });
  it('PAPA_COMMA_CSV_OPTIONS pins comma delimiter', () => {
    expect(PAPA_COMMA_CSV_OPTIONS.delimiter).toBe(',');
  });

  it('returns an empty result for empty/whitespace-only input', () => {
    const r = parseCsvRows('', 'test', false);
    expect(r.rows).toEqual([]);
    expect(r.detectedHeader).toBe(false);
    expect(r.extraColumns).toEqual([]);
    expect(r.commaInLabel).toEqual([]);

    const r2 = parseCsvRows('   \n  \n', 'test', false);
    expect(r2.rows).toEqual([]);
  });

  it('handles CRLF line endings (Windows / Excel exports)', () => {
    const r = parseCsvRows('A\r\nB\r\nC', 'test', false);
    expect(r.rows.map((x) => x.label)).toEqual(['A', 'B', 'C']);
  });
});

describe('parseExtrasText edge cases', () => {
  it('handles CRLF line endings', () => {
    const rows = parseExtrasText('A\r\nB\r\nC');
    expect(rows.map((r) => r.label)).toEqual(['A', 'B', 'C']);
  });

  it('returns [] for empty/whitespace-only input', () => {
    expect(parseExtrasText('')).toEqual([]);
    expect(parseExtrasText('  \n  \n')).toEqual([]);
  });
});

describe('parseCsvRows comma-in-label repair', () => {
  it('joins a 3-cell title-only row and emits a warning', () => {
    const r = parseCsvRows('inari, konkon, koi iroha.', 'test', false);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].label).toBe('inari, konkon, koi iroha.');
    expect(r.rows[0].url).toBeUndefined();
    expect(r.rows[0].imageUrl).toBeUndefined();
    expect(r.commaInLabel.length).toBe(1);
    const w = r.commaInLabel[0];
    expect(w.naiveParsedAs).toEqual({
      label: 'inari',
      url: 'konkon',
      imageUrl: 'koi iroha.',
    });
    expect(w.repairedLabel).toBe('inari, konkon, koi iroha.');
    expect(w.cellCount).toBe(3);
    expect(r.rows[0].rawCells).toEqual(w.rawCells);
  });

  it('joins a 2-cell title and emits a warning', () => {
    const r = parseCsvRows('Title, with comma', 'test', false);
    expect(r.rows[0].label).toBe('Title, with comma');
    expect(r.commaInLabel.length).toBe(1);
    expect(r.commaInLabel[0].naiveParsedAs).toEqual({
      label: 'Title',
      url: 'with comma',
      imageUrl: undefined,
    });
  });

  it('does not repair rows with a URL in trailing cells', () => {
    const r = parseCsvRows('A,https://x,https://y', 'test', false);
    expect(r.rows[0]).toMatchObject({
      label: 'A',
      url: 'https://x',
      imageUrl: 'https://y',
    });
    expect(r.commaInLabel).toEqual([]);
    expect(r.rows[0].rawCells).toBeUndefined();
  });

  it('keeps extraColumns (not commaInLabel) when a URL is present past 3 cells', () => {
    const r = parseCsvRows('Foo, Bar, Baz,https://x,https://img', 'test', false);
    expect(r.extraColumns.length).toBe(1);
    expect(r.commaInLabel).toEqual([]);
    expect(r.rows[0].label).toBe('Foo');
  });

  it('does not repair single-cell rows', () => {
    const r = parseCsvRows('Codenames', 'test', false);
    expect(r.commaInLabel).toEqual([]);
    expect(r.rows[0].label).toBe('Codenames');
  });
});

describe('parseSources comma-in-label flow', () => {
  it('concatenates commaInLabel across sources in input order', () => {
    const r = parseSources([
      {
        sourceName: 'list-a',
        rawRows: [{ label: 'A', sourceName: 'list-a', sourceRow: 1 }],
        detectedHeader: false,
        commaInLabel: [
          {
            sourceName: 'list-a',
            rowNumber: 2,
            cellCount: 2,
            rawCells: ['Foo', ' Bar'],
            naiveParsedAs: { label: 'Foo', url: 'Bar' },
            repairedLabel: 'Foo, Bar',
          },
        ],
      },
      {
        sourceName: 'list-b',
        rawRows: [{ label: 'B', sourceName: 'list-b', sourceRow: 1 }],
        detectedHeader: false,
        commaInLabel: [
          {
            sourceName: 'list-b',
            rowNumber: 1,
            cellCount: 3,
            rawCells: ['x', 'y', 'z'],
            naiveParsedAs: { label: 'x', url: 'y', imageUrl: 'z' },
            repairedLabel: 'x, y, z',
          },
        ],
      },
    ]);
    expect(r.commaInLabel.map((w) => w.sourceName)).toEqual(['list-a', 'list-b']);
  });

  it('omitted commaInLabel on a SourceParse counts as zero', () => {
    const r = parseSources([
      {
        sourceName: 'list-a',
        rawRows: [{ label: 'A', sourceName: 'list-a', sourceRow: 1 }],
        detectedHeader: false,
      },
    ]);
    expect(r.commaInLabel).toEqual([]);
  });
});

describe('parseCsvRows extra-columns warning', () => {
  // Motivating case: a label like `Foo, Bar, Baz` *without* enclosing
  // quotes parses into 4 cells and silently misaligns columns. The
  // warning lets the user spot it before the rawCells are dropped at
  // session start.
  it('flags rows with more than 3 non-empty cells', () => {
    const r = parseCsvRows('Foo, Bar, Baz,https://x,https://img', 'test', false);
    expect(r.extraColumns.length).toBe(1);
    const w = r.extraColumns[0];
    expect(w.sourceName).toBe('test');
    expect(w.rowNumber).toBe(1);
    expect(w.cellCount).toBe(5);
    expect(w.parsedAs.label).toBe('Foo');
    // Best-effort: the URL/IMAGE columns get hijacked by the comma
    // fragments. The warning's job is to surface that to the user.
    expect(w.parsedAs.url).toBe('Bar');
    expect(w.parsedAs.imageUrl).toBe('Baz');
  });

  it('attaches rawCells to BOTH the warning and the corresponding RawRow', () => {
    // The modal pulls rawCells off the RawRow via the StartScreen
    // overlay, while the preview surfaces it via the warning entry —
    // both must agree, and both must contain the verbatim parsed
    // cells so the user can copy substrings out.
    const r = parseCsvRows('Foo, Bar,https://x,https://img', 'test', false);
    expect(r.extraColumns.length).toBe(1);
    expect(r.extraColumns[0].rawCells).toEqual([
      'Foo',
      ' Bar',
      'https://x',
      'https://img',
    ]);
    expect(r.rows[0].rawCells).toEqual(r.extraColumns[0].rawCells);
  });

  it('does NOT flag a row with trailing empty cells (uniform-width CSV)', () => {
    // A CSV with one row that has trailing empties — `A,,,,` — is
    // syntactically 5 cells but only 1 is non-empty. The user clearly
    // didn't intend any data in those columns; warning here would
    // be noise.
    const r = parseCsvRows('A,,,,\nB,,,,', 'test', false);
    expect(r.extraColumns).toEqual([]);
    expect(r.rows.map((x) => x.label)).toEqual(['A', 'B']);
    expect(r.rows[0].rawCells).toBeUndefined();
  });

  it('does NOT flag quoted-comma rows (papaparse collapses to 3 cells)', () => {
    // The whole point of CSV quoting: `"Foo, Bar"` is one cell, not
    // two. parseCsvRows trusts papaparse here, so well-formed quoted
    // labels never trip the warning.
    const r = parseCsvRows(
      '"Foo, Bar",https://x,https://img',
      'test',
      false,
    );
    expect(r.extraColumns).toEqual([]);
    expect(r.rows[0].label).toBe('Foo, Bar');
    expect(r.rows[0].url).toBe('https://x');
    expect(r.rows[0].imageUrl).toBe('https://img');
    expect(r.rows[0].rawCells).toBeUndefined();
  });

  it('row numbering is post-header-skip', () => {
    // The user-facing rowNumber must match what we render in the UI
    // ("source, row N") which is 1-indexed from the FIRST DATA row,
    // not the file's first physical line.
    const r = parseCsvRows(
      'ITEM,URL,IMAGE\nA, B, C,https://x,https://img',
      'test',
      true,
    );
    expect(r.rows.length).toBe(1);
    expect(r.extraColumns.length).toBe(1);
    expect(r.extraColumns[0].rowNumber).toBe(1);
  });

  it('a >3-cell row that ALSO collides with another row dedups normally and warns on both axes', () => {
    // Belt-and-suspenders: an unquoted-comma row can ALSO happen to
    // dedup against another row with the same first-cell label.
    // Both signals are independent and must both fire — extraColumns
    // is per-row, dedupRows operates on the post-parse RawRow stream.
    const parsed = parseCsvRows('Foo, Bar,https://x,https://img\nFoo,,', 'test', false);
    expect(parsed.extraColumns.length).toBe(1); // only the first row has >3 cells
    const { warnings } = dedupRows(parsed.rows);
    expect(warnings.length).toBe(1);
    expect(warnings[0].canonicalKey).toBe('foo');
    expect(warnings[0].occurrences.map((o) => o.rowNumber)).toEqual([1, 2]);
  });
});

describe('parseSources extra-columns flow', () => {
  it('concatenates extraColumns across sources in input order', () => {
    const r = parseSources([
      {
        sourceName: 'list-a',
        rawRows: [{ label: 'A', sourceName: 'list-a', sourceRow: 1 }],
        detectedHeader: false,
        extraColumns: [
          {
            sourceName: 'list-a',
            rowNumber: 3,
            cellCount: 4,
            rawCells: ['A', 'b', 'c', 'd'],
            parsedAs: { label: 'A', url: 'b', imageUrl: 'c' },
          },
        ],
      },
      {
        sourceName: 'list-b',
        rawRows: [{ label: 'B', sourceName: 'list-b', sourceRow: 1 }],
        detectedHeader: false,
        extraColumns: [
          {
            sourceName: 'list-b',
            rowNumber: 1,
            cellCount: 5,
            rawCells: ['B', 'b', 'c', 'd', 'e'],
            parsedAs: { label: 'B', url: 'b', imageUrl: 'c' },
          },
        ],
      },
    ]);
    expect(r.extraColumns.map((w) => w.sourceName)).toEqual(['list-a', 'list-b']);
  });

  it('omitted extraColumns on a SourceParse counts as zero (no fabrication required)', () => {
    // SourceParse.extraColumns is optional — hand-built test fixtures
    // and legacy paths shouldn't have to fabricate an empty array.
    const r = parseSources([
      {
        sourceName: 'list-a',
        rawRows: [{ label: 'A', sourceName: 'list-a', sourceRow: 1 }],
        detectedHeader: false,
      },
    ]);
    expect(r.extraColumns).toEqual([]);
  });
});

describe('parseExtrasText', () => {
  it('one label per line, no parsing of commas', () => {
    const rows = parseExtrasText('A\n  B  \n\nC,with,commas');
    expect(rows.map((r) => r.label)).toEqual(['A', 'B', 'C,with,commas']);
  });
});

describe('dedupRows', () => {
  const mk = (
    label: string,
    sourceName: string,
    sourceRow: number,
    url?: string,
    imageUrl?: string,
  ): RawRow => ({ label, url, imageUrl, sourceName, sourceRow });

  it('first occurrence wins for position', () => {
    const { items } = dedupRows([
      mk('A', 's1', 1),
      mk('B', 's1', 2),
      mk('A', 's2', 1),
    ]);
    expect(items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('fills in URL/IMAGE from later occurrences when first lacks them', () => {
    const { items } = dedupRows([
      mk('Pit', 's1', 1),
      mk('Pit', 's2', 1, 'https://x', 'https://y'),
    ]);
    expect(items[0]).toMatchObject({
      label: 'Pit',
      url: 'https://x',
      imageUrl: 'https://y',
    });
  });

  it('does NOT overwrite metadata already set on the first', () => {
    const { items } = dedupRows([
      mk('Pit', 's1', 1, 'https://orig', 'https://origimg'),
      mk('Pit', 's2', 1, 'https://new', 'https://newimg'),
    ]);
    expect(items[0].url).toBe('https://orig');
    expect(items[0].imageUrl).toBe('https://origimg');
  });

  it('emits a warning per duplicated canonical key', () => {
    const { warnings } = dedupRows([
      mk('Pit', 's1', 1),
      mk('Pit', 's2', 3),
      mk('Inception', 's2', 1),
      mk('Inception', 's3', 2),
    ]);
    expect(warnings.length).toBe(2);
    const pitWarning = warnings.find((w) => w.canonicalKey === 'pit');
    expect(pitWarning?.winningSource).toBe('s1');
    expect(pitWarning?.occurrences.length).toBe(2);
  });

  it('reports cross-source vs in-source duplicates correctly', () => {
    const { warnings } = dedupRows([
      mk('Pit', 's1', 1),
      mk('Pit', 's2', 3),
    ]);
    expect(warnings[0].reason).toBe('duplicate-across-sources');

    const { warnings: w2 } = dedupRows([
      mk('Pit', 's1', 1),
      mk('Pit', 's1', 3),
    ]);
    expect(w2[0].reason).toBe('duplicate-in-source');
  });

  it('does NOT collapse distinct CJK labels onto the same id', () => {
    // Regression for the pre-Unicode-aware canonicalKey: every CJK
    // label slugged to '' → fallback 'item', so three different
    // titles produced one survivor + two "duplicate of row 1"
    // warnings. The fix gives each CJK label its own id.
    const { items, warnings } = dedupRows([
      mk('君の膵臓をたべたい', 'pasted CSV', 1),
      mk('君の膵臓をたべたい', 'pasted CSV', 2), // true duplicate
      mk('物語シリーズ', 'pasted CSV', 3),       // distinct title
    ]);
    expect(items.map((i) => i.id)).toEqual([
      '君の膵臓をたべたい',
      '物語シリーズ',
    ]);
    expect(warnings.length).toBe(1);
    expect(warnings[0].canonicalKey).toBe('君の膵臓をたべたい');
    expect(warnings[0].occurrences.map((o) => o.rowNumber)).toEqual([1, 2]);
  });

  it('honors an explicit idOverride instead of canonicalKey(label)', () => {
    // Two rows with the same label but distinct idOverrides should be
    // treated as separate items — this is how the START-tab edit
    // overlay disambiguates a genuine collision without changing the
    // displayed label.
    const { items, warnings } = dedupRows([
      { label: 'Same Label', sourceName: 's1', sourceRow: 1, idOverride: 'one' },
      { label: 'Same Label', sourceName: 's1', sourceRow: 2, idOverride: 'two' },
    ]);
    expect(items.map((i) => i.id)).toEqual(['one', 'two']);
    expect(warnings.length).toBe(0);
  });

  it('idOverride can also collide INTO another row to force a dedup', () => {
    // Inverse case: two rows with distinct labels but the same
    // idOverride should dedup as if they were the same item.
    const { items, warnings } = dedupRows([
      { label: 'Foo (alt)', sourceName: 's1', sourceRow: 1, idOverride: 'foo' },
      { label: 'Foo',       sourceName: 's1', sourceRow: 2, idOverride: 'foo' },
    ]);
    expect(items.length).toBe(1);
    expect(items[0].id).toBe('foo');
    expect(warnings.length).toBe(1);
    expect(warnings[0].canonicalKey).toBe('foo');
  });
});

describe('parseSources', () => {
  it('per-source preview list keeps original input order', () => {
    const r = parseSources([
      {
        sourceName: 'list-a',
        rawRows: [
          { label: 'A', sourceName: 'list-a', sourceRow: 1 },
          { label: 'B', sourceName: 'list-a', sourceRow: 2 },
        ],
        detectedHeader: false,
      },
      {
        sourceName: 'list-b',
        rawRows: [
          { label: 'B', sourceName: 'list-b', sourceRow: 1 },
          { label: 'C', sourceName: 'list-b', sourceRow: 2 },
        ],
        detectedHeader: false,
      },
    ]);
    expect(r.perSource[0].items.map((pi) => pi.item.id)).toEqual(['a', 'b']);
    expect(r.perSource[1].items.map((pi) => pi.item.id)).toEqual(['b', 'c']);
    expect(r.items.map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0].canonicalKey).toBe('b');
  });

  it('per-source items carry the originating sourceRow', () => {
    // Powers the START-tab per-row Edit button: clicking the pencil
    // on any preview row must resolve back to the correct RawRow
    // even when the source has rows out of contiguous 1..N order
    // (e.g. blank lines stripped before parseCsvRows).
    const r = parseSources([
      {
        sourceName: 'list-a',
        rawRows: [
          { label: 'A', sourceName: 'list-a', sourceRow: 1 },
          { label: 'B', sourceName: 'list-a', sourceRow: 4 },
          { label: 'C', sourceName: 'list-a', sourceRow: 7 },
        ],
        detectedHeader: false,
      },
    ]);
    expect(r.perSource[0].items.map((pi) => pi.sourceRow)).toEqual([1, 4, 7]);
  });

  it('per-source sourceRow points at the FIRST occurrence within the source', () => {
    // When a label appears twice in the same source, the preview row
    // should map to the first occurrence — that's the position dedup
    // keeps, and where the user expects "Edit" to land.
    const r = parseSources([
      {
        sourceName: 'list-a',
        rawRows: [
          { label: 'A', sourceName: 'list-a', sourceRow: 1 },
          { label: 'A', sourceName: 'list-a', sourceRow: 5 }, // dropped
          { label: 'B', sourceName: 'list-a', sourceRow: 8 },
        ],
        detectedHeader: false,
      },
    ]);
    expect(r.perSource[0].items.map((pi) => pi.sourceRow)).toEqual([1, 8]);
  });
});

describe('mergeIntoExisting', () => {
  const existing: Record<string, Item> = {
    a: { id: 'a', label: 'A' },
    b: { id: 'b', label: 'B', url: 'https://orig-b' },
  };

  it('adds net-new items', () => {
    const r = mergeIntoExisting(existing, [{ id: 'c', label: 'C' }]);
    expect(r.netNew.map((i) => i.id)).toEqual(['c']);
    expect(r.skipped).toEqual([]);
    expect(r.mergedDict.c).toBeDefined();
  });

  it('skips items already in dict', () => {
    const r = mergeIntoExisting(existing, [{ id: 'a', label: 'A' }]);
    expect(r.skipped.map((i) => i.id)).toEqual(['a']);
    expect(r.netNew).toEqual([]);
  });

  it('fills missing metadata on existing without overwriting', () => {
    const r = mergeIntoExisting(existing, [
      { id: 'a', label: 'A', url: 'https://new-a', imageUrl: 'https://img-a' },
      { id: 'b', label: 'B', url: 'https://new-b' },
    ]);
    expect(r.mergedDict.a.url).toBe('https://new-a');
    expect(r.mergedDict.a.imageUrl).toBe('https://img-a');
    expect(r.mergedDict.b.url).toBe('https://orig-b'); // preserved
    expect(r.metadataFills.length).toBe(2);
  });
});
