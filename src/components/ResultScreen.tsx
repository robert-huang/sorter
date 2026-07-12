import { useMemo, useState } from 'react';
import type { SlotResultsImportBatch } from '../lib/completedSortEditH';
import type { Item, SortState } from '../lib/types';
import { comparisonsRemaining, getRanking } from '../lib/engine';
import {
  activeRankingIds,
  formatOrphanHiddenId,
  rankingSlotIds,
} from './listScreenH';
import { AddItemsModal } from './AddItemsModal';
import { ItemThumb } from './ItemThumb';
import { ShareLinkModal } from './ShareLinkModal';

interface Props {
  state: SortState;
  /** Bumps when the AniList source DB changes (import, pull, etc.). */
  dbSyncRevision: number;
  /**
   * Active slot's display name. Passed through to the share-link
   * payload so the recipient sees a meaningful default slot name
   * after import (instead of the generic "Shared sort" fallback).
   */
  slotName?: string;
  /** Active slot id — excluded from Sort results import picker. */
  slotId?: string;
  onUnhide: (id: string) => void;
  onRestoreHidden: (id: string) => void;
  /** Permanently remove from hidden list and ranking (matches LIST tab Dismiss). */
  onForgetHidden: (id: string) => void;
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
  /** Results tab — multiple saved slots in one state update. */
  onAddSlotImports: (batches: SlotResultsImportBatch[]) => void;
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
  slotId,
  dbSyncRevision,
  onUnhide,
  onRestoreHidden,
  onForgetHidden,
  onStartOver,
  onAddOne,
  onAddMany,
  onAddPreRanked,
  onAddSlotImports,
}: Props) {
  const [copied, setCopied] = useState<'csv' | 'md' | 'txt' | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  // existingIds powers AddItemsModal de-dup hints. Only ids in ranking
  // slots / in-flight inserts count — not stale catalog leftovers.
  const existingIds = useMemo(() => activeRankingIds(state), [state]);
  const rankingSlots = useMemo(() => rankingSlotIds(state), [state]);

  if (!state.done) {
    return (
      <div className="page">
        <div className="page-section" style={{ textAlign: 'center' }}>
          <h2>Sort not finished yet</h2>
          <p style={{ color: 'var(--text-muted)' }}>
            ~{comparisonsRemaining(state)} comparisons left · {state.comparisons}{' '}
            comparison{state.comparisons === 1 ? '' : 's'} made
          </p>
        </div>
      </div>
    );
  }

  const ranking = getRanking(state)
    .map((id) => state.items[id])
    .filter(Boolean);
  const hiddenIds = state.hidden;

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
      <div className="page-section result-ranking-panel">
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

      {hiddenIds.length > 0 && (
        <div className="page-section result-hidden-section">
          <button
            className="result-hidden-toggle"
            onClick={() => setShowHidden((v) => !v)}
          >
            {showHidden ? '▾' : '▸'} {hiddenIds.length} item
            {hiddenIds.length === 1 ? '' : 's'} removed during sorting
          </button>
          {showHidden && (
            <ul className="result-list result-hidden-list">
              {hiddenIds.map((id) => {
                const item = state.items[id];
                const label = item?.label ?? formatOrphanHiddenId(id);
                const inRanking = rankingSlots.has(id);
                const canRestore = !!item;
                return (
                  <li key={id} className="result-row">
                    <div className="rank-num" style={{ color: 'var(--text-faint)' }}>
                      —
                    </div>
                    <ItemThumb
                      item={item ?? { id, label }}
                      as="div"
                      className="image-wrap"
                    />
                    <div
                      className="label-cell"
                      style={{ textDecoration: 'line-through' }}
                    >
                      {label}
                      {!canRestore && (
                        <span style={{ color: 'var(--text-faint)' }}>
                          {' '}
                          · metadata missing — dismiss only
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {canRestore && (
                        <button
                          className="btn"
                          onClick={() =>
                            inRanking ? onUnhide(id) : onRestoreHidden(id)
                          }
                          title={
                            inRanking
                              ? 'Show in final ranking again'
                              : 'Queue for sorting again'
                          }
                        >
                          Restore
                        </button>
                      )}
                      <button
                        className="btn danger"
                        onClick={() => onForgetHidden(id)}
                        title={
                          inRanking
                            ? 'Remove from the sort entirely'
                            : 'Clear from hidden count'
                        }
                      >
                        Dismiss
                      </button>
                    </div>
                  </li>
                );
              })}
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
          excludeSlotId={slotId}
          dbSyncRevision={dbSyncRevision}
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
          onAddSlotImports={(batches) => {
            onAddSlotImports(batches);
            setAddOpen(false);
          }}
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
