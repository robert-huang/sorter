import { useState } from 'react';
import type { Item, SortState } from '../lib/types';
import { comparisonsRemaining, getRanking } from '../lib/engine';
import { AddPreRankedModal } from './AddPreRankedModal';

interface Props {
  state: SortState;
  onUnhide: (id: string) => void;
  /**
   * Start over from scratch: re-init the sort with the same items but
   * no comparison history. Shows a confirm modal in App.tsx (unless the
   * user opted out of it). Distinct from "Delete this slot" — items
   * survive, only the ranking work is discarded.
   */
  onStartOver: () => void;
  /**
   * Batch-add items to the current sort, engine-aware. On insertion
   * engine: appends to pending. On merge engine, not-done: appends a
   * pre-ranked sublist. On merge engine, done: triggers the
   * merge→insertion engine transition (which App.tsx confirms via modal).
   */
  onAddItems: (items: Item[]) => void;
}

function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function buildCsv(items: Item[]): string {
  const escape = (v: string | undefined): string => {
    if (v === undefined) return '';
    if (/[",\n]/.test(v)) {
      return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
  };
  return items
    .map((it) => `${escape(it.label)},${escape(it.url)},${escape(it.imageUrl)}`)
    .join('\n');
}

function downloadText(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ResultScreen({ state, onUnhide, onStartOver, onAddItems }: Props) {
  const [copied, setCopied] = useState<'csv' | 'md' | 'txt' | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  if (!state.done) {
    return (
      <div className="page">
        <div className="page-section" style={{ textAlign: 'center' }}>
          <h2>Sort not finished yet</h2>
          <p style={{ color: 'var(--text-muted)' }}>
            {comparisonsRemaining(state)} comparisons left · {state.comparisons}{' '}
            comparison{state.comparisons === 1 ? '' : 's'} made
          </p>
        </div>
      </div>
    );
  }

  const ranking = getRanking(state)
    .map((id) => state.items[id])
    .filter(Boolean);
  const hiddenItems = state.hidden
    .map((id) => state.items[id])
    .filter(Boolean);

  const md = ranking.map((it, i) => `${i + 1}. ${it.label}`).join('\n');
  const txt = ranking.map((it) => it.label).join('\n');
  const csv = buildCsv(ranking);

  async function copy(value: string, label: 'csv' | 'md' | 'txt'): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  }

  return (
    <div className="page">
      <div className="page-section">
        <div className="result-header">
          <h2>Final ranking</h2>
          <div className="result-export">
            <button
              className="btn"
              onClick={() =>
                downloadText(csv, `sorter-ranking.csv`, 'text/csv')
              }
            >
              Download CSV
            </button>
            <button className="btn" onClick={() => copy(md, 'md')}>
              {copied === 'md' ? '✓ Copied' : 'Copy as Markdown'}
            </button>
            <button className="btn" onClick={() => copy(txt, 'txt')}>
              {copied === 'txt' ? '✓ Copied' : 'Copy as plain text'}
            </button>
            <button className="btn" onClick={() => copy(csv, 'csv')}>
              {copied === 'csv' ? '✓ Copied' : 'Copy as CSV'}
            </button>
          </div>
        </div>
        <ol className="result-list">
          {ranking.map((it, i) => (
            <li key={it.id} className="result-row">
              <div className="rank-num">{i + 1}</div>
              <div className="image-wrap">
                {it.imageUrl ? (
                  <img src={it.imageUrl} alt="" />
                ) : (
                  <div className="placeholder">{initials(it.label)}</div>
                )}
              </div>
              <div className="label-cell">{it.label}</div>
              <div>
                {it.url && (
                  <a
                    href={it.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={it.url}
                  >
                    🔗
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {hiddenItems.length > 0 && (
        <div className="page-section">
          <button
            className="result-hidden-toggle"
            onClick={() => setShowHidden((v) => !v)}
          >
            {showHidden ? '▾' : '▸'} {hiddenItems.length} item
            {hiddenItems.length === 1 ? '' : 's'} were removed during sorting
          </button>
          {showHidden && (
            <ul className="result-list" style={{ marginTop: 8 }}>
              {hiddenItems.map((it) => (
                <li key={it.id} className="result-row">
                  <div className="rank-num" style={{ color: 'var(--text-faint)' }}>
                    —
                  </div>
                  <div className="image-wrap">
                    {it.imageUrl ? (
                      <img src={it.imageUrl} alt="" />
                    ) : (
                      <div className="placeholder">{initials(it.label)}</div>
                    )}
                  </div>
                  <div className="label-cell" style={{ textDecoration: 'line-through' }}>
                    {it.label}
                  </div>
                  <button className="btn" onClick={() => onUnhide(it.id)}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="result-bottom">
        <button className="btn" onClick={() => setAddOpen(true)}>
          + Add items
        </button>
        <button
          className="btn danger"
          onClick={onStartOver}
          title="Discard all comparisons and re-queue the items as a fresh sort. Items keep their cards. Undoable."
        >
          Start over
        </button>
      </div>

      {addOpen && (
        <AddPreRankedModal
          onCancel={() => setAddOpen(false)}
          onAppend={(items) => {
            onAddItems(items);
            setAddOpen(false);
          }}
        />
      )}
    </div>
  );
}
