import { useEffect, useRef, useState } from 'react';
import { SlotList } from './SlotList';
import type { SlotsManifest } from '../lib/types';

interface Props {
  autosaveAvailable: boolean;
  onLoadFromFile: (file: File) => void;
  onReset: () => void;
  /** Disable the "Delete this slot" entry when there is no active slot. */
  hasActiveSlot: boolean;
  /** Slots manifest, rendered inline at the top of the menu. */
  manifest: SlotsManifest;
  /** Slot whose blob is loaded in memory now (null if none). */
  loadedSlotId: string | null;
  onSwitchSlot: (id: string) => void;
  onDeleteSlot: (id: string) => void;
  onRenameSlot: (id: string, name: string) => void;
  showEstimatedRemaining: boolean;
  onToggleShowEstimatedRemaining: () => void;
}

export function SettingsMenu({
  autosaveAvailable,
  onLoadFromFile,
  onReset,
  hasActiveSlot,
  manifest,
  loadedSlotId,
  onSwitchSlot,
  onDeleteSlot,
  onRenameSlot,
  showEstimatedRemaining,
  onToggleShowEstimatedRemaining,
}: Props) {
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
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
            />
          </div>
          <div className="settings-divider" />
          <button className="settings-item" onClick={onLoadClick}>
            Load save file…
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
    </div>
  );
}
