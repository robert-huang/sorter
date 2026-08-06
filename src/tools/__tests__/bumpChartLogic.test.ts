import { beforeEach, describe, expect, it } from 'vitest';
import type { Item } from '../../lib/types';
import {
  _clearAnilistDisplayPreferencesForTesting,
  saveAnilistDisplayPreferences,
} from '../../lib/importers/anilist/displayPreferences';
import {
  BUMP_CHART_COLORS,
  buildBumpConnections,
  bumpRowCenterOffsets,
  bumpItemsFromRows,
  dedupeBumpChartItems,
  displayBumpChartItems,
  hasCustomAnilistLabels,
  type BumpChartItem,
} from '../panels/bumpChartLogic';

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
      displayBumpChartItems(
        [{ item: { ...item, anilistLabelIncludesFormat: true }, logicalId: item.id }],
        false,
      )[0]!.item.label,
    ).toBe('English title (TV)');
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
