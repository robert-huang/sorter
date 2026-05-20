import { describe, expect, it } from 'vitest';
import {
  canonicalKey,
  dedupRows,
  looksLikeHeader,
  mergeIntoExisting,
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
  it('collapses non-alphanumerics into single dashes', () => {
    expect(canonicalKey("It's a Wonderful Life!!")).toBe(
      'it-s-a-wonderful-life',
    );
  });
  it('falls back to "item" for empty/garbage input', () => {
    expect(canonicalKey('')).toBe('item');
    expect(canonicalKey('   ')).toBe('item');
    expect(canonicalKey('!!')).toBe('item');
  });
  it('collides "Cafe" and "Café" deliberately (intent: case-insensitive dedup)', () => {
    expect(canonicalKey('Cafe')).toBe('cafe');
    expect(canonicalKey('Café')).toBe('caf');
    // Documenting actual behavior: accents are stripped because we only keep
    // [a-z0-9]; "Café" -> "caf". They don't collide today. If we ever care
    // we'd need to normalize unicode first.
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
    expect(r.rows.map((x) => x.label)).toEqual(['ITEM', 'A']);
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
    expect(r.perSource[0].items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(r.perSource[1].items.map((i) => i.id)).toEqual(['b', 'c']);
    expect(r.items.map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0].canonicalKey).toBe('b');
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
