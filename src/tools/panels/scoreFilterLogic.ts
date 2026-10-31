/**
 * The multi-user score chip shared by User Scores and Seasonal Scores.
 * Dependency-free so either tool's logic can import it without a cycle.
 */

export type ComparisonScoreMode = 'any' | 'all';

export type ComparisonScoreFilter = {
  mode: ComparisonScoreMode;
  pill: 'any' | 'rated' | 'unrated';
  min: number | null;
  max: number | null;
};

export const DEFAULT_SCORE_FILTER: ComparisonScoreFilter = {
  mode: 'any',
  pill: 'any',
  min: null,
  max: null,
};

function scoreInRange(score: number, filter: ComparisonScoreFilter): boolean {
  if (filter.min !== null && score < filter.min) return false;
  if (filter.max !== null && score > filter.max) return false;
  return true;
}

/** Single-user semantics from the sorter's score chip: range applies to rated only. */
function scoreMatchesChip(score: number, filter: ComparisonScoreFilter): boolean {
  const rated = score > 0;
  if (filter.pill === 'rated' && !rated) return false;
  if (filter.pill === 'unrated') return !rated;
  return !rated || scoreInRange(score, filter);
}

export function scoreFilterActive(filter: ComparisonScoreFilter): boolean {
  return filter.pill !== 'any' || filter.min !== null || filter.max !== null;
}

/**
 * Scores (0–100, 0 = unrated) of the users counted for one media.
 * `any` ("one person"): someone rated it in range; others may be unrated.
 * `all` ("everyone"): every user matches the score chip.
 */
export function scoresPassScoreFilter(
  scores: readonly number[],
  filter: ComparisonScoreFilter,
): boolean {
  if (!scoreFilterActive(filter)) return true;
  if (scores.length === 0) return false;
  if (filter.mode === 'all') {
    return scores.every((score) => scoreMatchesChip(score, filter));
  }
  if (filter.pill === 'unrated') {
    return scores.some((score) => score <= 0);
  }
  return scores.some((score) => score > 0 && scoreInRange(score, filter));
}

function normalizeBound(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100
    ? value
    : null;
}

export function normalizeScoreFilter(value: unknown): ComparisonScoreFilter {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return DEFAULT_SCORE_FILTER;
  }
  const record = value as Record<string, unknown>;
  const pill = record.pill === 'rated' || record.pill === 'unrated' ? record.pill : 'any';
  return {
    mode: record.mode === 'all' ? 'all' : 'any',
    pill,
    min: pill === 'unrated' ? null : normalizeBound(record.min),
    max: pill === 'unrated' ? null : normalizeBound(record.max),
  };
}
