import { Modal } from './Modal';

interface Props {
  slotName: string;
  onCancel: () => void;
  /**
   * Clear the slot's cloud binding while leaving the Drive file in place.
   */
  onConfirmKeepCloud: () => void;
  /**
   * Move the Drive file to Trash, then clear the slot's cloud binding.
   */
  onConfirmTrashCloud: () => void;
}

/**
 * Surfaced when the user clicks the cloud-icon toggle on a slot that
 * has an established cloud binding (cloudId set). The user can unlink
 * while preserving the Drive file, or move that file to Drive's Trash.
 *
 * Sibling to `SlotDeleteConfirmModal` but semantically distinct:
 * "remove from cloud" preserves the local slot, while delete-modal
 * variants are about removing the slot itself.
 */
export function CloudUnlinkConfirmModal({
  slotName,
  onCancel,
  onConfirmKeepCloud,
  onConfirmTrashCloud,
}: Props) {
  return (
    <Modal label="Unlink slot from cloud confirmation" onClose={onCancel}>
      <h3>Stop backing up &ldquo;{slotName}&rdquo; to cloud?</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        The local slot stays on this device either way.
      </p>
      <ul style={{ color: 'var(--text-muted)', paddingLeft: '1.25em' }}>
        <li>
          <strong>Unlink only</strong> leaves the cloud copy in your Drive
          folder. You can Pull it from the cloud library later.
        </li>
        <li>
          <strong>Unlink and move to Trash</strong> removes the cloud copy from
          the folder. Drive keeps it in Trash for up to 30 days.
        </li>
      </ul>
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn" onClick={onConfirmKeepCloud}>
          Unlink only
        </button>
        <button className="btn danger" onClick={onConfirmTrashCloud}>
          Unlink and move to Trash
        </button>
      </div>
    </Modal>
  );
}
