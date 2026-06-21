import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getPair } from '../lib/engine';
import {
  canReorderInCurrentMerge,
  type CurrentMergeSlice,
} from '../lib/queueMergeSort';
import type {
  InsertionState,
  Item,
  MergeState,
  SortState,
} from '../lib/types';
import { AddItemsModal } from './AddItemsModal';
import { EditItemModal, type EditItemSavePayload } from './EditItemModal';
import { canOpenItemDetail, ItemDetailContext } from './itemDetailContext';
import { ItemThumb } from './ItemThumb';
import { mergeSliceLabel, groupInsertionPending, insertionSortFromSublists, type InsertionPendingGroup } from './listScreenH';

interface Props {
  state: SortState;
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
  /** Merge-only: queue a to-be-inserted id for binary-insertion. */
  onManualInsert: (id: string) => void;
  /** Merge-only: drop a to-be-inserted id permanently. */
  onForget: (id: string) => void;
  /**
   * Insertion-only: nudge an item up (-1) or down (+1) in `sorted[]`.
   * Cancels and restarts any in-flight insert frame.
   */
  onReorderInSorted: (sortedIndex: number, dir: -1 | 1) => void;
  /**
   * Insertion-only: pull an item out of `sorted[]` and re-insert it
   * via a fresh binary insertion (queued to the front of `pending`).
   */
  onReturnToPending: (id: string) => void;
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

/**
 * Info-icon button that opens the media detail panel (AnilistDetailModal)
 * for `item`, via the app-level ItemDetailContext. Mirrors EditButton's
 * chip/row variants so it slots in right beside it. Renders nothing for
 * non-AniList items (no panel to show) or when no opener is wired (tests /
 * hosts without the provider) — the same gate ItemThumb and ItemCard use.
 * This gives the LIST chips/rows parity with the COMPARE card's detail
 * button.
 */
function DetailButton({
  item,
  variant,
}: {
  item: Item;
  variant: 'chip' | 'row';
}) {
  const opener = useContext(ItemDetailContext);
  if (!opener || !canOpenItemDetail(item)) return null;
  return (
    <button
      className={variant === 'chip' ? 'x detail' : 'icon-btn'}
      onClick={(e) => {
        e.stopPropagation();
        opener(item);
      }}
      title={`Details for "${item.label}"`}
      aria-label={`Details for ${item.label}`}
    >
      ⓘ
    </button>
  );
}

/**
 * Pencil-icon button that opens the EditItemModal for `item`, paired with
 * the {@link DetailButton} so every editable item row/chip also exposes a
 * media-details affordance (AniList items only). Shared between the chip
 * variant (current merge frame, currently-inserting banner) and the
 * full-row variant (queue sublists, to-be-inserted, sorted, pending). The
 * `chip` variant uses the inline `.x`-style button class already styled
 * for chips; the `row` variant uses `.icon-btn`.
 */
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
    <>
      <DetailButton item={item} variant={variant} />
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
    </>
  );
}

function formatItemCount(total: number, hidden: number): string {
  const base = `${total} item${total === 1 ? '' : 's'}`;
  if (hidden === 0) return base;
  return `${base} (${hidden} hidden)`;
}

/** True when the active compare pair is an insert frame (not merge heads). */
function isInsertComparison(state: SortState): boolean {
  if (state.engine === 'insertion') return true;
  return !!(
    state.currentManualInsert ||
    (state.currentAutoInsert && state.currentAutoInsert.frame)
  );
}

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

