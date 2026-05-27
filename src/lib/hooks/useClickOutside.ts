import { useEffect, type RefObject } from 'react';

/**
 * Close-on-outside-click + ESC for popover-style UI. Attaches a
 * single document-level `mousedown` listener and a `keydown` listener
 * while `active` is true; tears both down on unmount or when `active`
 * flips false so an inactive dropdown carries no listener cost.
 *
 * Uses `mousedown` (not `click`) so the popover dismisses on the
 * press, before the click event would reach an interactive element
 * BEHIND the popover — matches the native `<select>` and OS menu
 * feel. A click STARTED inside the popover still counts as inside
 * (the mousedown lands on the inside target), so a drag-select that
 * happens to lift the mouse outside the popover doesn't dismiss it.
 *
 * The ESC handler runs alongside outside-click so keyboard users
 * have a parity with mouse users (matching the dialog dismissal
 * idiom every modal in this app follows).
 *
 * Multiple popovers can use this hook independently — each one
 * owns its own ref + handler, and React's effect ordering ensures
 * a newly-opened popover's listener fires AFTER any older one's
 * cleanup, so they don't cross-dismiss in confusing ways.
 *
 * @param ref       The popover root (or chip root that contains both
 *                  the trigger AND the menu so clicking the trigger
 *                  itself doesn't count as "outside").
 * @param active    Whether the popover is currently open — when
 *                  false the hook is a no-op and attaches nothing.
 * @param onClose   Called on outside mousedown OR ESC. Should
 *                  transition the popover to closed.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    const handleMouseDown = (event: MouseEvent) => {
      const root = ref.current;
      if (!root) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      // `contains` returns true for the root element itself, so
      // a mousedown on the trigger button (inside `root`) is
      // correctly treated as inside and DOES NOT close.
      if (root.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [ref, active, onClose]);
}
