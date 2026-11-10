import { extractCompletedRankingItems } from './slotResultsImport';
import {
  formatSortVersionDate,
  frozenVersion,
  newSortVersionId,
  normalizeSortVersions,
  onlyNewestLive,
  sameVersionContent,
  sortVersionItem,
  sortVersionLabel,
  versionItemRenamed,
  withSortVersionName,
} from './sortVersionShape';
import type { AutosaveBlob } from './storage';
import type { Item, ItemId, SortVersion, SortVersionItem } from './types';

export {
  formatSortVersionDate,
  newSortVersionId,
  normalizeSortVersions,
  sameVersionContent,
  sortVersionLabel,
  withSortVersionName,
};

type RankedBlob = Pick<AutosaveBlob, 'items' | 'progress'>;

/** Version snapshot of an already-ranked item list (best→worst); null when empty. */
export function snapshotFromRankedItems(
  ranked: readonly Item[],
  createdAt: string,
): SortVersion | null {
  if (ranked.length === 0) return null;
  const items: Record<ItemId, SortVersionItem> = {};
  for (const item of ranked) items[item.id] = sortVersionItem(item);
  return { id: newSortVersionId(), createdAt, rankedIds: ranked.map((it) => it.id), items };
}

/** Completed ranking of a blob as a version snapshot; null when not done or empty. */
export function snapshotSortVersion(blob: RankedBlob, createdAt: string): SortVersion | null {
  if (!blob.progress.done) return null;
  return snapshotFromRankedItems(extractCompletedRankingItems(blob as AutosaveBlob), createdAt);
}

/**
 * Automatic freezing: a sort going from in-progress to done records, and a loaded
 * finished save with no history gets a baseline. Reordering a finished sort only
 * updates the live version (see `upsertLiveVersion`).
 */
export function shouldAutoRecordVersion(transition: {
  wasDone: boolean;
  isDone: boolean;
  isLoad: boolean;
  hasVersions: boolean;
}): boolean {
  if (!transition.isDone) return false;
  if (transition.isLoad) return !transition.hasVersions;
  return !transition.wasDone;
}

/**
 * Records the ranking as a frozen version. A live newest version is frozen as-is first
 * (it was a real earlier ranking); an identical ranking with the same custom names
 * and images is not appended twice.
 * Same array back when nothing changes (or the sort isn't done).
 */
export function appendVersionIfChanged(
  versions: readonly SortVersion[],
  blob: RankedBlob,
  now: Date,
): readonly SortVersion[] {
  const snap = snapshotSortVersion(blob, now.toISOString());
  if (!snap) return versions;
  const latest = versions[versions.length - 1];
  const base = latest?.live ? [...versions.slice(0, -1), frozenVersion(latest)] : versions;
  if (latest && sameVersionContent(latest, snap)) return base;
  return [...base, snap];
}

/** Sets (trimmed) or clears (blank) one version's name; same array back when nothing changes. */
export function renameSortVersion(
  versions: readonly SortVersion[],
  id: string,
  name: string,
): readonly SortVersion[] {
  const named = withSortVersionName(name);
  const target = versions.find((v) => v.id === id);
  if (!target || target.name === named.name) return versions;
  const { name: _old, ...rest } = target;
  const renamed: SortVersion = { ...rest, ...named };
  return versions.map((v) => (v === target ? renamed : v));
}

/**
 * Keeps the newest version in step with a finished sort's current ranking: updates the
 * live version in place, or starts one after a frozen version. Same array back when the
 * newest version already matches.
 */
export function upsertLiveVersion(
  versions: readonly SortVersion[],
  blob: RankedBlob,
  now: Date,
): readonly SortVersion[] {
  const snap = snapshotSortVersion(blob, now.toISOString());
  if (!snap) return versions;
  const latest = versions[versions.length - 1];
  if (latest && sameVersionContent(latest, snap)) return versions;
  const live: SortVersion = { ...snap, live: true };
  if (latest?.live) {
    return [
      ...versions.slice(0, -1),
      { ...live, id: latest.id, ...withSortVersionName(latest.name) },
    ];
  }
  return [...versions, live];
}

export type SortVersionMove = { id: ItemId; from: number; to: number; delta: number };

export type SortVersionDiff = {
  added: ItemId[];
  removed: ItemId[];
  /** Biggest moves first; `delta > 0` means moved up. Ranks are 1-based. */
  moved: SortVersionMove[];
  /** In both, with a custom name added, changed or reset; in `next`'s order. */
  renamed: ItemId[];
};

/**
 * How moves are counted:
 * - `ordering`: only items whose order against the other kept items changed. Moving one
 *   item 60 places is 1 move; delta is its shift among kept items.
 * - `raw`: every item whose rank number changed, including ones that only slid to make room.
 */
export type SortVersionMovementMode = 'ordering' | 'raw';

