import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDisposableCacheDbForTesting } from '../../lib/disposableCacheDb';
import { _resetAvailabilityCache } from '../../lib/storage';
import {
  _resetPersistentToolsCacheForTesting,
  persistentCacheGet,
  persistentCacheSet,
} from '../../lib/importers/anilist/toolsPersistentCache';
import {
  _clearSessionMemoForTesting,
} from '../../lib/importers/anilist/toolsSessionMemo';
import {
  bustWeeklyCalendarUserListMemo,
  fetchWeeklyCalendarSeasonEntries,
  fetchWeeklyCalendarWatchingEntries,
} from '../panels/weeklyCalendarApi';

vi.mock('../../lib/importers/anilist/depaginate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/importers/anilist/depaginate')>();
  return {
    ...actual,
    depaginate: vi.fn(),
  };
});

import { depaginate } from '../../lib/importers/anilist/depaginate';

const depaginateMock = vi.mocked(depaginate);

function watchingEntry(id: number) {
  return {
    status: 'CURRENT',
    score: 80,
    progress: 5,
    media: {
      id,
      title: {
        english: `Show ${id}`,
        romaji: null,
        native: null,
        userPreferred: `Show ${id}`,
      },
      coverImage: { large: `cover-${id}` },
      format: 'TV',
      status: 'RELEASING',
      episodes: 12,
      popularity: 1000,
      startDate: { year: 2026, month: 1, day: 1 },
      endDate: null,
      nextAiringEpisode: { airingAt: 1_700_000_000, episode: 6 },
      airingSchedule: { nodes: [{ airingAt: 1_699_000_000, episode: 5 }] },
    },
  };
}

describe('fetchWeeklyCalendarWatchingEntries', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await _resetDisposableCacheDbForTesting();
    _resetPersistentToolsCacheForTesting();
    _resetAvailabilityCache();
    _clearSessionMemoForTesting();
    depaginateMock.mockReset();
    depaginateMock.mockResolvedValue([watchingEntry(1)]);
  });

  it('memoizes the live list fetch in-session', async () => {
    const first = await fetchWeeklyCalendarWatchingEntries('rh_test');
    const second = await fetchWeeklyCalendarWatchingEntries('rh_test');

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(depaginateMock).toHaveBeenCalledTimes(1);
  });

  it('persists the live list in localStorage across session memo clears', async () => {
    await fetchWeeklyCalendarWatchingEntries('rh_test');
    _clearSessionMemoForTesting();

    const second = await fetchWeeklyCalendarWatchingEntries('rh_test');

    expect(second[0]).toMatchObject({ progress: 5, format: 'TV' });
    expect(depaginateMock).toHaveBeenCalledTimes(1);
    await expect(
      persistentCacheGet('weekly-calendar:watching:v2:rh_test'),
    ).resolves.toEqual({
      hit: true,
      value: second,
    });
  });

  it('forceRefresh busts session + localStorage and re-fetches', async () => {
    depaginateMock
      .mockResolvedValueOnce([watchingEntry(1)])
      .mockResolvedValueOnce([watchingEntry(2)]);

    expect((await fetchWeeklyCalendarWatchingEntries('rh_test'))[0]?.id).toBe(1);
    _clearSessionMemoForTesting();
    expect(
      (await fetchWeeklyCalendarWatchingEntries('rh_test', undefined, { forceRefresh: true }))[0]?.id,
    ).toBe(2);
    expect(depaginateMock).toHaveBeenCalledTimes(2);
  });

  it('ignores pre-format cache entries from the previous key version', async () => {
    await persistentCacheSet(
      'weekly-calendar:watching:rh_test',
      [{ id: 99, title: 'Stale entry without format' }],
      60_000,
    );

    const result = await fetchWeeklyCalendarWatchingEntries('rh_test');

    expect(result[0]).toMatchObject({ id: 1, format: 'TV' });
    expect(depaginateMock).toHaveBeenCalledTimes(1);
  });

  it('bustWeeklyCalendarUserListMemo clears persistent cache', async () => {
    await fetchWeeklyCalendarWatchingEntries('rh_test');
    bustWeeklyCalendarUserListMemo('rh_test');

    await expect(
      persistentCacheGet('weekly-calendar:watching:v2:rh_test'),
    ).resolves.toEqual({ hit: false });

    _clearSessionMemoForTesting();
    await fetchWeeklyCalendarWatchingEntries('rh_test');

    expect(depaginateMock).toHaveBeenCalledTimes(2);
  });

  it('requests and maps media format', async () => {
    const result = await fetchWeeklyCalendarWatchingEntries('rh_test');

    expect(result[0]?.format).toBe('TV');
    expect(depaginateMock.mock.calls[0]?.[0].query).toMatch(/\bformat\b/);
  });
});

describe('fetchWeeklyCalendarSeasonEntries', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await _resetDisposableCacheDbForTesting();
    _resetPersistentToolsCacheForTesting();
    _resetAvailabilityCache();
    _clearSessionMemoForTesting();
    depaginateMock.mockReset();
    depaginateMock.mockImplementation(async ({ variables }) => {
      if (variables && 'seasonYear' in variables) {
        return [watchingEntry(7).media];
      }
      return [
        {
          status: 'COMPLETED',
          score: 90,
          progress: 12,
          media: { id: 7 },
        },
      ];
    });
  });

  it('fetches and reuses a historical previous-season result', async () => {
    const previousSeason = { season: 'SPRING' as const, year: 2020 };

    const first = await fetchWeeklyCalendarSeasonEntries(
      'rh_test',
      previousSeason,
    );
    _clearSessionMemoForTesting();
    const restored = await fetchWeeklyCalendarSeasonEntries(
      'rh_test',
      previousSeason,
    );

    expect(first.seasonLabel).toBe('Spring 2020');
    expect(first.entries[0]).toMatchObject({
      id: 7,
      listStatus: 'COMPLETED',
      score: 90,
      progress: 12,
    });
    expect(restored).toEqual(first);
    expect(depaginateMock).toHaveBeenCalledTimes(2);
    expect(
      depaginateMock.mock.calls.some(
        ([options]) =>
          options.variables?.season === 'SPRING' &&
          options.variables?.seasonYear === 2020,
      ),
    ).toBe(true);
  });
});
