import { describe, expect, it } from 'vitest';
import {
  buildStatsResult,
  buildVaStatsRows,
  buildStatsTimeWatchedRows,
  compareStatsSortValues,
  cycleStatsSort,
  DEFAULT_STATS_LIST_STATUS_FILTERS,
  DEFAULT_STATS_MEDIA_STATUS_FILTERS,
  filterStatsPool,
  filterStatsPoolByRatingScore,
  formatStatsFormatLabel,
  formatStatsDurationWithDayCount,
  parseCustomTagsFromNotes,
  normalizeStatsStaffRoleFilters,
  statsAggregationEmptyHint,
  statsDefaultStaffRoleFilters,
  statsEntryScoreSortValue,
  statsStudioIsAnimation,
  type StatsCachedData,
  type StatsEntry,
  type StatsForm,
} from '../panels/statsLogic';
import { statsCachedNeedsCast } from '../panels/statsApi';

function entry(overrides: Partial<StatsEntry> & Pick<StatsEntry, 'mediaId' | 'title'>): StatsEntry {
  return {
    titleSource: {
      id: overrides.mediaId,
      title_english: overrides.title,
      title_romaji: null,
      title_native: null,
    },
    coverImage: null,
    mediaType: 'ANIME',
    format: 'TV',
    mediaStatus: 'FINISHED',
    listStatus: 'COMPLETED',
    score: 80,
    repeat: null,
    notes: null,
    progress: 10,
    progressVolumes: null,
    episodes: 12,
    chapters: null,
    volumes: null,
    duration: 24,
    meanScore: 75,
    genres: [],
    tags: [],
    studios: [],
    staffCredits: [],
    vaCredits: [],
    ...overrides,
  };
}

const baseForm: StatsForm = {
  username: 'tester',
  mediaType: 'ANIME',
  mediaStatusFilters: [...DEFAULT_STATS_MEDIA_STATUS_FILTERS],
  formatFilters: ['TV'],
  listStatusFilters: [...DEFAULT_STATS_LIST_STATUS_FILTERS],
  userScoreInclude: 'any',
  scoreMin: null,
  scoreMax: null,
  showSummary: false,
  aggregationType: 'VA',
  staffRoleFilters: statsDefaultStaffRoleFilters('ANIME'),
  vaRoleFilters: ['MAIN', 'SUPPORTING', 'BACKGROUND'],
  vaShowMainRoleInfo: false,
  vaShowDiff: false,
  tagOptions: { tagMode: 'or', tagMinRank: 0 },
  studioKindFilters: ['animation', 'non_animation'],
};

describe('normalizeStatsStaffRoleFilters', () => {
  it('defaults to key production roles without Other', () => {
    expect(statsDefaultStaffRoleFilters('ANIME')).not.toContain('OTHER');
    expect(normalizeStatsStaffRoleFilters(undefined, 'ANIME')).toEqual(
      statsDefaultStaffRoleFilters('ANIME'),
    );
    expect(normalizeStatsStaffRoleFilters(undefined, 'MANGA')).toEqual(
      statsDefaultStaffRoleFilters('MANGA'),
    );
  });
});

describe('parseCustomTagsFromNotes', () => {
  it('extracts space-terminated hash tokens', () => {
    expect(parseCustomTagsFromNotes('hello #airing #dub fun')).toEqual(['#airing', '#dub']);
  });

  it('ignores #039 html entities', () => {
    expect(parseCustomTagsFromNotes('notes #039s')).toEqual([]);
  });
});

