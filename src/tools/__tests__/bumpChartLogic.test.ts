import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '../../lib/types';
import {
  _clearAnilistDisplayPreferencesForTesting,
  saveAnilistDisplayPreferences,
} from '../../lib/importers/anilist/displayPreferences';
import {
  BUMP_CHART_COLORS,
  buildBumpConnections,
  bumpConnectionMovement,
  bumpRowCenterOffsets,
  bumpItemsFromSortResults,
  bumpItemsFromRows,
  dedupeBumpChartItems,
  displayBumpChartItems,
  hasCustomAnilistLabels,
  hydrateBumpChartItems,
  type BumpChartItem,
} from '../panels/bumpChartLogic';
import { productionReads } from '../../lib/importers/anilist/readQueries';

function entry(
  label: string,
  logicalId?: string,
  id = logicalId ?? label.toLowerCase(),
): BumpChartItem {
  return { item: { id, label }, logicalId };
}

beforeEach(() => {
  _clearAnilistDisplayPreferencesForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildBumpConnections', () => {
  it('matches saved logical ids in either direction with plain exact-name rows', () => {
    expect(
      buildBumpConnections([entry('Item', 'item')], [entry('Item')]),
    ).toMatchObject([{ kind: 'matched', leftIndex: 0, rightIndex: 0 }]);
    expect(
      buildBumpConnections([entry('Item')], [entry('Item', 'item')]),
    ).toMatchObject([{ kind: 'matched', leftIndex: 0, rightIndex: 0 }]);
  });

  it('matches plain rows by exact name and source rows by logical id', () => {
    expect(
      buildBumpConnections([entry('Item')], [entry('Item')]),
    ).toMatchObject([{ kind: 'matched', leftIndex: 0, rightIndex: 0 }]);
    expect(
      buildBumpConnections(
        [entry('Old label', 'anilist:1')],
        [entry('New label', 'anilist:1')],
      ),
    ).toMatchObject([{ kind: 'matched', leftIndex: 0, rightIndex: 0 }]);
  });

  it('does not name-match two different logical entities', () => {
    expect(
      buildBumpConnections(
        [entry('Same name', 'anilist-character:1')],
        [entry('Same name', 'anilist-character:2')],
      ).map((connection) => connection.kind),
    ).toEqual(['removed', 'added']);
  });

  it('infers an exact-title match between archived auto ids and AniList ids', () => {
    const connections = buildBumpConnections(
      [entry('Frieren', 'frieren')],
      [
        {
          item: {
            id: 'anilist:154587',
            label: 'Frieren',
            source: { kind: 'anilist', externalId: 154587 },
          },
          logicalId: 'anilist:154587',
        },
      ],
    );

    expect(connections).toMatchObject([
      {
        kind: 'matched',
        matchBasis: 'label',
        leftIndex: 0,
        rightIndex: 0,
      },
    ]);
  });

  it('disables every title fallback when best matching is off', () => {
    expect(
      buildBumpConnections(
        [entry('Same title', 'archived-id')],
        [entry('Same title', 'current-id')],
        { bestMatchByTitle: false },
      ).map((connection) => connection.kind),
    ).toEqual(['removed', 'added']);
  });

  it('leaves ambiguous exact-title candidates disconnected', () => {
    expect(
      buildBumpConnections(
        [entry('Shared title', 'left-a'), entry('Shared title', 'left-b')],
        [entry('Shared title', 'right-a')],
      ).map((connection) => connection.kind),
    ).toEqual(['removed', 'removed', 'added']);
  });

  it('uses AniList title variants only after exact displayed labels', () => {
    const archived = entry('Sousou no Frieren', 'archived-id');
    const current: BumpChartItem = {
      item: {
        id: 'anilist:154587',
        label: 'Frieren: Beyond Journey’s End',
        source: { kind: 'anilist', externalId: 154587 },
        searchTokens: [
          'Frieren: Beyond Journey’s End',
          'Sousou no Frieren',
          '葬送のフリーレン',
        ],
      },
      logicalId: 'anilist:154587',
    };

    expect(buildBumpConnections([archived], [current])).toMatchObject([
      {
        kind: 'matched',
        matchBasis: 'alternate-title',
        leftIndex: 0,
        rightIndex: 0,
      },
    ]);
  });

  it('does not infer alternate-title matches across conflicting AniList ids', () => {
    const left: BumpChartItem = {
      item: {
        id: 'anilist:1',
        label: 'Shared alternate title',
        source: { kind: 'anilist', externalId: 1 },
      },
      logicalId: 'anilist:1',
    };
    const right: BumpChartItem = {
      item: {
        id: 'anilist:2',
        label: 'Different display title',
        source: { kind: 'anilist', externalId: 2 },
        searchTokens: ['Shared alternate title'],
      },
      logicalId: 'anilist:2',
    };

    expect(
      buildBumpConnections([left], [right]).map(
        (connection) => connection.kind,
      ),
    ).toEqual(['removed', 'added']);
  });

  it('shows removed and added items when side lengths differ', () => {
    const connections = buildBumpConnections(
      [entry('A'), entry('B'), entry('Dropped')],
      [entry('B'), entry('A'), entry('New'), entry('Also new')],
    );
    expect(connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'matched', leftIndex: 0, rightIndex: 1 }),
        expect.objectContaining({ kind: 'matched', leftIndex: 1, rightIndex: 0 }),
        expect.objectContaining({ kind: 'removed', leftIndex: 2, rightIndex: null }),
        expect.objectContaining({ kind: 'added', leftIndex: null, rightIndex: 2 }),
        expect.objectContaining({ kind: 'added', leftIndex: null, rightIndex: 3 }),
      ]),
    );
  });

  it('reports positive movement for higher ranks and negative movement for lower ranks', () => {
    const connections = buildBumpConnections(
      [entry('A'), entry('B'), entry('C'), entry('Removed')],
      [entry('B'), entry('A'), entry('C'), entry('Added')],
    );

    expect(
      connections.map((connection) => [
        connection.kind,
        bumpConnectionMovement(connection),
      ]),
    ).toEqual([
      ['matched', -1],
      ['matched', 1],
      ['matched', 0],
      ['removed', null],
      ['added', null],
    ]);
  });

  it('uses different colors for connections adjacent on either side', () => {
    const connections = buildBumpConnections(
      [entry('1'), entry('2'), entry('3')],
      [entry('1'), entry('4'), entry('2')],
    );
    const movedTwo = connections.find(
      (connection) =>
        connection.leftIndex === 1 && connection.rightIndex === 2,
    );
    const addedFour = connections.find(
      (connection) =>
        connection.leftIndex === null && connection.rightIndex === 1,
    );
    expect(movedTwo?.colorIndex).not.toBe(addedFour?.colorIndex);

    for (const connection of connections) {
      for (const other of connections) {
        if (connection.key === other.key) continue;
        const adjacentLeft =
          connection.leftIndex != null &&
          other.leftIndex != null &&
          Math.abs(connection.leftIndex - other.leftIndex) === 1;
        const adjacentRight =
          connection.rightIndex != null &&
          other.rightIndex != null &&
          Math.abs(connection.rightIndex - other.rightIndex) === 1;
        if (adjacentLeft || adjacentRight) {
          expect(connection.colorIndex).not.toBe(other.colorIndex);
        }
      }
    }
  });

  it('provides twenty colors and distributes stable rows across the palette', () => {
    expect(BUMP_CHART_COLORS).toHaveLength(20);
    const ranked = Array.from({ length: 20 }, (_, index) =>
      entry(`Item ${index}`),
    );
    const colors = new Set(
      buildBumpConnections(ranked, ranked).map(
        (connection) => connection.colorIndex,
      ),
    );
    expect(colors.size).toBe(20);
  });
});

