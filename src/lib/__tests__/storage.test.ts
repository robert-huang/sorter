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
  loadSaveFromFile,
  migrateLegacyIfNeeded,
  peekEvictionTarget,
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
import type { MergeProgress, SaveFile, SlotMeta } from '../types';

/**
 * Tiny File-like polyfill for jsdom. jsdom does provide File globally
 * but the constructor signature is fussy across versions; building our
 * own keeps the test independent.
 */
function makeFakeFile(text: string, name = 'fake.json'): File {
  // Cast through `unknown` because we only implement the slice of File
  // that loadSaveFromFile actually uses (text()). loadSaveFromFile's
  // signature is `File`; ts is happy when we tell it that's what we have.
  return {
    name,
    text: async () => text,
  } as unknown as File;
}

const LEGACY_KEY = 'sorter:v1';

function makeProgress(comparisons = 0, done = false): MergeProgress {
  return {
    engine: 'merge',
    queue: [['a']],
    current: null,
    comparisons,
    done,
    hidden: [],
    totalComparisonsEverNeeded: 0,
    unplaced: [],
    pendingManualInserts: [],
    currentManualInsert: null,
    currentAutoInsert: null,
  };
}

function makeBlob(comparisons = 0, done = false): AutosaveBlob {
  return {
    items: { a: { id: 'a', label: 'Alpha' }, b: { id: 'b', label: 'Bravo' } },
    progress: makeProgress(comparisons, done),
    undoRing: [],
  };
}

/** Test helper: `createSlot` now returns `{ meta, evicted }`. Tests that
 *  only care about the new meta use `mintSlot` for brevity. Tests that
 *  need to verify eviction call `createSlot` directly and destructure. */
function mintSlot(blob: AutosaveBlob, name: string): SlotMeta {
  return createSlot(blob, name).meta;
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
    const { meta, evicted } = createSlot(makeBlob(), 'My sort');

    const m = readManifest();
    expect(m.activeId).toBe(meta.id);
    expect(m.slots[0].id).toBe(meta.id);
    expect(m.slots[0].name).toBe('My sort');
    expect(readSlotBlob(meta.id)).not.toBeNull();
    // No eviction when we're well below the cap.
    expect(evicted).toEqual([]);
  });

  it('evicts the oldest-updatedAt slot when SLOT_CAP would be exceeded and reports it in `evicted`', () => {
    // Create SLOT_CAP slots, then create one more.
    const created: string[] = [];
    for (let i = 0; i < SLOT_CAP; i++) {
      const meta = mintSlot(makeBlob(i), `Slot ${i}`);
      created.push(meta.id);
      // Hand-roll the timestamps so we have a deterministic eviction order:
      // slot 0 = oldest, slot (CAP-1) = newest.
      updateSlotMeta(meta.id, {
        updatedAt: new Date(2026, 0, 1 + i).toISOString(),
      });
    }
    expect(readManifest().slots.length).toBe(SLOT_CAP);

    const { meta: newest, evicted } = createSlot(makeBlob(99), 'Newest');

    const m = readManifest();
    expect(m.slots.length).toBe(SLOT_CAP);
    expect(m.activeId).toBe(newest.id);
    // The oldest created slot (id == created[0]) should be gone:
    expect(m.slots.some((s) => s.id === created[0])).toBe(false);
    expect(readSlotBlob(created[0])).toBeNull();
    // And reported via the return value so the UI can flash a toast.
    expect(evicted.map((e) => e.id)).toEqual([created[0]]);
    expect(evicted[0].name).toBe('Slot 0');
  });
});

