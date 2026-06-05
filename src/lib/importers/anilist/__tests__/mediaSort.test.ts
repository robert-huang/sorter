import { describe, expect, it } from 'vitest';
import { compareMediaByReleaseDateDesc, mediaReleaseSortKey } from '../mediaSort';
import type { MediaRow } from '../types';

function media(partial: Partial<MediaRow> & Pick<MediaRow, 'id'>): MediaRow {
  return {
    id: partial.id,
    type: 'ANIME',
    title_english: null,
    title_romaji: null,
    title_native: null,
    cover_image: null,
    format: null,
    status: null,
    episodes: null,
    chapters: null,
    start_year: partial.start_year ?? null,
    start_month: partial.start_month ?? null,
    start_day: partial.start_day ?? null,
    end_year: null,
    end_month: null,
    end_day: null,
    season: null,
    season_year: partial.season_year ?? null,
    mean_score: null,
    favourites: null,
    country_of_origin: null,
    genres_json: null,
    synonyms_json: null,
    fetched_at: 0,
    updated_at: 0,
  };
}

describe('mediaSort', () => {
  it('mediaReleaseSortKey prefers start date over season year', () => {
    expect(mediaReleaseSortKey(media({ id: 1, start_year: 2020, season_year: 2010 }))).toBeGreaterThan(
      mediaReleaseSortKey(media({ id: 2, season_year: 2015 })),
    );
  });

  it('compareMediaByReleaseDateDesc sorts newest first', () => {
    const older = media({ id: 1, start_year: 2010 });
    const newer = media({ id: 2, start_year: 2020 });
    expect(compareMediaByReleaseDateDesc(older, newer)).toBeGreaterThan(0);
    expect(compareMediaByReleaseDateDesc(newer, older)).toBeLessThan(0);
  });
});
