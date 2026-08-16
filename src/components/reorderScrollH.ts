export interface KeepReorderControlPositionOptions {
  scrollContainer?: HTMLElement | null;
  resolveControl?: () => HTMLElement | null;
  direction?: -1 | 1;
  animationPairs?: ReorderAnimationPair[];
}

export interface ReorderAnimationPair {
  beforeElement: HTMLElement;
  resolveAfterElement?: () => HTMLElement | null;
}

interface ReorderTransitionTarget {
  element: HTMLElement;
  x: number;
  y: number;
  previousTransform: string;
  previousWillChange: string;
  previousZIndex: string;
  active: boolean;
}

interface ActiveReorderTransition {
  frame: number | null;
  finish: () => void;
}

const REORDER_ANIMATION_DURATION_MS = 160;
const DEFAULT_REORDER_ITEM_SELECTOR = '.queue-item-row, .chip';
let reorderSequence = 0;
let activeReorderTransition: ActiveReorderTransition | null = null;

function cancelActiveReorderTransition(): void {
  if (!activeReorderTransition) return;
  const transition = activeReorderTransition;
  activeReorderTransition = null;
  if (transition.frame != null) {
    cancelAnimationFrame(transition.frame);
  }
  transition.finish();
}

function defaultAnimationPairs(
  control: HTMLElement,
  direction: -1 | 1 | undefined,
): ReorderAnimationPair[] {
  if (direction == null) return [];
  const item = control.closest<HTMLElement>(DEFAULT_REORDER_ITEM_SELECTOR);
  const parent = item?.parentElement;
  if (!item || !parent) return [];
  const siblings = Array.from(parent.children).filter(
    (candidate): candidate is HTMLElement =>
      candidate instanceof HTMLElement &&
      candidate.matches(DEFAULT_REORDER_ITEM_SELECTOR),
  );
  const index = siblings.indexOf(item);
  const target = siblings[index + direction];
  return target
    ? [{ beforeElement: item }, { beforeElement: target }]
    : [{ beforeElement: item }];
}

function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  );
}

function scrollByOffset(
  scrollContainer: HTMLElement | null | undefined,
  left: number,
  top: number,
): void {
  if (left === 0 && top === 0) return;
  if (scrollContainer) {
    scrollContainer.scrollLeft += left;
    scrollContainer.scrollTop += top;
  } else {
    window.scrollBy(left, top);
  }
}

function cubicBezierCoordinate(
  time: number,
  firstControl: number,
  secondControl: number,
): number {
  const remaining = 1 - time;
  return (
    3 * remaining * remaining * time * firstControl +
    3 * remaining * time * time * secondControl +
    time * time * time
  );
}

function reorderAnimationProgress(linearProgress: number): number {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const time = (low + high) / 2;
    if (cubicBezierCoordinate(time, 0.2, 0) < linearProgress) {
      low = time;
    } else {
      high = time;
    }
  }
  return cubicBezierCoordinate((low + high) / 2, 0, 1);
}

