/** Named item labels in each compare peek deck (depths 1…COMPARE_PEEK_DEPTH). */
export const COMPARE_PEEK_DEPTH = 4;

export function peekOverflowLabel(count: number): string {
  const noun = count === 1 ? 'item' : 'items';
  return `...${count} ${noun}`;
}

/** Insert compare modes show probe left / inserting right (engine pair is reversed). */
export function swapsInsertCompareSides(mode: string): boolean {
  return (
    mode === 'inserting' ||
    mode === 'manual-insert' ||
    mode === 'auto-insert'
  );
}

export function visualComparePair<T extends { leftId: string; rightId: string }>(
  pair: T,
  swapsSides: boolean,
): T {
  if (!swapsSides) return pair;
  return { ...pair, leftId: pair.rightId, rightId: pair.leftId };
}

/** Map engine pick side to the side the user clicked on screen. */
export function enginePickToVisualSide(
  engineSide: 'left' | 'right',
  swapsSides: boolean,
): 'left' | 'right' {
  if (!swapsSides) return engineSide;
  return engineSide === 'left' ? 'right' : 'left';
}

/** Map engine peek decks to on-screen left/right when insert sides are swapped. */
export function visualPeekSides<T>(
  engineLeft: T,
  engineRight: T,
  swapsSides: boolean,
): { left: T; right: T } {
  if (!swapsSides) return { left: engineLeft, right: engineRight };
  return { left: engineRight, right: engineLeft };
}

/**
 * True when an insert-mode pick just spliced the visual-right inserting
 * item into the target list (next in-flight id differs, or none left).
 */
export function insertingItemLanded(
  prevMode: string,
  prevPair: { rightId: string } | null,
  nextInsertingId: string | null,
): boolean {
  if (!prevPair) return false;
  const wasInsert =
    prevMode === 'insert' ||
    prevMode === 'inserting' ||
    prevMode === 'manual-insert' ||
    prevMode === 'auto-insert';
  if (!wasInsert) return false;
  return nextInsertingId === null || nextInsertingId !== prevPair.rightId;
}

export type SlotAnimKind = 'pop' | 'deck' | 'fade' | 'none';

export type ConfirmationComparePhase = 'confirm' | 'insert';

/** Incoming animation kinds for the confirmation compare hero + candidate slots. */
export function confirmationAnimKinds(
  prev: { leftId: string; rightId: string } | null,
  vp: { leftId: string; rightId: string },
  prevPhase: ConfirmationComparePhase | null,
  phase: ConfirmationComparePhase,
  insertingId: string | null,
): { left: SlotAnimKind; right: SlotAnimKind } {
  if (!prev || !prevPhase) {
    return { left: 'pop', right: 'pop' };
  }
  const sameLeft = prev.leftId === vp.leftId;
  const sameRight = prev.rightId === vp.rightId;
  if (sameLeft && sameRight) {
    return { left: 'none', right: 'none' };
  }
  const modeBoundary = prevPhase !== phase;
  if (phase === 'confirm') {
    if (!sameLeft && !sameRight) {
      return { left: 'pop', right: 'pop' };
    }
    if (!sameLeft) return { left: 'deck', right: 'none' };
    return { left: 'none', right: 'deck' };
  }
  if (modeBoundary && prevPhase === 'confirm') {
    return { left: 'pop', right: 'none' };
  }
  if (modeBoundary) {
    return { left: 'pop', right: 'pop' };
  }
  const landed = insertingItemLanded(prevPhase, prev, insertingId);
  if (landed) {
    return {
      left: sameLeft ? 'none' : 'deck',
      right: 'pop',
    };
  }
  return {
    left: sameLeft ? 'none' : 'deck',
    right: sameRight ? 'none' : 'none',
  };
}

export const COMPARE_EXIT_ANIM_NAMES = new Set([
  'cardSlideOutLeft',
  'cardSlideOutRight',
  'cardFadeOut',
]);

export const COMPARE_RUSH_DURATION_MS = 70;
