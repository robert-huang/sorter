import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  InsertionState,
  Item,
  ItemId,
  MergeState,
  SlotsManifest,
  SortProgress,
  SortState,
} from './lib/types';
import {
  addItem as engineAddItem,
  addItems as engineAddItems,
  type EngineOptions,
  getRanking as engineGetRanking,
  hideItem as engineHideItem,
  pickLeft as enginePickLeft,
  pickRight as enginePickRight,
  reorderInSorted as engineReorderInSorted,
  restoreProgress as engineRestoreProgress,
  returnToPending as engineReturnToPending,
  snapshotProgress as engineSnapshotProgress,
  transitionMergeDoneToInsertion,
  unhideItem as engineUnhideItem,
  updateItem as engineUpdateItem,
} from './lib/engine';
import {
  appendPreRankedSublist,
  breakApartSublist,
  cancelManualInsert,
  forgetUnplaced,
  initSort,
  manualInsert,
  reorderInSublist,
  seedFromSublists,
} from './lib/queueMergeSort';
import {
  addItems as insertionAddItems,
  seedAsSorted,
} from './lib/insertionSort';
import {
  type AutosaveBlob,
  autoNameFromBlob,
  createSlot,
  deleteSlot,
  downloadSave,
  flushAutosave,
  isAutosaveAvailable,
  loadSaveFromFile,
  migrateLegacyIfNeeded,
  peekEvictionTarget,
  primeActiveSlot,
  readManifest,
  readSettings,
  readSlotBlob,
  renameSlot,
  scheduleAutosave,
  setActiveSlot,
  updateSettings,
  type ThemeName,
} from './lib/storage';
import type { SlotMeta } from './lib/types';
import { Header, type TabId } from './components/Header';
import { StartScreen } from './components/StartScreen';
import { CompareScreen, type LastInteraction } from './components/CompareScreen';
import { ListScreen } from './components/ListScreen';
import { ResultScreen } from './components/ResultScreen';
import { SlotCapConfirmModal } from './components/SlotCapConfirmModal';
import { SlotDeleteConfirmModal } from './components/SlotDeleteConfirmModal';
import { StartOverConfirmModal } from './components/StartOverConfirmModal';
import { useKeyboard } from './hooks/useKeyboard';

const UNDO_CAP = 50;

interface SavedSession {
  state: SortState;
  undoRing: SortProgress[];
}

function deserialize(raw: AutosaveBlob | null): SavedSession | null {
  if (!raw) return null;
  // storage.upgradeProgress has already normalized progress to a v2
  // shape with engine discriminator. Tag the state by engine.
  const state: SortState =
    raw.progress.engine === 'insertion'
      ? ({ ...raw.progress, items: raw.items } as InsertionState)
      : ({ ...raw.progress, items: raw.items } as MergeState);
  return { state, undoRing: raw.undoRing ?? [] };
}

function buildBlob(state: SortState, undoRing: SortProgress[]): AutosaveBlob {
  return {
    items: state.items,
    progress: engineSnapshotProgress(state),
    undoRing,
  };
}

/**
 * Boot-time read: run legacy migration, prime the in-module active-slot
 * pointer, return the manifest. We deliberately do NOT auto-load the
 * active slot's blob on refresh — the user always lands on START and
 * resumes explicitly via the "last used" CTA or the slot list in the
 * gear menu. This avoids surprising users with a stale session and keeps
 * refresh-as-escape-hatch behavior intact.
 */
function bootRead(): { manifest: SlotsManifest } {
  migrateLegacyIfNeeded();
  primeActiveSlot();
  return { manifest: readManifest() };
}

