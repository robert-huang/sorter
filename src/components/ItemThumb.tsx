import { useContext, useState } from 'react';
import type { Item } from '../lib/types';
import { getItemSourceKind } from '../lib/types';
import { ItemDetailContext } from './itemDetailContext';

/**
 * `initials` derives a short visual label from `label`. Used as the
 * placeholder text when an item has no imageUrl OR when the image
 * URL is broken (404, CORS, network failure).
 *
 * Rules:
 *  - empty/whitespace-only → '?'
 *  - one word → first two letters, upper-cased
 *  - two+ words → first letter of word 1 + first letter of word 2
 */
export function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

interface ItemThumbProps {
  item: Item;
  /**
   * Class for the OUTER wrapper. Callers control sizing/positioning
   * via this — that's why there's no default: every place this lives
   * inside a layout (.thumb / .image-wrap / .preview) with its own
   * dimensions.
   */
  className?: string;
  /** Outer element tag. Defaults to 'span' to be inline-flexible. */
  as?: 'span' | 'div';
  /**
   * Class for the placeholder element shown when imageUrl is empty
   * or the image failed to load. Defaults to 'placeholder' (matches
   * the ResultScreen styling); callers using compact contexts (e.g.
   * the ListScreen sub-list thumbs) can pass undefined to inherit
   * the parent's text styling.
   */
  placeholderClass?: string;
}

/**
 * Shared thumbnail renderer for an item. Single source of truth for
 * three rules previously duplicated across ListScreen + ResultScreen
 * + ItemCard:
 *
 *  1. If `imageUrl` is set AND the image loads, render `<img>`.
 *  2. On image load failure (`onError`), switch to the initials
 *     placeholder so we don't leave a broken-image icon in the UI.
 *  3. If `imageUrl` is missing entirely, render the initials placeholder.
 *
 * Note: ItemCard intentionally keeps its own logic (text-only mode
 * collapses the image area entirely) because its layout changes
 * shape when there's no image. This component is for sites where
 * the thumb slot is always reserved.
 */
export function ItemThumb({
  item,
  className,
  as = 'span',
  placeholderClass = 'placeholder',
}: ItemThumbProps) {
  const [failed, setFailed] = useState(false);
  const showImage = item.imageUrl && !failed;
  const Tag = as;
  // App-level opt-in for "click thumb to open detail panel". Currently
  // only AniList items have a panel to show; other source kinds fall
  // back to the non-interactive thumb. The opener may be null (e.g. in
  // tests that don't wrap the tree with ItemDetailContext.Provider).
  const opener = useContext(ItemDetailContext);
  const clickable = opener && getItemSourceKind(item) === 'anilist';
  const inner = showImage ? (
    <img
      src={item.imageUrl}
      alt=""
      onError={() => setFailed(true)}
      draggable={false}
    />
  ) : (
    <span className={placeholderClass}>{initials(item.label)}</span>
  );
  if (clickable) {
    // Render as a transparent button so keyboard focus + native
    // click-handling work without extra ARIA wiring. Keep the
    // caller's className so layout sizing stays intact; the button
    // resets default chrome via CSS.
    return (
      <button
        type="button"
        className={`${className ?? ''} item-thumb-button`.trim()}
        onClick={(e) => {
          // stopPropagation so a parent row's click handler doesn't
          // also fire (none today, but defensively the modal-open
          // shouldn't double up with hide/select/drag elsewhere).
          e.stopPropagation();
          opener!(item);
        }}
        aria-label={`Details for ${item.label}`}
        title={`Details for ${item.label}`}
      >
        {inner}
      </button>
    );
  }
  return <Tag className={className}>{inner}</Tag>;
}