describe('filterStatsPool', () => {
  it('includes planning entries for staff when PLANNING is selected', () => {
    const pool = [
      entry({ mediaId: 1, title: 'A', listStatus: 'PLANNING' }),
      entry({ mediaId: 2, title: 'B', listStatus: 'COMPLETED' }),
    ];
    const filtered = filterStatsPool(pool, { ...baseForm, aggregationType: 'STAFF' });
    expect(filtered.map((e) => e.mediaId)).toEqual([1, 2]);
  });

  it('excludes planning when PLANNING is deselected', () => {
    const pool = [
      entry({ mediaId: 1, title: 'A', listStatus: 'PLANNING' }),
      entry({ mediaId: 2, title: 'B', listStatus: 'COMPLETED' }),
    ];
    const filtered = filterStatsPool(pool, {
      ...baseForm,
      aggregationType: 'VA',
      listStatusFilters: ['COMPLETED'],
    });
    expect(filtered.map((e) => e.mediaId)).toEqual([2]);
  });
});

describe('buildVaStatsRows', () => {
  it('dedupes shows per VA and filters by character role', () => {
    const pool = [
      entry({
        mediaId: 1,
        title: 'Show A',
        vaCredits: [
          {
            staffId: 10,
            staffName: 'VA One',
            staffImage: null,
            staffGender: 'Female',
            characterId: 100,
            characterName: 'Hero',
            characterRole: 'MAIN',
          },
        ],
      }),
      entry({
        mediaId: 2,
        title: 'Show B',
        vaCredits: [
          {
            staffId: 10,
            staffName: 'VA One',
            staffImage: null,
            staffGender: 'Female',
            characterId: 101,
            characterName: 'Side',
            characterRole: 'SUPPORTING',
          },
        ],
      }),
    ];
    const rows = buildVaStatsRows(pool, {
      ...baseForm,
      vaRoleFilters: ['MAIN'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metrics.count).toBe(1);
    expect(rows[0]?.subrows[0]?.entry.mediaId).toBe(1);
  });
});

describe('cycleStatsSort', () => {
  it('cycles forward desc → asc → off', () => {
    expect(cycleStatsSort(null, 'count', false)).toEqual({ column: 'count', direction: 'desc' });
    expect(cycleStatsSort({ column: 'count', direction: 'desc' }, 'count', false)).toEqual({
      column: 'count',
      direction: 'asc',
    });
    expect(cycleStatsSort({ column: 'count', direction: 'asc' }, 'count', false)).toBeNull();
  });

  it('cycles backward off → asc → desc', () => {
    expect(cycleStatsSort(null, 'count', true)).toEqual({ column: 'count', direction: 'asc' });
    expect(cycleStatsSort({ column: 'count', direction: 'asc' }, 'count', true)).toEqual({
      column: 'count',
      direction: 'desc',
    });
    expect(cycleStatsSort({ column: 'count', direction: 'desc' }, 'count', true)).toBeNull();
  });
});

describe('buildStatsResult', () => {
  it('builds genre rows with one row per genre on a show', () => {
    const pool = [
      entry({
        mediaId: 1,
        title: 'Tagged',
        genres: ['Action', 'Comedy'],
        listStatus: 'COMPLETED',
      }),
    ];
    const result = buildStatsResult(pool, {
      ...baseForm,
      aggregationType: 'GENRES_TAGS',
      listStatusFilters: ['COMPLETED', 'PLANNING'],
    });
    expect(result.genreRows.map((r) => r.name).sort()).toEqual(['Action', 'Comedy']);
  });
});

describe('filterStatsPoolByRatingScore', () => {
  it('returns only entries with the given rated score', () => {
    const pool = [
      entry({ mediaId: 1, title: 'A', score: 80 }),
      entry({ mediaId: 2, title: 'B', score: 60 }),
      entry({ mediaId: 3, title: 'C', score: null, listStatus: 'PLANNING' }),
    ];
    expect(filterStatsPoolByRatingScore(pool, 80).map((e) => e.mediaId)).toEqual([1]);
  });
});

describe('formatStatsFormatLabel', () => {
  it('uses title case for manga formats', () => {
    expect(formatStatsFormatLabel('MANGA')).toBe('Manga');
    expect(formatStatsFormatLabel('NOVEL')).toBe('Novel');
    expect(formatStatsFormatLabel('ONE_SHOT')).toBe('One Shot');
  });
});

describe('statsCachedNeedsCast', () => {
  const cachedBase = (entries: StatsEntry[]): StatsCachedData => ({
    username: 'tester',
    mediaType: 'ANIME',
    entries,
    castExpanded: false,
  });

  it('returns false when cast is already expanded', () => {
    expect(
      statsCachedNeedsCast({
        username: 'tester',
        mediaType: 'ANIME',
        entries: [entry({ mediaId: 1, title: 'A' })],
        castExpanded: true,
      }),
    ).toBe(false);
  });

  it('returns true when every entry still has empty cast arrays', () => {
    expect(statsCachedNeedsCast(cachedBase([entry({ mediaId: 1, title: 'A' })]))).toBe(true);
  });

  it('returns false when cast arrays are populated', () => {
    const expanded = entry({
      mediaId: 1,
      title: 'A',
      vaCredits: [
        {
          staffId: 1,
          staffName: 'VA',
          staffImage: null,
          staffGender: null,
          characterId: 1,
          characterName: 'Hero',
          characterRole: 'MAIN',
        },
      ],
    });
    expect(statsCachedNeedsCast(cachedBase([expanded]))).toBe(false);
  });
});

describe('buildStatsTimeWatchedRows', () => {
  it('sums progress and repeat into minutes for anime', () => {
    const pool = [
      entry({
        mediaId: 1,
        title: 'Short',
        progress: 10,
        duration: 24,
        episodes: 12,
        repeat: 1,
      }),
      entry({
        mediaId: 2,
        title: 'Manga',
        mediaType: 'MANGA',
        progress: 100,
      }),
    ];
    const rows = buildStatsTimeWatchedRows(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entry.mediaId).toBe(1);
    expect(rows[0]?.minutes).toBe(10 * 24 + 12 * 24);
  });
});

describe('statsEntryScoreSortValue', () => {
  it('sorts rated scores numerically and letters below unrated', () => {
    const rated = entry({ mediaId: 1, title: 'A', score: 85 });
    const planning = entry({ mediaId: 2, title: 'B', listStatus: 'PLANNING', score: 0 });
    const unrated = entry({ mediaId: 3, title: 'C', listStatus: 'COMPLETED', score: 0 });

    expect(statsEntryScoreSortValue(rated)).toBe(85);
    expect(statsEntryScoreSortValue(planning)).toBe(-40);
    expect(statsEntryScoreSortValue(unrated)).toBeNull();
    expect(
      compareStatsSortValues(statsEntryScoreSortValue(rated), statsEntryScoreSortValue(planning)),
    ).toBeGreaterThan(0);
  });
});

describe('formatStatsDurationWithDayCount', () => {
  it('appends day count when at least one full day', () => {
    expect(formatStatsDurationWithDayCount(60 * 24 * 5 + 30)).toBe('120h 30m (5 days)');
  });

  it('omits day count under one day', () => {
    expect(formatStatsDurationWithDayCount(90)).toBe('1h 30m');
  });
});

describe('statsStudioIsAnimation', () => {
  it('uses AniList isMain when present', () => {
    expect(statsStudioIsAnimation(true, 3)).toBe(true);
    expect(statsStudioIsAnimation(false, 0)).toBe(false);
  });

  it('falls back to sort_order 0 for legacy rows', () => {
    expect(statsStudioIsAnimation(null, 0)).toBe(true);
    expect(statsStudioIsAnimation(null, 2)).toBe(false);
  });
});

describe('statsAggregationEmptyHint', () => {
  it('suggests cast expansion for staff/va when cast is missing', () => {
    expect(statsAggregationEmptyHint('STAFF', true)).toContain('Expand all cast');
    expect(statsAggregationEmptyHint('VA', true)).toContain('Expand all cast');
  });

  it('returns filter message when cast is loaded', () => {
    expect(statsAggregationEmptyHint('STAFF', false)).toBe('No rows match the current filters.');
  });
});
