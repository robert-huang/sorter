import { useMemo, useState } from 'react';
import type { Item, SortState } from '../lib/types';
import { comparisonsRemaining, getRanking } from '../lib/engine';
import { AddItemsModal } from './AddItemsModal';
import { ItemThumb } from './ItemThumb';
import { ShareLinkModal } from './ShareLinkModal';

interface Props {
  state: SortState;
  /**
   * Active slot's display name. Passed through to the share-link
   * payload so the recipient sees a meaningful default slot name
   * after import (instead of the generic "Shared sort" fallback).
   */
  slotName?: string;
  onUnhide: (id: string) => void;
  /**
   * Start over from scratch: re-init the sort with the same items but
   * no comparison history. Shows a confirm modal in App.tsx (unless the
   * user opted out of it). Distinct from deleting the slot — items
   * survive, only the ranking work is discarded.
   */
  onStartOver: () => void;
  /**
   * Add a single item via the AddItemsModal's Single tab. App.tsx
   * dispatches engine-aware: merge → singleton sublist (or transition
   * modal if merge is done); insertion → push to pending.
   */
  onAddOne: (item: Item) => void;
  /**
   * Add many items via the Multiple tab (pre-ranked checkbox unchecked).
   * Merge → N singleton sublists; insertion → push to pending FIFO;
   * completed sort → modify-vs-new-slot confirm (merge-done switches to
   * insertion mode when modifying the current slot).
   */
  onAddMany: (items: Item[]) => void;
  /**
   * Add many items via the Multiple tab with the "Treat as one
   * pre-ranked sublist" checkbox checked. Merge → appendPreRankedSublist
   * as one sublist; completed sort → modify-vs-new-slot confirm.
   * Undefined / hidden checkbox on insertion engine since pending is
   * FIFO either way.
   */
  onAddPreRanked?: (items: Item[]) => void;
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

export function ResultScreen({
  state,
  slotName,
  onUnhide,
  onStartOver,
  onAddOne,
  onAddMany,
  onAddPreRanked,
}: Props) {
  const [copied, setCopied] = useState<'csv' | 'md' | 'txt' | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  // existingIds powers AddItemsModal's de-dup hints; it shows in the
  // multiple-tab preview ("N already in your sort, will be skipped").
  // AddItemsModal also handles the engine-aware tab UI itself — we pass
  // state.engine and it hides the "pre-ranked" checkbox on insertion.
  const existingIds = useMemo(() => new Set(Object.keys(state.items)), [state.items]);

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
            <button
              className="btn"
              onClick={() => setShareOpen(true)}
              title="Generate a link recipients can open to import this ranking"
            >
              Share link
            </button>
          </div>
        </div>
        <ol className="result-list">
          {ranking.map((it, i) => (
            <li key={it.id} className="result-row">
              <div className="rank-num">{i + 1}</div>
              <ItemThumb item={it} as="div" className="image-wrap" />
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
                  <ItemThumb item={it} as="div" className="image-wrap" />
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
        <AddItemsModal
          engine={state.engine}
          existingIds={existingIds}
          onCancel={() => setAddOpen(false)}
          onAddOne={(item) => {
            onAddOne(item);
            setAddOpen(false);
          }}
          onAddMany={(items) => {
            onAddMany(items);
            setAddOpen(false);
          }}
          onAddPreRanked={
            onAddPreRanked
              ? (items) => {
                  onAddPreRanked(items);
                  setAddOpen(false);
                }
              : undefined
          }
        />
      )}
      {shareOpen && (
        <ShareLinkModal
          ranking={ranking}
          slotName={slotName}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}
