import { describe, expect, it } from 'vitest';
import {
  buildSortInputFromStaged,
  findDuplicateOccurrences,
  type StagedGroup,
} from '../StagedItemsPanel';
import type { Item } from '../../lib/types';

function item(id: string, label = id): Item {
  return { id, label };
}

function flat(id: string, source: string, items: Item[]): StagedGroup {
  return { kind: 'flat', id, source, items };
}

function sublist(
  id: string,
  source: string,
  items: Item[],
  opts: { seedAsSortedHint?: boolean } = {},
): StagedGroup {
  return {
    kind: 'sublist',
    id,
    source,
    items,
    ...(opts.seedAsSortedHint ? { seedAsSortedHint: true } : {}),
  };
}

describe('buildSortInputFromStaged', () => {
  it('returns empty extras and sublists for an empty list', () => {
    expect(buildSortInputFromStaged([])).toEqual({
      sublists: [],
      extras: [],
      uniqueCount: 0,
      sublistCount: 0,
    });
  });

  it('promotes flat-group items to extras and sublist-group items to sublists', () => {
    const out = buildSortInputFromStaged([
      flat('g1', 'pasted CSV', [item('a'), item('b')]),
      sublist('g2', 'ranked.csv', [item('c'), item('d')]),
    ]);
    expect(out.sublists).toEqual([[item('c'), item('d')]]);
    expect(out.extras).toEqual([item('a'), item('b')]);
    expect(out.uniqueCount).toBe(4);
    expect(out.sublistCount).toBe(1);
  });

  it('dedups across groups keeping the first occurrence and dropping later duplicates', () => {
    // 'a' appears first as flat then as sublist — sublist loses 'a'
    // but keeps 'c'. This protects the user's flat-tab additions
    // from being silently relocated into a later sublist.
    const out = buildSortInputFromStaged([
      flat('g1', 'clipboard', [item('a'), item('b')]),
      sublist('g2', 'ranked.csv', [item('a'), item('c')]),
    ]);
    expect(out.extras).toEqual([item('a'), item('b')]);
    expect(out.sublists).toEqual([[item('c')]]);
    expect(out.uniqueCount).toBe(3);
    expect(out.sublistCount).toBe(1);
  });

  it('dedups within a single group (same id twice in one source)', () => {
    const out = buildSortInputFromStaged([
      flat('g1', 'pasted CSV', [item('a'), item('a'), item('b')]),
    ]);
    expect(out.extras).toEqual([item('a'), item('b')]);
    expect(out.uniqueCount).toBe(2);
  });

  it('skips a sublist entirely if every item was already taken by an earlier group', () => {
    const out = buildSortInputFromStaged([
      flat('g1', 'clipboard', [item('a'), item('b')]),
      sublist('g2', 'ranked.csv', [item('a'), item('b')]),
    ]);
    // The sublist becomes empty after dedup → it isn't pushed.
    // sublistCount reflects ACTUAL sublists kept, not staged groups.
    expect(out.sublists).toEqual([]);
    expect(out.sublistCount).toBe(0);
    expect(out.extras).toEqual([item('a'), item('b')]);
  });

  it('preserves sublist ORDER (a sublist is the user-asserted ranking)', () => {
    const out = buildSortInputFromStaged([
      sublist('g1', 'ranked.csv', [item('c'), item('a'), item('b')]),
    ]);
    expect(out.sublists).toEqual([[item('c'), item('a'), item('b')]]);
  });

  it('combines multiple sublists into one array of sublists', () => {
    const out = buildSortInputFromStaged([
      sublist('g1', 'top10.csv', [item('a'), item('b')]),
      sublist('g2', 'rated.csv', [item('c'), item('d')]),
    ]);
    expect(out.sublists).toEqual([
      [item('a'), item('b')],
      [item('c'), item('d')],
    ]);
    expect(out.sublistCount).toBe(2);
  });

  it('handles the typical mixed-source scenario (clipboard + ranked CSV + AniList)', () => {
    const out = buildSortInputFromStaged([
      flat('g1', 'pasted CSV', [item('clipboard1'), item('clipboard2')]),
      sublist('g2', 'top5.csv', [
        item('r1'),
        item('r2'),
        item('r3'),
        item('r4'),
        item('r5'),
      ]),
      flat('g3', 'AniList: robert/anime', [
        item('anilist:1'),
        item('anilist:2'),
        item('anilist:3'),
      ]),
    ]);
    expect(out.uniqueCount).toBe(10);
    expect(out.sublistCount).toBe(1);
    expect(out.extras).toHaveLength(5);
    expect(out.sublists).toHaveLength(1);
    expect(out.sublists[0]).toHaveLength(5);
  });

  it('ignores seedAsSortedHint when building the input (it is a panel-level UI hint, not a sort-engine flag)', () => {
    // seedAsSortedHint is checked by StagedItemsPanel to decide
    // which CTA to render — not by the sort engine. The shape of
    // the output here should be identical with or without the hint.
    const without = buildSortInputFromStaged([
      sublist('g1', 'ranked.csv', [item('a'), item('b')]),
    ]);
    const withHint = buildSortInputFromStaged([
      sublist('g1', 'ranked.csv', [item('a'), item('b')], {
        seedAsSortedHint: true,
      }),
    ]);
    expect(withHint).toEqual(without);
  });
});

