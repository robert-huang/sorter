import { describe, expect, it, vi } from 'vitest';
import {
  bfsFranchiseRelations,
  buildFranchiseCsv,
  buildFranchiseClipboardText,
  buildFranchiseEntries,
  csvEscapeFranchiseCell,
  DEFAULT_RELATION_TOGGLES,
  enabledRelationTypes,
  formatFranchiseScoreLabel,
  franchiseDateLabel,
  franchiseDateSortKey,
  franchiseFormatLabel,
  type FranchiseEntry,
  type FranchiseNode,
  type FranchiseRelationsResponse,
} from '../panels/franchiseScoresLogic';

function node(
  id: number,
  startDate: { year: number | null; month?: number | null; day?: number | null } = {
    year: 2020,
  },
  overrides: Partial<FranchiseNode> = {},
): FranchiseNode {
  return {
    id,
    mediaType: 'ANIME',
    format: 'TV',
    title: `Show ${id}`,
    titleSource: {
      id,
      title_english: `Show ${id}`,
      title_romaji: null,
      title_native: null,
    },
    coverImage: null,
    startDate: {
      year: startDate.year,
      month: startDate.month ?? null,
      day: startDate.day ?? null,
    },
    ...overrides,
  };
}

describe('franchiseDateSortKey', () => {
  it('orders earlier dates first', () => {
    const a = franchiseDateSortKey({ year: 2019, month: 4, day: 7 });
    const b = franchiseDateSortKey({ year: 2020, month: 4, day: 7 });
    expect(a).toBeLessThan(b);
  });

  it('treats missing month/day as start-of-year', () => {
    expect(franchiseDateSortKey({ year: 2020, month: null, day: null })).toBe(20200101);
    expect(franchiseDateSortKey({ year: 2020, month: 6, day: null })).toBe(20200601);
  });

  it('sorts missing years to the end', () => {
    const key = franchiseDateSortKey({ year: null, month: null, day: null });
    const known = franchiseDateSortKey({ year: 9999, month: 12, day: 31 });
    expect(key).toBeGreaterThan(known);
  });
});

describe('franchiseDateLabel', () => {
  it('formats year + month as "Mon YYYY"', () => {
    expect(franchiseDateLabel({ year: 2024, month: 4, day: 7 })).toBe('Apr 2024');
  });
  it('omits month when only year is known', () => {
    expect(franchiseDateLabel({ year: 2024, month: null, day: null })).toBe('2024');
  });
  it('returns TBA when year is missing', () => {
    expect(franchiseDateLabel({ year: null, month: null, day: null })).toBe('TBA');
  });
});

describe('formatFranchiseScoreLabel', () => {
  it('marks unwatched entries (no list entry) as U', () => {
    expect(formatFranchiseScoreLabel(null, null)).toBe('U');
    // Score is moot when the user isn't on the list at all.
    expect(formatFranchiseScoreLabel(80, null)).toBe('U');
  });

  it('marks PLANNING as P regardless of score', () => {
    expect(formatFranchiseScoreLabel(null, 'PLANNING')).toBe('P');
    expect(formatFranchiseScoreLabel(70, 'PLANNING')).toBe('P');
  });

  it('shows — when on list but no score', () => {
    expect(formatFranchiseScoreLabel(null, 'COMPLETED')).toBe('—');
    expect(formatFranchiseScoreLabel(0, 'COMPLETED')).toBe('—');
  });

  it('shows the score for rated entries', () => {
    expect(formatFranchiseScoreLabel(85, 'COMPLETED')).toBe('85');
  });
});

describe('enabledRelationTypes / DEFAULT_RELATION_TOGGLES', () => {
  it('defaults canon franchise relations ON but excludes CHARACTER + OTHER', () => {
    // CHARACTER drags in cameos; OTHER is AniList's catch-all noise bucket
    // (soundtracks, promos) — both off by default per user preference.
    const enabled = enabledRelationTypes(DEFAULT_RELATION_TOGGLES);
    expect(enabled.has('SEQUEL')).toBe(true);
    expect(enabled.has('SOURCE')).toBe(true);
    expect(enabled.has('ADAPTATION')).toBe(true);
    expect(enabled.has('OTHER')).toBe(false);
    expect(enabled.has('CHARACTER')).toBe(false);
  });
});

