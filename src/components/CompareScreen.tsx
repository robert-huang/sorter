import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Item, ItemId, SortState } from '../lib/types';
import {
  getCompareProgress,
  getPair,
  getPeekLeftIds,
  getPeekLeftOverflowCount,
  getPeekRightIds,
  getPeekRightOverflowCount,
} from '../lib/engine';
import { COMPARE_PEEK_DEPTH, peekOverflowLabel } from './compareScreenH';
import { ItemCard } from './ItemCard';
import { PeekCard } from './PeekCard';

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
  /**
   * How the exiting cards should animate off-screen.
   *  - 'slide' — classic side-ward slide (`cardSlideOutLeft/Right`). Used
   *    in normal merge mode where the picked card visually goes to the
   *    "merged pile" on its side.
   *  - 'fade' — vertical fade-out (`cardFadeOut`). Used whenever EITHER
   *    side of the transition is in an insert mode (insertion engine,
   *    auto-insert, or manual-insert). Sliding sideways would imply
   *    "this card got picked into the merged stream", which is a lie
   *    when the user is actually narrowing a binary search and the next
   *    probe could land anywhere in the active range.
   */
  exitKind: 'slide' | 'fade';
  /** Whether the in-grid left slot was hidden while this exit played.
   *  False for 'deck' transitions — the slot stays visible so the user
   *  can see the peek deck shift and the new live card rise in parallel
   *  with the overlay exit. */
  leftHidden: boolean;
  rightHidden: boolean;
}

/**
 * What animation drives a side's *incoming* live card on the next render.
 * Decided per pick from the previous → new pair diff and the engine mode.
 *  - 'pop'  — classic dramatic scale-up (`cardPopIn`). Cold start, sublist
 *    boundary in merge (both ids changed), and any transition into/out
 *    of an insert mode.
 *  - 'deck' — slide up from the depth-1 peek transform into the live
 *    position (`cardSlideUpFromDeck`). Used when exactly one side's id
 *    changed in normal merge mode — visually, the next-up card the user
 *    was just shown at depth-1 rises into the live slot.
 *  - 'fade' — opacity-only crossfade (`cardFadeIn`). Used while we stay
 *    inside an insert mode probe-to-probe; binary search jumps so the
 *    new probe wasn't necessarily in the prior peek deck and a deck
 *    slide-up would lie about the rank relationship.
 *  - 'none' — no animation. Set on the side that didn't change (its
 *    `popInKey` doesn't bump anyway, so the live card doesn't remount
 *    and stays exactly where it was through the partner's exit).
 */
type SlotAnimKind = 'pop' | 'deck' | 'fade' | 'none';

/** When a new pick lands while an exit is in flight, we re-pace the live
 *  overlay's CSS animation to this duration via the --anim-duration custom
 *  property so it finishes quickly and the next pick can play. */
const RUSH_DURATION_MS = 70;

/** Animation names we listen for to know an exit cycle finished. Fires
 *  once per exiting side (so 1 or 2 per outgoing pair). Includes the
 *  insert-mode fade-out so the same drain logic handles both kinds. */