describe('peekEvictionTarget', () => {
  it('returns null while we are below the cap', () => {
    mintSlot(makeBlob(), 'A');
    mintSlot(makeBlob(), 'B');
    expect(peekEvictionTarget()).toBeNull();
  });

  it('returns the oldest-updatedAt slot once we are at the cap', () => {
    let oldestId = '';
    for (let i = 0; i < SLOT_CAP; i++) {
      const meta = mintSlot(makeBlob(i), `Slot ${i}`);
      if (i === 0) oldestId = meta.id;
      updateSlotMeta(meta.id, {
        updatedAt: new Date(2026, 0, 1 + i).toISOString(),
      });
    }
    expect(readManifest().slots.length).toBe(SLOT_CAP);
    const target = peekEvictionTarget();
    expect(target).not.toBeNull();
    expect(target?.id).toBe(oldestId);
    expect(target?.name).toBe('Slot 0');
  });
});

describe('setActiveSlot', () => {
  it('switches the active pointer and flushes any pending autosave first', async () => {
    const slotA = mintSlot(makeBlob(0), 'A');
    const slotB = mintSlot(makeBlob(0), 'B');
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
    const slot = mintSlot(makeBlob(), 'A');
    setActiveSlot('this-id-does-not-exist');
    expect(readManifest().activeId).toBe(slot.id);
  });
});

describe('scheduleAutosave', () => {
  it('writes under the active slot key after the debounce', async () => {
    const slot = mintSlot(makeBlob(0), 'A');
    scheduleAutosave(makeBlob(3));
    // Pre-flush, blob is still the initial.
    expect(readSlotBlob(slot.id)?.progress.comparisons).toBe(0);

    await new Promise((r) => setTimeout(r, AUTOSAVE_DEBOUNCE_MS + 50));

    expect(readSlotBlob(slot.id)?.progress.comparisons).toBe(3);
  });

  it('flushes immediately on flushAutosave', () => {
    const slot = mintSlot(makeBlob(0), 'A');
    scheduleAutosave(makeBlob(7));
    flushAutosave();
    expect(readSlotBlob(slot.id)?.progress.comparisons).toBe(7);
  });

  it('also patches the slot meta (comparisons / done / updatedAt)', () => {
    const slot = mintSlot(makeBlob(0), 'A');
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
    const slot = mintSlot(makeBlob(), 'A');
    expect(readManifest().activeId).toBe(slot.id);

    const m = deleteSlot(slot.id);

    expect(m.activeId).toBeNull();
    expect(m.slots).toEqual([]);
    expect(window.localStorage.getItem(slotBlobKey(slot.id))).toBeNull();
  });

  it('preserves activeId when deleting a non-active slot', () => {
    const slotA = mintSlot(makeBlob(), 'A');
    const slotB = mintSlot(makeBlob(), 'B'); // B becomes active

    const m = deleteSlot(slotA.id);

    expect(m.activeId).toBe(slotB.id);
    expect(m.slots.length).toBe(1);
    expect(m.slots[0].id).toBe(slotB.id);
  });

  it('drops any pending autosave bound to the active slot before deleting', () => {
    const slot = mintSlot(makeBlob(0), 'A');
    scheduleAutosave(makeBlob(99));
    deleteSlot(slot.id);
    // After deletion, the pending blob must NOT have been written to a
    // ghost / re-created key.
    expect(window.localStorage.getItem(slotBlobKey(slot.id))).toBeNull();
  });
});

describe('renameSlot', () => {
  it('updates the name and bumps updatedAt', () => {
    const slot = mintSlot(makeBlob(), 'Old');
    const before = readManifest().slots[0].updatedAt;
    renameSlot(slot.id, '  New name  ');
    const after = readManifest().slots[0];
    expect(after.name).toBe('New name');
    expect(after.updatedAt >= before).toBe(true);
  });

  it('falls back to a stub name when given empty/whitespace input', () => {
    const slot = mintSlot(makeBlob(), 'Old');
    renameSlot(slot.id, '   ');
    expect(readManifest().slots[0].name).toMatch(/^Untitled — \d{4}-\d{2}-\d{2}$/);
  });
});

