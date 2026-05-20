import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AutosaveBlob } from '../storage';
import {
  AUTOSAVE_DEBOUNCE_MS,
  MANIFEST_KEY,
  SLOT_CAP,
  _resetAvailabilityCache,
  createSlot,
  deleteSlot,
  flushAutosave,
  migrateLegacyIfNeeded,
  primeActiveSlot,
  readActiveSlot,
  readManifest,
  readSlotBlob,
  renameSlot,
  scheduleAutosave,
  setActiveSlot,
  slotBlobKey,
  updateSlotMeta,
} from '../storage';
import type { SaveFile, SortProgress } from '../types';

const LEGACY_KEY = 'sorter:v1';

function makeProgress(comparisons = 0, done = false): SortProgress {
  return {
    queue: [['a']],
    current: null,
    comparisons,
    done,
    hidden: [],
    totalComparisonsEverNeeded: 0,
  };
}

function makeBlob(comparisons = 0, done = false): AutosaveBlob {
  return {
    items: { a: { id: 'a', label: 'Alpha' }, b: { id: 'b', label: 'Bravo' } },
    progress: makeProgress(comparisons, done),
    undoRing: [],
  };
}

beforeEach(() => {
  window.localStorage.clear();
  _resetAvailabilityCache();
  // Re-prime the in-module active-slot pointer to null since storage was wiped.
  primeActiveSlot();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('migrateLegacyIfNeeded', () => {
  it('converts a v1 legacy save into a single active slot', () => {
    const legacy: SaveFile = {
      version: 1,
      createdAt: '2026-05-19T00:00:00.000Z',
      items: { a: { id: 'a', label: 'Alpha' } },
      progress: makeProgress(7, false),
      undoRing: [],
    };
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));

    const m = migrateLegacyIfNeeded();

    expect(m.activeId).not.toBeNull();
    expect(m.slots.length).toBe(1);
    expect(m.slots[0].comparisons).toBe(7);
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
    // Blob copied under the new slot key.
    const blob = readSlotBlob(m.slots[0].id);
    expect(blob?.progress.comparisons).toBe(7);
  });

  it('is idempotent: a second call leaves the manifest unchanged', () => {
    const legacy: SaveFile = {
      version: 1,
      createdAt: '2026-05-19T00:00:00.000Z',
      items: { a: { id: 'a', label: 'Alpha' } },
      progress: makeProgress(3),
      undoRing: [],
    };
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));

    const first = migrateLegacyIfNeeded();
    const second = migrateLegacyIfNeeded();

    expect(second).toEqual(first);
  });

  it('initializes an empty manifest when neither legacy nor manifest exists', () => {
    const m = migrateLegacyIfNeeded();
    expect(m.activeId).toBeNull();
    expect(m.slots).toEqual([]);
    // Persisted so the next read returns the same shape.
    expect(window.localStorage.getItem(MANIFEST_KEY)).not.toBeNull();
  });

  it('discards corrupt legacy data instead of throwing', () => {
    window.localStorage.setItem(LEGACY_KEY, 'not-json-at-all');
    const m = migrateLegacyIfNeeded();
    expect(m.activeId).toBeNull();
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
  });
});

describe('createSlot', () => {
  it('writes the blob, prepends a meta entry, and activates the new slot', () => {
    const meta = createSlot(makeBlob(), 'My sort');

    const m = readManifest();
    expect(m.activeId).toBe(meta.id);
    expect(m.slots[0].id).toBe(meta.id);
    expect(m.slots[0].name).toBe('My sort');
    expect(readSlotBlob(meta.id)).not.toBeNull();
  });

  it('evicts the oldest-updatedAt slot when SLOT_CAP would be exceeded', () => {
    // Create SLOT_CAP slots, then create one more.
    const created: string[] = [];
    for (let i = 0; i < SLOT_CAP; i++) {
      const meta = createSlot(makeBlob(i), `Slot ${i}`);
      created.push(meta.id);
      // Hand-roll the timestamps so we have a deterministic eviction order:
      // slot 0 = oldest, slot (CAP-1) = newest.
      updateSlotMeta(meta.id, {
        updatedAt: new Date(2026, 0, 1 + i).toISOString(),
      });
    }
    expect(readManifest().slots.length).toBe(SLOT_CAP);

    const newest = createSlot(makeBlob(99), 'Newest');

    const m = readManifest();
    expect(m.slots.length).toBe(SLOT_CAP);
    expect(m.activeId).toBe(newest.id);
    // The oldest created slot (id == created[0]) should be gone:
    expect(m.slots.some((s) => s.id === created[0])).toBe(false);
    expect(readSlotBlob(created[0])).toBeNull();
  });
});

