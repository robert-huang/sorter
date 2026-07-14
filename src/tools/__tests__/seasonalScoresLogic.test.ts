import { describe, expect, it } from 'vitest';
import type { AnilistMediaSource } from '../../lib/importers/anilist/types';
import {
  applySeasonalListStatusFilters,
  applySeasonalSeasonYearFilters,
  applySeasonalSourceFilters,
  averageScore,
  buildSeasonalColumns,
  clampAiringIntervalSeasonBoundaries,
  countSeasonalShowsBySourceBucket,
  discoverSeasonalSeasonYearEncoded,
  DEFAULT_SEASONAL_SOURCE_FILTERS,
  effectiveSeasonalForm,
  encodeSeasonalShowSeasonYear,
  formatSeasonColumnLabel,
  formatSeasonalScoreLabel,
  normalizeSeasonalListScore,
  scoreDisplayTone,
  scoreDisplayToneClass,
  seasonColumnIndicesWithTopAverage,
  seasonalSourceFilterBucket,
  parseSeasonLine,
  parseSeasonSpecs,
  type SeasonalScoresForm,
  type SeasonalShow,
} from '../panels/seasonalScoresLogic';
import { encodeSeasonYear } from '../../lib/importers/anilist/filters';

const sampleShows: SeasonalShow[] = [
  {
    id: 1,
    title: 'Winter A',
    season: 'WINTER',
    seasonYear: 2024,
    score: 90,
    notes: null,
  },
  {
    id: 2,
    title: 'Winter B',
    season: 'WINTER',
    seasonYear: 2024,
    score: 80,
    notes: null,
  },
  {
    id: 3,
    title: 'Spring A',
    season: 'SPRING',
    seasonYear: 2024,
    score: 70,
    notes: null,
  },
];

