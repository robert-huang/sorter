import { describe, expect, it } from 'vitest';
import { seedAsSorted } from '../insertionSort';
import { versionImportsForSlot, type SlotImportEntry } from '../slotResultsImport';
import {
  appendVersionIfChanged,
  diffSortVersions,
  formatSortVersionDate,
  mergeImportedVersions,
  normalizeSortVersions,
  countSortVersionDiff,
  shouldAutoRecordVersion,
  snapshotSortVersion,
  summarizeSortVersionDiff,
  upsertLiveVersion,
  versionsFromImportSource,
} from '../sortVersions';
import type { AutosaveBlob } from '../storage';
import type { Item, SortVersion } from '../types';

const A: Item = { id: 'AAAAAAAAAAAAAA', label: 'Alpha', url: 'https://a.example' };
const B: Item = { id: 'BBBBBBBBBBBBBQ', label: 'Beta' };
const C: Item = { id: 'QQQQQQQQQQQQQg', label: 'Gamma', imageUrl: 'https://c.example/c.png' };
const D: Item = { id: 'wwwwwwwwwwwwww', label: 'Delta' };

function doneBlob(order: Item[]): AutosaveBlob {
  const state = seedAsSorted(order);
  return { items: state.items, progress: state, undoRing: [] };
}

function inProgressBlob(order: Item[]): AutosaveBlob {
  const blob = doneBlob(order);
  return { ...blob, progress: { ...blob.progress, done: false } };
}

function version(order: Item[], createdAt: string, id = createdAt): SortVersion {
  return {
    id,
    createdAt,
    rankedIds: order.map((it) => it.id),
    items: Object.fromEntries(order.map((it) => [it.id, { label: it.label }])),
  };
}

const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-10T10:00:00.000Z';
const T3 = '2026-10-20T10:00:00.000Z';

describe('appendVersionIfChanged', () => {
  it('records the first finished ranking with copied display fields', () => {
    const next = appendVersionIfChanged([], doneBlob([A, B, C]), new Date(T1));
    expect(next).toHaveLength(1);
    expect(next[0]!.createdAt).toBe(T1);
    expect(next[0]!.rankedIds).toEqual([A.id, B.id, C.id]);
    expect(next[0]!.items[A.id]).toEqual({ label: 'Alpha', url: 'https://a.example' });
    expect(next[0]!.items[C.id]).toEqual({ label: 'Gamma', imageUrl: 'https://c.example/c.png' });
  });

  it('returns the same array when the ranking is unchanged or the sort is not done', () => {
    const first = appendVersionIfChanged([], doneBlob([A, B]), new Date(T1));
    expect(appendVersionIfChanged(first, doneBlob([A, B]), new Date(T2))).toBe(first);
    expect(appendVersionIfChanged(first, inProgressBlob([B, A]), new Date(T2))).toBe(first);
  });

  it('records a reopened sort only when it finishes in a different order', () => {
    // Finish, reopen (not done), finish again unchanged, then finish with a new order.
    let versions = appendVersionIfChanged([], doneBlob([A, B]), new Date(T1));
    versions = appendVersionIfChanged(versions, inProgressBlob([A, B, C]), new Date(T2));
    versions = appendVersionIfChanged(versions, doneBlob([A, B]), new Date(T2));
    expect(versions).toHaveLength(1);
    versions = appendVersionIfChanged(versions, doneBlob([A, C, B]), new Date(T3));
    expect(versions.map((v) => v.rankedIds)).toEqual([
      [A.id, B.id],
      [A.id, C.id, B.id],
    ]);
  });

  it('ignores a finished sort with nothing ranked', () => {
    expect(appendVersionIfChanged([], doneBlob([]), new Date(T1))).toEqual([]);
  });

  it('freezes a live newest version and appends the new ranking after it', () => {
    const live = { ...version([B, A], T2, 'live'), live: true as const };
    const next = appendVersionIfChanged([version([A, B], T1), live], doneBlob([C, B, A]), new Date(T3));
    expect(next.map((v) => [v.rankedIds, v.live])).toEqual([
      [[A.id, B.id], undefined],
      [[B.id, A.id], undefined],
      [[C.id, B.id, A.id], undefined],
    ]);
  });

  it('freezes a live version that already matches instead of duplicating it', () => {
    const live = { ...version([B, A], T2, 'live'), live: true as const };
    const next = appendVersionIfChanged([live], doneBlob([B, A]), new Date(T3));
    expect(next).toHaveLength(1);
    expect(next[0]!.live).toBeUndefined();
    expect(next[0]!.createdAt).toBe(T2);
  });
});

