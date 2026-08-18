import { beforeEach, describe, expect, it } from 'vitest';
import {
  formatCachedThemeSongMatchProgress,
  loadWeeklyCalendarForm,
  saveWeeklyCalendarForm,
  themeSongMatchesPlaylistFilter,
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

describe('themeSongMatchesPlaylistFilter', () => {
  it('shows only confirmed playlist matches in the green filter', () => {
    expect(themeSongMatchesPlaylistFilter('in', 'in')).toBe(true);
    expect(themeSongMatchesPlaylistFilter('out', 'in')).toBe(false);
    expect(themeSongMatchesPlaylistFilter('unknown', 'in')).toBe(false);
  });

  it('shows missing and unresolved rows in the red filter', () => {
    expect(themeSongMatchesPlaylistFilter('in', 'out')).toBe(false);
    expect(themeSongMatchesPlaylistFilter('out', 'out')).toBe(true);
    expect(themeSongMatchesPlaylistFilter('unknown', 'out')).toBe(true);
  });
});

describe('formatCachedThemeSongMatchProgress', () => {
  it('shows completed and total ISRC lookups for cached songs', () => {
    expect(
      formatCachedThemeSongMatchProgress({ completed: 12, total: 37 }),
    ).toBe('Loading cached theme songs… 12/37');
  });
});
