import type { MediaTitleFields } from '../../lib/importers/anilist/mediaDisplayLabel';
import type { AnilistMediaListStatus } from '../../lib/importers/anilist/types';
import {
  listStatusScoreLabel,
  normalizeSeasonalListScore,
} from './seasonalScoresLogic';

export type FranchiseListStatus = AnilistMediaListStatus;

/** All AniList list statuses available in the status filter chip. */
export const FRANCHISE_LIST_STATUS_OPTIONS: readonly FranchiseListStatus[] = [
  'CURRENT',
  'REPEATING',
  'COMPLETED',
  'PLANNING',
  'PAUSED',
  'DROPPED',
];

/** Default status filter — all statuses so unwatched franchise entries stay visible. */
export const DEFAULT_FRANCHISE_LIST_STATUSES: readonly FranchiseListStatus[] = [
  ...FRANCHISE_LIST_STATUS_OPTIONS,
];

export function normalizeFranchiseListStatuses(raw: unknown): FranchiseListStatus[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_FRANCHISE_LIST_STATUSES];
  }
  const selected = FRANCHISE_LIST_STATUS_OPTIONS.filter((status) => raw.includes(status));
  return selected.length > 0 ? [...selected] : [...DEFAULT_FRANCHISE_LIST_STATUSES];
}

export function entryPassesListStatusFilter(
  listStatus: string | null,
  listStatuses: readonly FranchiseListStatus[],
): boolean {
  if (listStatuses.length === 0) {
    return false;
  }
  if (listStatuses.length >= FRANCHISE_LIST_STATUS_OPTIONS.length) {
    return true;
  }
  if (listStatus == null) {
    return false;
  }
  return listStatuses.includes(listStatus as FranchiseListStatus);
}

/**
 * AniList `MediaRelation` enum values. AniList's GraphQL schema does not
 * document each one in detail, but in practice:
 * - PREQUEL / SEQUEL: chronologically before / after the seed in the same arc
 * - PARENT / SIDE_STORY / SPIN_OFF: same world, off-shoot lines
 * - SUMMARY / ALTERNATIVE: recap or alt-universe retelling
 * - SOURCE / ADAPTATION: cross-medium pair (manga ↔ anime, novel ↔ anime, ...)
 * - COMPILATION / CONTAINS: collection / contains relationships
 * - CHARACTER: shares a character (often cameos)
 * - OTHER: AniList's catch-all when nothing else fits (soundtracks,
 *   special editions, promos, etc.)
 */
export const FRANCHISE_RELATION_TYPES = [
  'PREQUEL',
  'SEQUEL',
  'PARENT',
  'SIDE_STORY',
  'SPIN_OFF',
  'ALTERNATIVE',
  'SUMMARY',
  'ADAPTATION',
  'SOURCE',
  'COMPILATION',
  'CONTAINS',
  'OTHER',
  'CHARACTER',
] as const;

export type FranchiseRelationType = (typeof FRANCHISE_RELATION_TYPES)[number];

/** Human label + tooltip for the toggle grid. */
export const FRANCHISE_RELATION_LABELS: Record<
  FranchiseRelationType,
  { label: string; hint: string }
> = {
  PREQUEL: { label: 'Prequel', hint: 'Comes before the seed in-arc.' },
  SEQUEL: { label: 'Sequel', hint: 'Continues after the seed.' },
  PARENT: { label: 'Parent', hint: 'Containing series / parent story.' },
  SIDE_STORY: { label: 'Side story', hint: 'Same world, off-shoot story.' },
  SPIN_OFF: { label: 'Spin-off', hint: 'Spin-off series.' },
  ALTERNATIVE: { label: 'Alternative', hint: 'Alternative universe retelling.' },
  SUMMARY: { label: 'Summary', hint: 'Recap / summary cut.' },
  ADAPTATION: {
    label: 'Adaptation',
    hint: 'A cross-medium adaptation (e.g. an anime made FROM the seed manga).',
  },
  SOURCE: {
    label: 'Source',
    hint: 'The source material the seed was adapted from (e.g. the manga an anime is based on).',
  },
  COMPILATION: { label: 'Compilation', hint: 'A compilation containing the seed.' },
  CONTAINS: { label: 'Contains', hint: 'The seed contains this entry.' },
  OTHER: {
    label: 'Other',
    hint: "AniList's catch-all bucket (soundtracks, promos, specials) — often noisy. Off by default.",
  },
  CHARACTER: {
    label: 'Character',
    hint: 'Just shares a character with the seed — often only a cameo. Off by default.',
  },
};