export const DEFAULT_SORT_VERSION_MOVEMENT_MODE: SortVersionMovementMode = 'ordering';

/**
 * For each index of `values` (a permutation of 0..n-1), the length of the longest strictly
 * increasing run ending there. Fenwick tree of prefix maxima over values, O(n log n).
 */
function increasingRunLengths(values: readonly number[]): number[] {
  const tree = new Array<number>(values.length + 1).fill(0);
  return values.map((value) => {
    let before = 0;
    for (let k = value; k > 0; k -= k & -k) before = Math.max(before, tree[k]!);
    for (let k = value + 1; k <= values.length; k += k & -k) tree[k] = Math.max(tree[k]!, before + 1);
    return before + 1;
  });
}

/**
 * Indices that belong to every longest strictly increasing subsequence of `values`.
 * An index is on some longest run when the runs ending and starting there add up to the
 * longest length, and on all of them when it's the only such index at its run position.
 */
function alwaysInLongestRun(values: readonly number[]): Set<number> {
  const n = values.length;
  const ending = increasingRunLengths(values);
  const starting = increasingRunLengths(values.map((v) => n - 1 - v).reverse()).reverse();
  const longest = ending.reduce((max, length) => Math.max(max, length), 0);
  const onSomeRun = values.map((_, i) => ending[i]! + starting[i]! - 1 === longest);
  const atPosition = new Map<number, number>();
  onSomeRun.forEach((on, i) => {
    if (on) atPosition.set(ending[i]!, (atPosition.get(ending[i]!) ?? 0) + 1);
  });
  const always = new Set<number>();
  onSomeRun.forEach((on, i) => {
    if (on && atPosition.get(ending[i]!) === 1) always.add(i);
  });
  return always;
}

function rawMoves(prevRank: ReadonlyMap<ItemId, number>, next: SortVersion): SortVersionMove[] {
  const moved: SortVersionMove[] = [];
  next.rankedIds.forEach((id, i) => {
    const from = prevRank.get(id);
    if (from !== undefined && from !== i + 1) {
      moved.push({ id, from, to: i + 1, delta: from - (i + 1) });
    }
  });
  return moved;
}

/**
 * Items that aren't part of every longest run kept in the same relative order. A single
 * long move stays 1 move: A B C D → B C D A is A ↓3, not 4. When runs tie, every item
 * whose place is ambiguous counts: A B → B A moves both (B ↑1, A ↓1).
 */
function orderingMoves(
  prev: SortVersion,
  prevRank: ReadonlyMap<ItemId, number>,
  next: SortVersion,
): SortVersionMove[] {
  const nextIds = new Set(next.rankedIds);
  const prevKept = prev.rankedIds.filter((id) => nextIds.has(id));
  const prevPos = new Map(prevKept.map((id, i) => [id, i]));
  const nextKept = next.rankedIds.filter((id) => prevPos.has(id));
  const nextRank = new Map(next.rankedIds.map((id, i) => [id, i + 1]));
  const stayed = alwaysInLongestRun(nextKept.map((id) => prevPos.get(id)!));
  const moved: SortVersionMove[] = [];
  nextKept.forEach((id, i) => {
    const delta = prevPos.get(id)! - i;
    if (stayed.has(i) || delta === 0) return;
    moved.push({ id, from: prevRank.get(id)!, to: nextRank.get(id)!, delta });
  });
  return moved;
}

export function diffSortVersions(
  prev: SortVersion | null,
  next: SortVersion,
  mode: SortVersionMovementMode = DEFAULT_SORT_VERSION_MOVEMENT_MODE,
): SortVersionDiff {
  if (!prev) return { added: [], removed: [], moved: [], renamed: [] };
  const prevRank = new Map(prev.rankedIds.map((id, i) => [id, i + 1]));
  const nextIds = new Set(next.rankedIds);
  const added = next.rankedIds.filter((id) => !prevRank.has(id));
  const moved =
    mode === 'raw' ? rawMoves(prevRank, next) : orderingMoves(prev, prevRank, next);
  const removed = prev.rankedIds.filter((id) => !nextIds.has(id));
  moved.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.to - b.to);
  const renamed = next.rankedIds.filter((id) => {
    const before = prev.items[id];
    const after = next.items[id];
    return before && after && versionItemRenamed(id, before, after);
  });
  return { added, removed, moved, renamed };
}

