import { describe, expect, it } from 'vitest';
import {
  buildSeasonalColumns,
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
    });
    expect(result.kind).toBe('columns');
    if (result.kind !== 'columns') {
      return;
    }
    const winter = result.columns.find((c) => c.label === 'Winter 2024');
    expect(winter?.average).toBe(85);
    expect(winter?.shows.map((s) => s.title)).toEqual(['Winter A', 'Winter B']);
  });
});