function animateReorderTransition(
  targets: ReorderTransitionTarget[],
  movedControl: HTMLElement,
  controlBefore: DOMRect,
  scrollContainer: HTMLElement | null | undefined,
  left: number,
  top: number,
  startTime: number,
  sequence: number,
): void {
  let appliedLeft = 0;
  let appliedTop = 0;
  let finished = false;
  const restore = (): void => {
    for (const target of targets) {
      target.element.style.transform = target.previousTransform;
      target.element.style.willChange = target.previousWillChange;
      target.element.style.zIndex = target.previousZIndex;
    }
  };
  const finish = (): void => {
    if (finished) return;
    finished = true;
    scrollByOffset(
      scrollContainer,
      left - appliedLeft,
      top - appliedTop,
    );
    appliedLeft = left;
    appliedTop = top;
    restore();
    if (movedControl.isConnected) {
      const finalRect = movedControl.getBoundingClientRect();
      scrollByOffset(
        scrollContainer,
        finalRect.left - controlBefore.left,
        finalRect.top - controlBefore.top,
      );
    }
  };
  const transition: ActiveReorderTransition = {
    frame: null,
    finish,
  };
  activeReorderTransition = transition;

  const updateTransition = (frameTime: number): void => {
    if (sequence !== reorderSequence) {
      restore();
      return;
    }
    const linearProgress = Math.min(
      Math.max((frameTime - startTime) / REORDER_ANIMATION_DURATION_MS, 0),
      1,
    );
    const progress =
      linearProgress === 0 || linearProgress === 1
        ? linearProgress
        : reorderAnimationProgress(linearProgress);
    const remaining = 1 - progress;
    for (const target of targets) {
      const translation = `translate(${target.x * remaining}px, ${
        target.y * remaining
      }px)`;
      target.element.style.transform = target.previousTransform
        ? `${translation} ${target.previousTransform}`
        : translation;
      target.element.style.willChange = 'transform';
      if (target.active) target.element.style.zIndex = '1';
    }
    const nextLeft = left * progress;
    const nextTop = top * progress;
    scrollByOffset(
      scrollContainer,
      nextLeft - appliedLeft,
      nextTop - appliedTop,
    );
    appliedLeft = nextLeft;
    appliedTop = nextTop;
    if (linearProgress < 1) {
      transition.frame = requestAnimationFrame(updateTransition);
    } else {
      finish();
      if (activeReorderTransition === transition) {
        activeReorderTransition = null;
      }
    }
  };
  updateTransition(startTime);
}

/**
 * Animate the two items through their exchanged positions. Exact scroll
 * anchoring and the FLIP transition share the same timing so the moved item
 * stays pinned while the surrounding page or list moves around it.
 */
export function reorderKeepingControlPosition(
  control: HTMLElement,
  reorder: () => void,
  options: KeepReorderControlPositionOptions = {},
): void {
  cancelActiveReorderTransition();
  const sequence = ++reorderSequence;
  const before = control.getBoundingClientRect();
  const animationPairs =
    options.animationPairs ??
    defaultAnimationPairs(control, options.direction);
  const animationSnapshots = animationPairs.map((pair) => {
    const rect = pair.beforeElement.getBoundingClientRect();
    return { pair, rect };
  });
  reorder();

  requestAnimationFrame((frameTime) => {
    if (sequence !== reorderSequence) return;
    const movedControl = options.resolveControl?.() ?? control;
    if (!movedControl.isConnected) return;

    const animateSwap =
      !prefersReducedMotion() && animationSnapshots.length > 0;
    const after = movedControl.getBoundingClientRect();
    const leftDelta = after.left - before.left;
    const topDelta = after.top - before.top;
    const scrollContainer = options.scrollContainer;

    if (!animateSwap) {
      scrollByOffset(scrollContainer, leftDelta, topDelta);
    }

    if (animateSwap) {
      const targets: ReorderTransitionTarget[] = [];
      for (const [pairIndex, { pair, rect }] of animationSnapshots.entries()) {
        const element =
          pair.resolveAfterElement?.() ?? pair.beforeElement;
        if (!element.isConnected) continue;
        const finalRect = element.getBoundingClientRect();
        const active = pairIndex === 0;
        const x = active ? -leftDelta : rect.left - finalRect.left;
        const y = active ? -topDelta : rect.top - finalRect.top;
        if (x === 0 && y === 0) continue;
        targets.push({
          element,
          x,
          y,
          previousTransform: element.style.transform,
          previousWillChange: element.style.willChange,
          previousZIndex: element.style.zIndex,
          active,
        });
      }
      if (targets.length > 0) {
        animateReorderTransition(
          targets,
          movedControl,
          before,
          scrollContainer,
          leftDelta,
          topDelta,
          frameTime,
          sequence,
        );
      } else {
        scrollByOffset(scrollContainer, leftDelta, topDelta);
      }
    }

    if (movedControl !== control) {
      movedControl.focus({ preventScroll: true });
    }
  });
}
