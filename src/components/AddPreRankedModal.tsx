import { useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import { looksLikeHeader, parseCsvRows, parseSources } from '../lib/csv';
import type { Item } from '../lib/types';

interface Props {
  onCancel: () => void;
  onAppend: (items: Item[]) => void;
}

export function AddPreRankedModal({ onCancel, onAppend }: Props) {
  const [text, setText] = useState('');
  const [skipHeader, setSkipHeader] = useState(false);
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
      skipEmptyLines: 'greedy',
      preview: 1,
    });
    const first = parsed.data?.[0];
    return Array.isArray(first) ? looksLikeHeader(first) : false;
  }, [text]);

  const result = useMemo(() => {
    if (!text.trim()) return { items: [] as Item[] };
    const rows = parseCsvRows(text, 'pre-ranked list', skipHeader);
    const r = parseSources([
      {
        sourceName: 'pre-ranked list',
        rawRows: rows.rows,
        detectedHeader: rows.detectedHeader,
      },
    ]);
    return { items: r.items };
  }, [text, skipHeader]);

  function onSubmit(): void {
    if (result.items.length === 0) return;
    onAppend(result.items);
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Add pre-ranked list</h3>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0 }}>
          Paste a CSV or upload a file. Row order is the sorted order. The new
          sublist is appended to the back of the queue. Items already in your
          sort (by label) are skipped.
        </p>
        <textarea
          className="csv-textarea"
          placeholder={`Inception, https://…\nHeat\nThe Matrix`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn" onClick={() => fileRef.current?.click()}>
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
            id="appended-header"
            type="checkbox"
            checked={skipHeader}
            onChange={(e) => setSkipHeader(e.target.checked)}
          />
          <label htmlFor="appended-header">First row is a header</label>
          {detectedHeader && !skipHeader && (
            <span className="header-hint">
              ⓘ Looks like a header. Check to skip.
            </span>
          )}
        </div>
        <div
          style={{
            marginTop: 12,
            fontSize: 13,
            color: 'var(--text-muted)',
          }}
        >
          {result.items.length === 0
            ? 'No items parsed yet.'
            : `Parsed ${result.items.length} item${result.items.length === 1 ? '' : 's'}.`}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={onSubmit}
            disabled={result.items.length === 0}
          >
            Append
          </button>
        </div>
      </div>
    </div>
  );
}
