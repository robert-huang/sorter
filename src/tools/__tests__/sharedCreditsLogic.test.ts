import { describe, expect, it } from 'vitest';
import {
  buildSharedCreditsResult,
  filterMainRoles,
  formatStartDateKey,
} from '../panels/sharedCreditsLogic';

describe('sharedCreditsLogic', () => {
  const staffA = {
    '1': { title: 'Show A', roles: ['Alice (MAIN)'], startDate: '20200101' },
    '2': { title: 'Show B', roles: ['Bob (SUPPORTING)'], startDate: '20190101' },
  };
  const staffB = {
    '1': { title: 'Show A', roles: ['Carol (MAIN)'], startDate: '20200101' },
    '3': { title: 'Show C', roles: ['Dave (MAIN)'], startDate: '20210101' },
  };

  it('formatStartDateKey pads missing parts', () => {
    expect(formatStartDateKey({ year: 2020, month: 3, day: 5 })).toBe('20200305');
    expect(formatStartDateKey({})).toBe('99999999');
  });

  it('filterMainRoles keeps only MAIN-tagged roles', () => {
    const filtered = filterMainRoles(staffA);
    expect(filtered['1']?.roles).toEqual(['Alice (MAIN)']);
    expect(filtered['2']).toBeUndefined();
  });

  it('buildSharedCreditsResult returns intersection table sorted newest first', () => {
    const result = buildSharedCreditsResult(
      [10, 20],
      { 10: 'VA A', 20: 'VA B' },
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
    expect(result.rows[0]?.title).toBe('Show A');
    expect(result.rows[0]?.cells).toEqual(['Alice (MAIN)', 'Carol (MAIN)']);
  });

  it('buildSharedCreditsResult supports diff mode', () => {
    const result = buildSharedCreditsResult(
      [10, 20],
      { 10: 'VA A', 20: 'VA B' },
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
      { 10: 'VA A', 20: 'VA B' },
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
    expect(result.rows.every((r) => r.mediaId === 1 || r.title === '')).toBe(true);
  });
});
