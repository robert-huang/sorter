import type { SlotMeta } from '../lib/types';
import { SLOT_CAP } from '../lib/storage';

interface Props {
  /** The slot that will be silently evicted to make room. */
  victim: SlotMeta;
  onCancel: () => void;
  /** Download a JSON copy of `victim`, then continue with the mint. */
  onDownloadThenContinue: () => void;
  /** Continue with the mint and evict `victim`. */
  onContinue: () => void;
}

/**
 * "Don't ask again" is intentionally omitted here — eviction is
 * destructive (the slot's blob is deleted from localStorage) and the
 * cap is high enough (30) that the average user will hit this rarely.
 * Forcing a deliberate click each time is the right trade.
 *
 * The "Download oldest first" button is the natural escape hatch when
 * the user doesn't want to lose the victim: it triggers a JSON download
 * of the victim and *then* continues with the mint in one click. The
 * per-row download buttons in the gear menu serve the same purpose
 * proactively (you can back any slot up before hitting the cap).
 */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'moments ago';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return iso.slice(0, 10);
}

export function SlotCapConfirmModal({
  victim,
  onCancel,
  onDownloadThenContinue,
  onContinue,
}: Props) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Slot storage is full</h3>
        <p style={{ color: 'var(--text-muted)' }}>
          Your browser is holding the maximum of <strong>{SLOT_CAP} saved
          sorts</strong>. To make room for a new one, the least-recently-used
          slot will be deleted:
        </p>
        <p style={{ color: 'var(--text)', fontWeight: 500 }}>
          &ldquo;{victim.name}&rdquo;{' '}
          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
            &mdash; {victim.totalItems} item{victim.totalItems === 1 ? '' : 's'},
            last touched {relativeTime(victim.updatedAt)}
          </span>
        </p>
        <p style={{ color: 'var(--text-muted)' }}>
          Once deleted, the slot&rsquo;s sort and undo history are gone &mdash;
          but any JSON file you downloaded for it is unaffected. Tip: open the
          gear menu beforehand to download a backup of any slot.
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn" onClick={onDownloadThenContinue}>
            Download oldest first
          </button>
          <button className="btn danger" onClick={onContinue}>
            Delete oldest &amp; continue
          </button>
        </div>
      </div>
    </div>
  );
}
