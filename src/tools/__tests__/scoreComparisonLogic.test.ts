import { describe, expect, it } from 'vitest';
import {
  buildComparisonRows,
  DEFAULT_SCORE_FILTER,
  fitRescaleTarget,
  RAW_NORMALIZATION,
  nextComparisonSort,
  normalizeScoreComparisonSettings,
  rowPassesScoreRange,
  rowStat,
  sortComparisonRows,
  userColumnSummaries,
  userWholeListStats,
  visibleComparisonRows,
  zScore,
  type ComparisonCell,
  type ComparisonEntry,
  type ComparisonFilters,
  type ComparisonMedia,
  type ComparisonUserList,
} from '../panels/scoreComparisonLogic';

function entry(score: number, status: ComparisonEntry['status'] = 'COMPLETED'): ComparisonEntry {
  return { score, status };
}

function user(username: string, entries: Record<number, ComparisonEntry>): ComparisonUserList {
  return {
    username,
    entries: new Map(Object.entries(entries).map(([id, e]) => [Number(id), e])),
    favouriteMediaIds: new Set<number>(),
  };
}

function mediaMap(titles: Record<number, string>): Map<number, ComparisonMedia> {
  return new Map(
    Object.entries(titles).map(([id, title]) => [
      Number(id),
      { id: Number(id), title, coverImage: null },
    ]),
  );
}

function filters(patch: Partial<ComparisonFilters> = {}): ComparisonFilters {
  return { userStatuses: {}, score: DEFAULT_SCORE_FILTER, minLists: 1, ...patch };
}

function cell(score: number | null, excluded = false): ComparisonCell {
  return { entry: score === null ? null : entry(score), excluded, favourite: false };
}

describe('userWholeListStats / zScore', () => {
  it('ignores unrated entries and uses population std dev', () => {
    const stats = userWholeListStats([entry(60), entry(80), entry(0)]);
    expect(stats).toEqual({ mean: 70, stdDev: 10, ratedCount: 2 });
    expect(zScore(80, stats)).toBe(1);
    expect(zScore(0, stats)).toBeNull();
  });

  it('returns null z-scores when the user has no spread', () => {
    const stats = userWholeListStats([entry(70), entry(70)]);
    expect(zScore(70, stats)).toBeNull();
    expect(userWholeListStats([entry(0)])).toBeNull();
  });
});

describe('fitRescaleTarget', () => {
  const stats = userWholeListStats([entry(20), entry(40), entry(70), entry(90), entry(95)])!;
  const fitRow = (id: number, score: number, patch: { passes?: boolean; excluded?: boolean } = {}) => ({
    media: { id, title: `T${id}`, coverImage: null },
    cells: [cell(score, patch.excluded ?? false)],
    passes: patch.passes ?? true,
  });
  const rescale = (target: { mean: number; stdDev: number }, score: number) =>
    target.mean + zScore(score, stats)! * target.stdDev;

  it('maps the lowest and highest passing scores onto 0 and 100', () => {
    const target = fitRescaleTarget([fitRow(1, 40), fitRow(2, 70), fitRow(3, 95), fitRow(4, 0)], 0, stats)!;
    expect(rescale(target, 40)).toBeCloseTo(0);
    expect(rescale(target, 95)).toBeCloseTo(100);
  });

  it('ignores filtered-out rows and excluded cells', () => {
    const rows = [
      fitRow(1, 20, { passes: false }),
      fitRow(2, 90, { excluded: true }),
      fitRow(3, 40),
      fitRow(4, 70),
    ];
    const target = fitRescaleTarget(rows, 0, stats)!;
    expect(rescale(target, 40)).toBeCloseTo(0);
    expect(rescale(target, 70)).toBeCloseTo(100);
  });

  it('is null without at least two different passing scores', () => {
    expect(fitRescaleTarget([fitRow(1, 0)], 0, stats)).toBeNull();
    expect(fitRescaleTarget([fitRow(1, 80), fitRow(2, 80)], 0, stats)).toBeNull();
  });
});

