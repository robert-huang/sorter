import { describe, expect, it } from 'vitest';
import type { VaCreditRow } from '../../lib/importers/anilist/graphQueries';
import {
  vaCreditListImage,
  vaCreditStaffName,
  vaCreditSubtitle,
} from '../vaCreditDisplay';

function row(partial: Partial<VaCreditRow> & Pick<VaCreditRow, 'staff' | 'character'>): VaCreditRow {
  return {
    characterRole: null,
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
});
