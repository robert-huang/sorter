import { useState } from 'react';
import type { Item } from '../lib/types';
import { canonicalKey } from '../lib/csv';

interface Props {
  existingIds: Set<string>;
  onCancel: () => void;
  onAdd: (item: Item) => void;
}

export function AddItemModal({ existingIds, onCancel, onAdd }: Props) {
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) {
      setError('Label is required.');
      return;
    }
    const id = canonicalKey(trimmed);
    if (existingIds.has(id)) {
      setError('An item with this label is already in the sort.');
      return;
    }
    onAdd({
      id,
      label: trimmed,
      url: url.trim() || undefined,
      imageUrl: imageUrl.trim() || undefined,
    });
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={onSubmit}
      >
        <h3>Add item</h3>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0 }}>
          New item is appended to the back of the queue and merged into the
          existing ranking.
        </p>
        <div className="form-row">
          <label htmlFor="add-label">Label *</label>
          <input
            id="add-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoFocus
          />
        </div>
        <div className="form-row">
          <label htmlFor="add-url">URL (optional)</label>
          <input
            id="add-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
          />
        </div>
        <div className="form-row">
          <label htmlFor="add-image">Image URL (optional)</label>
          <input
            id="add-image"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://…"
          />
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Add
          </button>
        </div>
      </form>
    </div>
  );
}