const EXIT_ANIM_NAMES = new Set([
  'cardSlideOutLeft',
  'cardSlideOutRight',
  'cardFadeOut',
]);

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
  // The mode (merging / manual-insert / auto-insert / inserting) on the
  // previous render. Read alongside the pair to decide whether the
  // outgoing pair should slide off (merge) or fade out (insert), and to
  // detect transitions in/out of insert modes that always warrant a
  // fresh full pop-in on both sides.
  const prevModeRef = useRef<CompareMode | null>(null);
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
  // Per-side incoming-animation kind. Drives which keyframe the live
  // ItemCard runs on its next remount via `data-anim` on the slot,
  // AND is passed as `mountAnim` to each PeekCard so the card freezes
  // it on its initial mount (so persisted peek cards don't re-fire
  // their entry animation when the slot's kind flips on a later pick).
  //
  // Computed at render time via useMemo (NOT in the layout effect) for
  // a critical timing reason: peek cards that mount on this commit
  // freeze their `data-mount-anim` from this prop *during this
  // render*. If we waited until the effect to update animKind state,
  // newly-mounted peek cards on render N would freeze the OLD kind
  // (e.g., 'pop' from the cold start) and only render N+1 would have
  // the right value — but by then the cards are already mounted and
  // their attribute is locked in. By deriving from the refs at render
  // time we get the right kind on the same commit the new pair
  // appears. The refs are updated by the layout effect AFTER this
  // render commits, so the next render with an unchanged pair
  // (deps-equal) returns the cached useMemo value, and the next
  // render with a new pair re-derives against the now-updated refs.
  const { left: leftAnimKind, right: rightAnimKind } = useMemo<{
    left: SlotAnimKind;
    right: SlotAnimKind;
  }>(() => {
    const prev = prevPairRef.current;
    const prevMode = prevModeRef.current;
    if (!pair || !prev || prevMode === null) {
      // Cold start (no prior pair) — both sides do the dramatic
      // pop-in, which is what the old single-animation behavior did
      // and matches the user's "all 4 cards pop in" feel.
      return { left: 'pop', right: 'pop' };
    }
    const sameLeft = prev.leftId === pair.leftId;
    const sameRight = prev.rightId === pair.rightId;
    if (sameLeft && sameRight) {
      // Pair didn't change since last commit — neither side animates.
      return { left: 'none', right: 'none' };
    }
    const newIsInsert = mode !== 'merging';
    const prevIsInsert = prevMode !== 'merging';
    const modeBoundary = newIsInsert !== prevIsInsert;
    if (newIsInsert) {
      // Insert mode (now): fade out + fade in both sides regardless
      // of which id technically changed — the inserting id stays put
      // but we treat the pair as a unit visually.
      return { left: 'fade', right: 'fade' };
    }
    if (modeBoundary || (!sameLeft && !sameRight)) {
      // Just left an insert mode, OR a sublist boundary in pure merge.
      // Pop both sides (and their peek decks) for the "all 4 at once"
      // effect.
      return { left: 'pop', right: 'pop' };
    }
    if (!sameLeft) return { left: 'deck', right: 'none' };
    return { left: 'none', right: 'deck' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair?.leftId, pair?.rightId, mode]);
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
  /**
   * Tracks which sides already got a popInKey bump for the current incoming
   * pair. An INTERRUPT pick bumps immediately (snappy reveal); without this
   * flag the leisurely overlay tail would bump again when the exit finishes —
   * especially visible at merge-queue boundaries (both sides `pop`) where the
   * new queue's cards appear to flash twice.
   */
  const incomingAnimatedRef = useRef({ left: false, right: false });
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

  useEffect(() => {
    outgoingRef.current = outgoing;
  }, [outgoing]);

  // useLayoutEffect (not useEffect) so the hidden class lands in the same
  // paint as the new-pair render. Otherwise the user briefly sees the new
  // cards before they're hidden, producing a flicker on every slow pick.
  useLayoutEffect(() => {
    if (!pair) {
      prevPairRef.current = null;
      prevModeRef.current = null;
      return;
    }
    const prev = prevPairRef.current;
    const prevMode = prevModeRef.current;
    prevPairRef.current = { leftId: pair.leftId, rightId: pair.rightId };
    prevModeRef.current = mode;
    if (!prev) return; // first mount — initial 'pop' state covers it
    const sameLeft = prev.leftId === pair.leftId;
    const sameRight = prev.rightId === pair.rightId;
    if (sameLeft && sameRight) return;

    // The animKind for each side has already been decided at render
    // time via the useMemo above (so PeekCards mounting on this commit
    // freeze the right value). Here we only need to know which sides
    // should *bump their popInKey* (i.e., remount their live ItemCard
    // so it replays the keyframe driven by the slot's `data-anim`).
    //
    // In normal merge that's exactly the changed side(s). In insert
    // modes — or when crossing the merge ↔ insert mode boundary — we
    // force both sides to remount so the visual swap covers both cards
    // even when one technically retained its id.
    const newIsInsert = mode !== 'merging';
    const prevIsInsert = prevMode !== 'merging';
    const modeBoundary = newIsInsert !== prevIsInsert;
    const bumpLeft = !sameLeft || newIsInsert || modeBoundary;
    const bumpRight = !sameRight || newIsInsert || modeBoundary;

    // Non-pick pair changes (undo, slot switch, etc.) skip the slide-out
    // overlay entirely — the changed side(s) just remount fresh and
    // their slot's data-anim picks the right keyframe.
    if (lastInteraction?.kind !== 'pick') {
      if (bumpLeft) setPopInKeyLeft((k) => k + 1);
      if (bumpRight) setPopInKeyRight((k) => k + 1);
      return;
    }

    // Exit kind: insert mode (now or just left) → fade out vertically
    // (the picked side's card didn't actually go anywhere physical).
    // Pure merge → classic side-ward slide.
    const exitKind: 'slide' | 'fade' = newIsInsert || prevIsInsert ? 'fade' : 'slide';

    // Build the outgoing pair. In insert / mode-boundary cases include
    // BOTH sides as exiting (even the side whose id didn't change), so
    // the user sees both fade out in unison before the new probe lands.
    let oldLeft = sameLeft && !newIsInsert && !modeBoundary
      ? null
      : state.items[prev.leftId] ?? null;
    let oldRight = sameRight && !newIsInsert && !modeBoundary
      ? null
      : state.items[prev.rightId] ?? null;

    if (!oldLeft && !oldRight) {
      // Old items missing (rare — e.g. previous items hidden mid-sort).
      // Fall back to plain remount — the data-anim already drives the
      // right keyframe on the incoming live card.
      if (bumpLeft) setPopInKeyLeft((k) => k + 1);
      if (bumpRight) setPopInKeyRight((k) => k + 1);
      return;
    }

    const newOutgoing: OutgoingPair = {
      id: ++outgoingCounterRef.current,
      leftExiting: oldLeft,
      rightExiting: oldRight,
      pickedSide: lastInteraction.side,
      exitKind,
      // 'deck' transitions keep the slot visible so the user sees the
      // peek depth shift and the live card rise in parallel with the
      // overlay exit. Pop/fade still hide until the overlay drains.
      leftHidden: !!oldLeft && leftAnimKind !== 'deck',
      rightHidden: !!oldRight && rightAnimKind !== 'deck',
    };

    if (outgoingRef.current === null) {
      // LEISURELY: start the exit. For pop/fade, hide the entering side(s)
      // until the overlay drains. For deck, keep the slot visible and
      // bump popInKey now so cardSlideUpFromDeck + peek depth shifts
      // play in parallel with the overlay slide-off.
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
      const isMergeQueueBoundary =
        !newIsInsert &&
        !prevIsInsert &&
        !modeBoundary &&
        bumpLeft &&
        bumpRight &&
        leftAnimKind === 'pop' &&
        rightAnimKind === 'pop';

      if (isMergeQueueBoundary) {
        // Merge queue advanced (fresh sublists on both sides). Play the full
        // leisurely boundary exit instead of the 70ms interrupt so a fast
        // second click feels like two separate picks, not a rushed snap.
        cancelDeferredDeckBumps();
        queueRef.current = [];
        if (overlayContainerRef.current) {
          overlayContainerRef.current.style.removeProperty('--anim-duration');
        }
        incomingAnimatedRef.current = { left: false, right: false };
        setOutgoing(newOutgoing);
        setLeftRevealed(false);
        setRightRevealed(false);
      } else {
        // INTERRUPT: rush the in-flight exit by re-pacing its CSS animation
        // duration to RUSH_DURATION_MS (via a CSS variable on the overlay
        // container, which children inherit), reveal the new cards now, and
        // do NOT queue another exit overlay — the incoming pair is already
        // on screen; playing a chained exit on top is what caused the
        // double-flash when double-clicking through a short sublist.
        cancelDeferredDeckBumps();
        if (overlayContainerRef.current) {
          overlayContainerRef.current.style.setProperty(
            '--anim-duration',
            `${RUSH_DURATION_MS}ms`,
          );
        }
        queueRef.current = [];
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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair?.leftId, pair?.rightId, mode, lastInteraction]);

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
      // Queue drained — leisurely tail. Reveal any side that was hidden
      // and replay its incoming animation. Deck sides were never hidden
      // and already got their popInKey bump on pick, so skip them here.
      // Skip sides that already bumped on an INTERRUPT pick too.
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
  // back rather than letting it appear to retreat. While in flight the
  // forecast counts the active pair as remaining, so the last comparison
  // may sit below 100%; completion is signaled by `state.done` (✓ in title).
  const { completed, total, pct } = getCompareProgress(state, {
    autoInsertEnabled,
  });

  // The slot itself is a *stable* DOM node across picks (no key on the
  // wrapper), so the peek deck inside can persist its child elements
  // across renders — that's what makes the depth-2 → depth-1 CSS
  // transition smooth on a 'deck' transition. The only thing that
  // remounts on a pick is the live ItemCard (keyed by popInKey). Anim
  // selection happens via `data-anim` on the slot, read by CSS rules
  // targeting the live card and the peek-card inner wrappers.
  const leftSlotClass = `compare-slot compare-slot--left${
    leftRevealed ? '' : ' compare-slot--hidden'
  }`;
  const rightSlotClass = `compare-slot compare-slot--right${
    rightRevealed ? '' : ' compare-slot--hidden'
  }`;
  // Peek entry animations are frozen on mount — skip pop/deck on cards that
  // mount while the slot is hidden, or they replay when the slot unhides.
  const leftPeekMountAnim: SlotAnimKind = leftRevealed ? leftAnimKind : 'none';
  const rightPeekMountAnim: SlotAnimKind = rightRevealed
    ? rightAnimKind
    : 'none';

  // Rank-adjacent peek decks rendered behind the live cards. Right side
  // applies in every mode; left side is non-empty only in normal merge
  // mode (the engine helpers return [] in insert modes so the left
  // stack is skipped entirely). Filtered through the items dict so any
  // id missing a backing record (shouldn't happen, but be defensive)
  // doesn't crash the render.
  const peekRightItems = getPeekRightIds(state, COMPARE_PEEK_DEPTH)
    .map((id) => state.items[id])
    .filter((it): it is Item => !!it);
  const peekRightOverflow = getPeekRightOverflowCount(state, COMPARE_PEEK_DEPTH);
  const peekLeftItems = getPeekLeftIds(state, COMPARE_PEEK_DEPTH)
    .map((id) => state.items[id])
    .filter((it): it is Item => !!it);
  const peekLeftOverflow = getPeekLeftOverflowCount(state, COMPARE_PEEK_DEPTH);

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
        <div className={leftSlotClass} data-anim={leftAnimKind}>
          {(peekLeftItems.length > 0 || peekLeftOverflow > 0) && (
            <div
              className="compare-peek-stack compare-peek-stack--left"
              aria-hidden="true"
            >
              {/* Render deepest first so DOM order matches paint order
                  for the same z-index — depth 1 (closest) ends up on
                  top of the stack but still under the live card via
                  the .compare-slot > .item-card { z-index: 1 } rule. */}
              {[
                ...peekLeftItems.map((item, i) => ({
                  kind: 'item' as const,
                  item,
                  depth: i + 1,
                })),
                ...(peekLeftOverflow > 0
                  ? [
                      {
                        kind: 'overflow' as const,
                        depth: peekLeftItems.length + 1,
                        count: peekLeftOverflow,
                      },
                    ]
                  : []),
              ]
                .reverse()
                .map((layer) =>
                  layer.kind === 'item' ? (
                    <PeekCard
                      key={layer.item.id}
                      item={layer.item}
                      depth={layer.depth}
                      mountAnim={leftPeekMountAnim}
                    />
                  ) : (
                    <PeekCard
                      key="peek-overflow-left"
                      item={left}
                      labelOverride={peekOverflowLabel(layer.count)}
                      isOverflow
                      depth={layer.depth}
                      mountAnim={leftPeekMountAnim}
                    />
                  ),
                )}
            </div>
          )}
          <ItemCard
            key={popInKeyLeft}
            item={left}
            onPick={onPickLeft}
            onRemove={() => onHide(left.id)}
          />
        </div>
        <div className={rightSlotClass} data-anim={rightAnimKind}>
          {(peekRightItems.length > 0 || peekRightOverflow > 0) && (
            <div
              className="compare-peek-stack compare-peek-stack--right"
              aria-hidden="true"
            >
              {[
                ...peekRightItems.map((item, i) => ({
                  kind: 'item' as const,
                  item,
                  depth: i + 1,
                })),
                ...(peekRightOverflow > 0
                  ? [
                      {
                        kind: 'overflow' as const,
                        depth: peekRightItems.length + 1,
                        count: peekRightOverflow,
                      },
                    ]
                  : []),
              ]
                .reverse()
                .map((layer) =>
                  layer.kind === 'item' ? (
                    <PeekCard
                      key={layer.item.id}
                      item={layer.item}
                      depth={layer.depth}
                      mountAnim={rightPeekMountAnim}
                    />
                  ) : (
                    <PeekCard
                      key="peek-overflow-right"
                      item={right}
                      labelOverride={peekOverflowLabel(layer.count)}
                      isOverflow
                      depth={layer.depth}
                      mountAnim={rightPeekMountAnim}
                    />
                  ),
                )}
            </div>
          )}
          <ItemCard
            key={popInKeyRight}
            item={right}
            onPick={onPickRight}
            onRemove={() => onHide(right.id)}
          />
        </div>
        {outgoing && (
          <div
            ref={overlayContainerRef}
            className={`compare-overlay compare-overlay--exit-${outgoing.exitKind}`}
            onAnimationEnd={handleOverlayAnimationEnd}
            key={`overlay-${outgoing.id}`}
          >
            {/* Both slot cells are always rendered to preserve the grid
                columns, but only the side(s) actually exiting get the
                exit-class + card content. The retained side is left empty
                so the in-grid card behind shows through unobscured. The
                container's `--exit-{slide,fade}` modifier picks the
                keyframe via CSS — slide for merge, fade for insert. */}
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
