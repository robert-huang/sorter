import { useContext } from 'react';
import type { Item } from '../lib/types';
import { canOpenItemDetail, ItemDetailContext } from './itemDetailContext';

export type DetailButtonVariant = 'chip' | 'row' | 'staged';

function classNameForVariant(variant: DetailButtonVariant): string {
  if (variant === 'chip') return 'x detail';
  if (variant === 'staged') return 'x-button staged-panel-item-detail detail';
  return 'icon-btn detail';
}

/**
 * Opens the AniList media/staff detail panel when `item.source` supports
 * it. Hidden for manual items or when no {@link ItemDetailContext} opener
 * is wired (tests).
 */
export function DetailButton({
  item,
  variant,
}: {
  item: Item;
  variant: DetailButtonVariant;
}) {
  const opener = useContext(ItemDetailContext);
  if (!opener || !canOpenItemDetail(item)) return null;
  return (
    <button
      type="button"
      className={classNameForVariant(variant)}
      onClick={(e) => {
        e.stopPropagation();
        opener(item);
      }}
      title={`Details for "${item.label}"`}
      aria-label={`Details for ${item.label}`}
    >
      ⓘ
    </button>
  );
}
