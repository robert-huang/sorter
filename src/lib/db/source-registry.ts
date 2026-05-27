export type SourceMigration = { version: number; sql: string };

export type SourceMergeTable = {
  name: string;
  pk: string[];
  timestampCol: 'fetched_at' | 'updated_at';
};

export type SourceMergeSpec = {
  metadataTables: SourceMergeTable[];
  userDataTables: SourceMergeTable[];
};

export type SourceDescriptor = {
  id: string;
  migrations: SourceMigration[];
  merge: SourceMergeSpec;
};

const registry = new Map<string, SourceDescriptor>();

export function registerSource(d: SourceDescriptor): void {
  if (registry.has(d.id)) {
    throw new Error(`source '${d.id}' already registered`);
  }
  registry.set(d.id, d);
}

export function getSource(id: string): SourceDescriptor {
  const s = registry.get(id);
  if (!s) {
    throw new Error(`source '${id}' not registered`);
  }
  return s;
}

export function maxMigrationVersion(source: SourceDescriptor): number {
  if (source.migrations.length === 0) {
    return 0;
  }
  return Math.max(...source.migrations.map((m) => m.version));
}

export function listSources(): SourceDescriptor[] {
  return [...registry.values()];
}

// ---------------------------------------------------------------------
// Per-source filter modules (Phase D / cross-source filter framework).
//
// Kept separate from `SourceDescriptor` so the worker bundle never
// imports React. Filter modules live in the UI layer and hold:
//
//   - getChips(externalIds): React node array of chip controls keyed
//     to the source's actual data (e.g. AniList genres / formats /
//     studios pulled from anilist.sqlite). FilterBar renders these
//     inline with the chips from other sources.
//   - filter(externalIds, chipState) -> Promise<Set<number>>: given
//     the user's chip selection, returns the subset of the source's
//     externalIds that should remain visible. The shell unions this
//     subset back into the visibleIds set it emits upward.
//
// Filter state is owned by the chip components themselves (React
// state in the UI layer) and round-tripped through the chip-state
// blob the module defines — opaque to the shell. Session-scoped:
// reload resets to "all chips off" by default.
// ---------------------------------------------------------------------

export type FilterChipState = Record<string, unknown>;

export interface SourceFilterModule {
  /** Stable initial chip-state for the source. Used as the starting
   *  value when FilterBar first mounts for a slot with items of
   *  this source. Must be JSON-serialisable so future "persist filter
   *  state" work can drop in without touching the modules. */
  initialChipState(): FilterChipState;
  /** Render the chip UI for this source. Receives the current
   *  chip-state slice and a setter that merges patches back. The
   *  externalIds prop is the universe the chips should hint over
   *  (e.g. AniList chips show only genres that are actually present
   *  in the slot's media). */
  renderChips(props: {
    externalIds: ReadonlySet<string | number>;
    chipState: FilterChipState;
    onChipStateChange: (patch: FilterChipState) => void;
  }): unknown;
  /** Compute the subset of externalIds that pass the current chip
   *  state. The shell unions allowed subsets across sources back
   *  into the visibleIds set. Async because the AniList implementation
   *  hits the worker via the sqlite RPC layer. */
  computeAllowed(
    externalIds: ReadonlySet<string | number>,
    chipState: FilterChipState,
  ): Promise<Set<string | number>>;
  /** Optional fast-path check: returns true iff applying `chipState`
   *  would let every externalId through (i.e. the chip group is a
   *  no-op). FilterBar uses this to skip the async `computeAllowed`
   *  round-trip when no chip is "active".
   *
   *  The default fallback (if a module doesn't implement this) is
   *  `shallowEqual(state, initialChipState())` — which is correct
   *  when the initial state itself is the "off" state. Modules that
   *  ship a non-trivial default (e.g. AniList's list_status chip
   *  pre-selecting 3 of 6 statuses) MUST implement this so the
   *  pre-selected default doesn't get treated as "no filter active"
   *  and silently bypass the actual filtering work. */
  isPassthrough?(chipState: FilterChipState): boolean;
}

const filterModules = new Map<string, SourceFilterModule>();

export function registerSourceFilters(
  sourceId: string,
  module: SourceFilterModule,
): void {
  filterModules.set(sourceId, module);
}

export function getSourceFilters(sourceId: string): SourceFilterModule | null {
  return filterModules.get(sourceId) ?? null;
}

export function listSourceFilters(): Array<{
  sourceId: string;
  module: SourceFilterModule;
}> {
  return Array.from(filterModules.entries(), ([sourceId, module]) => ({
    sourceId,
    module,
  }));
}

/** Test-only reset. */
export function _clearSourceFiltersForTesting(): void {
  filterModules.clear();
}
