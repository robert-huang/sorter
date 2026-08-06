import { useContext, useState } from 'react';
import {
  isAnilistPageUrl,
} from '../lib/importers/anilist/anilistLinks';
import { AnilistMiddleClickLink } from '../lib/importers/anilist/AnilistMiddleClickLink';
import type { Item } from '../lib/types';
import {
  canOpenItemDetail,
  ItemDetailContext,
  type ItemDetailOpener,
} from './itemDetailContext';

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
  /** Explicit opener for trees that do not provide ItemDetailContext. */
  onOpenDetail?: ItemDetailOpener | null;
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
  onOpenDetail,
}: ItemThumbProps) {
  const [failed, setFailed] = useState(false);
  const showImage = item.imageUrl && !failed;
  const Tag = as;
  // App-level opt-in for "click thumb to open detail panel". Only
  // AniList media + staff items have a panel to show (see
  // canOpenItemDetail); other source kinds fall back to the
  // non-interactive thumb. The opener may be null (e.g. in tests that
  // don't wrap the tree with ItemDetailContext.Provider).
  const contextOpener = useContext(ItemDetailContext);
  const opener = onOpenDetail === undefined ? contextOpener : onOpenDetail;
  const opensDetail = Boolean(opener && canOpenItemDetail(item));
  // AniList items are materialised with `url` = their canonical AniList
  // page (see buildAnilistMediaUrl). Media/staff thumbs: left-click opens
  // the detail modal, middle-click opens AniList. Character/studio
  // favourites carry an AniList url but no detail panel — middle-click
  // only; left-click is a no-op.
  const anilistUrl =
    item.url && isAnilistPageUrl(item.url) ? item.url : undefined;
  const middleClickOnly = Boolean(anilistUrl && !opensDetail);
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
  if (opensDetail) {
    if (!anilistUrl) {
      return (
        <button
          type="button"
          className={`${className ?? ''} item-thumb-button`.trim()}
          aria-label={`Details for ${item.label}`}
          title={`Details for ${item.label}`}
          onClick={(e) => {
            e.stopPropagation();
            opener!(item);
          }}
        >
          {inner}
        </button>
      );
    }
    return (
      <AnilistMiddleClickLink
        url={anilistUrl}
        className={`${className ?? ''} item-thumb-button`.trim()}
        aria-label={`Details for ${item.label}`}
        title={`Details for ${item.label} (middle-click to open on AniList)`}
        onPrimaryClick={(e) => {
          e.stopPropagation();
          opener!(item);
        }}
      >
        {inner}
      </AnilistMiddleClickLink>
    );
  }
  if (middleClickOnly) {
    return (
      <AnilistMiddleClickLink
        url={anilistUrl!}
        className={className ?? ''}
        title={`${item.label} (middle-click to open on AniList)`}
        onPrimaryClick={(e) => {
          e.stopPropagation();
        }}
      >
        {inner}
      </AnilistMiddleClickLink>
    );
  }
  return <Tag className={className}>{inner}</Tag>;
}
