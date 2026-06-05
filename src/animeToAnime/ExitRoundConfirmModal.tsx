import { Modal } from '../components/Modal';

interface Props {
  onConfirm: () => void;
  onCancel: () => void;
}

export function ExitRoundConfirmModal({ onConfirm, onCancel }: Props) {
  return (
    <Modal label="Leave round confirmation" onClose={onCancel}>
      <h3>Leave this round?</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        Return to setup? Your progress on this round will be lost.
      </p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={onConfirm}>
          Return to setup
        </button>
      </div>
    </Modal>
  );
}
