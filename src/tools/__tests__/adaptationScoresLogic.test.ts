import { describe, expect, it } from 'vitest';
import {
  applyAdaptationFilters,
  ADAPTATION_LIST_STATUS_OPTIONS,
  buildAdaptationBlockRows,
  buildAdaptationDisplay,
  canStaggerChain,
  dedupeAdaptationPairs,
  normalizeAdaptationPair,
  type AdaptationMedia,
  type AdaptationPair,
} from '../panels/adaptationScoresLogic';

function media(
  id: number,
  overrides: Partial<AdaptationMedia> = {},
): AdaptationMedia {
  return {
    id,
    mediaType: 'ANIME',
    format: 'TV',
    title: `Media ${id}`,
    titleSource: {
      id,
      title_english: `Media ${id}`,
      title_romaji: null,
      title_native: null,
    },
    coverImage: null,
    startDate: { year: 2020 + id, month: 1, day: 1 },
    listStatus: 'COMPLETED',
    score: 80,
    startedAt: { year: 2021, month: 1, day: 1 },
    ...overrides,
  };
}

function mediaMap(entries: AdaptationMedia[]): Map<number, AdaptationMedia> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

function visibleSourceIds(rows: ReturnType<typeof buildAdaptationBlockRows>): number[] {
  return rows
    .filter((row) => row.source && !row.source.skipRender)
    .map((row) => row.source!.media.id);
}

function visibleAdaptationIds(rows: ReturnType<typeof buildAdaptationBlockRows>): number[] {
  return rows
    .filter((row) => row.adaptation && !row.adaptation.skipRender)
    .map((row) => row.adaptation!.media.id);
}

describe('normalizeAdaptationPair', () => {
  it('maps SOURCE neighbor to source side', () => {
    expect(normalizeAdaptationPair(10, 'SOURCE', 5)).toEqual({
      sourceId: 5,
      adaptationId: 10,
    });
  });

  it('maps ADAPTATION neighbor to adaptation side', () => {
    expect(normalizeAdaptationPair(10, 'ADAPTATION', 20)).toEqual({
      sourceId: 10,
      adaptationId: 20,
    });
  });

  it('ignores unrelated relation types', () => {
    expect(normalizeAdaptationPair(10, 'SEQUEL', 20)).toBeNull();
    expect(normalizeAdaptationPair(10, 'SPIN_OFF', 20)).toBeNull();
  });
});

describe('dedupeAdaptationPairs', () => {
  it('removes duplicate directed edges', () => {
    const pairs: AdaptationPair[] = [
      { sourceId: 1, adaptationId: 2 },
      { sourceId: 1, adaptationId: 2 },
      { sourceId: 3, adaptationId: 4 },
    ];
    expect(dedupeAdaptationPairs(pairs)).toEqual([
      { sourceId: 1, adaptationId: 2 },
      { sourceId: 3, adaptationId: 4 },
    ]);
  });
});

describe('applyAdaptationFilters', () => {
  const pairs: AdaptationPair[] = [
    { sourceId: 1, adaptationId: 2 },
    { sourceId: 3, adaptationId: 4 },
    { sourceId: 5, adaptationId: 6 },
  ];
  const map = mediaMap([
    media(1, { mediaType: 'MANGA', listStatus: 'COMPLETED' }),
    media(2, { mediaType: 'ANIME', listStatus: 'COMPLETED' }),
    media(3, { mediaType: 'MANGA', listStatus: null }),
    media(4, { mediaType: 'ANIME', listStatus: 'COMPLETED' }),
    media(5, { mediaType: 'MANGA', listStatus: 'COMPLETED' }),
    media(6, { mediaType: 'MANGA', listStatus: 'COMPLETED' }),
  ]);
  const scope = {
    animeListIds: new Set([2, 4]),
    mangaListIds: new Set([1, 5, 6]),
  };
  const allStatuses = [...ADAPTATION_LIST_STATUS_OPTIONS];

  it('filters rows by anime list membership when only anime is included', () => {
    const filtered = applyAdaptationFilters(pairs, map, scope, {
      includeAnime: true,
      includeManga: false,
      listStatuses: allStatuses,
      onlyBothOnList: false,
      hideSameMedium: false,
    });
    expect(filtered).toEqual([
      { sourceId: 1, adaptationId: 2 },
      { sourceId: 3, adaptationId: 4 },
    ]);
  });

  it('filters rows by manga list membership when only manga is included', () => {
    const filtered = applyAdaptationFilters(pairs, map, scope, {
      includeAnime: false,
      includeManga: true,
      listStatuses: allStatuses,
      onlyBothOnList: false,
      hideSameMedium: false,
    });
    expect(filtered).toEqual([
      { sourceId: 1, adaptationId: 2 },
      { sourceId: 5, adaptationId: 6 },
    ]);
  });

  it('filters to both-on-list pairs', () => {
    const filtered = applyAdaptationFilters(pairs, map, scope, {
      includeAnime: true,
      includeManga: true,
      listStatuses: allStatuses,
      onlyBothOnList: true,
      hideSameMedium: false,
    });
    expect(filtered).toEqual([
      { sourceId: 1, adaptationId: 2 },
      { sourceId: 5, adaptationId: 6 },
    ]);
  });

  it('hides same-medium pairs when requested', () => {
    const filtered = applyAdaptationFilters(pairs, map, scope, {
      includeAnime: true,
      includeManga: true,
      listStatuses: allStatuses,
      onlyBothOnList: false,
      hideSameMedium: true,
    });
    expect(filtered).toEqual([
      { sourceId: 1, adaptationId: 2 },
      { sourceId: 3, adaptationId: 4 },
    ]);
  });

  it('filters rows when either side matches a selected list status', () => {
    const filtered = applyAdaptationFilters(pairs, map, scope, {
      includeAnime: true,
      includeManga: true,
      listStatuses: ['COMPLETED'],
      onlyBothOnList: false,
      hideSameMedium: false,
    });
    expect(filtered).toEqual([
      { sourceId: 1, adaptationId: 2 },
      { sourceId: 3, adaptationId: 4 },
      { sourceId: 5, adaptationId: 6 },
    ]);
  });
});

