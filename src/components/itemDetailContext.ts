import { createContext } from 'react';
import type { Item } from '../lib/types';

/**
 * App-provided callback for opening a per-item detail panel. Consumed
 * by {@link ItemThumb} (and any future per-row affordance) so screens
 * don't need to prop-drill the open handler through every nested
 * sub-component.
 *
 * Why a context, not props:
 *   - ListScreen renders Items through 5+ different sub-components
 *     (current-merge slices, queue sublists, to-be-inserted, pending,
 *     sorted, hidden). Threading `onOpenItemDetail` through all of
 *     them just so the thumb at the leaf can call it would balloon
 *     every Props interface. The context keeps the per-component
 *     surface area unchanged.
 *   - Detail panels are inherently App-level (the modal renders at
 *     the App root anyway). Context aligns the data flow with the
 *     rendering location.
 *
 * Default = null. ItemThumb skips the button wrapping when null, so
 * tests + screens that don't wire the context behave identically to
 * pre-Phase-D.
 */
export type ItemDetailOpener = (item: Item) => void;

export const ItemDetailContext = createContext<ItemDetailOpener | null>(null);
