import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadWeeklyCalendarForm,
  saveWeeklyCalendarForm,
} from '../panels/WeeklyCalendarPanel';
import {
  buildWeeklyCalendarCustomSeasonYearOptions,
  DEFAULT_WEEKLY_CALENDAR_FORM,
} from '../panels/weeklyCalendarLogic';

describe('WeeklyCalendarPanel form persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('restores the selected season and custom season range', () => {
    const seasonOptions = buildWeeklyCalendarCustomSeasonYearOptions();
    const customSeasonMinEncoded = seasonOptions[1]!;
    const customSeasonMaxEncoded = seasonOptions[3]!;

    saveWeeklyCalendarForm({
      ...DEFAULT_WEEKLY_CALENDAR_FORM,
      seasonScope: 'previous',
      customSeasonMinEncoded,
      customSeasonMaxEncoded,
    });

    const restored = loadWeeklyCalendarForm();
    expect(restored.seasonScope).toBe('previous');
    expect(restored.customSeasonMinEncoded).toBe(customSeasonMinEncoded);
    expect(restored.customSeasonMaxEncoded).toBe(customSeasonMaxEncoded);
  });
});
