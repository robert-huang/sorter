import { describe, expect, it } from 'vitest';
import {
  buildActiveStatsChartRows,
  buildStatsResult,
  buildStudioStatsRows,
  buildVaStatsRows,
  buildStatsTimeWatchedRows,
  compareStatsSortValues,
  cycleStatsParentSort,
  cycleStatsSubrowSort,
  entryChaptersRemaining,
  entryEpisodesRemaining,
  filterStatsParentRowsByMinCount,
  sortStatsParentRows,
  sortStatsSubrows,
  DEFAULT_STATS_LIST_STATUS_FILTERS,
  DEFAULT_STATS_MEDIA_STATUS_FILTERS,
  filterStatsPool,
  filterStatsPoolByRatingScore,
  formatStatsFormatLabel,
  formatStatsDurationWithDayCount,
  formatStatsSubrowCountLabel,
  parseCustomTagsFromNotes,
  normalizeStatsStaffRoleFilters,
  statsAggregationEmptyHint,
  statsDefaultStaffRoleFilters,
  statsEntryScoreSortValue,
  statsStudioIsAnimation,
  type StatsCachedData,
  type StatsEntry,
  type StatsForm,
  type StatsParentRow,
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
    startDate: { year: null, month: null, day: null },
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
  minCount: 0,
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

  it('lists every matching role on one subrow when a VA voices multiple characters on the same show', () => {
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
    const rows = buildVaStatsRows(pool, baseForm);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metrics.count).toBe(1);
    expect(rows[0]?.subrows).toHaveLength(1);
    expect(rows[0]?.subrows[0]?.link?.characters).toEqual([
      {
        characterId: 100,
        characterName: 'Hero',
        characterRole: 'MAIN',
      },
      {
        characterId: 101,
        characterName: 'Side',
        characterRole: 'SUPPORTING',
      },
    ]);
    expect(rows[0]?.metrics.mainRoleCount).toBe(1);
  });
});

describe('cycleStatsParentSort', () => {
  it('toggles asc/desc on the active column and starts desc on new columns', () => {
    expect(cycleStatsParentSort(null, 'count')).toEqual({ column: 'count', direction: 'asc' });
    expect(cycleStatsParentSort({ column: 'count', direction: 'desc' }, 'count')).toEqual({
      column: 'count',
      direction: 'asc',
    });
    expect(cycleStatsParentSort({ column: 'count', direction: 'asc' }, 'count')).toEqual({
      column: 'count',
      direction: 'desc',
    });
    expect(cycleStatsParentSort({ column: 'count', direction: 'desc' }, 'meanScore')).toEqual({
      column: 'meanScore',
      direction: 'desc',
    });
  });
});

describe('cycleStatsSubrowSort', () => {
  it('cycles desc → asc → release-date default', () => {
    expect(cycleStatsSubrowSort(null, 'meanScore')).toEqual({ column: 'meanScore', direction: 'desc' });
    expect(
      cycleStatsSubrowSort({ column: 'meanScore', direction: 'desc' }, 'meanScore'),
    ).toEqual({ column: 'meanScore', direction: 'asc' });
    expect(
      cycleStatsSubrowSort({ column: 'meanScore', direction: 'asc' }, 'meanScore'),
    ).toBeNull();
  });
});

describe('compareStatsSortValues', () => {
  it('puts null values last regardless of direction', () => {
    expect(compareStatsSortValues(null, 1, 'asc')).toBeGreaterThan(0);
    expect(compareStatsSortValues(null, 1, 'desc')).toBeGreaterThan(0);
    expect(compareStatsSortValues(1, null, 'asc')).toBeLessThan(0);
    expect(compareStatsSortValues(1, null, 'desc')).toBeLessThan(0);
  });
});

describe('entryEpisodesRemaining', () => {
  it('returns 0 for completed shows', () => {
    expect(
      entryEpisodesRemaining(
        entry({
          mediaId: 1,
          title: 'Done',
          listStatus: 'COMPLETED',
          episodes: 12,
          progress: 10,
        }),
      ),
    ).toBe(0);
  });

  it('returns remaining episodes for in-progress shows', () => {
    expect(
      entryEpisodesRemaining(
        entry({
          mediaId: 2,
          title: 'Watching',
          listStatus: 'CURRENT',
          episodes: 12,
          progress: 5,
        }),
      ),
    ).toBe(7);
  });
});

describe('entryChaptersRemaining', () => {
  it('returns chapters left for in-progress manga with a chapter total', () => {
    expect(
      entryChaptersRemaining(
        entry({
          mediaId: 1,
          title: 'Manga A',
          mediaType: 'MANGA',
          listStatus: 'CURRENT',
          chapters: 100,
          progress: 40,
        }),
      ),
    ).toBe(60);
  });

  it('ignores manga without a chapter total', () => {
    expect(
      entryChaptersRemaining(
        entry({
          mediaId: 2,
          title: 'Ongoing',
          mediaType: 'MANGA',
          listStatus: 'CURRENT',
          chapters: null,
          progress: 40,
        }),
      ),
    ).toBe(0);
  });

  it('returns 0 for completed manga', () => {
    expect(
      entryChaptersRemaining(
        entry({
          mediaId: 3,
          title: 'Done',
          mediaType: 'MANGA',
          listStatus: 'COMPLETED',
          chapters: 100,
          progress: 100,
        }),
      ),
    ).toBe(0);
  });
});

