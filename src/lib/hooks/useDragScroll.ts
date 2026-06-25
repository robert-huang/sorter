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

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
      dragging: false,
    };
    el.setPointerCapture(event.pointerId);
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
