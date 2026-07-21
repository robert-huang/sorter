import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  buildSortInputFromStaged,
  countMarkedForRemoval,
  findDuplicateOccurrences,
  isSingleRankedSublistReady,
  StagedItemsPanel,
  type StagedGroup,
  type StartMode,
} from '../StagedItemsPanel';
import type { Item, ItemId } from '../../lib/types';

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

  it('ignores seedAsSortedHint when building the input (it is a staging hint only, not a sort-engine flag)', () => {
    // seedAsSortedHint marks the group as sublist-shaped — the sort
    // builder ignores it. Output should be identical with or without.
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

// =====================================================================
// Soft removal (markedForRemoval / markedItemIds)
//
// The sort builder MUST drop marked content — those rows are
// "staged to remove" and Start Sort treats them as gone for real,
// not as pre-hidden items in the sort. The duplicate-warning hook
// must also skip marked content so the user doesn't see noisy
// dedup badges for rows that are about to disappear.
// =====================================================================

function withGroupMark(g: StagedGroup): StagedGroup {
  return { ...g, markedForRemoval: true };
}

function withItemMark(g: StagedGroup, ...ids: ItemId[]): StagedGroup {
  return { ...g, markedItemIds: new Set(ids) };
}

describe('buildSortInputFromStaged · soft removal', () => {
  it('skips groups whose markedForRemoval flag is true', () => {
    const out = buildSortInputFromStaged([
      withGroupMark(flat('g1', 'pasted CSV', [item('a'), item('b')])),
      flat('g2', 'clipboard', [item('c')]),
    ]);
    // g1 is gone — its items don't appear in extras and don't claim
    // their ids for dedup. g2 contributes 'c' as the sole extra.
    expect(out.extras).toEqual([item('c')]);
    expect(out.uniqueCount).toBe(1);
  });

  it('skips individual items in markedItemIds while keeping the rest of the group', () => {
    const out = buildSortInputFromStaged([
      withItemMark(
        flat('g1', 'clipboard', [item('a'), item('b'), item('c')]),
        'b',
      ),
    ]);
    expect(out.extras).toEqual([item('a'), item('c')]);
    expect(out.uniqueCount).toBe(2);
  });

  it('drops a sublist entirely when EVERY item is marked (no empty-husk sublist)', () => {
    const out = buildSortInputFromStaged([
      withItemMark(
        sublist('g1', 'top.csv', [item('a'), item('b')]),
        'a',
        'b',
      ),
    ]);
    expect(out.sublists).toEqual([]);
    expect(out.sublistCount).toBe(0);
    expect(out.extras).toEqual([]);
    expect(out.uniqueCount).toBe(0);
  });

  it('a marked group does NOT claim its ids for dedup — a later group can use them', () => {
    // The dedup invariant ("first occurrence wins") must NOT consider
    // marked content. Otherwise marking the winner would silently
    // drop every later copy too — turning soft-remove into a cascade.
    const out = buildSortInputFromStaged([
      withGroupMark(flat('g1', 'clipboard', [item('a')])),
      flat('g2', 'AniList', [item('a'), item('b')]),
    ]);
    // g2's 'a' must survive — g1 is marked-out so its earlier claim
    // is moot. The user expects "remove from g1" to free 'a' for g2.
    expect(out.extras).toEqual([item('a'), item('b')]);
    expect(out.uniqueCount).toBe(2);
  });

  it('per-item marks also free their ids for later groups (same invariant as group marks)', () => {
    const out = buildSortInputFromStaged([
      withItemMark(flat('g1', 'clipboard', [item('a'), item('z')]), 'a'),
      flat('g2', 'AniList', [item('a')]),
    ]);
    // g1 still contributes 'z'; g2 contributes 'a' (g1 marked it out).
    expect(out.extras).toEqual([item('z'), item('a')]);
    expect(out.uniqueCount).toBe(2);
  });
});

describe('findDuplicateOccurrences · soft removal', () => {
  it('does not warn about a duplicate when one of the copies is marked', () => {
    // Marking the duplicate copy silences the warning — that's the
    // whole point of soft-remove. Without this the panel would still
    // badge "duplicate" on a struck-through row, which reads as
    // unresolved noise.
    const out = findDuplicateOccurrences([
      flat('g1', 'clipboard', [item('a')]),
      withItemMark(sublist('g2', 'ranked.csv', [item('a'), item('b')]), 'a'),
    ]);
    expect(out.size).toBe(0);
  });

  it('a marked GROUP also removes its occurrences from the duplicate map', () => {
    const out = findDuplicateOccurrences([
      flat('g1', 'clipboard', [item('a')]),
      withGroupMark(sublist('g2', 'ranked.csv', [item('a')])),
    ]);
    expect(out.size).toBe(0);
  });

  it('still warns when 2+ unmarked copies remain (mark one, two left)', () => {
    const out = findDuplicateOccurrences([
      flat('g1', 'clipboard', [item('shared')]),
      withItemMark(sublist('g2', 'ranked.csv', [item('shared')]), 'shared'),
      flat('g3', 'AniList', [item('shared')]),
    ]);
    // Two unmarked copies remain — still a duplicate, but g2's mark
    // is not enumerated.
    const occs = out.get('shared');
    expect(occs).toHaveLength(2);
    expect(occs?.map((o) => o.groupId)).toEqual(['g1', 'g3']);
  });
});

describe('countMarkedForRemoval', () => {
  it('returns 0 when nothing is marked', () => {
    expect(
      countMarkedForRemoval([flat('g1', 'clipboard', [item('a'), item('b')])]),
    ).toBe(0);
  });

  it('a fully-marked group contributes every item in that group', () => {
    expect(
      countMarkedForRemoval([
        withGroupMark(flat('g1', 'clipboard', [item('a'), item('b'), item('c')])),
      ]),
    ).toBe(3);
  });

  it('per-item marks contribute one per unique id (intra-group dupes counted once)', () => {
    // Same id twice in one source + marked once should count as 1
    // disappearing item from the user's POV (the dedup pass would
    // also collapse the dupe), matching the panel header tally.
    expect(
      countMarkedForRemoval([
        withItemMark(
          flat('g1', 'clipboard', [item('a'), item('a'), item('b')]),
          'a',
        ),
      ]),
    ).toBe(1);
  });

  it('sums across groups, mixing whole-group and per-item marks', () => {
    expect(
      countMarkedForRemoval([
        withGroupMark(flat('g1', 'clipboard', [item('x'), item('y')])),
        withItemMark(
          sublist('g2', 'ranked.csv', [item('a'), item('b'), item('c')]),
          'b',
          'c',
        ),
        flat('g3', 'AniList', [item('p'), item('q')]),
      ]),
    ).toBe(4);
  });
});

// =====================================================================
// Start Sort split-button (engine picker)
//
// The split-button is the ONLY place the non-persisted insertion vs
// merge mode is chosen. These render tests pin the contract the
// parent (StartScreen) and the routing in startFromCombined rely on:
//   - default label is "Start sort" (merge), enabled only at 2+ items
//   - the chevron menu surfaces both engines as radio items
//   - picking insertion calls onStartModeChange('insertion') and the
//     primary CTA relabels to "Insertion sort" so the user can SEE
//     which engine the next click starts
//   - the primary click fires onStartSort regardless of mode (the
//     parent reads its own startMode to route — see startFromCombined)
//
// Uses the same bare createRoot/act harness as FilterBar.test.tsx
// (no react-testing-library — keeps the dep surface flat).
// =====================================================================

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * Wraps the panel with the same local `startMode` state the real
 * StartScreen owns, so a menu click actually re-renders the primary
 * label (proving the round-trip), while still exposing a spy on the
 * change so the test can assert the emitted mode.
 */
function SplitButtonHarness({
  onStartSort,
  onModeSpy,
  staged = [flat('g1', 'clipboard', [item('a'), item('b')])],
  startMode: initialMode = 'merge',
}: {
  onStartSort: () => void;
  onModeSpy: (mode: StartMode) => void;
  staged?: StagedGroup[];
  startMode?: StartMode;
}) {
  const [mode, setMode] = useState<StartMode>(initialMode);
  return (
    <StagedItemsPanel
      staged={staged}
      pending={[]}
      onToggleRemoveGroup={() => {}}
      onClearAll={() => {}}
      onStartSort={onStartSort}
      startMode={mode}
      onStartModeChange={(m) => {
        onModeSpy(m);
        setMode(m);
      }}
    />
  );
}

function mainBtn(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('.staged-panel-start-main');
}
function caretBtn(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('.staged-panel-start-caret');
}
function menuItems(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('.staged-panel-start-menu-item'),
  );
}

describe('StagedItemsPanel · Start Sort split-button', () => {
  it('defaults to the merge label and is enabled with 2+ unique items', () => {
    act(() => {
      root.render(
        <SplitButtonHarness onStartSort={() => {}} onModeSpy={() => {}} />,
      );
    });
    const main = mainBtn();
    expect(main).not.toBeNull();
    expect(main!.textContent).toContain('Start sort');
    expect(main!.textContent).toContain('(2)');
    expect(main!.disabled).toBe(false);
  });

  it('disables both halves of the split when fewer than 2 unique items remain', () => {
    act(() => {
      root.render(
        <SplitButtonHarness
          onStartSort={() => {}}
          onModeSpy={() => {}}
          staged={[flat('g1', 'clipboard', [item('only')])]}
        />,
      );
    });
    expect(mainBtn()!.disabled).toBe(true);
    expect(caretBtn()!.disabled).toBe(true);
  });

  it('shows Confirmation sort third in the menu for a single ranked sublist', () => {
    act(() => {
      root.render(
        <SplitButtonHarness
          onStartSort={() => {}}
          onModeSpy={() => {}}
          staged={[sublist('g1', 'ranked.csv', [item('a'), item('b')])]}
          startMode="confirmation"
        />,
      );
    });
    act(() => caretBtn()!.click());
    const items = menuItems();
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Merge sort');
    expect(items[1].textContent).toContain('Insertion sort');
    expect(items[2].textContent).toContain('Confirmation sort');
    expect(mainBtn()!.textContent).toContain('Confirm order');
  });

  it('opens the chevron menu with merge and insertion when not a single ranked sublist', () => {
    act(() => {
      root.render(
        <SplitButtonHarness onStartSort={() => {}} onModeSpy={() => {}} />,
      );
    });
    // Closed initially.
    expect(container.querySelector('.staged-panel-start-menu')).toBeNull();
    act(() => caretBtn()!.click());
    const items = menuItems();
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Merge sort');
    expect(items[1].textContent).toContain('Insertion sort');
    expect(items[0].getAttribute('aria-checked')).toBe('true');
    expect(items[1].getAttribute('aria-checked')).toBe('false');
  });

  it('picking Insertion emits onStartModeChange, relabels the CTA, and closes the menu', () => {
    const onModeSpy = vi.fn();
    act(() => {
      root.render(
        <SplitButtonHarness onStartSort={() => {}} onModeSpy={onModeSpy} />,
      );
    });
    act(() => caretBtn()!.click());
    act(() => menuItems()[1].click());
    expect(onModeSpy).toHaveBeenCalledWith('insertion');
    // Menu closes on select.
    expect(container.querySelector('.staged-panel-start-menu')).toBeNull();
    // Primary CTA now reflects the chosen engine so the next click is
    // unambiguous.
    expect(mainBtn()!.textContent).toContain('Insertion sort');
    expect(mainBtn()!.textContent).toContain('(2)');
  });

  it('the primary click fires onStartSort (the parent routes on its own startMode)', () => {
    const onStartSort = vi.fn();
    act(() => {
      root.render(
        <SplitButtonHarness onStartSort={onStartSort} onModeSpy={() => {}} />,
      );
    });
    act(() => mainBtn()!.click());
    expect(onStartSort).toHaveBeenCalledTimes(1);
  });

  it('picking Confirmation relabels the primary CTA', () => {
    const onModeSpy = vi.fn();
    act(() => {
      root.render(
        <SplitButtonHarness
          onStartSort={() => {}}
          onModeSpy={onModeSpy}
          staged={[
            sublist('g1', 'ranked.csv', [item('a'), item('b')]),
          ]}
        />,
      );
    });
    act(() => caretBtn()!.click());
    act(() => menuItems()[2].click());
    expect(onModeSpy).toHaveBeenCalledWith('confirmation');
    expect(mainBtn()!.textContent).toContain('Confirm order');
  });

  it('offers confirmation when extra groups are marked for removal', () => {
    act(() => {
      root.render(
        <SplitButtonHarness
          onStartSort={() => {}}
          onModeSpy={() => {}}
          staged={[
            sublist('g1', 'ranked.csv', [item('a'), item('b')]),
            { ...flat('g2', 'extras', [item('x')]), markedForRemoval: true },
          ]}
        />,
      );
    });
    act(() => caretBtn()!.click());
    expect(menuItems()).toHaveLength(3);
    expect(menuItems()[2].textContent).toContain('Confirmation sort');
  });
});

describe('isSingleRankedSublistReady', () => {
  it('is true for one ranked sublist with 2+ items', () => {
    expect(
      isSingleRankedSublistReady([
        sublist('g1', 'ranked.csv', [item('a'), item('b')]),
      ]),
    ).toBe(true);
  });

  it('is true when extra flat groups are marked for removal', () => {
    expect(
      isSingleRankedSublistReady([
        sublist('g1', 'ranked.csv', [item('a'), item('b')]),
        { ...flat('g2', 'clipboard', [item('x')]), markedForRemoval: true },
      ]),
    ).toBe(true);
  });

  it('is false when unranked extras remain in the effective input', () => {
    expect(
      isSingleRankedSublistReady([
        sublist('g1', 'ranked.csv', [item('a'), item('b')]),
        flat('g2', 'clipboard', [item('x')]),
      ]),
    ).toBe(false);
  });

  it('is false when two ranked sublists are active', () => {
    expect(
      isSingleRankedSublistReady([
        sublist('g1', 'a.csv', [item('a'), item('b')]),
        sublist('g2', 'b.csv', [item('c'), item('d')]),
      ]),
    ).toBe(false);
  });
});
