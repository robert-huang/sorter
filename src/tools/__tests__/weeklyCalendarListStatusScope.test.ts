import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEEKLY_CALENDAR_FORM,
  describeWeeklyCalendarFilters,
  activeWeeklyListStatusFilters,
  finalizeWeeklyCalendarResult,
  toggleWeeklyListStatusFilter,
  WEEKLY_CALENDAR_NOT_ON_LIST_FILTER,
  weeklyCalendarListStatusOptions,
  type WeeklyCalendarForm,
  type WeeklyCalendarRawEntry,
} from '../panels/weeklyCalendarLogic';

const NOT_ON_LIST = WEEKLY_CALENDAR_NOT_ON_LIST_FILTER;

function form(patch: Partial<WeeklyCalendarForm>): WeeklyCalendarForm {
  return { ...DEFAULT_WEEKLY_CALENDAR_FORM, username: 'robert', ...patch };
}

function raw(id: number, listStatus: string | null): WeeklyCalendarRawEntry {
  return {
    id,
    title: `Show ${id}`,
    coverImage: null,
    format: 'TV',
    score: null,
    listStatus,
    progress: 0,
    totalEpisodes: null,
    popularity: 0,
    mediaStatus: 'RELEASING',
    startDate: null,
    endDate: null,
    nextAiringAt: 1704153600,
    airedCount: null,
    weekdayJs: null,
    airingTimeMinutes: null,
    inferredWeekday: false,
    pastAiringAts: [],
  } as WeeklyCalendarRawEntry;
}

describe('NOT ON LIST and the watching list', () => {
  it('is offered when browsing a season but not on the watching list', () => {
    expect(weeklyCalendarListStatusOptions('watching')).not.toContain(NOT_ON_LIST);
    for (const scope of ['previous', 'current', 'next', 'custom'] as const) {
      expect(weeklyCalendarListStatusOptions(scope)).toContain(NOT_ON_LIST);
    }
  });

  it('offers DROPPED on both scopes, off by default, and dropped rows are not NOT ON LIST', () => {
    expect(weeklyCalendarListStatusOptions('watching')).toContain('DROPPED');
    expect(weeklyCalendarListStatusOptions('current')).toContain('DROPPED');
    const rows = [raw(1, 'DROPPED')];
    const season = form({ seasonScope: 'current', listStatusFilters: [NOT_ON_LIST] });
    expect(finalizeWeeklyCalendarResult(rows, season, 'Fall 2026').kind).toBe('empty');
    expect(
      finalizeWeeklyCalendarResult(rows, { ...season, listStatusFilters: ['DROPPED'] }, 'Fall 2026').kind,
    ).toBe('columns');
    expect(finalizeWeeklyCalendarResult(rows, form({ seasonScope: 'watching' }), null).kind).toBe('empty');
  });

  it('the watching list and the season tabs each use their own set', () => {
    const f = form({ listStatusFilters: ['PLANNING', NOT_ON_LIST], watchingListStatusFilters: ['PAUSED'] });
    expect(activeWeeklyListStatusFilters({ ...f, seasonScope: 'watching' })).toEqual(['PAUSED']);
    expect(activeWeeklyListStatusFilters({ ...f, seasonScope: 'current' })).toEqual(['PLANNING', NOT_ON_LIST]);
  });

  it('filters rows with the set for the current scope', () => {
    const f = form({ listStatusFilters: [NOT_ON_LIST], watchingListStatusFilters: ['CURRENT'] });
    const rows = [raw(1, 'CURRENT')];
    expect(finalizeWeeklyCalendarResult(rows, { ...f, seasonScope: 'watching' }, null).kind).toBe('columns');
    expect(finalizeWeeklyCalendarResult(rows, { ...f, seasonScope: 'current' }, 'Fall 2026').kind).toBe('empty');
  });

  it('toggling on the watching list only changes the watching set', () => {
    const f = form({ seasonScope: 'watching', listStatusFilters: ['CURRENT'], watchingListStatusFilters: ['CURRENT'] });
    expect(toggleWeeklyListStatusFilter(f, 'PLANNING')).toEqual({ watchingListStatusFilters: ['CURRENT', 'PLANNING'] });
    expect(toggleWeeklyListStatusFilter(f, 'CURRENT')).toEqual({ watchingListStatusFilters: [] });
    expect(toggleWeeklyListStatusFilter(f, NOT_ON_LIST)).toEqual({});
  });

  it('toggling while browsing a season only changes the season set', () => {
    const f = form({ seasonScope: 'current', listStatusFilters: ['CURRENT'] });
    expect(toggleWeeklyListStatusFilter(f, NOT_ON_LIST)).toEqual({ listStatusFilters: ['CURRENT', NOT_ON_LIST] });
    expect(toggleWeeklyListStatusFilter(f, 'CURRENT')).toEqual({ listStatusFilters: [] });
  });

  it('the playlist description lists the set for the current scope', () => {
    const text = describeWeeklyCalendarFilters(
      form({ seasonScope: 'watching', listStatusFilters: ['PLANNING', NOT_ON_LIST], watchingListStatusFilters: ['CURRENT'] }),
      null,
    );
    expect(text).toContain('list: current');
    expect(text.toLowerCase()).not.toContain('not on list');
  });
});
