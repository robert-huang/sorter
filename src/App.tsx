import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  ConfirmationState,
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
  getCompareProgress,
  dismissHidden as engineDismissHidden,
  normalizeLoadedState,
  type EngineOptions,
  forgetHiddenItem as engineForgetHiddenItem,
  getRanking as engineGetRanking,
  hideItem as engineHideItem,
  pickLeft as enginePickLeft,
  pickRight as enginePickRight,
  selectUndoSnapshot,
  undoSnapshotsEqual,
  reorderInSorted as engineReorderInSorted,
  restoreProgress as engineRestoreProgress,
  restoreHiddenItem as engineRestoreHiddenItem,
  reinsertHiddenItem as engineReinsertHiddenItem,
  returnToPending as engineReturnToPending,
  rewriteIdInProgress as engineRewriteIdInProgress,
  snapshotProgress as engineSnapshotProgress,
  unhideItem as engineUnhideItem,
  updateItem as engineUpdateItem,
  updateItemId as engineUpdateItemId,
} from './lib/engine';
import {
  appendPreRankedSublist,
  breakApartSublist,
  cancelManualInsert,
  forgetItem,
  initSort,
  reorderInSublist,
  reorderInCurrentMerge,
  reorderInsertTarget,
  seedAsDoneMerge,
  seedFromSublists,
} from './lib/queueMergeSort';
import { seedInsertionFromSublists } from './lib/insertionSort';
import { seedConfirmation } from './lib/confirmationSort';
import {
  applyCompletedSortEdit,
  applySlotImportBatches,
  cloneSortState,
  derivedSlotName,
  resetBranchedSlotComparisonProgress,
  type CompletedSortEditAction,
  type SlotResultsImportBatch,
} from './lib/completedSortEditH';
import { listHeaderItemCount } from './lib/sortPopulation';
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
  findSlotByCloudId,
  readManifest,
  readSettings,
  readSlotBlob,
  isHarmlessCrossTabSlotBlobWrite,
  persistCanonicalBlobOnLoad,
  pinSlot,
  renameSlot,
  replaceSlotBlob,
  setCloudOptIn,
  setCloudPulled,
  setCloudPushed,
  updateSlotMeta,
  deriveAdoptedCloudSlotTimestamps,
  clearCloudBinding,
  getLastAutosaveError,
  saveNow,
  scheduleAutosave,
  subscribeAfterWrite,
  subscribeAutosaveError,
  setActiveSlot,
  updateSettings,
  type ThemeName,
} from './lib/storage';
import type { SlotMeta } from './lib/types';
import { AppBannerStack } from './components/AppBannerStack';
import { RemoveGlyph } from './components/RemoveGlyph';
import { Header, type TabId } from './components/Header';
import {
  StartScreen,
  type StartDraftCapabilities,
  type StartScreenHandle,
} from './components/StartScreen';
import { CompareScreen, type LastInteraction } from './components/CompareScreen';
import { ListScreen } from './components/ListScreen';
import { ResultScreen } from './components/ResultScreen';
import { SharedImportModal } from './components/SharedImportModal';
import { type SharedRanking, decodeShareLink, readShareParamFromHash } from './lib/share';
import { BackupRestoreConfirmModal } from './components/BackupRestoreConfirmModal';
import { SlotCapConfirmModal } from './components/SlotCapConfirmModal';
import { SlotDeleteConfirmModal } from './components/SlotDeleteConfirmModal';
import { StartOverConfirmModal } from './components/StartOverConfirmModal';
import { CompletedSortEditConfirmModal } from './components/CompletedSortEditConfirmModal';
import { CloudLibraryModal } from './components/CloudLibraryModal';
import { CloudPushConflictModal } from './components/CloudPushConflictModal';
import { CloudUnlinkConfirmModal } from './components/CloudUnlinkConfirmModal';
import type { CloudMenuStatus } from './components/SettingsMenu';
import {
  type AuthState as CloudAuthState,
  CloudEtagMismatchError,
  type CloudPushOptions,
  type CloudSlotMeta,
  buildSlotFilename,
  getAuthState as cloudGetAuthState,
  handleAuthRedirect as cloudHandleAuthRedirect,
  pickFolder as cloudPickFolder,
  pullSlot as cloudPullSlot,
  pushSlot as cloudPushSlot,
  registerDefaultCloudProvider,
  removeCloudSlot as cloudRemoveCloudSlot,
  signIn as cloudSignIn,
  signOut as cloudSignOut,
  subscribeAuthChange as cloudSubscribeAuthChange,
} from './lib/cloud';
import { GoogleDriveProvider } from './lib/cloud/googleDrive';
import { InFlightTracker } from './lib/inFlightTracker';
import {
  MEMORY_MODE_PUSH_BLOCKED,
  NO_REMOTE,
  REMOTE_DRIFTED,
  REMOTE_SCHEMA_NEWER,
  pullDbFromDrive,
  pushDbToDrive,
} from './lib/db/sync';
import { openSourceDb } from './lib/db/client';
import {
  DB_NON_PERSISTENT_EVENT,
  describeNonPersistentStorageBanner,
  type DbNonPersistentEventDetail,
  type DbNonPersistentReason,
} from './lib/db/opfs';
import { ANILIST_SOURCE_ID } from './lib/importers/anilist/anilistSource';
import { handleAnilistAuthRedirect } from './lib/importers/anilist/anilistAuth';
import { ensureAnilistFiltersRegistered } from './lib/importers/anilist/filters';
import { ensureCharacterStaffFiltersRegistered } from './lib/importers/anilist/characterStaffFilters';
import { configureAnilistRunnerHooks } from './lib/importers/anilist/runners';
import { subscribeAnilistDisplayPreferences } from './lib/importers/anilist/displayPreferences';
import { relabelAnilistItemPreservingFormat } from './lib/importers/anilist/anilistItemLabel';
import { AnilistDetailModal } from './components/AnilistDetailModal';
import { StaffDetailModal } from './components/StaffDetailModal';
import { ItemDetailContext } from './components/itemDetailContext';
import { useAnilistApiWait } from './hooks/useAnilistApiWait';
import { useKeyboard } from './hooks/useKeyboard';
import { useHistoryBackGuard } from './hooks/useHistoryBackGuard';

// Register the default cloud provider exactly once at module load.
// Tests that need to swap it can call `_setCloudProviderForTesting`
// before any cloud call (the proxy lazily instantiates this factory
// only when no test override is set).
registerDefaultCloudProvider(() => new GoogleDriveProvider());

const UNDO_CAP = 50;

interface SavedSession {
  state: SortState;
  undoRing: SortProgress[];
}

function deserialize(raw: AutosaveBlob | null): SavedSession | null {
  if (!raw) return null;
  // storage.upgradeProgress has already normalized progress to a v2
  // shape with engine discriminator. Tag the state by engine.
  const tagged: SortState =
    raw.progress.engine === 'insertion'
      ? ({ ...raw.progress, items: raw.items } as InsertionState)
      : raw.progress.engine === 'confirmation'
        ? ({ ...raw.progress, items: raw.items } as ConfirmationState)
        : ({ ...raw.progress, items: raw.items } as MergeState);
  const state = normalizeLoadedState(tagged);
  return { state, undoRing: raw.undoRing ?? [] };
}

function buildBlob(state: SortState, undoRing: SortProgress[]): AutosaveBlob {
  return {
    items: state.items,
    progress: engineSnapshotProgress(state),
    undoRing,
  };
}