describe('buildAdaptationBlockRows', () => {
  it('merges one source across two adaptations (Bakemonogatari-style)', () => {
    const pairs: AdaptationPair[] = [
      { sourceId: 1, adaptationId: 10 },
      { sourceId: 1, adaptationId: 11 },
    ];
    const map = mediaMap([
      media(1, { mediaType: 'MANGA', format: 'NOVEL', startDate: { year: 2006, month: 11, day: 1 } }),
      media(10, {
        mediaType: 'MANGA',
        format: 'MANGA',
        startDate: { year: 2018, month: 7, day: 1 },
      }),
      media(11, { startDate: { year: 2009, month: 7, day: 1 } }),
    ]);

    const rows = buildAdaptationBlockRows(pairs, map);
    expect(visibleSourceIds(rows)).toEqual([1]);
    expect(rows[0]?.source?.rowSpan).toBe(2);
    expect(visibleAdaptationIds(rows)).toEqual([11, 10]);
  });

  it('merges one source across multiple adaptations (ReZero-style)', () => {
    const pairs: AdaptationPair[] = [
      { sourceId: 1, adaptationId: 10 },
      { sourceId: 1, adaptationId: 11 },
      { sourceId: 1, adaptationId: 12 },
    ];
    const map = mediaMap([
      media(1, { mediaType: 'MANGA', format: 'NOVEL', startDate: { year: 2014, month: 1, day: 1 } }),
      media(10, { startDate: { year: 2016, month: 4, day: 1 } }),
      media(11, { startDate: { year: 2017, month: 1, day: 1 } }),
      media(12, { startDate: { year: 2018, month: 10, day: 1 } }),
    ]);

    const rows = buildAdaptationBlockRows(pairs, map);
    expect(visibleSourceIds(rows)).toEqual([1]);
    expect(rows[0]?.source?.rowSpan).toBe(3);
    expect(visibleAdaptationIds(rows)).toEqual([10, 11, 12]);
  });

  it('merges one adaptation across multiple sources (Monogatari-style)', () => {
    const pairs: AdaptationPair[] = [
      { sourceId: 1, adaptationId: 10 },
      { sourceId: 2, adaptationId: 10 },
      { sourceId: 3, adaptationId: 10 },
    ];
    const map = mediaMap([
      media(1, { mediaType: 'MANGA', format: 'NOVEL', startDate: { year: 2010, month: 1, day: 1 } }),
      media(2, { mediaType: 'MANGA', format: 'NOVEL', startDate: { year: 2011, month: 1, day: 1 } }),
      media(3, { mediaType: 'MANGA', format: 'NOVEL', startDate: { year: 2012, month: 1, day: 1 } }),
      media(10, { startDate: { year: 2013, month: 7, day: 1 } }),
    ]);

    const rows = buildAdaptationBlockRows(pairs, map);
    expect(visibleSourceIds(rows)).toEqual([1, 2, 3]);
    expect(visibleAdaptationIds(rows)).toEqual([10]);
    expect(rows[0]?.adaptation?.rowSpan).toBe(3);
  });

  it('uses stagger layout for rolling overlap chains', () => {
    const pairs: AdaptationPair[] = [
      { sourceId: 1, adaptationId: 10 },
      { sourceId: 2, adaptationId: 10 },
      { sourceId: 2, adaptationId: 11 },
      { sourceId: 3, adaptationId: 11 },
      { sourceId: 3, adaptationId: 12 },
      { sourceId: 4, adaptationId: 12 },
    ];
    const map = mediaMap([
      media(1, { mediaType: 'MANGA', format: 'NOVEL', startDate: { year: 2010, month: 1, day: 1 } }),
      media(2, { mediaType: 'MANGA', format: 'NOVEL', startDate: { year: 2011, month: 1, day: 1 } }),
      media(3, { mediaType: 'MANGA', format: 'NOVEL', startDate: { year: 2012, month: 1, day: 1 } }),
      media(4, { mediaType: 'MANGA', format: 'NOVEL', startDate: { year: 2013, month: 1, day: 1 } }),
      media(10, { startDate: { year: 2014, month: 1, day: 1 } }),
      media(11, { startDate: { year: 2015, month: 1, day: 1 } }),
      media(12, { startDate: { year: 2016, month: 1, day: 1 } }),
    ]);

    const adaptations = [map.get(10)!, map.get(11)!, map.get(12)!];
    expect(canStaggerChain(adaptations, pairs, map)).toBe(true);

    const rows = buildAdaptationBlockRows(pairs, map);
    expect(visibleSourceIds(rows)).toEqual([1, 2, 3, 4]);
    expect(visibleAdaptationIds(rows)).toEqual([10, 11, 12]);

    const boundaryRow = rows.find((row) => row.source?.media.id === 2 && !row.source.skipRender);
    expect(boundaryRow?.source?.rowSpan).toBe(2);
  });

  it('falls back to duplicate rows for non-chain N-to-M overlap', () => {
    const pairs: AdaptationPair[] = [
      { sourceId: 1, adaptationId: 10 },
      { sourceId: 2, adaptationId: 10 },
      { sourceId: 3, adaptationId: 10 },
      { sourceId: 2, adaptationId: 11 },
      { sourceId: 3, adaptationId: 11 },
      { sourceId: 4, adaptationId: 12 },
    ];
    const map = mediaMap([
      media(1, { mediaType: 'MANGA', format: 'NOVEL', startDate: { year: 2010, month: 1, day: 1 } }),
      media(2, { mediaType: 'MANGA', format: 'NOVEL', startDate: { year: 2011, month: 1, day: 1 } }),
      media(3, { mediaType: 'MANGA', format: 'NOVEL', startDate: { year: 2012, month: 1, day: 1 } }),
      media(4, { mediaType: 'MANGA', format: 'NOVEL', startDate: { year: 2013, month: 1, day: 1 } }),
      media(10, { startDate: { year: 2014, month: 1, day: 1 } }),
      media(11, { startDate: { year: 2015, month: 1, day: 1 } }),
      media(12, { startDate: { year: 2016, month: 1, day: 1 } }),
    ]);

    const adaptations = [map.get(10)!, map.get(11)!, map.get(12)!];
    expect(canStaggerChain(adaptations, pairs, map)).toBe(false);

    const rows = buildAdaptationBlockRows(pairs, map);
    expect(visibleSourceIds(rows)).toEqual([1, 2, 3, 2, 3, 4]);
    expect(visibleAdaptationIds(rows)).toEqual([10, 11, 12]);
  });

  it('staggers shared manga across anime seasons when same-medium edges exist (FMA-style)', () => {
    const pairs: AdaptationPair[] = [
      { sourceId: 1, adaptationId: 2 },
      { sourceId: 2, adaptationId: 10 },
      { sourceId: 2, adaptationId: 11 },
    ];
    const map = mediaMap([
      media(1, { mediaType: 'MANGA', format: 'NOVEL', startDate: { year: 2003, month: 2, day: 1 } }),
      media(2, { mediaType: 'MANGA', format: 'MANGA', startDate: { year: 2001, month: 7, day: 1 } }),
      media(10, { startDate: { year: 2003, month: 10, day: 1 } }),
      media(11, { startDate: { year: 2009, month: 4, day: 1 } }),
    ]);

    const rows = buildAdaptationBlockRows(pairs, map);
    expect(visibleSourceIds(rows)).toEqual([1, 2]);
    expect(visibleAdaptationIds(rows)).toEqual([2, 10, 11]);

    const mangaSourceRow = rows.find((row) => row.source?.media.id === 2 && !row.source.skipRender);
    expect(mangaSourceRow?.source?.rowSpan).toBe(2);
    expect(mangaSourceRow?.adaptation?.media.id).toBe(10);
  });

  it('marks the earliest startedAt side with the consumption dot', () => {
    const pairs: AdaptationPair[] = [{ sourceId: 1, adaptationId: 10 }];
    const map = mediaMap([
      media(1, {
        mediaType: 'MANGA',
        startedAt: { year: 2022, month: 6, day: 1 },
      }),
      media(10, {
        startedAt: { year: 2020, month: 1, day: 1 },
      }),
    ]);

    const rows = buildAdaptationBlockRows(pairs, map);
    expect(rows[0]?.adaptation?.showConsumptionDot).toBe(true);
    expect(rows[0]?.source?.showConsumptionDot).toBe(false);
  });
});

