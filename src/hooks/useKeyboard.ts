import { useEffect } from 'react';

export interface KeyHandlers {
  onLeft?: () => void;
  onRight?: () => void;
  onUp?: () => void;
}

/**
 * Global keyboard handler for the RANK loop. Skips when the user is typing
 * in an input/textarea/contenteditable so arrow keys don't double-fire.
 */
export function useKeyboard(handlers: KeyHandlers, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    function isTyping(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (target.isContentEditable) return true;
      return false;
    }
    function handler(e: KeyboardEvent): void {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;
      switch (e.key) {
        case 'ArrowLeft':
          if (handlers.onLeft) {
            e.preventDefault();
            handlers.onLeft();
          }
          break;
        case 'ArrowRight':
          if (handlers.onRight) {
            e.preventDefault();
            handlers.onRight();
          }
          break;
        case 'ArrowUp':
          if (handlers.onUp) {
            e.preventDefault();
            handlers.onUp();
          }
          break;
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handlers, enabled]);
}
