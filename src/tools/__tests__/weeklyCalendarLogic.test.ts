import { describe, expect, it } from 'vitest';
import {
  buildWeeklyCalendarColumns,
  compareWeeklyCalendarClassicOrder,
  computeAiredEpisodeCount,
  finalizeWeeklyCalendarResult,
  formatWeeklyCalendarEpisodeProgress,
  formatWeeklyCalendarDateRange,
  formatWeeklyCalendarDetailLines,
  formatWeeklyCalendarListStatusFilterLabel,
  getCurrentAnilistSeason,
  getNextAnilistSeason,
  inferWeekdayFromPastAirings,
  orderedWeekdayColumns,
  resolveEntrySchedule,
  WEEKLY_CALENDAR_NOT_ON_LIST_FILTER,
  WEEKLY_CALENDAR_NOT_ON_LIST_LABEL,
  type WeeklyCalendarEntry,
  type WeeklyCalendarRawEntry,
  DEFAULT_WEEKLY_CALENDAR_FORM,
} from '../panels/weeklyCalendarLogic';

function entry(
  overrides: Partial<WeeklyCalendarEntry> & Pick<WeeklyCalendarEntry, 'id' | 'title'>,
): WeeklyCalendarEntry {
  return {
    coverImage: null,
    score: null,
    listStatus: 'CURRENT',
    progress: 0,
    totalEpisodes: null,
    popularity: 0,
    mediaStatus: 'RELEASING',
    startDate: null,
    endDate: null,
    nextAiringAt: null,
    airedCount: null,
    weekdayJs: null,
    airingTimeMinutes: null,
    inferredWeekday: false,
    ...overrides,
  };
}

describe('getCurrentAnilistSeason', () => {
  it('maps July to Summer of the same year', () => {
    expect(getCurrentAnilistSeason(new Date('2026-07-14T12:00:00Z'))).toEqual({
      season: 'SUMMER',
      year: 2026,
    });
  });
});

describe('getNextAnilistSeason', () => {
  it('rolls from Summer to Fall in the same year', () => {
    expect(getNextAnilistSeason({ season: 'SUMMER', year: 2026 })).toEqual({
      season: 'FALL',
      year: 2026,
    });
  });

  it('rolls from Fall to Winter next year', () => {
    expect(getNextAnilistSeason({ season: 'FALL', year: 2026 })).toEqual({
      season: 'WINTER',
      year: 2027,
    });
  });
});

describe('computeAiredEpisodeCount', () => {
  it('uses next episode minus one when upcoming exists', () => {
    expect(computeAiredEpisodeCount(5, 3)).toBe(4);
  });

  it('falls back to progress when no next episode', () => {
    expect(computeAiredEpisodeCount(null, 3)).toBe(3);
  });
});

describe('inferWeekdayFromPastAirings', () => {
  it('picks the most common weekday from past airing timestamps', () => {
    const inferred = inferWeekdayFromPastAirings(
      [1704153600, 1704758400, 1705363200],
      'UTC',
      1706000000,
    );
    expect(inferred?.weekdayJs).toBe(2);
  });
});

describe('orderedWeekdayColumns', () => {
  it('starts on Monday by default ordering', () => {
    expect(orderedWeekdayColumns('MONDAY').map((col) => col.label)).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]);
  });
});

describe('buildWeeklyCalendarColumns', () => {
  it('buckets by weekday and sorts watching rows by airing time', () => {
    const columns = buildWeeklyCalendarColumns(
      [
        entry({
          id: 1,
          title: 'Late',
          weekdayJs: 2,
          airingTimeMinutes: 23 * 60,
        }),
        entry({
          id: 2,
          title: 'Early',
          weekdayJs: 2,
          airingTimeMinutes: 12 * 60,
        }),
      ],
      { weekStartDay: 'MONDAY', showUnscheduledColumn: false, seasonMode: false },
    );
    const tuesday = columns.find((col) => col.label === 'Tuesday');
    expect(tuesday?.shows.map((show) => show.title)).toEqual(['Early', 'Late']);
  });

  it('adds an unscheduled column when enabled', () => {
    const columns = buildWeeklyCalendarColumns(
      [entry({ id: 1, title: 'Mystery', weekdayJs: null })],
      { weekStartDay: 'MONDAY', showUnscheduledColumn: true, seasonMode: false },
    );
    const last = columns[columns.length - 1];
    expect(last?.label).toBe('Unknown');
    expect(last?.shows).toHaveLength(1);
  });
});

describe('compareWeeklyCalendarClassicOrder', () => {
  it('orders scored entries before watching without score', () => {
    const scored = entry({ id: 1, title: 'A', score: 90, listStatus: 'CURRENT' });
    const watching = entry({ id: 2, title: 'B', score: null, listStatus: 'CURRENT' });
    expect(compareWeeklyCalendarClassicOrder(scored, watching)).toBeLessThan(0);
  });
});

