import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutosaveBlob, AutosaveError, AutosaveRecovery } from '../storage';
import {
  AUTOSAVE_DEBOUNCE_MS,
  MANIFEST_KEY,
  SLOT_CAP,
  _resetAvailabilityCache,
  consumeManifestRepairNotice,
  createSlot,
  deleteSlot,
  discardPendingAutosave,
  exportAllSlots,
  flushAutosave,
  getLastAutosaveError,
  importAllSlots,
  isAtCapAndAllPinned,
  loadSaveFromFile,
  migrateLegacyIfNeeded,
  peekEvictionTarget,
  pinSlot,
  primeActiveSlot,
  readActiveSlot,
  readManifest,
  readSlotBlob,
  renameSlot,
  repairManifestIfCorrupt,
  scheduleAutosave,
  setActiveSlot,
  slotBlobKey,
  subscribeAutosaveError,
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
    toBeInserted: [],
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

/** Test helper: `createSlot` returns `{ meta, evicted } | null` (null on
 *  durable-write failure). Tests that only care about the new meta use
 *  `mintSlot` for brevity and assert success; tests that need to verify
 *  eviction call `createSlot` directly and destructure with a non-null
 *  check. */
function mintSlot(blob: AutosaveBlob, name: string): SlotMeta {
  const result = createSlot(blob, name);
  if (!result) throw new Error('mintSlot: createSlot returned null');
  return result.meta;
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
    const result = createSlot(makeBlob(), 'My sort');
    expect(result).not.toBeNull();
    const { meta, evicted } = result!;

    const m = readManifest();
    expect(m.activeId).toBe(meta.id);
    expect(m.slots[0].id).toBe(meta.id);
    expect(m.slots[0].name).toBe('My sort');
    expect(readSlotBlob(meta.id)).not.toBeNull();
    // No eviction when we're well below the cap.
    expect(evicted).toEqual([]);
  });

  it('totalItems excludes hidden items', () => {
    const blob: AutosaveBlob = {
      items: {
        a: { id: 'a', label: 'Alpha' },
        b: { id: 'b', label: 'Bravo' },
        c: { id: 'c', label: 'Charlie' },
      },
      progress: {
        ...makeProgress(),
        hidden: ['b', 'c'],
      },
      undoRing: [],
    };
    const meta = mintSlot(blob, 'With hidden');
    expect(meta.totalItems).toBe(1);
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

    const result = createSlot(makeBlob(99), 'Newest');
    expect(result).not.toBeNull();
    const { meta: newest, evicted } = result!;

    const m = readManifest();
    expect(m.slots.length).toBe(SLOT_CAP);
    expect(m.activeId).toBe(newest.id);
    // The oldest created slot (id == created[0]) should be gone:
    expect(m.slots.some((s) => s.id === created[0])).toBe(false);
    expect(readSlotBlob(created[0])).toBeNull();
    // And reported via the return value so the UI can flash a toast.
    expect(evicted.map((e: SlotMeta) => e.id)).toEqual([created[0]]);
    expect(evicted[0].name).toBe('Slot 0');
  });

  it('returns null and does NOT register meta when the blob write fails', () => {
    // Force the slot-blob write to throw (simulating quota exhaustion).
    // jsdom forbids replacing methods on the localStorage instance directly,
    // so we spy on the Storage prototype and selectively short-circuit
    // sorter:slot:* keys.
    const origSet = Storage.prototype.setItem;
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
      function (this: Storage, k: string, v: string) {
        if (k.startsWith('sorter:slot:')) {
          const err = new Error('QuotaExceededError');
          err.name = 'QuotaExceededError';
          throw err;
        }
        return origSet.call(this, k, v);
      },
    );
    // createSlot logs a warning on the expected failure path; silence
    // it so the test output stays clean (the assertion below is what
    // actually verifies the failure was observed).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = createSlot(makeBlob(), 'doomed');
      expect(result).toBeNull();
      // Manifest should NOT contain a ghost meta whose blob is missing.
      const m = readManifest();
      expect(m.slots.some((s) => s.name === 'doomed')).toBe(false);
      expect(m.activeId).toBeNull();
    } finally {
      setSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('skips pinned slots when evicting and reports the next-oldest unpinned slot instead', () => {
    // Fill to cap, then pin the would-be-evicted oldest. The next mint
    // should evict the second-oldest unpinned slot.
    const created: string[] = [];
    for (let i = 0; i < SLOT_CAP; i++) {
      const meta = mintSlot(makeBlob(i), `Slot ${i}`);
      created.push(meta.id);
      updateSlotMeta(meta.id, {
        updatedAt: new Date(2026, 0, 1 + i).toISOString(),
      });
    }
    pinSlot(created[0], true);
    // pinSlot bumps updatedAt; revert so the deterministic ordering holds.
    updateSlotMeta(created[0], {
      updatedAt: new Date(2026, 0, 1).toISOString(),
    });
    const result = createSlot(makeBlob(99), 'After Pin');
    expect(result).not.toBeNull();
    const { evicted } = result!;
    expect(evicted.map((e: SlotMeta) => e.id)).toEqual([created[1]]);
    const m = readManifest();
    expect(m.slots.some((s) => s.id === created[0])).toBe(true); // pinned survives
    expect(m.slots.some((s) => s.id === created[1])).toBe(false); // unpinned evicted
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

  it('skips pinned slots and points at the next-oldest unpinned slot', () => {
    const ids: string[] = [];
    for (let i = 0; i < SLOT_CAP; i++) {
      const meta = mintSlot(makeBlob(i), `Slot ${i}`);
      ids.push(meta.id);
      updateSlotMeta(meta.id, {
        updatedAt: new Date(2026, 0, 1 + i).toISOString(),
      });
    }
    pinSlot(ids[0], true);
    updateSlotMeta(ids[0], {
      updatedAt: new Date(2026, 0, 1).toISOString(),
    });
    const target = peekEvictionTarget();
    expect(target?.id).toBe(ids[1]);
  });

  it('returns null when every slot at cap is pinned', () => {
    const ids: string[] = [];
    for (let i = 0; i < SLOT_CAP; i++) {
      const meta = mintSlot(makeBlob(i), `Slot ${i}`);
      ids.push(meta.id);
    }
    for (const id of ids) pinSlot(id, true);
    expect(peekEvictionTarget()).toBeNull();
    expect(isAtCapAndAllPinned()).toBe(true);
  });
});

describe('pinSlot', () => {
  it('toggles the pinned flag and bumps updatedAt', () => {
    const meta = mintSlot(makeBlob(), 'P');
    const beforeUpdated = readManifest().slots[0].updatedAt;
    const m = pinSlot(meta.id, true);
    expect(m.slots[0].pinned).toBe(true);
    expect(m.slots[0].updatedAt >= beforeUpdated).toBe(true);
    const m2 = pinSlot(meta.id, false);
    expect(m2.slots[0].pinned).toBe(false);
  });

  it('is a no-op for unknown ids', () => {
    mintSlot(makeBlob(), 'A');
    const before = readManifest();
    const after = pinSlot('does-not-exist', true);
    expect(after).toEqual(before);
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

  it('does NOT bump updatedAt when the scheduled blob is identical to on-disk content', async () => {
    // Reproduces the bug where clicking a slot to activate it (which
    // re-binds the same state/undoRing into App's autosave-on-change
    // effect) caused a no-op write that bumped updatedAt and pushed the
    // cloud-sync indicator into "pending" — even though the user made
    // no edits. performWrite now compares the in-memory blob against
    // the on-disk content and skips the setItem + meta bump when they
    // match.
    const slot = mintSlot(makeBlob(3), 'A');
    const beforeUpdatedAt = readManifest().slots.find((s) => s.id === slot.id)!.updatedAt;
    // Wait long enough that an actual setItem would produce a strictly
    // greater ISO timestamp (Date.now() resolution is 1ms, but ISO
    // strings can collide within the same ms). Anything >=2ms is safe.
    await new Promise((r) => setTimeout(r, 5));
    scheduleAutosave(makeBlob(3));
    flushAutosave();
    const afterUpdatedAt = readManifest().slots.find((s) => s.id === slot.id)!.updatedAt;
    expect(afterUpdatedAt).toBe(beforeUpdatedAt);
  });

  it('still bumps updatedAt when even a single field of the blob differs', async () => {
    // Sanity check: the no-op skip must NOT swallow real changes —
    // a one-comparison delta is still a write.
    const slot = mintSlot(makeBlob(3), 'A');
    const beforeUpdatedAt = readManifest().slots.find((s) => s.id === slot.id)!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    scheduleAutosave(makeBlob(4));
    flushAutosave();
    const afterUpdatedAt = readManifest().slots.find((s) => s.id === slot.id)!.updatedAt;
    expect(afterUpdatedAt > beforeUpdatedAt).toBe(true);
  });

  it('is a no-op when there is no active slot', () => {
    // No slot created → activeId is null.
    scheduleAutosave(makeBlob(1));
    flushAutosave();
    // Nothing under any slot key.
    expect(readManifest().slots.length).toBe(0);
  });
});

describe('discardPendingAutosave', () => {
  // Keep the scheduled blob's comparison delta below AUTOSAVE_MAX_COMPARISONS
  // (20) so we stay on the debounced path. Anything >= 20 since the last
  // flush forces a synchronous write inside scheduleAutosave itself,
  // leaving nothing for discardPendingAutosave to cancel.
  it('drops the pending blob so a subsequent flush is a no-op', () => {
    const slot = mintSlot(makeBlob(0), 'A');
    scheduleAutosave(makeBlob(3));
    // Before discard, flush would write 3; after, the on-disk blob
    // must still be the original (0). This is the multi-tab reload
    // contract: we MUST NOT clobber the other tab's writes by flushing.
    discardPendingAutosave();
    flushAutosave();
    expect(readSlotBlob(slot.id)?.progress.comparisons).toBe(0);
  });

  it('also cancels the pending debounce timer so a later tick does not fire', async () => {
    const slot = mintSlot(makeBlob(0), 'A');
    scheduleAutosave(makeBlob(5));
    discardPendingAutosave();
    await new Promise((r) => setTimeout(r, AUTOSAVE_DEBOUNCE_MS + 50));
    expect(readSlotBlob(slot.id)?.progress.comparisons).toBe(0);
  });
});

describe('scheduleAutosave quota recovery', () => {
  /**
   * Helper: install a cumulative-byte quota limit on `sorter:slot:*`
   * writes. The mock tracks total bytes stored across slot-blob keys
   * and rejects any setItem whose post-write total would exceed the
   * limit. This matches real localStorage semantics — i.e. evicting
   * an existing slot actually frees room for a subsequent write —
   * which is what the eviction recovery path needs to exercise.
   * Manifest / settings / probe keys are unaffected.
   */
  function installQuotaLimit(byteLimit: number): () => void {
    const origSet = Storage.prototype.setItem;
    function slotBytes(): number {
      let total = 0;
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (!k || !k.startsWith('sorter:slot:')) continue;
        const v = window.localStorage.getItem(k);
        if (v) total += v.length;
      }
      return total;
    }
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, k: string, v: string) {
        if (k.startsWith('sorter:slot:')) {
          const existing = window.localStorage.getItem(k);
          const delta = v.length - (existing ? existing.length : 0);
          if (slotBytes() + delta > byteLimit) {
            const err = new Error('QuotaExceededError');
            err.name = 'QuotaExceededError';
            throw err;
          }
        }
        return origSet.call(this, k, v);
      });
    return () => spy.mockRestore();
  }

  function withSilencedWarn(fn: () => void | Promise<void>): void | Promise<void> {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      return fn();
    } finally {
      warnSpy.mockRestore();
    }
  }

  function makeFatBlob(undoLen: number): AutosaveBlob {
    // Build an undoRing of progress snapshots with a "comparisons"
    // counter we can verify post-trim. Each entry is small but cumulative
    // length grows linearly with undoLen.
    const ring: MergeProgress[] = [];
    for (let i = 0; i < undoLen; i++) ring.push(makeProgress(i));
    return {
      items: {
        a: { id: 'a', label: 'Alpha' },
        b: { id: 'b', label: 'Bravo' },
      },
      progress: makeProgress(undoLen),
      undoRing: ring,
    };
  }

  type Notification = { err: AutosaveError | null; recovery?: AutosaveRecovery };
  // Collect notifications into an array and read the last one — this
  // sidesteps the TS quirk where `let x: Notification | null = null`
  // gets narrowed to `never` after a closure assignment from inside the
  // callback (which TS can't see during flow analysis).
  function last(events: Notification[]): Notification | undefined {
    return events[events.length - 1];
  }

  it('trims the on-disk undoRing on quota error and notifies the listener with newUndoRingLen', async () => {
    const slot = mintSlot(makeBlob(0), 'A');
    const events: Notification[] = [];
    const unsub = subscribeAutosaveError((err, recovery) => {
      events.push({ err, recovery });
    });
    // Empirical sizes (from /tmp/dbg.mjs): blob20 = ~4548 bytes,
    // trimmed-to-5 = ~1408 bytes, plain blob0 = ~358 bytes. Pick a
    // limit that the fat blob clearly exceeds but the trimmed-to-5
    // blob fits under comfortably.
    const restore = installQuotaLimit(2000);
    try {
      await withSilencedWarn(async () => {
        scheduleAutosave(makeFatBlob(20));
        flushAutosave();
      });
      expect(last(events)?.err).toBeNull();
      expect(last(events)?.recovery?.kind).toBe('trimmed-undo');
      expect(last(events)?.recovery?.newUndoRingLen).toBe(5);
      const onDisk = readSlotBlob(slot.id);
      expect(onDisk?.undoRing.length).toBe(5);
      // The TRIMMED entries are the most recent ones (tail of the ring).
      expect(onDisk?.undoRing[0].comparisons).toBe(15);
      expect(onDisk?.undoRing[4].comparisons).toBe(19);
    } finally {
      restore();
      unsub();
    }
  });

  it('evicts the oldest non-pinned non-active slot when trim alone is insufficient', async () => {
    // Empirical sizes: each makeBlob(0) lands at ~358 bytes on disk
    // (3 × 358 = ~1074 baseline). The full 20-entry blob is ~4548
    // bytes; the trimmed-to-5 version is ~1408 bytes. We size the
    // cap so trim alone fails (existing 1074 + delta 1050 = 2124 >
    // 1900) but trim AFTER evicting one ~358-byte slot succeeds
    // (716 + 1050 = 1766 < 1900). That forces both recovery stages
    // to run and lets us verify exactly one eviction happened.
    const oldA = mintSlot(makeBlob(0), 'OldA');
    updateSlotMeta(oldA.id, { updatedAt: new Date(2020, 0, 1).toISOString() });
    const oldB = mintSlot(makeBlob(0), 'OldB');
    updateSlotMeta(oldB.id, { updatedAt: new Date(2021, 0, 1).toISOString() });
    const active = mintSlot(makeBlob(0), 'Active');
    const events: Notification[] = [];
    const unsub = subscribeAutosaveError((err, recovery) => {
      events.push({ err, recovery });
    });
    const restore = installQuotaLimit(1900);
    try {
      await withSilencedWarn(async () => {
        scheduleAutosave(makeFatBlob(20));
        flushAutosave();
      });
      const m = readManifest();
      expect(m.slots.some((s) => s.id === oldA.id)).toBe(false);
      expect(m.slots.some((s) => s.id === oldB.id)).toBe(true);
      expect(m.slots.some((s) => s.id === active.id)).toBe(true);
      expect(last(events)?.err).toBeNull();
      expect(last(events)?.recovery?.kind).toBe('evicted-slot');
      expect(last(events)?.recovery?.evicted?.id).toBe(oldA.id);
      // The on-disk blob for active is the trimmed-to-5 variant since
      // the trim happened in concert with the eviction.
      expect(readSlotBlob(active.id)?.undoRing.length).toBe(5);
    } finally {
      restore();
      unsub();
    }
  });

  it('surfaces a terminal quota error when all recovery is exhausted', async () => {
    // Pin every other slot so eviction can't free anything.
    const active = mintSlot(makeBlob(0), 'Active');
    const events: Notification[] = [];
    const unsub = subscribeAutosaveError((err, recovery) => {
      events.push({ err, recovery });
    });
    // Refuse every slot-blob write regardless of size.
    const restore = installQuotaLimit(0);
    try {
      await withSilencedWarn(async () => {
        scheduleAutosave(makeFatBlob(20));
        flushAutosave();
      });
      expect(last(events)?.err).not.toBeNull();
      expect(last(events)?.err?.reason).toBe('quota');
      expect(typeof last(events)?.err?.slotCount).toBe('number');
      expect(getLastAutosaveError()?.reason).toBe('quota');
    } finally {
      restore();
      unsub();
    }
    // The active slot's on-disk blob is the original (unchanged from
    // the initial mint). The recovery did not corrupt it.
    expect(readSlotBlob(active.id)?.progress.comparisons).toBe(0);
  });

  it('clears the error on the next successful write', async () => {
    const slot = mintSlot(makeBlob(0), 'A');
    const events: Notification[] = [];
    const unsub = subscribeAutosaveError((err, recovery) => {
      events.push({ err, recovery });
    });
    // Fail once …
    const restore = installQuotaLimit(0);
    await withSilencedWarn(async () => {
      scheduleAutosave(makeFatBlob(20));
      flushAutosave();
    });
    expect(last(events)?.err?.reason).toBe('quota');
    // … then unblock and write normally.
    restore();
    scheduleAutosave(makeBlob(99));
    flushAutosave();
    expect(last(events)?.err).toBeNull();
    expect(readSlotBlob(slot.id)?.progress.comparisons).toBe(99);
    unsub();
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

describe('repairManifestIfCorrupt', () => {
  it('is a no-op when the manifest is valid', () => {
    const slot = mintSlot(makeBlob(3), 'Valid');
    const before = window.localStorage.getItem(MANIFEST_KEY);
    repairManifestIfCorrupt();
    const after = window.localStorage.getItem(MANIFEST_KEY);
    expect(after).toBe(before);
    expect(consumeManifestRepairNotice()).toBeNull();
    expect(readManifest().slots[0].id).toBe(slot.id);
  });

  it('is a no-op when the manifest is missing (fresh install)', () => {
    expect(window.localStorage.getItem(MANIFEST_KEY)).toBeNull();
    repairManifestIfCorrupt();
    expect(consumeManifestRepairNotice()).toBeNull();
  });

  it('rebuilds the manifest from orphaned slot blobs when the manifest is unparseable', () => {
    // Mint two slots through the normal path so their blobs exist on disk.
    const s1 = mintSlot(makeBlob(5), 'First');
    const s2 = mintSlot(makeBlob(8, true), 'Second');
    // Corrupt the manifest blob (simulating a partially-written save or
    // an unrelated localStorage corruption).
    window.localStorage.setItem(MANIFEST_KEY, '{not-valid-json');

    repairManifestIfCorrupt();

    const repairedCount = consumeManifestRepairNotice();
    expect(repairedCount).toBe(2);
    const m = readManifest();
    // activeId is cleared because the original was lost with the manifest.
    expect(m.activeId).toBeNull();
    expect(m.slots.length).toBe(2);
    const idsRecovered = m.slots.map((s) => s.id).sort();
    expect(idsRecovered).toEqual([s1.id, s2.id].sort());
    // Per-slot metadata is rebuilt from the blob contents, including
    // comparisons + done flags so the LIST tab shows accurate info.
    const meta1 = m.slots.find((s) => s.id === s1.id)!;
    const meta2 = m.slots.find((s) => s.id === s2.id)!;
    expect(meta1.comparisons).toBe(5);
    expect(meta1.done).toBe(false);
    expect(meta2.comparisons).toBe(8);
    expect(meta2.done).toBe(true);
  });

  it('rebuilds when the manifest has the wrong shape (e.g. wrong version)', () => {
    const s1 = mintSlot(makeBlob(1), 'A');
    window.localStorage.setItem(MANIFEST_KEY, JSON.stringify({ version: 99, slots: 'not-an-array' }));
    repairManifestIfCorrupt();
    expect(consumeManifestRepairNotice()).toBe(1);
    expect(readManifest().slots[0].id).toBe(s1.id);
  });

  it('reports 0 when the manifest is corrupt and no slot blobs exist on disk', () => {
    window.localStorage.setItem(MANIFEST_KEY, 'garbage');
    repairManifestIfCorrupt();
    expect(consumeManifestRepairNotice()).toBe(0);
    expect(readManifest().slots).toEqual([]);
  });

  it('consumeManifestRepairNotice returns null on subsequent reads after the first consume', () => {
    window.localStorage.setItem(MANIFEST_KEY, 'still-broken');
    repairManifestIfCorrupt();
    expect(consumeManifestRepairNotice()).toBe(0);
    expect(consumeManifestRepairNotice()).toBeNull();
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
  it('legacy v1 blob with no engine field is upgraded to engine=merge with current defaults', () => {
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
        // No engine, no toBeInserted, no Place/Insert fields.
      },
      undoRing: [],
    };
    window.localStorage.setItem('sorter:v1', JSON.stringify(legacyV1));

    const m = migrateLegacyIfNeeded();
    const blob = readSlotBlob(m.slots[0].id)!;

    expect(blob.progress.engine).toBe('merge');
    if (blob.progress.engine === 'merge') {
      expect(blob.progress.toBeInserted).toEqual([]);
      expect(blob.progress.pendingManualInserts).toEqual([]);
      expect(blob.progress.currentManualInsert).toBeNull();
      expect(blob.progress.currentAutoInsert).toBeNull();
      expect(blob.progress.comparisons).toBe(5);
      expect(blob.progress.totalComparisonsEverNeeded).toBe(7);
    }
  });

  it('current merge blob round-trips through readSlotBlob unchanged', () => {
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
        toBeInserted: ['b'],
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
      expect(read.progress.toBeInserted).toEqual(['b']);
      expect(read.progress.hidden).toEqual(['b']);
      expect(read.progress.currentAutoInsert).toBeNull();
    }
  });

  it('insertion blob round-trips and preserves all fields', () => {
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

  // Phase D: Item.source is optional + additive, so we keep readSlotBlob /
  // writeSlotBlob blind to its presence (forward+backward compat). These
  // tests pin the contract that an AniList-tagged item flows through the
  // autosave blob untouched and an absent .source stays absent (defaults
  // to manual at the helper layer, not at the persistence layer).
  it('preserves an Item.source = anilist tag through the autosave blob', () => {
    const blob: AutosaveBlob = {
      items: {
        a: {
          id: 'a',
          label: 'Cowboy Bebop',
          imageUrl: 'https://cdn.example/c.jpg',
          source: { kind: 'anilist', externalId: 12345 },
        },
        b: { id: 'b', label: 'Manual entry' },
      },
      progress: makeProgress(),
      undoRing: [],
    };
    const meta = mintSlot(blob, 'AniList round-trip');
    const read = readSlotBlob(meta.id)!;
    expect(read.items.a.source).toEqual({ kind: 'anilist', externalId: 12345 });
    // Manual items round-trip with `.source` undefined (not added at write).
    expect(read.items.b.source).toBeUndefined();
  });
});

// ============================================================================
// loadSaveFromFile — version handling + upgrade through the public entry point
// ============================================================================

describe('loadSaveFromFile', () => {
  it('accepts a v1 file and upgrades progress to engine=merge with current defaults', async () => {
    const v1: SaveFile = {
      version: 1,
      createdAt: '2026-05-19T00:00:00.000Z',
      items: {
        a: { id: 'a', label: 'Alpha' },
        b: { id: 'b', label: 'Bravo' },
      },
      // intentionally typed loose — v1 didn't have engine/toBeInserted/etc.
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
      expect(blob.progress.toBeInserted).toEqual([]);
      expect(blob.progress.pendingManualInserts).toEqual([]);
      expect(blob.progress.currentManualInsert).toBeNull();
      expect(blob.progress.currentAutoInsert).toBeNull();
      expect(blob.progress.queue).toEqual([['a'], ['b']]);
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

  it('upgrades each undoRing entry to current shape too', async () => {
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
        expect(u.toBeInserted).toEqual([]);
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

describe('exportAllSlots / importAllSlots', () => {
  it('round-trips an empty store into another empty store', () => {
    const archive = exportAllSlots();

    // Wipe + re-import. Re-prime so the in-module activeId is null.
    window.localStorage.clear();
    primeActiveSlot();

    const result = importAllSlots(archive, 'merge');
    expect(result.error).toBeUndefined();
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.renamedIds).toEqual([]);
    expect(readManifest().slots).toEqual([]);
  });

  it('round-trips a populated store via merge into an empty store', () => {
    const blobA = makeBlob(3, false);
    const blobB = makeBlob(8, true);
    const metaA = mintSlot(blobA, 'Slot A');
    const metaB = mintSlot(blobB, 'Slot B');
    const originalManifest = readManifest();

    const archive = exportAllSlots();

    // Wipe everything and re-import into a fresh store.
    window.localStorage.clear();
    primeActiveSlot();

    const result = importAllSlots(archive, 'merge');
    expect(result.error).toBeUndefined();
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.renamedIds).toEqual([]);

    const restored = readManifest();
    // Round-trip preserves both metas (id, name, pinned, timestamps).
    const restoredById = new Map(restored.slots.map((s) => [s.id, s]));
    expect(restoredById.get(metaA.id)?.name).toBe('Slot A');
    expect(restoredById.get(metaB.id)?.name).toBe('Slot B');
    // Compare modulo activeId — merge mode does not adopt the archive's
    // active slot. The original was active, the restored is not (merge
    // keeps the user's current null active).
    expect(restored.slots.length).toBe(originalManifest.slots.length);

    // Blobs round-trip with progress / undo intact.
    const restoredA = readSlotBlob(metaA.id);
    const restoredB = readSlotBlob(metaB.id);
    expect(restoredA?.progress.comparisons).toBe(3);
    expect(restoredA?.progress.done).toBe(false);
    expect(restoredB?.progress.comparisons).toBe(8);
    expect(restoredB?.progress.done).toBe(true);
  });

  it('merge with collisions mints fresh ids and reports the renames', () => {
    const blobA = makeBlob(1, false);
    const metaA = mintSlot(blobA, 'Slot A');

    const archive = exportAllSlots();

    // Don't wipe — re-import on top of the same store so id collides.
    const result = importAllSlots(archive, 'merge');
    expect(result.error).toBeUndefined();
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.renamedIds.length).toBe(1);
    expect(result.renamedIds[0].from).toBe(metaA.id);
    expect(result.renamedIds[0].to).not.toBe(metaA.id);

    const m = readManifest();
    // Original slot is still there; the imported copy got a fresh id.
    expect(m.slots.length).toBe(2);
    expect(m.slots.some((s) => s.id === metaA.id)).toBe(true);
    expect(
      m.slots.some((s) => s.id === result.renamedIds[0].to),
    ).toBe(true);
    // Both blobs are readable (no clobber).
    expect(readSlotBlob(metaA.id)?.progress.comparisons).toBe(1);
    expect(readSlotBlob(result.renamedIds[0].to)?.progress.comparisons).toBe(1);
  });

  it('replace wipes existing slots that are not in the archive', () => {
    const metaA = mintSlot(makeBlob(1, false), 'Slot A');
    const archive = exportAllSlots();

    // Add more slots that the archive doesn't know about.
    const metaB = mintSlot(makeBlob(2, false), 'Slot B');
    const metaC = mintSlot(makeBlob(3, false), 'Slot C');
    expect(readManifest().slots.length).toBe(3);

    const result = importAllSlots(archive, 'replace');
    expect(result.error).toBeUndefined();
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);

    const m = readManifest();
    expect(m.slots.length).toBe(1);
    expect(m.slots[0].id).toBe(metaA.id);
    // B and C blobs were wiped from disk.
    expect(readSlotBlob(metaB.id)).toBeNull();
    expect(readSlotBlob(metaC.id)).toBeNull();
  });

  it('replace adopts the archive activeId when its blob survived', () => {
    mintSlot(makeBlob(1, false), 'Slot A');
    const metaB = mintSlot(makeBlob(2, false), 'Slot B');
    // metaB is active because it was the most recent mint.
    expect(readManifest().activeId).toBe(metaB.id);

    const archive = exportAllSlots();

    // Wipe and replace from the archive.
    window.localStorage.clear();
    primeActiveSlot();
    const result = importAllSlots(archive, 'replace');
    expect(result.error).toBeUndefined();

    const m = readManifest();
    expect(m.activeId).toBe(metaB.id);
  });

  it('returns an error for invalid JSON without touching disk', () => {
    mintSlot(makeBlob(1, false), 'Slot A');
    const before = window.localStorage.getItem(MANIFEST_KEY);

    const result = importAllSlots('not json {{{', 'merge');
    expect(result.error).toMatch(/not valid JSON/);
    expect(result.imported).toBe(0);

    // Manifest unchanged.
    expect(window.localStorage.getItem(MANIFEST_KEY)).toBe(before);
  });

  it('returns an error for wrong archiveVersion without touching disk', () => {
    mintSlot(makeBlob(1, false), 'Slot A');
    const before = window.localStorage.getItem(MANIFEST_KEY);

    const result = importAllSlots(
      JSON.stringify({ archiveVersion: 99, manifest: {}, blobs: {} }),
      'merge',
    );
    expect(result.error).toMatch(/Unsupported archive version/);
    expect(result.imported).toBe(0);

    expect(window.localStorage.getItem(MANIFEST_KEY)).toBe(before);
  });

  it('returns an error in merge mode when total would exceed SLOT_CAP', () => {
    // Fill store to (SLOT_CAP - 1) so merging anything > 1 overflows.
    for (let i = 0; i < SLOT_CAP - 1; i++) {
      mintSlot(makeBlob(i, false), `Slot ${i}`);
    }
    expect(readManifest().slots.length).toBe(SLOT_CAP - 1);

    // Build an archive with 5 slots in a separate, isolated store.
    const sideStore: SlotMeta[] = [];
    // Temporarily wipe, build the archive, then restore. We use a
    // detour through localStorage because exportAllSlots reads live
    // store state.
    const snapshot: Record<string, string> = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k) snapshot[k] = window.localStorage.getItem(k) ?? '';
    }
    window.localStorage.clear();
    primeActiveSlot();
    for (let i = 0; i < 5; i++) {
      sideStore.push(mintSlot(makeBlob(i, false), `Archive ${i}`));
    }
    const archive = exportAllSlots();

    // Restore original store contents.
    window.localStorage.clear();
    for (const [k, v] of Object.entries(snapshot)) {
      window.localStorage.setItem(k, v);
    }
    primeActiveSlot();
    const before = window.localStorage.getItem(MANIFEST_KEY);

    const result = importAllSlots(archive, 'merge');
    expect(result.error).toMatch(/exceed the/);
    expect(result.error).toContain('slot cap');
    expect(result.imported).toBe(0);
    // Disk unchanged.
    expect(window.localStorage.getItem(MANIFEST_KEY)).toBe(before);
    // Side-store metas reference: nothing else asserted, but typing
    // requires the local to be used somewhere.
    expect(sideStore.length).toBe(5);
  });

  it('replace mode hard-caps at SLOT_CAP and reports the overflow as skipped', () => {
    // Build an oversized archive by directly synthesizing the envelope
    // — we don't need to actually persist (SLOT_CAP + 5) slots first.
    const blobs: Record<string, AutosaveBlob> = {};
    const slots: SlotMeta[] = [];
    const overage = 5;
    for (let i = 0; i < SLOT_CAP + overage; i++) {
      const id = `archive${i.toString().padStart(2, '0')}`;
      blobs[id] = makeBlob(i, false);
      slots.push({
        id,
        name: `Archive ${i}`,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        totalItems: 2,
        comparisons: i,
        done: false,
      });
    }
    const archive = JSON.stringify({
      archiveVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      manifest: { version: 1, activeId: null, slots },
      blobs,
    });

    const result = importAllSlots(archive, 'replace');
    expect(result.error).toBeUndefined();
    expect(result.imported).toBe(SLOT_CAP);
    expect(result.skipped).toBe(overage);
    expect(readManifest().slots.length).toBe(SLOT_CAP);
  });

  it('preserves the pinned flag through round-trip', () => {
    const metaA = mintSlot(makeBlob(1, false), 'Slot A');
    pinSlot(metaA.id, true);
    expect(readManifest().slots.find((s) => s.id === metaA.id)?.pinned).toBe(
      true,
    );

    const archive = exportAllSlots();

    window.localStorage.clear();
    primeActiveSlot();
    const result = importAllSlots(archive, 'merge');
    expect(result.error).toBeUndefined();

    const restored = readManifest().slots.find((s) => s.id === metaA.id);
    expect(restored?.pinned).toBe(true);
  });

  it('skips blobs whose meta has no matching entry in archive.blobs', () => {
    // Construct an envelope where the manifest references two slots
    // but only one has a blob attached. The orphan meta should be
    // counted as skipped, not imported.
    const goodBlob = makeBlob(2, false);
    const archive = JSON.stringify({
      archiveVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      manifest: {
        version: 1,
        activeId: null,
        slots: [
          {
            id: 'orphan',
            name: 'Orphan',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            totalItems: 2,
            comparisons: 0,
            done: false,
          },
          {
            id: 'real',
            name: 'Real',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            totalItems: 2,
            comparisons: 2,
            done: false,
          },
        ],
      },
      blobs: { real: goodBlob },
    });

    const result = importAllSlots(archive, 'merge');
    expect(result.error).toBeUndefined();
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(readManifest().slots.find((s) => s.id === 'real')).toBeDefined();
    expect(readManifest().slots.find((s) => s.id === 'orphan')).toBeUndefined();
  });
});
