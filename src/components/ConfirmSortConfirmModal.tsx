import { derivedSlotName } from '../lib/completedSortEditH';
import { Modal } from './Modal';

interface Props {
  itemCount: number;
  slotName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirm for the RESULT-tab "Confirm sort" button. The completed source
 * slot stays untouched while a confirmation-engine slot verifies its ranking.
 */
export function ConfirmSortConfirmModal({
  itemCount,
  slotName,
  onConfirm,
  onCancel,
}: Props) {
  const newSlotName = derivedSlotName(slotName, 'confirm');

  return (
    <Modal label="Confirm sort confirmation" onClose={onCancel}>
      <h3>Confirm this ranking in a new slot?</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        Creates <strong>&ldquo;{newSlotName}&rdquo;</strong> with the{' '}
        {itemCount} ranked item{itemCount === 1 ? '' : 's'} in their current
        order.
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        The confirmation sort checks the ranking from top to bottom. Items that
        still fit are confirmed with one comparison; misplaced items are
        binary-inserted into the confirmed prefix.
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        <strong>&ldquo;{slotName}&rdquo; stays finished.</strong> Hidden and
        uninserted items are not copied into the confirmation slot.
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" onClick={onConfirm}>
          Create confirmation slot
        </button>
      </div>
    </Modal>
  );
}
