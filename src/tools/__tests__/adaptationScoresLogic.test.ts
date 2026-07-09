import { describe, expect, it } from 'vitest';
import {
  applyAdaptationFilters,
  ADAPTATION_LIST_STATUS_OPTIONS,
  buildAdaptationBlockRows,
  buildAdaptationDisplay,
  canStaggerChain,
  canonicalizeDirectedAdaptationLinks,
  dedupeAdaptationPairs,
  dedupeDirectedAdaptationLinks,
  normalizeAdaptationPair,
  normalizeDirectedAdaptationLink,
  relationTypeFromDirectedLink,
  resolveCrossMediumAdaptationPair,
  type AdaptationMedia,
  type AdaptationPair,
  type DirectedAdaptationLink,
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

function link(
  sourceId: number,
  adaptationId: number,
  seedId: number,
): DirectedAdaptationLink {
  return { sourceId, adaptationId, seedId };
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

/** Compact grid snapshot for stagger/overlap layout tests. */
function rowGrid(rows: ReturnType<typeof buildAdaptationBlockRows>): string[] {
  return rows.map((row, index) => {
    const src = row.source
      ? row.source.skipRender
        ? '.'
        : `S${row.source.media.id}${row.source.rowSpan > 1 ? `(rs${row.source.rowSpan})` : ''}`
      : row.leadingSourceGap
        ? '_'
        : '.';
    const adapt = row.adaptation
      ? row.adaptation.skipRender
        ? '.'
        : `A${row.adaptation.media.id}${row.adaptation.rowSpan > 1 ? `(rs${row.adaptation.rowSpan})` : ''}`
      : '.';
    const pair =
      row.pair != null ? `${row.pair.sourceId}->${row.pair.adaptationId}` : 'no-pair';
    return `${index}:${src}|${adapt} ${pair}`;
  });
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
    expect(normalizeAdaptationPair(107068, 'ADAPTATION', 85533)).toEqual({
      sourceId: 107068,
      adaptationId: 85533,
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

describe('normalizeDirectedAdaptationLink', () => {
  it('includes the scanning list entry as seedId', () => {
    expect(normalizeDirectedAdaptationLink(10, 'SOURCE', 5)).toEqual({
      sourceId: 5,
      adaptationId: 10,
      seedId: 10,
    });
    expect(normalizeDirectedAdaptationLink(10, 'ADAPTATION', 20)).toEqual({
      sourceId: 10,
      adaptationId: 20,
      seedId: 10,
    });
  });
});

describe('relationTypeFromDirectedLink', () => {
  it('recovers the raw AniList relation from strict normalization', () => {
    expect(relationTypeFromDirectedLink({ sourceId: 10, adaptationId: 20, seedId: 10 })).toBe(
      'ADAPTATION',
    );
    expect(relationTypeFromDirectedLink({ sourceId: 5, adaptationId: 10, seedId: 10 })).toBe(
      'SOURCE',
    );
  });
});

describe('canonicalizeDirectedAdaptationLinks', () => {
  const types = new Map<number, 'ANIME' | 'MANGA'>([
    [85533, 'MANGA'],
    [87142, 'MANGA'],
    [107068, 'ANIME'],
    [200, 'ANIME'],
    [300, 'MANGA'],
  ]);

  it('resolves bidirectional ADAPTATION to manga|anime (Takagi pattern B)', () => {
    const strict: DirectedAdaptationLink[] = [
      { sourceId: 87142, adaptationId: 107068, seedId: 87142 },
      { sourceId: 107068, adaptationId: 87142, seedId: 107068 },
    ];
    expect(canonicalizeDirectedAdaptationLinks(strict, types)).toEqual([
      { sourceId: 87142, adaptationId: 107068, seedId: 87142 },
      { sourceId: 87142, adaptationId: 107068, seedId: 107068 },
    ]);
  });

  it('keeps anime|manga when manga has SOURCE to anime (spinoff pattern A)', () => {
    const strict: DirectedAdaptationLink[] = [
      { sourceId: 200, adaptationId: 300, seedId: 300 },
      { sourceId: 200, adaptationId: 300, seedId: 200 },
    ];
    expect(canonicalizeDirectedAdaptationLinks(strict, types)).toEqual([
      { sourceId: 200, adaptationId: 300, seedId: 300 },
      { sourceId: 200, adaptationId: 300, seedId: 200 },
    ]);
    expect(
      resolveCrossMediumAdaptationPair(300, 200, strict),
    ).toEqual({ sourceId: 200, adaptationId: 300 });
  });

  it('leaves a single-sided anime ADAPTATION as anime|manga until the manga side is scanned', () => {
    const strict: DirectedAdaptationLink[] = [
      { sourceId: 200, adaptationId: 300, seedId: 200 },
    ];
    expect(canonicalizeDirectedAdaptationLinks(strict, types)).toEqual(strict);
  });
});

describe('takagi franchise orientation', () => {
  const TAKAGI_MANGA = 85533;
  const ASHITA_MANGA = 87142;
  const TAKAGI_S2 = 107068;
  const TAKAGI_S3 = 138424;

  const takagiLinks: DirectedAdaptationLink[] = [
    { sourceId: ASHITA_MANGA, adaptationId: TAKAGI_S2, seedId: ASHITA_MANGA },
    { sourceId: ASHITA_MANGA, adaptationId: TAKAGI_S2, seedId: TAKAGI_S2 },
    { sourceId: TAKAGI_MANGA, adaptationId: TAKAGI_S2, seedId: TAKAGI_S2 },
    { sourceId: ASHITA_MANGA, adaptationId: TAKAGI_S3, seedId: ASHITA_MANGA },
    { sourceId: ASHITA_MANGA, adaptationId: TAKAGI_S3, seedId: TAKAGI_S3 },
    { sourceId: TAKAGI_MANGA, adaptationId: TAKAGI_S3, seedId: TAKAGI_S3 },
  ];
  const takagiMap = mediaMap([
    media(ASHITA_MANGA, { mediaType: 'MANGA', title: 'Ashita wa Doyoubi' }),
    media(TAKAGI_MANGA, { mediaType: 'MANGA', title: 'Takagi-san', listStatus: null }),
    media(TAKAGI_S2, { mediaType: 'ANIME', title: 'Takagi-san 2' }),
    media(TAKAGI_S3, { mediaType: 'ANIME', title: 'Takagi-san 3' }),
  ]);
  const ashitaPlusAnimeScope = {
    animeListIds: new Set([TAKAGI_S2, TAKAGI_S3]),
    mangaListIds: new Set([ASHITA_MANGA]),
  };
  const allStatuses = [...ADAPTATION_LIST_STATUS_OPTIONS];

  it('shows ashita|anime pairs with onlyBothOnList when ashita and seasons are on list', () => {
    const filtered = applyAdaptationFilters(takagiLinks, takagiMap, ashitaPlusAnimeScope, {
      includeAnime: true,
      includeManga: true,
      listStatuses: allStatuses,
      onlyBothOnList: true,
      hideSameMedium: true,
    });

    expect(filtered).toEqual([
      { sourceId: ASHITA_MANGA, adaptationId: TAKAGI_S2 },
      { sourceId: ASHITA_MANGA, adaptationId: TAKAGI_S3 },
    ]);
  });

  it('shows main manga|anime from anime seeds when onlyBothOnList is off', () => {
    const filtered = applyAdaptationFilters(takagiLinks, takagiMap, ashitaPlusAnimeScope, {
      includeAnime: true,
      includeManga: true,
      listStatuses: allStatuses,
      onlyBothOnList: false,
      hideSameMedium: true,
    });

    expect(filtered).toEqual(
      expect.arrayContaining([
        { sourceId: TAKAGI_MANGA, adaptationId: TAKAGI_S2 },
        { sourceId: TAKAGI_MANGA, adaptationId: TAKAGI_S3 },
      ]),
    );
    expect(filtered).not.toEqual(
      expect.arrayContaining([
        { sourceId: TAKAGI_S3, adaptationId: ASHITA_MANGA },
        { sourceId: TAKAGI_S2, adaptationId: TAKAGI_MANGA },
      ]),
    );
  });

  it('shows main manga|anime with onlyBothOnList when main manga is also on list', () => {
    const scope = {
      animeListIds: new Set([TAKAGI_S2, TAKAGI_S3]),
      mangaListIds: new Set([ASHITA_MANGA, TAKAGI_MANGA]),
    };
    const links: DirectedAdaptationLink[] = [
      ...takagiLinks,
      { sourceId: TAKAGI_MANGA, adaptationId: TAKAGI_S2, seedId: TAKAGI_MANGA },
      { sourceId: TAKAGI_MANGA, adaptationId: TAKAGI_S3, seedId: TAKAGI_MANGA },
    ];
    const map = mediaMap([
      media(ASHITA_MANGA, { mediaType: 'MANGA', title: 'Ashita wa Doyoubi' }),
      media(TAKAGI_MANGA, { mediaType: 'MANGA', title: 'Takagi-san' }),
      media(TAKAGI_S2, { mediaType: 'ANIME', title: 'Takagi-san 2' }),
      media(TAKAGI_S3, { mediaType: 'ANIME', title: 'Takagi-san 3' }),
    ]);

    const filtered = applyAdaptationFilters(links, map, scope, {
      includeAnime: true,
      includeManga: true,
      listStatuses: allStatuses,
      onlyBothOnList: true,
      hideSameMedium: true,
    });

    expect(filtered).toEqual(
      expect.arrayContaining([
        { sourceId: TAKAGI_MANGA, adaptationId: TAKAGI_S2 },
        { sourceId: TAKAGI_MANGA, adaptationId: TAKAGI_S3 },
      ]),
    );
  });
});

describe('dedupeDirectedAdaptationLinks', () => {
  it('keeps distinct seeds for the same canonical pair', () => {
    const links: DirectedAdaptationLink[] = [
      { sourceId: 1, adaptationId: 2, seedId: 1 },
      { sourceId: 1, adaptationId: 2, seedId: 2 },
      { sourceId: 1, adaptationId: 2, seedId: 1 },
    ];
    expect(dedupeDirectedAdaptationLinks(links)).toEqual([
      { sourceId: 1, adaptationId: 2, seedId: 1 },
      { sourceId: 1, adaptationId: 2, seedId: 2 },
    ]);
  });
});

describe('applyAdaptationFilters', () => {
  const links: DirectedAdaptationLink[] = [
    link(1, 2, 1),
    link(1, 2, 2),
    link(3, 4, 4),
    link(5, 6, 5),
    link(5, 6, 6),
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
    const filtered = applyAdaptationFilters(links, map, scope, {
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
    const filtered = applyAdaptationFilters(links, map, scope, {
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

  it('filters to doubly-connected pairs when onlyBothOnList is enabled', () => {
    const filtered = applyAdaptationFilters(links, map, scope, {
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
    const filtered = applyAdaptationFilters(links, map, scope, {
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

  it('filters rows when the scanning seed matches a selected list status', () => {
    const filtered = applyAdaptationFilters(links, map, scope, {
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

  it('anime-only status filter matches anime seeds, not manga seeds', () => {
    const filtered = applyAdaptationFilters(
      [
        link(100, 200, 100),
        link(100, 200, 200),
      ],
      mediaMap([
        media(100, { mediaType: 'MANGA', format: 'MANGA', listStatus: 'COMPLETED' }),
        media(200, {
          mediaType: 'ANIME',
          format: 'MOVIE',
          listStatus: 'PLANNING',
        }),
      ]),
      { animeListIds: new Set([200]), mangaListIds: new Set([100]) },
      {
        includeAnime: true,
        includeManga: false,
        listStatuses: ['PLANNING'],
        onlyBothOnList: false,
        hideSameMedium: false,
      },
    );
    expect(filtered).toEqual([{ sourceId: 100, adaptationId: 200 }]);
  });

  it('anime-only status filter ignores planning manga seeds', () => {
    const filtered = applyAdaptationFilters(
      [
        link(100, 200, 100),
        link(100, 200, 200),
      ],
      mediaMap([
        media(100, { mediaType: 'MANGA', format: 'MANGA', listStatus: 'PLANNING' }),
        media(200, {
          mediaType: 'ANIME',
          format: 'MOVIE',
          listStatus: 'COMPLETED',
        }),
      ]),
      { animeListIds: new Set([200]), mangaListIds: new Set([100]) },
      {
        includeAnime: true,
        includeManga: false,
        listStatuses: ['PLANNING'],
        onlyBothOnList: false,
        hideSameMedium: false,
      },
    );
    expect(filtered).toEqual([]);
  });

  it('anime-only planning filter keeps manga-completed anime seeds (Haikyuu-style)', () => {
    const filtered = applyAdaptationFilters(
      [
        link(100, 200, 100),
        link(100, 200, 200),
      ],
      mediaMap([
        media(100, { mediaType: 'MANGA', format: 'MANGA', listStatus: 'COMPLETED' }),
        media(200, {
          mediaType: 'ANIME',
          format: 'MOVIE',
          listStatus: 'PLANNING',
        }),
      ]),
      { animeListIds: new Set([200]), mangaListIds: new Set([100]) },
      {
        includeAnime: true,
        includeManga: false,
        listStatuses: ['PLANNING'],
        onlyBothOnList: false,
        hideSameMedium: false,
      },
    );
    expect(filtered).toEqual([{ sourceId: 100, adaptationId: 200 }]);
  });

  it('onlyBothOnList requires passing seeds from both sides under status filters', () => {
    const filtered = applyAdaptationFilters(
      [
        link(100, 200, 100),
        link(100, 200, 200),
      ],
      mediaMap([
        media(100, { mediaType: 'MANGA', format: 'MANGA', listStatus: 'PLANNING' }),
        media(200, {
          mediaType: 'ANIME',
          format: 'TV',
          listStatus: 'COMPLETED',
        }),
      ]),
      { animeListIds: new Set([200]), mangaListIds: new Set([100]) },
      {
        includeAnime: true,
        includeManga: true,
        listStatuses: ['PLANNING'],
        onlyBothOnList: true,
        hideSameMedium: false,
      },
    );
    expect(filtered).toEqual([]);
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

  it('staggers the minimal two-adaptation overlap grid (A|X, A|Y, B|Y)', () => {
    //  A (rs=2) | X
    //           | Y (rs=2)
    //  B        |
    const A = 1;
    const B = 2;
    const X = 10;
    const Y = 11;
    const pairs: AdaptationPair[] = [
      { sourceId: A, adaptationId: X },
      { sourceId: A, adaptationId: Y },
      { sourceId: B, adaptationId: Y },
    ];
    const map = mediaMap([
      media(A, { mediaType: 'MANGA', format: 'NOVEL', startDate: { year: 2010, month: 1, day: 1 } }),
      media(B, { mediaType: 'MANGA', format: 'NOVEL', startDate: { year: 2011, month: 1, day: 1 } }),
      media(X, { startDate: { year: 2014, month: 1, day: 1 } }),
      media(Y, { startDate: { year: 2015, month: 1, day: 1 } }),
    ]);

    expect(canStaggerChain([map.get(X)!, map.get(Y)!], pairs, map)).toBe(true);

    const rows = buildAdaptationBlockRows(pairs, map);
    expect(rowGrid(rows)).toEqual([
      '0:S1(rs2)|A10 1->10',
      '1:.|A11(rs2) no-pair',
      '2:S2|. no-pair',
    ]);

    expect(rows[0]?.source?.rowSpan).toBe(2);
    expect(rows[0]?.adaptation?.media.id).toBe(X);
    expect(rows[1]?.adaptation?.rowSpan).toBe(2);
    expect(rows[1]?.adaptation?.skipRender).toBe(false);
    expect(rows[2]?.source?.media.id).toBe(B);
    expect(rows[2]?.adaptation).toBeNull();
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

    const sourceAfterAdaptSegment = rows.find(
      (row) => row.source?.media.id === 3 && !row.source.skipRender,
    );
    expect(sourceAfterAdaptSegment?.leadingSourceGap).not.toBe(true);
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

  it('does not merge a shared source across multi-source adaptations (Takagi-style)', () => {
    const M = 85533;
    const A = 87142;
    const S1 = 99468;
    const S2 = 107068;
    const WS = 101426;
    const S3 = 138424;
    const pairs: AdaptationPair[] = [
      { sourceId: M, adaptationId: S1 },
      { sourceId: M, adaptationId: WS },
      { sourceId: M, adaptationId: S2 },
      { sourceId: M, adaptationId: S3 },
      { sourceId: A, adaptationId: S2 },
      { sourceId: A, adaptationId: S3 },
    ];
    const map = mediaMap([
      media(M, {
        mediaType: 'MANGA',
        format: 'MANGA',
        title: 'Takagi manga',
        startDate: { year: 2013, month: 1, day: 1 },
      }),
      media(A, {
        mediaType: 'MANGA',
        format: 'MANGA',
        title: 'Ashita',
        startDate: { year: 2017, month: 1, day: 1 },
      }),
      media(S1, { title: 'S1', startDate: { year: 2018, month: 1, day: 8 } }),
      media(WS, {
        title: 'Water Slide',
        format: 'OVA',
        startDate: { year: 2018, month: 7, day: 10 },
      }),
      media(S2, { title: 'S2', startDate: { year: 2019, month: 7, day: 7 } }),
      media(S3, { title: 'S3', startDate: { year: 2022, month: 1, day: 8 } }),
    ]);

    const rows = buildAdaptationBlockRows(pairs, map);
    const mangaS2Row = rows.find(
      (row) =>
        row.pair?.sourceId === M &&
        row.pair.adaptationId === S2 &&
        row.source &&
        !row.source.skipRender,
    );
    expect(mangaS2Row).toBeDefined();
    expect(mangaS2Row?.source?.rowSpan).toBe(1);
    expect(mangaS2Row?.adaptation?.media.id).toBe(S2);
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
    const links: DirectedAdaptationLink[] = [
      link(1, 20, 1),
      link(2, 30, 2),
    ];
    const map = mediaMap([
      media(1, { mediaType: 'MANGA' }),
      media(2, { mediaType: 'MANGA' }),
      media(20, { startDate: { year: 2020, month: 1, day: 1 } }),
      media(30, { startDate: { year: 2018, month: 1, day: 1 } }),
    ]);

    const display = buildAdaptationDisplay(links, map, {
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
    const links: DirectedAdaptationLink[] = [
      link(1, 10, 1),
      link(1, 10, 10),
      link(2, 20, 2),
      link(2, 20, 20),
    ];
    const map = mediaMap([
      media(1, { mediaType: 'MANGA', listStatus: 'COMPLETED' }),
      media(2, { mediaType: 'MANGA', listStatus: 'COMPLETED' }),
      media(10, { mediaType: 'ANIME', listStatus: 'COMPLETED' }),
      media(20, { mediaType: 'ANIME', listStatus: null }),
    ]);

    const display = buildAdaptationDisplay(
      links,
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
    const links: DirectedAdaptationLink[] = [
      link(1, 10, 1),
      link(1, 20, 1),
    ];
    const map = mediaMap([
      media(1, { mediaType: 'MANGA', format: 'MANGA', listStatus: 'COMPLETED' }),
      media(10, { mediaType: 'ANIME', format: 'TV', listStatus: 'COMPLETED' }),
      media(20, { mediaType: 'ANIME', format: 'MOVIE', listStatus: 'COMPLETED' }),
    ]);

    const display = buildAdaptationDisplay(
      links,
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
