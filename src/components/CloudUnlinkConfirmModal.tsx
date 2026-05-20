import { Modal } from './Modal';

interface Props {
  slotName: string;
  onCancel: () => void;
  /**
   * Proceed with unlinking: deletes the cloud copy and clears the
   * slot's cloudId binding. Local copy is preserved.
   */
  onConfirm: () => void;
}

/**
 * Surfaced when the user clicks the cloud-icon toggle on a slot that
 * has an established cloud binding (cloudId set). Opting out is
 * destructive — `onCloudToggleOptInSlot` deletes the corresponding
 * Drive file — and a stray click on the icon could otherwise nuke a
 * push you wanted to keep, with no obvious recovery (Drive's Trash
 * does keep the file for 30 days, but pulling it back from there is
 * a manual chore in Drive's own UI).
 *
 * Sibling to `SlotDeleteConfirmModal` but semantically distinct:
 * "remove from cloud" preserves the local slot, while delete-modal
 * variants are about removing the slot itself.
 */
export function CloudUnlinkConfirmModal({ slotName, onCancel, onConfirm }: Props) {
  return (
    <Modal label="Unlink slot from cloud confirmation" onClose={onCancel}>
      <h3>Stop backing up &ldquo;{slotName}&rdquo; to cloud?</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        This deletes <strong>{slotName}</strong>&rsquo;s cloud copy from your Drive
        folder. The local slot stays put &mdash; you can re-enable cloud backup
        for it later, which will create a fresh cloud copy.
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        Drive&rsquo;s Trash holds the deleted file for 30 days if you change
        your mind, but pulling it back into the app afterwards is a manual
        chore.
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn danger" onClick={onConfirm}>
          Unlink and delete cloud copy
        </button>
      </div>
    </Modal>
  );
}