/**
 * Default relation toggles: the strong franchise links are ON; CHARACTER
 * and OTHER are OFF because they tend to drag in unrelated noise (cameos,
 * soundtrack-only entries, promo videos) that bloats the chart without
 * being "the same story".
 */
export const DEFAULT_RELATION_TOGGLES: Record<FranchiseRelationType, boolean> = {
  PREQUEL: true,
  SEQUEL: true,
  PARENT: true,
  SIDE_STORY: true,
  SPIN_OFF: true,
  ALTERNATIVE: true,
  SUMMARY: true,
  ADAPTATION: true,
  SOURCE: true,
  COMPILATION: true,
  CONTAINS: true,
  OTHER: false,
  CHARACTER: false,
};

export type FranchiseForm = {
  username: string;
  showText: string;
  relationTypes: Record<FranchiseRelationType, boolean>;
};

/**
 * Client-side filters layered over the franchise result table. Applied
 * post-fetch so toggling them is instant (no relation re-walk, no
 * list re-read). The score controls mirror the sorter's ScoreRangeChip
 * exactly so the rated/unrated/score-range semantics stay consistent
 * between tools.
 *
 * Defaults ({@link DEFAULT_FRANCHISE_FILTERS}) are "show everything":
 * both media-type checkboxes on, all list statuses selected, score pill
 * at 'any', range unbounded.
 */
export type FranchiseFilters = {
  includeAnime: boolean;
  includeManga: boolean;
  listStatuses: readonly FranchiseListStatus[];
  userScoreInclude: 'any' | 'rated' | 'unrated';
  scoreMin: number | null;
  scoreMax: number | null;
};

export const DEFAULT_FRANCHISE_FILTERS: FranchiseFilters = {
  includeAnime: true,
  includeManga: true,
  listStatuses: [...DEFAULT_FRANCHISE_LIST_STATUSES],
  userScoreInclude: 'any',
  scoreMin: null,
  scoreMax: null,
};

/** Raw node returned by the BFS — display fields normalized for the chart. */
export type FranchiseNode = {
  id: number;
  /** ANIME or MANGA — drives which user list lookup applies. */
  mediaType: 'ANIME' | 'MANGA';
  /** AniList format (TV, MOVIE, OVA, MANGA, NOVEL, ...) — null if missing. */
  format: string | null;
  title: string;
  titleSource: MediaTitleFields;
  coverImage: string | null;
  startDate: { year: number | null; month: number | null; day: number | null };
};

/** A franchise entry stamped with the seed's relation hop and the user's list status. */
export type FranchiseEntry = FranchiseNode & {
  /** True for the seed media itself. */
  isSeed: boolean;
  /** Null when the entry is not on the user's list at all (unwatched). */
  listStatus: string | null;
  /** Null when no score is set on the list entry. */
  score: number | null;
};

export type FranchiseResult =
  | { kind: 'empty'; message: string }
  | {
      kind: 'columns';
      seed: { id: number; title: string };
      entries: FranchiseEntry[];
    };

/**
 * Date sort key: YYYYMMDD as a number, with unknown parts filled in with `01`
 * so half-known dates anchor to the start of their year/month. Fully-missing
 * dates sort last via Number.MAX_SAFE_INTEGER.
 */
export function franchiseDateSortKey(date: FranchiseNode['startDate']): number {
  if (date.year == null) {
    return Number.MAX_SAFE_INTEGER;
  }
  const month = date.month ?? 1;
  const day = date.day ?? 1;
  return date.year * 10000 + month * 100 + day;
}

/** Short, chart-friendly label for the column header. */
export function franchiseDateLabel(date: FranchiseNode['startDate']): string {
  if (date.year == null) {
    return 'TBA';
  }
  if (date.month == null) {
    return String(date.year);
  }
  const MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ] as const;
  const monthLabel = MONTHS[Math.min(Math.max(date.month, 1), 12) - 1];
  return `${monthLabel} ${date.year}`;
}

/**
 * Score cell label. `U` = unwatched (entry isn't on the user's list at all),
 * `P` / `W` / `H` = unrated PLANNING / CURRENT|REPEATING / PAUSED,
 * `—` = on list but no score and no status letter, otherwise the score itself.
 *
 * Distinct from {@link formatSeasonalScoreLabel} because seasonal-scores only
 * ever shows shows already on the list — there's no "unwatched" bucket there.
 */
