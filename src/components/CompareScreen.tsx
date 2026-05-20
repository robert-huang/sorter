import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Item, ItemId, SortState } from '../lib/types';
import { comparisonsRemaining, getPair } from '../lib/engine';
import { ItemCard } from './ItemCard';

/**
 * The last user action that *can change the current pair*. Surfaced from
 * App so both click and keyboard pickers feed the same animation pipeline,
 * and so a same-side pick twice in a row still re-runs the effect (same
 * side, same kind — React re-fires because the object identity is fresh).
 */
export type LastInteraction =
  | { kind: 'pick'; side: 'left' | 'right' }
  | { kind: 'undo' }
  | null;

interface Props {
  state: SortState;
  lastInteraction: LastInteraction;
  onPickLeft: () => void;
  onPickRight: () => void;
  onHide: (id: ItemId) => void;
  /** Cancel an in-flight manual insert (merge engine only). */
  onCancelManualInsert: () => void;
  /**
   * Whether the merge engine may auto-insert popped pairs (engine setting).
   * Threaded through here only to make the progress-bar forecast match what
   * advance() will actually do — no other UI here depends on it.
   */
  autoInsertEnabled: boolean;
}

/**
 * What kind of comparison the user is being asked to make right now.
 *  - 'merging' — a normal merge frame (left=head of left, right=head of right)
 *  - 'manual-insert' — a user-triggered insert mini-session on the merge
 *    engine (an exiled item being binary-inserted into a queue sublist).
 *    Cancelable via the banner's Cancel button.
 *  - 'auto-insert' — an engine-triggered auto-insert frame on the merge
 *    engine (a small side being binary-inserted into a much larger
 *    target sublist). Not cancelable as a session — to opt out, the
 *    user disables auto-insert in settings; to skip an individual item
 *    they hide it.
 *  - 'inserting' — the insertion engine's full-session binary insertion
 */
type CompareMode = 'merging' | 'manual-insert' | 'auto-insert' | 'inserting';

function currentMode(state: SortState): CompareMode {
  if (state.engine === 'insertion') return 'inserting';
  if (state.currentManualInsert) return 'manual-insert';
  if (state.currentAutoInsert && state.currentAutoInsert.frame) return 'auto-insert';
  return 'merging';
}

interface OutgoingPair {
  id: number;
  // Either or both can be set. In merge sort the *picked* side is the one
  // that advances (e.g. picking left → left[i] is decided, left[i+1] takes
  // its place, right stays), so the common case is exactly one of these
  // being non-null. When a merge finishes and the queue pops a fresh
  // pair, both are non-null (Case B — full pair turnover).
  leftExiting: Item | null;
  rightExiting: Item | null;
  pickedSide: 'left' | 'right';
}

/** When a new pick lands while an exit is in flight, we re-pace the live
 *  overlay's CSS animation to this duration via the --anim-duration custom
 *  property so it finishes quickly and the next pick can play. */
const RUSH_DURATION_MS = 70;

/** Animation names we listen for to know an exit cycle finished. Fires
 *  once per exiting side (so 1 or 2 per outgoing pair). */
const EXIT_ANIM_NAMES = new Set(['cardSlideOutLeft', 'cardSlideOutRight']);