function CurrentComparisonSection({
  state,
  onOpenEdit,
  onHideLeft,
}: {
  state: SortState;
  onOpenEdit: (item: Item) => void;
  /** Insertion engine only: × on the left (inserting) card. */
  onHideLeft?: (id: string) => void;
}) {
  const pair = getPair(state);
  if (!pair) return null;

  const left = state.items[pair.leftId];
  const right = state.items[pair.rightId];
  if (!left || !right) return null;

  const isInsert = isInsertComparison(state);
  const leftRole = isInsert ? 'Inserting' : 'Left';
  const rightRole = isInsert ? 'Probe' : 'Right';

  return (
    <div className="list-merging">
      <div className="list-section-label">Current comparison</div>
      <p
        style={{
          fontSize: 13,
          color: 'var(--text-muted)',
          marginTop: 0,
          marginBottom: 8,
        }}
      >
        The same two items shown on the RANK tab — edit labels here without
        leaving LIST.
      </p>
      <div className="queue-sublist">
        <div className="queue-sublist-items">
          <div className="queue-item-row">
            <span
              style={{
                fontSize: 12,
                color: 'var(--text-muted)',
                minWidth: 72,
              }}
            >
              A · {leftRole}
            </span>
            <Thumb item={left} />
            <span className="label-cell" title={left.label}>
              {left.label}
            </span>
            <EditButton item={left} onOpen={onOpenEdit} variant="row" />
            {onHideLeft && (
              <button
                className="icon-btn danger"
                onClick={() => onHideLeft(left.id)}
                title="Remove this item — skip inserting it and move on"
                aria-label={`Remove ${left.label}`}
              >
                ×
              </button>
            )}
          </div>
          <div className="queue-item-row">
            <span
              style={{
                fontSize: 12,
                color: 'var(--text-muted)',
                minWidth: 72,
              }}
            >
              B · {rightRole}
            </span>
            <Thumb item={right} />
            <span className="label-cell" title={right.label}>
              {right.label}
            </span>
            <EditButton item={right} onOpen={onOpenEdit} variant="row" />
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
  const itemCount = useMemo(
    () => Object.keys(props.state.items).length,
    [props.state.items],
  );
  const hiddenCount = props.state.hidden.length;

  return (
    <div className="page">
      <ListSlotHeader
        slotId={props.slotId}
        slotName={props.slotName}
        itemCount={itemCount}
        hiddenCount={hiddenCount}
        onRename={props.onRenameSlot}
      />
      {props.state.engine === 'insertion' ? (
        <InsertionListView {...props} state={props.state} />
      ) : (
        <MergeListView {...props} state={props.state} />
      )}
    </div>
  );
}

// ============================================================================
// MERGE VIEW — original list screen + "To be inserted (N)" section
// (items exiled from a merge close, awaiting an explicit Insert or Forget)
// ============================================================================

function MergeListView({
  state,
  onHide,
  onUnhide,
  onReorder,
  onReorderInCurrentMerge,
  onBreakApart,
  onAddItem,
  onAddItems,
  onAppendPreRanked,
  onManualInsert,
  onForget,
  onEditItem,
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
  const existingIds = useMemo(
    () => new Set(Object.keys(state.items)),
    [state.items],
  );
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
      {shouldShowCurrentComparison(state) && (
        <CurrentComparisonSection
          state={state}
          onOpenEdit={openEdit}
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

      <div className="list-section-label">
        Queue ({state.queue.length} sublist{state.queue.length === 1 ? '' : 's'})
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
            These items were removed mid-merge and have not been re-inserted
            into the ranking yet. Click <strong>↺ Insert</strong> to
            binary-search them into a queue sublist, or{' '}
            <strong>× Forget</strong> to drop them from the rank.
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
                  <EditButton item={item} onOpen={openEdit} variant="row" />
                  <button
                    className="icon-btn"
                    onClick={() => onManualInsert(id)}
                    disabled={queued || inserting}
                    title="Binary-search this item back into the ranking"
                  >
                    ↺ Insert
                  </button>
                  <button
                    className="icon-btn danger"
                    onClick={() => onForget(id)}
                    title="Drop this item from the rank permanently"
                  >
                    × Forget
                  </button>
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
              {ids.length > 1 && (
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
              )}
              <EditButton item={item} onOpen={onEdit} variant="chip" />
              {isHidden ? (
                <button
                  className="x"
                  onClick={() => onUnhide(id)}
                  title="Restore item"
                  aria-label={`Restore ${item.label}`}
                >
                  ↺
                </button>
              ) : (
                <button
                  className="x"
                  onClick={() => onHide(id)}
                  title="Remove item"
                  aria-label={`Remove ${item.label}`}
                >
                  ×
                </button>
              )}
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
                {sub.length > 1 && (
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
                )}
              </span>
              <span className="actions">
                <EditButton item={item} onOpen={onEdit} variant="row" />
                {isHidden ? (
                  <button
                    className="icon-btn"
                    onClick={() => onUnhide(id)}
                    title="Restore"
                  >
                    ↺
                  </button>
                ) : (
                  <button
                    className="icon-btn danger"
                    onClick={() => onHide(id)}
                    title="Remove"
                  >
                    ×
                  </button>
                )}
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
}: {
  item: Item;
  hidden: Set<string>;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  onEdit: (item: Item) => void;
  rank?: number;
}) {
  const isHidden = hidden.has(item.id);
  return (
    <div className={`queue-item-row ${isHidden ? 'hidden' : ''}`}>
      {rank !== undefined && <span className="rank">{rank}.</span>}
      <Thumb item={item} />
      <span className="label-cell" title={item.label}>
        {item.label}
      </span>
      <span className="actions">
        <EditButton item={item} onOpen={onEdit} variant="row" />
        {isHidden ? (
          <button
            className="icon-btn"
            onClick={() => onUnhide(item.id)}
            title="Restore"
          >
            ↺
          </button>
        ) : (
          <button
            className="icon-btn danger"
            onClick={() => onHide(item.id)}
            title="Skip this item"
          >
            ×
          </button>
        )}
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
}: {
  group: InsertionPendingGroup;
  groupIndex: number;
  state: InsertionState;
  hidden: Set<string>;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  onEdit: (item: Item) => void;
  isNext: boolean;
}) {
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
            />
          );
        })}
      </div>
    </div>
  );
}