describe('finalizeWeeklyCalendarResult', () => {
  it('resolves next airing weekday into columns', () => {
    const raw: WeeklyCalendarRawEntry = {
      ...entry({ id: 1, title: 'Show', progress: 2 }),
      nextAiringAt: 1704153600, // 2024-01-02 00:00 UTC
      pastAiringAts: [],
      nextAiringEpisodeNumber: 3,
    };
    const result = finalizeWeeklyCalendarResult(
      [raw],
      { ...DEFAULT_WEEKLY_CALENDAR_FORM, showUnscheduledColumn: false },
      null,
      new Date('2024-01-01T00:00:00Z'),
    );
    expect(result.kind).toBe('columns');
    if (result.kind === 'columns') {
      const total = result.columns.reduce((sum, col) => sum + col.shows.length, 0);
      expect(total).toBe(1);
    }
  });

  it('filters by list status selection', () => {
    const raw: WeeklyCalendarRawEntry = {
      ...entry({ id: 1, title: 'Show', listStatus: 'COMPLETED' }),
      pastAiringAts: [],
    };
    const result = finalizeWeeklyCalendarResult(
      [raw],
      {
        ...DEFAULT_WEEKLY_CALENDAR_FORM,
        listStatusFilters: ['CURRENT', 'REPEATING'],
      },
      null,
    );
    expect(result.kind).toBe('empty');
  });

  it('includes NOT ON LIST shows when that filter is selected', () => {
    const raw: WeeklyCalendarRawEntry = {
      ...entry({ id: 1, title: 'Show', listStatus: null }),
      nextAiringAt: 1704153600,
      pastAiringAts: [],
      nextAiringEpisodeNumber: 2,
    };
    const filteredOut = finalizeWeeklyCalendarResult(
      [raw],
      {
        ...DEFAULT_WEEKLY_CALENDAR_FORM,
        listStatusFilters: ['CURRENT', 'REPEATING'],
        showUnscheduledColumn: false,
      },
      'Summer 2026',
    );
    expect(filteredOut.kind).toBe('empty');

    const included = finalizeWeeklyCalendarResult(
      [raw],
      {
        ...DEFAULT_WEEKLY_CALENDAR_FORM,
        listStatusFilters: [WEEKLY_CALENDAR_NOT_ON_LIST_FILTER],
        showUnscheduledColumn: false,
      },
      'Summer 2026',
      new Date('2026-07-14T12:00:00Z'),
    );
    expect(included.kind).toBe('columns');
  });

  it('labels NOT ON LIST for the status chip', () => {
    expect(formatWeeklyCalendarListStatusFilterLabel(WEEKLY_CALENDAR_NOT_ON_LIST_FILTER)).toBe(
      WEEKLY_CALENDAR_NOT_ON_LIST_LABEL,
    );
    expect(formatWeeklyCalendarListStatusFilterLabel('PLANNING')).toBe('PLANNING');
  });
});

describe('formatWeeklyCalendarEpisodeProgress', () => {
  it('uses total episode count as the denominator when known', () => {
    expect(formatWeeklyCalendarEpisodeProgress(3, 12)).toBe('ep 3/12');
  });

  it('uses ? when total episode count is unknown', () => {
    expect(formatWeeklyCalendarEpisodeProgress(3, null)).toBe('ep 3/?');
  });

  it('omits progress when unwatched and total is unknown', () => {
    expect(formatWeeklyCalendarEpisodeProgress(0, null)).toBeNull();
  });
});

describe('formatWeeklyCalendarDateRange', () => {
  it('formats start and end dates', () => {
    expect(
      formatWeeklyCalendarDateRange(
        { year: 2026, month: 1, day: 5 },
        { year: 2026, month: 3, day: 28 },
      ),
    ).toBe('2026-01-05 - 2026-03-28');
  });

  it('uses ? when end date is missing', () => {
    expect(formatWeeklyCalendarDateRange({ year: 2026, month: 1, day: 5 }, null)).toBe(
      '2026-01-05 - ?',
    );
  });

  it('returns null when both dates are missing', () => {
    expect(formatWeeklyCalendarDateRange(null, null)).toBeNull();
  });
});

describe('formatWeeklyCalendarDetailLines', () => {
  it('puts metadata on separate lines with airing time last', () => {
    const lines = formatWeeklyCalendarDetailLines(
      entry({
        id: 1,
        title: 'Show',
        progress: 3,
        airedCount: 5,
        startDate: { year: 2026, month: 1, day: 5 },
        endDate: { year: 2026, month: 3, day: 28 },
        totalEpisodes: 12,
        nextAiringAt: 1704153600,
      }),
      'UTC',
    );
    expect(lines.primary).toContain('ep 3/12');
    expect(lines.primary).toContain('2026-01-05 - 2026-03-28');
    expect(lines.primary).not.toContain('episodes left');
    expect(lines.episodesLeft).toBe('9 episodes left');
    expect(lines.secondary).toBeTruthy();
    expect(lines.primary).not.toContain('Tue');
  });
});

describe('resolveEntrySchedule', () => {
  it('prefers next airing over inferred schedule', () => {
    const schedule = resolveEntrySchedule(
      entry({ id: 1, title: 'A', nextAiringAt: 1704153600 }),
      [1704758400],
      'UTC',
      new Date('2024-01-01T00:00:00Z'),
    );
    expect(schedule.inferredWeekday).toBe(false);
    expect(schedule.weekdayJs).not.toBeNull();
  });
});
