import type { SharedRanking } from '../lib/share';
import { Modal } from './Modal';

interface Props {
  payload: SharedRanking;
  /**
   * Called when the user opts to import the shared payload. App.tsx
   * branches on `payload.kind`: 'ranking' mints a slot pre-seeded as
   * a finished sort (via seedAsSorted), 'template' mints a fresh
   * unsorted slot the user will then rank themselves (via initSort).
   */
  onImport: (payload: SharedRanking) => void;
  /**
   * Called when the user dismisses the modal without importing. App.tsx
   * still clears the `#share=...` fragment so a refresh doesn't re-prompt.
   */
  onDismiss: () => void;
}

/**
 * Recipient overlay for an inbound share link. Shows the sender's
 * payload as a preview list (numbered for rankings, unnumbered for
 * templates), plus an Import button that mints a new slot.
 *
 * Why a preview before importing: the link is opaque to the recipient
 * until they decode it. Surfacing the list lets the user confirm "yep,
 * that's what I expected" before adding a slot to their browser —
 * particularly important if they hit slot-cap and need to evict
 * something to make room.
 *
 * Kind branching:
 *  - 'ranking'  → "shared a ranking" heading, <ol> preview, primary
 *                 button "Import as new slot" (the legacy behavior).
 *  - 'template' → "shared a starting list" heading, <ul> preview,
 *                 primary button "Start sorting these items" (lands
 *                 on RANK, not RESULT).
 *
 * The body copy explains the consequence of each path so the user
 * understands they're either viewing someone else's result or
 * inheriting someone else's candidate set before producing their own.
 */
export function SharedImportModal({ payload, onImport, onDismiss }: Props) {
  const previewCount = Math.min(payload.items.length, 10);
  const remaining = payload.items.length - previewCount;
  const isTemplate = payload.kind === 'template';

  const heading = isTemplate
    ? 'Someone shared a starting list with you'
    : 'Someone shared a ranking with you';
  const bodyCopy = isTemplate
    ? 'Importing creates a new slot in your browser seeded with these items as a fresh sort. You decide the order — the sender did not include their ranking. Your existing slots aren\u2019t touched.'
    : 'Importing creates a new slot in your browser seeded with this ranking as a finished sort. You can re-rank, add items, or remove items from there. Your existing slots aren\u2019t touched.';
  const importLabel = isTemplate
    ? 'Start sorting these items'
    : 'Import as new slot';
  const modalLabel = isTemplate
    ? 'Imported shared list'
    : 'Imported shared ranking';

  // Render the preview using the right semantic list element. <ol> for
  // rankings (the numbers carry meaning), <ul> for templates (the
  // order is arbitrary; numbering would be misleading).
  const previewItems = payload.items.slice(0, previewCount).map((it) => (
    <li key={it.id}>
      <span className="shared-import-label">{it.label}</span>
      {it.url && (
        <a
          href={it.url}
          target="_blank"
          rel="noopener noreferrer"
          className="shared-import-link"
          title={it.url}
        >
          🔗
        </a>
      )}
    </li>
  ));
  const moreLi = remaining > 0 ? (
    <li className="shared-import-more">… and {remaining} more</li>
  ) : null;

  return (
    <Modal label={modalLabel} onClose={onDismiss} className="modal-wide">
      <h3>{heading}</h3>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0 }}>
        {bodyCopy}
      </p>
      <div className="shared-import-name">
        <strong>{payload.name}</strong>
        <span style={{ color: 'var(--text-muted)' }}>
          {' '}&mdash; {payload.items.length} item
          {payload.items.length === 1 ? '' : 's'}
        </span>
      </div>
      {isTemplate ? (
        <ul className="shared-import-preview shared-import-preview-template">
          {previewItems}
          {moreLi}
        </ul>
      ) : (
        <ol className="shared-import-preview">
          {previewItems}
          {moreLi}
        </ol>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onDismiss}>
          Dismiss
        </button>
        <button className="btn primary" onClick={() => onImport(payload)}>
          {importLabel}
        </button>
      </div>
    </Modal>
  );
}