describe('findDuplicateOccurrences', () => {
  it('returns an empty map when nothing is staged', () => {
    expect(findDuplicateOccurrences([])).toEqual(new Map());
  });

  it('returns an empty map when every item appears in exactly one group', () => {
    const out = findDuplicateOccurrences([
      flat('g1', 'clipboard', [item('a'), item('b')]),
      sublist('g2', 'ranked.csv', [item('c'), item('d')]),
    ]);
    expect(out.size).toBe(0);
  });

  it('finds an item that appears in two groups and orders occurrences by group iteration order', () => {
    // This mirrors `buildSortInputFromStaged`'s dedup contract:
    // the FIRST occurrence is the one that gets kept, so the panel
    // can rely on `occurrences[0]` being the "winner" to badge the
    // others as "will be skipped".
    const out = findDuplicateOccurrences([
      flat('g1', 'clipboard', [item('a'), item('b')]),
      sublist('g2', 'ranked.csv', [item('a'), item('c')]),
    ]);
    expect(out.size).toBe(1);
    const occs = out.get('a');
    expect(occs).toEqual([
      { groupId: 'g1', groupSource: 'clipboard', positionInGroup: 1 },
      { groupId: 'g2', groupSource: 'ranked.csv', positionInGroup: 1 },
    ]);
  });

  it('captures every group an item appears in (3+ duplicates)', () => {
    const out = findDuplicateOccurrences([
      flat('g1', 'clipboard', [item('shared')]),
      sublist('g2', 'top5.csv', [item('shared'), item('alone')]),
      flat('g3', 'AniList: me/anime', [item('shared')]),
    ]);
    // 'shared' is in all three; 'alone' is in only g2 → excluded.
    expect(out.size).toBe(1);
    const occs = out.get('shared');
    expect(occs).toHaveLength(3);
    expect(occs?.map((o) => o.groupId)).toEqual(['g1', 'g2', 'g3']);
  });

  it('reports the within-group position so the panel can show "#3 of ranked.csv"', () => {
    // The panel uses positionInGroup in the tooltip so the user can
    // find a duplicate inside a long sublist without scrolling. It
    // is 1-indexed for display (matches "row 1 is the top" feel).
    const out = findDuplicateOccurrences([
      sublist('g1', 'top.csv', [item('a'), item('b'), item('c')]),
      sublist('g2', 'alt.csv', [item('x'), item('b'), item('y')]),
    ]);
    const occs = out.get('b');
    expect(occs).toEqual([
      { groupId: 'g1', groupSource: 'top.csv', positionInGroup: 2 },
      { groupId: 'g2', groupSource: 'alt.csv', positionInGroup: 2 },
    ]);
  });

  it('reports intra-group duplicates so the panel can mark the second copy as "will be skipped"', () => {
    // Same id twice in one source is silently dedup'd by
    // `buildSortInputFromStaged`. We MUST surface that to the user
    // — otherwise a CSV with an accidentally-repeated row would
    // produce a "Sort N items" count that's lower than the count
    // the user sees in the panel, with no explanation. Both
    // occurrences are recorded with their position so the panel
    // can resolve which one is the winner (the first).
    const out = findDuplicateOccurrences([
      flat('g1', 'clipboard', [item('a'), item('a'), item('b')]),
    ]);
    expect(out.size).toBe(1);
    const occs = out.get('a');
    expect(occs).toEqual([
      { groupId: 'g1', groupSource: 'clipboard', positionInGroup: 1 },
      { groupId: 'g1', groupSource: 'clipboard', positionInGroup: 2 },
    ]);
  });

  it('records both intra-group AND cross-group occurrences in one map for the same id', () => {
    // The hairy case: an item that's duplicated within one source
    // AND also shows up in another source. The hook should
    // enumerate every occurrence so the panel can render whichever
    // is most useful in context — e.g. for the cross-source row
    // the tooltip can say "also at #1 and #2 of clipboard".
    const out = findDuplicateOccurrences([
      flat('g1', 'clipboard', [item('a'), item('a')]),
      sublist('g2', 'ranked.csv', [item('a')]),
    ]);
    const occs = out.get('a');
    expect(occs).toEqual([
      { groupId: 'g1', groupSource: 'clipboard', positionInGroup: 1 },
      { groupId: 'g1', groupSource: 'clipboard', positionInGroup: 2 },
      { groupId: 'g2', groupSource: 'ranked.csv', positionInGroup: 1 },
    ]);
  });
});
