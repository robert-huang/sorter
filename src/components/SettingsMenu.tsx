import { useEffect, useRef, useState } from 'react';
import { ANIME_TO_ANIME_HREF } from '../lib/appRoutes';
import { SettingsGitHubLink } from './SettingsGitHubLink';
import { SlotList } from './SlotList';
import { CloudBackupSection } from './CloudBackupSection';
import { SourceDatabasesSection } from './sourceDatabasesSection';
import type { SlotsManifest } from '../lib/types';

/**
 * Cloud-section auth tier rendered in the gear menu.
 *
 * signed-out:     show "Sign in to cloud"
 * needs-folder:   tokens present but no folder picked yet — show
 *                 "Pick cloud folder" highlighted as the next step
 * ready:          tokens + folder present — show Browse / Change
 *                 folder / Sign out
 * expired:        refresh token gone — show "Please sign in again"
 *                 with the Sign-in entry as the primary action
 *
 * `unavailable` collapses the section entirely (e.g. autosave is
 * off — cloud backup has nothing to back up to).
 */
export type CloudMenuStatus = 'unavailable' | 'signed-out' | 'needs-folder' | 'ready' | 'expired';

interface Props {
  autosaveAvailable: boolean;
  onLoadFromFile: (file: File) => void;
  onReset: () => void;
  /** Trigger a JSON download of every slot in one archive file. */
  onBackupAll: () => void;
  /**
   * Hand a SlotArchive JSON file to the App for parsing + confirm modal.
   * Distinct from onLoadFromFile (which expects a single-slot SaveFile).
   * The App branches on archive vs single-slot shape itself; this prop
   * is just the upload trigger.
   */
  onRestoreFromBackup: (file: File) => void;
  /** Disable the "Delete this slot" entry when there is no active slot. */
  hasActiveSlot: boolean;
  /** Slots manifest, rendered inline at the top of the menu. */
  manifest: SlotsManifest;
  /** Slot whose blob is loaded in memory now (null if none). */
  loadedSlotId: string | null;
  onSwitchSlot: (id: string) => void;
  onDeleteSlot: (id: string) => void;
  onRenameSlot: (id: string, name: string) => void;
  /** Download a JSON copy of a slot's on-disk blob from the per-row
   *  button in the slot list. */
  onDownloadSlot: (id: string) => void;
  /** Pin/unpin a slot. Pinned slots are excluded from the auto-eviction
   *  loop when `createSlot` hits the cap. */
  onTogglePinSlot: (id: string, pinned: boolean) => void;
  showEstimatedRemaining: boolean;
  onToggleShowEstimatedRemaining: () => void;
  /**
   * Whether the merge engine auto-inserts a popped pair when the smaller
   * side is small enough that binary insertion beats the full merge.
   * Default on. Off forces every pair through the classic merge.
   */
  autoInsertEnabled: boolean;
  onToggleAutoInsertEnabled: () => void;
  // ---------- cloud backup (tier 0b) ----------
  /** Current cloud menu tier; collapses the section when 'unavailable'. */
  cloudStatus: CloudMenuStatus;
  /** Display name of the currently-picked folder; shown as a hint
   *  under "Browse cloud library" in the 'ready' tier. */
  cloudFolderName?: string;
  /** Initiate the OAuth redirect. Called for both initial sign-in and
   *  re-sign-in from the 'expired' tier. */
  onCloudSignIn: () => void;
  /** Open the Google Picker so the user can choose a folder.
   *  Must be called from the click handler so popup blockers don't
   *  eat the picker. */
  onCloudPickFolder: () => void;
  /** Open the read-only Phase-1 cloud library modal. */
  onCloudBrowse: () => void;
  /** Sign out: wipes tokens + folder selection. Cloud-side files are
   *  not touched. */
  onCloudSignOut: () => void;
  /** Per-slot cloud handlers passed through to SlotList. Only consumed
   *  when `cloudStatus === 'ready'` — earlier tiers can't push/pull. */
  onCloudToggleOptIn: (id: string, optIn: boolean) => void;
  onCloudPushSlot: (id: string) => void;
  onCloudPullSlot: (id: string) => void;
  /** Ids of slots whose Push request is currently in flight — driven
   *  from App.tsx's InFlightTracker. SlotList uses these to swap the
   *  Push glyph for a spinner and disable the button. */
  cloudPushingIds: ReadonlySet<string>;
  /** Same as cloudPushingIds, but for Pull. */
  cloudPullingIds: ReadonlySet<string>;
  /** Per-source SQLite DB sync (Phase B). */
  dbPushingIds: ReadonlySet<string>;
  dbPullingIds: ReadonlySet<string>;
  sourceDbErrors: Record<string, string>;
  dbSyncRevision: number;
  onDbPushSource: (sourceId: string) => void;
  onDbPullSource: (sourceId: string) => void;
  /** Bulk push every opted-in slot to the cloud. Triggered by the
   *  "[⇡ ALL]" affordance in the SlotList header. App-side handler
   *  fans out to per-slot push; we just pipe the click through. */
  onCloudPushAllSlots: () => void;
  /** Bulk pull every opted-in slot with an established cloud binding.
   *  Triggered by the "[⇣ ALL]" affordance. */
  onCloudPullAllSlots: () => void;
  /**
   * Click handler for the "[NEW]" button rendered on the right edge of
   * the SlotList "Saved sorts" header. App-side wiring just navigates
   * to the START tab; this prop only propagates that intent. We close
   * the popover here too so the menu doesn't sit overtop the START
   * screen the user is about to interact with.
   */
  onNewSort: () => void;
}