export function CompareScreen({
  state,
  lastInteraction,
  onPickLeft,
  onPickRight,
  onHide,
  onCancelManualInsert,
  autoInsertEnabled,
}: Props) {
  const pair = getPair(state);
  const mode = currentMode(state);
  // During any insert mode the "left" item is the one being inserted,
  // and hiding it would cancel the mini-session in a confusing way. We
  // hide the trash button on the left card in those modes.
  const hideRemoveOnLeft = mode !== 'merging';
  const insertingId = (() => {
    if (state.engine === 'insertion') return state.current?.insertingId ?? null;
    if (state.currentManualInsert) return state.currentManualInsert.insertingId;
    if (state.currentAutoInsert && state.currentAutoInsert.frame) {
      return state.currentAutoInsert.frame.insertingId;
    }
    return null;
  })();
  const insertingLabel = insertingId
    ? state.items[insertingId]?.label ?? insertingId
    : null;

  // -------- pair-change animation pipeline --------
  // The pair just rendered on the previous render (for change detection).
  const prevPairRef = useRef<{ leftId: ItemId; rightId: ItemId } | null>(null);
  // The overlay currently being animated off-screen. There is at most one
  // visible at a time; backed-up exits queue on queueRef.
  const [outgoing, setOutgoing] = useState<OutgoingPair | null>(null);
  // Mirror of `outgoing` in a ref so the pair-change effect can read it
  // without needing it in its dep array (which would re-fire wrongly).
  const outgoingRef = useRef<OutgoingPair | null>(null);
  const queueRef = useRef<OutgoingPair[]>([]);
  const outgoingCounterRef = useRef(0);
  // Counts up as each overlay child fires its animationend. The expected
  // total is 1 or 2 depending on how many sides of the outgoing pair are
  // actually animating off-screen. Resets when the next outgoing drains.
  const exitFinishCountRef = useRef(0);
  // Per-side pop-in key: bumped exactly when that side becomes (re-)visible,
  // so the in-grid <div> key changes and its pop-in animation replays from
  // frame 0. A side's key is only bumped when *that side* changed (when the
  // retained side stays put across a pick, its key never changes and the
  // card doesn't re-mount or animate).
  const [popInKeyLeft, setPopInKeyLeft] = useState(0);
  const [popInKeyRight, setPopInKeyRight] = useState(0);
  // Per-side revealed flag. When a pick starts a leisurely exit on a given
  // side, that side's new card is mounted into the slot but suppressed via
  // .compare-slot--hidden so the user only sees it after the previous card
  // on that side has fully faded. Flips back to true either when the exit
  // overlay finishes (leisurely tail) or the moment a follow-up pick
  // interrupts (snappy). The side that *isn't* being replaced is never
  // hidden — the retained card stays visible the entire time.
  const [leftRevealed, setLeftRevealed] = useState(true);
  const [rightRevealed, setRightRevealed] = useState(true);
  const overlayContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    outgoingRef.current = outgoing;
  }, [outgoing]);

  // useLayoutEffect (not useEffect) so the hidden class lands in the same
  // paint as the new-pair render. Otherwise the user briefly sees the new
  // cards before they're hidden, producing a flicker on every slow pick.
  useLayoutEffect(() => {
    if (!pair) {
      prevPairRef.current = null;
      return;
    }
    const prev = prevPairRef.current;
    prevPairRef.current = { leftId: pair.leftId, rightId: pair.rightId };
    if (!prev) return; // first mount — first pair pops in via the CSS rule itself
    const sameLeft = prev.leftId === pair.leftId;
    const sameRight = prev.rightId === pair.rightId;
    if (sameLeft && sameRight) return;

    // Non-pick pair changes (undo, slot switch, etc.) skip the slide-out
    // overlay entirely — the changed side(s) just pop in fresh.
    if (lastInteraction?.kind !== 'pick') {
      if (!sameLeft) setPopInKeyLeft((k) => k + 1);
      if (!sameRight) setPopInKeyRight((k) => k + 1);
      return;
    }

    // Build the outgoing pair — only sides that actually changed are
    // included. In merge sort picking left advances left (oldLeft slides
    // off, oldRight retains), and vice versa. The retained side gets
    // nothing here so it never animates and stays visible the whole time.
    const oldLeft = sameLeft ? null : state.items[prev.leftId] ?? null;
    const oldRight = sameRight ? null : state.items[prev.rightId] ?? null;

    if (!oldLeft && !oldRight) {
      // Both sides changed but neither old item is available (rare —
      // e.g. previous items hidden mid-sort). Fall back to plain pop-in.
      if (!sameLeft) setPopInKeyLeft((k) => k + 1);
      if (!sameRight) setPopInKeyRight((k) => k + 1);
      return;
    }

    const newOutgoing: OutgoingPair = {
      id: ++outgoingCounterRef.current,
      leftExiting: oldLeft,
      rightExiting: oldRight,
      pickedSide: lastInteraction.side,
    };

    if (outgoingRef.current === null) {
      // LEISURELY: start the exit and hide the *entering* side(s). The
      // reveal + pop-in fire from handleOverlayAnimationEnd when the
      // queue drains. Sides that changed but couldn't get an exit overlay
      // (old item missing) still pop in immediately.
      setOutgoing(newOutgoing);
      if (oldLeft) setLeftRevealed(false);
      else if (!sameLeft) setPopInKeyLeft((k) => k + 1);
      if (oldRight) setRightRevealed(false);
      else if (!sameRight) setPopInKeyRight((k) => k + 1);
    } else {
      // INTERRUPT: rush the in-flight exit by re-pacing its CSS animation
      // duration to RUSH_DURATION_MS (via a CSS variable on the overlay
      // container, which children inherit), queue this pair to start as
      // soon as the rushed pair ends, AND reveal the new cards now — the
      // snappy "pick again immediately and the next pair is already
      // there" feel. Only sides that just changed get a fresh pop-in;
      // the retained side keeps its current mount.
      if (overlayContainerRef.current) {
        overlayContainerRef.current.style.setProperty(
          '--anim-duration',
          `${RUSH_DURATION_MS}ms`,
        );
      }
      queueRef.current.push(newOutgoing);
      setLeftRevealed(true);
      setRightRevealed(true);
      if (!sameLeft) setPopInKeyLeft((k) => k + 1);
      if (!sameRight) setPopInKeyRight((k) => k + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair?.leftId, pair?.rightId, lastInteraction]);

  function handleOverlayAnimationEnd(
    e: React.AnimationEvent<HTMLDivElement>,
  ): void {
    if (!EXIT_ANIM_NAMES.has(e.animationName)) return;
    exitFinishCountRef.current += 1;
    const cur = outgoingRef.current;
    const expected =
      (cur?.leftExiting ? 1 : 0) + (cur?.rightExiting ? 1 : 0);
    if (exitFinishCountRef.current < expected) return;
    exitFinishCountRef.current = 0;
    // Capture which sides this exit was covering before we swap it out —
    // they're the ones that may need revealing on the leisurely tail.
    const leftWasExiting = !!cur?.leftExiting;
    const rightWasExiting = !!cur?.rightExiting;
    const next = queueRef.current.shift() ?? null;
    setOutgoing(next);
    if (!next) {
      // Queue drained — leisurely tail. Reveal the side(s) this exit was
      // covering and replay their pop-in. When `next` is non-null we were
      // interrupted, in which case the interrupt branch above already
      // revealed + re-keyed the slots and we leave them alone while the
      // queued exit plays on top.
      if (leftWasExiting) {
        setLeftRevealed(true);
        setPopInKeyLeft((k) => k + 1);
      }
      if (rightWasExiting) {
        setRightRevealed(true);
        setPopInKeyRight((k) => k + 1);
      }
    }
  }

  if (state.done) {
    return (
      <div className="page">
        <div className="page-section" style={{ textAlign: 'center' }}>
          <h2>All done!</h2>
          <p style={{ color: 'var(--text-muted)' }}>
            Switch to the RESULT tab to see your ranking.
          </p>
        </div>
      </div>
    );
  }

  if (!pair) {
    return (
      <div className="page">
        <div className="page-section" style={{ textAlign: 'center' }}>
          <h2>Nothing to compare</h2>
          <p style={{ color: 'var(--text-muted)' }}>
            Add some items on the START tab first.
          </p>
        </div>
      </div>
    );
  }

  const left = state.items[pair.leftId];
  const right = state.items[pair.rightId];

  // Progress bar bookkeeping — moved out of the always-on header into the
  // rank screen so it's only visible when there's actually a sort in
  // flight. Denominator is the max-so-far ("totalComparisonsEverNeeded")
  // so mid-sort growth (adding items / pre-ranked sublists) bumps the bar
  // back rather than letting it appear to retreat. The autoInsertEnabled
  // prop feeds the per-pair forecast so the bar matches what advance()
  // will actually do.
  const total = state.totalComparisonsEverNeeded ?? 0;
  const remaining = comparisonsRemaining(state, { autoInsertEnabled });
  const completed = Math.max(0, total - remaining);
  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;

  const leftSlotClass = `compare-slot${leftRevealed ? '' : ' compare-slot--hidden'}`;
  const rightSlotClass = `compare-slot${rightRevealed ? '' : ' compare-slot--hidden'}`;

  // Banner shown above the compare grid identifying the current mode.
  // Drives both UI clarity (user knows whether this is "the merge", a
  // user-triggered manual insert, or an engine-triggered auto insert)
  // and the Cancel affordance (only for manual inserts).
  let banner: JSX.Element | null = null;
  if (mode === 'manual-insert' && insertingLabel) {
    banner = (
      <div className="compare-banner">
        <span className="compare-banner-label">
          Inserting <strong>{insertingLabel}</strong> into queue sublist
        </span>
        <button
          type="button"
          className="btn"
          onClick={onCancelManualInsert}
          title="Cancel this insert and return the item to the To be inserted bucket"
        >
          Cancel insertion
        </button>
      </div>
    );
  } else if (mode === 'auto-insert' && insertingLabel) {
    banner = (
      <div className="compare-banner">
        <span className="compare-banner-label">
          Inserting <strong>{insertingLabel}</strong> into queue sublist
        </span>
      </div>
    );
  } else if (mode === 'inserting' && insertingLabel) {
    banner = (
      <div className="compare-banner">
        <span className="compare-banner-label">
          Inserting <strong>{insertingLabel}</strong>
        </span>
      </div>
    );
  }

  return (
    <div className="page">
      <div
        className="compare-progress"
        title={`${pct}% — ${completed} of ${total} comparisons done`}
      >
        <div className="compare-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      {banner}
      <div className="compare-help">
        Which do you prefer? Click a card or use ← / → · ↑ to undo · middle-click to open link
      </div>
      <div className="compare">
        <div key={`pop-${popInKeyLeft}-l`} className={leftSlotClass}>
          <ItemCard
            item={left}
            onPick={onPickLeft}
            onRemove={hideRemoveOnLeft ? undefined : () => onHide(left.id)}
          />
        </div>
        <div key={`pop-${popInKeyRight}-r`} className={rightSlotClass}>
          <ItemCard
            item={right}
            onPick={onPickRight}
            onRemove={() => onHide(right.id)}
          />
        </div>
        {outgoing && (
          <div
            ref={overlayContainerRef}
            className="compare-overlay"
            onAnimationEnd={handleOverlayAnimationEnd}
            key={`overlay-${outgoing.id}`}
          >
            {/* Both slot cells are always rendered to preserve the grid
                columns, but only the side(s) actually exiting get the
                exit-class + card content. The retained side is left empty
                so the in-grid card behind shows through unobscured. */}
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
    </div>
  );
}
