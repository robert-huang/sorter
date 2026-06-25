import { describe, expect, it } from 'vitest';
import { anilistUrlForSeasonSearch } from '../anilistLinks';

describe('anilistUrlForSeasonSearch', () => {
  it('builds a year+season URL with "only show my anime" pre-checked', () => {
    expect(anilistUrlForSeasonSearch('FALL', 2020)).toBe(
      'https://anilist.co/search/anime?year=2020&season=FALL&only%20show%20my%20anime=true',
    );
  });

  it('omits season when null (full-year column from `all`)', () => {
    expect(anilistUrlForSeasonSearch(null, 2020)).toBe(
      'https://anilist.co/search/anime?year=2020&only%20show%20my%20anime=true',
    );
  });

  it('upper-cases the season token (handles `allseasons` lowercase output)', () => {
    expect(anilistUrlForSeasonSearch('winter', 2024)).toContain('season=WINTER');
  });

  it('uses %20 (not +) for spaces in the toggle key so AniList parses it', () => {
    const url = anilistUrlForSeasonSearch(null, 2024);
    expect(url).toContain('only%20show%20my%20anime=true');
    expect(url).not.toContain('+');
  });
});