describe('buildAdaptationDisplay', () => {
  it('sorts blocks by earliest adaptation release date', () => {
    const pairs: AdaptationPair[] = [
      { sourceId: 1, adaptationId: 20 },
      { sourceId: 2, adaptationId: 30 },
    ];
    const map = mediaMap([
      media(1, { mediaType: 'MANGA' }),
      media(2, { mediaType: 'MANGA' }),
      media(20, { startDate: { year: 2020, month: 1, day: 1 } }),
      media(30, { startDate: { year: 2018, month: 1, day: 1 } }),
    ]);

    const display = buildAdaptationDisplay(pairs, map, {
      animeListIds: new Set([20, 30]),
      mangaListIds: new Set([1, 2]),
    }, {
      includeAnime: true,
      includeManga: true,
      listStatuses: [...ADAPTATION_LIST_STATUS_OPTIONS],
      onlyBothOnList: false,
      hideSameMedium: false,
    });

    expect(display.kind).toBe('table');
    if (display.kind !== 'table') {
      return;
    }
    expect(display.blocks[0]?.rows[0]?.adaptation?.media.id).toBe(30);
    expect(display.blocks[1]?.rows[0]?.adaptation?.media.id).toBe(20);
  });

  it('showAllRows keeps filtered-out pairs visible with hiddenByFilter', () => {
    const pairs: AdaptationPair[] = [
      { sourceId: 1, adaptationId: 10 },
      { sourceId: 2, adaptationId: 20 },
    ];
    const map = mediaMap([
      media(1, { mediaType: 'MANGA', listStatus: 'COMPLETED' }),
      media(2, { mediaType: 'MANGA', listStatus: 'COMPLETED' }),
      media(10, { mediaType: 'ANIME', listStatus: 'COMPLETED' }),
      media(20, { mediaType: 'ANIME', listStatus: null }),
    ]);

    const display = buildAdaptationDisplay(
      pairs,
      map,
      { animeListIds: new Set([10, 20]), mangaListIds: new Set([1, 2]) },
      {
        includeAnime: true,
        includeManga: true,
        listStatuses: ['COMPLETED'],
        onlyBothOnList: true,
        hideSameMedium: false,
      },
      { showAllRows: true },
    );

    expect(display.kind).toBe('table');
    if (display.kind !== 'table') {
      return;
    }
    const rows = display.blocks.flatMap((block) => block.rows);
    expect(rows.some((row) => row.hiddenByFilter)).toBe(true);
    expect(rows.filter((row) => !row.hiddenByFilter)).toHaveLength(1);
  });

  it('showAllRows greys every row in a rowspan block, not only the first', () => {
    const pairs: AdaptationPair[] = [
      { sourceId: 1, adaptationId: 10 },
      { sourceId: 1, adaptationId: 20 },
    ];
    const map = mediaMap([
      media(1, { mediaType: 'MANGA', format: 'MANGA', listStatus: 'COMPLETED' }),
      media(10, { mediaType: 'ANIME', format: 'TV', listStatus: 'COMPLETED' }),
      media(20, { mediaType: 'ANIME', format: 'MOVIE', listStatus: 'COMPLETED' }),
    ]);

    const display = buildAdaptationDisplay(
      pairs,
      map,
      { animeListIds: new Set([10, 20]), mangaListIds: new Set([1]) },
      {
        includeAnime: false,
        includeManga: false,
        listStatuses: [...ADAPTATION_LIST_STATUS_OPTIONS],
        onlyBothOnList: false,
        hideSameMedium: false,
      },
      { showAllRows: true },
    );

    expect(display.kind).toBe('table');
    if (display.kind !== 'table') {
      return;
    }
    const rows = display.blocks[0]?.rows ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.hiddenByFilter)).toBe(true);
  });
});
