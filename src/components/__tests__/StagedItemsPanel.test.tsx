import { describe, expect, it } from 'vitest';
import {
  buildSortInputFromStaged,
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