export function formatFranchiseScoreLabel(
  score: number | null | undefined,
  listStatus: string | null | undefined,
): string {
  if (listStatus == null) {
    return 'U';
  }
  const statusLabel = listStatusScoreLabel(listStatus, score);
  if (statusLabel != null) {
    return statusLabel;
  }
  const normalized = normalizeSeasonalListScore(score);
  return normalized == null ? '—' : String(normalized);
}

/**
 * Chip label for an entry: prefer the AniList `format` (TV / MOVIE / OVA /
 * MANGA / NOVEL / ...) and fall back to the `mediaType` (ANIME / MANGA)
 * when the format is missing. Centralized so the table cell and the CSV
 * export always agree on what shows next to a title.
 */
export function franchiseFormatLabel(
  entry: Pick<FranchiseEntry, 'format' | 'mediaType'>,
): string {
  return entry.format ?? entry.mediaType;
}

/**
 * RFC 4180 CSV escaping: wrap the value in double quotes when it contains
 * a comma, double quote, or any newline; double up embedded quotes inside
 * the wrapped form. Used by {@link buildFranchiseCsv}.
 */
export function csvEscapeFranchiseCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Build a CSV string for the franchise table — columns: Title, Format,
 * Score. The Score column uses the same display label the on-screen table
 * shows ({@link formatFranchiseScoreLabel}) so the export matches what
 * the user sees: `U` for unwatched, `P` for planning, `—` for "on list
 * but no score", otherwise the numeric score. Rows are CRLF-separated
 * per RFC 4180 so Excel opens it cleanly on Windows.
 */
export function buildFranchiseCsv(entries: FranchiseEntry[]): string {
  const header = ['Title', 'Format', 'Score'].join(',');
  const rows = entries.map((entry) =>
    [
      csvEscapeFranchiseCell(entry.title),
      csvEscapeFranchiseCell(franchiseFormatLabel(entry)),
      csvEscapeFranchiseCell(
        formatFranchiseScoreLabel(entry.score, entry.listStatus),
      ),
    ].join(','),
  );
  return [header, ...rows].join('\r\n');
}

/**
 * "Title (Format)" lines — one per entry, separated by `\n`. Plain text
 * intended for the "Copy" button (e.g. paste into Discord / a notes app
 * where a CSV would be noisy).
 */
export function buildFranchiseClipboardText(entries: FranchiseEntry[]): string {
  return entries
    .map((entry) => `${entry.title} (${franchiseFormatLabel(entry)})`)
    .join('\n');
}

/** Filter helper used by the BFS and reused by tests. */
export function enabledRelationTypes(
  toggles: Record<FranchiseRelationType, boolean>,
): Set<string> {
  const out = new Set<string>();
  for (const [type, enabled] of Object.entries(toggles)) {
    if (enabled) {
      out.add(type);
    }
  }
  return out;
}

/** One response from the relation-fetcher used by {@link bfsFranchiseRelations}. */
export type FranchiseRelationsResponse = {
  self: FranchiseNode | null;
  edges: Array<{ relationType: string; node: FranchiseNode }>;
};

export type BfsFranchiseOptions = {
  maxNodes?: number;
  /** Fires once per visited media id so the panel can show progress. */
  onProgress?: (info: { visited: number; queueDepth: number; lastTitle: string }) => void;
  signal?: AbortSignal;
};

/**
 * Walk franchise relations breadth-first from `seedId`, returning every node
 * reachable via the enabled relation types (bounded by `maxNodes`, default
 * 200, so a runaway "OTHER" web from a popular property can't drown the UI).
 * Pure-ish: relies on the injected `fetcher` so tests can stub the network.
 */
