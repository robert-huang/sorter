import { useState } from 'react';
import type { Item } from '../lib/types';

/**
 * Mirrors `SlotAnimKind` in CompareScreen — duplicated here to avoid
 * cross-component type imports for what is essentially a CSS attribute
 * value. Keep in sync if a new kind is added.
 */
type MountAnim = 'pop' | 'deck' | 'fade' | 'none';

interface Props {
  item: Item;
  /** When set, replaces `item.label` (used for the `...n` overflow tail). */
  labelOverride?: string;
  /** Overflow tail only: align the label toward the deck splay edge. */
  isOverflow?: boolean;
  /**
   * Stack depth, 1-indexed. 1 = closest to the live card (largest, most
   * opaque); higher numbers are progressively smaller and more faded.
   * Maps to a CSS attribute selector — see `.compare-peek-card[data-depth=...]`
   * rules in styles.css.
   */
  depth: number;
  /**
   * The `leftAnimKind` / `rightAnimKind` of the parent slot at the
   * moment this peek card mounts. Frozen below via `useState` so the
   * entry keyframe runs ONCE on initial mount and never re-fires when
   * the parent slot's `data-anim` flips on a subsequent pick — that
   * re-fire is what previously clobbered the smooth depth-2 → depth-1
   * transform interpolation for cards that persist across the pick
   * (the browser sees `animation-name` change on the still-alive
   * `.compare-peek-card-inner` and replays from frame 0, snapping
   * transform back to the start keyframe).
   */
  mountAnim: MountAnim;
}

/**
 * A non-interactive visual card rendered behind the live comparison
 * cards as part of the peek "deck". Shows a faded card body that's
 * almost entirely occluded by the live card; only a bottom strip and
 * a small side sliver remain visible. The label sits in that bottom
 * strip via `.peek-label-strip` (single-line, ellipsis-truncated).
 *
 * Deliberately does NOT render the item's image: the image area is
 * fully hidden behind the live card anyway, and dropping it keeps the
 * peek cheap and avoids loading extra images per pair just to
 * not render them. The full label is surfaced via the native browser
 * tooltip on hover (`title`).
 *
 * Marked `aria-hidden` because the visible peek is purely a sighted-
 * user hint — assistive tech users already get the live A/B cards
 * announced through `ItemCard` and don't need the rank-adjacent
 * preview re-read.
 */
export function PeekCard({
  item,
  labelOverride,
  isOverflow = false,
  depth,
  mountAnim,
}: Props) {
  const label = labelOverride ?? item.label;
  // Capture the mount animation kind exactly once on initial mount.
  // Subsequent prop changes are intentionally ignored — see the
  // mountAnim prop docs above for why.
  const [frozenMountAnim] = useState<MountAnim>(mountAnim);
  // The inner wrapper exists solely to host the mount-time entry
  // animation (scale + opacity). Putting that animation on the outer
  // would conflict with the depth-positioning transform that lives on
  // `.compare-peek-card[data-depth=...]` and would prevent the smooth
  // depth-2 → depth-1 transition that runs when an existing peek card
  // shifts up during a 'deck' transition. The composition is:
  //   outer: translate + scale-by-depth (smooth transition on depth change)
  //   inner: scale 0.92|0.35 → 1 + opacity 0 → 1 (one-shot on mount)
  return (
    <div
      className="compare-peek-card"
      data-depth={depth}
      data-mount-anim={frozenMountAnim}
      data-peek-overflow={isOverflow ? '' : undefined}
      aria-hidden="true"
      title={label}
    >
      <div className="compare-peek-card-inner">
        <span className="peek-label-strip">{label}</span>
      </div>
    </div>
  );
}
