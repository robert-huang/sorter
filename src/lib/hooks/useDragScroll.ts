import { useCallback, useRef, type PointerEventHandler, type RefObject } from 'react';

const DRAG_THRESHOLD_PX = 5;

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
  dragging: boolean;
};

export type UseDragScrollResult<T extends HTMLElement> = {
  ref: RefObject<T>;
  onPointerDown: PointerEventHandler<T>;
  onPointerMove: PointerEventHandler<T>;
  onPointerUp: PointerEventHandler<T>;
  onPointerCancel: PointerEventHandler<T>;
};

/** Click-drag anywhere on a scroll container to pan its scroll position. */
export function useDragScroll<T extends HTMLElement = HTMLDivElement>(): UseDragScrollResult<T> {
  const ref = useRef<T>(null!);
  const dragRef = useRef<DragState | null>(null);

  const endDrag = useCallback((pointerId: number, suppressClick: boolean) => {
    const el = ref.current;
    const state = dragRef.current;
    if (!state || state.pointerId !== pointerId) {
      return;
    }

    el?.classList.remove('is-drag-scroll-dragging');
    try {
      el?.releasePointerCapture(pointerId);
    } catch {
      /* pointer capture may already be released */
    }

    if (suppressClick && state.dragging) {
      // If the synthesized click never reaches us (release outside window,
      // browser swallows it, etc.) we'd otherwise leak this capture
      // listener forever. The cleanup timeout fires on the next macrotask
      // — well after any real click dispatched as part of the same gesture.
      let timeoutId = 0;
      const cleanup = () => {
        document.removeEventListener('click', suppress, true);
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      };
      const suppress = (event: MouseEvent) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        cleanup();
      };
      document.addEventListener('click', suppress, true);
      timeoutId = window.setTimeout(cleanup, 250);
    }

    dragRef.current = null;
  }, []);

  const onPointerDown = useCallback<PointerEventHandler<T>>((event) => {
    if (event.button !== 0) {
      return;
    }

    const el = ref.current;
    if (!el) {
      return;
    }

    // NOTE: do NOT call setPointerCapture here. Capturing on pointerdown
    // makes browsers (Chromium especially) retarget the subsequent
    // synthesized `click` event to this scroll container instead of the
    // inner element the user actually clicked — breaking buttons inside
    // a DragScroll (e.g. the show-name tiles in Seasonal Scores). We
    // upgrade to a real capture only once the drag threshold is crossed.
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
      dragging: false,
    };
  }, []);

  const onPointerMove = useCallback<PointerEventHandler<T>>((event) => {
    const el = ref.current;
    const state = dragRef.current;
    if (!el || !state || state.pointerId !== event.pointerId) {
      return;
    }

    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;

    if (!state.dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) {
        return;
      }
      state.dragging = true;
      el.classList.add('is-drag-scroll-dragging');
      // Drag confirmed — claim the pointer so a fast swipe that leaves
      // the container still keeps panning. Safe to do now because the
      // gesture is no longer a click.
      try {
        el.setPointerCapture(event.pointerId);
      } catch {
        /* capture may fail if the pointer was already released */
      }
    }

    event.preventDefault();
    el.scrollLeft = state.scrollLeft - dx;
    el.scrollTop = state.scrollTop - dy;
  }, []);

  const onPointerUp = useCallback<PointerEventHandler<T>>((event) => {
    const state = dragRef.current;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }
    endDrag(event.pointerId, true);
  }, [endDrag]);

  const onPointerCancel = useCallback<PointerEventHandler<T>>((event) => {
    const state = dragRef.current;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }
    endDrag(event.pointerId, state.dragging);
  }, [endDrag]);

  return { ref, onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
