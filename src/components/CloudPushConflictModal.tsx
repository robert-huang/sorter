import { Modal } from './Modal';

interface Props {
  slotName: string;
  onCancel: () => void;
  /** Push again without the expectedEtag precondition (overwrite). */
  onPushAnyway: () => void;
}

/**
 * Surfaced when `pushSlot` rejects with `CloudEtagMismatchError` — the
 * cloud copy was modified somewhere else (another device, the user's
 * Drive UI, a third device pushing in between) since this device last
 * pulled or pushed.
 *
 * Locked decision: no merge UI in tier 0b. The user either cancels
 * (and presumably opens the cloud library to Pull the newer version
 * first) or pushes anyway, which overwrites the cloud copy with the
 * local one. Cloud is "source of truth" only in the steady-state
 * single-device sense; the warning is the one safety against silently
 * losing another device's edits.
 */
export function CloudPushConflictModal({ slotName, onCancel, onPushAnyway }: Props) {
  return (
    <Modal label="Cloud push conflict" onClose={onCancel}>
      <h3>Cloud copy was changed elsewhere</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        <strong>{slotName}</strong>&rsquo;s cloud copy was modified after your last sync
        with this device &mdash; possibly by another device, or by editing the file in
        Drive&rsquo;s UI.
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        Pushing anyway will overwrite the cloud copy with your local version. To
        keep the other side&rsquo;s changes, cancel and Pull this slot first.
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn danger" onClick={onPushAnyway}>
          Push anyway
        </button>
      </div>
    </Modal>
  );
}
