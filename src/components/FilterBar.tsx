import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  type FilterChipState,
  getSourceFilters,
  type SourceFilterModule,
} from '../lib/db/source-registry';
import { getItemSourceKind, type Item, type ItemId, type ItemSource } from '../lib/types';

/**
 * Cross-source filter bar shell for the LIST tab.
 *
 * Owns:
 *   1. Partitioning the slot's items by `source.kind`.
 *   2. Looking up the registered FilterModule for each kind
 *      (`registerSourceFilters` in source-registry).
 *   3. Holding chip-state per source (component-local, session-scoped).
 *   4. Calling each module's `computeAllowed` on chip-state changes and
 *      unioning the allowed externalIds back into a visible-ItemId set
 *      emitted to the parent.
 *
 * The shell stays source-agnostic: chip UIs come from the modules and
 * are rendered inline in the order their sources appear in `items[]`.
 * Items whose `source.kind` has no registered module (or whose module
 * returns no chips) are unconditionally visible — manual items in
 * particular have no filter module, so they always pass through.
 *
 * Filter state is session-scoped: it lives in `useState` here, so a
 * page reload resets every chip. Per the Phase D plan trade-offs,
 * persisting filter state would require a slot-blob schema bump and
 * isn't worth it for v1.
 *
 * The empty-bar case (no items, or only manual items) renders nothing
 * so the LIST tab layout doesn't grow an empty chrome row.
 */

interface FilterBarProps {
  items: Item[];
  /**
   * Emitted whenever the visible set changes. Null means "no filters
   * active — all items visible". The LIST tab can use null as a
   * fast-path render hint to avoid Set lookups.
   */
  onVisibleChange: (visible: ReadonlySet<ItemId> | null) => void;
}

/**
 * Partition items by source.kind, dropping kinds we don't have a
 * filter module for. Returns a stable Map keyed by source.kind so
 * downstream rendering can iterate it in source-discovery order.
 *
 * The externalIds set holds whatever externalId the source declares
 * (number for anilist, string for spotify, etc.) — modules narrow it
 * at use-site.
 */
function partitionItems(items: Item[]): Map<
  ItemSource['kind'],
  {
    module: SourceFilterModule;
    items: Item[];
    externalIds: Set<string | number>;
  }
> {
  const buckets = new Map<
    ItemSource['kind'],
    {
      module: SourceFilterModule;
      items: Item[];
      externalIds: Set<string | number>;
    }
  >();
  for (const item of items) {
    const kind = getItemSourceKind(item);
    if (kind === 'manual') continue;
    const module = getSourceFilters(kind);
    if (!module) continue;
    let bucket = buckets.get(kind);
    if (!bucket) {
      bucket = { module, items: [], externalIds: new Set() };
      buckets.set(kind, bucket);
    }
    bucket.items.push(item);
    if (item.source && item.source.kind === kind && 'externalId' in item.source) {
      bucket.externalIds.add(item.source.externalId);
    }
  }
  return buckets;
}

/** True when every key/value in `b` equals the same key/value in `a`. */
function shallowEqual(a: FilterChipState, b: FilterChipState): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

export function FilterBar({ items, onVisibleChange }: FilterBarProps) {
  // Partition is pure derivation from items; memo so rapid re-renders
  // (e.g. on every compare pick) don't re-bucket the same array.
  const buckets = useMemo(() => partitionItems(items), [items]);
  const sourceKinds = useMemo(() => Array.from(buckets.keys()), [buckets]);

  // Per-source chip state. Keyed by source.kind so a kind unmounting
  // (last item of that kind removed) sheds its slice cleanly.
  // Initial state pulled from each module's `initialChipState` so
  // the chips show their "all off" default on first mount.
  const [chipStates, setChipStates] = useState<
    Record<string, FilterChipState>
  >(() => {
    const initial: Record<string, FilterChipState> = {};
    for (const [kind, bucket] of buckets) {
      initial[kind] = bucket.module.initialChipState();
    }
    return initial;
  });

  // Reconcile chipStates when the set of source kinds changes — e.g.
  // a slot just gained its first AniList item via "+ Add items".
  // Keeps existing kinds' state untouched (no chip reset for stable
  // sources), seeds new kinds via initialChipState, drops stale ones.
  useEffect(() => {
    setChipStates((prev) => {
      let next: Record<string, FilterChipState> | null = null;
      for (const kind of sourceKinds) {
        if (!(kind in prev)) {
          if (!next) next = { ...prev };
          next[kind] = buckets.get(kind)!.module.initialChipState();
        }
      }
      for (const kind of Object.keys(prev)) {
        if (!sourceKinds.includes(kind as ItemSource['kind'])) {
          if (!next) next = { ...prev };
          delete next[kind];
        }
      }
      return next ?? prev;
    });
  }, [sourceKinds, buckets]);

  // Compute visible ItemId set whenever items or chip-state change.
  // Async because modules query their per-source SQLite DB; we guard
  // against stale resolutions clobbering newer ones via a request
  // counter (classic "drop response if not the latest request" pattern).
  const requestSeqRef = useRef(0);
  useEffect(() => {
    const seq = ++requestSeqRef.current;
    // Fast path: no active chip state across any source -> emit null
    // ("all visible") and skip the async dance.
    let anyActive = false;
    for (const [kind, bucket] of buckets) {
      const state = chipStates[kind];
      if (!state) continue;
      const initial = bucket.module.initialChipState();
      if (!shallowEqual(state, initial)) {
        anyActive = true;
        break;
      }
    }
    if (!anyActive) {
      onVisibleChange(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      const visible = new Set<ItemId>();
      // Manual items always pass.
      for (const item of items) {
        if (getItemSourceKind(item) === 'manual') visible.add(item.id);
      }
      for (const [kind, bucket] of buckets) {
        const state = chipStates[kind];
        if (!state) {
          for (const item of bucket.items) visible.add(item.id);
          continue;
        }
        const initial = bucket.module.initialChipState();
        if (shallowEqual(state, initial)) {
          for (const item of bucket.items) visible.add(item.id);
          continue;
        }
        const allowed = await bucket.module.computeAllowed(
          bucket.externalIds,
          state,
        );
        for (const item of bucket.items) {
          if (
            item.source &&
            'externalId' in item.source &&
            allowed.has(item.source.externalId)
          ) {
            visible.add(item.id);
          }
        }
      }
      if (cancelled || seq !== requestSeqRef.current) return;
      onVisibleChange(visible);
    })();
    return () => {
      cancelled = true;
    };
  }, [items, buckets, chipStates, onVisibleChange]);

  if (buckets.size === 0) return null;

  return (
    <div className="filter-bar" role="toolbar" aria-label="Filter items">
      {Array.from(buckets.entries()).map(([kind, bucket]) => {
        const state = chipStates[kind] ?? bucket.module.initialChipState();
        const chips = bucket.module.renderChips({
          externalIds: bucket.externalIds,
          chipState: state,
          onChipStateChange: (patch) =>
            setChipStates((prev) => ({
              ...prev,
              [kind]: { ...(prev[kind] ?? {}), ...patch },
            })),
        });
        return <Fragment key={kind}>{chips as ReactNode}</Fragment>;
      })}
    </div>
  );
}
