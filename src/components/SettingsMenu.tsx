import { useEffect, useRef, useState } from 'react';
import { SlotList } from './SlotList';
import type { SlotsManifest } from '../lib/types';

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
}: Props) {
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Separate hidden input for archive restore so we can scope its
  // change handler to "this is an archive" rather than "this is a
  // single-slot save". Keeps the two pickers' UX independent.
  const archiveFileRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

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
          <div className="settings-slots">
            <SlotList
              slots={manifest.slots}
              loadedSlotId={loadedSlotId}
              onSwitch={handleSwitch}
              onDelete={onDeleteSlot}
              onRename={onRenameSlot}
              onDownload={onDownloadSlot}
              onTogglePin={onTogglePinSlot}
            />
          </div>
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
            Autosave: {autosaveAvailable ? 'on' : 'disabled (file:// origin)'}
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
