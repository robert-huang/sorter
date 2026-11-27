import type {
  WeeklyCalendarTimezone,
  WeeklyCalendarWeekStartDay,
} from './panels/weeklyCalendarLogic';

export const WEEKLY_CALENDAR_WEEK_START_OPTIONS: readonly WeeklyCalendarWeekStartDay[] = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
];

export const WEEKLY_CALENDAR_TIMEZONE_OPTIONS: ReadonlyArray<{
  value: WeeklyCalendarTimezone;
  label: string;
}> = [
  { value: 'eastern', label: 'Eastern' },
  { value: 'pacific', label: 'Pacific' },
  { value: 'utc', label: 'UTC' },
  { value: 'local', label: 'Local' },
];

export const DEFAULT_WEEKLY_CALENDAR_WEEK_START_DAY: WeeklyCalendarWeekStartDay = 'MONDAY';
export const DEFAULT_WEEKLY_CALENDAR_TIMEZONE: WeeklyCalendarTimezone = 'eastern';

export function isWeeklyCalendarWeekStartDay(value: unknown): value is WeeklyCalendarWeekStartDay {
  return WEEKLY_CALENDAR_WEEK_START_OPTIONS.includes(value as WeeklyCalendarWeekStartDay);
}

export function isWeeklyCalendarTimezone(value: unknown): value is WeeklyCalendarTimezone {
  return WEEKLY_CALENDAR_TIMEZONE_OPTIONS.some((option) => option.value === value);
}

/** `MONDAY` → `Monday`. */
export function formatWeeklyCalendarWeekStartDay(day: WeeklyCalendarWeekStartDay): string {
  return day[0] + day.slice(1).toLowerCase();
}
