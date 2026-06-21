import { useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import type { Item } from '../lib/types';
import {
  canonicalKey,
  looksLikeHeader,
  parseCsvRows,
  parseSources,
  PAPA_COMMA_CSV_OPTIONS,
} from '../lib/csv';
import { Modal } from './Modal';

/**
 * Unified "Add item(s)" modal. Two tabs:
 *  - "Single"  — label + URL + image fields (one item).
 *  - "Multiple" — CSV paste + file upload (N items at once).
 *
 * On the merge engine, the Multiple tab also offers a checkbox:
 *  "Treat as one pre-ranked sublist". When checked, the items append as
 *  ONE ranked sublist to the back of the queue (route to onAppendPreRanked).
 *  When unchecked, each item becomes its own singleton sublist
 *  (route to onAddMany). On the insertion engine the checkbox is hidden
 *  because there is no pre-ranked concept — pending is FIFO either way.
 */
type Tab = 'single' | 'multiple';

interface Props {
  engine: 'merge' | 'insertion';
  existingIds: Set<string>;
  onCancel: () => void;
  /** Single tab → add one item (skipped automatically if id collides). */
  onAddOne: (item: Item) => void;
  /** Multiple tab, unranked → each item becomes its own singleton. */
  onAddMany: (items: Item[]) => void;
  /**
   * Multiple tab, "treat as pre-ranked sublist" checked. Merge engine only;
   * may be omitted when the modal opens on the insertion engine.
   */
  onAddPreRanked?: (items: Item[]) => void;
}

export function AddItemsModal({
  engine,
  existingIds,
  onCancel,
  onAddOne,
  onAddMany,
  onAddPreRanked,
}: Props) {
  const [tab, setTab] = useState<Tab>('single');

  return (
    <Modal
      label={`Add item${tab === 'multiple' ? 's' : ''}`}
      onClose={onCancel}
      className="modal-wide"
    >
      <h3>Add item{tab === 'multiple' ? 's' : ''}</h3>
      <div className="modal-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'single'}
          className={`modal-tab${tab === 'single' ? ' active' : ''}`}
          onClick={() => setTab('single')}
        >
          Single
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'multiple'}
          className={`modal-tab${tab === 'multiple' ? ' active' : ''}`}
          onClick={() => setTab('multiple')}
        >
          Multiple
        </button>
      </div>

      {tab === 'single' && (
        <SingleTab
          existingIds={existingIds}
          engine={engine}
          onCancel={onCancel}
          onAdd={onAddOne}
        />
      )}
      {tab === 'multiple' && (
        <MultipleTab
          engine={engine}
          onCancel={onCancel}
          onAddMany={onAddMany}
          onAddPreRanked={onAddPreRanked}
        />
      )}
    </Modal>
  );
}

// ============================================================================
// Single tab — same form as the legacy AddItemModal
// ============================================================================

function SingleTab({
  existingIds,
  engine,
  onCancel,
  onAdd,
}: {
  existingIds: Set<string>;
  engine: 'merge' | 'insertion';
  onCancel: () => void;
  onAdd: (item: Item) => void;
}) {
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

  const hint =
    engine === 'insertion'
      ? 'New item is appended to the pending list and binary-inserted into the ranking.'
      : 'New item is appended to the back of the queue and merged into the existing ranking.';

  return (
    <form onSubmit={onSubmit}>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0 }}>
        {hint}
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
  );
}

// ============================================================================
// Multiple tab — CSV paste / file, optional "preserve order as one sublist"
// ============================================================================

function MultipleTab({
  engine,
  onCancel,
  onAddMany,
  onAddPreRanked,
}: {
  engine: 'merge' | 'insertion';
  onCancel: () => void;
  onAddMany: (items: Item[]) => void;
  onAddPreRanked?: (items: Item[]) => void;
}) {
  const [text, setText] = useState('');
  const [skipHeader, setSkipHeader] = useState(false);
  // Merge-engine only: when checked, send the items through the
  // pre-ranked path (one sublist preserving order); when unchecked,
  // they go through addItems (N singletons). For insertion engine,
  // pending is FIFO either way so the checkbox is hidden.
  const [asPreRanked, setAsPreRanked] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((t) => setText(t));
    e.target.value = '';
  }

  const detectedHeader = useMemo(() => {
    if (!text.trim()) return false;
    const parsed = Papa.parse<string[]>(text, {
      ...PAPA_COMMA_CSV_OPTIONS,
      preview: 1,
    });
    const first = parsed.data?.[0];
    return Array.isArray(first) ? looksLikeHeader(first) : false;
  }, [text]);

  const parsed = useMemo(() => {
    if (!text.trim()) return { items: [] as Item[] };
    const rows = parseCsvRows(text, 'add items', skipHeader);
    const r = parseSources([
      {
        sourceName: 'add items',
        rawRows: rows.rows,
        detectedHeader: rows.detectedHeader,
      },
    ]);
    return { items: r.items };
  }, [text, skipHeader]);

  function onSubmit(): void {
    if (parsed.items.length === 0) return;
    if (engine === 'merge' && asPreRanked && onAddPreRanked) {
      onAddPreRanked(parsed.items);
    } else {
      onAddMany(parsed.items);
    }
  }

  // Submit-button caption mirrors what'll actually happen.
  const submitLabel = (() => {
    const n = parsed.items.length;
    if (n === 0) return 'Add items';
    if (engine === 'merge' && asPreRanked && onAddPreRanked) {
      return `Add ${n} as pre-ranked sublist`;
    }
    return `Add ${n} item${n === 1 ? '' : 's'}`;
  })();

  const showPreRankedCheckbox =
    engine === 'merge' && typeof onAddPreRanked === 'function';

  return (
    <>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0 }}>
        Paste a CSV or load a file. One item per row, format{' '}
        <code>ITEM, URL (optional), IMAGE (optional)</code>. Items already in
        the sort (by label) are skipped.
      </p>
      <textarea
        className="csv-textarea"
        placeholder={`Inception\nHeat\nThe Matrix`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          type="button"
          className="btn"
          onClick={() => fileRef.current?.click()}
        >
          Load CSV file…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          style={{ display: 'none' }}
          onChange={onFile}
        />
      </div>
      <div className="checkbox-row">
        <input
          id="multi-header"
          type="checkbox"
          checked={skipHeader}
          onChange={(e) => setSkipHeader(e.target.checked)}
        />
        <label htmlFor="multi-header">First row is a header</label>
        {detectedHeader && !skipHeader && (
          <span className="header-hint">
            ⓘ Looks like a header. Check to skip.
          </span>
        )}
      </div>

      {showPreRankedCheckbox && (
        <div className="checkbox-row">
          <input
            id="multi-preranked"
            type="checkbox"
            checked={asPreRanked}
            onChange={(e) => setAsPreRanked(e.target.checked)}
          />
          <label htmlFor="multi-preranked">
            Treat as one pre-ranked sublist (preserve order)
          </label>
          <span className="header-hint">
            {asPreRanked
              ? 'Items merge as a single sorted sublist at the back of the queue.'
              : 'Each item becomes its own singleton sublist.'}
          </span>
        </div>
      )}

      <div
        style={{
          marginTop: 12,
          fontSize: 13,
          color: 'var(--text-muted)',
        }}
      >
        {parsed.items.length === 0
          ? 'No items parsed yet.'
          : `Parsed ${parsed.items.length} item${parsed.items.length === 1 ? '' : 's'}.`}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={onSubmit}
          disabled={parsed.items.length === 0}
        >
          {submitLabel}
        </button>
      </div>
    </>
  );
}
