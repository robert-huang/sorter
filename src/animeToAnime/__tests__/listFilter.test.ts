import { describe, expect, it } from 'vitest';
import type { AnimeFilmographyRow, VaCreditRow } from '../../lib/importers/anilist/graphQueries';
import {
  filmographyFilterParts,
  groupedVaCreditFilterParts,
  matchesListFilter,
  productionCreditFilterParts,
} from '../listFilter';
import { groupSortedVaCredits } from '../vaCreditDisplay';

function makeStaff(id: number, name: string) {
  return {
    id,
    name_full: name,
    name_native: null,
    image: null,
    age: null,
    gender: null,
    language_v2: null,
    favourites: null,
    fetched_at: 0,
    updated_at: 0,
  };
}

function makeCharacter(id: number, name: string) {
  return {
    id,
    name_full: name,
    name_native: null,
    name_alternatives_json: null,
    name_alternatives_spoiler_json: null,
    image: null,
    age: null,
    gender: null,
    favourites: null,
    birth_year: null,
    birth_month: null,
    birth_day: null,
    fetched_at: 0,
    updated_at: 0,
  };
}

function makeVaCredit(
  staffId: number,
  staffName: string,
  characterId: number,
  characterName: string,
  role: 'MAIN' | 'SUPPORTING',
): VaCreditRow {
  return {
    staff: makeStaff(staffId, staffName),
    character: makeCharacter(characterId, characterName),
    characterRole: role,
    characterSortOrder: 0,
  };
}

describe('matchesListFilter', () => {
  it('matches every stored title variant and role strings', () => {
    const row: AnimeFilmographyRow = {
      media: {
        id: 1,
        type: 'ANIME',
        title_romaji: 'Yuru Yuri',
        title_english: 'YuruYuri',
        title_native: 'ゆるゆり',
        cover_image: null,
        format: null,
        status: null,
        episodes: null,
        chapters: null,
        start_year: null,
        start_month: null,
        start_day: null,
        end_year: null,
        end_month: null,
        end_day: null,
        season: null,
        season_year: null,
        mean_score: null,
        favourites: null,
        country_of_origin: null,
        genres_json: null,
        synonyms_json: null,
        fetched_at: 0,
        updated_at: 0,
      },
      creditKind: 'voice',
      roles: ['Yui Funami (MAIN)'],
    };

    expect(matchesListFilter(filmographyFilterParts(row), 'yuru')).toBe(true);
    expect(matchesListFilter(filmographyFilterParts(row), 'yuruyuri')).toBe(true);
    expect(matchesListFilter(filmographyFilterParts(row), 'ゆる')).toBe(true);
    expect(matchesListFilter(filmographyFilterParts(row), 'as yui')).toBe(true);
    expect(matchesListFilter(filmographyFilterParts(row), 'fire force')).toBe(false);
  });

  it('matches non-displayed name variants when filtering grouped VA rows', () => {
    const credits = [
      {
        ...makeVaCredit(1, 'Aoi Yuuki', 10, 'Yui Funami', 'MAIN'),
        staff: { ...makeStaff(1, 'Aoi Yuuki'), name_native: '悠木碧' },
        character: { ...makeCharacter(10, 'Yui Funami'), name_native: '船見結衣' },
      },
    ];
    const grouped = groupSortedVaCredits(credits);
    const aoiGroup = grouped[0];

    expect(matchesListFilter(groupedVaCreditFilterParts(aoiGroup), 'yui')).toBe(true);
    expect(matchesListFilter(groupedVaCreditFilterParts(aoiGroup), '悠木')).toBe(true);
    expect(matchesListFilter(groupedVaCreditFilterParts(aoiGroup), '船見')).toBe(true);
  });
});

describe('groupSortedVaCredits', () => {
  it('merges multiple characters for the same voice actor', () => {
    const credits = [
      makeVaCredit(1, 'Aoi Yuuki', 10, 'Main Role', 'MAIN'),
      makeVaCredit(1, 'Aoi Yuuki', 11, 'Second Role', 'SUPPORTING'),
    ];

    const grouped = groupSortedVaCredits(credits);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].credits).toHaveLength(2);
    expect(groupedVaCreditFilterParts(grouped[0])).toEqual(
      expect.arrayContaining([
        'Aoi Yuuki',
        'Main Role',
        'Second Role',
        'as Main Role (MAIN), Second Role (SUPPORTING)',
      ]),
    );
  });
});

describe('productionCreditFilterParts', () => {
  it('includes all displayed production roles for grouped staff', () => {
    const row = {
      staff: makeStaff(1, 'Yoshihiko Umakoshi'),
      roles: ['Animation Director', 'Character Design'],
    };

    expect(productionCreditFilterParts(row)).toEqual([
      'Yoshihiko Umakoshi',
      'Animation Director',
      'Character Design',
    ]);
    expect(matchesListFilter(productionCreditFilterParts(row), 'character design')).toBe(true);
  });
});