describe('filterStatsParentRowsByMinCount', () => {
  const metrics = (count: number): StatsParentRow['metrics'] => ({
    count,
    meanScore: null,
    anilistMeanScore: null,
    mainRoleCount: null,
    mainRoleMeanScore: null,
    mainRoleAnilistMeanScore: null,
    scoreDiff: null,
    episodesWatched: 0,
    timeWatchedMinutes: 0,
    episodesRemaining: 0,
    timeRemainingMinutes: 0,
    chaptersRead: 0,
    chaptersRemaining: 0,
    volumesRead: 0,
    volumesRemaining: 0,
  });

  it('filters parent rows below the minimum count', () => {
    const rows: StatsParentRow[] = [
      { key: 'a', name: 'A', metrics: metrics(1), subrows: [] },
      { key: 'b', name: 'B', metrics: metrics(3), subrows: [] },
    ];
    expect(filterStatsParentRowsByMinCount(rows, 2).map((r) => r.key)).toEqual(['b']);
  });
});

describe('sortStatsParentRows', () => {
  const metrics = (
    overrides: Partial<StatsParentRow['metrics']> & Pick<StatsParentRow['metrics'], 'count' | 'meanScore'>,
  ): StatsParentRow['metrics'] => ({
    anilistMeanScore: null,
    mainRoleCount: null,
    mainRoleMeanScore: null,
    mainRoleAnilistMeanScore: null,
    scoreDiff: null,
    episodesWatched: 0,
    timeWatchedMinutes: 0,
    episodesRemaining: 0,
    timeRemainingMinutes: 0,
    chaptersRead: 0,
    chaptersRemaining: 0,
    volumesRead: 0,
    volumesRemaining: 0,
    ...overrides,
  });

  it('uses stable ordering for ties', () => {
    const rows: StatsParentRow[] = [
      { key: 'first', name: 'First', metrics: metrics({ count: 2, meanScore: 80 }), subrows: [] },
      { key: 'second', name: 'Second', metrics: metrics({ count: 2, meanScore: 80 }), subrows: [] },
    ];
    const sorted = sortStatsParentRows(rows, { column: 'meanScore', direction: 'desc' });
    expect(sorted.map((r) => r.key)).toEqual(['first', 'second']);
  });
});

describe('sortStatsSubrows', () => {
  it('defaults to oldest release date first when subrow sort is off', () => {
    const subrows = [
      {
        entry: entry({
          mediaId: 1,
          title: 'Old',
          startDate: { year: 2010, month: 1, day: 1 },
        }),
      },
      {
        entry: entry({
          mediaId: 2,
          title: 'New',
          startDate: { year: 2020, month: 1, day: 1 },
        }),
      },
    ];
    const sorted = sortStatsSubrows(subrows, null, { mediaType: 'ANIME', vaShowDiff: false });
    expect(sorted.map((s) => s.entry.mediaId)).toEqual([1, 2]);
  });

  it('sorts by list repeat when count column is selected', () => {
    const subrows = [
      { entry: entry({ mediaId: 1, title: 'A', repeat: 0 }) },
      { entry: entry({ mediaId: 2, title: 'B', repeat: 2 }) },
      { entry: entry({ mediaId: 3, title: 'C', repeat: 1 }) },
    ];
    const sorted = sortStatsSubrows(
      subrows,
      { column: 'count', direction: 'desc' },
      { mediaType: 'ANIME', vaShowDiff: false },
    );
    expect(sorted.map((s) => s.entry.mediaId)).toEqual([2, 3, 1]);
  });
});

