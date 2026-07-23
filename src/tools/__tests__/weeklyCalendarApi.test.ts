import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAvailabilityCache } from '../../lib/storage';
import {
  persistentCacheGet,
} from '../../lib/importers/anilist/toolsPersistentCache';
import {
  _clearSessionMemoForTesting,
} from '../../lib/importers/anilist/toolsSessionMemo';
import {
  bustWeeklyCalendarUserListMemo,
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
  beforeEach(() => {
    window.localStorage.clear();
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

    expect(second[0]?.progress).toBe(5);
    expect(depaginateMock).toHaveBeenCalledTimes(1);
    expect(persistentCacheGet('weekly-calendar:watching:rh_test')).toEqual({
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

  it('bustWeeklyCalendarUserListMemo clears persistent cache', async () => {
    await fetchWeeklyCalendarWatchingEntries('rh_test');
    bustWeeklyCalendarUserListMemo('rh_test');

    expect(persistentCacheGet('weekly-calendar:watching:rh_test')).toEqual({ hit: false });

    _clearSessionMemoForTesting();
    await fetchWeeklyCalendarWatchingEntries('rh_test');

    expect(depaginateMock).toHaveBeenCalledTimes(2);
  });
});
