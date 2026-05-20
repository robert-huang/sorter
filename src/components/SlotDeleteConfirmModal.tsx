import { useState } from 'react';
import { Modal } from './Modal';

interface Props {
  slotName: string;
  /**
   * True when the slot has an established cloud binding. Switches the
   * modal to the two-button variant — "Remove from device" (keeps the
   * cloud copy) vs "Delete everywhere" (also wipes the cloud copy).
   *
   * When false (most slots), the original single-button confirm is
   * shown, complete with the "Don't ask again" preference for users
   * who want to skip the prompt entirely.
   */
  hasCloudCopy: boolean;
  /**
   * Local-only delete. Called for the non-cloud variant (carrying the
   * dontAskAgain flag the user ticked) AND for the "Remove from
   * device" button in the cloud-aware variant (dontAskAgain always
   * false; the choice between local-only and everywhere should remain
   * explicit so we don't accidentally start nuking cloud copies).
   */
  onConfirmLocalOnly: (dontAskAgain: boolean) => void;
  /**
   * Cloud-aware "delete everywhere" path. Only invoked from the
   * cloud-aware variant of the modal. The caller is responsible for
   * ordering the cloud-side delete before the local delete (so a
   * cloud failure can be surfaced without orphaning the local slot).
   */
  onConfirmEverywhere: () => void;
  onCancel: () => void;
}

/**
 * Slot-delete confirmation. Two variants:
 *
 *  - No cloud copy: single "Delete slot" button + "Don't ask again"
 *    checkbox. Same UX as pre-tier-0b — this is the common case.
 *  - Cloud copy present: three buttons (Cancel / Remove from device /
 *    Delete everywhere). The "Don't ask again" checkbox is hidden in
 *    this variant: cloud-vs-not deletion is a deliberate choice every
 *    time, never a default-on shortcut.
 */
export function SlotDeleteConfirmModal({
  slotName,
  hasCloudCopy,
  onConfirmLocalOnly,
  onConfirmEverywhere,
  onCancel,
}: Props) {
  const [dontAsk, setDontAsk] = useState(false);
  if (hasCloudCopy) {
    return (
      <Modal label={`Delete slot "${slotName}" confirmation`} onClose={onCancel}>
        <h3>Delete &ldquo;{slotName}&rdquo;?</h3>
        <p style={{ color: 'var(--text-muted)' }}>
          This slot is also backed up to your cloud folder.
        </p>
        <ul style={{ color: 'var(--text-muted)', paddingLeft: '1.25em' }}>
          <li>
            <strong>Remove from device</strong> deletes the slot from this
            browser. The cloud copy stays in your Drive folder &mdash; you can
            Pull it back from the cloud library later.
          </li>
          <li>
            <strong>Delete everywhere</strong> also wipes the cloud copy. The
            cloud copy is gone for good (Drive&rsquo;s trash counts).
          </li>
        </ul>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" onClick={() => onConfirmLocalOnly(false)}>
            Remove from device
          </button>
          <button className="btn danger" onClick={onConfirmEverywhere}>
            Delete everywhere
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal label={`Delete slot "${slotName}" confirmation`} onClose={onCancel}>
      <h3>Delete &ldquo;{slotName}&rdquo;?</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        This deletes the slot, including its autosave and undo history. Your
        other slots are unaffected, and any JSON files you downloaded are also
        unaffected.
      </p>
      <div className="checkbox-row">
        <input
          id="dont-ask-delete-slot"
          type="checkbox"
          checked={dontAsk}
          onChange={(e) => setDontAsk(e.target.checked)}
        />
        <label htmlFor="dont-ask-delete-slot">Don&rsquo;t ask again</label>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn danger" onClick={() => onConfirmLocalOnly(dontAsk)}>
          Delete slot
        </button>
      </div>
    </Modal>
  );
}
