import { useMemo, useRef, useState } from 'react';
import type { Item, ItemId } from '../lib/types';
import { useClickOutside } from '../lib/hooks/useClickOutside';

/**
 * Which engine the current START draft will start in. Non-persisted —
 * lives in StartScreen state, defaults to 'merge', and resets to 'merge'
 * for every new draft. Chosen via the Start Sort split-button's chevron
 * menu; see `seedInsertionFromSublists` for the insertion path.
 */
export type StartMode = 'merge' | 'insertion';

/**
 * Soft-removal markers shared by both group variants. Splitting them
 * out keeps `StagedGroup` readable and lets the distributive
 * `StagedGroupInput` carry the flags too without re-listing them in
 * each variant.
 *
 * Why a Set (not an array) for items? The panel hot-paths a
 * per-render `markedItemIds.has(it.id)` lookup; arrays would force
 * `.includes` which is O(n) per item — fine for 10 items, painful
 * for a 500-item AniList sublist with overlapping marks. `StagedGroup`
 * is transient React state (never serialised to OPFS) so the Set is
 * fine. Read-only because callers shouldn't mutate in-place — the
 * parent always replaces the whole group on toggle, which keeps React
 * change detection honest.
 */
export interface StagedRemovalMarkers {
  /** When true the whole group is "staged to remove" — visually
   *  struck-through and excluded by `buildSortInputFromStaged`. The
   *  per-item marks are PRESERVED while the group is marked so undoing
   *  the group restores the previous per-item state. */
  markedForRemoval?: boolean;
  /** Per-item soft-removal set. Items in this set are visually
   *  struck-through (same as a marked group) and excluded by the sort
   *  builder. Ignored when `markedForRemoval` is true at the group
   *  level since the whole group is gone anyway — but kept so undoing
   *  the group brings the per-item state back. */
  markedItemIds?: ReadonlySet<ItemId>;
}

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
  | ({
      kind: 'flat';
      id: string;
      source: string;
      items: Item[];
    } & StagedRemovalMarkers)
  | ({
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
    } & StagedRemovalMarkers);

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
 * Soft-removed content (groups with `markedForRemoval` or items in
 * `markedItemIds`) is dropped BEFORE dedup, so the sort engine never
 * sees them — they are gone for real on Start Sort, not added as
 * pre-hidden items.
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
    if (g.markedForRemoval) continue;
    const itemMarks = g.markedItemIds;
    const taken: Item[] = [];
    for (const it of g.items) {
      if (itemMarks?.has(it.id)) continue;
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
 * Soft-removed content is skipped — if the user has already marked
 * a duplicate for removal there's nothing to warn about. This also
 * has the nice property that if a "winner" gets marked, the next
 * remaining occurrence is what the badges talk about.
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
    if (g.markedForRemoval) continue;
    const itemMarks = g.markedItemIds;
    g.items.forEach((it, idx) => {
      if (itemMarks?.has(it.id)) return;
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

/** Total count of items soft-removed across all groups (both
 *  whole-group marks and per-item marks). Used by the panel header
 *  to surface "N marked for removal" so the user is never surprised
 *  about what Start Sort will skip. */
export function countMarkedForRemoval(groups: readonly StagedGroup[]): number {
  let n = 0;
  for (const g of groups) {
    if (g.markedForRemoval) {
      n += g.items.length;
      continue;
    }
    if (g.markedItemIds && g.markedItemIds.size > 0) {
      // Counting unique items in the group that match the mark set —
      // group.items can have intra-group duplicates (same id twice),
      // and we only want to count one per id so the header total
      // matches the "items that disappear" the user actually sees.
      const seen = new Set<ItemId>();
      for (const it of g.items) {
        if (g.markedItemIds.has(it.id) && !seen.has(it.id)) {
          seen.add(it.id);
          n += 1;
        }
      }
    }
  }
  return n;
}

interface Props {
  /** Groups the user has explicitly added via "Add to staged". */
  staged: StagedGroup[];
  /**
   * Groups the CURRENT START tab would add if the user hit its
   * per-tab "Add to staged" CTA right now. Rendered in the same
   * list but visually subdued and without × / edit handles — to
   * remove pending content, the user edits the source textarea /
   * files directly. Start uses staged + pending combined so there's
   * no surprise about what gets sorted.
   */
  pending: StagedGroup[];
  /**
   * Soft-toggle a whole group's `markedForRemoval` flag. The group
   * stays in the panel struck-through so the user can ↺ it; only
   * Start Sort and "Clear staged" actually drop content.
   */
  onToggleRemoveGroup: (id: string) => void;
  /**
   * Hard clear-all: drops every staged group immediately (no undo).
   * Different from the per-row × — the user has to opt-in by name
   * via the "Clear staged" button in the header.
   */
  onClearAll: () => void;
  /** Start the sort using the currently-selected `startMode`. */
  onStartSort: () => void;
  onStartAlreadySorted: () => void;
  /**
   * Selected engine for the Start Sort split-button. Non-persisted; the
   * parent (StartScreen) owns it so it can also route header-tab draft
   * adoption (`tryAdoptDraft`) through the same mode.
   */
  startMode: StartMode;
  /** Pick a different engine from the split-button's chevron menu. */
  onStartModeChange: (mode: StartMode) => void;
  /**
   * Soft-toggle a single item's removal state inside a STAGED group
   * (no-op for pending — those rows render without action handles).
   * The item stays in the panel struck-through; Start Sort drops it
   * for real and the sort engine never sees it. Optional so other
   * call sites (tests, future hosts) can omit it; when missing,
   * item-level × buttons aren't rendered.
   */
  onToggleRemoveItem?: (groupId: string, itemId: ItemId) => void;
  /**
   * Open the per-item edit modal. Mirrors the CSV-preview's edit
   * flow but targets a staged item by (group, itemId) instead of
   * (sourceName, rowNumber). Optional for the same reason as the
   * toggle handlers above.
   */
  onEditItem?: (groupId: string, itemId: ItemId) => void;
}

/**
 * The combined list is in "already sorted" mode iff there's exactly
 * one group, it's a sublist, carries the seed-as-sorted hint, and is
 * not marked for removal. Anything else (a second group, a flat
 * group, a sublist without the hint, or a marked-for-removal sublist)
 * demotes the CTA back to the normal merge-sort path — or, in the
 * marked-for-removal case, disables Start Sort entirely.
 */
function isAlreadySortedReady(combined: StagedGroup[]): boolean {
  if (combined.length !== 1) return false;
  const g = combined[0];
  if (g.markedForRemoval) return false;
  return g.kind === 'sublist' && g.seedAsSortedHint === true;
}

export function StagedItemsPanel({
  staged,
  pending,
  onToggleRemoveGroup,
  onClearAll,
  onStartSort,
  onStartAlreadySorted,
  startMode,
  onStartModeChange,
  onToggleRemoveItem,
  onEditItem,
}: Props) {
  const combined = useMemo(() => [...staged, ...pending], [staged, pending]);
  const summary = useMemo(() => buildSortInputFromStaged(combined), [combined]);
  const duplicates = useMemo(() => findDuplicateOccurrences(combined), [combined]);
  const markedCount = useMemo(() => countMarkedForRemoval(combined), [combined]);
  const alreadySortedReady = isAlreadySortedReady(combined);
  // Per-group expansion state. Lives here (not as a single
  // currently-expanded id) so the user can fan multiple groups open
  // to compare them side-by-side — useful when chasing a duplicate.
  // Keyed by group id; pending groups use their own synthetic ids
  // (e.g. `__pending_scratch__`) so they don't clash with real ones.
  // Start Sort split-button chevron menu (engine picker). Closed by
  // outside-click / ESC via the shared popover hook. The ref wraps both
  // the split-button group AND the menu so clicking the chevron itself
  // doesn't count as "outside".
  const [startMenuOpen, setStartMenuOpen] = useState(false);
  const startSplitRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(startSplitRef, startMenuOpen, () => setStartMenuOpen(false));
  const chooseStartMode = (mode: StartMode) => {
    onStartModeChange(mode);
    setStartMenuOpen(false);
  };

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
          {markedCount > 0 && (
            <>
              {' '}
              · <span className="staged-panel-marked-count">
                {markedCount} marked for removal
              </span>
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
            <div className="staged-panel-start-split" ref={startSplitRef}>
              <button
                type="button"
                className="btn primary staged-panel-start-main"
                disabled={summary.uniqueCount < 2}
                onClick={onStartSort}
                title={
                  startMode === 'insertion'
                    ? 'Binary-insert each item one at a time into a growing ranked list'
                    : 'Classic pairwise merge sort — fewest comparisons overall'
                }
              >
                {startMode === 'insertion' ? 'Insertion sort' : 'Start sort'} (
                {summary.uniqueCount})
              </button>
              <button
                type="button"
                className="btn primary staged-panel-start-caret"
                disabled={summary.uniqueCount < 2}
                aria-haspopup="menu"
                aria-expanded={startMenuOpen}
                aria-label="Choose sort method"
                title="Choose sort method"
                onClick={() => setStartMenuOpen((v) => !v)}
              >
                ▾
              </button>
              {startMenuOpen && (
                <div className="staged-panel-start-menu" role="menu">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={startMode === 'merge'}
                    className="staged-panel-start-menu-item"
                    onClick={() => chooseStartMode('merge')}
                  >
                    <span className="staged-panel-start-menu-check" aria-hidden>
                      {startMode === 'merge' ? '✓' : ''}
                    </span>
                    <span className="staged-panel-start-menu-text">
                      <strong>Merge sort</strong>
                      <span className="staged-panel-start-menu-hint">
                        Pairwise tournament — fewest comparisons overall
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={startMode === 'insertion'}
                    className="staged-panel-start-menu-item"
                    onClick={() => chooseStartMode('insertion')}
                  >
                    <span className="staged-panel-start-menu-check" aria-hidden>
                      {startMode === 'insertion' ? '✓' : ''}
                    </span>
                    <span className="staged-panel-start-menu-text">
                      <strong>Insertion sort</strong>
                      <span className="staged-panel-start-menu-hint">
                        Binary-insert items one at a time; pre-ranked lists
                        seed the order
                      </span>
                    </span>
                  </button>
                </div>
              )}
            </div>
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
          const groupMarked = g.markedForRemoval === true;
          const itemMarks = g.markedItemIds;
          // Duplicates affecting THIS group: count the rows that
          // will be silently dropped by `buildSortInputFromStaged`.
          // A row at position `idx+1` is a loser whenever the
          // FIRST occurrence of its id is anywhere else — either a
          // different group or an earlier row in this same group
          // (intra-group dupes count too). The per-group "N dup"
          // badge shows this so the user knows at a glance which
          // sources are losing entries to dedup. Marked groups
          // contribute zero because `findDuplicateOccurrences`
          // already excluded them; same for marked items inside an
          // unmarked group.
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
              className={
                'staged-panel-group' +
                (isPending ? ' pending' : '') +
                (isOpen ? ' expanded' : '') +
                (groupMarked ? ' marked-for-removal' : '')
              }
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

                When the group is already marked for removal the
                × flips to ↺ (undo) so a second click restores it.
                Start Sort drops every marked group for real — the
                soft-remove only lives until then.
              */}
              {!isPending && (
                <button
                  type="button"
                  className={
                    'x-button staged-panel-group-remove' +
                    (groupMarked ? ' staged-panel-group-undo' : '')
                  }
                  onClick={() => onToggleRemoveGroup(g.id)}
                  aria-label={
                    groupMarked
                      ? `Undo remove ${g.source} from staged items`
                      : `Mark ${g.source} for removal from staged items`
                  }
                  title={
                    groupMarked
                      ? 'Undo — bring this source back into the sort'
                      : 'Mark this whole source for removal (undo with ↺ before Start Sort)'
                  }
                >
                  {groupMarked ? '↺' : '×'}
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
                    const itemMarked = itemMarks?.has(it.id) === true;
                    return (
                      <li
                        className={
                          'staged-panel-item' +
                          (isDuplicate && !isWinner ? ' duplicate-loser' : '') +
                          (isDuplicate && isWinner ? ' duplicate-winner' : '') +
                          // Cascade the group-level mark visually so
                          // every row reads as "going away" even
                          // though the actual mark lives at the
                          // group level. The data layer keeps these
                          // separate (`itemMarks` is untouched) so
                          // undoing the group restores any prior
                          // per-item marks intact.
                          (itemMarked || groupMarked ? ' marked-for-removal' : '')
                        }
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
                        {/* Edit (pencil) — opens EditItemModal in the
                            parent. Hidden when the group is marked
                            for removal: there's no point editing a
                            row that's about to be dropped, and the
                            pencil sitting next to a strikethrough
                            row reads as "still active" which is
                            misleading. The item-level mark alone
                            does NOT hide the pencil — the user might
                            want to edit before deciding to keep. */}
                        {!isPending && onEditItem && !groupMarked && (
                          <button
                            type="button"
                            className="x-button staged-panel-item-edit"
                            onClick={() => onEditItem(g.id, it.id)}
                            aria-label={`Edit ${it.label}`}
                            title="Edit label / URL / image for this entry"
                          >
                            ✎
                          </button>
                        )}
                        {/* × ↔ ↺ on the per-item handle. The handle
                            is hidden whenever the group itself is
                            marked for removal — the group-level ↺
                            is what restores everything, and surfacing
                            the per-item handles inside a struck-
                            through group encourages the user to fight
                            two pieces of state at once. */}
                        {!isPending && onToggleRemoveItem && !groupMarked && (
                          <button
                            type="button"
                            className={
                              'x-button staged-panel-item-remove' +
                              (itemMarked ? ' staged-panel-item-undo' : '')
                            }
                            onClick={() => onToggleRemoveItem(g.id, it.id)}
                            aria-label={
                              itemMarked
                                ? `Undo remove ${it.label}`
                                : `Mark ${it.label} for removal`
                            }
                            title={
                              itemMarked
                                ? 'Undo — bring this entry back into the sort'
                                : 'Mark this entry for removal (undo with ↺ before Start Sort)'
                            }
                          >
                            {itemMarked ? '↺' : '×'}
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
