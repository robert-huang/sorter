import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getPair } from '../lib/engine';
import {
  canReorderInCurrentMerge,
  type CurrentMergeSlice,
} from '../lib/queueMergeSort';
import type { SlotResultsImportBatch } from '../lib/completedSortEditH';
import type {
  InsertionState,
  Item,
  MergeState,
  SortState,
} from '../lib/types';
import { AddItemsModal } from './AddItemsModal';
import { EditItemModal, type EditItemSavePayload } from './EditItemModal';
import { DetailButtonSlot } from './DetailButton';
import { RemoveGlyph } from './RemoveGlyph';
import { ItemThumb } from './ItemThumb';
import {
  activeRankingIds,
  formatOrphanHiddenId,
  autoInsertSourceRowState,
  getInsertContext,
  groupInsertionPending,
  insertContextInsertingLabel,
  insertionSortFromSublists,
  listHeaderItemCount,
  mergeSliceLabel,
  rankLabelForHiddenId,
  rankingSlotIds,
  type InsertContextKind,
  type InsertionPendingGroup,
} from './listScreenH';

/** Item ids shown in the unified completed-ranking section (LIST tab). */
function completedRankingIds(state: SortState): string[] {
  if (state.engine === 'insertion') return state.sorted;
  if (!state.done || state.queue.length === 0) return [];
  return state.queue[0];
}

/**
 * Unified LIST view for a finished sort — same label, help text, and row
 * actions (↑/↓, ↻, ×) whether the slot finished on merge or insertion.
 */