describe('upsertLiveVersion', () => {
  it('starts a live version after a frozen one when the ranking moved', () => {
    const frozen = [version([A, B], T1)];
    const next = upsertLiveVersion(frozen, doneBlob([B, A]), new Date(T2));
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ rankedIds: [B.id, A.id], createdAt: T2, live: true });
  });

  it('updates the live version in place, keeping its id', () => {
    const live = { ...version([B, A], T2, 'live'), live: true as const };
    const next = upsertLiveVersion([version([A, B], T1), live], doneBlob([C, A, B]), new Date(T3));
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ id: 'live', rankedIds: [C.id, A.id, B.id], createdAt: T3, live: true });
  });

  it('returns the same array when the newest version already matches or the sort is open', () => {
    const versions = [version([A, B], T1)];
    expect(upsertLiveVersion(versions, doneBlob([A, B]), new Date(T2))).toBe(versions);
    expect(upsertLiveVersion(versions, inProgressBlob([B, A]), new Date(T2))).toBe(versions);
  });
});

describe('diffSortVersions / summarizeSortVersionDiff', () => {
  it('reports added, removed and the biggest moves first', () => {
    const prev = version([A, B, C, D], T1);
    const next = version([D, A, B, { id: 'gggggggggggggg', label: 'Epsilon' }], T2);
    const diff = diffSortVersions(prev, next);
    expect(diff.added).toEqual(['gggggggggggggg']);
    expect(diff.removed).toEqual([C.id]);
    expect(diff.moved[0]).toEqual({ id: D.id, from: 4, to: 1, delta: 3 });
    expect(summarizeSortVersionDiff(prev, next)).toBe(
      '1 added, 1 removed · Delta ↑3, Alpha ↓1, Beta ↓1',
    );
  });

  it('labels the oldest version and an unchanged one', () => {
    const v = version([A, B], T1);
    expect(summarizeSortVersionDiff(null, v)).toBe('First version');
    expect(summarizeSortVersionDiff(v, version([A, B], T2))).toBe('No changes');
  });

  it('collapses moves beyond the limit', () => {
    const prev = version([A, B, C, D], T1);
    const next = version([D, C, B, A], T2);
    // Equal moves are listed by their new rank.
    expect(summarizeSortVersionDiff(prev, next, 2)).toBe('Delta ↑3, Alpha ↓3, +2 more moved');
  });
});

describe('mergeImportedVersions', () => {
  it('orders by date, keeps existing versions and assigns fresh ids', () => {
    const existing = [version([A, B, C], T3, 'existing')];
    const result = mergeImportedVersions(existing, [
      version([C, B, A], T2, 'imp2'),
      version([B, A, C], T1, 'imp1'),
    ]);
    expect(result.versions.map((v) => v.createdAt)).toEqual([T1, T2, T3]);
    expect(result.versions[2]!.rankedIds).toEqual([A.id, B.id, C.id]);
    expect(result.versions.map((v) => v.id)).not.toContain('existing');
    expect(result).toMatchObject({ added: 2, skipped: 0 });
  });

  it('drops a version identical to its direct predecessor', () => {
    const result = mergeImportedVersions(
      [version([A, B], T3)],
      [version([B, A], T1), version([B, A], T2)],
    );
    expect(result.versions.map((v) => v.createdAt)).toEqual([T1, T3]);
    expect(result).toMatchObject({ added: 1, skipped: 1 });
  });

  it("imports a source's nested versions along with its current ranking", () => {
    const source = { ...doneBlob([A, C, B]), versions: [version([A, B, C], T1)] };
    const imported = versionsFromImportSource(source, T2);
    expect(imported.map((v) => [v.createdAt, v.rankedIds])).toEqual([
      [T1, [A.id, B.id, C.id]],
      [T2, [A.id, C.id, B.id]],
    ]);
    const result = mergeImportedVersions([version([A, C, B], T3)], imported);
    // The T3 existing version matches the imported T2 ranking, so it is the one dropped.
    expect(result.versions.map((v) => v.createdAt)).toEqual([T1, T2]);
    expect(result).toMatchObject({ added: 2, skipped: 1 });
  });

  it('keeps live only on the newest version and freezes imported live versions', () => {
    const existingLive = { ...version([A, B], T2, 'mine'), live: true as const };
    const importedLive = { ...version([B, A], T3, 'theirs'), live: true as const };
    const result = mergeImportedVersions([existingLive], [importedLive]);
    expect(result.versions.map((v) => v.live)).toEqual([undefined, undefined]);
    const kept = mergeImportedVersions([existingLive], [version([B, A], T1)]);
    expect(kept.versions.map((v) => v.live)).toEqual([undefined, true]);
  });
});

