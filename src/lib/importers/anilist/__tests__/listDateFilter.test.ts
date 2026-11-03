import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIST_DATE_FILTER,
  encodeListMonth,
  formatListMonth,
  listDateOptions,
  listDatePasses,
  listDatesPassForUsers,
  listEntryDatesFromMal,
  normalizeListDateFilter,
  parseListMonth,
  type ListDateFilterState,
  type ListEntryDates,
} from '../listDateFilter';

const dates = (
  startedYear: number | null,
  startedMonth: number | null,
  completedYear: number | null,
  completedMonth: number | null,
): ListEntryDates => ({ startedYear, startedMonth, completedYear, completedMonth });

const range = (
  listDateField: ListDateFilterState['listDateField'],
  min: [number, number] | null,
  max: [number, number] | null,
): ListDateFilterState => ({
  listDateField,
  listDateMin: min ? encodeListMonth(min[0], min[1]) : null,
  listDateMax: max ? encodeListMonth(max[0], max[1]) : null,
});

const year2023 = (field: ListDateFilterState['listDateField']) => range(field, [2023, 1], [2023, 12]);

describe('listDatePasses', () => {
  it('passes everything, including undated entries, when no range is set', () => {
    expect(listDatePasses(dates(null, null, null, null), DEFAULT_LIST_DATE_FILTER)).toBe(true);
    expect(listDatePasses(null, DEFAULT_LIST_DATE_FILTER)).toBe(true);
  });

  it('hides undated entries once a range is set', () => {
    expect(listDatePasses(dates(null, null, null, null), year2023('active'))).toBe(false);
    expect(listDatePasses(null, year2023('started'))).toBe(false);
    expect(listDatePasses(dates(null, null, 2023, 2), year2023('active'))).toBe(false);
  });

  it('active passes an entry that spans the whole range', () => {
    expect(listDatePasses(dates(2022, 12, 2024, 3), year2023('active'))).toBe(true);
  });

  it('active treats a missing completion as ongoing', () => {
    expect(listDatePasses(dates(2021, 5, null, null), year2023('active'))).toBe(true);
    expect(listDatePasses(dates(2024, 2, null, null), year2023('active'))).toBe(false);
  });

  it('active rejects entries finished before or started after the range', () => {
    expect(listDatePasses(dates(2021, 1, 2021, 3), year2023('active'))).toBe(false);
    expect(listDatePasses(dates(2024, 1, 2024, 2), year2023('active'))).toBe(false);
  });

  it('started and completed check only their own date', () => {
    const entry = dates(2022, 12, 2023, 7);
    expect(listDatePasses(entry, year2023('started'))).toBe(false);
    expect(listDatePasses(entry, year2023('completed'))).toBe(true);
  });

  it('a year-only date spans the whole year', () => {
    const march = range('started', [2023, 3], [2023, 3]);
    expect(listDatePasses(dates(2023, null, null, null), march)).toBe(true);
    // Year-only start counts from January; year-only completion runs to December.
    expect(listDatePasses(dates(2023, null, 2023, null), range('active', [2023, 12], [2023, 12]))).toBe(true);
    expect(listDatePasses(dates(2023, null, 2023, null), range('active', [2024, 1], null))).toBe(false);
  });

  it('a null bound is open-ended', () => {
    expect(listDatePasses(dates(2010, 1, 2010, 2), range('completed', null, [2015, 1]))).toBe(true);
    expect(listDatePasses(dates(2010, 1, 2010, 2), range('completed', [2015, 1], null))).toBe(false);
  });
});

describe('listDatesPassForUsers', () => {
  const inRange = dates(2023, 4, 2023, 6);
  const outOfRange = dates(2020, 1, 2020, 2);

  it('any passes when one user matches; all needs every user', () => {
    expect(listDatesPassForUsers([inRange, outOfRange], year2023('active'), 'any')).toBe(true);
    expect(listDatesPassForUsers([inRange, outOfRange], year2023('active'), 'all')).toBe(false);
    expect(listDatesPassForUsers([inRange, inRange], year2023('active'), 'all')).toBe(true);
  });

  it('passes everything when no range is set', () => {
    expect(listDatesPassForUsers([], DEFAULT_LIST_DATE_FILTER, 'all')).toBe(true);
  });
});

describe('listDateOptions', () => {
  const entries = [dates(2023, 4, 2023, 6), dates(2021, null, null, null), null];

  it('uses only the chosen date for started / completed', () => {
    expect(listDateOptions(entries, 'started').map(formatListMonth)).toEqual(['January 2021', 'April 2023']);
    expect(listDateOptions(entries, 'completed').map(formatListMonth)).toEqual(['June 2023']);
  });

  it('active unions both dates and adds the current month when something is ongoing', () => {
    expect(listDateOptions(entries, 'active', new Date(2025, 9, 15)).map(formatListMonth)).toEqual([
      'January 2021',
      'April 2023',
      'June 2023',
      'October 2025',
    ]);
  });
});

describe('parsing helpers', () => {
  it('parseListMonth reads YYYYMM, YYYY/MM, YYYY-MM, YYYY and blanks', () => {
    expect(parseListMonth('202304', 'start')).toBe(encodeListMonth(2023, 4));
    expect(parseListMonth('2023/04', 'start')).toBe(encodeListMonth(2023, 4));
    expect(parseListMonth('2023-04', 'start')).toBe(encodeListMonth(2023, 4));
    expect(parseListMonth('2023', 'start')).toBe(encodeListMonth(2023, 1));
    expect(parseListMonth('2023', 'end')).toBe(encodeListMonth(2023, 12));
    expect(parseListMonth('', 'start')).toBeNull();
    expect(parseListMonth('2023-13', 'start')).toBeUndefined();
    expect(parseListMonth('april', 'start')).toBeUndefined();
  });

  it('listEntryDatesFromMal reads partial MAL dates', () => {
    expect(listEntryDatesFromMal('2023-04-02', '2024')).toEqual(dates(2023, 4, 2024, null));
    expect(listEntryDatesFromMal(undefined, '')).toEqual(dates(null, null, null, null));
  });

  it('normalizeListDateFilter falls back to defaults', () => {
    expect(normalizeListDateFilter(undefined)).toEqual(DEFAULT_LIST_DATE_FILTER);
    expect(normalizeListDateFilter({ listDateField: 'bogus', listDateMin: 'x', listDateMax: 5 })).toEqual({
      ...DEFAULT_LIST_DATE_FILTER,
      listDateMax: 5,
    });
  });
});