describe('setActiveSlot', () => {
  it('switches the active pointer and flushes any pending autosave first', async () => {
    const slotA = createSlot(makeBlob(0), 'A');
    const slotB = createSlot(makeBlob(0), 'B');
    // After two creates, B is active.
    expect(readManifest().activeId).toBe(slotB.id);

    // Schedule an autosave for B (won't fire immediately due to debounce).
    scheduleAutosave(makeBlob(5));
    // No write has happened yet; B's blob is still the initial one.
    expect(readSlotBlob(slotB.id)?.progress.comparisons).toBe(0);

    setActiveSlot(slotA.id);

    // The flush inside setActiveSlot must have written the pending blob
    // under B's key BEFORE the pointer moved.
    expect(readSlotBlob(slotB.id)?.progress.comparisons).toBe(5);
    expect(readManifest().activeId).toBe(slotA.id);
  });

  it('no-ops when given an unknown id', () => {
    const slot = createSlot(makeBlob(), 'A');
    setActiveSlot('this-id-does-not-exist');
    expect(readManifest().activeId).toBe(slot.id);
  });
});

describe('scheduleAutosave', () => {
  it('writes under the active slot key after the debounce', async () => {
    const slot = createSlot(makeBlob(0), 'A');
    scheduleAutosave(makeBlob(3));
    // Pre-flush, blob is still the initial.
    expect(readSlotBlob(slot.id)?.progress.comparisons).toBe(0);

    await new Promise((r) => setTimeout(r, AUTOSAVE_DEBOUNCE_MS + 50));

    expect(readSlotBlob(slot.id)?.progress.comparisons).toBe(3);
  });

  it('flushes immediately on flushAutosave', () => {
    const slot = createSlot(makeBlob(0), 'A');
    scheduleAutosave(makeBlob(7));
    flushAutosave();
    expect(readSlotBlob(slot.id)?.progress.comparisons).toBe(7);
  });

  it('also patches the slot meta (comparisons / done / updatedAt)', () => {
    const slot = createSlot(makeBlob(0), 'A');
    const beforeUpdatedAt = readManifest().slots[0].updatedAt;
    scheduleAutosave(makeBlob(5, true));
    flushAutosave();

    const after = readManifest().slots.find((s) => s.id === slot.id)!;
    expect(after.comparisons).toBe(5);
    expect(after.done).toBe(true);
    expect(after.updatedAt >= beforeUpdatedAt).toBe(true);
  });

  it('is a no-op when there is no active slot', () => {
    // No slot created → activeId is null.
    scheduleAutosave(makeBlob(1));
    flushAutosave();
    // Nothing under any slot key.
    expect(readManifest().slots.length).toBe(0);
  });
});

describe('deleteSlot', () => {
  it('removes the blob + meta and clears activeId when deleting the active slot', () => {
    const slot = createSlot(makeBlob(), 'A');
    expect(readManifest().activeId).toBe(slot.id);

    const m = deleteSlot(slot.id);

    expect(m.activeId).toBeNull();
    expect(m.slots).toEqual([]);
    expect(window.localStorage.getItem(slotBlobKey(slot.id))).toBeNull();
  });

  it('preserves activeId when deleting a non-active slot', () => {
    const slotA = createSlot(makeBlob(), 'A');
    const slotB = createSlot(makeBlob(), 'B'); // B becomes active

    const m = deleteSlot(slotA.id);

    expect(m.activeId).toBe(slotB.id);
    expect(m.slots.length).toBe(1);
    expect(m.slots[0].id).toBe(slotB.id);
  });

  it('drops any pending autosave bound to the active slot before deleting', () => {
    const slot = createSlot(makeBlob(0), 'A');
    scheduleAutosave(makeBlob(99));
    deleteSlot(slot.id);
    // After deletion, the pending blob must NOT have been written to a
    // ghost / re-created key.
    expect(window.localStorage.getItem(slotBlobKey(slot.id))).toBeNull();
  });
});

describe('renameSlot', () => {
  it('updates the name and bumps updatedAt', () => {
    const slot = createSlot(makeBlob(), 'Old');
    const before = readManifest().slots[0].updatedAt;
    renameSlot(slot.id, '  New name  ');
    const after = readManifest().slots[0];
    expect(after.name).toBe('New name');
    expect(after.updatedAt >= before).toBe(true);
  });

  it('falls back to a stub name when given empty/whitespace input', () => {
    const slot = createSlot(makeBlob(), 'Old');
    renameSlot(slot.id, '   ');
    expect(readManifest().slots[0].name).toMatch(/^Untitled — \d{4}-\d{2}-\d{2}$/);
  });
});

describe('readActiveSlot', () => {
  it('returns the active slot blob, or null when none', () => {
    expect(readActiveSlot()).toBeNull();
    const slot = createSlot(makeBlob(2), 'A');
    const blob = readActiveSlot();
    expect(blob?.progress.comparisons).toBe(2);
    expect(blob?.items.a.label).toBe('Alpha');
    // After deleting the active slot, readActiveSlot is null again.
    deleteSlot(slot.id);
    expect(readActiveSlot()).toBeNull();
  });
});