describe('rowStat', () => {
  it('divides by the rated count and skips unrated and excluded cells', () => {
    const row = { media: { id: 1, title: 'A', coverImage: null }, cells: [cell(60), cell(0), cell(80), cell(10, true)], passes: true };
    expect(rowStat(row, 'mean', [], RAW_NORMALIZATION)).toBe(70);
    expect(rowStat(row, 'stddev', [], RAW_NORMALIZATION)).toBe(10);
  });

  it('maps z-scores onto the target scale when rescaled', () => {
    const stats = { mean: 70, stdDev: 10, ratedCount: 2 };
    const row = { media: { id: 1, title: 'A', coverImage: null }, cells: [cell(80)], passes: true };
    expect(rowStat(row, 'mean', [stats], { kind: 'z' })).toBe(1);
    expect(rowStat(row, 'mean', [stats], { kind: 'rescaled', mean: 70, stdDev: 15 })).toBe(85);
  });

  it('is null when nobody rated it', () => {
    const row = { media: { id: 1, title: 'A', coverImage: null }, cells: [cell(0), cell(null)], passes: true };
    expect(rowStat(row, 'mean', [], RAW_NORMALIZATION)).toBeNull();
  });

  it('leaves std dev blank with a single rater, raw or normalized, but keeps the mean', () => {
    const stats = { mean: 70, stdDev: 10, ratedCount: 2 };
    const row = {
      media: { id: 1, title: 'A', coverImage: null },
      cells: [cell(80), cell(0), cell(90, true)],
      passes: true,
    };
    expect(rowStat(row, 'stddev', [stats, stats, stats], RAW_NORMALIZATION)).toBeNull();
    expect(rowStat(row, 'stddev', [stats, stats, stats], { kind: 'z' })).toBeNull();
    expect(rowStat(row, 'mean', [stats, stats, stats], RAW_NORMALIZATION)).toBe(80);
  });

  it('sorts single-rater std dev rows last in both directions', () => {
    const media = (id: number, title: string) => ({ id, title, coverImage: null });
    const rows = [
      { media: media(1, 'Solo'), cells: [cell(80), cell(0)], passes: true },
      { media: media(2, 'Close'), cells: [cell(70), cell(72)], passes: true },
      { media: media(3, 'Far'), cells: [cell(40), cell(90)], passes: true },
    ];
    const ctx = {
      usernames: ['a', 'b'],
      userStats: [],
      normalization: RAW_NORMALIZATION,
      stat: 'stddev' as const,
    };
    const titles = (direction: 'asc' | 'desc') =>
      sortComparisonRows(rows, { column: 'stat', direction }, ctx).map((r) => r.media.title);
    expect(titles('desc')).toEqual(['Far', 'Close', 'Solo']);
    expect(titles('asc')).toEqual(['Close', 'Far', 'Solo']);
  });
});

describe('rowPassesScoreRange', () => {
  const range = { ...DEFAULT_SCORE_FILTER, pill: 'rated' as const, min: 70, max: null };

  it('one-person mode lets others be unrated or out of range', () => {
    expect(rowPassesScoreRange([cell(80), cell(0)], range)).toBe(true);
    expect(rowPassesScoreRange([cell(80), cell(40)], range)).toBe(true);
    expect(rowPassesScoreRange([cell(40), cell(0)], range)).toBe(false);
  });

  it('everyone mode requires every passing user to match', () => {
    const all = { ...range, mode: 'all' as const };
    expect(rowPassesScoreRange([cell(80), cell(90)], all)).toBe(true);
    expect(rowPassesScoreRange([cell(80), cell(0)], all)).toBe(false);
    expect(rowPassesScoreRange([cell(80), cell(40)], all)).toBe(false);
    expect(rowPassesScoreRange([cell(80), cell(40, true)], all)).toBe(true);
  });

  it('one-person mode with a range and the any pill still needs a rated match', () => {
    const anyPill = { ...DEFAULT_SCORE_FILTER, min: 70, max: null };
    expect(rowPassesScoreRange([cell(0), cell(40)], anyPill)).toBe(false);
    expect(rowPassesScoreRange([cell(0), cell(75)], anyPill)).toBe(true);
  });

  it('handles the unrated pill in both modes', () => {
    const unrated = { ...DEFAULT_SCORE_FILTER, pill: 'unrated' as const };
    expect(rowPassesScoreRange([cell(80), cell(0)], unrated)).toBe(true);
    expect(rowPassesScoreRange([cell(80), cell(0)], { ...unrated, mode: 'all' })).toBe(false);
  });
});