describe('bfsFranchiseRelations', () => {
  function makeFetcher(
    graph: Record<number, FranchiseRelationsResponse | null>,
  ) {
    return vi.fn(async (id: number) => graph[id] ?? null);
  }

  it('visits seed and direct relations honouring toggles', async () => {
    const fetcher = makeFetcher({
      1: { self: node(1), edges: [
        { relationType: 'SEQUEL', node: node(2) },
        // Default toggles have CHARACTER off — node 3 must NOT appear.
        { relationType: 'CHARACTER', node: node(3) },
        // OTHER is also off by default — node 4 must NOT appear.
        { relationType: 'OTHER', node: node(4) },
      ]},
      2: { self: node(2), edges: [] },
    });
    const nodes = await bfsFranchiseRelations(1, DEFAULT_RELATION_TOGGLES, fetcher);
    expect([...nodes.keys()].sort()).toEqual([1, 2]);
    // Fetcher should not have been called for the skipped children.
    expect(fetcher).not.toHaveBeenCalledWith(3, expect.anything());
    expect(fetcher).not.toHaveBeenCalledWith(4, expect.anything());
  });

  it('walks transitively across enabled edges', async () => {
    const fetcher = makeFetcher({
      1: { self: node(1), edges: [{ relationType: 'SEQUEL', node: node(2) }] },
      2: { self: node(2), edges: [{ relationType: 'SEQUEL', node: node(3) }] },
      3: { self: node(3), edges: [{ relationType: 'SEQUEL', node: node(4) }] },
      4: { self: node(4), edges: [] },
    });
    const nodes = await bfsFranchiseRelations(1, DEFAULT_RELATION_TOGGLES, fetcher);
    expect([...nodes.keys()].sort()).toEqual([1, 2, 3, 4]);
  });

  it('handles cycles (A → B → A) without looping forever', async () => {
    const fetcher = makeFetcher({
      1: { self: node(1), edges: [{ relationType: 'SEQUEL', node: node(2) }] },
      2: { self: node(2), edges: [{ relationType: 'PREQUEL', node: node(1) }] },
    });
    const nodes = await bfsFranchiseRelations(1, DEFAULT_RELATION_TOGGLES, fetcher);
    expect([...nodes.keys()].sort()).toEqual([1, 2]);
    // Each id fetched at most once.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('respects maxNodes cap', async () => {
    const fetcher = makeFetcher({
      1: { self: node(1), edges: [
        { relationType: 'SEQUEL', node: node(2) },
        { relationType: 'SEQUEL', node: node(3) },
        { relationType: 'SEQUEL', node: node(4) },
      ]},
    });
    const nodes = await bfsFranchiseRelations(1, DEFAULT_RELATION_TOGGLES, fetcher, {
      maxNodes: 2,
    });
    expect(nodes.size).toBe(2);
  });

  it('includes manga edges from SOURCE/ADAPTATION relations', async () => {
    const fetcher = makeFetcher({
      1: { self: node(1), edges: [
        { relationType: 'SOURCE', node: node(10, { year: 2015 }, { mediaType: 'MANGA', format: 'MANGA' }) },
      ]},
      10: { self: node(10, { year: 2015 }, { mediaType: 'MANGA', format: 'MANGA' }), edges: [] },
    });
    const nodes = await bfsFranchiseRelations(1, DEFAULT_RELATION_TOGGLES, fetcher);
    expect(nodes.get(10)?.mediaType).toBe('MANGA');
  });

  it('aborts when signal is already aborted', async () => {
    const fetcher = makeFetcher({
      1: { self: node(1), edges: [] },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      bfsFranchiseRelations(1, DEFAULT_RELATION_TOGGLES, fetcher, {
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
  });
});

describe('buildFranchiseEntries', () => {
  it('stamps seed flag + sorts entries by start date ascending', () => {
    const nodes = new Map<number, FranchiseNode>([
      [1, node(1, { year: 2010 })],
      [2, node(2, { year: 2008 })],
      [3, node(3, { year: 2012 })],
    ]);
    const entries = buildFranchiseEntries(1, nodes, new Map());
    expect(entries.map((e) => e.id)).toEqual([2, 1, 3]);
    expect(entries.find((e) => e.id === 1)?.isSeed).toBe(true);
    expect(entries.find((e) => e.id === 2)?.isSeed).toBe(false);
    // All unwatched (no list entries).
    expect(entries.every((e) => e.listStatus === null && e.score === null)).toBe(true);
  });

  it('joins user list status/score by media id', () => {
    const nodes = new Map<number, FranchiseNode>([
      [1, node(1, { year: 2010 })],
      [2, node(2, { year: 2011 })],
      [3, node(3, { year: 2012 })],
    ]);
    const userList = new Map([
      [1, { status: 'COMPLETED', score: 88 }],
      [2, { status: 'PLANNING', score: null }],
    ]);
    const entries = buildFranchiseEntries(1, nodes, userList);
    const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
    expect(byId[1]?.score).toBe(88);
    expect(byId[1]?.listStatus).toBe('COMPLETED');
    expect(byId[2]?.listStatus).toBe('PLANNING');
    expect(byId[3]?.listStatus).toBeNull();
  });

  it('puts entries with unknown dates at the end', () => {
    const nodes = new Map<number, FranchiseNode>([
      [1, node(1, { year: 2010 })],
      [2, node(2, { year: null })],
      [3, node(3, { year: 2015 })],
    ]);
    const entries = buildFranchiseEntries(1, nodes, new Map());
    expect(entries.map((e) => e.id)).toEqual([1, 3, 2]);
  });

  it('uses id tiebreak when dates collide', () => {
    const nodes = new Map<number, FranchiseNode>([
      [10, node(10, { year: 2020, month: 1, day: 1 })],
      [5, node(5, { year: 2020, month: 1, day: 1 })],
    ]);
    const entries = buildFranchiseEntries(10, nodes, new Map());
    expect(entries.map((e) => e.id)).toEqual([5, 10]);
  });
});

// ---------- Export helpers (Copy / CSV) ----------

function entry(
  id: number,
  overrides: Partial<FranchiseEntry> = {},
): FranchiseEntry {
  return {
    id,
    mediaType: 'ANIME',
    format: 'TV',
    title: `Show ${id}`,
    titleSource: {
      id,
      title_english: `Show ${id}`,
      title_romaji: null,
      title_native: null,
    },
    coverImage: null,
    startDate: { year: 2020, month: 1, day: 1 },
    isSeed: false,
    listStatus: null,
    score: null,
    ...overrides,
  };
}

describe('franchiseFormatLabel', () => {
  it('uses the explicit AniList format when present', () => {
    expect(franchiseFormatLabel({ format: 'OVA', mediaType: 'ANIME' })).toBe('OVA');
  });

  it('falls back to mediaType when format is missing', () => {
    expect(franchiseFormatLabel({ format: null, mediaType: 'MANGA' })).toBe('MANGA');
  });
});

describe('csvEscapeFranchiseCell', () => {
  it('leaves plain text untouched', () => {
    expect(csvEscapeFranchiseCell('Fate Zero')).toBe('Fate Zero');
  });

  it('wraps values containing commas in quotes', () => {
    expect(csvEscapeFranchiseCell('Bocchi, the Rock!')).toBe('"Bocchi, the Rock!"');
  });

  it('doubles embedded quotes when wrapping', () => {
    expect(csvEscapeFranchiseCell('She said "hi"')).toBe('"She said ""hi"""');
  });

  it('wraps values with newlines (CR or LF) in quotes', () => {
    expect(csvEscapeFranchiseCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscapeFranchiseCell('line1\r\nline2')).toBe('"line1\r\nline2"');
  });
});

describe('buildFranchiseCsv', () => {
  it('emits header + one row per entry with Title/Format/Score columns', () => {
    const entries = [
      entry(1, { title: 'Show A', format: 'TV', score: 88, listStatus: 'COMPLETED' }),
      entry(2, { title: 'Show B', format: 'MOVIE', score: null, listStatus: 'PLANNING' }),
      entry(3, { title: 'Show C', format: null, score: null, listStatus: null }),
    ];
    expect(buildFranchiseCsv(entries)).toBe(
      [
        'Title,Format,Score',
        'Show A,TV,88',
        'Show B,MOVIE,P',
        'Show C,ANIME,U',
      ].join('\r\n'),
    );
  });

  it('escapes commas + quotes in any column', () => {
    const entries = [
      entry(1, {
        title: 'Bocchi, the Rock!',
        format: 'TV',
        score: 90,
        listStatus: 'COMPLETED',
      }),
    ];
    expect(buildFranchiseCsv(entries)).toBe(
      ['Title,Format,Score', '"Bocchi, the Rock!",TV,90'].join('\r\n'),
    );
  });

  it('uses CRLF row separators for cross-platform spreadsheet compat', () => {
    const csv = buildFranchiseCsv([entry(1, { score: 80, listStatus: 'COMPLETED' })]);
    expect(csv.split('\r\n')).toHaveLength(2);
  });

  it('header-only output when there are no entries', () => {
    expect(buildFranchiseCsv([])).toBe('Title,Format,Score');
  });
});

describe('buildFranchiseClipboardText', () => {
  it('emits "Title (Format)" lines separated by newlines', () => {
    const entries = [
      entry(1, { title: 'Fate/Zero', format: 'TV' }),
      entry(2, { title: 'Fate/stay night Movie', format: 'MOVIE' }),
      entry(3, { title: 'Fate/Apocrypha', format: null }),
    ];
    expect(buildFranchiseClipboardText(entries)).toBe(
      ['Fate/Zero (TV)', 'Fate/stay night Movie (MOVIE)', 'Fate/Apocrypha (ANIME)'].join(
        '\n',
      ),
    );
  });

  it('empty input yields an empty string', () => {
    expect(buildFranchiseClipboardText([])).toBe('');
  });
});
