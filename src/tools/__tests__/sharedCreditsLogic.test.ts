import { describe, expect, it } from 'vitest';
import {
  buildSharedCreditsResult,
  filterMainRoles,
  formatStartDateKey,
  type StaffRoleEntry,
} from '../panels/sharedCreditsLogic';

function role(label: string, characterId?: number): StaffRoleEntry {
  return characterId != null ? { label, characterId } : { label };
}

function staffNameFields(
  names: Record<number, string>,
): Record<number, { id: number; name_full: string; name_native: null; image: null }> {
  return Object.fromEntries(
    Object.entries(names).map(([id, name]) => [
      Number(id),
      { id: Number(id), name_full: name, name_native: null, image: null },
    ]),
  );
}

describe('sharedCreditsLogic', () => {
  const staffA = {
    '1': {
      title: 'Show A',
      coverImage: null,
      roles: [role('Alice (MAIN)', 100)],
      startDate: '20200101',
    },
    '2': {
      title: 'Show B',
      coverImage: null,
      roles: [role('Bob (SUPPORTING)', 101)],
      startDate: '20190101',
    },
  };
  const staffB = {
    '1': {
      title: 'Show A',
      coverImage: null,
      roles: [role('Carol (MAIN)', 102)],
      startDate: '20200101',
    },
    '3': {
      title: 'Show C',
      coverImage: null,
      roles: [role('Dave (MAIN)', 103)],
      startDate: '20210101',
    },
  };

  it('formatStartDateKey pads missing parts', () => {
    expect(formatStartDateKey({ year: 2020, month: 3, day: 5 })).toBe('20200305');
    expect(formatStartDateKey({})).toBe('99999999');
  });

  it('filterMainRoles keeps only MAIN-tagged roles', () => {
    const filtered = filterMainRoles(staffA);
    expect(filtered['1']?.roles).toEqual([role('Alice (MAIN)', 100)]);
    expect(filtered['2']).toBeUndefined();
  });

  it('buildSharedCreditsResult returns one row per shared show without cross-column alignment', () => {
    const result = buildSharedCreditsResult(
      [10, 20],
      staffNameFields({ 10: 'VA A', 20: 'VA B' }),
      [staffA, staffB],
      {
        minMatches: null,
        mainRoleOnly: false,
        diffMode: false,
        oldestFirst: false,
      },
      null,
      null,
    );

    expect(result.kind).toBe('table');
    if (result.kind !== 'table') {
      return;
    }
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.title).toBe('Show A');
    expect(result.rows[0]?.cells).toEqual([
      [role('Alice (MAIN)', 100)],
      [role('Carol (MAIN)', 102)],
    ]);
  });

  it('buildSharedCreditsResult keeps each staff column independent when roles differ', () => {
    const multiRoleA = {
      '1': {
        title: 'Show A',
        coverImage: null,
        roles: [role('Alice (MAIN)', 100), role('Bob (SUPPORTING)', 101)],
        startDate: '20200101',
      },
    };
    const multiRoleB = {
      '1': {
        title: 'Show A',
        coverImage: null,
        roles: [role('Bob (SUPPORTING)', 101)],
        startDate: '20200101',
      },
    };
    const result = buildSharedCreditsResult(
      [10, 20],
      staffNameFields({ 10: 'VA A', 20: 'VA B' }),
      [multiRoleA, multiRoleB],
      {
        minMatches: null,
        mainRoleOnly: false,
        diffMode: false,
        oldestFirst: false,
      },
      null,
      null,
    );

    expect(result.kind).toBe('table');
    if (result.kind !== 'table') {
      return;
    }
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.cells).toEqual([
      [role('Alice (MAIN)', 100), role('Bob (SUPPORTING)', 101)],
      [role('Bob (SUPPORTING)', 101)],
    ]);
  });

  it('buildSharedCreditsResult supports diff mode', () => {
    const result = buildSharedCreditsResult(
      [10, 20],
      staffNameFields({ 10: 'VA A', 20: 'VA B' }),
      [staffA, staffB],
      {
        minMatches: null,
        mainRoleOnly: false,
        diffMode: true,
        oldestFirst: false,
      },
      null,
      null,
    );

    expect(result.kind).toBe('diff');
    if (result.kind !== 'diff') {
      return;
    }
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]?.shows[0]?.mediaId).toBe(2);
    expect(result.blocks[1]?.shows[0]?.mediaId).toBe(3);
  });

  it('buildSharedCreditsResult filters by username include set', () => {
    const result = buildSharedCreditsResult(
      [10, 20],
      staffNameFields({ 10: 'VA A', 20: 'VA B' }),
      [staffA, staffB],
      {
        minMatches: null,
        mainRoleOnly: false,
        diffMode: false,
        oldestFirst: false,
      },
      new Set(['1']),
      'include',
    );

    expect(result.kind).toBe('table');
    if (result.kind !== 'table') {
      return;
    }
    expect(result.rows.every((r) => r.mediaId === 1)).toBe(true);
  });
});