/** Deserialize a slot blob and silently migrate legacy on-disk shapes. */
function loadSlotSession(id: string): SavedSession | null {
  const session = deserialize(readSlotBlob(id));
  if (!session) return null;
  persistCanonicalBlobOnLoad(id, buildBlob(session.state, session.undoRing));
  return session;
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
  const stateRef = useRef<SortState | null>(null);
  stateRef.current = state;
  // Slot whose blob is currently in memory. Tracked explicitly (not via
  // manifest.activeId) because autosave's post-write manifest refresh can
  // race with setActiveSlot and leave React's activeId one beat behind the
  // loaded session — most visible in document.title after Resume.
  const [loadedSlotId, setLoadedSlotId] = useState<string | null>(null);
  const loadedSlotIdRef = useRef<string | null>(null);
  loadedSlotIdRef.current = loadedSlotId;
  const [undoRing, setUndoRing] = useState<SortProgress[]>([]);
  const undoRingRef = useRef<SortProgress[]>([]);
  undoRingRef.current = undoRing;
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
  // is shown. Driven by the per-row trashcan in the gear-popover slot list,
  // which goes through requestDeleteSlot so the modal and the "Don't ask
  // again" preference are shared.
  const [slotPendingDelete, setSlotPendingDelete] = useState<
    { id: string; name: string; cloudId?: string } | null
  >(null);
  // A pending "Start over" confirmation on the RESULT tab. When non-null,
  // StartOverConfirmModal is shown. itemCount feeds the modal copy.
  const [startOverPending, setStartOverPending] = useState<{
    itemCount: number;
    slotName: string;
  } | null>(null);
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
  const { apiWait, apiWaitSecondsLeft } = useAnilistApiWait();
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
  const [historyBackGuard, setHistoryBackGuardState] = useState(
    () => !!readSettings().historyBackGuard,
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
  // Pending edit to a completed sort (add items, pre-ranked append, etc.).
  // Non-null while the modify-vs-new-slot confirm modal is shown.
  const [completedEditPending, setCompletedEditPending] = useState<{
    action: CompletedSortEditAction;
    slotName: string;
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
  // Cloud auth state (tier 0b). Tracked in app state so the gear menu's
  // cloud section re-renders on every transition (sign-in, folder
  // pick, sign-out, token expiry). Initialised from the provider's
  // synchronous state so the very first render is correct without a
  // flash. `cloudAvailable` collapses the whole cloud section when
  // autosave itself is unavailable — there's no slot to back up.
  const cloudAvailable = autosaveOn;
  const [cloudAuth, setCloudAuth] = useState<CloudAuthState>(() =>
    cloudAvailable ? cloudGetAuthState() : { status: 'signed-out' },
  );
  const [cloudLibraryOpen, setCloudLibraryOpen] = useState(false);
  // Pending pre-Push stale-cache confirmation. When non-null, the
  // CloudPushConflictModal is rendered; `onConfirm` re-issues the
  // push without `expectedEtag` (force overwrite).
  // `onConfirm` re-issues the push without `expectedEtag` (force
  // overwrite). `onCancel` runs in addition to clearing the modal —
  // it exists so the push handler can release its in-flight gate
  // when the user backs out, otherwise the slot's Push button would
  // stay stuck on the spinner forever.
  const [cloudConflict, setCloudConflict] = useState<
    { slotName: string; onConfirm: () => void; onCancel: () => void } | null
  >(null);
  // Pending cloud-unlink confirmation. Only triggers when the user
  // clicks the cloud-icon toggle on a slot that has a cloud binding
  // (cloudId set) — opt-in → opt-out is destructive (deletes the
  // Drive file) and is too easy to misclick into without a guard.
  // The opt-IN direction never opens this modal; that path is
  // non-destructive (just sets the local flag).
  const [cloudUnlinkPending, setCloudUnlinkPending] = useState<
    { slotName: string; onConfirm: () => void } | null
  >(null);
  // Per-slot Push / Pull in-flight tracking. Two trackers so a slot
  // could (in principle) be pushing one button while pulling a
  // different one — they don't share UI state. The refs are the
  // source of truth for the re-entrancy guard (synchronous, so
  // double-clicks resolve deterministically); the matching React
  // states are derived snapshots used to drive icon spinners and
  // `disabled` props on the buttons. Always update them in lockstep
  // (tracker mutation → setPushingIds(tracker.snapshot())).
  const pushTrackerRef = useRef(new InFlightTracker());
  const pullTrackerRef = useRef(new InFlightTracker());
  const [pushingIds, setPushingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pullingIds, setPullingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const dbPushTrackerRef = useRef(new InFlightTracker());
  const dbPullTrackerRef = useRef(new InFlightTracker());
  const [dbPushingIds, setDbPushingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [dbPullingIds, setDbPullingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sourceDbErrors, setSourceDbErrors] = useState<Record<string, string>>({});
  const [dbSyncRevision, setDbSyncRevision] = useState(0);
  // Surfaces the "this tab fell back to in-memory SQLite" warning.
  // Fired exactly once by the db/client when the worker reports
  // `storageMode === 'memory'`. The two realistic causes are
  //   (a) another tab of the same origin already holds the OPFS SAH
  //       pool's exclusive lock (the common case — every new tab spins
  //       up its own dedicated SQLite worker), or
  //   (b) OPFS install genuinely failed (private window, quota refused).
  // In either case the user's cached data isn't reachable from this
  // tab's DB until they Pull from Drive — the banner CTA reflects that.
  const [dbNonPersistent, setDbNonPersistent] = useState(false);
  const [dbNonPersistentReason, setDbNonPersistentReason] =
    useState<DbNonPersistentReason>('opfs_unavailable');
  const [dbNonPersistentDismissed, setDbNonPersistentDismissed] = useState(false);
  // Per-item detail modal target (Phase D). Set when the user clicks
  // an AniList thumb anywhere in the tree — the ItemDetailContext
  // provider below routes those clicks here. Keyed by media id +
  // fallback title so a click on a stale list item still shows the
  // user something while the cached row loads.
  const [itemDetailTarget, setItemDetailTarget] = useState<
    { mediaId: number; fallbackTitle: string } | null
  >(null);
  // Staff detail modal target. Set when the user opens a staff item
  // (source.kind === 'anilist-staff') or clicks a VA / production name
  // inside the media detail modal. Mutually exclusive with
  // itemDetailTarget — opening one clears the other so the two panels
  // navigate to each other (forward nav) rather than stacking.
  const [staffDetailTarget, setStaffDetailTarget] = useState<
    { staffId: number; fallbackName: string } | null
  >(null);
  const openItemDetail = useCallback((item: Item) => {
    const src = item.source;
    if (!src) return;
    if (src.kind === 'anilist') {
      setStaffDetailTarget(null);
      setItemDetailTarget({ mediaId: src.externalId, fallbackTitle: item.label });
    } else if (src.kind === 'anilist-staff') {
      setItemDetailTarget(null);
      setStaffDetailTarget({ staffId: src.externalId, fallbackName: item.label });
    }
  }, []);

  // ITP / refresh-token-rejected banner gate. When the auth state
  // transitions to 'expired', we surface a one-shot banner pointing
  // the user back to Sign in. Dismissable; resets when the auth state
  // leaves 'expired' (sign-in completes, or sign-out clears tokens),
  // so a later expiry re-shows the banner. Locked decision: no
  // retry queue — the user re-signs-in and re-triggers actions
  // manually. Personal scale.
  const [cloudExpiredDismissed, setCloudExpiredDismissed] = useState(false);

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

  // -------- keep React manifest in sync with autosave writes --------
  // Each successful autosave bumps the slot's `updatedAt` (and counters)
  // in localStorage but NOT in React state. Without this subscription
  // the slot-row meta in the gear menu would render stale values —
  // most visibly, the cloud-sync indicator would stay on "synced" (✓)
  // forever because `slot.updatedAt > slot.cloudPushedAt` never
  // becomes true from React's point of view.
  //
  // Re-reading the whole manifest is cheap (small JSON parse on a
  // handful of slot metas) and runs at most once per AUTOSAVE_DEBOUNCE_MS
  // — same cadence as the underlying write, well below render budget.
  // We deliberately reuse the `subscribeAfterWrite` seam that was
  // built for the eventual Tier 1 autosave-to-cloud subscriber; a
  // UI-refresh subscriber is a valid second client.
  // -------- keep React manifest in sync with autosave writes --------
  // Each successful autosave bumps the slot's `updatedAt` (and
  // counters) in localStorage but NOT in React state. Without this
  // subscription the slot-row meta in the gear menu would render
  // stale values — most visibly, the cloud-sync indicator would
  // stay on "synced" (✓) forever because `slot.updatedAt >
  // slot.cloudPushedAt` never becomes true from React's point of
  // view. Re-reading the whole manifest is cheap (small JSON parse
  // on a handful of metas) and runs at most once per autosave
  // debounce cycle.
  useEffect(() => {
    if (!autosaveOn) return;
    return subscribeAfterWrite(() => {
      setManifest(readManifest());
    });
  }, [autosaveOn]);

  // -------- document.title --------
  // Title format: "<slot name> (NN%) — Sorter" while sorting,
  //               "<slot name> ✓ — Sorter" when done,
  //               "<slot name> — Sorter" when there's no work yet
  //                                       (total === 0; no meaningful pct),
  //               "Sorter" when no slot is loaded.
  // Slot name comes first so users running multiple sorter tabs in
  // parallel can tell them apart at a glance — the percent is a
  // secondary signal in parens. The pct uses the SAME formula as the
  // CompareScreen progress bar so the tab and bar always agree.
  // `autoInsertEnabled` is in deps because comparisonsRemaining's
  // forecast depends on it; `manifest` so renames re-title immediately.
  // useLayoutEffect so a completing pick flips the tab title to ✓ in the
  // same paint (not one frame late at 99%).
  useLayoutEffect(() => {
    if (!state) {
      document.title = 'Sorter';
      return;
    }
    const titleSlotId = loadedSlotId ?? manifest.activeId;
    const slotName = manifest.slots.find((s) => s.id === titleSlotId)?.name;
    const base = slotName ?? 'Untitled sort';
    if (state.done) {
      document.title = `${base} ✓ — Sorter`;
      return;
    }
    const { total, pct } = getCompareProgress(state, { autoInsertEnabled });
    if (total === 0) {
      document.title = `${base} — Sorter`;
      return;
    }
    document.title = `${base} (${pct}%) — Sorter`;
  }, [
    state,
    state?.done,
    state?.comparisons,
    state?.totalComparisonsEverNeeded,
    loadedSlotId,
    manifest.slots,
    manifest.activeId,
    autoInsertEnabled,
  ]);

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

  const toggleHistoryBackGuard = useCallback(() => {
    setHistoryBackGuardState((cur) => {
      const next = !cur;
      updateSettings({ historyBackGuard: next });
      return next;
    });
  }, []);

  // -------- transitions --------
  const pushUndo = useCallback((prior: SortState) => {
    setUndoRing((ring) => {
      const snap = engineSnapshotProgress(prior);
      const last = ring[ring.length - 1];
      if (last && undoSnapshotsEqual(snap, last)) return ring;
      const next = ring.concat(snap);
      if (next.length > UNDO_CAP) next.shift();
      return next;
    });
  }, []);

  /** Push one undo frame, then apply — never call pushUndo inside setState. */
  const applyWithUndo = useCallback(
    (compute: (cur: SortState) => SortState) => {
      const cur = stateRef.current;
      if (!cur) return;
      const next = compute(cur);
      if (next === cur) return;
      pushUndo(cur);
      setState(next);
    },
    [pushUndo],
  );

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
  //  2. This tab's loaded slot blob changed → another tab is sorting the
  //     same slot we have in memory. Surface a "stale" banner so the user
  //     can reload (overwriting in-memory changes with the other tab's disk
  //     state) or dismiss (continue + last-writer-wins on next autosave).
  //     Suppress when disk already matches in-memory (zombie tab echoing the
  //     same autosave).
  // Compare against loadedSlotId, not manifest.activeId — each tab can be
  // working a different slot while activeId tracks the last global writer.
  useEffect(() => {
    function onStorage(e: StorageEvent): void {
      if (!e.key) return;
      if (e.key === MANIFEST_KEY) {
        setManifest(readManifest());
        return;
      }
      if (!e.key.startsWith('sorter:slot:')) return;
      const slotId = loadedSlotIdRef.current;
      if (!slotId || e.key !== slotBlobKey(slotId)) return;

      const cur = stateRef.current;
      if (
        cur &&
        isHarmlessCrossTabSlotBlobWrite(
          buildBlob(cur, undoRingRef.current),
          e.newValue,
        )
      ) {
        return;
      }

      setMultitabStaleSlotId((prev) => prev ?? slotId);
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Drop a stale banner when we navigate away from that slot.
  useEffect(() => {
    setMultitabStaleSlotId((prev) =>
      prev && prev !== loadedSlotId ? null : prev,
    );
  }, [loadedSlotId]);

  // Reload action for the multi-tab stale banner: discard the in-flight
  // autosave (NEVER flush — that would clobber the other tab's writes),
  // re-read the slot blob from disk, and replace in-memory state. If
  // the blob disappeared between the event and the click (e.g. the
  // other tab deleted the slot), fall back to clearing state.
  const onMultitabReload = useCallback(() => {
    if (!multitabStaleSlotId) return;
    discardPendingAutosave();
    const session = loadSlotSession(multitabStaleSlotId);
    if (session) {
      setLoadedSlotId(multitabStaleSlotId);
      setState(session.state);
      setUndoRing(session.undoRing);
    } else {
      // Other tab deleted the slot between the event and the click.
      // Drop in-memory state and return to START so the user picks
      // their next move explicitly.
      setLoadedSlotId(null);
      setState(null);
      setUndoRing([]);
      setActiveTab('start');
    }
    setManifest(readManifest());
    setMultitabStaleSlotId(null);
  }, [multitabStaleSlotId]);

  // -------- boot: cloud auth redirect + share-link recipient --------
  // Order matters: cloud auth redirect runs FIRST because it restores
  // any pre-auth hash that signIn() stashed before bouncing through
  // Google (locked-decision: a mid-import `#share=...` survives the
  // OAuth round-trip). Once that hash is back in place, the share
  // link decode reads the same path it would have seen if no OAuth
  // round-trip had happened.
  //
  // Both are once-only — the deps array is intentionally `[]` and the
  // eslint suppression below is for `flashSkipped`, which is a stable
  // useCallback.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let canceled = false;
    async function run(): Promise<void> {
      // AniList OAuth redirect (implicit grant hash). Runs before cloud
      // auth so a mid-flow hash survives any subsequent OAuth round-trip.
      try {
        await handleAnilistAuthRedirect();
      } catch (err) {
        console.warn('anilist auth redirect failed', err);
      }
      if (canceled) return;
      // Cloud auth redirect handler. No-op when the URL has no auth
      // params (the common case). Errors surface to the console only;
      // the user sees the result via getAuthState on the next render.
      if (cloudAvailable) {
        try {
          await cloudHandleAuthRedirect();
        } catch (err) {
          console.warn('cloud auth redirect failed', err);
        }
      }
      if (canceled) return;
      // Share-link decode. Reads from the CURRENT hash (which the auth
      // redirect handler has by now restored if it was stashed).
      const param = readShareParamFromHash(window.location.hash);
      if (!param) return;
      const decoded = decodeShareLink(param);
      if (decoded) {
        setSharedPending(decoded);
      } else {
        clearShareHash();
        flashSkipped('The share link you opened was broken or unreadable.');
      }
    }
    void run();
    return () => {
      canceled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to cloud auth state changes so the gear menu re-renders
  // on every transition (sign-in completes, folder picked, sign-out,
  // token expired). The subscription is set up regardless of
  // `cloudAvailable` so a future toggle-cloud-on path wouldn't need a
  // remount, but the proxy is a no-op when no provider is registered
  // (which is the only reason we'd be in the unavailable branch).
  useEffect(() => {
    if (!cloudAvailable) return;
    const unsub = cloudSubscribeAuthChange((state) => setCloudAuth(state));
    // Also re-read once on mount in case the auth redirect handler
    // fired its listener before this effect attached.
    setCloudAuth(cloudGetAuthState());
    return () => {
      unsub();
    };
  }, [cloudAvailable]);

  // Re-arm the expired-banner dismissal flag whenever the auth state
  // leaves 'expired'. That way a later expiry surfaces the banner
  // again (a single sign-in -> work -> expire -> dismiss session
  // should be a clean cycle, not "dismissed forever after first
  // expiry").
  useEffect(() => {
    if (cloudAuth.status !== 'expired') setCloudExpiredDismissed(false);
  }, [cloudAuth.status]);

  // Clear `#share=...` from the URL without scrolling or triggering a
  // popstate. history.replaceState is the only API that lets us mutate
  // the fragment without an event the rest of the app might react to.
  function clearShareHash(): void {
    if (typeof window === 'undefined') return;
    const { origin, pathname, search } = window.location;
    window.history.replaceState(null, '', `${origin}${pathname}${search}`);
  }

  // Batch rapid same-side picks into one microtask chain, but apply them one
  // engine step per commit so CompareScreen can play deck → boundary pop like
  // separate clicks. When the side changes (peek preview → LEFT then RIGHT),
  // flush pending first so each direction gets its own animation.
  const pendingPicksRef = useRef<Array<'left' | 'right'>>([]);
  const pickFlushQueuedRef = useRef(false);

  const applyPendingPick = useCallback(
    (side: 'left' | 'right') => {
      setState((cur) => {
        if (!cur) return cur;
        setUndoRing((ring) => {
          const snap = engineSnapshotProgress(cur);
          const last = ring[ring.length - 1];
          if (last && undoSnapshotsEqual(snap, last)) return ring;
          let merged = ring.concat(snap);
          while (merged.length > UNDO_CAP) merged.shift();
          return merged;
        });
        return side === 'left'
          ? enginePickLeft(cur, engineOptions)
          : enginePickRight(cur, engineOptions);
      });
      setLastInteraction({ kind: 'pick', side });
    },
    [engineOptions],
  );

  const flushPendingPicks = useCallback(() => {
    pickFlushQueuedRef.current = false;
    const picks = pendingPicksRef.current.splice(0);
    if (picks.length === 0) return;
    const [head, ...tail] = picks;
    applyPendingPick(head!);
    if (tail.length > 0) {
      pendingPicksRef.current.push(...tail);
      pickFlushQueuedRef.current = true;
      queueMicrotask(flushPendingPicks);
    }
  }, [applyPendingPick]);

  const doPick = useCallback(
    (side: 'left' | 'right') => {
      const pending = pendingPicksRef.current;
      if (pending.length > 0 && pending[pending.length - 1] !== side) {
        pickFlushQueuedRef.current = false;
        flushPendingPicks();
      }
      pending.push(side);
      if (pickFlushQueuedRef.current) return;
      pickFlushQueuedRef.current = true;
      queueMicrotask(flushPendingPicks);
    },
    [flushPendingPicks],
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
      applyWithUndo((cur) => engineUnhideItem(cur, id));
    },
    [applyWithUndo],
  );

  const doDismissHidden = useCallback(
    (id: ItemId) => {
      applyWithUndo((cur) => engineDismissHidden(cur, id));
    },
    [applyWithUndo],
  );

  const doRestoreHidden = useCallback(
    (id: ItemId) => {
      applyWithUndo((cur) => engineRestoreHiddenItem(cur, id, engineOptions));
    },
    [applyWithUndo, engineOptions],
  );

  const doReinsertHidden = useCallback(
    (id: ItemId) => {
      applyWithUndo((cur) => engineReinsertHiddenItem(cur, id, engineOptions));
    },
    [applyWithUndo, engineOptions],
  );

  const doForgetHidden = useCallback(
    (id: ItemId) => {
      applyWithUndo((cur) => engineForgetHiddenItem(cur, id, engineOptions));
    },
    [applyWithUndo, engineOptions],
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

  const doReorderInCurrentMerge = useCallback(
    (slice: 'merged' | 'left' | 'right', itemIndex: number, dir: -1 | 1) => {
      setState((cur) => {
        if (!cur || cur.engine !== 'merge') return cur;
        const next = reorderInCurrentMerge(cur, slice, itemIndex, dir);
        if (next === cur) return cur;
        pushUndo(cur);
        return next;
      });
    },
    [pushUndo],
  );

  const doReorderInsertTarget = useCallback(
    (indexA: number, indexB: number) => {
      setState((cur) => {
        if (!cur || cur.engine !== 'merge') return cur;
        const next = reorderInsertTarget(cur, indexA, indexB);
        if (next === cur) return cur;
        pushUndo(cur);
        return next;
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

  const reportSkippedItems = useCallback(
    (skipped: ItemId[]) => {
      if (skipped.length > 0) {
        flashSkipped(
          `Skipped ${skipped.length} item${skipped.length === 1 ? '' : 's'} already in the sort.`,
        );
      }
    },
    [flashSkipped],
  );

  const doForget = useCallback(
    (id: ItemId) => {
      setState((cur) => {
        if (!cur || cur.engine !== 'merge') return cur;
        pushUndo(cur);
        return forgetItem(cur, id, engineOptions);
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
        if (!cur || (cur.engine !== 'insertion' && cur.engine !== 'confirmation')) {
          return cur;
        }
        const hadFrame =
          cur.engine === 'insertion'
            ? cur.current !== null
            : cur.phase === 'insert' && cur.insertFrame !== null;
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
        if (!cur) return cur;
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

  const doUndo = useCallback(() => {
    if (!state || undoRing.length === 0) return;

    const selected = selectUndoSnapshot(state, undoRing);
    if (!selected) return;

    const { snapshot, newRing } = selected;
    const restored = engineRestoreProgress(state, snapshot);

    setUndoRing(newRing);
    setState(restored);

    // LIST/RESULT are for inspecting results or hidden items; comparisons
    // live on RANK. Jump back when undoing a pick (comparisons drop) or when
    // undo leaves a completed sort (e.g. last pick, hide-to-finish). LIST
    // edits like reorder leave comparisons unchanged, so stay on LIST.
    const undoingPick = restored.comparisons < state.comparisons;
    const leavingCompleted =
      activeTab === 'result' && state.done && !restored.done;
    if (
      (undoingPick && (activeTab === 'list' || activeTab === 'result')) ||
      leavingCompleted
    ) {
      setActiveTab('rank');
    }
    setLastInteraction({ kind: 'undo' });
  }, [activeTab, state, undoRing]);

  // -------- slot mint helpers --------
  /**
   * Inner mint: persist the new slot, swap the in-memory state to its
   * session, and flash a toast if the storage layer had to evict
   * something. Pre-condition: caller has either confirmed the
   * eviction via the cap modal or verified we're below cap.
   *
   * Optional `cloudBinding`: when present, the freshly-minted slot is
   * also stamped with cloud-sync metadata and opted-in. Used by the
   * cloud library Pull flow (`onCloudPull`) so a pulled slot remembers
   * which Drive file it came from — future Push goes back to the same
   * file instead of creating a duplicate. The stamping happens BEFORE
   * the `setManifest(readManifest())` below so the slot appears in the
   * list already wearing its cloud icon (no UI flicker between
   * "regular new slot" and "cloud-linked slot").
   */
  const performSlotMint = useCallback(
    (
      session: SavedSession,
      name: string,
      initialTab?: TabId,
      cloudBinding?: {
        cloudId: string;
        cloudEtag: string;
        cloudPushedAt: string;
        cloudUpdatedAt: string;
      },
    ) => {
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
      if (cloudBinding) {
        // Order matters: stamp cloud fields, then flip opt-in. Both
        // calls go through the same atomic manifest writer in
        // storage.ts so the on-disk shape stays consistent even if a
        // refresh interrupts us between calls.
        setCloudPushed(result.meta.id, cloudBinding);
        setCloudOptIn(result.meta.id, true);
        // A freshly-pulled cloud copy is not a local edit. `createSlot`
        // stamps `updatedAt = now`, which (a) propels the slot to the top
        // of the list as "just now" and (b) lands a hair *after* the
        // `cloudPushedAt` computed before the mint, tripping the
        // `updatedAt > cloudPushedAt` test and mislabelling it "local
        // changes pending". Re-stamp `updatedAt` with the cloud file's own
        // last-modified time so the slot sorts into its real recency
        // position and reads as "synced" (cloudPushedAt is "now", which is
        // >= the cloud copy's date).
        updateSlotMeta(result.meta.id, { updatedAt: cloudBinding.cloudUpdatedAt });
      }
      setManifest(readManifest());
      setLoadedSlotId(result.meta.id);
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
    (
      session: SavedSession,
      name: string,
      initialTab?: TabId,
      cloudBinding?: {
        cloudId: string;
        cloudEtag: string;
        cloudPushedAt: string;
        cloudUpdatedAt: string;
      },
    ) => {
      const victim = peekEvictionTarget();
      if (victim) {
        setCapPending({
          victim,
          cancel: () => setCapPending(null),
          commit: () => {
            setCapPending(null);
            performSlotMint(session, name, initialTab, cloudBinding);
          },
        });
        return;
      }
      performSlotMint(session, name, initialTab, cloudBinding);
    },
    [performSlotMint],
  );

  const executeCompletedSortEdit = useCallback(
    (
      action: CompletedSortEditAction,
      target: 'current' | 'new',
      sourceSlotName: string,
    ) => {
      if (!state) return;

      const base = target === 'new' ? cloneSortState(state) : state;
      const { state: next, skipped, resumed } = applyCompletedSortEdit(
        base,
        action,
        engineOptions,
      );
      reportSkippedItems(skipped);

      if (next.done && !resumed) {
        return;
      }

      if (target === 'new') {
        const branched = resetBranchedSlotComparisonProgress(next, engineOptions);
        const session: SavedSession = { state: branched, undoRing: [] };
        adoptNewSession(
          session,
          derivedSlotName(sourceSlotName, 'branch'),
          resumed ? 'rank' : undefined,
        );
        return;
      }

      pushUndo(state);
      setState(next);
      if (resumed) {
        setActiveTab('rank');
      }
    },
    [state, pushUndo, engineOptions, reportSkippedItems, adoptNewSession],
  );

  const requestCompletedSortEdit = useCallback(
    (action: CompletedSortEditAction) => {
      if (!state || !state.done) return;
      const slotName =
        manifest.slots.find((s) => s.id === (loadedSlotId ?? manifest.activeId))?.name ??
        'Untitled sort';
      if (readSettings().suppressCompletedSortEditConfirm) {
        executeCompletedSortEdit(action, 'new', slotName);
        return;
      }
      setCompletedEditPending({ action, slotName });
    },
    [state, manifest.slots, manifest.activeId, loadedSlotId, executeCompletedSortEdit],
  );

  // doAppendPreRanked is merge-only. A pre-ranked sublist appends to the
  // merge queue even when the sort is done — appendPreRankedSublist clears
  // `done` and resumes FIFO merges (auto-insert only when the size heuristic
  // fires).
  const doAppendPreRanked = useCallback(
    (items: Item[]) => {
      if (!state || items.length === 0) return;
      if (state.engine !== 'merge') return;
      if (state.done) {
        requestCompletedSortEdit({ kind: 'appendPreRanked', items });
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
        reportSkippedItems(skipped);
        return next;
      });
    },
    [state, pushUndo, reportSkippedItems, engineOptions, requestCompletedSortEdit],
  );

  const doAddItem = useCallback(
    (item: Item) => {
      if (!state) return;
      if (state.done) {
        requestCompletedSortEdit({ kind: 'addOne', item });
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
    [state, pushUndo, engineOptions, requestCompletedSortEdit],
  );

  const doAddItemsList = useCallback(
    (items: Item[]) => {
      if (!state || items.length === 0) return;
      if (state.done) {
        requestCompletedSortEdit({ kind: 'addMany', items });
        return;
      }
      setState((cur) => {
        if (!cur) return cur;
        const { state: next, skipped } = engineAddItems(cur, items, engineOptions);
        reportSkippedItems(skipped);
        if (next === cur) return cur;
        pushUndo(cur);
        return next;
      });
    },
    [state, pushUndo, reportSkippedItems, engineOptions, requestCompletedSortEdit],
  );

  const doAddSlotImports = useCallback(
    (batches: SlotResultsImportBatch[]) => {
      const nonEmpty = batches.filter((b) => b.items.length > 0);
      if (!state || nonEmpty.length === 0) return;
      if (state.done) {
        requestCompletedSortEdit({ kind: 'slotImports', batches: nonEmpty });
        return;
      }
      setState((cur) => {
        if (!cur) return cur;
        const { state: next, skipped } = applySlotImportBatches(
          cur,
          nonEmpty,
          engineOptions,
        );
        reportSkippedItems(skipped);
        if (next === cur) return cur;
        pushUndo(cur);
        return next;
      });
    },
    [state, pushUndo, reportSkippedItems, engineOptions, requestCompletedSortEdit],
  );

  // Import a shared payload as a new slot. Branches on payload.kind:
  //
  //  - 'ranking'  → seed a completed merge-engine DONE state via
  //                 `seedAsDoneMerge`. Land on RESULT so the imported
  //                 ranking is immediately visible.
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
        const next = seedAsDoneMerge(payload.items);
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

  // -------- cloud backup handlers (tier 0b) --------
  // All gear-menu cloud entries route through these. They're small
  // wrappers that surface errors as toasts via `flashSkipped` rather
  // than throwing — the user gets a one-line explanation instead of
  // a console-only failure.

  const onCloudSignIn = useCallback(() => {
    void (async () => {
      try {
        await cloudSignIn();
        // signIn navigates the browser (PKCE redirect), so this point
        // is only reached on the same-page no-op failure path.
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Cloud sign-in failed.';
        flashSkipped(msg);
      }
    })();
    // flashSkipped is a stable useCallback (deps=[]) so referencing it
    // inside this once-stable handler is safe; suppress exhaustive-deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onCloudPickFolder = useCallback(() => {
    void (async () => {
      try {
        await cloudPickFolder();
        // Auth listener fires from inside the provider on successful
        // pick, which updates `cloudAuth` and re-renders the menu.
      } catch (err) {
        // pickFolder rejects on user cancel — that's not worth a toast.
        console.debug('folder pick canceled', err);
      }
    })();
  }, []);

  const onCloudBrowse = useCallback(() => {
    setCloudLibraryOpen(true);
  }, []);

  const onCloudSignOut = useCallback(() => {
    void (async () => {
      await cloudSignOut();
      setCloudLibraryOpen(false);
    })();
  }, []);

  // ---------- per-slot cloud handlers (tier 0b Phase 2) ----------

  /**
   * Toggle the cloud opt-in flag on a slot. Just flips the manifest
   * bit — does NOT immediately push (the user can do that explicitly
   * via the Push button). When toggling OFF, we also call
   * `removeCloudSlot` to delete the cloud copy so the local choice
   * stays honest with what's in Drive. On a failed remove, we keep
   * the local cloud binding so the user can retry.
   */
  const onCloudToggleOptInSlot = useCallback((id: string, optIn: boolean) => {
    const m = readManifest();
    const slot = m.slots.find((s) => s.id === id);
    if (!slot) return;
    if (optIn) {
      // Opt-IN is non-destructive — just flip the local bit. No
      // cloud-side work (the actual upload happens on user-initiated
      // Push) and no confirm needed.
      setCloudOptIn(id, true);
      setManifest(readManifest());
      return;
    }
    // Opt-OUT with NO cloud binding: there's nothing to destroy in
    // Drive, so flip the bit silently. Saves the user a confirm
    // click for what's effectively a no-op.
    if (!slot.cloudId) {
      setCloudOptIn(id, false);
      setManifest(readManifest());
      return;
    }
    // Opt-OUT with a cloud binding present: this WILL delete the
    // Drive file. Gate on a confirm modal so a stray click on the
    // cloud icon can't silently nuke a backup. The async work
    // (cloud delete + local meta clear) only runs after explicit
    // confirmation.
    const performUnlink = async () => {
      setCloudUnlinkPending(null);
      setCloudOptIn(id, false);
      setManifest(readManifest());
      try {
        await cloudRemoveCloudSlot(slot.cloudId!);
        clearCloudBinding(id);
        setManifest(readManifest());
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Cloud delete failed.';
        flashSkipped(`Couldn't delete the cloud copy of ${slot.name}: ${msg}`);
      }
    };
    setCloudUnlinkPending({
      slotName: slot.name,
      onConfirm: () => void performUnlink(),
    });
    // flashSkipped is stable; suppress exhaustive-deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Push a slot's blob to the cloud. Reads the current blob from
   * storage (NOT from in-memory `state` — the active slot may not
   * even be loaded, and disk is the source of truth for autosaved
   * content anyway). On etag-mismatch the App layer surfaces the
   * conflict modal, which on confirm re-invokes the push without
   * `expectedEtag` to force overwrite.
   */
  const onCloudPushSlot = useCallback(
    (id: string) => {
      if (!autosaveOn) return;
      // Re-entrancy guard: a rapid double-click on the Push button
      // used to fire two concurrent uploads racing each other's etag
      // check (one would win, the loser would pop a spurious
      // conflict modal). The tracker.tryAcquire below makes the
      // second click a no-op until the first call settles. The
      // matching `pushingIds` state drives the spinner glyph + the
      // `disabled` attribute on the button so the user sees that
      // their click registered but is in progress.
      if (!pushTrackerRef.current.tryAcquire(id)) return;
      setPushingIds(pushTrackerRef.current.snapshot());
      // Flush any pending autosave to disk first so we're pushing
      // the freshest local bytes.
      flushAutosave();
      const m = readManifest();
      const slot = m.slots.find((s) => s.id === id);
      if (!slot) {
        pushTrackerRef.current.release(id);
        setPushingIds(pushTrackerRef.current.snapshot());
        return;
      }
      const blob = readSlotBlob(id);
      if (!blob) {
        flashSkipped(`Couldn't read ${slot.name} for cloud push.`);
        pushTrackerRef.current.release(id);
        setPushingIds(pushTrackerRef.current.snapshot());
        return;
      }
      const opts: CloudPushOptions = {
        desiredFilename: buildSlotFilename(slot.name, slot.id),
        sorterSlotId: slot.id,
        displayName: slot.name,
        expectedEtag: slot.cloudEtag,
      };
      function releasePushGate(): void {
        pushTrackerRef.current.release(id);
        setPushingIds(pushTrackerRef.current.snapshot());
      }
      // attemptPush returns true iff the conflict-modal path took
      // ownership of the in-flight gate (the gate is released only
      // when the user picks Cancel or Push-anyway on the modal).
      // Returning a bool — rather than reading `cloudConflict` from
      // the closure — avoids the classic stale-state pitfall where
      // a setCloudConflict call earlier in the same tick isn't yet
      // visible to a later read of `cloudConflict`.
      async function attemptPush(withExpectedEtag: boolean): Promise<boolean> {
        try {
          const localOpts = withExpectedEtag ? opts : { ...opts, expectedEtag: undefined };
          const result = await cloudPushSlot(slot!.cloudId ?? null, blob!, localOpts);
          const wasDriveSideRecovery = slot!.cloudId !== null && result.cloudId !== slot!.cloudId;
          setCloudPushed(id, {
            cloudId: result.cloudId,
            cloudEtag: result.etag,
            cloudPushedAt: new Date().toISOString(),
            cloudUpdatedAt: result.updatedAt,
          });
          setManifest(readManifest());
          if (wasDriveSideRecovery) {
            flashSkipped(
              `${slot!.name}'s cloud copy was missing — created a fresh one in your Drive folder.`,
            );
          }
        } catch (err) {
          if (err instanceof CloudEtagMismatchError) {
            // Hand the gate off to the conflict modal: cancelling
            // releases it; confirming releases it after the retry
            // attempt resolves. Either way the spinner keeps
            // spinning until the user resolves the modal, which
            // matches the user's mental model ("the push is still
            // pending, waiting on my decision").
            setCloudConflict({
              slotName: slot!.name,
              onConfirm: () => {
                setCloudConflict(null);
                void (async () => {
                  try {
                    await attemptPush(false);
                  } finally {
                    releasePushGate();
                  }
                })();
              },
              onCancel: releasePushGate,
            });
            return true;
          }
          const msg = err instanceof Error ? err.message : 'Cloud push failed.';
          flashSkipped(`Push failed for ${slot!.name}: ${msg}`);
        }
        return false;
      }
      void (async () => {
        let conflictTookOver = false;
        try {
          conflictTookOver = await attemptPush(true);
        } finally {
          if (!conflictTookOver) releasePushGate();
        }
      })();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [autosaveOn],
  );

  /**
   * Pull a slot's cloud copy and OVERWRITE the local blob in place
   * (keeping the slot id and cloudId binding). Distinct from the
   * library-modal Pull, which mints a NEW slot. If the slot is
   * currently loaded into memory, reload it so the user sees the
   * pulled state immediately (no awkward "your unsaved local edits
   * are still in memory" trap).
   *
   * Pull-overflow strip (locked decision): if writing the pulled blob
   * fails (local quota), strip its undo ring and retry once. Push
   * always uploads with an empty undo ring, so a cloud-originated
   * blob normally has nothing to strip — but a hand-edited Drive
   * file (or an early-Phase-2 file pushed before the strip rule
   * landed) might. After a successful strip-and-write, we do NOT
   * re-Push the truncated version: leaves the option open for another
   * device with more quota to pull the full version intact.
   */
  const onCloudPullSlot = useCallback(
    (id: string) => {
      if (!autosaveOn) return;
      // Re-entrancy guard: see the matching comment on onCloudPushSlot.
      // Pull is less likely to race (the user only clicks it once per
      // download intention), but a misfire on a flaky network shouldn't
      // be able to start a second pull while the first is still
      // resolving and clobber the first's manifest write.
      if (!pullTrackerRef.current.tryAcquire(id)) return;
      setPullingIds(pullTrackerRef.current.snapshot());
      function releasePullGate(): void {
        pullTrackerRef.current.release(id);
        setPullingIds(pullTrackerRef.current.snapshot());
      }
      const m = readManifest();
      const slot = m.slots.find((s) => s.id === id);
      if (!slot || !slot.cloudId) {
        releasePullGate();
        return;
      }
      // Capture the post-narrowing cloudId in a local — TypeScript's
      // narrowing of `slot.cloudId` from `string | undefined` to
      // `string` doesn't survive the async-IIFE closure boundary,
      // so reading `slot.cloudId` inside the IIFE would be typed as
      // `string | undefined` again.
      const cloudId = slot.cloudId;
      void (async () => {
        try {
          const result = await cloudPullSlot(cloudId);
          let strippedUndo = false;
          let wrote = replaceSlotBlob(id, result.blob);
          if (!wrote && result.blob.undoRing.length > 0) {
            // Quota recovery: strip the undo ring and retry. Also
            // mutate the in-memory `result.blob` so the session-
            // reload branch below sees the same stripped shape we
            // just persisted (otherwise the in-memory state would
            // briefly carry the full undo ring, then get contradicted
            // by the next read of disk).
            result.blob.undoRing = [];
            wrote = replaceSlotBlob(id, result.blob);
            strippedUndo = wrote;
          }
          if (!wrote) {
            flashSkipped(
              `Pulled ${slot.name} but couldn't write it locally — try deleting some slots to free space.`,
            );
            return;
          }
          if (strippedUndo) {
            flashSkipped(
              `Pulled ${slot.name} but had to drop its undo history to fit local storage.`,
            );
          }
          setCloudPulled(id, {
            cloudId,
            cloudEtag: result.etag,
            cloudUpdatedAt: result.updatedAt,
          });
          const refreshed = readManifest();
          setManifest(refreshed);
          // If the pulled slot is the loaded-into-memory one, swap the
          // in-memory state to match. Otherwise the user would still
          // see their old pre-pull view until they Resume the slot.
          // We read the active id from the fresh manifest rather than
          // closing over `loadedSlotId` (which is computed AFTER this
          // handler in source order) — same source-of-truth, no
          // forward-reference noise.
          if (refreshed.activeId === id) {
            const session = loadSlotSession(id);
            if (session) {
              setLoadedSlotId(id);
              setState(session.state);
              setUndoRing(session.undoRing);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Cloud pull failed.';
          flashSkipped(`Pull failed for ${slot.name}: ${msg}`);
        } finally {
          releasePullGate();
        }
      })();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [autosaveOn],
  );

  /**
   * Bulk push every opted-in slot to the cloud. Reads the manifest at
   * call time (rather than closing over a stale `manifest` snapshot)
   * and fans out to the per-slot `onCloudPushSlot` handler — that
   * means every slot inherits the same re-entrancy guard, conflict
   * modal flow, and spinner UI as a single-row Push. Slots that are
   * not opted in are skipped (we don't want bulk to silently auto-
   * opt-in slots the user hasn't explicitly chosen to back up).
   *
   * Concurrency note: per-slot calls are fired without awaiting, so
   * they run in parallel. Drive's quota is per-user so a handful of
   * parallel pushes is fine; if a user has hundreds of opted-in
   * slots they'll hit rate limits and individual rows will surface
   * the failures via `flashSkipped`. The InFlightTracker prevents
   * the same slot from being pushed twice if the user mashes the
   * bulk button.
   *
   * Conflict-modal stacking is a known soft limitation: a single
   * `cloudConflict` slot is rendered at a time, so if multiple
   * slots' pushes simultaneously hit etag mismatches only the last
   * one's modal is visible. The earlier conflicts' in-flight gates
   * are leaked until refresh. Acceptable for v1 — conflict on bulk
   * push is rare in practice (the user is the one who just clicked
   * "push all", so it usually means their local is the freshest
   * anyway).
   */
  const onCloudPushAllSlots = useCallback(() => {
    const m = readManifest();
    for (const slot of m.slots) {
      if (slot.cloudOptIn) onCloudPushSlot(slot.id);
    }
  }, [onCloudPushSlot]);

  /**
   * Bulk pull every opted-in slot that has an established cloud
   * binding (`cloudId`). Slots that are opted in but never pushed
   * (no cloudId yet) are skipped — there's nothing to pull, so
   * including them would just no-op. Slots that are not opted in
   * are also skipped (matching the bulk-push policy: bulk operations
   * never silently auto-opt-in).
   *
   * Use the per-slot handler so each row gets the same
   * re-entrancy guard + spinner UI + quota-recovery (undo-ring
   * strip) as a single-row Pull. The active slot, if any, has its
   * in-memory state swapped to the pulled blob automatically by the
   * per-slot handler — no special-case here.
   */
  const onCloudPullAllSlots = useCallback(() => {
    const m = readManifest();
    for (const slot of m.slots) {
      if (slot.cloudOptIn && slot.cloudId) onCloudPullSlot(slot.id);
    }
  }, [onCloudPullSlot]);

  // Derive the gear-menu's cloud tier from the live auth state. Pulled
  // out as a useMemo so SettingsMenu's prop identity is stable across
  // renders that don't change auth state.
  const cloudStatus: CloudMenuStatus = useMemo(() => {
    if (!cloudAvailable) return 'unavailable';
    if (cloudAuth.status === 'signed-out') return 'signed-out';
    if (cloudAuth.status === 'expired') return 'expired';
    if (!cloudAuth.folderId) return 'needs-folder';
    return 'ready';
  }, [cloudAvailable, cloudAuth]);

  // -------- memory-mode banner --------
  // The worker reports `storageMode === 'memory'` when it can't acquire
  // the OPFS SAH pool. The dominant cause is "another tab of this
  // origin already holds OPFS"; the user needs to know that this tab
  // is running on volatile storage so they can Pull from Drive (or
  // close the other tab and reload) to make their cache reachable.
  //
  // We also kick the worker boot here with a lightweight openSourceDb
  // call so the banner-detection path runs even when the user lands on
  // a tab (LIST / RESULT / etc.) that doesn't issue any AniList reads.
  // Without this, a fresh second tab opened directly into LIST would
  // never spawn the worker and the user would have zero indication that
  // anything was wrong.
  useEffect(() => {
    const handler = (event: Event): void => {
      setDbNonPersistent(true);
      const reason = (event as CustomEvent<DbNonPersistentEventDetail>).detail?.reason;
      if (reason) {
        setDbNonPersistentReason(reason);
      }
    };
    window.addEventListener(DB_NON_PERSISTENT_EVENT, handler);
    void openSourceDb(ANILIST_SOURCE_ID)
      .then((result) => {
        if (result.storageMode !== 'memory') {
          return;
        }
        setDbNonPersistent(true);
        setDbNonPersistentReason(
          result.opfsLockContendedByOtherTab ? 'other_tab' : 'opfs_unavailable',
        );
      })
      .catch(() => {});
    return () => {
      window.removeEventListener(DB_NON_PERSISTENT_EVENT, handler);
    };
  }, []);

  function dbSyncErrorMessage(err: unknown): string {
    const e = err as Error & { code?: string };
    if (e.code === REMOTE_DRIFTED) {
      return 'Remote has new changes — pull first.';
    }
    if (e.code === REMOTE_SCHEMA_NEWER) {
      return 'App is out of date — please reload.';
    }
    if (e.code === NO_REMOTE) {
      return 'No cloud copy yet — push first.';
    }
    if (e.code === MEMORY_MODE_PUSH_BLOCKED) {
      return 'Push blocked: non-persistent tab. Close other tabs of this app and reload, then push.';
    }
    return e.message || 'Sync failed.';
  }

  const onDbPushSource = useCallback(
    (sourceId: string) => {
      if (!autosaveOn || cloudStatus !== 'ready') return;
      if (!dbPushTrackerRef.current.tryAcquire(sourceId)) return;
      setDbPushingIds(dbPushTrackerRef.current.snapshot());
      setSourceDbErrors((prev) => {
        const next = { ...prev };
        delete next[sourceId];
        return next;
      });
      void (async () => {
        try {
          await pushDbToDrive(sourceId);
          setDbSyncRevision((r) => r + 1);
        } catch (err) {
          setSourceDbErrors((prev) => ({
            ...prev,
            [sourceId]: dbSyncErrorMessage(err),
          }));
          setDbSyncRevision((r) => r + 1);
        } finally {
          dbPushTrackerRef.current.release(sourceId);
          setDbPushingIds(dbPushTrackerRef.current.snapshot());
        }
      })();
    },
    [autosaveOn, cloudStatus],
  );

  const onDbPullSource = useCallback(
    (sourceId: string) => {
      if (!autosaveOn || cloudStatus !== 'ready') return;
      if (!dbPullTrackerRef.current.tryAcquire(sourceId)) return;
      setDbPullingIds(dbPullTrackerRef.current.snapshot());
      setSourceDbErrors((prev) => {
        const next = { ...prev };
        delete next[sourceId];
        return next;
      });
      void (async () => {
        try {
          await pullDbFromDrive(sourceId);
          setDbSyncRevision((r) => r + 1);
        } catch (err) {
          setSourceDbErrors((prev) => ({
            ...prev,
            [sourceId]: dbSyncErrorMessage(err),
          }));
          setDbSyncRevision((r) => r + 1);
        } finally {
          dbPullTrackerRef.current.release(sourceId);
          setDbPullingIds(dbPullTrackerRef.current.snapshot());
        }
      })();
    },
    [autosaveOn, cloudStatus],
  );

  // -------- AniList runner hook wiring + filter module registration --------
  //
  // The AniList importer modules sit on the data-layer side of the
  // codebase and don't know about React. Wire them into the App here
  // so:
  //   - Full-import autopush -> the existing per-source push button
  //     code path (gated on cloud-ready by `onDbPushSource`).
  //   - Per-entry refresh dirty-bumps -> a dbSyncRevision tick so the
  //     source panel re-reads its pending-changes counter.
  //
  // The filter module also lives on the UI side (registers chip
  // components + the SQL builder) and is registered exactly once at
  // App mount so the FilterBar can find it for any item with
  // `source.kind === 'anilist'`.
  useEffect(() => {
    ensureAnilistFiltersRegistered();
    // Phase 1 + phase 2 chips for character / staff favourites. Routed
    // under separate source.kind values (`anilist-character` /
    // `anilist-staff`) so they get distinct chip groups instead of
    // sharing the media chip module's state.
    ensureCharacterStaffFiltersRegistered();
    configureAnilistRunnerHooks({
      onAutoPushRequested: () => onDbPushSource(ANILIST_SOURCE_ID),
      onDirtyBumped: () => setDbSyncRevision((r) => r + 1),
    });
    return () => {
      // Idle reset on unmount so a future re-mount (HMR) rebinds
      // cleanly against the new closure rather than calling into a
      // stale one.
      configureAnilistRunnerHooks({});
    };
  }, [onDbPushSource]);

  // Relabel the in-memory engine items whenever the AniList display
  // preferences change (title language / name mode), so an in-progress
  // or completed sort flips to the new language without a reload. The
  // per-item `anilistLabelSource` carries the raw title/name fields;
  // `relabelAnilistItemPreservingFormat` is a no-op for non-AniList
  // items and keeps the user's `(FORMAT)`-suffix choice intact. We
  // don't push an undo frame — this is a cosmetic relabel, not an edit.
  useEffect(() => {
    return subscribeAnilistDisplayPreferences(() => {
      setState((cur) => {
        if (!cur) return cur;
        let changed = false;
        const items: Record<ItemId, Item> = {};
        for (const [id, item] of Object.entries(cur.items)) {
          const next = relabelAnilistItemPreservingFormat(item);
          if (next !== item) changed = true;
          items[id] = next;
        }
        return changed ? ({ ...cur, items } as SortState) : cur;
      });
    });
  }, []);

  // -------- start --------
  const startScreenRef = useRef<StartScreenHandle>(null);

  const [draftCaps, setDraftCaps] = useState<StartDraftCapabilities>({
    canList: false,
    canRank: false,
    canResult: false,
    hasLosableDraft: false,
  });

  /** Park the in-memory session so START draft work begins a fresh slot. */
  const parkActiveSession = useCallback(() => {
    if (!stateRef.current) return;
    flushAutosave();
    setLoadedSlotId(null);
    setState(null);
    setUndoRing([]);
    setManifest(readManifest());
  }, []);

  const handleTabChange = useCallback(
    (tab: TabId) => {
      if (activeTab === 'start' && tab !== 'start') {
        const adopted = startScreenRef.current?.tryAdoptDraft(tab);
        if (adopted) return;
      }
      setActiveTab(tab);
    },
    [activeTab],
  );

  const onStartScratch = useCallback(
    (items: Item[], initialTab?: TabId) => {
      const next = initSort(items, engineOptions);
      const session: SavedSession = { state: next, undoRing: [] };
      adoptNewSession(session, autoNameFromBlob(buildBlob(next, [])), initialTab);
    },
    [adoptNewSession, engineOptions],
  );

  const onStartPreranked = useCallback(
    (args: { sublists: Item[][]; extras: Item[] }, initialTab?: TabId) => {
      const next = seedFromSublists(args, engineOptions);
      const session: SavedSession = { state: next, undoRing: [] };
      adoptNewSession(session, autoNameFromBlob(buildBlob(next, [])), initialTab);
    },
    [adoptNewSession, engineOptions],
  );

  /**
   * Insertion-mode START entry point. Same combined `{ sublists, extras }`
   * draft as the merge path, but seeds the binary-insertion engine: the
   * largest pre-ranked sublist becomes the frozen `sorted[]` and
   * everything else binary-inserts one item at a time (rank-aware
   * tightening for the remaining sublists). Chosen via the Start Sort
   * split-button's "Insertion sort" option — a per-draft, non-persisted
   * mode toggle that lives in StartScreen.
   */
  const onStartInsertion = useCallback(
    (args: { sublists: Item[][]; extras: Item[] }, initialTab?: TabId) => {
      const { state: next } = seedInsertionFromSublists(args);
      const session: SavedSession = { state: next, undoRing: [] };
      adoptNewSession(session, autoNameFromBlob(buildBlob(next, [])), initialTab);
    },
    [adoptNewSession],
  );

  /**
   * CSV-as-sorted entry point: take the parsed items verbatim as a
   * frozen merge-engine done ranking (`queue = [[...ids]]`). The user can
   * then "+ Add items" later via the same merge resume paths as any
   * other completed sort.
   */
  const onStartAlreadySorted = useCallback(
    (items: Item[], initialTab?: TabId) => {
      const next = seedAsDoneMerge(items);
      const session: SavedSession = { state: next, undoRing: [] };
      adoptNewSession(session, autoNameFromBlob(buildBlob(next, [])), initialTab);
    },
    [adoptNewSession],
  );

  const onStartConfirmation = useCallback(
    (items: Item[], initialTab?: TabId) => {
      const next = seedConfirmation(items);
      const session: SavedSession = { state: next, undoRing: [] };
      adoptNewSession(session, autoNameFromBlob(buildBlob(next, [])), initialTab ?? 'rank');
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
    // Use the returned manifest — readManifest() after flushAutosave can
    // still see the outgoing activeId if a post-write listener ran first.
    const m = setActiveSlot(id);
    const session = loadSlotSession(id);
    if (!session) {
      // Bad data — refresh manifest and stay put.
      setManifest(readManifest());
      return;
    }
    setLoadedSlotId(id);
    setManifest(m);
    setState(session.state);
    setUndoRing(session.undoRing);
    setActiveTab(session.state.done ? 'result' : 'rank');
  }, []);

  const localCloudSlotByCloudId = useMemo(() => {
    const index = new Map<string, SlotMeta>();
    for (const slot of manifest.slots) {
      if (slot.cloudId && !index.has(slot.cloudId)) {
        index.set(slot.cloudId, slot);
      }
    }
    return index;
  }, [manifest.slots]);

  // Routed from the library modal's Pull button. Wraps the inbound
  // cloud blob into the `SavedSession` shape that `adoptNewSession`
  // already speaks — keeping cap-eviction / quota-recovery / first-
  // write-failure on the one well-tested path.
  //
  // If this Drive file is already bound to a local slot, switch to it
  // instead of minting a duplicate (same cloudId as LIST-tab Pull).
  const onCloudPull = useCallback(
    async (meta: CloudSlotMeta) => {
      const existing = findSlotByCloudId(meta.cloudId);
      if (existing) {
        setCloudLibraryOpen(false);
        onSwitchSlot(existing.id);
        return;
      }
      try {
        const pulled = await cloudPullSlot(meta.cloudId);
        const session = deserialize(pulled.blob);
        if (!session) {
          flashSkipped('Pulled file was not a valid sorter slot.');
          return;
        }
        setCloudLibraryOpen(false);
        // Adopt with timestamps derived from the cloud file's own modified
        // time so the new slot reads as "synced" (not "local changes
        // pending") and sorts into its real recency position instead of
        // jumping to the top — performSlotMint applies the `updatedAt` from
        // `cloudUpdatedAt`. See deriveAdoptedCloudSlotTimestamps.
        const ts = deriveAdoptedCloudSlotTimestamps(
          pulled.updatedAt,
          new Date().toISOString(),
        );
        adoptNewSession(session, meta.displayName, undefined, {
          cloudId: meta.cloudId,
          cloudEtag: pulled.etag,
          cloudPushedAt: ts.cloudPushedAt,
          cloudUpdatedAt: ts.cloudUpdatedAt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Pull failed.';
        flashSkipped(msg);
      }
    },
    [adoptNewSession, flashSkipped, onSwitchSlot],
  );

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
      const wasLoaded = loadedSlotId === id;
      const m = deleteSlot(id);
      setManifest(m);
      if (wasLoaded) {
        setLoadedSlotId(null);
        setState(null);
        setUndoRing([]);
        setActiveTab('start');
      }
    },
    [loadedSlotId],
  );

  /** Cloud library: drop local copy when listing shows a full sync. */
  const onRemoveLocalFromCloudLibrary = useCallback(
    (id: string) => {
      performDeleteSlot(id);
    },
    [performDeleteSlot],
  );

  // Single entry-point for "delete this slot, with confirm-unless-suppressed".
  // Used by both the gear-popover trashcan (any slot) and the toolbar "Delete
  // this slot" item (currently active slot). Reads the manifest fresh so the
  // modal title shows the right name even if the manifest closure is stale.
  //
  // suppressResetConfirm short-circuits the modal ONLY when there's no
  // cloud copy. The local-vs-everywhere choice should always be explicit
  // for cloud-backed slots, never silently default to one side.
  const requestDeleteSlot = useCallback(
    (id: string) => {
      const slot = readManifest().slots.find((s) => s.id === id);
      if (!slot) return;
      if (!slot.cloudId && readSettings().suppressResetConfirm) {
        performDeleteSlot(id);
      } else {
        setSlotPendingDelete({ id, name: slot.name, cloudId: slot.cloudId });
      }
    },
    [performDeleteSlot],
  );

  /**
   * Delete a slot's local + cloud blob in lock-step. Cloud delete runs
   * first so a cloud-side failure (e.g. revoked permission) surfaces
   * before we destroy the local copy — keeps the user from losing
   * everything when only the cloud delete misbehaves.
   */
  const performDeleteSlotEverywhere = useCallback(
    async (id: string, cloudId: string) => {
      try {
        await cloudRemoveCloudSlot(cloudId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Cloud delete failed.';
        flashSkipped(`Couldn't delete the cloud copy: ${msg}. Local slot left in place.`);
        return;
      }
      performDeleteSlot(id);
    },
    // performDeleteSlot is closure-captured; flashSkipped is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Force-flush the active slot and bump its recency (`updatedAt`) so it
  // rises to the top of the slot list — even when nothing changed since
  // the last autosave.
  const onSaveNow = useCallback(() => {
    if (!state) return;
    saveNow(buildBlob(state, undoRing));
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
        setLoadedSlotId(null);
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
  //   - EXCLUDES `toBeInserted[]` — items that were exiled but never
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
    const slotName =
      manifest.slots.find((s) => s.id === (loadedSlotId ?? manifest.activeId))?.name ??
      'Untitled sort';
    adoptNewSession(session, derivedSlotName(slotName, 'redo'), 'list');
  }, [state, manifest.slots, manifest.activeId, loadedSlotId, adoptNewSession, engineOptions]);

  const requestStartOver = useCallback(() => {
    if (!state) return;
    const itemCount = engineGetRanking(state).length;
    if (itemCount === 0) return;
    const slotName =
      manifest.slots.find((s) => s.id === (loadedSlotId ?? manifest.activeId))?.name ??
      'Untitled sort';
    if (readSettings().suppressStartOverConfirm) {
      performStartOver();
      return;
    }
    setStartOverPending({ itemCount, slotName });
  }, [state, manifest.slots, manifest.activeId, loadedSlotId, performStartOver]);

  // -------- keyboard --------
  const rankInProgress = activeTab === 'rank' && state !== null && !state.done;
  const listInProgress = activeTab === 'list' && state !== null && !state.done;
  const startHasLosableDraft = activeTab === 'start' && draftCaps.hasLosableDraft;
  const historyBackGuardActive = startHasLosableDraft || listInProgress || rankInProgress;

  useKeyboard(
    {
      onLeft: rankInProgress ? () => doPick('left') : undefined,
      onRight: rankInProgress ? () => doPick('right') : undefined,
      onUp: rankInProgress ? () => doUndo() : undefined,
    },
    rankInProgress,
  );

  const onBlockedHistoryBack = useCallback(() => {
    if (startHasLosableDraft) {
      flashSkipped('Unsaved START draft — use the tabs to navigate.');
      return;
    }
    flashSkipped('Sort in progress — use the tabs to navigate.');
  }, [startHasLosableDraft, flashSkipped]);

  useHistoryBackGuard(historyBackGuardActive && historyBackGuard, onBlockedHistoryBack);

  // -------- derived --------
  const hasState = state !== null;
  const canUndo = undoRing.length > 0;

  // Slot whose blob is in memory — null when parked / after refresh.
  const effectiveLoadedSlotId = hasState ? loadedSlotId : null;
  const loadedSlotItemCount = state ? listHeaderItemCount(state) : null;
  const loadedSlotName =
    manifest.slots.find((s) => s.id === (loadedSlotId ?? manifest.activeId))?.name ??
    'Untitled sort';

  // The single-slot Resume CTA on START. Only shown when there's no
  // in-memory session AND we have a previously-active slot to resume.
  const resumeMeta =
    hasState
      ? null
      : manifest.slots.find((s) => s.id === manifest.activeId) ?? null;

  // -------- render --------
  // Keep StartScreen mounted while LIST/RANK/RESULT are visible so staged
  // draft state (useState inside StartScreen) survives START ↔ sort tabs.
  const showStartScreen = activeTab === 'start' || !state;

  const startScreenEl = (
    <div
      className="start-screen-host"
      hidden={!showStartScreen}
      aria-hidden={!showStartScreen}
    >
      <StartScreen
        ref={startScreenRef}
        resumeMeta={resumeMeta}
        onResumeActive={onResumeActive}
        onStartScratch={onStartScratch}
        onStartPreranked={onStartPreranked}
        onStartInsertion={onStartInsertion}
        onStartAlreadySorted={onStartAlreadySorted}
        onStartConfirmation={onStartConfirmation}
        hasLoadedSession={hasState}
        onDraftActivity={parkActiveSession}
        onDraftCapabilitiesChange={setDraftCaps}
        dbSyncRevision={dbSyncRevision}
      />
    </div>
  );

  let body: JSX.Element;
  if (showStartScreen) {
    body = startScreenEl;
  } else if (activeTab === 'list') {
    body = (
      <>
        {startScreenEl}
        <ListScreen
        state={state}
        dbSyncRevision={dbSyncRevision}
        slotId={effectiveLoadedSlotId ?? ''}
        slotName={loadedSlotName}
        onRenameSlot={onRenameSlot}
        onHide={doHide}
        onUnhide={doUnhide}
        onReorder={doReorder}
        onReorderInCurrentMerge={doReorderInCurrentMerge}
        onReorderInsertTarget={doReorderInsertTarget}
        onBreakApart={doBreak}
        onAddItem={doAddItem}
        onAddItems={doAddItemsList}
        onAddSlotImports={doAddSlotImports}
        onAppendPreRanked={doAppendPreRanked}
        onForget={doForget}
        onReorderInSorted={doReorderInSorted}
        onReturnToPending={doReturnToPending}
        onDismissHidden={doDismissHidden}
        onRestoreHidden={doRestoreHidden}
        onReinsertHidden={doReinsertHidden}
        onForgetHidden={doForgetHidden}
        onEditItem={doEditItem}
      />
      </>
    );
  } else if (activeTab === 'rank') {
    body = (
      <>
        {startScreenEl}
        <CompareScreen
        state={state}
        lastInteraction={lastInteraction}
        onPickLeft={() => doPick('left')}
        onPickRight={() => doPick('right')}
        onHide={doHide}
        onCancelManualInsert={doCancelManualInsert}
        onEditItem={doEditItem}
        onReorderConfirmed={doReorderInSorted}
        onReturnToPending={doReturnToPending}
        autoInsertEnabled={autoInsertEnabled}
      />
      </>
    );
  } else {
    body = (
      <>
        {startScreenEl}
        <ResultScreen
        state={state}
        dbSyncRevision={dbSyncRevision}
        slotName={loadedSlotName}
        slotId={effectiveLoadedSlotId ?? undefined}
        onUnhide={doUnhide}
        onRestoreHidden={doRestoreHidden}
        onForgetHidden={doForgetHidden}
        onStartOver={requestStartOver}
        onAddOne={doAddItem}
        onAddMany={doAddItemsList}
        onAddSlotImports={doAddSlotImports}
        onAddPreRanked={doAppendPreRanked}
      />
      </>
    );
  }

  // Auto-switch tabs when the sort crosses the done boundary:
  //   in-progress on RANK → RESULT when complete
  //   undo (or any restore) leaving completed → RANK when no longer done
  const prevDoneRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const wasDone = prevDoneRef.current;
    const isDone = state?.done ?? false;
    prevDoneRef.current = isDone;

    if (isDone && activeTab === 'rank') {
      setActiveTab('result');
    } else if (wasDone && state && !isDone) {
      setActiveTab('rank');
    }
  }, [state, activeTab]);

  return (
    <ItemDetailContext.Provider value={openItemDetail}>
    <div className="app-shell">
      <AppBannerStack>
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
            <RemoveGlyph size={12} />
          </button>
        </div>
      )}
      {dbNonPersistent && !dbNonPersistentDismissed && (
        // Non-persistent storage banner. The worker fell back to an
        // in-memory SQLite DB — almost always because another tab of
        // the same origin already holds the OPFS SAH pool (browsers
        // grant OPFS access exclusively to one realm at a time). The
        // user's persisted data sits in OPFS but this tab can't reach
        // it. We tell them what's wrong, how to load data for this
        // session (Pull from Drive), and how to make it persistent
        // again (close the other tab, reload).
        <div className="app-banner warn">
          <span>
            {describeNonPersistentStorageBanner({
              reason: dbNonPersistentReason,
              context: 'sorter',
            })}
            {dbNonPersistentReason === 'other_tab' && (
              <>
                {' '}
                Pull from Drive (gear &rarr; Source databases &rarr; Pull) to load data
                for this session without closing the other tab.
              </>
            )}
          </span>
          <button
            type="button"
            className="banner-dismiss"
            onClick={() => setDbNonPersistentDismissed(true)}
            aria-label="Dismiss non-persistent storage warning"
            title="Dismiss"
          >
            <RemoveGlyph size={12} />
          </button>
        </div>
      )}
      {cloudAvailable && cloudAuth.status === 'expired' && !cloudExpiredDismissed && (
        // Refresh-token-rejected banner. Locked behavior (Phase 3
        // ITP): no automatic retry queue — surfacing the prompt
        // immediately is the whole recovery mechanism. The Sign in
        // button triggers a same-window OAuth redirect; the dismiss
        // button suppresses the banner for the rest of the session
        // (re-armed on any auth-status transition out of 'expired').
        <div className="app-banner warn">
          <span>
            Cloud session expired &mdash; sign in again to resume Push / Pull.
            Your local sorts are unaffected.
          </span>
          <button
            type="button"
            className="banner-action"
            onClick={onCloudSignIn}
            aria-label="Sign in to cloud again"
          >
            Sign in
          </button>
          <button
            type="button"
            className="banner-dismiss"
            onClick={() => setCloudExpiredDismissed(true)}
            aria-label="Dismiss cloud session expired warning"
            title="Dismiss"
          >
            <RemoveGlyph size={12} />
          </button>
        </div>
      )}
      {multitabStaleSlotId && multitabStaleSlotId === loadedSlotId && state && (
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
            <RemoveGlyph size={12} />
          </button>
        </div>
      )}
      {skippedMessage && <div className="app-banner">{skippedMessage}</div>}
      {apiWait && apiWaitSecondsLeft !== null && (
        <div className="app-banner warn">
          <span>
            AniList rate limit — retrying in {apiWaitSecondsLeft}s (attempt{' '}
            {apiWait.attempt})
          </span>
        </div>
      )}
      </AppBannerStack>
      <Header
        activeTab={activeTab}
        onTabChange={handleTabChange}
        state={state}
        canUndo={canUndo}
        onUndo={doUndo}
        onSaveNow={onSaveNow}
        onDownload={onDownload}
        autosaveAvailable={autosaveOn}
        onLoadFromFile={onLoadFile}
        onBackupAll={onBackupAll}
        onRestoreFromBackup={onRestoreFromBackup}
        manifest={manifest}
        loadedSlotId={effectiveLoadedSlotId}
        loadedSlotItemCount={loadedSlotItemCount}
        onSwitchSlot={onSwitchSlot}
        onDeleteSlot={onDeleteSlot}
        onRenameSlot={onRenameSlot}
        onDownloadSlot={onDownloadSlot}
        onTogglePinSlot={onTogglePinSlot}
        hasState={hasState}
        draftCaps={draftCaps}
        theme={theme}
        onToggleTheme={toggleTheme}
        showEstimatedRemaining={showEstimatedRemaining}
        onToggleShowEstimatedRemaining={toggleShowEstimatedRemaining}
        autoInsertEnabled={autoInsertEnabled}
        onToggleAutoInsertEnabled={toggleAutoInsertEnabled}
        historyBackGuard={historyBackGuard}
        onToggleHistoryBackGuard={toggleHistoryBackGuard}
        cloudStatus={cloudStatus}
        cloudFolderName={cloudAuth.folderName}
        onCloudSignIn={onCloudSignIn}
        onCloudPickFolder={onCloudPickFolder}
        onCloudBrowse={onCloudBrowse}
        onCloudSignOut={onCloudSignOut}
        onCloudToggleOptIn={onCloudToggleOptInSlot}
        onCloudPushSlot={onCloudPushSlot}
        onCloudPullSlot={onCloudPullSlot}
        cloudPushingIds={pushingIds}
        cloudPullingIds={pullingIds}
        dbPushingIds={dbPushingIds}
        dbPullingIds={dbPullingIds}
        sourceDbErrors={sourceDbErrors}
        dbSyncRevision={dbSyncRevision}
        onDbPushSource={onDbPushSource}
        onDbPullSource={onDbPullSource}
        onCloudPushAllSlots={onCloudPushAllSlots}
        onCloudPullAllSlots={onCloudPullAllSlots}
        onNewSort={() => handleTabChange('start')}
      />
      <main className="app-main">{body}</main>
      {slotPendingDelete && (
        <SlotDeleteConfirmModal
          slotName={slotPendingDelete.name}
          hasCloudCopy={!!slotPendingDelete.cloudId}
          onCancel={() => setSlotPendingDelete(null)}
          onConfirmLocalOnly={(dontAsk) => {
            if (dontAsk) updateSettings({ suppressResetConfirm: true });
            const id = slotPendingDelete.id;
            setSlotPendingDelete(null);
            performDeleteSlot(id);
          }}
          onConfirmEverywhere={() => {
            const id = slotPendingDelete.id;
            const cloudId = slotPendingDelete.cloudId;
            setSlotPendingDelete(null);
            if (cloudId) {
              void performDeleteSlotEverywhere(id, cloudId);
            } else {
              performDeleteSlot(id);
            }
          }}
        />
      )}
      {completedEditPending && (
        <CompletedSortEditConfirmModal
          slotName={completedEditPending.slotName}
          action={completedEditPending.action}
          onCancel={() => setCompletedEditPending(null)}
          onModifyCurrent={() => {
            const { action, slotName } = completedEditPending;
            setCompletedEditPending(null);
            executeCompletedSortEdit(action, 'current', slotName);
          }}
          onCreateNewSlot={(dontAsk) => {
            if (dontAsk) {
              updateSettings({ suppressCompletedSortEditConfirm: true });
            }
            const { action, slotName } = completedEditPending;
            setCompletedEditPending(null);
            executeCompletedSortEdit(action, 'new', slotName);
          }}
        />
      )}
      {startOverPending && (
        <StartOverConfirmModal
          itemCount={startOverPending.itemCount}
          slotName={startOverPending.slotName}
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
      {cloudLibraryOpen && (
        <CloudLibraryModal
          onClose={() => setCloudLibraryOpen(false)}
          onPull={onCloudPull}
          localCloudSlotByCloudId={localCloudSlotByCloudId}
          onOpenLocalSlot={onSwitchSlot}
          onRemoveLocalSlot={onRemoveLocalFromCloudLibrary}
          activeSlotId={manifest.activeId}
          onSignedOut={() => setCloudAuth(cloudGetAuthState())}
          onFolderChanged={() => setCloudAuth(cloudGetAuthState())}
        />
      )}
      {cloudUnlinkPending && (
        <CloudUnlinkConfirmModal
          slotName={cloudUnlinkPending.slotName}
          onCancel={() => setCloudUnlinkPending(null)}
          onConfirm={cloudUnlinkPending.onConfirm}
        />
      )}
      {cloudConflict && (
        <CloudPushConflictModal
          slotName={cloudConflict.slotName}
          onCancel={() => {
            // Release the in-flight gate the push handler is still
            // holding (so the spinner stops + the button re-enables)
            // BEFORE clearing the modal state — the order doesn't
            // matter functionally, but keeping side-effects first
            // matches the rest of the modal-cancel paths in this
            // file.
            cloudConflict.onCancel();
            setCloudConflict(null);
          }}
          onPushAnyway={cloudConflict.onConfirm}
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
      {itemDetailTarget && (
        <AnilistDetailModal
          mediaId={itemDetailTarget.mediaId}
          fallbackTitle={itemDetailTarget.fallbackTitle}
          onClose={() => setItemDetailTarget(null)}
          onOpenStaff={(staffId, fallbackName) => {
            setItemDetailTarget(null);
            setStaffDetailTarget({ staffId, fallbackName });
          }}
        />
      )}
      {staffDetailTarget && (
        <StaffDetailModal
          staffId={staffDetailTarget.staffId}
          fallbackName={staffDetailTarget.fallbackName}
          onClose={() => setStaffDetailTarget(null)}
          onOpenMedia={(mediaId, fallbackTitle) => {
            setStaffDetailTarget(null);
            setItemDetailTarget({ mediaId, fallbackTitle });
          }}
        />
      )}
    </div>
    </ItemDetailContext.Provider>
  );
}