function CompletedRankingSection({
  rankedIds,
  items,
  hidden,
  onHide,
  onUnhide,
  onEdit,
  onReorder,
  onReturnToPending,
}: {
  rankedIds: string[];
  items: Record<string, Item>;
  hidden: Set<string>;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  onEdit: (item: Item) => void;
  onReorder: (itemIndex: number, dir: -1 | 1) => void;
  onReturnToPending: (id: string) => void;
}) {
  return (
    <>
      <div className="list-section-label">
        {mergeSliceLabel('Sorted', rankedIds.length)}
      </div>
      <p
        style={{
          fontSize: 13,
          color: 'var(--text-muted)',
          marginTop: 0,
        }}
      >
        Nudge an item with{' '} <strong>↑ / ↓</strong>, pull it back to re-insert with{' '}
        <strong>↻</strong>, or <strong>× Remove</strong> to drop it from the rank.
      </p>
      <div className="queue-sublist">
        <div className="queue-sublist-items">
          {rankedIds.map((id, ii) => {
            const item = items[id];
            if (!item) return null;
            const isHidden = hidden.has(id);
            return (
              <div
                key={id}
                className={`queue-item-row ${isHidden ? 'hidden' : ''}`}
              >
                <span className="rank">{ii + 1}.</span>
                <Thumb item={item} />
                <span className="label-cell" title={item.label}>
                  {item.label}
                </span>
                <span className="actions">
                  <ItemRowActions
                    item={item}
                    variant="row"
                    onEdit={onEdit}
                    reorder={
                      !isHidden && rankedIds.length > 1 ? (
                        <>
                          <button
                            className="icon-btn"
                            onClick={() => onReorder(ii, -1)}
                            disabled={ii === 0}
                            title="Nudge up"
                          >
                            ↑
                          </button>
                          <button
                            className="icon-btn"
                            onClick={() => onReorder(ii, 1)}
                            disabled={ii === rankedIds.length - 1}
                            title="Nudge down"
                          >
                            ↓
                          </button>
                          <button
                            className="icon-btn"
                            onClick={() => onReturnToPending(id)}
                            title="Pull this item back out and re-insert it (fresh binary search)"
                          >
                            ↻
                          </button>
                        </>
                      ) : null
                    }
                    trailing={
                      <HideOrRestoreButton
                        id={id}
                        isHidden={isHidden}
                        allowRestore
                        onHide={onHide}
                        onUnhide={onUnhide}
                      />
                    }
                  />
                </span>
              </div>
            );
          })}
          {rankedIds.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              (no sorted items yet)
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * All hidden items — shown at the bottom even when they still appear
 * (struck through) in the main ranking list above.
 */
function HiddenItemsSection({
  ids,
  items,
  state,
  rankingSlots,
  activeRankingSlots,
  allowInlineRestore,
  onUnhide,
  onReinsert,
  onRestoreHidden,
  onForget,
}: {
  ids: string[];
  items: Record<string, Item>;
  state: SortState;
  /** Settled ranking slots (queue / sorted). */
  rankingSlots: Set<string>;
  /** In-flight merge + insert targets — used while sort is active. */
  activeRankingSlots: Set<string>;
  /** When true (sort finished), in-slot hidden ids use ↺ Restore. */
  allowInlineRestore: boolean;
  onUnhide: (id: string) => void;
  onReinsert: (id: string) => void;
  onRestoreHidden: (id: string) => void;
  onForget: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  if (ids.length === 0) return null;

  return (
    <div className="list-removed-during-sort">
      <button
        type="button"
        className="list-section-label list-removed-toggle"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          textAlign: 'left',
          width: '100%',
        }}
      >
        {open ? '▾' : '▸'} Hidden items ({ids.length})
      </button>
      {open && (
        <>
          <p
            style={{
              fontSize: 13,
              color: 'var(--text-muted)',
              marginTop: 0,
            }}
          >
            These items stay in the list above at their old rank (struck
            through) when applicable. While the sort is still running, use{' '}
            <strong>↻ Reinsert</strong> to pull one back out for a fresh binary
            insert. After the sort finishes, use <strong>↺ Restore</strong>{' '}
            (inline or here) to show it at its old rank again — or the row{' '}
            <strong>↻</strong> on a visible item to binary-search it back in.{' '}
            <strong>× Dismiss</strong> removes an item from the sort entirely.
          </p>
          <div className="queue-sublist">
            <div className="queue-sublist-items">
              {ids.map((id) => {
                const item = items[id];
                const label = item?.label ?? formatOrphanHiddenId(id);
                const inRanking = (
                  allowInlineRestore ? rankingSlots : activeRankingSlots
                ).has(id);
                const canAct = !!item;
                const rank = inRanking ? rankLabelForHiddenId(state, id) : '—';
                const useRestore = allowInlineRestore && inRanking;
                return (
                  <div key={id} className="queue-item-row hidden">
                    <span className="rank">{rank}</span>
                    <Thumb item={item ?? { id, label }} />
                    <span className="label-cell" title={label}>
                      {label}
                      {!canAct && (
                        <span style={{ color: 'var(--text-faint)' }}>
                          {' '}
                          · metadata missing — dismiss only
                        </span>
                      )}
                    </span>
                    <span className="actions">
                      {canAct && useRestore && (
                        <LabeledIconButton
                          glyph="↺"
                          label="Restore"
                          onClick={() => onUnhide(id)}
                          title="Restore at old rank"
                        />
                      )}
                      {canAct && !useRestore && (
                        <LabeledIconButton
                          glyph="↻"
                          label="Reinsert"
                          onClick={() =>
                            allowInlineRestore
                              ? onRestoreHidden(id)
                              : onReinsert(id)
                          }
                          title={
                            inRanking
                              ? 'Pull out and binary-insert again'
                              : 'Queue for sorting again'
                          }
                        />
                      )}
                      <LabeledIconButton
                        className="icon-btn danger icon-btn-text"
                        glyph={<RemoveGlyph />}
                        label="Dismiss"
                        onClick={() => onForget(id)}
                        title={
                          inRanking
                            ? 'Remove from the sort entirely'
                            : 'Clear from hidden count'
                        }
                      />
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface Props {
  state: SortState;
  /** Bumps when the AniList source DB changes (import, pull, etc.). */
  dbSyncRevision: number;
  /** Active save-slot id — used when renaming from the LIST header. */
  slotId: string;
  slotName: string;
  onRenameSlot: (id: string, name: string) => void;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  onReorder: (queueIndex: number, itemIndex: number, dir: -1 | 1) => void;
  /** Merge-only: nudge an item within one slice of the in-flight merge frame. */
  onReorderInCurrentMerge: (
    slice: CurrentMergeSlice,
    itemIndex: number,
    dir: -1 | 1,
  ) => void;
  /**
   * Merge-only: swap two absolute positions in the active insert target
   * (the "insert-into" list during auto- or manual-insert). Cancels and
   * restarts the in-flight insert frame.
   */
  onReorderInsertTarget: (indexA: number, indexB: number) => void;
  onBreakApart: (queueIndex: number) => void;
  /** Add a single item (Single tab). */
  onAddItem: (item: Item) => void;
  /**
   * Add many items as N individual adds (Multiple tab, unranked):
   *  - insertion engine: appends each to pending FIFO.
   *  - merge engine: appends N singleton sublists to the queue back.
   */
  onAddItems: (items: Item[]) => void;
  /**
   * Add many items as ONE pre-ranked sublist (Multiple tab, merge engine
   * only, with the "Treat as pre-ranked sublist" checkbox checked).
   */
  onAppendPreRanked: (items: Item[]) => void;
  /** Results tab — multiple saved slots in one state update. */
  onAddSlotImports: (batches: SlotResultsImportBatch[]) => void;
  /** Merge-only: drop a to-be-inserted id permanently. */
  onForget: (id: string) => void;
  /**
   * Insertion-only: nudge an item up (-1) or down (+1) in `sorted[]`.
   * Cancels and restarts any in-flight insert frame.
   */
  onReorderInSorted: (sortedIndex: number, dir: -1 | 1) => void;
  /**
   * Pull an item out of the ranking and re-insert it via a fresh binary
   * search (↻). Works on both engines when the sort is complete.
   */
  onReturnToPending: (id: string) => void;
  /** Clear a hidden id that no longer has a ranking row (ghost / orphan). */
  onDismissHidden: (id: string) => void;
  /**
   * Re-queue a hidden orphan for sorting. In-slot hidden ids during an
   * active sort use `onReinsertHidden`; `onUnhide` is for completed sorts.
   */
  onRestoreHidden: (id: string) => void;
  /** Pull a hidden item back out for a fresh binary insert (↻). */
  onReinsertHidden: (id: string) => void;
  /** Permanently remove a hidden item from the sort (× Dismiss). */
  onForgetHidden: (id: string) => void;
  /**
   * Patch metadata (label / url / imageUrl) on an item in place. The
   * item's structural position in the sort is preserved — only the
   * display fields change. Used to fix labels mis-parsed at import
   * time (e.g. commas inside the label being treated as the CSV
   * column separator).
   *
   * `patch.id`, when present, also renames the item's logical id.
   * The handler in App.tsx applies it atomically with the metadata
   * patch and rewrites the undo ring so a later undo doesn't restore
   * stale-id references. See `engine.updateItemId` and
   * `engine.rewriteIdInProgress`.
   */
  onEditItem: (id: string, patch: EditItemSavePayload) => void;
}

function Thumb({ item }: { item: Item }) {
  // Pass placeholderClass="" so the placeholder inherits the parent
  // .thumb font styling — matches the prior single-character look but
  // now shows initials and adds onError fallback for broken URLs.
  return <ItemThumb item={item} className="thumb" placeholderClass="" />;
}

/** Labeled row action — glyph slot + label with icon-btn-text gap (× Dismiss pattern). */
function LabeledIconButton({
  className = 'icon-btn icon-btn-text',
  glyph,
  label,
  ...props
}: {
  className?: string;
  glyph: ReactNode;
  label: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'>) {
  return (
    <button type="button" className={className} {...props}>
      <span className="icon-btn-glyph-slot" aria-hidden="true">
        {glyph}
      </span>
      <span>{label}</span>
    </button>
  );
}

/** Pencil-icon button that opens the EditItemModal for `item`. */
function EditButton({
  item,
  onOpen,
  variant,
}: {
  item: Item;
  onOpen: (item: Item) => void;
  variant: 'chip' | 'row';
}) {
  return (
    <button
      className={variant === 'chip' ? 'x edit' : 'icon-btn'}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(item);
      }}
      title={`Edit "${item.label}"`}
      aria-label={`Edit ${item.label}`}
    >
      ✎
    </button>
  );
}

/** Standard row/chip action order: [ⓘ?] reorder, edit, trailing. */
function ItemRowActions({
  item,
  variant,
  onEdit,
  reorder,
  trailing,
}: {
  item: Item;
  variant: 'chip' | 'row';
  onEdit: (item: Item) => void;
  reorder?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <>
      <DetailButtonSlot item={item} variant={variant} />
      {reorder}
      <EditButton item={item} onOpen={onEdit} variant={variant} />
      {trailing}
    </>
  );
}

/**
 * × Remove on visible rows; ↺ Restore only when `allowRestore` (sort
 * finished). During an active sort, hidden in-slot rows have no inline
 * recovery — use Hidden items → ↻ Reinsert.
 */
function HideOrRestoreButton({
  id,
  isHidden,
  allowRestore,
  onHide,
  onUnhide,
  hideTitle = 'Remove',
  restoreTitle = 'Restore',
  variant = 'row',
  ariaLabel,
}: {
  id: string;
  isHidden: boolean;
  allowRestore: boolean;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  hideTitle?: string;
  restoreTitle?: string;
  variant?: 'chip' | 'row';
  ariaLabel?: string;
}) {
  if (isHidden) {
    if (!allowRestore) return null;
    if (variant === 'chip') {
      return (
        <button
          className="x"
          onClick={() => onUnhide(id)}
          title={restoreTitle}
          aria-label={ariaLabel ?? restoreTitle}
        >
          ↺
        </button>
      );
    }
    return (
      <button
        className="icon-btn"
        onClick={() => onUnhide(id)}
        title={restoreTitle}
        aria-label={ariaLabel}
      >
        ↺
      </button>
    );
  }
  if (variant === 'chip') {
    return (
      <button
        className="x"
        onClick={() => onHide(id)}
        title={hideTitle}
        aria-label={ariaLabel ?? hideTitle}
      >
        <RemoveGlyph size={14} />
      </button>
    );
  }
  return (
    <button
      className="icon-btn danger"
      onClick={() => onHide(id)}
      title={hideTitle}
      aria-label={ariaLabel}
    >
      <RemoveGlyph />
    </button>
  );
}

function formatItemCount(total: number, hidden: number): string {
  const base = `${total} item${total === 1 ? '' : 's'}`;
  if (hidden === 0) return base;
  return `${base} (${hidden} hidden)`;
}

const INSERT_CONTEXT_COPY: Record<
  InsertContextKind,
  { title: string; hint: string; targetHeading: string }
> = {
  'insertion': {
    title: 'Insertion mode',
    hint: 'Binary-inserting into the sorted list — highlighted rows match the active pair on RANK.',
    targetHeading: 'Inserting into',
  },
  'merge-manual': {
    title: 'Manual insert',
    hint: 'Inserting an exiled item into a queue sublist — highlighted rows match RANK.',
    targetHeading: 'Inserting into',
  },
  'merge-auto': {
    title: 'Sublist merge',
    hint: 'Inserting the smaller sublist into the larger one — highlighted rows match the active pair on RANK.',
    targetHeading: 'Merging into',
  },
};

/**
 * LIST should mirror the RANK tab's active pair via `getPair`, not whatever
 * happens to be in "current sublist" slices. Those slices are empty during
 * merge auto-/manual-insert (`state.current` is null) and insertion only
 * surfaced the inserting item — never the probe on the right card.
 */
function shouldShowCurrentComparison(state: SortState): boolean {
  if (state.done) return false;
  if (!getPair(state)) return false;
  if (state.engine === 'insertion') return true;
  return state.current === null;
}

function InsertContextSection({
  state,
  onOpenEdit,
  onHideRemaining,
  onHideTarget,
  onReorderTarget,
  onReturnTargetToPending,
}: {
  state: SortState;
  onOpenEdit: (item: Item) => void;
  /**
   * × on any "inserting" row — the in-flight inserting item OR a
   * queued one. Dropping orphans the item into Hidden items (reinsert-only,
   * it has no rank slot to restore to). Undoable via the ring.
   */
  onHideRemaining?: (id: string) => void;
  /** × on a row of the "insert-into" list (removable target). */
  onHideTarget?: (id: string) => void;
  /**
   * Swap two absolute positions in the "insert-into" list.
   * Passed absolute indices into `ctx.targetIds` (the full target,
   * including hidden), so swaps preserve hidden items' slots.
   */
  onReorderTarget?: (indexA: number, indexB: number) => void;
  /** Insertion-only: pull a target row back out for a fresh binary insert (↻). */
  onReturnTargetToPending?: (id: string) => void;
}) {
  const ctx = getInsertContext(state);
  if (!ctx) return null;
  const copy = INSERT_CONTEXT_COPY[ctx.kind];
  const hidden = useMemo(() => new Set(state.hidden), [state.hidden]);
  const probeRowRef = useRef<HTMLDivElement | null>(null);

  // Visible target rows carry their ABSOLUTE index into ctx.targetIds so
  // reorder swaps map correctly even with hidden items interleaved.
  const targetRows = ctx.targetIds
    .map((id, absoluteIndex) => ({ id, absoluteIndex }))
    .filter((row) => !hidden.has(row.id));
  const visibleTarget = targetRows.map((row) => row.id);
  const visibleRemaining = ctx.remainingIds.filter((id) => !hidden.has(id));
  const isMergeAutoSource =
    ctx.kind === 'merge-auto' && ctx.sourceSublistIds !== undefined;
  const insertingSourceIds =
    isMergeAutoSource && ctx.sourceSublistIds
      ? ctx.sourceSublistIds.filter((id) => !hidden.has(id))
      : visibleRemaining;
  const probeVisible = !hidden.has(ctx.probeId);
  const probeItem = state.items[ctx.probeId];

  function jumpToProbe(): void {
    probeRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  return (
    <div className="list-merging">
      <div className="list-section-label">{copy.title}</div>
      <p
        style={{
          fontSize: 13,
          color: 'var(--text-muted)',
          marginTop: 0,
          marginBottom: 12,
        }}
      >
        {copy.hint}
      </p>
      <div className="list-merge-context-grid">
        <div className="list-merge-context-panel">
          <div className="list-merge-context-heading">
            {mergeSliceLabel(copy.targetHeading, visibleTarget.length)}
          </div>
          <div className="queue-sublist">
            <div className="queue-sublist-items">
              {visibleTarget.length === 0 && (
                <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>
                  (empty)
                </span>
              )}
              {targetRows.map((row, ii) => {
                const id = row.id;
                const item = state.items[id];
                if (!item) return null;
                const isProbe = id === ctx.probeId;
                const prevRow = targetRows[ii - 1];
                const nextRow = targetRows[ii + 1];
                return (
                  <div
                    key={id}
                    ref={isProbe ? probeRowRef : undefined}
                    className={`queue-item-row list-merge-context-row${isProbe ? ' list-merge-context-active' : ''}`}
                  >
                    <span className="rank">{ii + 1}.</span>
                    <Thumb item={item} />
                    <span className="label-cell" title={item.label}>
                      {item.label}
                    </span>
                    <span className="actions">
                      {isProbe && (
                        <span className="list-merge-context-tag">probe</span>
                      )}
                      <span className="row-action-glyphs">
                        <ItemRowActions
                          item={item}
                          variant="row"
                          onEdit={onOpenEdit}
                          reorder={
                          onReorderTarget || onReturnTargetToPending ? (
                            <>
                              {onReorderTarget ? (
                                <>
                                  <button
                                    className="icon-btn"
                                    onClick={() =>
                                      prevRow &&
                                      onReorderTarget(
                                        row.absoluteIndex,
                                        prevRow.absoluteIndex,
                                      )
                                    }
                                    disabled={!prevRow}
                                    title="Nudge up (restarts the current insert)"
                                    aria-label={`Move ${item.label} up`}
                                  >
                                    ↑
                                  </button>
                                  <button
                                    className="icon-btn"
                                    onClick={() =>
                                      nextRow &&
                                      onReorderTarget(
                                        row.absoluteIndex,
                                        nextRow.absoluteIndex,
                                      )
                                    }
                                    disabled={!nextRow}
                                    title="Nudge down (restarts the current insert)"
                                    aria-label={`Move ${item.label} down`}
                                  >
                                    ↓
                                  </button>
                                </>
                              ) : null}
                              {onReturnTargetToPending ? (
                                <button
                                  className="icon-btn"
                                  onClick={() => onReturnTargetToPending(id)}
                                  title="Pull this item back out and re-insert it (fresh binary search)"
                                >
                                  ↻
                                </button>
                              ) : null}
                            </>
                          ) : null
                        }
                        trailing={
                          onHideTarget ? (
                            <button
                              className="icon-btn danger"
                              onClick={() => onHideTarget(id)}
                              title="Remove this item from the list being inserted into"
                              aria-label={`Remove ${item.label}`}
                            >
                              <RemoveGlyph />
                            </button>
                          ) : null
                        }
                        />
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="list-merge-context-panel">
          <div className="list-merge-context-heading list-merge-context-heading-row">
            <span>
              {insertContextInsertingLabel(ctx, visibleRemaining.length)}
            </span>
            <button
              type="button"
              className="btn small list-merge-context-jump-probe"
              onClick={jumpToProbe}
              disabled={!probeVisible}
              title={
                probeVisible
                  ? `Scroll to probe${probeItem ? `: ${probeItem.label}` : ''}`
                  : 'Probe is hidden'
              }
            >
              Jump to probe
            </button>
          </div>
          <div className="queue-sublist">
            <div className="queue-sublist-items">
              {insertingSourceIds.length === 0 && (
                <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>
                  (empty)
                </span>
              )}
              {insertingSourceIds.map((id, ii) => {
                const item = state.items[id];
                if (!item) return null;
                const rowState = isMergeAutoSource
                  ? autoInsertSourceRowState(ctx, id)
                  : id === ctx.insertingId
                    ? 'inserting'
                    : 'queued';
                const isInserting = rowState === 'inserting';
                const isDone = rowState === 'done';
                const rankNum = isMergeAutoSource
                  ? ctx.sourceSublistIds!.indexOf(id) + 1
                  : ii + 1;
                return (
                  <div
                    key={id}
                    className={`queue-item-row list-merge-context-row${isInserting ? ' list-merge-context-active' : ''}${!isInserting && !isDone ? ' list-merge-context-queued' : ''}${isDone ? ' list-merge-context-done' : ''}`}
                  >
                    <span className="rank">{rankNum}.</span>
                    <Thumb item={item} />
                    <span className="label-cell" title={item.label}>
                      {item.label}
                    </span>
                    <span className="actions">
                      {isInserting && (
                        <span className="list-merge-context-tag">inserting</span>
                      )}
                      <span className="row-action-glyphs">
                        <ItemRowActions
                          item={item}
                          variant="row"
                          onEdit={onOpenEdit}
                          trailing={
                            onHideRemaining && !isDone ? (
                              <button
                                className="icon-btn danger"
                                onClick={() => onHideRemaining(id)}
                                title={
                                  isInserting
                                    ? 'Remove this item — skip inserting it and move on'
                                    : 'Remove this queued item — drops it to Hidden items for later reinsert'
                                }
                                aria-label={`Remove ${item.label}`}
                              >
                                <RemoveGlyph />
                              </button>
                            ) : null
                          }
                        />
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ListSlotHeader({
  slotId,
  slotName,
  itemCount,
  hiddenCount,
  onRename,
}: {
  slotId: string;
  slotName: string;
  itemCount: number;
  hiddenCount: number;
  onRename: (id: string, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(slotName);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(slotName);
  }, [slotName, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commitRename(): void {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== slotName) {
      onRename(slotId, trimmed);
    } else {
      setDraft(slotName);
    }
  }

  function cancelRename(): void {
    setEditing(false);
    setDraft(slotName);
  }

  return (
    <div className="list-slot-header">
      <div className="list-slot-title-row">
        {editing ? (
          <input
            ref={inputRef}
            className="list-slot-title-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelRename();
              }
            }}
            aria-label="Sort title"
          />
        ) : (
          <div className="list-slot-title-group">
            <button
              type="button"
              className="list-slot-title"
              title={slotName}
              onClick={() => setEditing(true)}
            >
              {slotName}
            </button>
            <button
              type="button"
              className="list-slot-edit"
              onClick={() => setEditing(true)}
              title="Rename sort"
              aria-label="Rename sort"
            >
              ✎
            </button>
          </div>
        )}
      </div>
      <span className="list-slot-meta">
        {formatItemCount(itemCount, hiddenCount)}
      </span>
    </div>
  );
}

export function ListScreen(props: Props) {
  const items = props.state?.items;
  const itemCount = useMemo(
    () => (props.state ? listHeaderItemCount(props.state) : 0),
    [props.state],
  );
  const hiddenCount = props.state?.hidden?.length ?? 0;

  if (!props.state || !items) {
    return null;
  }

  const state = props.state;
  const rankingSlots = useMemo(() => rankingSlotIds(state), [state]);
  const activeRankingSlots = useMemo(() => activeRankingIds(state), [state]);
  const hiddenIds = useMemo(() => state.hidden, [state.hidden]);

  return (
    <div className="page page--list">
      <ListSlotHeader
        slotId={props.slotId}
        slotName={props.slotName}
        itemCount={itemCount}
        hiddenCount={hiddenCount}
        onRename={props.onRenameSlot}
      />
      {state.engine === 'insertion' ? (
        <InsertionListView {...props} state={state} />
      ) : (
        <MergeListView {...props} state={state} />
      )}
      <HiddenItemsSection
        ids={hiddenIds}
        items={items}
        state={state}
        rankingSlots={rankingSlots}
        activeRankingSlots={activeRankingSlots}
        allowInlineRestore={state.done}
        onUnhide={props.onUnhide}
        onReinsert={props.onReinsertHidden}
        onRestoreHidden={props.onRestoreHidden}
        onForget={props.onForgetHidden}
      />
    </div>
  );
}

// ============================================================================
// MERGE VIEW — original list screen + "To be inserted (N)" section
// (items exiled from a merge close, awaiting Insert or Remove → Hidden)
// ============================================================================

function MergeListView({
  state,
  slotId,
  dbSyncRevision,
  onHide,
  onUnhide,
  onReorder,
  onReorderInCurrentMerge,
  onBreakApart,
  onAddItem,
  onAddItems,
  onAppendPreRanked,
  onAddSlotImports,
  onEditItem,
  onReturnToPending,
  onReorderInsertTarget,
}: Props & { state: MergeState }) {
  const [addOpen, setAddOpen] = useState(false);
  // The item currently open in the EditItemModal. We track by id (not
  // by Item reference) so the modal re-reads from state.items[id] on
  // any external update — keeps the form in sync if the user has an
  // edit open and another autosave/restore changes the underlying
  // dict.
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingItem = editingId ? state.items[editingId] ?? null : null;
  const openEdit = (it: Item) => setEditingId(it.id);
  const hidden = useMemo(() => new Set(state.hidden), [state.hidden]);
  const existingIds = useMemo(() => activeRankingIds(state), [state]);
  // id → label for every item EXCEPT the one currently being edited.
  // Powers the collision check inside EditItemModal's advanced panel.
  // Recomputed when state.items changes (cheap — N items, infrequent
  // open) or when the modal opens against a different id.
  const otherIds = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of Object.values(state.items)) {
      if (it.id === editingId) continue;
      m.set(it.id, it.label);
    }
    return m;
  }, [state.items, editingId]);

  return (
    <>
      {shouldShowCurrentComparison(state) && getInsertContext(state) && (
        <InsertContextSection
          state={state}
          onOpenEdit={openEdit}
          onHideRemaining={onHide}
          onHideTarget={onHide}
          onReorderTarget={onReorderInsertTarget}
        />
      )}
      {state.current && (
        <div className="list-merging">
          <div className="list-section-label">Current sublist</div>
          <CurrentMergeRow
            label={mergeSliceLabel('Merged so far', state.current.merged.length)}
            slice="merged"
            ids={state.current.merged}
            state={state}
            hidden={hidden}
            onHide={onHide}
            onUnhide={onUnhide}
            onReorder={onReorderInCurrentMerge}
            onEdit={openEdit}
          />
          <CurrentMergeRow
            label={mergeSliceLabel('Left remaining', state.current.left.length)}
            slice="left"
            ids={state.current.left}
            state={state}
            hidden={hidden}
            onHide={onHide}
            onUnhide={onUnhide}
            onReorder={onReorderInCurrentMerge}
            onEdit={openEdit}
          />
          <CurrentMergeRow
            label={mergeSliceLabel('Right remaining', state.current.right.length)}
            slice="right"
            ids={state.current.right}
            state={state}
            hidden={hidden}
            onHide={onHide}
            onUnhide={onUnhide}
            onReorder={onReorderInCurrentMerge}
            onEdit={openEdit}
          />
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-muted)',
              marginTop: 8,
            }}
          >
            Use the RANK tab to make comparisons.
          </div>
        </div>
      )}

      {state.done ? (
        <CompletedRankingSection
          rankedIds={completedRankingIds(state)}
          items={state.items}
          hidden={hidden}
          onHide={onHide}
          onUnhide={onUnhide}
          onEdit={openEdit}
          onReorder={(ii, dir) => onReorder(0, ii, dir)}
          onReturnToPending={onReturnToPending}
        />
      ) : (
        <>
          <div className="list-section-label">
            Queue ({state.queue.length} sublist
            {state.queue.length === 1 ? '' : 's'})
          </div>
          {state.queue.length === 0 && (
            <div
              className="page-section"
              style={{ textAlign: 'center', color: 'var(--text-muted)' }}
            >
              Queue is empty.
            </div>
          )}
          {state.queue.map((sub, qi) => (
            <SublistView
              key={qi}
              sub={sub}
              queueIndex={qi}
              state={state}
              hidden={hidden}
              onHide={onHide}
              onUnhide={onUnhide}
              onReorder={onReorder}
              onBreakApart={onBreakApart}
              onEdit={openEdit}
            />
          ))}
        </>
      )}

      {state.toBeInserted.length > 0 && (
        <div className="list-to-be-inserted">
          <div className="list-section-label">
            To be inserted ({state.toBeInserted.length})
          </div>
          <p
            style={{
              fontSize: 13,
              color: 'var(--text-muted)',
              marginTop: 0,
            }}
          >
            These items are queued for binary insertion into the ranking.
            Use <strong>× Remove</strong> to move them back to Hidden
            items.
          </p>
          {state.toBeInserted.map((id) => {
            const item = state.items[id];
            if (!item) return null;
            const queued = state.pendingManualInserts.includes(id);
            const inserting =
              state.currentManualInsert?.insertingId === id;
            return (
              <div key={id} className="queue-item-row">
                <Thumb item={item} />
                <span className="label-cell" title={item.label}>
                  {item.label}
                  {inserting && (
                    <span style={{ color: 'var(--text-faint)' }}>
                      {' '}
                      · inserting now
                    </span>
                  )}
                  {queued && !inserting && (
                    <span style={{ color: 'var(--text-faint)' }}>
                      {' '}
                      · queued for insertion
                    </span>
                  )}
                </span>
                <span className="actions">
                  <ItemRowActions
                    item={item}
                    variant="row"
                    onEdit={openEdit}
                    trailing={
                      <button
                        className="icon-btn danger"
                        onClick={() => onHide(id)}
                        title="Remove — move to Hidden items"
                        aria-label={`Remove ${item.label}`}
                      >
                        <RemoveGlyph />
                      </button>
                    }
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="add-buttons">
        <button className="btn" onClick={() => setAddOpen(true)}>
          + Add item(s)
        </button>
      </div>

      {addOpen && (
        <AddItemsModal
          engine="merge"
          existingIds={existingIds}
          excludeSlotId={slotId || undefined}
          dbSyncRevision={dbSyncRevision}
          onCancel={() => setAddOpen(false)}
          onAddOne={(item) => {
            onAddItem(item);
            setAddOpen(false);
          }}
          onAddMany={(items) => {
            onAddItems(items);
            setAddOpen(false);
          }}
          onAddPreRanked={(items) => {
            onAppendPreRanked(items);
            setAddOpen(false);
          }}
          onAddSlotImports={(batches) => {
            onAddSlotImports(batches);
            setAddOpen(false);
          }}
        />
      )}

      {editingItem && (
        <EditItemModal
          item={editingItem}
          onCancel={() => setEditingId(null)}
          onSave={(patch) => {
            onEditItem(editingItem.id, patch);
            setEditingId(null);
          }}
          allowEditId
          currentId={editingItem.id}
          otherIds={otherIds}
        />
      )}
    </>
  );
}

function CurrentMergeRow({
  label,
  slice,
  ids,
  state,
  hidden,
  onHide,
  onUnhide,
  onReorder,
  onEdit,
}: {
  label: string;
  slice: CurrentMergeSlice;
  ids: string[];
  state: MergeState;
  hidden: Set<string>;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  onReorder: (slice: CurrentMergeSlice, itemIndex: number, dir: -1 | 1) => void;
  onEdit: (item: Item) => void;
}) {
  return (
    <div className="list-merge-row">
      <div className="row-label">{label}</div>
      <div className="list-chip-row">
        {ids.length === 0 && (
          <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>
            (empty)
          </span>
        )}
        {ids.map((id, ii) => {
          const item = state.items[id];
          if (!item) return null;
          const isHidden = hidden.has(id);
          const canUp = canReorderInCurrentMerge(state, slice, ii, -1);
          const canDown = canReorderInCurrentMerge(state, slice, ii, 1);
          return (
            <span
              key={id}
              className={`chip ${isHidden ? 'hidden' : ''}`}
              title={item.label}
            >
              <Thumb item={item} />
              {item.label}
              <ItemRowActions
                item={item}
                variant="chip"
                onEdit={onEdit}
                reorder={
                  ids.length > 1 ? (
                    <>
                      <button
                        className="x reorder"
                        onClick={() => onReorder(slice, ii, -1)}
                        disabled={!canUp}
                        title="Move up"
                        aria-label={`Move ${item.label} up`}
                      >
                        ↑
                      </button>
                      <button
                        className="x reorder"
                        onClick={() => onReorder(slice, ii, 1)}
                        disabled={!canDown}
                        title="Move down"
                        aria-label={`Move ${item.label} down`}
                      >
                        ↓
                      </button>
                    </>
                  ) : null
                }
                trailing={
                  <HideOrRestoreButton
                    id={id}
                    isHidden={isHidden}
                    allowRestore={false}
                    onHide={onHide}
                    onUnhide={onUnhide}
                    hideTitle="Remove item"
                    restoreTitle="Restore item"
                    variant="chip"
                    ariaLabel={
                      isHidden ? `Restore ${item.label}` : `Remove ${item.label}`
                    }
                  />
                }
              />
            </span>
          );
        })}
      </div>
    </div>
  );
}

function SublistView({
  sub,
  queueIndex,
  state,
  hidden,
  onHide,
  onUnhide,
  onReorder,
  onBreakApart,
  onEdit,
}: {
  sub: string[];
  queueIndex: number;
  state: MergeState;
  hidden: Set<string>;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  onReorder: (queueIndex: number, itemIndex: number, dir: -1 | 1) => void;
  onBreakApart: (queueIndex: number) => void;
  onEdit: (item: Item) => void;
}) {
  const isFront = queueIndex < 2;
  return (
    <div className="queue-sublist">
      <div className="queue-sublist-header">
        <span className="index">
          #{queueIndex + 1}{' '}
          {isFront && state.current === null && queueIndex < 2 && (
            <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>
              · next to merge
            </span>
          )}
        </span>
        {sub.length > 1 && (
          <button
            className="icon-btn break-btn"
            onClick={() => onBreakApart(queueIndex)}
            title="Break this sublist apart into singletons at the end of the queue"
          >
            ⚡ Break apart
          </button>
        )}
      </div>
      <div className="queue-sublist-items">
        {sub.map((id, ii) => {
          const item = state.items[id];
          if (!item) return null;
          const isHidden = hidden.has(id);
          return (
            <div
              key={id}
              className={`queue-item-row ${isHidden ? 'hidden' : ''}`}
            >
              <span className="rank">{ii + 1}.</span>
              <Thumb item={item} />
              <span className="label-cell" title={item.label}>
                {item.label}
              </span>
              <span className="actions">
                <ItemRowActions
                  item={item}
                  variant="row"
                  onEdit={onEdit}
                  reorder={
                    sub.length > 1 ? (
                      <>
                        <button
                          className="icon-btn"
                          onClick={() => onReorder(queueIndex, ii, -1)}
                          disabled={ii === 0}
                          title="Move up"
                        >
                          ↑
                        </button>
                        <button
                          className="icon-btn"
                          onClick={() => onReorder(queueIndex, ii, 1)}
                          disabled={ii === sub.length - 1}
                          title="Move down"
                        >
                          ↓
                        </button>
                      </>
                    ) : null
                  }
                  trailing={
                    <HideOrRestoreButton
                      id={id}
                      isHidden={isHidden}
                      allowRestore={false}
                      onHide={onHide}
                      onUnhide={onUnhide}
                    />
                  }
                />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// INSERTION VIEW — Sorted seed + pending queue. When seeded from multiple
// pre-ranked sublists (`pendingRunIds`), pending renders as sublist blocks
// like the merge engine queue; otherwise flat FIFO rows.
// ============================================================================

function InsertionPendingItemRow({
  item,
  hidden,
  onHide,
  onUnhide,
  onEdit,
  rank,
  insertStatus,
}: {
  item: Item;
  hidden: Set<string>;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  onEdit: (item: Item) => void;
  rank?: number;
  /** Shown while an insert compare is active (duplicates the INSERTING panel). */
  insertStatus?: 'inserting' | 'queued';
}) {
  const isHidden = hidden.has(item.id);
  const isInserting = insertStatus === 'inserting';
  const isQueued = insertStatus === 'queued';
  return (
    <div className={`queue-item-row ${isHidden ? 'hidden' : ''}`}>
      {rank !== undefined && <span className="rank">{rank}.</span>}
      <Thumb item={item} />
      <span className="label-cell" title={item.label}>
        {item.label}
        {isInserting && (
          <span style={{ color: 'var(--text-faint)' }}> · inserting now</span>
        )}
        {isQueued && (
          <span style={{ color: 'var(--text-faint)' }}>
            {' '}
            · queued for insertion
          </span>
        )}
      </span>
      <span className="actions">
        <ItemRowActions
          item={item}
          variant="row"
          onEdit={onEdit}
          trailing={
            <HideOrRestoreButton
              id={item.id}
              isHidden={isHidden}
              allowRestore={false}
              onHide={onHide}
              onUnhide={onUnhide}
              hideTitle="Skip this item"
            />
          }
        />
      </span>
    </div>
  );
}

function InsertionPendingGroupView({
  group,
  groupIndex,
  state,
  hidden,
  onHide,
  onUnhide,
  onEdit,
  isNext,
  insertingId,
}: {
  group: InsertionPendingGroup;
  groupIndex: number;
  state: InsertionState;
  hidden: Set<string>;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  onEdit: (item: Item) => void;
  isNext: boolean;
  insertingId?: string;
}) {
  const pendingInsertStatus = (
    id: string,
  ): 'inserting' | 'queued' | undefined => {
    if (!insertingId) return undefined;
    return id === insertingId ? 'inserting' : 'queued';
  };
  if (group.kind === 'flat') {
    return (
      <>
        {group.ids.map((id) => {
          const item = state.items[id];
          if (!item) return null;
          return (
            <InsertionPendingItemRow
              key={id}
              item={item}
              hidden={hidden}
              onHide={onHide}
              onUnhide={onUnhide}
              onEdit={onEdit}
              insertStatus={pendingInsertStatus(id)}
            />
          );
        })}
      </>
    );
  }

  if (group.kind === 'extras') {
    return (
      <div className="queue-sublist">
        <div className="queue-sublist-header">
          <span className="index">
            Unranked extras ({group.ids.length})
          </span>
        </div>
        <div className="queue-sublist-items">
          {group.ids.map((id) => {
            const item = state.items[id];
            if (!item) return null;
            return (
              <InsertionPendingItemRow
                key={id}
                item={item}
                hidden={hidden}
                onHide={onHide}
                onUnhide={onUnhide}
                onEdit={onEdit}
                insertStatus={pendingInsertStatus(id)}
              />
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="queue-sublist">
      <div className="queue-sublist-header">
        <span className="index">
          #{groupIndex + 1}{' '}
          <span style={{ fontWeight: 400 }}>
            pre-ranked sublist ({group.ids.length} item
            {group.ids.length === 1 ? '' : 's'})
          </span>
          {isNext && (
            <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>
              {' '}
              · next in queue
            </span>
          )}
        </span>
      </div>
      <div className="queue-sublist-items">
        {group.ids.map((id, ii) => {
          const item = state.items[id];
          if (!item) return null;
          return (
            <InsertionPendingItemRow
              key={id}
              item={item}
              hidden={hidden}
              onHide={onHide}
              onUnhide={onUnhide}
              onEdit={onEdit}
              rank={ii + 1}
              insertStatus={pendingInsertStatus(id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function InsertionListView({
  state,
  slotId,
  dbSyncRevision,
  onHide,
  onUnhide,
  onAddItem,
  onAddItems,
  onAddSlotImports,
  onReorderInSorted,
  onReturnToPending,
  onEditItem,
}: Props & { state: InsertionState }) {
  const [addOpen, setAddOpen] = useState(false);
  // See MergeListView's editingId comment — we track by id so the modal
  // re-reads from the (potentially-updated) items dict.
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingItem = editingId ? state.items[editingId] ?? null : null;
  const openEdit = (it: Item) => setEditingId(it.id);
  const hidden = useMemo(() => new Set(state.hidden), [state.hidden]);
  const existingIds = useMemo(() => activeRankingIds(state), [state]);
  const otherIds = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of Object.values(state.items)) {
      if (it.id === editingId) continue;
      m.set(it.id, it.label);
    }
    return m;
  }, [state.items, editingId]);

  const insertingId = state.current?.insertingId;
  const fromSublists = insertionSortFromSublists(state.pendingRunIds);
  const pendingGroups = useMemo(
    () => groupInsertionPending(state.pending, state.pendingRunIds),
    [state.pending, state.pendingRunIds],
  );
  const pendingUsesRuns = pendingGroups.some((g) => g.kind === 'preranked');
  const pendingEpisodeCount =
    state.pending.length + (insertingId !== undefined ? 1 : 0);
  const flatPendingIds = insertingId
    ? [insertingId, ...state.pending]
    : state.pending;

  return (
    <>
      {shouldShowCurrentComparison(state) && getInsertContext(state) && (
        <InsertContextSection
          state={state}
          onOpenEdit={openEdit}
          onHideRemaining={onHide}
          onHideTarget={onHide}
          onReorderTarget={(indexA, indexB) =>
            onReorderInSorted(indexA, indexB > indexA ? 1 : -1)
          }
          onReturnTargetToPending={onReturnToPending}
        />
      )}

      {state.done ? (
        <CompletedRankingSection
          rankedIds={completedRankingIds(state)}
          items={state.items}
          hidden={hidden}
          onHide={onHide}
          onUnhide={onUnhide}
          onEdit={openEdit}
          onReorder={(ii, dir) => onReorderInSorted(ii, dir)}
          onReturnToPending={onReturnToPending}
        />
      ) : (
        <>
          <div className="list-section-label">
            {fromSublists
              ? mergeSliceLabel('Seed sublist (sorted)', state.sorted.length)
              : `Sorted (${state.sorted.length})`}
          </div>
          <p
            style={{
              fontSize: 13,
              color: 'var(--text-muted)',
              marginTop: 0,
            }}
          >
            {fromSublists ? (
              <>
                The largest pre-ranked sublist, frozen best→worst. Other
                sublists wait in the queue below and binary-insert one item at
                a time. You can still nudge with <strong>↑ / ↓</strong>,
                re-insert with <strong>↻</strong>, or <strong>× Remove</strong>{' '}
                any row.
              </>
            ) : (
              <>
                The ranking locked in so far, best to worst — items
                binary-insert into this list one at a time. You can nudge an
                item with <strong>↑ / ↓</strong> or pull it back to re-insert
                with <strong>↻</strong> — both cancel and restart the current
                insert, costing up to ⌈log₂(N+1)⌉ extra comparisons. Use{' '}
                <strong>× Remove</strong> to drop an item from the rank.
              </>
            )}
          </p>
          <div className="queue-sublist">
            <div className="queue-sublist-items">
              {state.sorted.map((id, ii) => {
                const item = state.items[id];
                if (!item) return null;
                const isHidden = hidden.has(id);
                return (
                  <div
                    key={id}
                    className={`queue-item-row ${isHidden ? 'hidden' : ''}`}
                  >
                    <span className="rank">{ii + 1}.</span>
                    <Thumb item={item} />
                    <span className="label-cell" title={item.label}>
                      {item.label}
                    </span>
                    <span className="actions">
                      <ItemRowActions
                        item={item}
                        variant="row"
                        onEdit={openEdit}
                        reorder={
                          !isHidden && state.sorted.length > 1 ? (
                            <>
                              <button
                                className="icon-btn"
                                onClick={() => onReorderInSorted(ii, -1)}
                                disabled={ii === 0}
                                title="Nudge up (cancels and restarts the current insert)"
                              >
                                ↑
                              </button>
                              <button
                                className="icon-btn"
                                onClick={() => onReorderInSorted(ii, 1)}
                                disabled={ii === state.sorted.length - 1}
                                title="Nudge down (cancels and restarts the current insert)"
                              >
                                ↓
                              </button>
                              <button
                                className="icon-btn"
                                onClick={() => onReturnToPending(id)}
                                title="Pull this item back out and re-insert it (fresh binary search)"
                              >
                                ↻
                              </button>
                            </>
                          ) : null
                        }
                        trailing={
                          <HideOrRestoreButton
                            id={id}
                            isHidden={isHidden}
                            allowRestore={false}
                            onHide={onHide}
                            onUnhide={onUnhide}
                          />
                        }
                      />
                    </span>
                  </div>
                );
              })}
              {state.sorted.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  (no sorted items yet)
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {pendingEpisodeCount > 0 && (
        <>
          <div className="list-section-label">
            {pendingUsesRuns
              ? `Queue (${pendingEpisodeCount} item${
                  pendingEpisodeCount === 1 ? '' : 's'
                } in ${pendingGroups.length} group${
                  pendingGroups.length === 1 ? '' : 's'
                }${insertingId ? ' · 1 inserting now' : ''})`
              : mergeSliceLabel('Pending', pendingEpisodeCount)}
          </div>
          {pendingUsesRuns && (
            <p
              style={{
                fontSize: 13,
                color: 'var(--text-muted)',
                marginTop: 0,
              }}
            >
              Pre-ranked sublists keep their internal order; only comparisons
              between sublists are needed. Unranked extras drain after the
              sublists.
            </p>
          )}
          {pendingUsesRuns ? (
            <>
              {insertingId && state.items[insertingId] && (
                <div className="queue-sublist">
                  <div className="queue-sublist-items">
                    <InsertionPendingItemRow
                      item={state.items[insertingId]}
                      hidden={hidden}
                      onHide={onHide}
                      onUnhide={onUnhide}
                      onEdit={openEdit}
                      rank={1}
                      insertStatus="inserting"
                    />
                  </div>
                </div>
              )}
              {pendingGroups.map((group, gi) => (
                <InsertionPendingGroupView
                  key={
                    group.kind === 'preranked'
                      ? `run-${group.runId}`
                      : group.kind
                  }
                  group={group}
                  groupIndex={gi}
                  state={state}
                  hidden={hidden}
                  onHide={onHide}
                  onUnhide={onUnhide}
                  onEdit={openEdit}
                  isNext={gi === 0 && !insertingId}
                  insertingId={insertingId}
                />
              ))}
            </>
          ) : (
            <div className="queue-sublist">
              <div className="queue-sublist-items">
                {flatPendingIds.map((id, ii) => {
                  const item = state.items[id];
                  if (!item) return null;
                  return (
                    <InsertionPendingItemRow
                      key={id}
                      item={item}
                      hidden={hidden}
                      onHide={onHide}
                      onUnhide={onUnhide}
                      onEdit={openEdit}
                      rank={ii + 1}
                      insertStatus={
                        insertingId
                          ? id === insertingId
                            ? 'inserting'
                            : 'queued'
                          : undefined
                      }
                    />
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      <div className="add-buttons">
        <button className="btn" onClick={() => setAddOpen(true)}>
          + Add item(s)
        </button>
      </div>

      {addOpen && (
        <AddItemsModal
          engine="insertion"
          existingIds={existingIds}
          excludeSlotId={slotId || undefined}
          dbSyncRevision={dbSyncRevision}
          onCancel={() => setAddOpen(false)}
          onAddOne={(item) => {
            onAddItem(item);
            setAddOpen(false);
          }}
          onAddMany={(items) => {
            onAddItems(items);
            setAddOpen(false);
          }}
          onAddSlotImports={(batches) => {
            onAddSlotImports(batches);
            setAddOpen(false);
          }}
        />
      )}

      {editingItem && (
        <EditItemModal
          item={editingItem}
          onCancel={() => setEditingId(null)}
          onSave={(patch) => {
            onEditItem(editingItem.id, patch);
            setEditingId(null);
          }}
          allowEditId
          currentId={editingItem.id}
          otherIds={otherIds}
        />
      )}
    </>
  );
}
