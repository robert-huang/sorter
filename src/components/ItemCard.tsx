import { useContext, useState } from 'react';
import type { Item } from '../lib/types';
import { getItemSourceKind } from '../lib/types';
import { InfoIcon, TrashIcon } from './icons';
import { ItemDetailContext } from './itemDetailContext';

interface Props {
  item: Item;
  onPick?: () => void;
  onRemove?: () => void;
  /** When true, clicking does nothing (e.g. while in done state showing previews). */
  disabled?: boolean;
}

export function ItemCard({ item, onPick, onRemove, disabled }: Props) {
  const [imgFailed, setImgFailed] = useState(false);
  // App-provided opener for the media detail panel (AnilistDetailModal).
  // Only AniList items have a panel to show, so mirror ItemThumb's gate
  // and skip the button entirely for other source kinds (and in tests /
  // hosts that don't wrap the tree with the provider, where opener is null).
  const opener = useContext(ItemDetailContext);
  const canOpenDetail = !!opener && getItemSourceKind(item) === 'anilist';

  function onDetailClick(e: React.MouseEvent): void {
    // Stop the card's onClick (a pick) from also firing.
    e.stopPropagation();
    opener?.(item);
  }

  function onClick(): void {
    if (disabled) return;
    if (onPick) onPick();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (disabled) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // Only handle activation when the card itself is focused. Without
    // this guard, Enter pressed on the inner remove-button or external
    // link would double-fire: once for the child's native action, again
    // here as the keydown bubbles up to the card.
    if (e.target !== e.currentTarget) return;
    e.preventDefault(); // Space scrolls the page by default; suppress.
    if (onPick) onPick();
  }

  function onMouseUp(e: React.MouseEvent): void {
    if (disabled) return;
    if (e.button === 1 && item.url) {
      e.preventDefault();
      window.open(item.url, '_blank', 'noopener,noreferrer');
    }
  }

  function onAuxClick(e: React.MouseEvent): void {
    // Prevent middle-click "paste" or autoscroll behavior on some browsers.
    if (e.button === 1) e.preventDefault();
  }

  function onRemoveClick(e: React.MouseEvent): void {
    e.stopPropagation();
    if (onRemove) onRemove();
  }

  const showImage = item.imageUrl && !imgFailed;

  return (
    <div
      className={`item-card${disabled ? ' disabled' : ''}${
        showImage ? '' : ' text-only'
      }`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onMouseUp={onMouseUp}
      onAuxClick={onAuxClick}
      role="button"
      // Disabled cards stay focusable for screen readers but skip
      // activation. tabIndex=-1 would hide them from tab order; we
      // prefer aria-disabled so the read order still flows naturally.
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={`Pick ${item.label}`}
      title={item.label}
    >
      {onRemove && (
        <button
          className="remove-btn"
          onClick={onRemoveClick}
          aria-label={`Remove ${item.label}`}
          title="Remove from sort"
        >
          <TrashIcon size={14} />
        </button>
      )}
      {showImage && (
        <div className="image-wrap">
          <img
            src={item.imageUrl}
            alt={item.label}
            onError={() => setImgFailed(true)}
            draggable={false}
          />
        </div>
      )}
      <div className="label">{item.label}</div>
      {item.url && (
        <a
          className="link-icon"
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title={item.url}
        >
          🔗
        </a>
      )}
      {canOpenDetail && (
        <button
          type="button"
          className="detail-btn"
          onClick={onDetailClick}
          aria-label={`Details for ${item.label}`}
          title="View media details"
        >
          <InfoIcon size={14} />
        </button>
      )}
    </div>
  );
}
