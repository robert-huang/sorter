import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  anilistUrlForCharacter,
  anilistUrlForPathStep,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from './anilistMiddleClick';
import type { RouteSlotOption } from './cachedGraph';
import type { PathHopCharacter, PathStep } from './pathHistory';
import { pathStepLabel } from './pathHistory';

const SLOT_MENU_GAP_PX = 6;
const SLOT_MENU_VIEWPORT_MARGIN_PX = 12;
const SLOT_MENU_MAX_HEIGHT_PX = 240;
const SLOT_MENU_ITEM_HEIGHT_PX = 36;
const SLOT_MENU_PADDING_PX = 8;

/** Rough menu height before paint; matches `.anime-to-anime-slot-menu` caps. */
export function estimatedSlotMenuHeight(itemCount: number): number {
  return Math.min(
    SLOT_MENU_MAX_HEIGHT_PX,
    SLOT_MENU_PADDING_PX + itemCount * SLOT_MENU_ITEM_HEIGHT_PX,
  );
}

/** Flip the alternate-links menu above the slot when the viewport is tight below. */
export function shouldOpenSlotMenuUp(
  anchor: Pick<DOMRect, 'top' | 'bottom'>,
  menuHeight: number,
  viewportHeight: number = window.innerHeight,
): boolean {
  const spaceBelow =
    viewportHeight - anchor.bottom - SLOT_MENU_GAP_PX - SLOT_MENU_VIEWPORT_MARGIN_PX;
  if (spaceBelow >= menuHeight) {
    return false;
  }
  const spaceAbove = anchor.top - SLOT_MENU_GAP_PX - SLOT_MENU_VIEWPORT_MARGIN_PX;
  return spaceAbove > spaceBelow;
}

export function PathStepBubble({
  step,
  isCurrent = false,
  compact = false,
  onOpenStep,
}: {
  step: PathStep;
  isCurrent?: boolean;
  compact?: boolean;
  /**
   * When set, left-clicking (or Enter/Space) the bubble opens the detail
   * modal for this step. Only wired from the result screen so the
   * in-game trail stays non-interactive. Middle-click still opens AniList
   * regardless.
   */
  onOpenStep?: (step: PathStep) => void;
}) {
  const imageSrc = step.kind === 'anime' ? step.coverImage : step.image;
  const label = pathStepLabel(step);
  const initial = label.trim().charAt(0).toUpperCase() || '?';

  const anilistLink = bindAnilistMiddleClick(anilistUrlForPathStep(step));
  const interactive = Boolean(onOpenStep);
  const className = mergeAnilistLinkClass(
    [
      'anime-to-anime-path-step',
      compact ? 'anime-to-anime-path-step--compact' : '',
      isCurrent ? 'anime-to-anime-path-step--current' : '',
      interactive ? 'anime-to-anime-path-step--interactive' : '',
    ]
      .filter(Boolean)
      .join(' '),
    anilistLink.className,
  );

  const title = interactive ? `${label} — click for details` : label;

  return (
    <div
      className={className}
      title={title}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `Open details for ${label}` : undefined}
      onMouseDown={anilistLink.onMouseDown}
      onAuxClick={anilistLink.onAuxClick}
      onClick={interactive ? () => onOpenStep?.(step) : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenStep?.(step);
              }
            }
          : undefined
      }
    >
      {imageSrc ? (
        <img src={imageSrc} alt="" className="anime-to-anime-path-step-img" />
      ) : (
        <span className="anime-to-anime-path-step-initial" aria-hidden="true">
          {initial}
        </span>
      )}
    </div>
  );
}