describe('readActiveSlot', () => {
  it('returns the active slot blob, or null when none', () => {
    expect(readActiveSlot()).toBeNull();
    const slot = mintSlot(makeBlob(2), 'A');
    const blob = readActiveSlot();
    expect(blob?.progress.comparisons).toBe(2);
    expect(blob?.items.a.label).toBe('Alpha');
    // After deleting the active slot, readActiveSlot is null again.
    deleteSlot(slot.id);
    expect(readActiveSlot()).toBeNull();
  });
});

// ============================================================================
// v1 → v2 → v3 migration: upgradeProgress (covered indirectly via the loaders)
// ============================================================================

describe('upgradeProgress (via loaders)', () => {
  it('legacy v1 blob with no engine field is upgraded to engine=merge with v3 defaults', () => {
    // Write a v1-shaped legacy save (no engine, no exile/Insert fields).
    const legacyV1 = {
      version: 1 as const,
      createdAt: '2026-05-19T00:00:00.000Z',
      items: { a: { id: 'a', label: 'Alpha' } },
      progress: {
        queue: [['a']],
        current: null,
        comparisons: 5,
        done: false,
        hidden: [],
        totalComparisonsEverNeeded: 7,
        // No engine, no unplaced, no Place/Insert fields.
      },
      undoRing: [],
    };
    window.localStorage.setItem('sorter:v1', JSON.stringify(legacyV1));

    const m = migrateLegacyIfNeeded();
    const blob = readSlotBlob(m.slots[0].id)!;

    expect(blob.progress.engine).toBe('merge');
    if (blob.progress.engine === 'merge') {
      expect(blob.progress.unplaced).toEqual([]);
      expect(blob.progress.pendingManualInserts).toEqual([]);
      expect(blob.progress.currentManualInsert).toBeNull();
      expect(blob.progress.currentAutoInsert).toBeNull();
      expect(blob.progress.comparisons).toBe(5);
      expect(blob.progress.totalComparisonsEverNeeded).toBe(7);
    }
  });

  it('v2 merge blob with legacy field names is upgraded to v3 (renames fields, adds currentAutoInsert)', () => {
    // Persist a v2-shaped blob directly via localStorage so we can
    // observe the read-time upgrade. Don't go through createSlot —
    // that would always write the new v3 shape.
    const slotId = 'manualv2slotxx';
    const v2OnDisk = {
      version: 2 as const,
      createdAt: '2026-05-19T00:00:00.000Z',
      items: {
        a: { id: 'a', label: 'Alpha' },
        g: { id: 'g', label: 'Gamma' },
      },
      progress: {
        engine: 'merge',
        queue: [['a', 'g']],
        current: null,
        comparisons: 3,
        done: false,
        hidden: ['g'],
        totalComparisonsEverNeeded: 3,
        unplaced: ['g'],
        // v2 legacy field names:
        pendingPlacements: ['g'],
        currentPlacement: null,
      },
      undoRing: [],
    };
    window.localStorage.setItem(slotBlobKey(slotId), JSON.stringify(v2OnDisk));

    const read = readSlotBlob(slotId)!;
    expect(read.progress.engine).toBe('merge');
    if (read.progress.engine === 'merge') {
      // Old field names translated to new ones.
      expect(read.progress.pendingManualInserts).toEqual(['g']);
      expect(read.progress.currentManualInsert).toBeNull();
      // New v3 field defaulted in.
      expect(read.progress.currentAutoInsert).toBeNull();
      // Other fields preserved.
      expect(read.progress.unplaced).toEqual(['g']);
      expect(read.progress.hidden).toEqual(['g']);
      // Old field names are stripped from the read shape (TS won't
      // surface them, but ensure we're not double-storing).
      expect(
        (read.progress as unknown as { pendingPlacements?: unknown })
          .pendingPlacements,
      ).toBeUndefined();
      expect(
        (read.progress as unknown as { currentPlacement?: unknown })
          .currentPlacement,
      ).toBeUndefined();
    }
  });

  it('v3 merge blob round-trips through readSlotBlob unchanged', () => {
    const v3Merge: AutosaveBlob = {
      items: { a: { id: 'a', label: 'Alpha' }, b: { id: 'b', label: 'Bravo' } },
      progress: {
        engine: 'merge',
        queue: [['a', 'b']],
        current: null,
        comparisons: 1,
        done: true,
        hidden: ['b'],
        totalComparisonsEverNeeded: 1,
        unplaced: ['b'],
        pendingManualInserts: [],
        currentManualInsert: null,
        currentAutoInsert: null,
      },
      undoRing: [],
    };
    const meta = mintSlot(v3Merge, 'V3 merge');
    const read = readSlotBlob(meta.id)!;
    expect(read.progress.engine).toBe('merge');
    if (read.progress.engine === 'merge') {
      expect(read.progress.unplaced).toEqual(['b']);
      expect(read.progress.hidden).toEqual(['b']);
      expect(read.progress.currentAutoInsert).toBeNull();
    }
  });

  it('v2/v3 insertion blob round-trips and preserves all fields', () => {
    const insBlob: AutosaveBlob = {
      items: {
        a: { id: 'a', label: 'Alpha' },
        b: { id: 'b', label: 'Bravo' },
        x: { id: 'x', label: 'X' },
      },
      progress: {
        engine: 'insertion',
        sorted: ['a', 'b'],
        pending: [],
        current: { insertingId: 'x', lo: 0, hi: 1, probe: 0 },
        comparisons: 0,
        done: false,
        hidden: [],
        totalComparisonsEverNeeded: 2,
      },
      undoRing: [],
    };
    const meta = mintSlot(insBlob, 'Insertion');
    const read = readSlotBlob(meta.id)!;
    expect(read.progress.engine).toBe('insertion');
    if (read.progress.engine === 'insertion') {
      expect(read.progress.sorted).toEqual(['a', 'b']);
      expect(read.progress.current?.insertingId).toBe('x');
    }
  });
});

