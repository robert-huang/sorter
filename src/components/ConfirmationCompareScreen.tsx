import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConfirmationState, Item, ItemId } from '../lib/types';
import { getCompareProgress, getPair } from '../lib/engine';
import { activeRankingIds } from '../lib/sortPopulation';
import { getInsertContext } from './listScreenH';
import {
  COMPARE_EXIT_ANIM_NAMES,
  COMPARE_RUSH_DURATION_MS,
  confirmationAnimKinds,
  insertingItemLanded,
  type ConfirmationComparePhase,
  type SlotAnimKind,
} from './compareScreenH';
import type { LastInteraction } from './CompareScreen';
import { ItemCard } from './ItemCard';
import { ItemThumb } from './ItemThumb';
import { DetailButtonSlot } from './DetailButton';
import { EditItemModal, type EditItemSavePayload } from './EditItemModal';
import { AddItemsModal } from './AddItemsModal';
import type { SlotResultsImportBatch } from '../lib/completedSortEditH';

interface Props {
  state: ConfirmationState;
  lastInteraction: LastInteraction;
  onPickLeft: () => void;
  onPickRight: () => void;
  onHide: (id: ItemId) => void;
  onEditItem: (id: ItemId, patch: EditItemSavePayload) => void;
  onReorderConfirmed: (index: number, direction: -1 | 1) => void;
  onReturnToPending: (id: ItemId) => void;
  autoInsertEnabled: boolean;
  slotId: string;
  dbSyncRevision: number;
  onAddItem: (item: Item) => void;
  onAddItems: (items: Item[]) => void;
  onAddSlotImports: (batches: SlotResultsImportBatch[]) => void;
}

interface OutgoingPair {
  id: number;
  leftExiting: Item | null;
  rightExiting: Item | null;
  pickedSide: 'left' | 'right';
  exitKind: 'slide';
  leftHidden: boolean;
  rightHidden: boolean;
}

function ListThumb({ item }: { item: Item }) {
  return <ItemThumb item={item} className="thumb" placeholderClass="" />;
}

function rowClassName(
  state: ConfirmationState,
  id: ItemId,
  index: number,
  hidden: Set<ItemId>,
): string {
  const base = `queue-item-row${hidden.has(id) ? ' hidden' : ''}`;
  if (state.phase !== 'insert') return base;
  const ctx = getInsertContext(state);
  if (!ctx) return base;
  const inWindow = index >= ctx.windowLo && index <= ctx.windowHi;
  const isProbe = id === ctx.probeId;
  return (
    `${base} list-merge-context-row` +
    (inWindow ? ' list-merge-context-in-window' : ' list-merge-context-out-of-window') +
    (isProbe ? ' list-merge-context-active' : '')
  );
}

