import { useEffect, useRef } from 'react';

interface ModalProps {
  /**
   * Accessible name for the dialog. Used as `aria-label` so each modal
   * needs to set a meaningful value (e.g. "Add items", "Delete slot
   * confirmation"). Visible h3 / heading is still part of `children`;
   * we don't auto-render it here so each modal stays free to compose
   * its own header (icons, tabs, dynamic suffixes, etc.).
   */
  label: string;
  /** Called on Escape, on backdrop click, or whenever the modal asks to close. */
  onClose: () => void;
  /** Modal panel content (heading + body + actions). */
  children: React.ReactNode;
  /**
   * Extra class appended to `.modal` (e.g. `'modal-wide'` for AddItemsModal).
   * Backdrop class is always `.modal-backdrop`.
   */
  className?: string;
}

/**
 * Returns the list of tab-focusable elements inside `root` in DOM order.
 * Used by the focus trap to wrap Tab/Shift+Tab at the panel edges.
 *
 * Selector intentionally excludes elements with `[tabindex="-1"]`
 * (e.g. the panel itself, disabled cards) but includes anything with a
 * non-negative tabindex.
 */
function listFocusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const sel = [
    'button:not([disabled])',
    'a[href]',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
    // Skip elements hidden via display:none / visibility:hidden so Tab
    // doesn't get stuck on something the user can't see.
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Shared modal shell: backdrop, role="dialog", aria-modal, Escape-to-close,
 * focus trap, and focus restore on unmount. Replaces the duplicated
 * `<div className="modal-backdrop" onClick={onCancel}><div className="modal"
 * onClick={e => e.stopPropagation()}>` pattern across all confirm /
 * form modals.
 *
 * a11y guarantees this wrapper provides:
 *  1. Focus moves into the panel on open. Each modal's own autoFocus
 *     (e.g. EditItemModal's label input) still wins because it runs
 *     in the child's effect — we focus the PANEL element (tabIndex=-1),
 *     which is overridden by any nested autoFocus.
 *  2. Escape closes the modal. This is in addition to any per-input
 *     Escape handlers (idempotent — second onClose is a no-op state
 *     setter). Works even when focus is on a button instead of an input.
 *  3. Tab / Shift+Tab cycles within the panel. Tab at the last focusable
 *     wraps to the first; Shift+Tab at the first wraps to the last.
 *  4. On unmount, focus is restored to whatever was focused when the
 *     modal opened (typically the button that triggered it). This is
 *     the keyboard-user equivalent of "the mouse stays where you left it".
 */
export function Modal({ label, onClose, children, className }: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Defer focusing to the next microtask so any child autoFocus
    // (e.g. <input autoFocus />) gets to run first and win. If we
    // focused the panel synchronously we'd briefly take focus, then
    // the child's autoFocus would steal it — net same outcome, but
    // microtask is one less focus event.
    queueMicrotask(() => {
      // Only grab focus if the panel doesn't already contain it (i.e.
      // an autoFocus child claimed it). Avoids snatching focus from
      // the user's preferred entry point.
      const root = panelRef.current;
      if (!root) return;
      if (!root.contains(document.activeElement)) {
        root.focus();
      }
    });
    return () => {
      // Restore focus to whatever triggered the modal. `?.()` defends
      // against the trigger being unmounted (rare; e.g. the modal was
      // opened from a transient toast that has since auto-dismissed).
      previouslyFocused.current?.focus?.();
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = listFocusables(panelRef.current);
    if (focusables.length === 0) {
      // Nothing tabbable; pin focus on the panel itself.
      e.preventDefault();
      panelRef.current?.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className={`modal${className ? ` ${className}` : ''}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