// ============================================================================
// loadSaveFromFile — version handling + upgrade through the public entry point
// ============================================================================

describe('loadSaveFromFile', () => {
  it('accepts a v1 file and upgrades progress to engine=merge with v3 defaults', async () => {
    const v1: SaveFile = {
      version: 1,
      createdAt: '2026-05-19T00:00:00.000Z',
      items: {
        a: { id: 'a', label: 'Alpha' },
        b: { id: 'b', label: 'Bravo' },
      },
      // intentionally typed loose — v1 didn't have engine/unplaced/etc.
      // The cast goes through `unknown` to mirror a real on-disk read.
      progress: {
        queue: [['a'], ['b']],
        current: null,
        comparisons: 0,
        done: false,
        hidden: [],
        totalComparisonsEverNeeded: 1,
      } as unknown as MergeProgress,
      undoRing: [],
    };

    const file = makeFakeFile(JSON.stringify(v1));
    const blob = await loadSaveFromFile(file);

    expect(blob.progress.engine).toBe('merge');
    if (blob.progress.engine === 'merge') {
      expect(blob.progress.unplaced).toEqual([]);
      expect(blob.progress.pendingManualInserts).toEqual([]);
      expect(blob.progress.currentManualInsert).toBeNull();
      expect(blob.progress.currentAutoInsert).toBeNull();
      expect(blob.progress.queue).toEqual([['a'], ['b']]);
    }
  });

  it('accepts a v2 file with legacy Place field names and upgrades to v3 vocabulary', async () => {
    const v2 = {
      version: 2 as const,
      createdAt: '2026-05-19T00:00:00.000Z',
      items: {
        a: { id: 'a', label: 'Alpha' },
        g: { id: 'g', label: 'Gamma' },
      },
      progress: {
        engine: 'merge',
        queue: [['a', 'g']],
        current: null,
        comparisons: 0,
        done: false,
        hidden: ['g'],
        totalComparisonsEverNeeded: 1,
        unplaced: ['g'],
        pendingPlacements: ['g'],
        currentPlacement: null,
      },
      undoRing: [],
    };
    const blob = await loadSaveFromFile(makeFakeFile(JSON.stringify(v2)));
    expect(blob.progress.engine).toBe('merge');
    if (blob.progress.engine === 'merge') {
      expect(blob.progress.pendingManualInserts).toEqual(['g']);
      expect(blob.progress.currentManualInsert).toBeNull();
      expect(blob.progress.currentAutoInsert).toBeNull();
    }
  });

  it('accepts a v3 insertion file and preserves the engine + frame', async () => {
    const v3: SaveFile = {
      version: 3,
      createdAt: '2026-05-19T00:00:00.000Z',
      items: {
        a: { id: 'a', label: 'Alpha' },
        x: { id: 'x', label: 'X' },
      },
      progress: {
        engine: 'insertion',
        sorted: ['a'],
        pending: [],
        current: { insertingId: 'x', lo: 0, hi: 0, probe: 0 },
        comparisons: 0,
        done: false,
        hidden: [],
        totalComparisonsEverNeeded: 1,
      },
      undoRing: [],
    };
    const blob = await loadSaveFromFile(makeFakeFile(JSON.stringify(v3)));
    expect(blob.progress.engine).toBe('insertion');
    if (blob.progress.engine === 'insertion') {
      expect(blob.progress.sorted).toEqual(['a']);
      expect(blob.progress.current?.insertingId).toBe('x');
    }
  });

  it('upgrades each undoRing entry to v3 shape too', async () => {
    const v1: SaveFile = {
      version: 1,
      createdAt: '2026-05-19T00:00:00.000Z',
      items: { a: { id: 'a', label: 'Alpha' } },
      progress: {
        queue: [['a']],
        current: null,
        comparisons: 1,
        done: false,
        hidden: [],
        totalComparisonsEverNeeded: 1,
      } as unknown as MergeProgress,
      // Two legacy undo entries with no engine field — both should be
      // upgraded to engine='merge' with default insert/auto-insert fields.
      undoRing: [
        {
          queue: [['a']],
          current: null,
          comparisons: 0,
          done: false,
          hidden: [],
          totalComparisonsEverNeeded: 1,
        } as unknown as MergeProgress,
        {
          queue: [['a']],
          current: null,
          comparisons: 0,
          done: false,
          hidden: ['a'],
          totalComparisonsEverNeeded: 1,
        } as unknown as MergeProgress,
      ],
    };
    const blob = await loadSaveFromFile(makeFakeFile(JSON.stringify(v1)));
    expect(blob.undoRing.length).toBe(2);
    for (const u of blob.undoRing) {
      expect(u.engine).toBe('merge');
      if (u.engine === 'merge') {
        expect(u.unplaced).toEqual([]);
        expect(u.pendingManualInserts).toEqual([]);
        expect(u.currentManualInsert).toBeNull();
        expect(u.currentAutoInsert).toBeNull();
      }
    }
  });

  it('rejects unknown versions cleanly', async () => {
    const bad = JSON.stringify({
      version: 99,
      createdAt: '2026-05-19T00:00:00.000Z',
      items: {},
      progress: { queue: [], current: null, comparisons: 0, done: true, hidden: [], totalComparisonsEverNeeded: 0 },
      undoRing: [],
    });
    await expect(loadSaveFromFile(makeFakeFile(bad))).rejects.toThrow(
      /Unsupported save file version/,
    );
  });

  it('rejects truncated files (missing required fields)', async () => {
    const bad = JSON.stringify({ version: 3, createdAt: 't' });
    await expect(loadSaveFromFile(makeFakeFile(bad))).rejects.toThrow(
      /missing required fields/,
    );
  });
});
