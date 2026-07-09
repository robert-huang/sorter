import { describe, expect, it } from 'vitest';
import { seedAsSorted } from '../insertionSort';
import { initSort } from '../queueMergeSort';
import type { AutosaveBlob } from '../storage';
import type { Item, MergeProgress, SlotMeta } from '../types';
import {
  classifySlotImport,
  extractCompletedRankingItems,
  filterItemsNotInSort,
  listSlotImportEntries,
  slotImportSourceLabel,
  slotImportStatusLabel,
} from '../slotResultsImport';

const A: Item = { id: 'a', label: 'Alpha' };
const B: Item = { id: 'b', label: 'Beta' };
const C: Item = { id: 'c', label: 'Gamma' };

function meta(overrides: Partial<SlotMeta> = {}): SlotMeta {
  return {
    id: 'slot1',
    name: 'My sort',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    totalItems: 3,
    comparisons: 5,
    done: true,
    ...overrides,
  };
}

function insertionDoneBlob(): AutosaveBlob {
  const state = seedAsSorted([A, B, C]);
  return {
    items: state.items,
    progress: {
      engine: 'insertion',
      sorted: state.sorted,
      pending: state.pending,
      current: state.current,
      comparisons: state.comparisons,
      done: state.done,
      hidden: state.hidden,
      totalComparisonsEverNeeded: state.totalComparisonsEverNeeded,
      pendingRunIds: state.pendingRunIds,
      activeRunId: state.activeRunId,
      activeRunAnchor: state.activeRunAnchor,
    },
    undoRing: [],
  };
}

function mergeDoneBlob(hidden: string[] = [], toBeInserted: string[] = []): AutosaveBlob {
  const progress: MergeProgress = {
    engine: 'merge',
    queue: [['a', 'b', 'c']],
    current: null,
    comparisons: 3,
    done: true,
    hidden,
    totalComparisonsEverNeeded: 3,
    toBeInserted,
    pendingManualInserts: [],
    currentManualInsert: null,
    currentAutoInsert: null,
  };
  return {
    items: { a: A, b: B, c: C },
    progress,
    undoRing: [],
  };
}

describe('extractCompletedRankingItems', () => {
  it('returns insertion final ranking excluding hidden', () => {
    const blob = insertionDoneBlob();
    blob.progress.hidden = ['b'];
    expect(extractCompletedRankingItems(blob).map((it) => it.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('returns merge final ranking excluding hidden and toBeInserted', () => {
    const blob = mergeDoneBlob(['b'], ['c']);
    expect(extractCompletedRankingItems(blob).map((it) => it.id)).toEqual(['a']);
  });
});

describe('classifySlotImport', () => {
  it('marks completed slots with items as importable', () => {
    const entry = classifySlotImport(meta(), insertionDoneBlob());
    expect(entry.status).toBe('importable');
    expect(entry.itemCount).toBe(3);
    expect(entry.items?.map((it) => it.label)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('marks in-progress slots', () => {
    const inProgress = initSort([A, B, C], { shuffleAtStart: false });
    const blob: AutosaveBlob = {
      items: inProgress.items,
      progress: {
        engine: 'merge',
        queue: inProgress.queue,
        current: inProgress.current,
        comparisons: inProgress.comparisons,
        done: false,
        hidden: [],
        totalComparisonsEverNeeded: inProgress.totalComparisonsEverNeeded,
        toBeInserted: [],
        pendingManualInserts: [],
        currentManualInsert: null,
        currentAutoInsert: null,
      },
      undoRing: [],
    };
    const entry = classifySlotImport(meta({ done: false }), blob);
    expect(entry.status).toBe('in_progress');
  });

  it('excludes the active slot id', () => {
    const entry = classifySlotImport(
      meta({ id: 'active' }),
      insertionDoneBlob(),
      { excludeSlotId: 'active' },
    );
    expect(entry.status).toBe('excluded');
  });

  it('marks missing blobs unreadable', () => {
    expect(classifySlotImport(meta(), null).status).toBe('unreadable');
  });

  it('marks done slots with no visible ranking as empty', () => {
    const blob = mergeDoneBlob(['a', 'b', 'c']);
    expect(classifySlotImport(meta(), blob).status).toBe('empty');
  });
});

describe('listSlotImportEntries', () => {
  it('sorts by updatedAt descending', () => {
    const entries = listSlotImportEntries({
      version: 1,
      activeId: 'old',
      slots: [
        meta({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
        meta({ id: 'new', updatedAt: '2026-02-01T00:00:00.000Z' }),
      ],
    });
    expect(entries.map((e) => e.meta.id)).toEqual(['new', 'old']);
  });
});

describe('filterItemsNotInSort', () => {
  it('drops ids already in the active sort', () => {
    const out = filterItemsNotInSort([A, B, C], new Set(['b']));
    expect(out.map((it) => it.id)).toEqual(['a', 'c']);
  });
});

describe('slotImportSourceLabel', () => {
  it('prefixes with Sort:', () => {
    expect(slotImportSourceLabel(meta({ name: 'Favourites' }))).toBe(
      'Sort: Favourites',
    );
  });
});

describe('slotImportStatusLabel', () => {
  it('formats in-progress slots', () => {
    const label = slotImportStatusLabel({
      meta: meta({ done: false, totalItems: 12, comparisons: 5 }),
      status: 'in_progress',
      itemCount: 0,
      items: null,
    });
    expect(label).toBe('12 items · in progress (5 comparisons in)');
  });
});
