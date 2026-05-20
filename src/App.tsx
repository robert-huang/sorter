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
  rewriteIdInProgress as engineRewriteIdInProgress,
  snapshotProgress as engineSnapshotProgress,
  transitionMergeDoneToInsertion,
  unhideItem as engineUnhideItem,
  updateItem as engineUpdateItem,
  updateItemId as engineUpdateItemId,
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
import { seedAsSorted } from './lib/insertionSort';
import {
  type AutosaveBlob,
  type AutosaveError,
  autoNameFromBlob,
  createSlot,
  deleteSlot,
  downloadAllSlots,
  downloadSave,
  flushAutosave,
  importAllSlots,
  isAutosaveAvailable,
  loadSaveFromFile,
  MANIFEST_KEY,
  consumeManifestRepairNotice,
  discardPendingAutosave,
  migrateLegacyIfNeeded,
  peekEvictionTarget,
  primeActiveSlot,
  repairManifestIfCorrupt,
  SLOT_CAP,
  slotBlobKey,
  readManifest,
  readSettings,
  readSlotBlob,
  pinSlot,
  renameSlot,
  getLastAutosaveError,
  scheduleAutosave,
  subscribeAutosaveError,
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
import { SharedImportModal } from './components/SharedImportModal';
import { type SharedRanking, decodeShareLink, readShareParamFromHash } from './lib/share';
import { BackupRestoreConfirmModal } from './components/BackupRestoreConfirmModal';
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
  // Repair AFTER legacy migration so the migrate path's freshly-written
  // manifest is treated as canonical. Repair only fires when the
  // manifest is present-but-broken; missing is the empty case.
  repairManifestIfCorrupt();
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
  // Latest terminal autosave failure (or null once cleared). When non-null
  // we render a sticky banner above the app shell explaining that the last
  // save couldn't write and offering the obvious manual remedies (pin /
  // delete slots, download a backup). Subscribed to the storage module so
  // both autosave debounced writes and Save-Now writes update this in
  // sync, and so the recovery toast can fire on the same edge.
  const [autosaveError, setAutosaveError] = useState<AutosaveError | null>(
    () => getLastAutosaveError(),
  );
  // Multi-tab coordination: when another tab edits THIS slot's blob in
  // localStorage, the `storage` event fires here. We capture the slot
  // id so the banner can render with the right name + reload action.
  // Cleared by the Reload (overwrites in-memory state) or Dismiss
  // (continues with potentially-stale view; last-writer-wins on next
  // autosave). Null = no stale state.
  const [multitabStaleSlotId, setMultitabStaleSlotId] = useState<string | null>(null);
  // Share-link recipient pending: populated at boot when the URL hash
  // carries a valid `#share=...` payload. The SharedImportModal renders
  // a preview + "Import as new slot" action. Cleared on import or dismiss.
  const [sharedPending, setSharedPending] = useState<SharedRanking | null>(null);
  // "Restore from backup…" pending: populated once the user picks an
  // archive file AND we've parsed the JSON envelope without error.
  // Holds the archive bytes (so the import handlers can re-feed them
  // to `importAllSlots`) plus a precomputed slot count + per-slot
  // collision split, used by the modal to label the merge / replace
  // buttons. Cleared on Cancel or after either import completes.
  const [restorePending, setRestorePending] = useState<{
    json: string;
    source: string;
    total: number;
    newCount: number;
  } | null>(null);

  // -------- boot: migrate + read manifest only --------
  // We intentionally don't auto-load the active slot's blob here. Refresh
  // always returns the user to START; the "Resume last used" CTA or the
  // gear-menu slot list re-enters a sort explicitly.
  useEffect(() => {
    const { manifest: m } = bootRead();
    setManifest(m);
    // If the manifest was corrupt and we just rebuilt it, surface the
    // recovery so the user knows their slots are still there (possibly
    // renamed by the autoname heuristic since original metadata is lost).
    const repairCount = consumeManifestRepairNotice();
    if (repairCount !== null) {
      if (repairCount > 0) {
        flashSkipped(
          `Slot list was corrupted; rebuilt ${repairCount} slot${repairCount === 1 ? '' : 's'} from backup data. Names may differ — rename as needed.`,
        );
      } else {
        flashSkipped(
          'Slot list was corrupted but no recoverable blobs were found. Starting fresh.',
        );
      }
    }
    // flashSkipped is a stable useCallback (deps=[]) so referencing it
    // here from a once-only boot effect is safe; exhaustive-deps would
    // force this effect to re-run on flashSkipped identity changes
    // (which it never does) so we suppress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // -------- autosave error surfacing --------
  // Storage emits a notification on terminal failure (banner) and on
  // successful auto-recovery (toast). We also mirror any undoRing trim
  // back into in-memory state — otherwise the next scheduleAutosave
  // immediately re-grows the on-disk ring and we hit quota again.
  useEffect(() => {
    const unsub = subscribeAutosaveError((err, recovery) => {
      setAutosaveError(err);
      if (recovery?.kind === 'evicted-slot' && recovery.evicted) {
        flashSkipped(
          `Storage was full — deleted "${recovery.evicted.name}" to make room. Pin slots you want to keep.`,
        );
        // The evicted slot just disappeared from disk; refresh the
        // manifest so the LIST tab stops showing it.
        setManifest(readManifest());
      } else if (recovery?.kind === 'trimmed-undo' && recovery.newUndoRingLen !== undefined) {
        flashSkipped(
          `Storage was full — trimmed undo history to the last ${recovery.newUndoRingLen} actions.`,
        );
        const keep = recovery.newUndoRingLen;
        setUndoRing((ring) => (ring.length > keep ? ring.slice(-keep) : ring));
      }
    });
    return unsub;
  }, [flashSkipped]);

  // -------- multi-tab coordination --------
  // The browser's `storage` event fires in OTHER tabs (not the writing
  // one) when localStorage changes. Two key shapes we care about:
  //  1. Manifest key changed → another tab created/deleted/renamed/pinned
  //     a slot. Re-read the manifest so the LIST tab reflects reality.
  //  2. Active slot's blob key changed → another tab is sorting in the
  //     same slot as us. Surface a "stale" banner so the user can reload
  //     (overwriting their in-memory changes with the other tab's disk
  //     state) or dismiss (continue + last-writer-wins on next autosave).
  // No banner shown when this tab has no in-memory state for the slot
  // (the next visit will load the fresh blob anyway).
  useEffect(() => {
    function onStorage(e: StorageEvent): void {
      if (!e.key) return;
      if (e.key === MANIFEST_KEY) {
        setManifest(readManifest());
        return;
      }
      if (!e.key.startsWith('sorter:slot:')) return;
      // Re-read manifest so we use its current activeId, not a stale
      // closure value. Cheap (one localStorage get + JSON.parse).
      const m = readManifest();
      if (m.activeId && e.key === slotBlobKey(m.activeId)) {
        setMultitabStaleSlotId((prev) => prev ?? m.activeId);
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Reload action for the multi-tab stale banner: discard the in-flight
  // autosave (NEVER flush — that would clobber the other tab's writes),
  // re-read the slot blob from disk, and replace in-memory state. If
  // the blob disappeared between the event and the click (e.g. the
  // other tab deleted the slot), fall back to clearing state.
  const onMultitabReload = useCallback(() => {
    if (!multitabStaleSlotId) return;
    discardPendingAutosave();
    const session = deserialize(readSlotBlob(multitabStaleSlotId));
    if (session) {
      setState(session.state);
      setUndoRing(session.undoRing);
    } else {
      // Other tab deleted the slot between the event and the click.
      // Drop in-memory state and return to START so the user picks
      // their next move explicitly.
      setState(null);
      setUndoRing([]);
      setActiveTab('start');
    }
    setManifest(readManifest());
    setMultitabStaleSlotId(null);
  }, [multitabStaleSlotId]);

  // -------- share-link recipient: detect at boot --------
  // Decode `#share=<payload>` once on mount. Successful decode pops the
  // SharedImportModal; failures clear the hash silently (a friendly
  // "this share link is broken" banner is a future-nice but not
  // essential — most failures come from hand-edited URLs, which the
  // sender will notice and re-share).
  // (The boot effect itself runs in source order — i.e. below the
  // adoptNewSession definition further down — but is registered here
  // alongside other a-bit-special boot effects to keep them grouped.)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const param = readShareParamFromHash(window.location.hash);
    if (!param) return;
    const decoded = decodeShareLink(param);
    if (decoded) {
      setSharedPending(decoded);
    } else {
      // Bad payload — clear the hash so a refresh doesn't keep
      // re-prompting on the same broken URL.
      clearShareHash();
      flashSkipped('The share link you opened was broken or unreadable.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear `#share=...` from the URL without scrolling or triggering a
  // popstate. history.replaceState is the only API that lets us mutate
  // the fragment without an event the rest of the app might react to.
  function clearShareHash(): void {
    if (typeof window === 'undefined') return;
    const { origin, pathname, search } = window.location;
    window.history.replaceState(null, '', `${origin}${pathname}${search}`);
  }

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

  // In-place metadata edit (label / url / imageUrl + optional id
  // rename). `engineUpdateItem` returns the same state reference when
  // nothing actually changes — that's our signal to NOT push an undo
  // frame and NOT trigger a state re-render. Driving use-case: fixing
  // labels whose commas got eaten by the CSV parser at import time.
  //
  // When `patch.id` is set (the "advanced" panel in EditItemModal),
  // we apply BOTH operations atomically inside a single setState +
  // single undo push:
  //   1. engineUpdateItem applies the metadata patch (label/url/imageUrl)
  //   2. engineUpdateItemId rekeys the items dict and rewrites every
  //      ItemId reference in the progress slice.
  // The undo ring is ALSO rewritten so a subsequent undo doesn't
  // restore a snapshot keyed under the old id while the items dict
  // is keyed under the new one — see engine.rewriteIdInProgress.
  //
  // engineUpdateItemId can reject (returns null) for empty / unknown
  // / colliding ids. The modal validates synchronously so a reject
  // here implies a race — we silently fall back to applying just the
  // metadata patch in that case.
  const doEditItem = useCallback(
    (
      id: ItemId,
      patch: {
        label?: string;
        url?: string;
        imageUrl?: string;
        id?: ItemId;
      },
    ) => {
      const { id: rawNewId, ...metaPatch } = patch;
      // Normalize the rename intent once so the setState callback
      // doesn't have to re-narrow.
      const newId: ItemId | null =
        rawNewId !== undefined && rawNewId.trim() !== id
          ? rawNewId.trim()
          : null;
      setState((cur) => {
        if (!cur) return cur;
        const afterMeta = engineUpdateItem(cur, id, metaPatch);
        if (newId === null) {
          if (afterMeta === cur) return cur;
          pushUndo(cur);
          return afterMeta;
        }
        const renamed = engineUpdateItemId(afterMeta, id, newId);
        if (renamed === null) {
          // Rename rejected (race with collision created elsewhere,
          // or some other engine-level guard) — keep the meta patch.
          if (afterMeta === cur) return cur;
          pushUndo(cur);
          return afterMeta;
        }
        // Push undo for the pre-edit state, then rewrite every prior
        // snapshot (including the one we just pushed) so a later undo
        // restores progress arrays referencing the NEW id. The items
        // dict is shared across snapshots so it's already keyed by
        // the new id — a snapshot still pointing at the old id would
        // render blanks. See engine.rewriteIdInProgress.
        pushUndo(cur);
        setUndoRing((ring) =>
          ring.map((snap) => engineRewriteIdInProgress(snap, id, newId)),
        );
        return renamed;
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

  // doAppendPreRanked is merge-only by definition; on a merge-done state
  // we route through the engine-transition confirm modal instead of
  // appending more sublist work that would re-merge against the frozen
  // ranking. Same routing pattern is mirrored in doAddItem / doAddItemsList
  // so RESULTS' "Add items" behaves identically no matter which add path
  // the user takes.
  const doAppendPreRanked = useCallback(
    (items: Item[]) => {
      if (!state || items.length === 0) return;
      if (state.engine !== 'merge') return;
      if (state.done) {
        setPendingTransition({ items });
        return;
      }
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
    [state, pushUndo, flashSkipped, engineOptions],
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
  // On merge-engine-done we route to the engine-transition confirm modal
  // instead of appending a singleton sublist that would force the user
  // to re-merge it against the frozen ranking — same pattern as the
  // multi-item paths.
  const doAddItem = useCallback(
    (item: Item) => {
      if (!state) return;
      if (state.engine === 'merge' && state.done) {
        setPendingTransition({ items: [item] });
        return;
      }
      setState((cur) => {
        if (!cur) return cur;
        const next = engineAddItem(cur, item, engineOptions);
        if (next === null) return cur;
        pushUndo(cur);
        return next;
      });
    },
    [state, pushUndo, engineOptions],
  );

  // ---- multi-item add (LIST tab "Multiple" tab unchecked): engine-aware ----
  // Insertion → appends each to pending FIFO. Merge (not done) → appends
  // N singleton sublists. Merge (done) → engine-transition confirm modal.
  // For "merge a pre-ranked sublist" semantics, see `doAppendPreRanked`.
  const doAddItemsList = useCallback(
    (items: Item[]) => {
      if (!state || items.length === 0) return;
      if (state.engine === 'merge' && state.done) {
        setPendingTransition({ items });
        return;
      }
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
    [state, pushUndo, flashSkipped, engineOptions],
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
      const result = createSlot(blob, name);
      if (result === null) {
        // Blob write failed (typically quota exhaustion AFTER eviction
        // already ran). The manifest may still have lost some slots to
        // the failed eviction — refresh from disk so the LIST tab
        // reflects reality. Flash a loud error so the user knows their
        // session was NOT persisted (still in-memory only for now).
        setManifest(readManifest());
        flashSkipped(
          'Could not save the new slot — browser storage is full. Pin / delete a slot to free room and try again.',
        );
        return;
      }
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
      if (result.evicted.length > 0) {
        const names = result.evicted.map((e) => `"${e.name}"`).join(', ');
        flashSkipped(
          `Made room: deleted oldest slot${result.evicted.length === 1 ? '' : 's'} ${names}.`,
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

  // Import a shared payload as a new slot. Branches on payload.kind:
  //
  //  - 'ranking'  → seed an insertion-engine DONE state via `seedAsSorted`.
  //                 Engine choice barely matters since there are no
  //                 pending comparisons; the user can hit Start over to
  //                 re-sort with their preferred engine if desired. Land
  //                 on RESULT so the imported ranking is immediately
  //                 visible.
  //  - 'template' → seed a fresh sort via `initSort` (respects the
  //                 user's current engine + auto-insert preferences).
  //                 Land on RANK because there is no result yet — the
  //                 recipient is supposed to do their own sorting.
  //
  // Both routes funnel through adoptNewSession so cap-eviction /
  // quota-recovery / first-write failure are handled uniformly with
  // all other "mint a new slot" paths.
  const onSharedImport = useCallback(
    (payload: SharedRanking) => {
      if (payload.kind === 'template') {
        const next = initSort(payload.items, engineOptions);
        const session: SavedSession = { state: next, undoRing: [] };
        adoptNewSession(session, payload.name, 'rank');
      } else {
        const next = seedAsSorted(payload.items);
        const session: SavedSession = { state: next, undoRing: [] };
        adoptNewSession(session, payload.name, 'result');
      }
      clearShareHash();
      setSharedPending(null);
    },
    [adoptNewSession, engineOptions],
  );

  const onSharedDismiss = useCallback(() => {
    clearShareHash();
    setSharedPending(null);
  }, []);

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

  const onTogglePinSlot = useCallback((id: string, pinned: boolean) => {
    const m = pinSlot(id, pinned);
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

  // -------- bulk backup (every slot in one archive) --------
  // Just delegates to the storage helper; no in-memory state changes
  // because the on-disk slots aren't touched. Disabled in the menu
  // when manifest is empty so this should never be a no-op.
  const onBackupAll = useCallback(() => {
    downloadAllSlots();
  }, []);

  // Parse the picked archive file, do a count-only pre-flight so the
  // confirm modal can label its buttons accurately, and stage the
  // import. Validation failures get the friendly alert path — same
  // UX as a corrupt single-slot save.
  const onRestoreFromBackup = useCallback((file: File) => {
    file
      .text()
      .then((json) => {
        // Lenient pre-parse: just inspect the manifest's slot ids so we
        // can compute "M new vs K already present". `importAllSlots`
        // does the real per-blob validation later; the modal preview
        // is intentionally optimistic.
        let parsedTotal = 0;
        let parsedNew = 0;
        try {
          const env = JSON.parse(json) as {
            archiveVersion?: unknown;
            manifest?: { slots?: Array<{ id?: unknown }> };
          };
          if (env.archiveVersion !== 1) {
            throw new Error(
              `Unsupported archive version: ${String(env.archiveVersion)}`,
            );
          }
          const slots = Array.isArray(env.manifest?.slots)
            ? env.manifest!.slots
            : [];
          parsedTotal = slots.length;
          const existingIds = new Set(
            readManifest().slots.map((s) => s.id),
          );
          parsedNew = slots.filter(
            (s) => typeof s.id === 'string' && !existingIds.has(s.id),
          ).length;
        } catch (err) {
          alert(
            `Could not read backup file: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
        setRestorePending({
          json,
          source: file.name || 'backup.json',
          total: parsedTotal,
          newCount: parsedNew,
        });
      })
      .catch((err: unknown) => {
        alert(
          `Could not read backup file: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }, []);

  // Apply the pending restore in the chosen mode and surface the result.
  // Merge keeps the user's current session intact; replace wipes both
  // disk AND in-memory state and lands them on START so they can pick
  // up where the archive left off (or pick a different slot manually).
  const performRestore = useCallback(
    (mode: 'merge' | 'replace') => {
      if (!restorePending) return;
      const result = importAllSlots(restorePending.json, mode);
      setRestorePending(null);
      if (result.error) {
        alert(`Could not import backup: ${result.error}`);
        return;
      }
      // For replace: flush any in-flight autosave was already cancelled
      // inside storage; here we just drop in-memory state so the UI
      // doesn't render a session whose blob may have just been wiped.
      if (mode === 'replace') {
        setState(null);
        setUndoRing([]);
        setActiveTab('start');
      }
      setManifest(readManifest());
      const parts: string[] = [
        `Imported ${result.imported} slot${result.imported === 1 ? '' : 's'}`,
      ];
      if (result.renamedIds.length > 0) {
        parts.push(
          `${result.renamedIds.length} renamed to avoid id collisions`,
        );
      }
      if (result.skipped > 0) {
        parts.push(`${result.skipped} skipped`);
      }
      flashSkipped(`${parts.join(' · ')}.`);
    },
    [restorePending, flashSkipped],
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
        slotName={
          manifest.slots.find((s) => s.id === manifest.activeId)?.name
        }
        onUnhide={doUnhide}
        onStartOver={requestStartOver}
        onAddOne={doAddItem}
        onAddMany={doAddItemsList}
        onAddPreRanked={doAppendPreRanked}
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
      {autosaveError && (
        // Persistent banner: stays up until the next successful write
        // clears the error (storage notifies the subscribed handler).
        // The Dismiss button lets the user hide it without unblocking
        // storage — useful when they've decided to keep working in
        // memory-only mode until they get around to housekeeping.
        <div className="app-banner danger">
          <span>
            Autosave failed — browser storage is full. Your work is safe in
            this tab, but won't survive a refresh until you make room. Pin
            slots you want to keep, then delete an old one (gear menu),
            or use Download to back up the current sort.
          </span>
          <button
            type="button"
            className="banner-dismiss"
            onClick={() => setAutosaveError(null)}
            aria-label="Dismiss storage-full warning"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      {multitabStaleSlotId && state && (
        // Another tab edited the same slot's saved data. Reload pulls the
        // other tab's writes in (discarding our pending autosave so we
        // don't clobber them); Dismiss keeps the current in-memory view
        // — next autosave will overwrite the other tab. Only shown when
        // we have in-memory state for the slot; without state, the next
        // visit naturally reads the fresh blob.
        <div className="app-banner warn">
          <span>
            Another browser tab updated this slot. Reload to view the latest
            saved progress (your unsaved changes here will be discarded),
            or keep working and overwrite the other tab.
          </span>
          <button
            type="button"
            className="banner-action"
            onClick={onMultitabReload}
            aria-label="Reload slot from other tab"
          >
            Reload
          </button>
          <button
            type="button"
            className="banner-dismiss"
            onClick={() => setMultitabStaleSlotId(null)}
            aria-label="Dismiss multi-tab warning"
            title="Dismiss"
          >
            ×
          </button>
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
        onBackupAll={onBackupAll}
        onRestoreFromBackup={onRestoreFromBackup}
        manifest={manifest}
        loadedSlotId={loadedSlotId}
        onSwitchSlot={onSwitchSlot}
        onDeleteSlot={onDeleteSlot}
        onRenameSlot={onRenameSlot}
        onDownloadSlot={onDownloadSlot}
        onTogglePinSlot={onTogglePinSlot}
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
      {sharedPending && (
        <SharedImportModal
          payload={sharedPending}
          onImport={onSharedImport}
          onDismiss={onSharedDismiss}
        />
      )}
      {restorePending && (
        <BackupRestoreConfirmModal
          total={restorePending.total}
          newCount={restorePending.newCount}
          source={restorePending.source}
          hasExisting={manifest.slots.length > 0}
          mergeWouldExceedCap={
            manifest.slots.length + restorePending.total > SLOT_CAP
          }
          slotCap={SLOT_CAP}
          onCancel={() => setRestorePending(null)}
          onMerge={() => performRestore('merge')}
          onReplace={() => performRestore('replace')}
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
