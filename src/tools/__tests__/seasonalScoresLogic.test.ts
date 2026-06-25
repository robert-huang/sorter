import { describe, expect, it } from 'vitest';
import {
  averageScore,
  buildSeasonalColumns,
  formatSeasonColumnLabel,
  formatSeasonalScoreLabel,
  normalizeSeasonalListScore,
  parseSeasonLine,
  parseSeasonSpecs,
  type SeasonalShow,
} from '../panels/seasonalScoresLogic';

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
    expect(formatSeasonalScoreLabel(85, 'PLANNING')).toBe('P');
    expect(formatSeasonalScoreLabel(null, 'PLANNING')).toBe('P');
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

  it('includes planning shows with P label and excludes them from average', () => {
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
        score: 90,
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
    });
    expect(result.kind).toBe('columns');
    if (result.kind === 'columns') {
      expect(result.columns[0]?.shows).toHaveLength(1);
      expect(result.columns[0]?.shows[0]?.title).toBe('Scored');
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

  it('skipEmpty drops columns with no matching shows', () => {
    const result = buildSeasonalColumns(sampleShows, {
      username: 'user',
      seasonText: 'Winter 2024\nFall 2099',
      skipEmpty: true,
      airingNotesOnly: false,
      includePlanning: false,
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
    });
    expect(result.kind).toBe('columns');
    if (result.kind === 'columns') {
      expect(result.columns[0]?.average).toBeNull();
      expect(result.columns[0]?.ratedCount).toBe(0);
      expect(result.columns[0]?.shows).toHaveLength(2);
    }
  });

  it('all-planning column returns null average and zero ratedCount but keeps the shows visible', () => {
    const shows: SeasonalShow[] = [
      { id: 1, title: 'P1', season: 'WINTER', seasonYear: 2024, score: 90, notes: null, listStatus: 'PLANNING' },
      { id: 2, title: 'P2', season: 'WINTER', seasonYear: 2024, score: 70, notes: null, listStatus: 'PLANNING' },
    ];
    const result = buildSeasonalColumns(shows, {
      username: 'user',
      seasonText: 'Winter 2024',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: true,
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
    });
    expect(result.kind).toBe('columns');
    if (result.kind === 'columns') {
      expect(result.columns[0]?.shows.map((s) => s.title)).toEqual(['B']);
    }
  });

  it('sorts within a column: scored descending, planning pinned to the bottom, unrated below scored', () => {
    const shows: SeasonalShow[] = [
      { id: 1, title: 'Low',      season: 'WINTER', seasonYear: 2024, score: 60,   notes: null },
      { id: 2, title: 'Planning', season: 'WINTER', seasonYear: 2024, score: 99,   notes: null, listStatus: 'PLANNING' },
      { id: 3, title: 'High',     season: 'WINTER', seasonYear: 2024, score: 90,   notes: null },
      { id: 4, title: 'Unrated',  season: 'WINTER', seasonYear: 2024, score: null, notes: null },
    ];
    const result = buildSeasonalColumns(shows, {
      username: 'user',
      seasonText: 'Winter 2024',
      skipEmpty: false,
      airingNotesOnly: false,
      includePlanning: true,
    });
    expect(result.kind).toBe('columns');
    if (result.kind === 'columns') {
      // High (90) → Low (60) → Unrated (0) → Planning (-1)
      expect(result.columns[0]?.shows.map((s) => s.title)).toEqual([
        'High',
        'Low',
        'Unrated',
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
    });
    expect(result.kind).toBe('empty');
  });
});