describe('bump chart imports', () => {
  it('flattens staged groups in order and keeps the first duplicate', () => {
    expect(
      dedupeBumpChartItems([
        [entry('A'), entry('B')],
        [entry('B'), entry('C')],
      ]).map((item) => item.item.label),
    ).toEqual(['A', 'B', 'C']);
  });

  it('reuses CSV deduplication and AniList URL source matching', () => {
    const items = bumpItemsFromRows([
      {
        label: 'Show',
        url: 'https://anilist.co/anime/123',
        sourceName: 'before',
        sourceRow: 1,
      },
      {
        label: 'Show duplicate',
        url: 'https://anilist.co/anime/123',
        sourceName: 'before',
        sourceRow: 2,
      },
      {
        label: 'Other',
        sourceName: 'before',
        sourceRow: 3,
      },
      {
        label: 'Other',
        sourceName: 'before',
        sourceRow: 4,
      },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      logicalId: 'anilist:123',
      item: {
        id: 'anilist:123',
        source: { kind: 'anilist', externalId: 123 },
      },
    });
  });

  it('defaults custom hydrated labels to AniList names unless preservation is enabled', () => {
    saveAnilistDisplayPreferences({ mediaTitleMode: 'english' });
    const item: Item = {
      id: 'anilist:1',
      label: 'My custom title',
      source: { kind: 'anilist', externalId: 1 },
      anilistLabelMode: 'custom',
      anilistLabelIncludesFormat: false,
      anilistLabelSource: {
        kind: 'media',
        titleFields: {
          id: 1,
          title_english: 'English title',
          title_romaji: 'Romaji title',
          title_native: 'Native title',
        },
        format: 'TV',
      },
    };
    const imported = [{ item, logicalId: item.id }];

    expect(hasCustomAnilistLabels(imported)).toBe(true);
    expect(displayBumpChartItems(imported, false)[0]!.item.label).toBe(
      'English title',
    );
    expect(displayBumpChartItems(imported, true)[0]!.item.label).toBe(
      'My custom title',
    );
    expect(
      buildBumpConnections(imported, [entry('My custom title', 'archived-id')]),
    ).toMatchObject([
      {
        kind: 'matched',
        matchBasis: 'label',
        leftIndex: 0,
        rightIndex: 0,
      },
    ]);
    expect(
      displayBumpChartItems(
        [{ item: { ...item, anilistLabelIncludesFormat: true }, logicalId: item.id }],
        false,
      )[0]!.item.label,
    ).toBe('English title (TV)');
  });

  it('hydrates legacy character slots and treats known native names as automatic', async () => {
    saveAnilistDisplayPreferences({ characterNameMode: 'full' });
    vi.spyOn(productionReads, 'getMediaByIds').mockResolvedValue([]);
    vi.spyOn(productionReads, 'getCharactersByIds').mockResolvedValue([
      {
        id: 127118,
        name_full: 'Sakura Yamauchi',
        name_native: '山内桜良',
        gender: null,
        favourites: null,
      },
    ]);
    vi.spyOn(productionReads, 'getStaffByIds').mockResolvedValue([]);
    const imported = bumpItemsFromSortResults([
      {
        id: 'anilist-character:127118',
        label: '山内桜良',
        source: { kind: 'anilist-character', externalId: 127118 },
      },
    ]);

    const hydrated = await hydrateBumpChartItems(imported);

    expect(hydrated[0]!.item.label).toBe('Sakura Yamauchi');
    expect(hydrated[0]!.item.anilistLabelMode).toBeUndefined();
    expect(hydrated[0]!.item.anilistLabelSource).toMatchObject({
      kind: 'character',
      nameFields: { name_full: 'Sakura Yamauchi', name_native: '山内桜良' },
    });
    expect(hasCustomAnilistLabels(hydrated)).toBe(false);

    saveAnilistDisplayPreferences({ characterNameMode: 'native' });
    expect(displayBumpChartItems(hydrated, true)[0]!.item.label).toBe('山内桜良');
  });

  it('identifies unmatched legacy character labels as custom after hydration', async () => {
    vi.spyOn(productionReads, 'getMediaByIds').mockResolvedValue([]);
    vi.spyOn(productionReads, 'getCharactersByIds').mockResolvedValue([
      {
        id: 1,
        name_full: 'Full Name',
        name_native: '原名',
        gender: null,
        favourites: null,
      },
    ]);
    vi.spyOn(productionReads, 'getStaffByIds').mockResolvedValue([]);
    const imported = bumpItemsFromSortResults([
      {
        id: 'anilist-character:1',
        label: 'My custom name',
        source: { kind: 'anilist-character', externalId: 1 },
      },
    ]);

    const hydrated = await hydrateBumpChartItems(imported);

    expect(hydrated[0]!.item.label).toBe('My custom name');
    expect(hydrated[0]!.item.anilistLabelMode).toBe('custom');
    expect(hasCustomAnilistLabels(hydrated)).toBe(true);
    expect(displayBumpChartItems(hydrated, false)[0]!.item.label).toBe(
      'Full Name',
    );
  });

  it('hydrates legacy staff slots with person name preferences', async () => {
    saveAnilistDisplayPreferences({ personNameMode: 'full' });
    vi.spyOn(productionReads, 'getMediaByIds').mockResolvedValue([]);
    vi.spyOn(productionReads, 'getCharactersByIds').mockResolvedValue([]);
    vi.spyOn(productionReads, 'getStaffByIds').mockResolvedValue([
      {
        id: 2,
        name_full: 'Kana Hanazawa',
        name_native: '花澤香菜',
        gender: null,
        language_v2: 'Japanese',
        favourites: null,
      },
    ]);
    const imported = bumpItemsFromSortResults([
      {
        id: 'anilist-staff:2',
        label: '花澤香菜',
        source: { kind: 'anilist-staff', externalId: 2 },
      },
    ]);

    const hydrated = await hydrateBumpChartItems(imported);

    expect(hydrated[0]!.item.label).toBe('Kana Hanazawa');
    expect(hydrated[0]!.item.anilistLabelSource?.kind).toBe('person');
    expect(hydrated[0]!.item.anilistLabelMode).toBeUndefined();
  });

  it('hydrates source-less studio ids and distinguishes canonical from custom labels', async () => {
    vi.spyOn(productionReads, 'getStudiosByIds').mockResolvedValue([
      { id: 10, name: 'Madhouse' },
      { id: 11, name: 'Sunrise' },
    ]);
    const imported = bumpItemsFromSortResults([
      { id: 'anilist-studios:10', label: 'Madhouse' },
      { id: 'anilist-studios:11', label: 'My favourite studio' },
    ]);

    const hydrated = await hydrateBumpChartItems(imported);

    expect(hydrated[0]).toMatchObject({
      logicalId: 'anilist-studios:10',
      item: {
        label: 'Madhouse',
        anilistLabelSource: { kind: 'studio', label: 'Madhouse' },
      },
    });
    expect(hydrated[0]!.item.anilistLabelMode).toBeUndefined();
    expect(hydrated[1]!.item.anilistLabelMode).toBe('custom');
    expect(hasCustomAnilistLabels(hydrated)).toBe(true);
    expect(displayBumpChartItems(hydrated, false)[1]!.item.label).toBe('Sunrise');
  });
});

describe('bump chart row geometry', () => {
  it('centers nodes in each measured row instead of assuming fixed heights', () => {
    expect(
      bumpRowCenterOffsets(100, [
        { top: 100, height: 64 },
        { top: 164, height: 104 },
        { top: 268, height: 64 },
      ]),
    ).toEqual([32, 116, 200]);
  });
});
