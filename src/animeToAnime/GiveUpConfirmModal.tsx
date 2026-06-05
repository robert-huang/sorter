import { Modal } from '../components/Modal';

interface Props {
  onConfirm: () => void;
  onCancel: () => void;
}

export function GiveUpConfirmModal({ onConfirm, onCancel }: Props) {
  return (
    <Modal label="Give up confirmation" onClose={onCancel}>
      <h3>Give up this round?</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        End the round and see whether a shorter path exists in your local cache.
      </p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Keep playing
        </button>
        <button type="button" className="btn primary" onClick={onConfirm}>
          Give up
        </button>
      </div>
    </Modal>
  );
}
