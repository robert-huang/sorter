import { describe, expect, it } from 'vitest';
import type { VaCreditRow } from '../../lib/importers/anilist/graphQueries';
import {
  compareVaCredits,
  sortVaCredits,
  vaCreditListImage,
  vaCreditStaffName,
  vaCreditSubtitle,
} from '../vaCreditDisplay';

function row(partial: Partial<VaCreditRow> & Pick<VaCreditRow, 'staff' | 'character'>): VaCreditRow {
  return {
    characterRole: null,
    characterSortOrder: 0,
    ...partial,
  };
}

describe('vaCreditDisplay', () => {
  it('vaCreditSubtitle shows character name when it differs from staff', () => {
    const subtitle = vaCreditSubtitle(
      row({
        staff: {
          id: 1,
          name_full: 'VA Name',
          name_native: null,
          image: null,
          age: null,
          gender: null,
          language_v2: null,
          favourites: null,
          fetched_at: 0,
          updated_at: 0,
        },
        character: {
          id: 2,
          name_full: 'Char Name',
          name_native: null,
          name_alternatives_json: null,
          name_alternatives_spoiler_json: null,
          image: null,
          age: null,
          gender: null,
          favourites: null,
          fetched_at: 0,
          updated_at: 0,
        },
      }),
    );
    expect(vaCreditStaffName).toBeDefined();
    expect(subtitle).toBe('as Char Name');
  });

  it('vaCreditListImage respects mode', () => {
    const credit = row({
      staff: {
        id: 1,
        name_full: 'VA',
        name_native: null,
        image: 'https://example.com/va.jpg',
        age: null,
        gender: null,
        language_v2: null,
        favourites: null,
        fetched_at: 0,
        updated_at: 0,
      },
      character: {
        id: 2,
        name_full: 'Char',
        name_native: null,
        name_alternatives_json: null,
        name_alternatives_spoiler_json: null,
        image: 'https://example.com/char.jpg',
        age: null,
        gender: null,
        favourites: null,
        fetched_at: 0,
        updated_at: 0,
      },
    });
    expect(vaCreditListImage(credit, 'staff')).toBe('https://example.com/va.jpg');
    expect(vaCreditListImage(credit, 'character')).toBe('https://example.com/char.jpg');
  });

  it('compareVaCredits orders MAIN before SUPPORTING before BACKGROUND', () => {
    const staff = row({
      staff: {
        id: 1,
        name_full: 'Same VA',
        name_native: null,
        image: null,
        age: null,
        gender: null,
        language_v2: null,
        favourites: null,
        fetched_at: 0,
        updated_at: 0,
      },
      character: {
        id: 1,
        name_full: 'A',
        name_native: null,
        name_alternatives_json: null,
        name_alternatives_spoiler_json: null,
        image: null,
        age: null,
        gender: null,
        favourites: null,
        fetched_at: 0,
        updated_at: 0,
      },
    });
    const main = { ...staff, characterRole: 'MAIN' as const, characterSortOrder: 5 };
    const supporting = {
      ...staff,
      character: { ...staff.character, id: 2, name_full: 'B' },
      characterRole: 'SUPPORTING' as const,
      characterSortOrder: 0,
    };
    const background = {
      ...staff,
      character: { ...staff.character, id: 3, name_full: 'C' },
      characterRole: 'BACKGROUND' as const,
      characterSortOrder: 0,
    };
    expect(sortVaCredits([background, supporting, main]).map((r) => r.characterRole)).toEqual([
      'MAIN',
      'SUPPORTING',
      'BACKGROUND',
    ]);
    expect(compareVaCredits(main, supporting)).toBeLessThan(0);
  });
});
