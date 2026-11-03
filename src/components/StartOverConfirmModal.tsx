import { useState } from 'react';
import { derivedSlotName } from '../lib/completedSortEditH';
import { Modal } from './Modal';

interface Props {
  itemCount: number;
  slotName: string;
  onConfirm: (dontAskAgain: boolean) => void;
  /** Restart in this slot, keeping the finished ranking as an older version. */
  onNewVersion: () => void;
  onCancel: () => void;
}

/**
 * Confirm for the RESULT-tab "Start over" button. The default mints a new slot
 * and leaves the current completed slot untouched; "New version"
 * restarts in place and keeps the finished ranking in the version history.
 */
export function StartOverConfirmModal({
  itemCount,
  slotName,
  onConfirm,
  onNewVersion,
  onCancel,
}: Props) {
  const [dontAsk, setDontAsk] = useState(false);
  const newSlotName = derivedSlotName(slotName, 'redo');

  return (
    <Modal label="Start over confirmation" onClose={onCancel}>
      <h3>Start over?</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        Re-sorts your {itemCount} ranked item{itemCount === 1 ? '' : 's'} as
        singletons and runs a fresh merge from the top. Items keep their cards
        (labels, links, images); only the comparison history starts empty.
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        <strong>Create new slot</strong> (recommended) starts &ldquo;{newSlotName}
        &rdquo; and leaves <strong>&ldquo;{slotName}&rdquo; finished</strong> in
        the gear-menu list with its full sort and undo history.
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        <strong>New version</strong> saves the current ranking to
        this slot&rsquo;s version history and restarts &ldquo;{slotName}&rdquo;
        in place. The new result becomes the next version when it finishes. The
        old ranking is kept as a version, not its comparisons; ↶ Undo can return
        to the finished sort.
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        <strong>Removed items don&rsquo;t come along.</strong> Anything you hid
        during the previous sort (or left in the To-be-inserted bucket) isn&rsquo;t
        seeded into the new sort.
      </p>
      <div className="checkbox-row">
        <input
          id="dont-ask-start-over"
          type="checkbox"
          checked={dontAsk}
          onChange={(e) => setDontAsk(e.target.checked)}
        />
        <label htmlFor="dont-ask-start-over">
          Don&rsquo;t ask again (always create new slot)
        </label>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn" onClick={onNewVersion}>
          New version
        </button>
        <button className="btn primary" onClick={() => onConfirm(dontAsk)}>
          Create new slot
        </button>
      </div>
    </Modal>
  );
}
