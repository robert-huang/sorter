import { useMemo, useState } from 'react';
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

/**
 * One occurrence of an item id across the staged groups. Order
 * mirrors group iteration order, so `occurrences[0]` is the "winner"
 * that `buildSortInputFromStaged` will keep — every entry past
 * index 0 is silently dropped from the sort input.
 */
export interface DuplicateOccurrence {
  groupId: string;
  groupSource: string;
  /** Position of this item within the source group (1-indexed for display). */
  positionInGroup: number;
}

/**
 * For each item that appears in >1 groups, return the ordered list
 * of where it appears. Used by the staged panel to surface dedup
 * collisions BEFORE the user starts the sort — otherwise
 * `buildSortInputFromStaged` silently drops the later occurrences
 * and the user has no idea their carefully-uploaded second sublist
 * was effectively a no-op.
 *
 * Pure derivation from `groups`; intentionally separate from
 * `buildSortInputFromStaged` so a UI-only re-render doesn't pay the
 * cost of re-collapsing every item into sublists/extras.
 */
export function findDuplicateOccurrences(
  groups: StagedGroup[],
): Map<ItemId, DuplicateOccurrence[]> {
  const all = new Map<ItemId, DuplicateOccurrence[]>();
  for (const g of groups) {
    g.items.forEach((it, idx) => {
      let arr = all.get(it.id);
      if (!arr) {
        arr = [];
        all.set(it.id, arr);
      }
      arr.push({
        groupId: g.id,
        groupSource: g.source,
        positionInGroup: idx + 1,
      });
    });
  }
  // Strip ids that only ever appear once — those aren't duplicates.
  // Keeping them in the map would force callers to filter on every
  // lookup; cheaper to do it once here.
  for (const [id, arr] of all) {
    if (arr.length < 2) all.delete(id);
  }
  return all;
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
  /**
   * Remove a single item from a STAGED group (no-op for pending).
   * If the removal empties the group, the parent should drop the
   * whole group rather than leaving an empty husk in the panel —
   * `StartScreen`'s implementation does exactly that.
   *
   * Optional so other call sites (tests, future hosts) can omit it;
   * when missing, item rows just don't render their × button.
   */
  onRemoveItemFromGroup?: (groupId: string, itemId: ItemId) => void;
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
  onRemoveItemFromGroup,
}: Props) {
  const combined = useMemo(() => [...staged, ...pending], [staged, pending]);
  const summary = useMemo(() => buildSortInputFromStaged(combined), [combined]);
  const duplicates = useMemo(() => findDuplicateOccurrences(combined), [combined]);
  const alreadySortedReady = isAlreadySortedReady(combined);
  // Per-group expansion state. Lives here (not as a single
  // currently-expanded id) so the user can fan multiple groups open
  // to compare them side-by-side — useful when chasing a duplicate.
  // Keyed by group id; pending groups use their own synthetic ids
  // (e.g. `__pending_scratch__`) so they don't clash with real ones.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Count of items that appear in 2+ groups, summed by extra
  // occurrences (so an item appearing in 3 groups contributes 2 to
  // the count — it'll be dropped from 2 of them). This matches what
  // the user actually loses to dedup.
  const duplicateDropCount = useMemo(() => {
    let n = 0;
    for (const occs of duplicates.values()) n += occs.length - 1;
    return n;
  }, [duplicates]);

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

      {/*
        Cross-source duplicate warning. Surfaces the silent dedup
        that `buildSortInputFromStaged` does — without this hint, a
        user uploading two CSVs of the same list with one item
        slightly different in each would see "Sort N items" and
        only later wonder why the second list's metadata vanished.
        The "first occurrence wins" rule is exactly what we apply
        below in the per-item badges so the user can audit it.
      */}
      {duplicateDropCount > 0 && (
        <div
          className="staged-panel-dup-warning"
          role="status"
          aria-live="polite"
          title="Click a group to expand it and see which entries are duplicates"
        >
          <strong>{duplicateDropCount}</strong> duplicate{' '}
          {duplicateDropCount === 1 ? 'entry' : 'entries'} across sources —
          the first occurrence of each is kept, the rest are skipped on
          sort. Expand a group to see which.
        </div>
      )}

      <ul className="staged-panel-groups">
        {combined.map((g) => {
          const isPending = pending.some((p) => p.id === g.id);
          const isOpen = expanded.has(g.id);
          // Duplicates affecting THIS group: count the rows that
          // will be silently dropped by `buildSortInputFromStaged`.
          // A row at position `idx+1` is a loser whenever the
          // FIRST occurrence of its id is anywhere else — either a
          // different group or an earlier row in this same group
          // (intra-group dupes count too). The per-group "N dup"
          // badge shows this so the user knows at a glance which
          // sources are losing entries to dedup.
          let groupLosingCount = 0;
          g.items.forEach((it, idx) => {
            const occs = duplicates.get(it.id);
            if (!occs) return;
            const winner = occs[0];
            const isWinner =
              winner.groupId === g.id && winner.positionInGroup === idx + 1;
            if (!isWinner) groupLosingCount += 1;
          });
          return (
            <li
              className={`staged-panel-group${isPending ? ' pending' : ''}${isOpen ? ' expanded' : ''}`}
              key={g.id}
            >
              <button
                type="button"
                className="staged-panel-group-row"
                onClick={() => toggleExpanded(g.id)}
                aria-expanded={isOpen}
                aria-controls={`staged-group-items-${g.id}`}
                title={isOpen ? 'Collapse' : 'Expand to see and edit items'}
              >
                <span className="staged-panel-caret" aria-hidden>
                  {isOpen ? '▾' : '▸'}
                </span>
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
                {groupLosingCount > 0 && (
                  <span
                    className="staged-panel-group-dup"
                    title={`${groupLosingCount} item${groupLosingCount === 1 ? '' : 's'} in this group already staged in an earlier source — will be ignored on sort`}
                  >
                    {groupLosingCount} dup
                  </span>
                )}
                {isPending && (
                  <span
                    className="staged-panel-pending-marker"
                    title="In the current tab but not yet added — click 'Add to staged' there, or just hit Start to include it"
                  >
                    pending
                  </span>
                )}
              </button>
              {/*
                Group-level × button is rendered OUTSIDE the
                expand-toggle button so clicking it doesn't also
                toggle the expansion (and so it isn't nested inside
                another <button>, which is invalid HTML). Hidden for
                pending groups — those are materialised from the
                source the user is currently editing, so the
                "remove" handle there is the source itself.
              */}
              {!isPending && (
                <button
                  type="button"
                  className="x-button staged-panel-group-remove"
                  onClick={() => onRemoveGroup(g.id)}
                  aria-label={`Remove ${g.source} from staged items`}
                  title="Remove this whole source from staged"
                >
                  ×
                </button>
              )}

              {isOpen && (
                <ol
                  id={`staged-group-items-${g.id}`}
                  className={`staged-panel-items kind-${g.kind}`}
                >
                  {g.items.map((it, idx) => {
                    const occs = duplicates.get(it.id);
                    const isDuplicate = occs !== undefined;
                    // The winner is the FIRST occurrence in iteration
                    // order — that's the row `buildSortInputFromStaged`
                    // keeps. Match BOTH groupId AND positionInGroup so
                    // intra-group duplicates resolve correctly: when
                    // the same item appears twice inside one source,
                    // only the first copy is the winner; the second
                    // copy must badge as "will be skipped" even
                    // though it shares the group with the winner.
                    const positionInGroup = idx + 1;
                    const isWinner =
                      !isDuplicate ||
                      (occs[0].groupId === g.id &&
                        occs[0].positionInGroup === positionInGroup);
                    // "Other" occurrences = everywhere this item shows
                    // up EXCEPT this exact row. For intra-group dupes
                    // the "other" can be the same source at a
                    // different row — that's still useful to surface
                    // ("kept at #1 of this list") so the user can
                    // jump to the row that's actually contributing.
                    const otherOccurrences =
                      occs?.filter(
                        (o) =>
                          !(o.groupId === g.id && o.positionInGroup === positionInGroup),
                      ) ?? [];
                    return (
                      <li
                        className={`staged-panel-item${isDuplicate && !isWinner ? ' duplicate-loser' : ''}${isDuplicate && isWinner ? ' duplicate-winner' : ''}`}
                        key={`${it.id}-${idx}`}
                      >
                        {g.kind === 'sublist' && (
                          <span
                            className="staged-panel-item-rank"
                            aria-hidden
                            title="Position within this pre-ranked sublist"
                          >
                            {idx + 1}
                          </span>
                        )}
                        {it.imageUrl ? (
                          <img
                            className="staged-panel-item-cover"
                            src={it.imageUrl}
                            alt=""
                            loading="lazy"
                          />
                        ) : (
                          <span
                            className="staged-panel-item-cover staged-panel-item-cover-placeholder"
                            aria-hidden
                          />
                        )}
                        <span className="staged-panel-item-label">
                          {it.label}
                        </span>
                        {isDuplicate && !isWinner && (
                          <span
                            className="staged-panel-item-dup-badge"
                            title={`Also in: ${otherOccurrences
                              .map((o) => `${o.groupSource} (#${o.positionInGroup})`)
                              .join(', ')}. This row will be skipped on sort because an earlier occurrence claimed the same item.`}
                          >
                            duplicate — will be skipped
                          </span>
                        )}
                        {isDuplicate && isWinner && (
                          <span
                            className="staged-panel-item-dup-badge winner"
                            title={`Also appears in: ${otherOccurrences
                              .map((o) => `${o.groupSource} (#${o.positionInGroup})`)
                              .join(', ')}. This is the FIRST occurrence so it's the one that's kept — the others will be skipped.`}
                          >
                            also in {otherOccurrences.length} other
                            {otherOccurrences.length === 1 ? '' : 's'}
                          </span>
                        )}
                        {!isPending && onRemoveItemFromGroup && (
                          <button
                            type="button"
                            className="x-button staged-panel-item-remove"
                            onClick={() => onRemoveItemFromGroup(g.id, it.id)}
                            aria-label={`Remove ${it.label} from ${g.source}`}
                            title="Remove this entry from the group"
                          >
                            ×
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
