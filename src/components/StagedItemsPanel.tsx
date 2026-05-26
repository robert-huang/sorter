import { useMemo } from 'react';
import type { Item, ItemId } from '../lib/types';

/**
 * One bucket of items the user has added on the START screen from
 * one specific source (a pasted CSV, a pre-ranked file, an AniList
 * selection, …). Groups stack: the user can keep adding from any tab
 * and they accumulate until they hit "Start sort".
 *
 *  - `kind: 'flat'` — items are unranked among themselves. They go
 *    into the merge sort as singleton sublists (i.e. they will be
 *    compared against everything else from scratch).
 *  - `kind: 'sublist'` — items are already in ranking order. They go
 *    into the merge sort as ONE sublist, so their relative order is
 *    preserved and only the merge between sublists needs questions.
 *
 * `id` is a synthetic value just for React keying + the remove
 * button; it isn't persisted anywhere.
 */
export type StagedGroup =
  | { kind: 'flat'; id: string; source: string; items: Item[] }
  | {
      kind: 'sublist';
      id: string;
      source: string;
      items: Item[];
      /**
       * When true and the staged list contains ONLY this group, the
       * start CTA offers "Use as ranking" — which routes through
       * `seedAsSorted` (skip the merge sort entirely; the slot
       * enters insertion mode immediately).
       *
       * Set by the scratch tab when the user ticks the "already in
       * ranking order" checkbox before adding to staged. Once any
       * other group is staged, the hint is silently ignored and the
       * sublist participates in a normal merge instead.
       */
      seedAsSortedHint?: boolean;
    };

/**
 * `StagedGroup` minus the synthetic `id`, distributed across the
 * union so the sublist variant keeps `seedAsSortedHint`. Plain
 * `Omit<StagedGroup, 'id'>` collapses the union and would drop the
 * sublist-only field — TS's Omit is not distributive by default.
 */
export type StagedGroupInput = StagedGroup extends infer T
  ? T extends { id: string }
    ? Omit<T, 'id'>
    : never
  : never;

/**
 * Collapse the staged groups down to the (sublists, extras) shape
 * the sort engine consumes. Dedup is by `Item.id`; an item that
 * appears in MULTIPLE groups is kept only in its FIRST occurrence's
 * group, so a sublist's order isn't broken by a later flat group
 * also mentioning the same item, and a flat-then-sublist ordering
 * keeps the sublist-position too (because the flat one wins).
 *
 * Note: this is deterministic on group iteration order, which is
 * insertion order in the staged array. That means "later additions
 * don't displace earlier ones" — matches the user's mental model of
 * adding to a shopping cart.
 */
export function buildSortInputFromStaged(groups: StagedGroup[]): {
  sublists: Item[][];
  extras: Item[];
  uniqueCount: number;
  sublistCount: number;
} {
  const seen = new Set<ItemId>();
  const sublists: Item[][] = [];
  const extras: Item[] = [];
  for (const g of groups) {
    const taken: Item[] = [];
    for (const it of g.items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      taken.push(it);
    }
    if (taken.length === 0) continue;
    if (g.kind === 'sublist') {
      sublists.push(taken);
    } else {
      for (const it of taken) extras.push(it);
    }
  }
  return {
    sublists,
    extras,
    uniqueCount: seen.size,
    sublistCount: sublists.length,
  };
}

interface Props {
  /** Groups the user has explicitly added via "Add to staged". */
  staged: StagedGroup[];
  /**
   * Groups the CURRENT START tab would add if the user hit its
   * per-tab "Add to staged" CTA right now. Rendered in the same
   * list but visually subdued and without an × button — to remove
   * pending content, the user edits the source textarea/files
   * directly. Start uses staged + pending combined so there's no
   * surprise about what gets sorted.
   */
  pending: StagedGroup[];
  onRemoveGroup: (id: string) => void;
  onClearAll: () => void;
  onStartSort: () => void;
  onStartAlreadySorted: () => void;
}

/**
 * The combined list is in "already sorted" mode iff there's exactly
 * one group, it's a sublist, and it carries the seed-as-sorted hint.
 * Anything else (a second group, a flat group, a sublist without the
 * hint) demotes the CTA back to the normal merge-sort path.
 */
function isAlreadySortedReady(combined: StagedGroup[]): boolean {
  if (combined.length !== 1) return false;
  const g = combined[0];
  return g.kind === 'sublist' && g.seedAsSortedHint === true;
}

export function StagedItemsPanel({
  staged,
  pending,
  onRemoveGroup,
  onClearAll,
  onStartSort,
  onStartAlreadySorted,
}: Props) {
  const combined = useMemo(() => [...staged, ...pending], [staged, pending]);
  const summary = useMemo(() => buildSortInputFromStaged(combined), [combined]);
  const alreadySortedReady = isAlreadySortedReady(combined);

  if (combined.length === 0) {
    return (
      <div className="staged-panel empty" aria-live="polite">
        <span className="staged-panel-empty-hint">
          Nothing staged yet. Add items from any tab above — clipboard,
          pre-ranked lists, and AniList all stack into one sort.
        </span>
      </div>
    );
  }

  return (
    <div className="staged-panel" aria-label="Staged items for sorting">
      <div className="staged-panel-header">
        <div className="staged-panel-summary">
          <strong>{summary.uniqueCount}</strong>{' '}
          unique item{summary.uniqueCount === 1 ? '' : 's'} ready across{' '}
          <strong>{combined.length}</strong> source
          {combined.length === 1 ? '' : 's'}
          {summary.sublistCount > 0 && (
            <>
              {' '}
              ({summary.sublistCount} pre-ranked sublist
              {summary.sublistCount === 1 ? '' : 's'})
            </>
          )}
          {pending.length > 0 && staged.length > 0 && (
            <>
              {' '}
              — including {pending.length} unstaged
            </>
          )}
        </div>
        <div className="staged-panel-actions">
          {staged.length > 0 && (
            <button
              type="button"
              className="btn"
              onClick={onClearAll}
              title="Remove every staged group"
            >
              Clear staged
            </button>
          )}
          {alreadySortedReady ? (
            <button
              type="button"
              className="btn primary"
              onClick={onStartAlreadySorted}
              title="Skip the merge sort — treat these as the final ranking and enter insertion mode"
            >
              Use as ranking ({summary.uniqueCount})
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={summary.uniqueCount < 2}
              onClick={onStartSort}
            >
              Start sort ({summary.uniqueCount})
            </button>
          )}
        </div>
      </div>
      <ul className="staged-panel-groups">
        {combined.map((g) => {
          const isPending = pending.some((p) => p.id === g.id);
          return (
            <li
              className={`staged-panel-group${isPending ? ' pending' : ''}`}
              key={g.id}
            >
              <span
                className={`staged-panel-kind kind-${g.kind}`}
                title={
                  g.kind === 'sublist'
                    ? 'Pre-ranked — order preserved during merge'
                    : 'Unranked — items compete from scratch'
                }
              >
                {g.kind === 'sublist' ? 'ranked' : 'unranked'}
              </span>
              <span className="staged-panel-source">{g.source}</span>
              <span className="staged-panel-count">
                {g.items.length} item{g.items.length === 1 ? '' : 's'}
              </span>
              {isPending ? (
                <span
                  className="staged-panel-pending-marker"
                  title="In the current tab but not yet added — click 'Add to staged' there, or just hit Start to include it"
                >
                  pending
                </span>
              ) : (
                <button
                  type="button"
                  className="x-button"
                  onClick={() => onRemoveGroup(g.id)}
                  aria-label={`Remove ${g.source} from staged items`}
                  title="Remove from staged"
                >
                  ×
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