export function PathTrailEdge({
  kind,
  compact = false,
  viaLabel,
  viaCharacters,
}: {
  kind: 'anime' | 'staff';
  compact?: boolean;
  viaLabel?: string;
  /** When set (voice hops), middle-clicking the arrow opens each character. */
  viaCharacters?: readonly PathHopCharacter[];
}) {
  const characterUrls = (viaCharacters ?? []).map((character) =>
    anilistUrlForCharacter(character.id),
  );
  const interactive = characterUrls.length > 0;
  const anilistLink = bindAnilistMiddleClick(interactive ? characterUrls : null);
  const baseClass = [
    'anime-to-anime-path-edge',
    `anime-to-anime-path-edge--${kind}`,
    compact ? 'anime-to-anime-path-edge--compact' : '',
    viaLabel ? 'anime-to-anime-path-edge--labeled' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const title = viaLabel;

  return (
    <span
      className={mergeAnilistLinkClass(baseClass, anilistLink.className)}
      title={title}
      aria-hidden={viaLabel || interactive ? undefined : true}
      onMouseDown={anilistLink.onMouseDown}
      onAuxClick={anilistLink.onAuxClick}
    >
      →
    </span>
  );
}

/**
 * A collapsed-route slot: shows the currently selected option's bubble plus a
 * `+N` caret badge. The caret (left-click) and a right-click anywhere on the
 * slot open a dropdown of the interchangeable shows (cover + title). Picking
 * one calls {@link onSelect}; the bubble itself behaves like any path node
 * (left-click opens the detail modal, middle-click opens AniList).
 */
export function SlotBubble({
  options,
  selectedIndex,
  onSelect,
  label,
  compact = false,
  onOpenStep,
}: {
  options: readonly RouteSlotOption[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  /** Selected show's title, shown beside the bubble (right-click target). */
  label: string;
  compact?: boolean;
  onOpenStep?: (step: PathStep) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuOpensUp, setMenuOpensUp] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const selected = options[selectedIndex] ?? options[0];
  const extraCount = options.length - 1;

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuOpensUp(false);
      return;
    }
    const updatePlacement = () => {
      const anchor = containerRef.current;
      if (!anchor) {
        return;
      }
      const measuredHeight = menuRef.current?.offsetHeight ?? 0;
      const menuHeight =
        measuredHeight > 0
          ? measuredHeight
          : estimatedSlotMenuHeight(options.length);
      setMenuOpensUp(
        shouldOpenSlotMenuUp(anchor.getBoundingClientRect(), menuHeight),
      );
    };
    updatePlacement();
    window.addEventListener('resize', updatePlacement);
    window.addEventListener('scroll', updatePlacement, true);
    return () => {
      window.removeEventListener('resize', updatePlacement);
      window.removeEventListener('scroll', updatePlacement, true);
    };
  }, [menuOpen, options.length]);

  // Close the menu on an outside click or Escape while it's open.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onDocMouseDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const toggleMenu = () => setMenuOpen((open) => !open);
  const openMenuFromContext = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setMenuOpen(true);
  };

  return (
    <span ref={containerRef} className="anime-to-anime-slot">
      <span className="anime-to-anime-slot-bubble">
        <PathStepBubble step={selected.show} compact={compact} onOpenStep={onOpenStep} />
      </span>
      {/* The title area is the dropdown trigger: left-click and right-click
          both open the show picker. The bubble keeps modal / AniList. */}
      <span className="anime-to-anime-slot-titlewrap" onContextMenu={openMenuFromContext}>
        <button
          type="button"
          className="anime-to-anime-win-path-label anime-to-anime-slot-title"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={toggleMenu}
        >
          {label}
        </button>
        {extraCount > 0 && (
          <button
            type="button"
            className="anime-to-anime-slot-caret"
            aria-hidden="true"
            tabIndex={-1}
            title={`${options.length} shows share this slot`}
            onClick={toggleMenu}
          >
            +{extraCount}
          </button>
        )}
      </span>
      {menuOpen && (
        <ul
          ref={menuRef}
          className={
            menuOpensUp
              ? 'anime-to-anime-slot-menu anime-to-anime-slot-menu--up'
              : 'anime-to-anime-slot-menu'
          }
          role="menu"
        >
          {options.map((option, index) => (
            <li key={option.show.mediaId}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={index === selectedIndex}
                className={
                  index === selectedIndex
                    ? 'anime-to-anime-slot-menu-item is-selected'
                    : 'anime-to-anime-slot-menu-item'
                }
                onClick={() => {
                  onSelect(index);
                  setMenuOpen(false);
                }}
              >
                {option.show.coverImage ? (
                  <img
                    className="anime-to-anime-slot-menu-cover"
                    src={option.show.coverImage}
                    alt=""
                    loading="lazy"
                  />
                ) : (
                  <span className="anime-to-anime-slot-menu-cover anime-to-anime-slot-menu-cover--blank" />
                )}
                <span className="anime-to-anime-slot-menu-title">{option.show.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
