import { Modal } from './Modal';

interface Props {
  /** Total number of slots present in the archive (after envelope validation). */
  total: number;
  /**
   * How many archive slot ids do not match anything in the current
   * manifest. With `total - newCount` collisions, `merge` mode would
   * mint fresh ids for the colliders (the existing slots are kept).
   */
  newCount: number;
  /**
   * Filename (or generic label) shown in the heading so the user can
   * sanity-check they picked the right archive.
   */
  source: string;
  /**
   * True when the current manifest holds at least one slot. Hides the
   * "Replace everything" path when there's nothing to replace —
   * destructive button on an empty store is pointless noise.
   */
  hasExisting: boolean;
  /**
   * True when (`existing slot count` + `total`) would exceed `SLOT_CAP`.
   * Disables the Add-as-new (merge) button with an explanation since
   * importAllSlots would refuse the merge.
   */
  mergeWouldExceedCap: boolean;
  /** Maximum number of slots allowed; surfaced in the cap-exceeded message. */
  slotCap: number;
  onCancel: () => void;
  onMerge: () => void;
  onReplace: () => void;
}

/**
 * Pre-flight confirm for "Restore from backup…". Shown once the user
 * has picked a file and we've successfully parsed the envelope; we
 * intentionally don't gate this behind a per-blob validation pass
 * because surfacing "5 blobs were skipped" pre-import duplicates work
 * `importAllSlots` will redo anyway — the final toast (post-import)
 * is the authoritative tally.
 *
 * No "Don't ask again" — this is rare AND destructive (replace path),
 * so forcing a deliberate click each time is the right trade.
 */
export function BackupRestoreConfirmModal({
  total,
  newCount,
  source,
  hasExisting,
  mergeWouldExceedCap,
  slotCap,
  onCancel,
  onMerge,
  onReplace,
}: Props) {
  const collisions = Math.max(0, total - newCount);
  return (
    <Modal label="Restore from backup confirmation" onClose={onCancel}>
      <h3>Restore from backup</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        <strong>{source}</strong> contains{' '}
        <strong>
          {total} slot{total === 1 ? '' : 's'}
        </strong>
        {total > 0 && (
          <>
            {' '}
            ({newCount} new, {collisions} already present)
          </>
        )}
        .
      </p>
      <ul style={{ color: 'var(--text-muted)', paddingLeft: '1.25em' }}>
        <li>
          <strong>Add as new</strong> keeps everything you already have and
          appends the backup&rsquo;s slots. Any id collisions get fresh ids
          (no clobbering).
        </li>
        {hasExisting && (
          <li>
            <strong>Replace everything</strong> deletes every slot currently
            in your browser, then writes the backup. Use this when restoring
            onto a fresh machine or after clearing browser data.
          </li>
        )}
      </ul>
      {mergeWouldExceedCap && (
        <p style={{ color: 'var(--text-danger)' }}>
          Adding {total} slot{total === 1 ? '' : 's'} would exceed the {slotCap}-slot
          cap. Delete some slots first, or use <em>Replace everything</em>.
        </p>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn primary"
          onClick={onMerge}
          disabled={total === 0 || mergeWouldExceedCap}
          title={
            mergeWouldExceedCap
              ? `Would exceed the ${slotCap}-slot cap`
              : 'Add the backup\u2019s slots alongside your existing ones'
          }
        >
          Add as new
        </button>
        {hasExisting && (
          <button
            className="btn danger"
            onClick={onReplace}
            disabled={total === 0}
            title="Delete every existing slot and write the backup"
          >
            Replace everything
          </button>
        )}
      </div>
    </Modal>
  );
}
