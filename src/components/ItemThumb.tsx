import { useState } from 'react';
import type { Item } from '../lib/types';

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
  return (
    <Tag className={className}>
      {showImage ? (
        <img
          src={item.imageUrl}
          alt=""
          onError={() => setFailed(true)}
          draggable={false}
        />
      ) : (
        <span className={placeholderClass}>{initials(item.label)}</span>
      )}
    </Tag>
  );
}
