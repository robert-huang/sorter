import { describe, expect, it } from 'vitest';
import {
  buildStatsResult,
  buildVaStatsRows,
  buildStatsTimeWatchedRows,
  cycleStatsSort,
  DEFAULT_STATS_LIST_STATUS_FILTERS,
  DEFAULT_STATS_MEDIA_STATUS_FILTERS,
  filterStatsPool,
  filterStatsPoolByRatingScore,
  parseCustomTagsFromNotes,
  statsAnimeStaffRoleOptions,
  type StatsEntry,
  type StatsForm,
} from '../panels/statsLogic';

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
  staffRoleFilters: statsAnimeStaffRoleOptions(),
  vaRoleFilters: ['MAIN', 'SUPPORTING', 'BACKGROUND'],
  vaMainOnly: false,
  vaShowDiff: false,
  tagOptions: { tagMode: 'or', tagMinRank: 0 },
  studioKindFilters: ['animation', 'non_animation'],
};

describe('parseCustomTagsFromNotes', () => {
  it('extracts space-terminated hash tokens', () => {
    expect(parseCustomTagsFromNotes('hello #airing #dub fun')).toEqual(['#airing', '#dub']);
  });

  it('ignores #039 html entities', () => {
    expect(parseCustomTagsFromNotes('notes #039s')).toEqual([]);
  });
});

describe('filterStatsPool', () => {
  it('excludes planning entries for staff aggregation', () => {
    const pool = [
      entry({ mediaId: 1, title: 'A', listStatus: 'PLANNING' }),
      entry({ mediaId: 2, title: 'B', listStatus: 'COMPLETED' }),
    ];
    const filtered = filterStatsPool(pool, { ...baseForm, aggregationType: 'STAFF' });
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