/** Persisted tab selection key so reopening the gear menu lands on
 *  the same tab the user last used. Lives in localStorage rather
 *  than React state across mounts so a hard reload doesn't reset
 *  it. */
const GEAR_TAB_LS_KEY = 'settings:lastTab';
type GearTab = 'slots' | 'databases';

function readPersistedTab(): GearTab {
  try {
    const v = localStorage.getItem(GEAR_TAB_LS_KEY);
    if (v === 'slots' || v === 'databases') return v;
  } catch {
    /* private mode / quota — fall through */
  }
  return 'slots';
}

function writePersistedTab(tab: GearTab): void {
  try {
    localStorage.setItem(GEAR_TAB_LS_KEY, tab);
  } catch {
    /* ignore */
  }
}

export function SettingsMenu({
  autosaveAvailable,
  onLoadFromFile,
  onReset,
  onBackupAll,
  onRestoreFromBackup,
  hasActiveSlot,
  manifest,
  loadedSlotId,
  onSwitchSlot,
  onDeleteSlot,
  onRenameSlot,
  onDownloadSlot,
  onTogglePinSlot,
  showEstimatedRemaining,
  onToggleShowEstimatedRemaining,
  autoInsertEnabled,
  onToggleAutoInsertEnabled,
  cloudStatus,
  cloudFolderName,
  onCloudSignIn,
  onCloudPickFolder,
  onCloudBrowse,
  onCloudSignOut,
  onCloudToggleOptIn,
  onCloudPushSlot,
  onCloudPullSlot,
  cloudPushingIds,
  cloudPullingIds,
  dbPushingIds,
  dbPullingIds,
  sourceDbErrors,
  dbSyncRevision,
  onDbPushSource,
  onDbPullSource,
  onCloudPushAllSlots,
  onCloudPullAllSlots,
  onNewSort,
}: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<GearTab>(() => readPersistedTab());
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Separate hidden input for archive restore so we can scope its
  // change handler to "this is an archive" rather than "this is a
  // single-slot save". Keeps the two pickers' UX independent.
  const archiveFileRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  function selectTab(next: GearTab): void {
    setTab(next);
    writePersistedTab(next);
  }

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent): void {
      if (!wrapRef.current) return;
      const target = e.target as Element | null;
      if (!target) return;
      if (wrapRef.current.contains(target)) return;
      // Don't auto-close while a confirm modal is up over the popover —
      // otherwise clicking Cancel or anywhere on the modal backdrop would
      // dump the user out of the slot list as a side-effect.
      if (target.closest('.modal-backdrop, .modal')) return;
      setOpen(false);
    }
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  function onLoadClick(): void {
    setOpen(false);
    fileRef.current?.click();
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (file) onLoadFromFile(file);
    e.target.value = '';
  }

  function onBackupAllClick(): void {
    setOpen(false);
    onBackupAll();
  }

  function onRestoreClick(): void {
    setOpen(false);
    archiveFileRef.current?.click();
  }

  function onArchiveFileChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (file) onRestoreFromBackup(file);
    e.target.value = '';
  }

  function onResetClick(): void {
    setOpen(false);
    onReset();
  }

  // Auto-close the popover after the user resumes a slot so the menu
  // doesn't sit overtop the new sort view.
  function handleSwitch(id: string): void {
    setOpen(false);
    onSwitchSlot(id);
  }

  // Same close-then-act pattern as `handleSwitch`. The START tab is
  // a full-bleed view; leaving the gear popover open over it would
  // partially obscure the very screen the click was meant to surface.
  function handleNewSort(): void {
    setOpen(false);
    onNewSort();
  }

  return (
    <div className="settings-wrap" ref={wrapRef}>
      <button
        className="toolbar-button gear"
        onClick={() => setOpen((v) => !v)}
        aria-label="Settings"
        title="Settings"
      >
        ⚙
      </button>
      {open && (
        <div className="settings-popover">
          <div className="settings-tabs" role="tablist" aria-label="Settings tabs">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'slots'}
              className={`settings-tab${tab === 'slots' ? ' active' : ''}`}
              onClick={() => selectTab('slots')}
            >
              Slots
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'databases'}
              className={`settings-tab${tab === 'databases' ? ' active' : ''}`}
              onClick={() => selectTab('databases')}
            >
              Databases
            </button>
          </div>

          <div className="settings-tab-body" role="tabpanel">
            {tab === 'slots' && (
              <>
                {/* SlotList pins header + search; only rows scroll
                    (.settings-slots-scroll on the list body). Action
                    buttons below stay outside the thumb. */}
                <div className="settings-slots">
                  <SlotList
                    slots={manifest.slots}
                    loadedSlotId={loadedSlotId}
                    onSwitch={handleSwitch}
                    onDelete={onDeleteSlot}
                    onRename={onRenameSlot}
                    onDownload={onDownloadSlot}
                    onTogglePin={onTogglePinSlot}
                    cloudControlsVisible={cloudStatus === 'ready'}
                    onCloudToggleOptIn={onCloudToggleOptIn}
                    onCloudPush={onCloudPushSlot}
                    onCloudPull={onCloudPullSlot}
                    cloudPushingIds={cloudPushingIds}
                    cloudPullingIds={cloudPullingIds}
                    onCloudPushAll={onCloudPushAllSlots}
                    onCloudPullAll={onCloudPullAllSlots}
                    onNewSort={handleNewSort}
                    listScrollClassName="settings-slots-scroll"
                  />
                </div>
                <div className="settings-tab-actions">
                  <div className="settings-divider" />
                  <button className="settings-item" onClick={onLoadClick}>
                    Load save file…
                  </button>
                  <button
                    className="settings-item"
                    onClick={onBackupAllClick}
                    disabled={manifest.slots.length === 0}
                    title={
                      manifest.slots.length === 0
                        ? 'No slots to back up yet'
                        : 'Download every slot in a single JSON archive'
                    }
                  >
                    Backup all slots…
                  </button>
                  <button
                    className="settings-item"
                    onClick={onRestoreClick}
                    title="Import a previously-saved archive file"
                  >
                    Restore from backup…
                  </button>
                  <button
                    className="settings-item danger"
                    onClick={onResetClick}
                    disabled={!hasActiveSlot}
                    title={
                      hasActiveSlot
                        ? 'Delete the slot you are currently sorting in'
                        : 'No active slot to delete'
                    }
                  >
                    Delete this slot
                  </button>
                  {cloudStatus !== 'unavailable' && (
                    <>
                      <div className="settings-divider" />
                      <CloudBackupSection
                        status={cloudStatus}
                        folderName={cloudFolderName}
                        onSignIn={() => {
                          setOpen(false);
                          onCloudSignIn();
                        }}
                        onPickFolder={() => {
                          setOpen(false);
                          onCloudPickFolder();
                        }}
                        onBrowse={() => {
                          setOpen(false);
                          onCloudBrowse();
                        }}
                        onSignOut={() => {
                          setOpen(false);
                          onCloudSignOut();
                        }}
                      />
                    </>
                  )}
                </div>
              </>
            )}

            {tab === 'databases' && (
              // Databases tab keeps a single scroller across its body —
              // there's no pinned action region here, so the whole
              // panel is free to scroll when the database list grows.
              <div className="settings-tab-scroll">
                {cloudStatus === 'unavailable' ? (
                  <div className="settings-status">
                    Database sync needs autosave enabled. Open the app from
                    a http(s) origin to enable it.
                  </div>
                ) : (
                  <SourceDatabasesSection
                    cloudStatus={cloudStatus}
                    pushingIds={dbPushingIds}
                    pullingIds={dbPullingIds}
                    sourceDbErrors={sourceDbErrors}
                    syncRevision={dbSyncRevision}
                    onPushSource={onDbPushSource}
                    onPullSource={onDbPullSource}
                  />
                )}
                <div className="settings-status">
                  To refresh a source's data, open the Start tab and pick
                  the source's import mode.
                </div>
              </div>
            )}
          </div>

          {/* Persistent footer — sort-engine toggles + autosave status
              live below the tabs because they apply globally, not
              per-tab, and the user expects them in a stable location. */}
          <div className="settings-footer">
            <div className="settings-divider" />
            <label className="settings-item checkbox">
              <input
                type="checkbox"
                checked={showEstimatedRemaining}
                onChange={onToggleShowEstimatedRemaining}
              />{' '}
              Show estimated comparisons left
            </label>
            <label
              className="settings-item checkbox"
              title="When on, the sort can swap a popped queue pair for binary insertion when the smaller side is small enough that insertion beats the full merge. Turn off to force classic merge on every pair."
            >
              <input
                type="checkbox"
                checked={autoInsertEnabled}
                onChange={onToggleAutoInsertEnabled}
              />{' '}
              Auto-insert skewed pairs
            </label>
            <div className="settings-divider" />
            <div className="settings-status">
              <a href={ANIME_TO_ANIME_HREF}>Anime to Anime</a>
              <span className="settings-item-hint">
                {' '}
                — connect two shows via voice actors
              </span>
            </div>
            <div className="settings-status">
              Autosave: {autosaveAvailable ? 'on' : 'disabled (file:// origin)'}
            </div>
            <SettingsGitHubLink />
          </div>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={onFileChange}
      />
      <input
        ref={archiveFileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={onArchiveFileChange}
      />
    </div>
  );
}