describe('seasonalScoresLogic', () => {
  it('parseSeasonLine maps Autumn to Fall', () => {
    expect(parseSeasonLine('Autumn 2024')).toEqual({ season: 'FALL', year: 2024 });
  });

  it('parseSeasonSpecs handles year-only and named seasons', () => {
    const specs = parseSeasonSpecs('2024\nWinter 2023', sampleShows);
    expect(specs.map((s) => s.label)).toEqual(['2024', 'Winter 2023']);
    expect(specs[1]?.season).toBe('WINTER');
  });

  it('buildSeasonalColumns buckets and averages per season', () => {
    const result = buildSeasonalColumns(sampleShows, {
      username: 'user',
      seasonText: 'Winter 2024\nSpring 2024',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: false,
      spanAiringSeasons: false,
      seasonMode: 'custom',
    });
    expect(result.kind).toBe('columns');
    if (result.kind !== 'columns') {
      return;
    }
    const winter = result.columns.find((c) => c.label === 'Winter 2024');
    expect(winter?.average).toBe(85);
    expect(winter?.ratedCount).toBe(2);
    expect(winter?.shows.map((s) => s.title)).toEqual(['Winter A', 'Winter B']);
  });

  it('normalizeSeasonalListScore treats 0 as unrated', () => {
    expect(normalizeSeasonalListScore(0)).toBeNull();
    expect(normalizeSeasonalListScore(null)).toBeNull();
    expect(normalizeSeasonalListScore(85)).toBe(85);
    expect(formatSeasonalScoreLabel(0)).toBe('—');
    expect(formatSeasonalScoreLabel(85)).toBe('85');
    expect(formatSeasonalScoreLabel(null, 'PLANNING')).toBe('P');
    expect(formatSeasonalScoreLabel(85, 'PLANNING')).toBe('85');
    expect(formatSeasonalScoreLabel(null, 'CURRENT')).toBe('W');
    expect(formatSeasonalScoreLabel(85, 'CURRENT')).toBe('85');
    expect(formatSeasonalScoreLabel(null, 'REPEATING')).toBe('W');
    expect(formatSeasonalScoreLabel(70, 'REPEATING')).toBe('70');
    expect(formatSeasonalScoreLabel(null, 'PAUSED')).toBe('H');
    expect(formatSeasonalScoreLabel(75, 'PAUSED')).toBe('75');
  });

  it('scoreDisplayTone highlights scores above 80 and below 70', () => {
    expect(scoreDisplayTone(85)).toBe('high');
    expect(scoreDisplayTone(80)).toBeNull();
    expect(scoreDisplayTone(70)).toBeNull();
    expect(scoreDisplayTone(65)).toBe('low');
    expect(scoreDisplayTone(null)).toBeNull();
    expect(scoreDisplayToneClass(90)).toBe('tool-score-tone--high');
    expect(scoreDisplayToneClass(50)).toBe('tool-score-tone--low');
    expect(scoreDisplayToneClass(75)).toBe('');
  });

  it('averageScore ignores unrated paused and repeating entries', () => {
    const shows: SeasonalShow[] = [
      {
        id: 1,
        title: 'Scored',
        season: 'WINTER',
        seasonYear: 2024,
        score: 80,
        notes: null,
      },
      {
        id: 2,
        title: 'Paused unrated',
        season: 'WINTER',
        seasonYear: 2024,
        score: null,
        notes: null,
      },
      {
        id: 3,
        title: 'Repeating unrated',
        season: 'WINTER',
        seasonYear: 2024,
        score: 0,
        notes: null,
      },
    ];
    expect(averageScore(shows)).toBe(80);
    const result = buildSeasonalColumns(shows, {
      username: 'user',
      seasonText: 'Winter 2024',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: false,
      spanAiringSeasons: false,
      seasonMode: 'custom',
    });
    expect(result.kind).toBe('columns');
    if (result.kind === 'columns') {
      expect(result.columns[0]?.average).toBe(80);
      expect(result.columns[0]?.ratedCount).toBe(1);
      expect(result.columns[0]?.shows).toHaveLength(3);
      expect(result.columns[0]?.shows[1]?.score).toBeNull();
      expect(result.columns[0]?.shows[2]?.score).toBeNull();
    }
  });

  it('formatSeasonColumnLabel appends rated count after the year', () => {
    expect(formatSeasonColumnLabel('Winter 2024', 5)).toBe('Winter 2024 (5)');
    expect(formatSeasonColumnLabel('2024', 12)).toBe('2024 (12)');
  });

  describe('seasonColumnIndicesWithTopAverage', () => {
    it('returns the single highest-average column index', () => {
      expect(
        seasonColumnIndicesWithTopAverage([
          { average: 70 },
          { average: 85 },
          { average: 80 },
        ]),
      ).toEqual(new Set([1]));
    });

    it('returns every column tied for the highest average', () => {
      expect(
        seasonColumnIndicesWithTopAverage([
          { average: 90 },
          { average: 75 },
          { average: 90 },
        ]),
      ).toEqual(new Set([0, 2]));
    });

    it('ignores null averages and returns empty when none are rated', () => {
      expect(
        seasonColumnIndicesWithTopAverage([
          { average: null },
          { average: null },
        ]),
      ).toEqual(new Set());
    });
  });

  it('includes unrated planning shows with P label and excludes them from average', () => {
    const shows: SeasonalShow[] = [
      {
        id: 1,
        title: 'Scored',
        season: 'WINTER',
        seasonYear: 2024,
        score: 80,
        notes: null,
      },
      {
        id: 2,
        title: 'Planning',
        season: 'WINTER',
        seasonYear: 2024,
        score: null,
        notes: null,
        listStatus: 'PLANNING',
      },
    ];
    expect(averageScore(shows)).toBe(80);
    const result = buildSeasonalColumns(shows, {
      username: 'user',
      seasonText: 'Winter 2024',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: true,
      spanAiringSeasons: false,
      seasonMode: 'custom',
    });
    expect(result.kind).toBe('columns');
    if (result.kind === 'columns') {
      expect(result.columns[0]?.average).toBe(80);
      expect(result.columns[0]?.ratedCount).toBe(1);
      expect(result.columns[0]?.shows).toHaveLength(2);
      expect(result.columns[0]?.shows[0]?.title).toBe('Scored');
      expect(result.columns[0]?.shows[1]?.listStatus).toBe('PLANNING');
    }
  });

  it('filters planning shows when includePlanning is off', () => {
    const shows: SeasonalShow[] = [
      {
        id: 1,
        title: 'Scored',
        season: 'WINTER',
        seasonYear: 2024,
        score: 80,
        notes: null,
      },
      {
        id: 2,
        title: 'Planning',
        season: 'WINTER',
        seasonYear: 2024,
        score: null,
        notes: null,
        listStatus: 'PLANNING',
      },
    ];
    const result = buildSeasonalColumns(shows, {
      username: 'user',
      seasonText: 'Winter 2024',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: false,
      spanAiringSeasons: false,
      seasonMode: 'custom',
    });
    expect(result.kind).toBe('columns');
    if (result.kind === 'columns') {
      expect(result.columns[0]?.shows).toHaveLength(1);
      expect(result.columns[0]?.shows[0]?.title).toBe('Scored');
    }
  });

  it('expands `alltime` into a single merged column', () => {
    const specs = parseSeasonSpecs('alltime', sampleShows);
    expect(specs).toEqual([
      { label: 'All Time', season: null, year: 0, matchAll: true },
    ]);
  });

  it('buildSeasonalColumns merges the full list in alltime mode', () => {
    const result = buildSeasonalColumns(sampleShows, {
      username: 'user',
      seasonText: 'alltime',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: false,
      spanAiringSeasons: false,
      seasonMode: 'alltime',
    });
    expect(result.kind).toBe('columns');
    if (result.kind === 'columns') {
      expect(result.columns).toHaveLength(1);
      expect(result.columns[0]).toMatchObject({
        label: 'All Time',
        matchAll: true,
        ratedCount: 3,
      });
      expect(result.columns[0]?.shows.map((s) => s.title)).toEqual([
        'Winter A',
        'Winter B',
        'Spring A',
      ]);
    }
  });

  it('applySeasonalSourceFilters keeps only enabled adaptation sources', () => {
    const shows: SeasonalShow[] = [
      {
        id: 1,
        title: 'Original',
        season: 'WINTER',
        seasonYear: 2024,
        score: 90,
        notes: null,
        source: 'ORIGINAL',
      },
      {
        id: 2,
        title: 'LN adapt',
        season: 'WINTER',
        seasonYear: 2024,
        score: 80,
        notes: null,
        source: 'LIGHT_NOVEL',
      },
    ];
    const filtered = applySeasonalSourceFilters(
      shows,
      DEFAULT_SEASONAL_SOURCE_FILTERS.filter((key) => key !== 'LIGHT_NOVEL'),
    );
    expect(filtered.map((s) => s.title)).toEqual(['Original']);
    expect(seasonalSourceFilterBucket(null)).toBe('OTHER');
    expect(seasonalSourceFilterBucket('DOUJINSHI')).toBe('DOUJINSHI');
    expect(seasonalSourceFilterBucket('WEB_NOVEL')).toBe('WEB_NOVEL');
    expect(seasonalSourceFilterBucket('not-a-source' as AnilistMediaSource)).toBe('OTHER');
  });

  it('countSeasonalShowsBySourceBucket tallies each adaptation source', () => {
    const shows: SeasonalShow[] = [
      {
        id: 1,
        title: 'A',
        season: 'WINTER',
        seasonYear: 2024,
        score: 90,
        notes: null,
        source: 'ORIGINAL',
      },
      {
        id: 2,
        title: 'B',
        season: 'WINTER',
        seasonYear: 2024,
        score: 80,
        notes: null,
        source: 'ORIGINAL',
      },
      {
        id: 3,
        title: 'C',
        season: 'WINTER',
        seasonYear: 2024,
        score: 70,
        notes: null,
        source: 'LIGHT_NOVEL',
      },
      {
        id: 4,
        title: 'D',
        season: 'WINTER',
        seasonYear: 2024,
        score: 60,
        notes: null,
        source: null,
      },
    ];
    const counts = countSeasonalShowsBySourceBucket(shows);
    expect(counts.ORIGINAL).toBe(2);
    expect(counts.LIGHT_NOVEL).toBe(1);
    expect(counts.OTHER).toBe(1);
    expect(counts.MANGA).toBe(0);
  });

  it('encodeSeasonalShowSeasonYear encodes season + seasonYear tuples', () => {
    expect(
      encodeSeasonalShowSeasonYear({
        id: 1,
        title: 'A',
        season: 'WINTER',
        seasonYear: 2024,
        score: 80,
        notes: null,
      }),
    ).toBe(encodeSeasonYear('WINTER', 2024));
    expect(
      encodeSeasonalShowSeasonYear({
        id: 2,
        title: 'B',
        season: null,
        seasonYear: 2024,
        score: 80,
        notes: null,
      }),
    ).toBeNull();
  });

  it('applySeasonalSeasonYearFilters keeps only shows in the encoded range', () => {
    const shows: SeasonalShow[] = [
      {
        id: 1,
        title: 'Winter 2024',
        season: 'WINTER',
        seasonYear: 2024,
        score: 90,
        notes: null,
      },
      {
        id: 2,
        title: 'Winter 2023',
        season: 'WINTER',
        seasonYear: 2023,
        score: 80,
        notes: null,
      },
    ];
    const encoded = discoverSeasonalSeasonYearEncoded(shows);
    expect(encoded).toEqual([
      encodeSeasonYear('WINTER', 2023),
      encodeSeasonYear('WINTER', 2024),
    ]);
    const filtered = applySeasonalSeasonYearFilters(shows, {
      seasonYearMin: encodeSeasonYear('WINTER', 2024),
      seasonYearMax: null,
    });
    expect(filtered.map((show) => show.title)).toEqual(['Winter 2024']);
  });

  it('applySeasonalListStatusFilters keeps only selected list statuses but not planning', () => {
    const shows: SeasonalShow[] = [
      {
        id: 1,
        title: 'Done',
        season: 'WINTER',
        seasonYear: 2024,
        score: 90,
        notes: null,
        listStatus: 'COMPLETED',
      },
      {
        id: 2,
        title: 'Plan',
        season: 'WINTER',
        seasonYear: 2024,
        score: null,
        notes: null,
        listStatus: 'PLANNING',
      },
      {
        id: 3,
        title: 'Watching',
        season: 'WINTER',
        seasonYear: 2024,
        score: 70,
        notes: null,
        listStatus: 'CURRENT',
      },
    ];
    const filtered = applySeasonalListStatusFilters(shows, ['COMPLETED']);
    expect(filtered.map((show) => show.title)).toEqual(['Done', 'Plan']);
  });

  it('buildSeasonalColumns applies seasonYear and list-status filters over cached shows', () => {
    const shows: SeasonalShow[] = [
      {
        id: 1,
        title: '2024 completed',
        season: 'WINTER',
        seasonYear: 2024,
        score: 90,
        notes: null,
        listStatus: 'COMPLETED',
      },
      {
        id: 2,
        title: '2023 completed',
        season: 'WINTER',
        seasonYear: 2023,
        score: 80,
        notes: null,
        listStatus: 'COMPLETED',
      },
      {
        id: 3,
        title: '2024 planning',
        season: 'WINTER',
        seasonYear: 2024,
        score: null,
        notes: null,
        listStatus: 'PLANNING',
      },
    ];
    const form: SeasonalScoresForm = {
      username: 'tester',
      seasonText: 'alltime',
      seasonMode: 'alltime',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: false,
      spanAiringSeasons: false,
    };
    const filtered = buildSeasonalColumns(shows, effectiveSeasonalForm(form), {
      seasonYearFilter: {
        seasonYearMin: encodeSeasonYear('WINTER', 2024),
        seasonYearMax: encodeSeasonYear('FALL', 2024),
      },
      listStatusFilters: ['COMPLETED'],
    });
    expect(filtered.kind).toBe('columns');
    if (filtered.kind === 'columns') {
      expect(filtered.columns[0]?.shows.map((show) => show.title)).toEqual(['2024 completed']);
    }
  });

  it('buildSeasonalColumns applies sourceFilters over cached shows', () => {
    const shows: SeasonalShow[] = [
      {
        id: 1,
        title: 'Manga show',
        season: 'WINTER',
        seasonYear: 2024,
        score: 90,
        notes: null,
        source: 'MANGA',
      },
      {
        id: 2,
        title: 'Original show',
        season: 'WINTER',
        seasonYear: 2024,
        score: 80,
        notes: null,
        source: 'ORIGINAL',
      },
    ];
    const form: SeasonalScoresForm = {
      username: 'tester',
      seasonText: 'alltime',
      seasonMode: 'alltime',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: false,
      spanAiringSeasons: false,
    };
    const filtered = buildSeasonalColumns(shows, effectiveSeasonalForm(form), {
      sourceFilters: ['ORIGINAL'],
    });
    expect(filtered.kind).toBe('columns');
    if (filtered.kind === 'columns') {
      expect(filtered.columns[0]?.shows.map((show) => show.title)).toEqual(['Original show']);
    }
  });

  it('expands `all` into one column per year covering the data span', () => {
    const shows: SeasonalShow[] = [
      { id: 1, title: 'A', season: 'WINTER', seasonYear: 2022, score: 70, notes: null },
      { id: 2, title: 'B', season: 'SPRING', seasonYear: 2024, score: 80, notes: null },
    ];
    const specs = parseSeasonSpecs('all', shows);
    expect(specs.map((s) => s.label)).toEqual(['2022', '2023', '2024']);
    expect(specs.every((s) => s.season === null)).toBe(true);
  });

  it('expands `allseasons` into four labeled columns per year', () => {
    const shows: SeasonalShow[] = [
      { id: 1, title: 'A', season: 'WINTER', seasonYear: 2023, score: 70, notes: null },
      { id: 2, title: 'B', season: 'FALL',   seasonYear: 2024, score: 80, notes: null },
    ];
    const specs = parseSeasonSpecs('allseasons', shows);
    expect(specs.map((s) => s.label)).toEqual([
      'Winter 2023', 'Spring 2023', 'Summer 2023', 'Fall 2023',
      'Winter 2024', 'Spring 2024', 'Summer 2024', 'Fall 2024',
    ]);
  });

  it('emits zero specs for `all` / `allseasons` when shows have no usable years', () => {
    // Empty list (most common: AniList `data: null` short-circuit).
    expect(parseSeasonSpecs('all', [])).toEqual([]);
    expect(parseSeasonSpecs('allseasons', [])).toEqual([]);
    // Non-empty list but every entry is missing seasonYear (e.g. all movies).
    const moviesOnly: SeasonalShow[] = [
      { id: 1, title: 'Movie A', season: null, seasonYear: null, score: 85, notes: null },
      { id: 2, title: 'Movie B', season: null, seasonYear: null, score: 75, notes: null },
    ];
    expect(parseSeasonSpecs('all', moviesOnly)).toEqual([]);
    expect(parseSeasonSpecs('allseasons', moviesOnly)).toEqual([]);
  });

  it('explicit season lines still resolve when shows have no usable years', () => {
    // Regression guard: removing the current-year fallback must not break
    // typed seasons / years that don't depend on the shows-derived range.
    const specs = parseSeasonSpecs('Winter 2024\n2018', []);
    expect(specs.map((s) => s.label)).toEqual(['Winter 2024', '2018']);
  });

  it('empty shows + `allseasons` returns the privacy/empty-list message', () => {
    const result = buildSeasonalColumns([], {
      username: 'user',
      seasonText: 'allseasons',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: false,
      spanAiringSeasons: false,
      seasonMode: 'allseasons',
    });
    expect(result.kind).toBe('empty');
    if (result.kind === 'empty') {
      expect(result.message).toMatch(/list may be private/i);
    }
  });

  it('shows-with-no-seasonYear + `all` returns the custom-mode hint', () => {
    const moviesOnly: SeasonalShow[] = [
      { id: 1, title: 'Movie A', season: null, seasonYear: null, score: 85, notes: null },
    ];
    const result = buildSeasonalColumns(moviesOnly, {
      username: 'user',
      seasonText: 'all',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: false,
      spanAiringSeasons: false,
      seasonMode: 'all',
    });
    expect(result.kind).toBe('empty');
    if (result.kind === 'empty') {
      expect(result.message).toMatch(/custom mode/i);
    }
  });

  it('skipEmpty drops columns with no matching shows', () => {
    const result = buildSeasonalColumns(sampleShows, {
      username: 'user',
      seasonText: 'Winter 2024\nFall 2099',
      skipEmpty: true,
      airingNotesOnly: false,
      includePlanning: false,
      spanAiringSeasons: false,
      seasonMode: 'custom',
    });
    expect(result.kind).toBe('columns');
    if (result.kind === 'columns') {
      expect(result.columns.map((c) => c.label)).toEqual(['Winter 2024']);
    }
  });

  it('all-unrated column returns null average and ratedCount 0', () => {
    const shows: SeasonalShow[] = [
      { id: 1, title: 'A', season: 'WINTER', seasonYear: 2024, score: 0,    notes: null },
      { id: 2, title: 'B', season: 'WINTER', seasonYear: 2024, score: null, notes: null },
    ];
    const result = buildSeasonalColumns(shows, {
      username: 'user',
      seasonText: 'Winter 2024',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: false,
      spanAiringSeasons: false,
      seasonMode: 'custom',
    });
    expect(result.kind).toBe('columns');
    if (result.kind === 'columns') {
      expect(result.columns[0]?.average).toBeNull();
      expect(result.columns[0]?.ratedCount).toBe(0);
      expect(result.columns[0]?.shows).toHaveLength(2);
    }
  });

  it('all-planning unrated column returns null average and zero ratedCount but keeps the shows visible', () => {
    const shows: SeasonalShow[] = [
      { id: 1, title: 'P1', season: 'WINTER', seasonYear: 2024, score: null, notes: null, listStatus: 'PLANNING' },
      { id: 2, title: 'P2', season: 'WINTER', seasonYear: 2024, score: null, notes: null, listStatus: 'PLANNING' },
    ];
    const result = buildSeasonalColumns(shows, {
      username: 'user',
      seasonText: 'Winter 2024',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: true,
      spanAiringSeasons: false,
      seasonMode: 'custom',
    });
    expect(result.kind).toBe('columns');
    if (result.kind === 'columns') {
      expect(result.columns[0]?.average).toBeNull();
      expect(result.columns[0]?.ratedCount).toBe(0);
      expect(result.columns[0]?.shows).toHaveLength(2);
    }
  });

  it('airingNotesOnly keeps only entries whose notes include #airing', () => {
    const shows: SeasonalShow[] = [
      { id: 1, title: 'A', season: 'WINTER', seasonYear: 2024, score: 90, notes: 'just a note' },
      { id: 2, title: 'B', season: 'WINTER', seasonYear: 2024, score: 80, notes: '#airing finished' },
      { id: 3, title: 'C', season: 'WINTER', seasonYear: 2024, score: 70, notes: null },
    ];
    const result = buildSeasonalColumns(shows, {
      username: 'user',
      seasonText: 'Winter 2024',
      skipEmpty: false,
      airingNotesOnly: true,
      includePlanning: false,
      spanAiringSeasons: false,
      seasonMode: 'custom',
    });
    expect(result.kind).toBe('columns');
    if (result.kind === 'columns') {
      expect(result.columns[0]?.shows.map((s) => s.title)).toEqual(['B']);
    }
  });

  it('sorts within a column: scored descending, then —, then W, H, P at the bottom', () => {
    const shows: SeasonalShow[] = [
      { id: 1, title: 'Low',              season: 'WINTER', seasonYear: 2024, score: 60,   notes: null },
      { id: 2, title: 'Planning',         season: 'WINTER', seasonYear: 2024, score: null, notes: null, listStatus: 'PLANNING' },
      { id: 3, title: 'High',             season: 'WINTER', seasonYear: 2024, score: 90,   notes: null },
      { id: 4, title: 'Unrated',          season: 'WINTER', seasonYear: 2024, score: null, notes: null },
      { id: 5, title: 'Watching rated',   season: 'WINTER', seasonYear: 2024, score: 85,   notes: null, listStatus: 'CURRENT' },
      { id: 6, title: 'Repeating unrated', season: 'WINTER', seasonYear: 2024, score: null, notes: null, listStatus: 'REPEATING' },
      { id: 7, title: 'Paused unrated',   season: 'WINTER', seasonYear: 2024, score: null, notes: null, listStatus: 'PAUSED' },
    ];
    const result = buildSeasonalColumns(shows, {
      username: 'user',
      seasonText: 'Winter 2024',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: true,
      spanAiringSeasons: false,
      seasonMode: 'custom',
    });
    expect(result.kind).toBe('columns');
    if (result.kind === 'columns') {
      expect(result.columns[0]?.shows.map((s) => s.title)).toEqual([
        'High',
        'Watching rated',
        'Low',
        'Unrated',
        'Repeating unrated',
        'Paused unrated',
        'Planning',
      ]);
    }
  });

  it('threads season + year into each SeasonColumn (for AniList search URL)', () => {
    const shows: SeasonalShow[] = [
      { id: 1, title: 'A', season: 'WINTER', seasonYear: 2024, score: 80, notes: null },
      { id: 2, title: 'B', season: 'SPRING', seasonYear: 2024, score: 70, notes: null },
    ];
    const result = buildSeasonalColumns(shows, {
      username: 'user',
      seasonText: 'Winter 2024\n2024',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: false,
      spanAiringSeasons: false,
      seasonMode: 'custom',
    });
    expect(result.kind).toBe('columns');
    if (result.kind === 'columns') {
      expect(result.columns[0]).toMatchObject({ season: 'WINTER', year: 2024 });
      // Year-only spec (`2024`) leaves season unset.
      expect(result.columns[1]).toMatchObject({ season: null, year: 2024 });
    }
  });

  it('returns empty kind when season text is blank', () => {
    const result = buildSeasonalColumns(sampleShows, {
      username: 'user',
      seasonText: '   \n  ',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: false,
      spanAiringSeasons: false,
      seasonMode: 'custom',
    });
    expect(result.kind).toBe('empty');
  });

  describe('effectiveSeasonalForm', () => {
    const baseForm: SeasonalScoresForm = {
      username: 'user',
      seasonText: 'Winter 2024',
      seasonMode: 'custom',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: false,
      spanAiringSeasons: false,
    };

    it('preserves seasonText when mode is custom', () => {
      const effective = effectiveSeasonalForm(baseForm);
      expect(effective.seasonText).toBe('Winter 2024');
      // Returned form should equal the input (custom is a passthrough).
      expect(effective).toEqual(baseForm);
    });

    it('overrides seasonText with "alltime" when mode is alltime', () => {
      const effective = effectiveSeasonalForm({ ...baseForm, seasonMode: 'alltime' });
      expect(effective.seasonText).toBe('alltime');
      const result = buildSeasonalColumns(sampleShows, effective);
      expect(result.kind).toBe('columns');
      if (result.kind === 'columns') {
        expect(result.columns).toHaveLength(1);
        expect(result.columns[0]?.matchAll).toBe(true);
      }
    });

    it('overrides seasonText with "all" when mode is all (keeping other fields)', () => {
      const effective = effectiveSeasonalForm({ ...baseForm, seasonMode: 'all' });
      expect(effective.seasonText).toBe('all');
      // Verifies the magic keyword routes through parseSeasonSpecs into year columns.
      // sampleShows are all 2024 — `all` yields one column per year in the range.
      const result = buildSeasonalColumns(sampleShows, effective);
      expect(result.kind).toBe('columns');
      if (result.kind === 'columns') {
        expect(result.columns.map((c) => c.label)).toEqual(['2024']);
        expect(result.columns.every((c) => c.season === null)).toBe(true);
      }
    });

    it('overrides seasonText with "allseasons" when mode is allseasons', () => {
      const effective = effectiveSeasonalForm({ ...baseForm, seasonMode: 'allseasons' });
      expect(effective.seasonText).toBe('allseasons');
      const result = buildSeasonalColumns(sampleShows, effective);
      expect(result.kind).toBe('columns');
      if (result.kind === 'columns') {
        // 1 year × 4 seasons = 4 columns in Winter→Fall order.
        expect(result.columns).toHaveLength(4);
        expect(result.columns[0]).toMatchObject({ season: 'WINTER', year: 2024 });
        expect(result.columns[3]).toMatchObject({ season: 'FALL', year: 2024 });
      }
    });

    it('keeps the user-typed seasonText on the form object even when overriding for compute', () => {
      const typed = 'My typed list';
      const effective = effectiveSeasonalForm({
        ...baseForm,
        seasonText: typed,
        seasonMode: 'all',
      });
      // The override applies only to the returned copy used for compute —
      // the caller's source-of-truth form (passed in) is untouched.
      expect(effective.seasonText).toBe('all');
      expect(baseForm.seasonText).toBe('Winter 2024');
      // And switching back to custom restores the typed text in the next call.
      const next = effectiveSeasonalForm({ ...baseForm, seasonText: typed });
      expect(next.seasonText).toBe(typed);
    });
  });

  describe('spanAiringSeasons', () => {
    const spanForm = {
      username: 'user',
      seasonText: 'Spring 2026\nSummer 2026',
      seasonMode: 'custom' as const,
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: false,
      spanAiringSeasons: true,
    };

    it('places cross-season shows in every overlapping column and counts both averages', () => {
      const shows: SeasonalShow[] = [
        {
          id: 1,
          title: 'ReZero S4',
          season: 'SPRING',
          seasonYear: 2026,
          startDate: { year: 2026, month: 4, day: 1 },
          endDate: { year: 2026, month: 8, day: 31 },
          score: 90,
          notes: null,
        },
      ];
      const result = buildSeasonalColumns(shows, spanForm);
      expect(result.kind).toBe('columns');
      if (result.kind !== 'columns') {
        return;
      }
      expect(result.columns.map((c) => c.label)).toEqual(['Spring 2026', 'Summer 2026']);
      expect(result.columns[0]?.shows.map((s) => s.title)).toEqual(['ReZero S4']);
      expect(result.columns[1]?.shows.map((s) => s.title)).toEqual(['ReZero S4']);
      expect(result.columns[0]?.average).toBe(90);
      expect(result.columns[1]?.average).toBe(90);
      expect(result.columns[0]?.shows[0]?.extendedPlacement).toBe(false);
      expect(result.columns[1]?.shows[0]?.extendedPlacement).toBe(true);
    });

    it('extends ongoing shows through today into each overlapped season', () => {
      const shows: SeasonalShow[] = [
        {
          id: 2,
          title: 'Mofusand',
          season: 'WINTER',
          seasonYear: 2026,
          startDate: { year: 2026, month: 1, day: 5 },
          endDate: null,
          score: 80,
          notes: null,
        },
      ];
      const june = buildSeasonalColumns(
        shows,
        {
          ...spanForm,
          seasonText: 'Winter 2026\nSpring 2026\nSummer 2026',
        },
        { now: new Date(2026, 5, 25) },
      );
      expect(june.kind).toBe('columns');
      if (june.kind === 'columns') {
        expect(june.columns.map((c) => c.label)).toEqual([
          'Winter 2026',
          'Spring 2026',
          'Summer 2026',
        ]);
        expect(june.columns[0]?.shows).toHaveLength(1);
        expect(june.columns[1]?.shows).toHaveLength(1);
        expect(june.columns[2]?.shows).toHaveLength(0);
        expect(june.columns[0]?.shows[0]?.extendedPlacement).toBe(false);
        expect(june.columns[1]?.shows[0]?.extendedPlacement).toBe(true);
      }

      const july = buildSeasonalColumns(
        shows,
        {
          ...spanForm,
          seasonText: 'Winter 2026\nSpring 2026\nSummer 2026',
        },
        { now: new Date(2026, 6, 15) },
      );
      expect(july.kind).toBe('columns');
      if (july.kind === 'columns') {
        expect(july.columns[2]?.shows.map((s) => s.title)).toEqual(['Mofusand']);
      }
    });

    it('falls back to season tag when airing dates are missing', () => {
      const shows: SeasonalShow[] = [
        {
          id: 3,
          title: 'Tagged only',
          season: 'WINTER',
          seasonYear: 2024,
          score: 70,
          notes: null,
        },
      ];
      const result = buildSeasonalColumns(
        shows,
        { ...spanForm, seasonText: 'Winter 2024\nSpring 2024', spanAiringSeasons: true },
      );
      expect(result.kind).toBe('columns');
      if (result.kind === 'columns') {
        expect(result.columns[0]?.shows).toHaveLength(1);
        expect(result.columns[1]?.shows).toHaveLength(0);
      }
    });

    it('with toggle off, cross-season dates still use season tag only', () => {
      const shows: SeasonalShow[] = [
        {
          id: 4,
          title: 'ReZero S4',
          season: 'SPRING',
          seasonYear: 2026,
          startDate: { year: 2026, month: 4, day: 1 },
          endDate: { year: 2026, month: 8, day: 31 },
          score: 90,
          notes: null,
        },
      ];
      const result = buildSeasonalColumns(shows, {
        ...spanForm,
        spanAiringSeasons: false,
      });
      expect(result.kind).toBe('columns');
      if (result.kind === 'columns') {
        expect(result.columns[0]?.shows).toHaveLength(1);
        expect(result.columns[1]?.shows).toHaveLength(0);
      }
    });

    it('year columns use calendar-year overlap', () => {
      const shows: SeasonalShow[] = [
        {
          id: 5,
          title: 'Cross-year',
          season: 'WINTER',
          seasonYear: 2026,
          startDate: { year: 2025, month: 12, day: 1 },
          endDate: { year: 2026, month: 2, day: 28 },
          score: 85,
          notes: null,
        },
      ];
      const result = buildSeasonalColumns(
        shows,
        { ...spanForm, seasonText: '2025\n2026', spanAiringSeasons: true },
      );
      expect(result.kind).toBe('columns');
      if (result.kind === 'columns') {
        expect(result.columns[0]?.shows.map((s) => s.title)).toEqual(['Cross-year']);
        expect(result.columns[1]?.shows.map((s) => s.title)).toEqual(['Cross-year']);
        expect(result.columns[0]?.shows[0]?.extendedPlacement).toBe(true);
        expect(result.columns[1]?.shows[0]?.extendedPlacement).toBe(false);
      }
    });

    it('clamps starts in the final 10 days of a season but not the 11th day', () => {
      expect(
        clampAiringIntervalSeasonBoundaries({
          start: 20240322,
          end: 20240615,
        }),
      ).toEqual({
        start: 20240401,
        end: 20240615,
      });
      expect(
        clampAiringIntervalSeasonBoundaries({
          start: 20240321,
          end: 20240615,
        }),
      ).toEqual({
        start: 20240321,
        end: 20240615,
      });
    });

    it('clamps ends in the first 10 days of a season but not the 11th day', () => {
      expect(
        clampAiringIntervalSeasonBoundaries({
          start: 20240105,
          end: 20240410,
        }),
      ).toEqual({
        start: 20240105,
        end: 20240331,
      });
      expect(
        clampAiringIntervalSeasonBoundaries({
          start: 20240105,
          end: 20240411,
        }),
      ).toEqual({
        start: 20240105,
        end: 20240411,
      });
    });

    it('does not leak across season overflow windows (late winter start / early spring end)', () => {
      const shows: SeasonalShow[] = [
        {
          id: 10,
          title: 'Shunkashuutou Daikousha',
          season: 'SPRING',
          seasonYear: 2024,
          startDate: { year: 2024, month: 3, day: 29 },
          endDate: { year: 2024, month: 6, day: 15 },
          score: 85,
          notes: null,
        },
        {
          id: 11,
          title: 'Darwin Jihen',
          season: 'WINTER',
          seasonYear: 2024,
          startDate: { year: 2024, month: 1, day: 5 },
          endDate: { year: 2024, month: 4, day: 1 },
          score: 75,
          notes: null,
        },
      ];
      const result = buildSeasonalColumns(
        shows,
        {
          ...spanForm,
          seasonText: 'Winter 2024\nSpring 2024',
        },
      );
      expect(result.kind).toBe('columns');
      if (result.kind !== 'columns') {
        return;
      }
      const winter = result.columns.find((c) => c.label === 'Winter 2024');
      const spring = result.columns.find((c) => c.label === 'Spring 2024');
      expect(winter?.shows.map((s) => s.title)).toEqual(['Darwin Jihen']);
      expect(spring?.shows.map((s) => s.title)).toEqual(['Shunkashuutou Daikousha']);
    });

    it('does not fade when dates place a show only outside its AniList season tag', () => {
      const shows: SeasonalShow[] = [
        {
          id: 12,
          title: 'Ray Chou Kaguya Hime',
          season: 'SPRING',
          seasonYear: 2026,
          startDate: { year: 2026, month: 1, day: 10 },
          endDate: { year: 2026, month: 3, day: 15 },
          score: 82,
          notes: null,
        },
      ];
      const result = buildSeasonalColumns(
        shows,
        { ...spanForm, seasonText: 'Winter 2026\nSpring 2026' },
      );
      expect(result.kind).toBe('columns');
      if (result.kind === 'columns') {
        const winter = result.columns.find((c) => c.label === 'Winter 2026');
        const spring = result.columns.find((c) => c.label === 'Spring 2026');
        expect(winter?.shows.map((s) => s.title)).toEqual(['Ray Chou Kaguya Hime']);
        expect(spring?.shows).toHaveLength(0);
        expect(winter?.shows[0]?.extendedPlacement).toBe(false);
      }
    });
  });
});
