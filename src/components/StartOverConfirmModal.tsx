import { useState } from 'react';

interface Props {
  itemCount: number;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}

/**
 * Confirm for the RESULT-tab "Start over" button. Distinct from
 * SlotDeleteConfirmModal because the action is *not* destructive — it
 * mints a brand-new slot seeded from the current sort's final ranking
 * and switches to it. The current slot is preserved untouched in the
 * gear-menu slot list.
 *
 * Sharing the modal shell + the "Don't ask again" mechanic keeps the
 * UX consistent with the slot-delete confirm; the suppression key
 * (`suppressStartOverConfirm`) is its own setting so opting out of one
 * confirm doesn't silently opt out of the other.
 */
export function StartOverConfirmModal({ itemCount, onConfirm, onCancel }: Props) {
  const [dontAsk, setDontAsk] = useState(false);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Start over from scratch?</h3>
        <p style={{ color: 'var(--text-muted)' }}>
          This mints a <strong>new slot</strong> seeded with your{' '}
          {itemCount} ranked item{itemCount === 1 ? '' : 's'} as singletons
          and runs a fresh merge sort from the top. Items keep their cards
          (labels, links, images); only the comparison history starts
          empty.
        </p>
        <p style={{ color: 'var(--text-muted)' }}>
          <strong>Your current slot is preserved.</strong> It stays in the
          gear-menu slot list with its full sort and undo history &mdash;
          you can resume it any time. To remove it, use &ldquo;Delete this
          slot&rdquo; in the gear menu.
        </p>
        <p style={{ color: 'var(--text-muted)' }}>
          <strong>Removed items don&rsquo;t come along.</strong> Anything
          you hid during the previous sort (or left in the To-be-inserted
          bucket) stays in the old slot and isn&rsquo;t seeded into the
          new one.
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
          <button
            className="btn danger"
            onClick={() => onConfirm(dontAsk)}
          >
            Start over
          </button>
        </div>
      </div>
    </div>
  );
}
