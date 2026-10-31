import { extractCompletedRankingItems } from './slotResultsImport';
import {
  formatSortVersionDate,
  frozenVersion,
  newSortVersionId,
  normalizeSortVersions,
  onlyNewestLive,
  sortVersionItem,
} from './sortVersionShape';
import type { AutosaveBlob } from './storage';
import type { Item, ItemId, SortVersion, SortVersionItem } from './types';

export { formatSortVersionDate, newSortVersionId, normalizeSortVersions };

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

export function sameRanking(a: readonly ItemId[], b: readonly ItemId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
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
 * (it was a real earlier ranking); an identical ranking is not appended twice.
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
  if (latest && sameRanking(latest.rankedIds, snap.rankedIds)) return base;
  return [...base, snap];
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
  if (latest && sameRanking(latest.rankedIds, snap.rankedIds)) return versions;
  const live: SortVersion = { ...snap, live: true };
  if (latest?.live) return [...versions.slice(0, -1), { ...live, id: latest.id }];
  return [...versions, live];
}

export type SortVersionMove = { id: ItemId; from: number; to: number; delta: number };

export type SortVersionDiff = {
  added: ItemId[];
  removed: ItemId[];
  /** Biggest moves first; `delta > 0` means moved up. Ranks are 1-based. */
  moved: SortVersionMove[];
};

export function diffSortVersions(prev: SortVersion | null, next: SortVersion): SortVersionDiff {
  if (!prev) return { added: [], removed: [], moved: [] };
  const prevRank = new Map(prev.rankedIds.map((id, i) => [id, i + 1]));
  const nextIds = new Set(next.rankedIds);
  const added: ItemId[] = [];
  const moved: SortVersionMove[] = [];
  next.rankedIds.forEach((id, i) => {
    const from = prevRank.get(id);
    if (from === undefined) {
      added.push(id);
    } else if (from !== i + 1) {
      moved.push({ id, from, to: i + 1, delta: from - (i + 1) });
    }
  });
  const removed = prev.rankedIds.filter((id) => !nextIds.has(id));
  moved.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.to - b.to);
  return { added, removed, moved };
}

/** e.g. "3 added, 1 removed · Steins;Gate ↑4, Your Name ↓2". */
export function summarizeSortVersionDiff(
  prev: SortVersion | null,
  next: SortVersion,
  maxMoves = 3,
): string {
  if (!prev) return 'First version';
  const diff = diffSortVersions(prev, next);
  const counts: string[] = [];
  if (diff.added.length) counts.push(`${diff.added.length} added`);
  if (diff.removed.length) counts.push(`${diff.removed.length} removed`);
  const moves = diff.moved
    .slice(0, maxMoves)
    .map((m) => `${next.items[m.id]?.label ?? m.id} ${m.delta > 0 ? '↑' : '↓'}${Math.abs(m.delta)}`);
  const extra = diff.moved.length - moves.length;
  if (extra > 0) moves.push(`+${extra} more moved`);
  const parts = [counts.join(', '), moves.join(', ')].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No changes';
}

export type SortVersionCountKind = 'up' | 'down' | 'added' | 'removed';
export type SortVersionCount = { kind: SortVersionCountKind; count: number };

/** Non-zero change counts in display order; null for the first version. */
export function sortVersionDiffCounts(
  prev: SortVersion | null,
  next: SortVersion,
): SortVersionCount[] | null {
  if (!prev) return null;
  const diff = diffSortVersions(prev, next);
  const up = diff.moved.filter((m) => m.delta > 0).length;
  const counts: SortVersionCount[] = [
    { kind: 'up', count: up },
    { kind: 'down', count: diff.moved.length - up },
    { kind: 'added', count: diff.added.length },
    { kind: 'removed', count: diff.removed.length },
  ];
  return counts.filter(({ count }) => count > 0);
}

/** Compact counts, e.g. "3 up · 2 down · 1 added · 1 removed". */
export function countSortVersionDiff(prev: SortVersion | null, next: SortVersion): string {
  const counts = sortVersionDiffCounts(prev, next);
  if (!counts) return 'First version';
  if (counts.length === 0) return 'No changes';
  return counts.map(({ kind, count }) => `${count} ${kind}`).join(' · ');
}

/** Versions carried by a source save plus its own current ranking, dated `createdAt`. */
export function versionsFromImportSource(
  blob: RankedBlob & { versions?: readonly SortVersion[] },
  createdAt: string,
): SortVersion[] {
  const nested = normalizeSortVersions(blob.versions) ?? [];
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
 * Combine existing and imported versions by `createdAt`, drop any whose ranking
 * matches its direct predecessor, and assign fresh ids. Existing wins date ties.
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
    if (prev && sameRanking(prev.rankedIds, v.rankedIds)) {
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