function InsertionListView({
  state,
  onHide,
  onUnhide,
  onAddItem,
  onAddItems,
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
  const existingIds = useMemo(
    () => new Set(Object.keys(state.items)),
    [state.items],
  );
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

  return (
    <>
      {shouldShowCurrentComparison(state) && (
        <CurrentComparisonSection
          state={state}
          onOpenEdit={openEdit}
          onHideLeft={onHide}
        />
      )}

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
            The largest pre-ranked sublist, frozen best→worst. Other sublists
            wait in the queue below and binary-insert one item at a time.
            You can still nudge with <strong>↑ / ↓</strong>, re-insert with{' '}
            <strong>↻</strong>, or <strong>× Remove</strong> any row.
          </>
        ) : (
          <>
            The ranking locked in so far, best to worst — items binary-insert
            into this list one at a time. You can nudge an item with{' '}
            <strong>↑ / ↓</strong> or pull it back to re-insert with{' '}
            <strong>↻</strong> — both cancel and restart the current insert,
            costing up to ⌈log₂(N+1)⌉ extra comparisons. Use{' '}
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
                {!isHidden && state.sorted.length > 1 && (
                  <span className="actions">
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
                  </span>
                )}
                <span className="actions">
                  <EditButton item={item} onOpen={openEdit} variant="row" />
                  {isHidden ? (
                    <button
                      className="icon-btn"
                      onClick={() => onUnhide(id)}
                      title="Restore"
                    >
                      ↺
                    </button>
                  ) : (
                    <button
                      className="icon-btn danger"
                      onClick={() => onHide(id)}
                      title="Remove"
                    >
                      ×
                    </button>
                  )}
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

      {state.pending.length > 0 && (
        <>
          <div className="list-section-label">
            {pendingUsesRuns
              ? `Queue (${state.pending.length} item${
                  state.pending.length === 1 ? '' : 's'
                } in ${pendingGroups.length} group${
                  pendingGroups.length === 1 ? '' : 's'
                })`
              : `Pending (${state.pending.length})`}
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
            pendingGroups.map((group, gi) => (
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
              />
            ))
          ) : (
            <div className="queue-sublist">
              <div className="queue-sublist-items">
                {state.pending.map((id) => {
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
          onCancel={() => setAddOpen(false)}
          onAddOne={(item) => {
            onAddItem(item);
            setAddOpen(false);
          }}
          onAddMany={(items) => {
            onAddItems(items);
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