describe('buildComparisonRows', () => {
  const media = mediaMap({ 1: 'Alpha', 2: 'Beta', 3: 'Gamma' });
  const users = [
    user('Alice', { 1: entry(80), 2: entry(70, 'DROPPED') }),
    user('Bob', { 1: entry(60), 3: entry(90) }),
  ];

  const completedOnly = filters({ userStatuses: { alice: ['COMPLETED'] } });

  it('defaults every user to all statuses', () => {
    const rows = buildComparisonRows(users, media, filters(), null);
    expect(rows.every((r) => r.passes)).toBe(true);
  });

  it('marks status-excluded cells and fails rows with no passing user', () => {
    const rows = buildComparisonRows(users, media, completedOnly, null);
    const beta = rows.find((r) => r.media.id === 2)!;
    expect(beta.cells[0]!.excluded).toBe(true);
    expect(beta.passes).toBe(false);
  });

  it('hides failing rows unless show all rows is on', () => {
    const rows = buildComparisonRows(users, media, completedOnly, null);
    expect(visibleComparisonRows(rows, false).map((r) => r.media.id).sort()).toEqual([1, 3]);
    expect(visibleComparisonRows(rows, true)).toHaveLength(3);
  });

  it('uses per-user statuses', () => {
    const rows = buildComparisonRows(
      users,
      media,
      filters({ userStatuses: { alice: ['COMPLETED', 'DROPPED'] } }),
      null,
    );
    expect(rows.find((r) => r.media.id === 2)!.passes).toBe(true);
  });

  it('applies min lists to passing cells', () => {
    const rows = buildComparisonRows(users, media, filters({ minLists: 2 }), null);
    expect(rows.filter((r) => r.passes).map((r) => r.media.id)).toEqual([1]);
  });

  it('requires every list when min lists is empty', () => {
    const rows = buildComparisonRows(users, media, filters({ minLists: null }), null);
    expect(rows.filter((r) => r.passes).map((r) => r.media.id)).toEqual([1]);
  });

  it('fails rows outside the media-level allowed set but keeps them for show all rows', () => {
    const rows = buildComparisonRows(users, media, filters(), new Set([3]));
    expect(visibleComparisonRows(rows, false).map((r) => r.media.id)).toEqual([3]);
    expect(visibleComparisonRows(rows, true)).toHaveLength(3);
  });

  it('summarizes each user over passing rows only', () => {
    const rows = buildComparisonRows(users, media, completedOnly, null);
    const [alice, bob] = userColumnSummaries(rows, 2);
    expect(alice).toEqual({ mean: 80, stdDev: 0, ratedCount: 1 });
    expect(bob).toEqual({ mean: 75, stdDev: 15, ratedCount: 2 });
  });
});

describe('sorting', () => {
  const media = mediaMap({ 1: 'Alpha', 2: 'Beta', 3: 'Gamma' });
  const users = [user('Alice', { 1: entry(80), 2: entry(0), 3: entry(90) })];
  const ctx = { usernames: ['Alice'], userStats: [null], normalization: RAW_NORMALIZATION, stat: 'mean' as const };

  it('puts nulls last in both directions', () => {
    const rows = buildComparisonRows(users, media, filters(), null);
    const asc = sortComparisonRows(rows, { column: 'user:alice', direction: 'asc' }, ctx);
    const desc = sortComparisonRows(rows, { column: 'user:alice', direction: 'desc' }, ctx);
    expect(asc.map((r) => r.media.id)).toEqual([1, 3, 2]);
    expect(desc.map((r) => r.media.id)).toEqual([3, 1, 2]);
  });

  it('cycles like the Stats tables', () => {
    expect(nextComparisonSort({ column: 'stat', direction: 'desc' }, 'title')).toEqual({ column: 'title', direction: 'asc' });
    expect(nextComparisonSort({ column: 'stat', direction: 'desc' }, 'stat')).toEqual({ column: 'stat', direction: 'asc' });
  });
});

describe('normalizeScoreComparisonSettings', () => {
  it('falls back to defaults on bad input', () => {
    const settings = normalizeScoreComparisonSettings({
      usernames: ['Alice', ' alice ', '', 3, 'Bob'],
      mediaType: 'BOOK',
      filters: { minLists: -1, score: { pill: 'unrated', min: 50, mode: 'all' }, userStatuses: { bob: ['NOPE', 'DROPPED'] } },
      sort: 'x',
      stat: 'median',
    });
    expect(settings.usernames).toEqual(['Alice', 'Bob']);
    expect(settings.mediaType).toBe('ANIME');
    expect(settings.filters.minLists).toBeNull();
    expect(settings.filters.score).toEqual({ mode: 'all', pill: 'unrated', min: null, max: null });
    expect(settings.filters.userStatuses).toEqual({ bob: ['DROPPED'] });
    expect(settings.sort).toEqual({ column: 'stat', direction: 'desc' });
    expect(settings.stat).toBe('mean');
    expect(normalizeScoreComparisonSettings('junk').usernames).toEqual([]);
  });

  it('folds the old normalized checkbox into the stat choice', () => {
    expect(normalizeScoreComparisonSettings({ stat: 'stddev', normalized: true }).stat).toBe('normalizedStddev');
    expect(normalizeScoreComparisonSettings({ normalized: true }).stat).toBe('normalizedMean');
    expect(normalizeScoreComparisonSettings({ stat: 'normalizedMean' }).stat).toBe('normalizedMean');
  });
});
