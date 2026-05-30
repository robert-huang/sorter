import { useState } from 'react';
import { derivedSlotName } from '../lib/completedSortEditH';
import { Modal } from './Modal';

interface Props {
  itemCount: number;
  slotName: string;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}

/**
 * Confirm for the RESULT-tab "Start over" button. Always mints a new slot;
 * the current completed slot is left untouched.
 */
export function StartOverConfirmModal({
  itemCount,
  slotName,
  onConfirm,
  onCancel,
}: Props) {
  const [dontAsk, setDontAsk] = useState(false);
  const newSlotName = derivedSlotName(slotName, 'redo');

  return (
    <Modal label="Start over confirmation" onClose={onCancel}>
      <h3>Start over in a new slot?</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        Creates <strong>&ldquo;{newSlotName}&rdquo;</strong> with your{' '}
        {itemCount} ranked item{itemCount === 1 ? '' : 's'} as singletons and
        runs a fresh merge from the top. Items keep their cards (labels, links,
        images); only the comparison history starts empty.
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        <strong>&ldquo;{slotName}&rdquo; stays finished.</strong> It remains in
        the gear-menu list with its full sort and undo history — you can open it
        any time. To remove it, use &ldquo;Delete this slot&rdquo; in the gear menu.
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        <strong>Removed items don&rsquo;t come along.</strong> Anything you hid
        during the previous sort (or left in the To-be-inserted bucket) stays in
        the old slot and isn&rsquo;t seeded into the new one.
      </p>
      <div className="checkbox-row">
        <input
          id="dont-ask-start-over"
          type="checkbox"
          checked={dontAsk}
          onChange={(e) => setDontAsk(e.target.checked)}
        />
        <label htmlFor="dont-ask-start-over">Don&rsquo;t ask again</label>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => onConfirm(dontAsk)}>
          Create new slot
        </button>
      </div>
    </Modal>
  );
}