describe('normalizeSortVersions', () => {
  it('keeps the live flag only on the newest version', () => {
    const raw = [
      { ...version([A, B], T1, 'one'), live: true },
      { ...version([B, A], T2, 'two'), live: true },
    ];
    expect(normalizeSortVersions(raw)!.map((v) => v.live)).toEqual([undefined, true]);
  });

  it('drops malformed entries and unknown ranked ids', () => {
    const raw = [
      version([A, B], T1, 'ok'),
      { id: 'bad-date', createdAt: 'nope', rankedIds: [A.id], items: { [A.id]: { label: 'x' } } },
      { createdAt: T2, rankedIds: [A.id, 'missing'], items: { [A.id]: { label: 7 } } },
      'junk',
    ];
    const out = normalizeSortVersions(raw)!;
    expect(out).toHaveLength(2);
    expect(out[0]!.id).toBe('ok');
    expect(out[1]!.rankedIds).toEqual([A.id]);
    expect(out[1]!.items[A.id]).toEqual({ label: A.id });
    expect(out[1]!.id).toMatch(/^v/);
  });

  it('returns undefined when nothing valid remains', () => {
    expect(normalizeSortVersions(undefined)).toBeUndefined();
    expect(normalizeSortVersions([{ nope: true }])).toBeUndefined();
  });
});

describe('versionImportsForSlot', () => {
  const entry = (versions: SortVersion[]): SlotImportEntry => ({
    meta: {
      id: 'slot',
      name: 'Top anime',
      createdAt: T1,
      updatedAt: T3,
      totalItems: 3,
      comparisons: 3,
      done: true,
    },
    status: 'importable',
    itemCount: 3,
    items: [
      { ...A, source: { kind: 'anilist', externalId: 1 } },
      B,
      C,
    ],
    versions,
  });

  it('emits picked versions oldest first named by date, keeping live item metadata', () => {
    const v1 = version([B, A], '2026-10-01T09:00:00');
    const v2 = version([A, B, C], '2026-10-05T09:00:00');
    const v3 = version([C, B, A], '2026-10-09T09:00:00');
    const imports = versionImportsForSlot(entry([v1, v2, v3]), new Set([v3.id, v1.id]), 'Sort: Top anime', 'Top anime');
    expect(imports.map((imp) => imp.slotName)).toEqual([
      'Top anime · 2026-10-01',
      'Top anime · 2026-10-09',
    ]);
    expect(imports[0]!.items.map((it) => it.id)).toEqual([B.id, A.id]);
    expect(imports[0]!.items[1]).toEqual({
      id: A.id,
      label: 'Alpha',
      source: { kind: 'anilist', externalId: 1 },
    });
    expect(imports[0]).toMatchObject({ source: 'Sort: Top anime', versionId: v1.id });
  });

  it('adds the time when two picked versions share a date', () => {
    const morning = version([A, B], '2026-10-28T09:05:00');
    const evening = version([B, A], '2026-10-28T14:05:00');
    const imports = versionImportsForSlot(entry([morning, evening]), new Set([morning.id, evening.id]), 's', 'Top anime');
    expect(imports.map((imp) => imp.slotName)).toEqual([
      `Top anime · ${formatSortVersionDate(morning.createdAt, true)}`,
      `Top anime · ${formatSortVersionDate(evening.createdAt, true)}`,
    ]);
    expect(imports[0]!.slotName).toBe('Top anime · 2026-10-28 09:05');
  });
});

describe('snapshotSortVersion', () => {
  it('returns null for an unfinished sort', () => {
    expect(snapshotSortVersion(inProgressBlob([A, B]), T1)).toBeNull();
  });
});

describe('countSortVersionDiff', () => {
  it('counts moves up and down, additions and removals', () => {
    const prev = version([A, B, C, D], T1);
    const next = version([C, A, B], T2);
    expect(countSortVersionDiff(prev, next)).toBe('1 up · 2 down · 1 removed');
    expect(countSortVersionDiff(next, version([C, A, B, D], T3))).toBe('1 added');
  });

  it('reports the first and unchanged versions', () => {
    const only = version([A, B], T1);
    expect(countSortVersionDiff(null, only)).toBe('First version');
    expect(countSortVersionDiff(only, version([A, B], T2))).toBe('No changes');
  });
});

describe('shouldAutoRecordVersion', () => {
  const base = { wasDone: false, isDone: true, isLoad: false, hasVersions: true };

  it('records when a sort goes from in-progress to done', () => {
    expect(shouldAutoRecordVersion(base)).toBe(true);
  });

  it('does not record a reorder inside a finished sort', () => {
    expect(shouldAutoRecordVersion({ ...base, wasDone: true })).toBe(false);
  });

  it('does not record while in progress', () => {
    expect(shouldAutoRecordVersion({ ...base, isDone: false })).toBe(false);
  });

  it('treats loading a finished save as a baseline only when it has no history', () => {
    expect(shouldAutoRecordVersion({ ...base, isLoad: true })).toBe(false);
    expect(shouldAutoRecordVersion({ ...base, isLoad: true, hasVersions: false })).toBe(true);
  });
});
