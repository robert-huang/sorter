import { useState, type ReactNode } from 'react';
import { derivedSlotName } from '../lib/completedSortEditH';
import type { CompletedSortEditAction } from '../lib/completedSortEditH';
import { completedSortEditItemCount } from '../lib/completedSortEditH';
import { Modal } from './Modal';

interface Props {
  slotName: string;
  action: CompletedSortEditAction;
  onModifyCurrent: () => void;
  onCreateNewSlot: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}

function describeAction(action: CompletedSortEditAction, itemCount: number): {
  title: string;
  detail: ReactNode;
} {
  const n = itemCount;
  const itemsPhrase = `${n} item${n === 1 ? '' : 's'}`;

  switch (action.kind) {
    case 'appendPreRanked':
      return {
        title: 'Add pre-ranked list to completed sort?',
        detail: (
          <>
            Adding {itemsPhrase} as one <strong>pre-ranked sublist</strong> resumes
            merge sorting against your existing ranking. Auto-insert only kicks in
            when the size heuristic says it is cheaper than a full merge.
          </>
        ),
      };
    case 'mergeToInsertion':
      return {
        title: 'Add items to completed sort?',
        detail: (
          <>
            Adding {itemsPhrase} to a completed merge sort switches the new slot to{' '}
            <strong>insertion mode</strong>: new items are binary-inserted into the
            frozen ranking. You can still nudge items in the sorted list or pull them
            back to re-insert.
          </>
        ),
      };
    case 'addOne':
    case 'addMany':
      return {
        title: 'Add items to completed sort?',
        detail: (
          <>
            Adding {itemsPhrase} queues new binary insertions into your frozen ranking.
          </>
        ),
      };
  }
}

/**
 * Shown before mutating a completed sort. Default path mints a new slot so the
 * finished ranking stays recoverable; modifying in place is secondary.
 */
export function CompletedSortEditConfirmModal({
  slotName,
  action,
  onModifyCurrent,
  onCreateNewSlot,
  onCancel,
}: Props) {
  const [dontAsk, setDontAsk] = useState(false);
  const itemCount = completedSortEditItemCount(action);
  const { title, detail } = describeAction(action, itemCount);
  const newSlotName = derivedSlotName(slotName, 'branch');

  return (
    <Modal label="Edit completed sort" onClose={onCancel}>
      <h3>{title}</h3>
      <p style={{ color: 'var(--text-muted)' }}>{detail}</p>
      <p style={{ color: 'var(--text-muted)' }}>
        <strong>Create new slot</strong> (recommended) keeps &ldquo;{slotName}
        &rdquo; finished as-is and continues in &ldquo;{newSlotName}&rdquo;.{' '}
        <strong>Modify this slot</strong> changes the completed slot in place; ↶
        Undo can back it out, but deleting a slot is easier than recovering a bad
        overwrite.
      </p>
      <div className="checkbox-row">
        <input
          id="dont-ask-completed-edit"
          type="checkbox"
          checked={dontAsk}
          onChange={(e) => setDontAsk(e.target.checked)}
        />
        <label htmlFor="dont-ask-completed-edit">
          Don&rsquo;t ask again (always create new slot)
        </label>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn" onClick={onModifyCurrent}>
          Modify this slot
        </button>
        <button
          className="btn primary"
          onClick={() => onCreateNewSlot(dontAsk)}
        >
          Create new slot
        </button>
      </div>
    </Modal>
  );
}