describe('formatStatsSubrowCountLabel', () => {
  it('shows x1 for first watch', () => {
    expect(formatStatsSubrowCountLabel(entry({ mediaId: 1, title: 'A', repeat: null }))).toBe('x1');
    expect(formatStatsSubrowCountLabel(entry({ mediaId: 2, title: 'B', repeat: 0 }))).toBe('x1');
  });

  it('shows higher ordinals for rewatches', () => {
    expect(formatStatsSubrowCountLabel(entry({ mediaId: 1, title: 'A', repeat: 1 }))).toBe('x2');
    expect(formatStatsSubrowCountLabel(entry({ mediaId: 2, title: 'B', repeat: 2 }))).toBe('x3');
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

describe('buildActiveStatsChartRows', () => {
  it('builds only VA rows when the VA chart is selected', () => {
    const pool = [
      entry({
        mediaId: 1,
        title: 'Show',
        vaCredits: [
          {
            staffId: 1,
            staffName: 'VA',
            staffImage: null,
            staffGender: null,
            characterId: 1,
            characterName: 'Char',
            characterRole: 'MAIN',
          },
        ],
      }),
    ];
    const rows = buildActiveStatsChartRows(pool, baseForm);
    expect(rows.vaRows.length).toBe(1);
    expect(rows.staffRows).toEqual([]);
    expect(rows.genreRows).toEqual([]);
  });

  it('skips chart rows when summary mode is on', () => {
    const rows = buildActiveStatsChartRows([entry({ mediaId: 1, title: 'A' })], {
      ...baseForm,
      showSummary: true,
    });
    expect(rows.vaRows).toEqual([]);
    expect(rows.staffRows).toEqual([]);
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
  it('uses AniList-style labels for manga formats', () => {
    expect(formatStatsFormatLabel('MANGA')).toBe('MANGA');
    expect(formatStatsFormatLabel('NOVEL')).toBe('LIGHT_NOVEL');
    expect(formatStatsFormatLabel('ONE_SHOT')).toBe('ONE_SHOT');
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
  it('appends day count rounded to two decimal places', () => {
    expect(formatStatsDurationWithDayCount(60 * 24 * 5 + 30)).toBe('120h 30m (5.02 days)');
  });

  it('omits day count under one day', () => {
    expect(formatStatsDurationWithDayCount(90)).toBe('1h 30m');
    expect(formatStatsDurationWithDayCount(60 * 24 - 1)).toBe('23h 59m');
  });

  it('shows day count from one day upward', () => {
    expect(formatStatsDurationWithDayCount(60 * 24)).toBe('24h (1 days)');
  });

  it('omits day count when zero', () => {
    expect(formatStatsDurationWithDayCount(0)).toBe('0m');
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

describe('buildStudioStatsRows', () => {
  const studioForm: StatsForm = { ...baseForm, aggregationType: 'STUDIOS' };

  it('marks parent normal when any animation credit exists', () => {
    const rows = buildStudioStatsRows(
      [
        entry({
          mediaId: 1,
          title: 'Producer credit first',
          studios: [
            { studioId: 10, studioName: 'Aniplex', isAnimation: false },
          ],
        }),
        entry({
          mediaId: 2,
          title: 'Animation credit',
          studios: [
            { studioId: 10, studioName: 'Aniplex', isAnimation: true },
          ],
        }),
      ],
      studioForm,
    );
    const row = rows.find((r) => r.studioId === 10);
    expect(row?.isNonAnimationStudio).toBe(false);
    expect(row?.subrows.find((s) => s.entry.mediaId === 1)?.link?.studioIsAnimation).toBe(false);
    expect(row?.subrows.find((s) => s.entry.mediaId === 2)?.link?.studioIsAnimation).toBe(true);
  });

  it('marks parent muted when every credit is non-animation', () => {
    const rows = buildStudioStatsRows(
      [
        entry({
          mediaId: 1,
          title: 'Licensed',
          studios: [{ studioId: 20, studioName: 'Licensors Inc', isAnimation: false }],
        }),
      ],
      studioForm,
    );
    const row = rows.find((r) => r.studioId === 20);
    expect(row?.isNonAnimationStudio).toBe(true);
    expect(row?.subrows[0]?.link?.studioIsAnimation).toBe(false);
  });

  it('upgrades subrow to animation when both credits exist on one show', () => {
    const rows = buildStudioStatsRows(
      [
        entry({
          mediaId: 1,
          title: 'Both credits',
          studios: [
            { studioId: 30, studioName: 'Dual Role', isAnimation: false },
            { studioId: 30, studioName: 'Dual Role', isAnimation: true },
          ],
        }),
      ],
      studioForm,
    );
    const row = rows.find((r) => r.studioId === 30);
    expect(row?.isNonAnimationStudio).toBe(false);
    expect(row?.subrows).toHaveLength(1);
    expect(row?.subrows[0]?.link?.studioIsAnimation).toBe(true);
  });

  it('fades producer-only credit when animation studio is a separate entity (Kusuriya)', () => {
    const rows = buildStudioStatsRows(
      [
        entry({
          mediaId: 161645,
          title: 'Kusuriya no Hitorigoto',
          studios: [
            { studioId: 245, studioName: 'Toho', isAnimation: false },
            { studioId: 28, studioName: 'OLM', isAnimation: true },
            { studioId: 7368, studioName: 'TOHO animation STUDIO', isAnimation: true },
          ],
        }),
      ],
      studioForm,
    );
    const toho = rows.find((r) => r.studioId === 245);
    expect(toho?.isNonAnimationStudio).toBe(true);
    expect(toho?.subrows[0]?.link?.studioIsAnimation).toBe(false);
    const tohoAnimation = rows.find((r) => r.studioId === 7368);
    expect(tohoAnimation?.isNonAnimationStudio).toBe(false);
    expect(tohoAnimation?.subrows[0]?.link?.studioIsAnimation).toBe(true);
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