export async function bfsFranchiseRelations(
  seedId: number,
  toggles: Record<FranchiseRelationType, boolean>,
  fetcher: (id: number, signal?: AbortSignal) => Promise<FranchiseRelationsResponse | null>,
  options: BfsFranchiseOptions = {},
): Promise<Map<number, FranchiseNode>> {
  const enabled = enabledRelationTypes(toggles);
  const maxNodes = options.maxNodes ?? 200;
  const nodes = new Map<number, FranchiseNode>();
  const visitedFetches = new Set<number>();
  const queue: number[] = [seedId];

  while (queue.length > 0 && nodes.size < maxNodes) {
    options.signal?.throwIfAborted();
    const id = queue.shift()!;
    if (visitedFetches.has(id)) {
      continue;
    }
    visitedFetches.add(id);

    const response = await fetcher(id, options.signal);
    if (!response) {
      continue;
    }
    if (response.self && !nodes.has(response.self.id)) {
      nodes.set(response.self.id, response.self);
    }

    options.onProgress?.({
      visited: nodes.size,
      queueDepth: queue.length,
      lastTitle: response.self?.title ?? String(id),
    });

    for (const edge of response.edges) {
      if (!enabled.has(edge.relationType)) {
        continue;
      }
      const childId = edge.node.id;
      if (!nodes.has(childId)) {
        // Stamp metadata immediately from the edge — we may not get around to
        // fetching this child before maxNodes is reached, but it can still
        // appear in the chart with title/date from this edge alone.
        nodes.set(childId, edge.node);
      }
      if (nodes.size >= maxNodes) {
        break;
      }
      if (!visitedFetches.has(childId)) {
        queue.push(childId);
      }
    }
  }

  return nodes;
}

/**
 * Stamp BFS nodes with the user's list status/score and sort by start date.
 * Pure — the panel & tests both call this on already-fetched data.
 */
export function buildFranchiseEntries(
  seedId: number,
  nodes: ReadonlyMap<number, FranchiseNode>,
  userList: ReadonlyMap<number, { status: string | null; score: number | null }>,
): FranchiseEntry[] {
  const entries: FranchiseEntry[] = [];
  for (const node of nodes.values()) {
    const listEntry = userList.get(node.id) ?? null;
    entries.push({
      ...node,
      isSeed: node.id === seedId,
      listStatus: listEntry?.status ?? null,
      score: listEntry?.score ?? null,
    });
  }
  // Stable tiebreak on id keeps two same-date entries in a deterministic order.
  entries.sort((a, b) => {
    const keyA = franchiseDateSortKey(a.startDate);
    const keyB = franchiseDateSortKey(b.startDate);
    if (keyA !== keyB) {
      return keyA - keyB;
    }
    return a.id - b.id;
  });
  return entries;
}

/**
 * Apply the client-side {@link FranchiseFilters} to a result set.
 * Order of operations matches the user mental model:
 *   1. Media-type gate (anime/manga checkboxes). With both off the
 *      result is empty by design — the panel renders the "no entries"
 *      state in that case.
 *   2. List status chip. Passes when the entry's list status is in the
 *      selected set. Unwatched entries (no list row) pass only when all
 *      statuses are selected (the default — preserves "show everything").
 *   3. Rated/unrated bucket. An entry is "rated" iff it's on the
 *      user's list AND has a numeric score > 0 (matches AniList's
 *      POINT_100 convention where 0 = "I haven't scored this").
 *      Unrated status-letter entries (P / W / H) are treated as unrated
 *      because the table shows a letter instead of a score. Unwatched
 *      entries (no list row at all) are also unrated.
 *   4. Score range. Only narrows the rated bucket — unrated items
 *      pass the range check by virtue of being filtered out at step
 *      2 when the pill is 'rated', and pass through unchanged when
 *      the pill is 'any' or 'unrated' (the slider is meaningless
 *      against a missing score). Bounds are inclusive on both sides.
 */
export function applyFranchiseFilters(
  entries: readonly FranchiseEntry[],
  filters: FranchiseFilters,
): FranchiseEntry[] {
  if (!filters.includeAnime && !filters.includeManga) {
    return [];
  }
  const out: FranchiseEntry[] = [];
  for (const entry of entries) {
    if (entry.mediaType === 'ANIME' && !filters.includeAnime) continue;
    if (entry.mediaType === 'MANGA' && !filters.includeManga) continue;
    if (!entryPassesListStatusFilter(entry.listStatus, filters.listStatuses)) continue;

    const normalized = normalizeSeasonalListScore(entry.score);
    const statusLabel = listStatusScoreLabel(entry.listStatus, entry.score);
    const isRated =
      entry.listStatus != null &&
      statusLabel == null &&
      normalized != null;

    if (filters.userScoreInclude === 'rated' && !isRated) continue;
    if (filters.userScoreInclude === 'unrated' && isRated) continue;

    if (isRated) {
      if (filters.scoreMin != null && normalized! < filters.scoreMin) continue;
      if (filters.scoreMax != null && normalized! > filters.scoreMax) continue;
    }

    out.push(entry);
  }
  return out;
}