export function App() {
  const [autosaveOn] = useState(() => isAutosaveAvailable());
  const [state, setState] = useState<SortState | null>(null);
  const [undoRing, setUndoRing] = useState<SortProgress[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('start');
  // The most recent user interaction that *changed the current pair*. The
  // CompareScreen animation reads this so it knows which side to slide the
  // outgoing pair toward (or to snap on undo). Distinct from `state` so the
  // animation triggers on every action, even repeated same-side picks.
  const [lastInteraction, setLastInteraction] = useState<LastInteraction>(null);
  const [manifest, setManifest] = useState<SlotsManifest>(() => ({
    version: 1,
    activeId: null,
    slots: [],
  }));
  // A pending slot-delete confirmation. When non-null, SlotDeleteConfirmModal
  // is shown. Used for both the toolbar "Delete this slot" flow and the
  // per-row trashcan in the gear-popover slot list — both routes go through
  // requestDeleteSlot so the modal and the "Don't ask again" preference are
  // shared.
  const [slotPendingDelete, setSlotPendingDelete] = useState<
    { id: string; name: string } | null
  >(null);
  // A pending "Start over" confirmation on the RESULT tab. When non-null,
  // StartOverConfirmModal is shown. itemCount feeds the modal copy.
  const [startOverPending, setStartOverPending] = useState<
    { itemCount: number } | null
  >(null);
  // Pre-flight at the slot-cap. When non-null, SlotCapConfirmModal is
  // shown listing the slot that will be silently evicted by the next
  // createSlot call. The `commit` callback runs the real mint; `cancel`
  // drops the staged session without persisting anything.
  const [capPending, setCapPending] = useState<
    {
      victim: SlotMeta;
      commit: () => void;
      cancel: () => void;
    } | null
  >(null);
  const [skippedMessage, setSkippedMessage] = useState<string | null>(null);
  const skippedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Settings-backed UI state. Read once on boot; written through
  // updateSettings so the next mount picks them up.
  const [theme, setThemeState] = useState<ThemeName>(
    () => readSettings().theme ?? 'light',
  );
  const [showEstimatedRemaining, setShowEstimatedRemainingState] = useState(
    () => !!readSettings().showEstimatedRemaining,
  );
  // Auto-insert defaults ON. We treat any saved value other than the
  // literal `false` as "leave it on" so existing slots get the new
  // behavior the first time they load on a build that knows the flag.
  const [autoInsertEnabled, setAutoInsertEnabledState] = useState(
    () => readSettings().autoInsertEnabled !== false,
  );
  // Stable options bag rebuilt on every toggle change. The engine
  // module re-resolves its own defaults if we pass `undefined`, but
  // we always have a value here so we just pass it straight through.
  // Memoized so identity changes only with the underlying flags —
  // useCallback dep arrays below depend on this.
  const engineOptions: EngineOptions = useMemo(
    () => ({ autoInsertEnabled }),
    [autoInsertEnabled],
  );
  // Pending merge→insertion transition for the "+ Add items" flow on the
  // RESULT screen. Non-null while the confirm modal is shown.
  const [pendingTransition, setPendingTransition] = useState<{
    items: Item[];
  } | null>(null);

  // -------- boot: migrate + read manifest only --------
  // We intentionally don't auto-load the active slot's blob here. Refresh
  // always returns the user to START; the "Resume last used" CTA or the
  // gear-menu slot list re-enters a sort explicitly.
  useEffect(() => {
    const { manifest: m } = bootRead();
    setManifest(m);
  }, []);

  // -------- apply theme to <html> attribute (boot + every toggle) --------
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // -------- autosave: schedule on every state change, flush on tab close --------
  useEffect(() => {
    if (!autosaveOn || !state) return;
    scheduleAutosave(buildBlob(state, undoRing));
  }, [state, undoRing, autosaveOn]);

  useEffect(() => {
    function onBeforeUnload(): void {
      flushAutosave();
    }
    function onVisibility(): void {
      if (document.visibilityState === 'hidden') flushAutosave();
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // -------- document.title --------
  // Title format: "<slot name> — Sorter" (with " ✓" suffix when done),
  // or just "Sorter" when no slot is loaded. The slot name beats the
  // comparisons-remaining counter because users running multiple
  // sorter tabs in parallel need to tell them apart at a glance, and
  // the in-app header already shows "Comparison #N" / "~M left".
  // `manifest` is in the deps so a rename via the gear menu re-titles
  // the tab immediately.
  useEffect(() => {
    if (!state) {
      document.title = 'Sorter';
      return;
    }
    const slotName = manifest.slots.find((s) => s.id === manifest.activeId)?.name;
    const base = slotName ?? 'Untitled sort';
    document.title = state.done ? `${base} ✓ — Sorter` : `${base} — Sorter`;
  }, [state, manifest]);

  // -------- theme + settings toggles --------
  const toggleTheme = useCallback(() => {
    setThemeState((cur) => {
      const next: ThemeName = cur === 'dark' ? 'light' : 'dark';
      updateSettings({ theme: next });
      return next;
    });
  }, []);

  const toggleShowEstimatedRemaining = useCallback(() => {
    setShowEstimatedRemainingState((cur) => {
      const next = !cur;
      updateSettings({ showEstimatedRemaining: next });
      return next;
    });
  }, []);

  const toggleAutoInsertEnabled = useCallback(() => {
    setAutoInsertEnabledState((cur) => {
      const next = !cur;
      updateSettings({ autoInsertEnabled: next });
      return next;
    });
  }, []);

  // -------- transitions --------
  const pushUndo = useCallback((prior: SortState) => {
    setUndoRing((ring) => {
      const next = ring.concat(engineSnapshotProgress(prior));
      if (next.length > UNDO_CAP) next.shift();
      return next;
    });
  }, []);

  const flashSkipped = useCallback((msg: string) => {
    setSkippedMessage(msg);
    if (skippedTimer.current) clearTimeout(skippedTimer.current);
    skippedTimer.current = setTimeout(() => setSkippedMessage(null), 4000);
  }, []);

  const doPick = useCallback(
    (side: 'left' | 'right') => {
      setState((cur) => {
        if (!cur) return cur;
        pushUndo(cur);
        return side === 'left'
          ? enginePickLeft(cur, engineOptions)
          : enginePickRight(cur, engineOptions);
      });
      // Stamp the interaction *after* the state change so the CompareScreen
      // effect (which fires on pair change) reads the freshest side.
      setLastInteraction({ kind: 'pick', side });
    },
    [pushUndo, engineOptions],
  );

  const doHide = useCallback(
    (id: ItemId) => {
      setState((cur) => {
        if (!cur) return cur;
        pushUndo(cur);
        return engineHideItem(cur, id, engineOptions);
      });
    },
    [pushUndo, engineOptions],
  );

  const doUnhide = useCallback(
    (id: ItemId) => {
      setState((cur) => {
        if (!cur) return cur;
        pushUndo(cur);
        return engineUnhideItem(cur, id);
      });
    },
    [pushUndo],
  );

  // In-place metadata edit (label / url / imageUrl). `engineUpdateItem`
  // returns the same state reference when nothing actually changes —
  // that's our signal to NOT push an undo frame and NOT trigger a state
  // re-render. Driving use-case: fixing labels whose commas got eaten by
  // the CSV parser at import time.
  const doEditItem = useCallback(
    (id: ItemId, patch: { label?: string; url?: string; imageUrl?: string }) => {
      setState((cur) => {
        if (!cur) return cur;
        const next = engineUpdateItem(cur, id, patch);
        if (next === cur) return cur;
        pushUndo(cur);
        return next;
      });
    },
    [pushUndo],
  );

  // ---- merge-only operations: reorder / break / append pre-ranked ----
  const doReorder = useCallback(
    (queueIndex: number, itemIndex: number, dir: -1 | 1) => {
      setState((cur) => {
        if (!cur || cur.engine !== 'merge') return cur;
        pushUndo(cur);
        return reorderInSublist(cur, queueIndex, itemIndex, dir);
      });
    },
    [pushUndo],
  );

  const doBreak = useCallback(
    (queueIndex: number) => {
      setState((cur) => {
        if (!cur || cur.engine !== 'merge') return cur;
        pushUndo(cur);
        return breakApartSublist(cur, queueIndex, engineOptions);
      });
    },
    [pushUndo, engineOptions],
  );

  const doAppendPreRanked = useCallback(
    (items: Item[]) => {
      setState((cur) => {
        if (!cur || cur.engine !== 'merge') return cur;
        pushUndo(cur);
        const { state: next, skipped } = appendPreRankedSublist(
          cur,
          items,
          engineOptions,
        );
        if (skipped.length > 0) {
          flashSkipped(
            `Skipped ${skipped.length} item${skipped.length === 1 ? '' : 's'} already in the sort.`,
          );
        }
        return next;
      });
    },
    [pushUndo, flashSkipped, engineOptions],
  );

  // ---- manual insert (merge-only) ----
  const doManualInsert = useCallback(
    (id: ItemId) => {
      setState((cur) => {
        if (!cur || cur.engine !== 'merge') return cur;
        pushUndo(cur);
        return manualInsert(cur, id, engineOptions);
      });
    },
    [pushUndo, engineOptions],
  );

  const doForget = useCallback(
    (id: ItemId) => {
      setState((cur) => {
        if (!cur || cur.engine !== 'merge') return cur;
        pushUndo(cur);
        return forgetUnplaced(cur, id, engineOptions);
      });
    },
    [pushUndo, engineOptions],
  );

  const doCancelManualInsert = useCallback(() => {
    setState((cur) => {
      if (!cur || cur.engine !== 'merge') return cur;
      pushUndo(cur);
      return cancelManualInsert(cur, engineOptions);
    });
  }, [pushUndo, engineOptions]);

  // ---- insertion-engine freeze-relax: ↑/↓ in sorted, ↻ re-insert ----
  // Both mutations cancel-and-restart any in-flight frame, which the
  // user pays for in extra comparisons. We flash a short toast each
  // time so the cost isn't a surprise.
  const doReorderInSorted = useCallback(
    (sortedIndex: number, dir: -1 | 1) => {
      setState((cur) => {
        if (!cur || cur.engine !== 'insertion') return cur;
        const hadFrame = cur.current !== null;
        pushUndo(cur);
        const next = engineReorderInSorted(cur, sortedIndex, dir);
        if (hadFrame && next !== cur) {
          flashSkipped(
            'Restarted the current insert — its bounds were invalidated by the reorder.',
          );
        }
        return next;
      });
    },
    [pushUndo, flashSkipped],
  );

  const doReturnToPending = useCallback(
    (id: ItemId) => {
      setState((cur) => {
        if (!cur || cur.engine !== 'insertion') return cur;
        pushUndo(cur);
        const next = engineReturnToPending(cur, id);
        if (next !== cur) {
          flashSkipped(
            `Re-inserting "${cur.items[id]?.label ?? id}" — pulled back out of the sorted list.`,
          );
        }
        return next;
      });
    },
    [pushUndo, flashSkipped],
  );

  // ---- single-item add: engine-aware, mutates current slot ----
  const doAddItem = useCallback(
    (item: Item) => {
      setState((cur) => {
        if (!cur) return cur;
        const next = engineAddItem(cur, item, engineOptions);
        if (next === null) return cur;
        pushUndo(cur);
        return next;
      });
    },
    [pushUndo, engineOptions],
  );

  // ---- multi-item add (LIST tab "Multiple" tab): engine-aware ----
  // Insertion → appends each to pending FIFO. Merge → appends N singleton
  // sublists. For "merge a pre-ranked sublist" semantics, see
  // `doAppendPreRanked` instead.
  const doAddItemsList = useCallback(
    (items: Item[]) => {
      if (items.length === 0) return;
      setState((cur) => {
        if (!cur) return cur;
        const { state: next, skipped } = engineAddItems(cur, items, engineOptions);
        if (skipped.length > 0) {
          flashSkipped(
            `Skipped ${skipped.length} item${skipped.length === 1 ? '' : 's'} already in the sort.`,
          );
        }
        // engineAddItems always returns a new state object; push the
        // pre-add state onto undo unless nothing actually changed.
        if (next === cur) return cur;
        pushUndo(cur);
        return next;
      });
    },
    [pushUndo, flashSkipped, engineOptions],
  );

  // ---- batch-add via "+ Add items" — engine-aware in-place mutation ----
  // For merge engine that's already done, this triggers a confirm modal
  // that warns about leaving the queue-merge structure behind (we can't
  // undo back across the transition only via the in-memory undo ring,
  // since the ring is bounded).
  const doAddItemsBatch = useCallback(
    (items: Item[]) => {
      if (!state || items.length === 0) return;
      if (state.engine === 'insertion') {
        pushUndo(state);
        const { state: next, skipped } = insertionAddItems(state, items);
        if (skipped.length > 0) {
          flashSkipped(
            `Skipped ${skipped.length} item${skipped.length === 1 ? '' : 's'} already in the sort.`,
          );
        }
        setState(next);
        setActiveTab('rank');
        return;
      }
      // Merge engine: if not done, we just append a pre-ranked sublist
      // and stay on merge engine. If done, ask the user whether they
      // want to switch to insertion mode (much faster) — that's the
      // engine-transition pathway.
      if (!state.done) {
        doAppendPreRanked(items);
        return;
      }
      setPendingTransition({ items });
    },
    [state, pushUndo, flashSkipped, doAppendPreRanked],
  );

  const confirmTransition = useCallback(() => {
    if (!state || state.engine !== 'merge' || !pendingTransition) return;
    pushUndo(state);
    const { state: next, skipped } = transitionMergeDoneToInsertion(
      state,
      pendingTransition.items,
    );
    if (skipped.length > 0) {
      flashSkipped(
        `Skipped ${skipped.length} item${skipped.length === 1 ? '' : 's'} already in the sort.`,
      );
    }
    setState(next);
    setUndoRing((ring) => ring); // ring already pushed via pushUndo
    setActiveTab('rank');
    setPendingTransition(null);
  }, [state, pendingTransition, pushUndo, flashSkipped]);

  const cancelTransition = useCallback(() => {
    setPendingTransition(null);
  }, []);

  const doUndo = useCallback(() => {
    setUndoRing((ring) => {
      if (ring.length === 0) return ring;
      const last = ring[ring.length - 1];
      setState((cur) => (cur ? engineRestoreProgress(cur, last) : cur));
      return ring.slice(0, -1);
    });
    setLastInteraction({ kind: 'undo' });
  }, []);

  // -------- slot mint helpers --------
  /**
   * Inner mint: persist the new slot, swap the in-memory state to its
   * session, and flash a toast if the storage layer had to evict
   * something. Pre-condition: caller has either confirmed the
   * eviction via the cap modal or verified we're below cap.
   */
  const performSlotMint = useCallback(
    (session: SavedSession, name: string, initialTab?: TabId) => {
      const blob = buildBlob(session.state, session.undoRing);
      const { evicted } = createSlot(blob, name);
      setManifest(readManifest());
      setState(session.state);
      setUndoRing(session.undoRing);
      setActiveTab(
        initialTab ?? (session.state.done ? 'result' : 'rank'),
      );
      // Eviction is loud: the user gave consent via the modal in the
      // common case, but the safety-net eviction inside createSlot can
      // still trip if some race nudged us past cap between the peek and
      // the mint. Either way, surface what got deleted.
      if (evicted.length > 0) {
        const names = evicted.map((e) => `"${e.name}"`).join(', ');
        flashSkipped(
          `Made room: deleted oldest slot${evicted.length === 1 ? '' : 's'} ${names}.`,
        );
      }
    },
    [flashSkipped],
  );

  /**
   * Mint a new slot for the given session and activate it. Used by all
   * "start a sort" paths (scratch, pre-ranked, already-sorted CSV, file
   * load, and RESULT-tab Start Over).
   *
   * `initialTab` overrides the default landing tab. Default = RESULT
   * when the seeded state is already done, else RANK. Start Over uses
   * this to land on LIST instead so the user can review / tweak the
   * starting queue before making the first comparison.
   *
   * Pre-flight at the cap: if minting would push us past `SLOT_CAP`,
   * we stage the mint and pop a `SlotCapConfirmModal` first. The user
   * picks Cancel / Download oldest first / Delete oldest & continue,
   * and only then do we call into the storage layer.
   */
  const adoptNewSession = useCallback(
    (session: SavedSession, name: string, initialTab?: TabId) => {
      const victim = peekEvictionTarget();
      if (victim) {
        setCapPending({
          victim,
          cancel: () => setCapPending(null),
          commit: () => {
            setCapPending(null);
            performSlotMint(session, name, initialTab);
          },
        });
        return;
      }
      performSlotMint(session, name, initialTab);
    },
    [performSlotMint],
  );

  // -------- start --------
  const onStartScratch = useCallback(
    (items: Item[]) => {
      const next = initSort(items, engineOptions);
      const session: SavedSession = { state: next, undoRing: [] };
      adoptNewSession(session, autoNameFromBlob(buildBlob(next, [])));
    },
    [adoptNewSession, engineOptions],
  );

  const onStartPreranked = useCallback(
    (args: { sublists: Item[][]; extras: Item[] }) => {
      const next = seedFromSublists(args, engineOptions);
      const session: SavedSession = { state: next, undoRing: [] };
      adoptNewSession(session, autoNameFromBlob(buildBlob(next, [])));
    },
    [adoptNewSession, engineOptions],
  );

  /**
   * CSV-as-sorted entry point: take the parsed items verbatim as a
   * frozen insertion-mode `sorted[]` with empty `pending[]` (state is
   * immediately `done`). The user can then "+ Add items" later to
   * binary-insert new items.
   */
  const onStartAlreadySorted = useCallback(
    (items: Item[]) => {
      const next = seedAsSorted(items);
      const session: SavedSession = { state: next, undoRing: [] };
      adoptNewSession(session, autoNameFromBlob(buildBlob(next, [])));
    },
    [adoptNewSession],
  );

  // -------- slot management --------
  /**
   * Load (or re-load) a slot into memory and jump to its sort view. Always
   * runs the load even when id === manifest.activeId, because after a
   * refresh `state` is null while activeId may still be set — and the user
   * clicking Resume on the "active" slot expects to actually re-enter it.
   */
  const onSwitchSlot = useCallback((id: string) => {
    setActiveSlot(id); // flushes any pending writes for the OUTGOING slot
    const session = deserialize(readSlotBlob(id));
    if (!session) {
      // Bad data — refresh manifest and stay put.
      setManifest(readManifest());
      return;
    }
    setManifest(readManifest());
    setState(session.state);
    setUndoRing(session.undoRing);
    setActiveTab(session.state.done ? 'result' : 'rank');
  }, []);

  /**
   * Resume the most-recently-used slot — i.e. the manifest's activeId.
   * Used by the "Last used" CTA on the START tab. No-op when there is no
   * activeId (manifest is empty).
   */
  const onResumeActive = useCallback(() => {
    const id = manifest.activeId;
    if (!id) return;
    onSwitchSlot(id);
  }, [manifest.activeId, onSwitchSlot]);

  // Actually perform the delete. Shared by both the modal's Delete button
  // and the suppressed-confirm path of requestDeleteSlot.
  const performDeleteSlot = useCallback(
    (id: string) => {
      const wasActive = manifest.activeId === id;
      const m = deleteSlot(id);
      setManifest(m);
      if (wasActive) {
        setState(null);
        setUndoRing([]);
        setActiveTab('start');
      }
    },
    [manifest.activeId],
  );

  // Single entry-point for "delete this slot, with confirm-unless-suppressed".
  // Used by both the gear-popover trashcan (any slot) and the toolbar "Delete
  // this slot" item (currently active slot). Reads the manifest fresh so the
  // modal title shows the right name even if the manifest closure is stale.
  const requestDeleteSlot = useCallback(
    (id: string) => {
      const slot = readManifest().slots.find((s) => s.id === id);
      if (!slot) return;
      if (readSettings().suppressResetConfirm) {
        performDeleteSlot(id);
      } else {
        setSlotPendingDelete({ id, name: slot.name });
      }
    },
    [performDeleteSlot],
  );

  const onDeleteSlot = requestDeleteSlot;

  const onRenameSlot = useCallback((id: string, name: string) => {
    const m = renameSlot(id, name);
    setManifest(m);
  }, []);

  // Download a JSON copy of any slot's blob — not just the one currently
  // loaded into memory. Used by the per-row download button in the
  // gear-menu slot list (back up before deleting / starting over) and by
  // the SlotCapConfirmModal's "Download oldest first" escape hatch.
  // Distinct from `onDownload`, which exports the IN-MEMORY active session
  // (which may differ from the on-disk blob if there's a pending autosave).
  const onDownloadSlot = useCallback((id: string) => {
    const blob = readSlotBlob(id);
    if (!blob) return;
    downloadSave(blob);
  }, []);

  // -------- save / load file --------
  const onDownload = useCallback(() => {
    if (!state) return;
    downloadSave(buildBlob(state, undoRing));
  }, [state, undoRing]);

  // Force-flush the autosave debounce so the active slot's localStorage
  // blob matches in-memory state right now. Used by the toolbar Save
  // button to give the user explicit "I saved" feedback.
  const onSaveNow = useCallback(() => {
    if (!state) return;
    // Make sure the most up-to-date blob is the pending one before we
    // flush; the effect-based scheduleAutosave may not have fired yet for
    // the very latest state.
    scheduleAutosave(buildBlob(state, undoRing));
    flushAutosave();
    setManifest(readManifest());
  }, [state, undoRing]);

  const onLoadFile = useCallback(
    (file: File) => {
      loadSaveFromFile(file)
        .then((blob) => {
          const session = deserialize(blob);
          if (!session) throw new Error('Invalid save file');
          const baseName = file.name.replace(/\.json$/i, '') || 'Imported';
          adoptNewSession(session, baseName);
        })
        .catch((err: unknown) => {
          alert(
            `Could not load save file: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    },
    [adoptNewSession],
  );

  // -------- reset (now == delete the active slot) --------
  // The toolbar's "Delete this slot" entry just funnels into the same
  // request-delete pipeline as the per-row trashcan, with the active slot
  // pre-selected. Reads the manifest fresh so the right id wins even if
  // the active slot just changed via another path.
  const onResetRequest = useCallback(() => {
    const activeId = readManifest().activeId;
    if (activeId) requestDeleteSlot(activeId);
  }, [requestDeleteSlot]);

  // -------- start over (RESULT tab: mint a NEW slot seeded from results)
  //
  // Semantically this is "use the previous sort's final ranking as the
  // input seed for a brand-new sort" — so we mint a fresh slot (same
  // path as Start Scratch / Pre-ranked / file load) rather than mutating
  // the current one. The old slot stays in the gear-menu list, fully
  // intact; the user can resume it any time. There's no in-state undo
  // because the prior state is preserved as its own slot.
  //
  // Item set = `getRanking(state)` (the visible final ranking), which:
  //   - EXCLUDES hidden items — they were deliberately removed and stay
  //     out of the new sort.
  //   - EXCLUDES `unplaced[]` — items that were exiled but never
  //     re-inserted are likewise dropped.
  //   - For insertion mode, this is just the frozen `sorted[]` minus
  //     hidden, so insertion-mode items get treated like any other
  //     items (their pre-sort "ranking" status doesn't survive).
  // The new singletons are seeded in the previous-ranking order, so the
  // first merge comparisons happen between previously-adjacent items —
  // the highest-information pairing for confirming or revising the
  // earlier ranking.
  const performStartOver = useCallback(() => {
    if (!state) return;
    const items = engineGetRanking(state)
      .map((id) => state.items[id])
      .filter((it): it is Item => !!it);
    if (items.length === 0) return;
    const next = initSort(items, engineOptions);
    const session: SavedSession = { state: next, undoRing: [] };
    // Land on LIST so the user can preview / tweak the seeded queue
    // before committing to the first comparison.
    adoptNewSession(session, autoNameFromBlob(buildBlob(next, [])), 'list');
  }, [state, adoptNewSession, engineOptions]);

  const requestStartOver = useCallback(() => {
    if (!state) return;
    const itemCount = engineGetRanking(state).length;
    if (itemCount === 0) return;
    if (readSettings().suppressStartOverConfirm) {
      performStartOver();
      return;
    }
    setStartOverPending({ itemCount });
  }, [state, performStartOver]);

  // -------- keyboard --------
  useKeyboard(
    {
      onLeft: () => doPick('left'),
      onRight: () => doPick('right'),
      onUp: () => doUndo(),
    },
    activeTab === 'rank' && state !== null && !state.done,
  );

  // -------- derived --------
  const hasState = state !== null;
  const canUndo = undoRing.length > 0;

  // The slot whose blob is currently loaded into memory. Null when state
  // is null (post-refresh, or after deleting the active slot). Used by the
  // gear-menu SlotList to render the "Active" tag *only* on the slot the
  // user is genuinely sorting in right now — not on the orphaned active
  // pointer from a previous session.
  const loadedSlotId = hasState ? manifest.activeId : null;

  // The single-slot Resume CTA on START. Only shown when there's no
  // in-memory session AND we have a previously-active slot to resume.
  const resumeMeta =
    hasState
      ? null
      : manifest.slots.find((s) => s.id === manifest.activeId) ?? null;

  // -------- render --------
  let body: JSX.Element;
  if (activeTab === 'start' || !state) {
    body = (
      <StartScreen
        resumeMeta={resumeMeta}
        onResumeActive={onResumeActive}
        onStartScratch={onStartScratch}
        onStartPreranked={onStartPreranked}
        onStartAlreadySorted={onStartAlreadySorted}
      />
    );
  } else if (activeTab === 'list') {
    body = (
      <ListScreen
        state={state}
        onHide={doHide}
        onUnhide={doUnhide}
        onReorder={doReorder}
        onBreakApart={doBreak}
        onAddItem={doAddItem}
        onAddItems={doAddItemsList}
        onAppendPreRanked={doAppendPreRanked}
        onManualInsert={doManualInsert}
        onForget={doForget}
        onReorderInSorted={doReorderInSorted}
        onReturnToPending={doReturnToPending}
        onEditItem={doEditItem}
      />
    );
  } else if (activeTab === 'rank') {
    body = (
      <CompareScreen
        state={state}
        lastInteraction={lastInteraction}
        onPickLeft={() => doPick('left')}
        onPickRight={() => doPick('right')}
        onHide={doHide}
        onCancelManualInsert={doCancelManualInsert}
        autoInsertEnabled={autoInsertEnabled}
      />
    );
  } else {
    body = (
      <ResultScreen
        state={state}
        onUnhide={doUnhide}
        onStartOver={requestStartOver}
        onAddItems={doAddItemsBatch}
      />
    );
  }

  // Auto-switch to RESULT when sort completes.
  useEffect(() => {
    if (state?.done && activeTab === 'rank') {
      setActiveTab('result');
    }
  }, [state, activeTab]);

  return (
    <div className="app-shell">
      {!autosaveOn && (
        <div className="app-banner">
          Autosave is disabled (this page is open from a <code>file://</code>{' '}
          URL). Use the Download button to keep progress.
        </div>
      )}
      {skippedMessage && <div className="app-banner">{skippedMessage}</div>}
      <Header
        activeTab={activeTab}
        onTabChange={setActiveTab}
        state={state}
        canUndo={canUndo}
        onUndo={doUndo}
        onSaveNow={onSaveNow}
        onDownload={onDownload}
        autosaveAvailable={autosaveOn}
        onLoadFromFile={onLoadFile}
        onReset={onResetRequest}
        manifest={manifest}
        loadedSlotId={loadedSlotId}
        onSwitchSlot={onSwitchSlot}
        onDeleteSlot={onDeleteSlot}
        onRenameSlot={onRenameSlot}
        onDownloadSlot={onDownloadSlot}
        hasState={hasState}
        theme={theme}
        onToggleTheme={toggleTheme}
        showEstimatedRemaining={showEstimatedRemaining}
        onToggleShowEstimatedRemaining={toggleShowEstimatedRemaining}
        autoInsertEnabled={autoInsertEnabled}
        onToggleAutoInsertEnabled={toggleAutoInsertEnabled}
      />
      <main className="app-main">{body}</main>
      {slotPendingDelete && (
        <SlotDeleteConfirmModal
          slotName={slotPendingDelete.name}
          onCancel={() => setSlotPendingDelete(null)}
          onConfirm={(dontAsk) => {
            if (dontAsk) updateSettings({ suppressResetConfirm: true });
            const id = slotPendingDelete.id;
            setSlotPendingDelete(null);
            performDeleteSlot(id);
          }}
        />
      )}
      {pendingTransition && (
        <TransitionConfirmModal
          itemCount={pendingTransition.items.length}
          onCancel={cancelTransition}
          onConfirm={confirmTransition}
        />
      )}
      {startOverPending && (
        <StartOverConfirmModal
          itemCount={startOverPending.itemCount}
          onCancel={() => setStartOverPending(null)}
          onConfirm={(dontAsk) => {
            if (dontAsk) updateSettings({ suppressStartOverConfirm: true });
            setStartOverPending(null);
            performStartOver();
          }}
        />
      )}
      {capPending && (
        <SlotCapConfirmModal
          victim={capPending.victim}
          onCancel={capPending.cancel}
          onDownloadThenContinue={() => {
            // Download first so the user has the JSON safety net, then
            // proceed with the mint — which evicts the victim inside
            // createSlot via the storage-layer cap loop.
            onDownloadSlot(capPending.victim.id);
            capPending.commit();
          }}
          onContinue={capPending.commit}
        />
      )}
    </div>
  );
}

/**
 * Inline confirm modal for the merge→insertion engine transition.
 * Shown when the user clicks "+ Add items" on the RESULT screen of a
 * completed merge sort. Warns that this morphs the slot in-place; the
 * one-step undo can back it out, but they should consider downloading
 * a JSON copy first if they want a long-term safety net.
 */
function TransitionConfirmModal({
  itemCount,
  onCancel,
  onConfirm,
}: {
  itemCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Switch to insertion mode?</h3>
        <p style={{ color: 'var(--text-muted)' }}>
          Adding {itemCount} item{itemCount === 1 ? '' : 's'} to a completed
          sort will switch this slot to <strong>insertion mode</strong>: new
          items get binary-inserted into the existing ranking. You can still
          nudge items up/down or pull them back to re-insert via the
          per-row controls — but those mutations cancel-and-restart the
          current insert (~⌈log₂(N+1)⌉ extra comparisons each).
        </p>
        <p style={{ color: 'var(--text-muted)' }}>
          The previous merge state goes onto the undo ring so a single ↶
          Undo will back this out. If you want a long-term safety net,
          consider downloading a JSON copy first.
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={onConfirm}>
            Switch to insertion mode
          </button>
        </div>
      </div>
    </div>
  );
}
