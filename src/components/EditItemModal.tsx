import { useEffect, useRef, useState } from 'react';
import type { Item } from '../lib/types';

interface Props {
  item: Item;
  onCancel: () => void;
  onSave: (patch: { label?: string; url?: string; imageUrl?: string }) => void;
}

/**
 * In-place metadata editor for a single item. Driving use-case: a pasted
 * list whose label contains a comma gets mis-parsed by the CSV path
 * (`"Foo, Inc, https://example.com"` → label=`"Foo"`, url=`" Inc"`,
 * imageUrl=`"https://example.com"`). The user wants to fix the
 * affected item without starting the sort over.
 *
 * Only `label / url / imageUrl` are editable — the item's internal `id`
 * (canonical slug) is intentionally NOT recomputed from the new label,
 * since the id is referenced by every sort-state collection (queue,
 * sorted, hidden, unplaced, pending, etc.). Keeping it stable means a
 * rename is a strict in-place patch with no structural risk.
 *
 * URL / Image URL fields treat an empty string as "clear it" — this is
 * how the user removes a bogus URL that came from the comma split.
 */
export function EditItemModal({ item, onCancel, onSave }: Props) {
  const [label, setLabel] = useState(item.label);
  const [url, setUrl] = useState(item.url ?? '');
  const [imageUrl, setImageUrl] = useState(item.imageUrl ?? '');
  const labelRef = useRef<HTMLInputElement | null>(null);

  // Autofocus the label and select its contents so the most common edit
  // (overwriting a mis-parsed label) is one keystroke.
  useEffect(() => {
    labelRef.current?.focus();
    labelRef.current?.select();
  }, []);

  const trimmedLabel = label.trim();
  const canSave = trimmedLabel.length > 0 && (
    trimmedLabel !== item.label ||
    url.trim() !== (item.url ?? '') ||
    imageUrl.trim() !== (item.imageUrl ?? '')
  );

  function commit(): void {
    if (!canSave) return;
    onSave({
      label: trimmedLabel,
      url: url.trim(),
      imageUrl: imageUrl.trim(),
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    // Enter on any field commits the form so the user doesn't have to
    // reach for the mouse on a single-field fix.
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Edit item</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 0 }}>
          Fix a mis-parsed label, URL, or image. The item&rsquo;s position
          in the sort is preserved. Leave URL or Image URL blank to clear.
        </p>
        <div className="edit-item-form">
          <label className="edit-item-field">
            <span className="edit-item-label">Label</span>
            <input
              ref={labelRef}
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Item name"
            />
          </label>
          <label className="edit-item-field">
            <span className="edit-item-label">URL</span>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="https://… (optional)"
            />
          </label>
          <label className="edit-item-field">
            <span className="edit-item-label">Image URL</span>
            <input
              type="text"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="https://… (optional)"
            />
          </label>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={commit}
            disabled={!canSave}
            title={
              !canSave
                ? trimmedLabel.length === 0
                  ? 'Label cannot be blank'
                  : 'No changes to save'
                : 'Save changes'
            }
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