export function ConfirmationCompareScreen({
  state,
  lastInteraction,
  onPickLeft,
  onPickRight,
  onHide,
  onEditItem,
  onReorderConfirmed,
  onReturnToPending,
  autoInsertEnabled,
  slotId,
  dbSyncRevision,
  onAddItem,
  onAddItems,
  onAddSlotImports,
}: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingItem = editingId ? state.items[editingId] ?? null : null;
  const otherIds = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of Object.values(state.items)) {
      if (it.id === editingId) continue;
      m.set(it.id, it.label);
    }
    return m;
  }, [state.items, editingId]);
  const existingIds = useMemo(() => activeRankingIds(state), [state]);

  const pair = getPair(state);
  const hidden = useMemo(() => new Set(state.hidden), [state.hidden]);
  const { pct } = getCompareProgress(state, { autoInsertEnabled });
  const insertCtx = state.phase === 'insert' ? getInsertContext(state) : null;

  const phase: ConfirmationComparePhase =
    state.phase === 'insert' ? 'insert' : 'confirm';
  const isInsertPhase = phase === 'insert' && !!state.insertFrame;
  const insertingId = isInsertPhase
    ? state.insertFrame?.insertingId ?? null
    : null;

  // Confirm: left hero = frontier, right = candidate.
  // Insert: left hero = probe, right = inserting candidate (same card as confirm).
  const heroId = isInsertPhase
    ? pair?.rightId ?? null
    : state.confirmed[state.confirmed.length - 1] ?? null;
  const rightCardId = isInsertPhase
    ? pair?.leftId ?? null
    : pair?.rightId ?? null;
  const visualPair =
    heroId && rightCardId
      ? { leftId: heroId, rightId: rightCardId }
      : null;

  const heroItem = heroId ? state.items[heroId] : null;
  const rightItem = rightCardId ? state.items[rightCardId] : null;

  const listIds = state.confirmed;
  const showList = listIds.length > 0;

  const prevPairRef = useRef<{ leftId: ItemId; rightId: ItemId } | null>(null);
  const prevPhaseRef = useRef<ConfirmationComparePhase | null>(null);
  const [outgoing, setOutgoing] = useState<OutgoingPair | null>(null);
  const outgoingRef = useRef<OutgoingPair | null>(null);
  const outgoingCounterRef = useRef(0);
  const exitFinishCountRef = useRef(0);
  const [popInKeyLeft, setPopInKeyLeft] = useState(0);
  const [popInKeyRight, setPopInKeyRight] = useState(0);
  const [leftRevealed, setLeftRevealed] = useState(true);
  const [rightRevealed, setRightRevealed] = useState(true);
  const incomingAnimatedRef = useRef({ left: false, right: false });
  const overlayContainerRef = useRef<HTMLDivElement | null>(null);
  const deckBumpRafRef = useRef<{ left?: number; right?: number }>({});

  function cancelDeferredDeckBumps(): void {
    const raf = deckBumpRafRef.current;
    if (raf.left !== undefined) {
      cancelAnimationFrame(raf.left);
      raf.left = undefined;
    }
    if (raf.right !== undefined) {
      cancelAnimationFrame(raf.right);
      raf.right = undefined;
    }
  }

  function scheduleDeferredDeckBump(
    side: 'left' | 'right',
    bump: () => void,
  ): void {
    const raf = deckBumpRafRef.current;
    const prev = raf[side];
    if (prev !== undefined) cancelAnimationFrame(prev);
    raf[side] = requestAnimationFrame(() => {
      raf[side] = undefined;
      bump();
    });
  }

  const { left: leftAnimKind, right: rightAnimKind } = useMemo<{
    left: SlotAnimKind;
    right: SlotAnimKind;
  }>(() => {
    const prev = prevPairRef.current;
    const prevPhase = prevPhaseRef.current;
    const vp = visualPair;
    if (!vp || !prev || !prevPhase) {
      return { left: 'pop', right: 'pop' };
    }
    return confirmationAnimKinds(prev, vp, prevPhase, phase, insertingId);
  }, [visualPair?.leftId, visualPair?.rightId, phase, insertingId]);

  useEffect(() => {
    outgoingRef.current = outgoing;
  }, [outgoing]);

  useLayoutEffect(() => {
    const prev = prevPairRef.current;
    const prevPhase = prevPhaseRef.current;
    const landed =
      prevPhase === 'insert' &&
      insertingItemLanded(prevPhase, prev, insertingId);

    if (!visualPair) {
      if (prev && landed && lastInteraction?.kind === 'pick') {
        const oldLeft = state.items[prev.leftId] ?? null;
        const oldRight = state.items[prev.rightId] ?? null;
        prevPairRef.current = null;
        prevPhaseRef.current = null;
        if (!oldLeft && !oldRight) return;

        const newOutgoing: OutgoingPair = {
          id: ++outgoingCounterRef.current,
          leftExiting: oldLeft,
          rightExiting: oldRight,
          pickedSide:
            lastInteraction.side === 'left' ? 'left' : 'right',
          exitKind: 'slide',
          leftHidden: !!oldLeft,
          rightHidden: !!oldRight,
        };

        if (outgoingRef.current === null) {
          incomingAnimatedRef.current = { left: false, right: false };
          cancelDeferredDeckBumps();
          setOutgoing(newOutgoing);
          if (oldLeft) setLeftRevealed(false);
          if (oldRight) setRightRevealed(false);
        }
      } else {
        prevPairRef.current = null;
        prevPhaseRef.current = null;
      }
      return;
    }

    prevPairRef.current = {
      leftId: visualPair.leftId,
      rightId: visualPair.rightId,
    };
    prevPhaseRef.current = phase;
    if (!prev) return;

    const sameLeft = prev.leftId === visualPair.leftId;
    const sameRight = prev.rightId === visualPair.rightId;
    if (sameLeft && sameRight) return;

    const modeBoundary = prevPhase !== phase;
    const bumpLeft = !sameLeft || modeBoundary;
    const bumpRight = !sameRight || modeBoundary || landed;

    if (lastInteraction?.kind !== 'pick') {
      if (bumpLeft) setPopInKeyLeft((k) => k + 1);
      if (bumpRight) setPopInKeyRight((k) => k + 1);
      return;
    }

    let oldLeft =
      sameLeft && !modeBoundary
        ? null
        : state.items[prev.leftId] ?? null;
    let oldRight =
      sameRight && !modeBoundary && !landed
        ? null
        : state.items[prev.rightId] ?? null;

    if (!oldLeft && !oldRight) {
      if (bumpLeft) setPopInKeyLeft((k) => k + 1);
      if (bumpRight) setPopInKeyRight((k) => k + 1);
      return;
    }

    const newOutgoing: OutgoingPair = {
      id: ++outgoingCounterRef.current,
      leftExiting: oldLeft,
      rightExiting: oldRight,
      pickedSide: lastInteraction.side,
      exitKind: 'slide',
      leftHidden: !!oldLeft && leftAnimKind !== 'deck',
      rightHidden: !!oldRight && rightAnimKind !== 'deck',
    };

    if (outgoingRef.current === null) {
      incomingAnimatedRef.current = { left: false, right: false };
      cancelDeferredDeckBumps();
      setOutgoing(newOutgoing);
      if (oldLeft) {
        if (newOutgoing.leftHidden) setLeftRevealed(false);
        else if (bumpLeft) {
          scheduleDeferredDeckBump('left', () => {
            setPopInKeyLeft((k) => k + 1);
            incomingAnimatedRef.current.left = true;
          });
        }
      } else if (bumpLeft) {
        setPopInKeyLeft((k) => k + 1);
        incomingAnimatedRef.current.left = true;
      }
      if (oldRight) {
        if (newOutgoing.rightHidden) setRightRevealed(false);
        else if (bumpRight) {
          scheduleDeferredDeckBump('right', () => {
            setPopInKeyRight((k) => k + 1);
            incomingAnimatedRef.current.right = true;
          });
        }
      } else if (bumpRight) {
        setPopInKeyRight((k) => k + 1);
        incomingAnimatedRef.current.right = true;
      }
    } else {
      cancelDeferredDeckBumps();
      if (overlayContainerRef.current) {
        overlayContainerRef.current.style.setProperty(
          '--anim-duration',
          `${COMPARE_RUSH_DURATION_MS}ms`,
        );
      }
      setLeftRevealed(true);
      setRightRevealed(true);
      if (bumpLeft) {
        setPopInKeyLeft((k) => k + 1);
        incomingAnimatedRef.current.left = true;
      }
      if (bumpRight) {
        setPopInKeyRight((k) => k + 1);
        incomingAnimatedRef.current.right = true;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visualPair?.leftId, visualPair?.rightId, phase, lastInteraction, insertingId]);

  function handleOverlayAnimationEnd(
    e: React.AnimationEvent<HTMLDivElement>,
  ): void {
    if (!COMPARE_EXIT_ANIM_NAMES.has(e.animationName)) return;
    exitFinishCountRef.current += 1;
    const cur = outgoingRef.current;
    const expected =
      (cur?.leftExiting ? 1 : 0) + (cur?.rightExiting ? 1 : 0);
    if (exitFinishCountRef.current < expected) return;
    exitFinishCountRef.current = 0;
    const leftWasExiting = !!cur?.leftExiting;
    const rightWasExiting = !!cur?.rightExiting;
    setOutgoing(null);
    if (leftWasExiting) {
      setLeftRevealed(true);
      if (cur?.leftHidden && !incomingAnimatedRef.current.left) {
        setPopInKeyLeft((k) => k + 1);
      }
    }
    if (rightWasExiting) {
      setRightRevealed(true);
      if (cur?.rightHidden && !incomingAnimatedRef.current.right) {
        setPopInKeyRight((k) => k + 1);
      }
    }
    incomingAnimatedRef.current = { left: false, right: false };
    if (overlayContainerRef.current) {
      overlayContainerRef.current.style.removeProperty('--anim-duration');
    }
  }

  const leftSlotClass = `compare-confirmation-hero compare-slot compare-slot--left${
    leftRevealed ? '' : ' compare-slot--hidden'
  }`;
  const rightSlotClass = `compare-slot compare-slot--right${
    rightRevealed ? '' : ' compare-slot--hidden'
  }`;

  return (
    <div className="page">
      <div className="compare-progress" title={`${pct}%`}>
        <div className="compare-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="compare-help">
        Which do you prefer? Click a card or use ← / → · ↑ to undo · middle-click to open link
      </div>
      <div className="add-buttons compare-add-buttons">
        <button type="button" className="btn" onClick={() => setAddOpen(true)}>
          + Add item(s)
        </button>
      </div>
      <div className="compare compare--confirmation">
        <div className="compare-confirmation-pair">
          <div className={leftSlotClass} data-anim={leftAnimKind}>
            {heroItem ? (
              <ItemCard
                key={popInKeyLeft}
                item={heroItem}
                onPick={onPickLeft}
                onRemove={() => onHide(heroItem.id)}
              />
            ) : (
              <div className="compare-confirmation-empty">No confirmed items yet</div>
            )}
          </div>
          <div className={rightSlotClass} data-anim={rightAnimKind}>
            {rightItem ? (
              <ItemCard
                key={popInKeyRight}
                item={rightItem}
                onPick={onPickRight}
                onRemove={() => onHide(rightItem.id)}
              />
            ) : (
              <div className="compare-confirmation-empty">Done</div>
            )}
          </div>
          {outgoing && (
            <div
              ref={overlayContainerRef}
              className={`compare-overlay compare-overlay--exit-${outgoing.exitKind}`}
              onAnimationEnd={handleOverlayAnimationEnd}
              key={`overlay-${outgoing.id}`}
            >
              <div
                className={
                  outgoing.leftExiting
                    ? `compare-overlay-slot exiting-left${
                        outgoing.pickedSide === 'left' ? ' picked' : ''
                      }`
                    : 'compare-overlay-slot'
                }
              >
                {outgoing.leftExiting && (
                  <ItemCard item={outgoing.leftExiting} disabled />
                )}
              </div>
              <div
                className={
                  outgoing.rightExiting
                    ? `compare-overlay-slot exiting-right${
                        outgoing.pickedSide === 'right' ? ' picked' : ''
                      }`
                    : 'compare-overlay-slot'
                }
              >
                {outgoing.rightExiting && (
                  <ItemCard item={outgoing.rightExiting} disabled />
                )}
              </div>
            </div>
          )}
        </div>
        {showList && (
          <div className="compare-confirmation-list-col">
            <div className="compare-confirmation-list queue-sublist">
              <div className="queue-sublist-items">
                {listIds.map((id, index) => {
                  const item = state.items[id];
                  if (!item) return null;
                  const isProbe = insertCtx?.probeId === id;
                  return (
                    <div
                      key={id}
                      className={rowClassName(state, id, index, hidden)}
                    >
                      <span className="rank">{index + 1}.</span>
                      <ListThumb item={item} />
                      <span className="label-cell" title={item.label}>
                        {item.label}
                      </span>
                      <span className="actions">
                        {isProbe && (
                          <span className="list-merge-context-tag">probe</span>
                        )}
                        <DetailButtonSlot item={item} variant="row" />
                        <button
                          type="button"
                          className="icon-btn"
                          disabled={index === 0}
                          onClick={() => onReorderConfirmed(index, -1)}
                          title="Move up"
                          aria-label={`Move ${item.label} up`}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          disabled={index === listIds.length - 1}
                          onClick={() => onReorderConfirmed(index, 1)}
                          title="Move down"
                          aria-label={`Move ${item.label} down`}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => onReturnToPending(id)}
                          title="Pull out and re-confirm"
                          aria-label={`Re-confirm ${item.label}`}
                        >
                          ↻
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => setEditingId(id)}
                          title={`Edit "${item.label}"`}
                          aria-label={`Edit ${item.label}`}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => onHide(id)}
                          title="Remove"
                          aria-label={`Remove ${item.label}`}
                        >
                          ×
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
      {addOpen && (
        <AddItemsModal
          engine="confirmation"
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
    </div>
  );
}