/** e.g. "3 new, 1 removed, 1 renamed · Steins;Gate ↑4, Your Name ↓2". */
export function summarizeSortVersionDiff(
  prev: SortVersion | null,
  next: SortVersion,
  mode: SortVersionMovementMode = DEFAULT_SORT_VERSION_MOVEMENT_MODE,
  maxMoves = 3,
): string {
  if (!prev) return 'First version';
  const diff = diffSortVersions(prev, next, mode);
  const counts: string[] = [];
  if (diff.added.length) counts.push(`${diff.added.length} new`);
  if (diff.removed.length) counts.push(`${diff.removed.length} removed`);
  if (diff.renamed.length) counts.push(`${diff.renamed.length} renamed`);
  const moves = diff.moved
    .slice(0, maxMoves)
    .map((m) => `${next.items[m.id]?.label ?? m.id} ${m.delta > 0 ? '↑' : '↓'}${Math.abs(m.delta)}`);
  const extra = diff.moved.length - moves.length;
  if (extra > 0) moves.push(`+${extra} more moved`);
  const parts = [counts.join(', '), moves.join(', ')].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No changes';
}

export type SortVersionCountKind = 'up' | 'down' | 'added' | 'removed' | 'renamed';
export type SortVersionCount = { kind: SortVersionCountKind; count: number };

/** Non-zero change counts in display order; null for the first version. */
export function sortVersionDiffCounts(
  prev: SortVersion | null,
  next: SortVersion,
  mode: SortVersionMovementMode = DEFAULT_SORT_VERSION_MOVEMENT_MODE,
): SortVersionCount[] | null {
  if (!prev) return null;
  const diff = diffSortVersions(prev, next, mode);
  const up = diff.moved.filter((m) => m.delta > 0).length;
  const counts: SortVersionCount[] = [
    { kind: 'up', count: up },
    { kind: 'down', count: diff.moved.length - up },
    { kind: 'added', count: diff.added.length },
    { kind: 'removed', count: diff.removed.length },
    { kind: 'renamed', count: diff.renamed.length },
  ];
  return counts.filter(({ count }) => count > 0);
}

/** Display word for each count kind; `added` items read as "new". */
export const SORT_VERSION_COUNT_WORDS: Readonly<Record<SortVersionCountKind, string>> = {
  up: 'up',
  down: 'down',
  added: 'new',
  removed: 'removed',
  renamed: 'renamed',
};

/** Compact counts, e.g. "3 up · 2 down · 1 new · 1 removed · 1 renamed". */
export function countSortVersionDiff(
  prev: SortVersion | null,
  next: SortVersion,
  mode: SortVersionMovementMode = DEFAULT_SORT_VERSION_MOVEMENT_MODE,
): string {
  const counts = sortVersionDiffCounts(prev, next, mode);
  if (!counts) return 'First version';
  if (counts.length === 0) return 'No changes';
  return counts.map(({ kind, count }) => `${count} ${SORT_VERSION_COUNT_WORDS[kind]}`).join(' · ');
}

/** Versions carried by a source save plus its own current ranking, dated `createdAt`. */
export function versionsFromImportSource(
  blob: RankedBlob & { versions?: readonly SortVersion[] },
  createdAt: string,
): SortVersion[] {
  const nested = [...(blob.versions ?? [])];
  const current = snapshotSortVersion(blob, createdAt);
  return current ? [...nested, current] : nested;
}

export type MergedSortVersions = {
  versions: SortVersion[];
  /** Imported versions that survived the merge. */
  added: number;
  /** Versions dropped because they matched their direct predecessor. */
  skipped: number;
  /** Indexes into `existing` that were dropped. */
  skippedExisting: ReadonlySet<number>;
  /** Indexes into `imported` that were dropped. */
  skippedImported: ReadonlySet<number>;
};

/**
 * Combine existing and imported versions by `createdAt`, drop any matching its direct
 * predecessor (`sameVersionContent`), and assign fresh ids. Existing wins date ties.
 */
export function mergeImportedVersions(
  existing: readonly SortVersion[],
  imported: readonly SortVersion[],
): MergedSortVersions {
  const tagged = [
    ...existing.map((v, index) => ({ v, index, imported: false })),
    // Another save's live version is archived history here.
    ...imported.map((v, index) => ({ v: frozenVersion(v), index, imported: true })),
  ];
  // Array.prototype.sort is stable, so equal dates keep existing-before-imported.
  tagged.sort((a, b) => Date.parse(a.v.createdAt) - Date.parse(b.v.createdAt));
  const versions: SortVersion[] = [];
  const skippedExisting = new Set<number>();
  const skippedImported = new Set<number>();
  let added = 0;
  for (const { v, index, imported: isImported } of tagged) {
    const prev = versions[versions.length - 1];
    if (prev && sameVersionContent(prev, v)) {
      // The surviving copy inherits a name only the dropped duplicate had.
      if (!prev.name && v.name) versions[versions.length - 1] = { ...prev, name: v.name };
      (isImported ? skippedImported : skippedExisting).add(index);
      continue;
    }
    versions.push({ ...v, id: newSortVersionId() });
    if (isImported) added++;
  }
  return {
    versions: onlyNewestLive(versions),
    added,
    skipped: tagged.length - versions.length,
    skippedExisting,
    skippedImported,
  };
}
