import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Item,
  ItemId,
  SlotsManifest,
  SortProgress,
  SortState,
} from './lib/types';
import {
  addItem,
  appendPreRankedSublist,
  breakApartSublist,
  comparisonsRemaining,
  hideItem,
  initSort,
  pickLeft,
  pickRight,
  reorderInSublist,
  restoreProgress,
  seedFromSublists,
  snapshotProgress,
  unhideItem,
} from './lib/queueMergeSort';
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
import { Header, type TabId } from './components/Header';
import { StartScreen } from './components/StartScreen';
import { CompareScreen, type LastInteraction } from './components/CompareScreen';
import { ListScreen } from './components/ListScreen';
import { ResultScreen } from './components/ResultScreen';
import { SlotDeleteConfirmModal } from './components/SlotDeleteConfirmModal';
import { useKeyboard } from './hooks/useKeyboard';

const UNDO_CAP = 50;

interface SavedSession {
  state: SortState;
  undoRing: SortProgress[];
}

function deserialize(raw: AutosaveBlob | null): SavedSession | null {
  if (!raw) return null;
  const state: SortState = {
    ...raw.progress,
    items: raw.items,
  };
  return { state, undoRing: raw.undoRing ?? [] };
}

function buildBlob(state: SortState, undoRing: SortProgress[]): AutosaveBlob {
  return {
    items: state.items,
    progress: snapshotProgress(state),
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
  useEffect(() => {
    if (!state || state.done) {
      document.title = state?.done ? 'Done — Sorter' : 'Sorter';
      return;
    }
    document.title = `${comparisonsRemaining(state)} left — Sorter`;
  }, [state]);

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

  // -------- transitions --------
  const pushUndo = useCallback((prior: SortState) => {
    setUndoRing((ring) => {
      const next = ring.concat(snapshotProgress(prior));
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
        return side === 'left' ? pickLeft(cur) : pickRight(cur);
      });
      // Stamp the interaction *after* the state change so the CompareScreen
      // effect (which fires on pair change) reads the freshest side.
      setLastInteraction({ kind: 'pick', side });
    },
    [pushUndo],
  );

  const doHide = useCallback(
    (id: ItemId) => {
      setState((cur) => {
        if (!cur) return cur;
        pushUndo(cur);
        return hideItem(cur, id);
      });
    },
    [pushUndo],
  );

  const doUnhide = useCallback(
    (id: ItemId) => {
      setState((cur) => {
        if (!cur) return cur;
        pushUndo(cur);
        return unhideItem(cur, id);
      });
    },
    [pushUndo],
  );

  const doReorder = useCallback(
    (queueIndex: number, itemIndex: number, dir: -1 | 1) => {
      setState((cur) => {
        if (!cur) return cur;
        pushUndo(cur);
        return reorderInSublist(cur, queueIndex, itemIndex, dir);
      });
    },
    [pushUndo],
  );

  const doBreak = useCallback(
    (queueIndex: number) => {
      setState((cur) => {
        if (!cur) return cur;
        pushUndo(cur);
        return breakApartSublist(cur, queueIndex);
      });
    },
    [pushUndo],
  );

  const doAddItem = useCallback(
    (item: Item) => {
      setState((cur) => {
        if (!cur) return cur;
        const next = addItem(cur, item);
        if (next === null) return cur;
        pushUndo(cur);
        return next;
      });
    },
    [pushUndo],
  );

  const doAppendPreRanked = useCallback(
    (items: Item[]) => {
      setState((cur) => {
        if (!cur) return cur;
        pushUndo(cur);
        const { state: next, skipped } = appendPreRankedSublist(cur, items);
        if (skipped.length > 0) {
          flashSkipped(
            `Skipped ${skipped.length} item${skipped.length === 1 ? '' : 's'} already in the sort.`,
          );
        }
        return next;
      });
    },
    [pushUndo, flashSkipped],
  );

  const doUndo = useCallback(() => {
    setUndoRing((ring) => {
      if (ring.length === 0) return ring;
      const last = ring[ring.length - 1];
      setState((cur) => (cur ? restoreProgress(cur, last) : cur));
      return ring.slice(0, -1);
    });
    setLastInteraction({ kind: 'undo' });
  }, []);

  // -------- slot mint helpers --------
  /**
   * Mint a new slot for the given session and activate it. Used by all
   * three "start a sort" paths (scratch, pre-ranked, file load) and also
   * by importing a save file.
   */
  const adoptNewSession = useCallback(
    (session: SavedSession, name: string) => {
      const blob = buildBlob(session.state, session.undoRing);
      createSlot(blob, name);
      setManifest(readManifest());
      setState(session.state);
      setUndoRing(session.undoRing);
      setActiveTab(session.state.done ? 'result' : 'rank');
    },
    [],
  );

  // -------- start --------
  const onStartScratch = useCallback(
    (items: Item[]) => {
      const next = initSort(items);
      const session: SavedSession = { state: next, undoRing: [] };
      adoptNewSession(session, autoNameFromBlob(buildBlob(next, [])));
    },
    [adoptNewSession],
  );

  const onStartPreranked = useCallback(
    (args: { sublists: Item[][]; extras: Item[] }) => {
      const next = seedFromSublists(args);
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
        onAppendPreRanked={doAppendPreRanked}
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
      />
    );
  } else {
    body = (
      <ResultScreen
        state={state}
        onUnhide={doUnhide}
        onReset={onResetRequest}
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
        hasState={hasState}
        theme={theme}
        onToggleTheme={toggleTheme}
        showEstimatedRemaining={showEstimatedRemaining}
        onToggleShowEstimatedRemaining={toggleShowEstimatedRemaining}
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
    </div>
  );
}
