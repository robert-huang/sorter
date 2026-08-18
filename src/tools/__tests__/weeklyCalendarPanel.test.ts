import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaThemeSongsPayload } from '../../lib/importers/anilist/themeSongs/types';
import {
  THEME_SONG_CACHE_LOAD_CHUNK_SIZE,
  formatCachedThemeSongLoadProgress,
  formatSpotifyTrackMatchProgress,
  loadCachedThemeSongsInChunks,
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

describe('cached theme-song loading', () => {
  it('loads and reports cached shows incrementally', async () => {
    const mediaIds = Array.from(
      { length: THEME_SONG_CACHE_LOAD_CHUNK_SIZE + 2 },
      (_, index) => index + 1,
    );
    const payload: MediaThemeSongsPayload = {
      version: 1,
      aniplaylistAvailable: true,
      rows: [],
    };
    const batchSizes: number[] = [];
    const snapshots: Array<{ completed: number; total: number; cacheSize: number }> = [];

    const cache = await loadCachedThemeSongsInChunks(
      mediaIds,
      async (chunk) => {
        batchSizes.push(chunk.length);
        return new Map(chunk.map((mediaId) => [mediaId, payload]));
      },
      ({ completed, total, cache: partialCache }) => {
        snapshots.push({ completed, total, cacheSize: partialCache.size });
      },
    );

    expect(batchSizes).toEqual([THEME_SONG_CACHE_LOAD_CHUNK_SIZE, 2]);
    expect(snapshots).toEqual([
      { completed: 0, total: mediaIds.length, cacheSize: 0 },
      {
        completed: THEME_SONG_CACHE_LOAD_CHUNK_SIZE,
        total: mediaIds.length,
        cacheSize: THEME_SONG_CACHE_LOAD_CHUNK_SIZE,
      },
      {
        completed: mediaIds.length,
        total: mediaIds.length,
        cacheSize: mediaIds.length,
      },
    ]);
    expect(cache.size).toBe(mediaIds.length);
  });

  it('distinguishes cache loading from Spotify matching progress', () => {
    expect(
      formatCachedThemeSongLoadProgress({ completed: 12, total: 37 }),
    ).toBe('Loading cached theme songs… 12/37 shows');
    expect(
      formatSpotifyTrackMatchProgress({ completed: 1200, total: 6752 }),
    ).toBe('Matching Spotify tracks… 1200/6752');
  });
});
