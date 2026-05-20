import { useState } from 'react';
import { Modal } from './Modal';

interface Props {
  slotName: string;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}

export function SlotDeleteConfirmModal({ slotName, onConfirm, onCancel }: Props) {
  const [dontAsk, setDontAsk] = useState(false);
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
        <button
          className="btn danger"
          onClick={() => onConfirm(dontAsk)}
        >
          Delete slot
        </button>
      </div>
    </Modal>
  );
}
