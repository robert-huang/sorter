export type ItemId = string;

export interface Item {
  id: ItemId;
  label: string;
  url?: string;
  imageUrl?: string;
}

/** Merge-engine in-flight merge frame: two sublists being interleaved into `merged`. */
export interface MergeFrame {
  left: ItemId[];
  right: ItemId[];
  merged: ItemId[];
}

/**
 * Binary-insertion primitive frame. Shared between the insertion engine
 * (in `insertionSort.ts`) and the deferred manual-insert mini-sessions on the
 * merge engine (in `queueMergeSort.ts`). lo/hi are inclusive bounds into
 * the target `sorted[]` array; probe = `(lo+hi) >> 1`.
 */
export interface InsertFrame {
  insertingId: ItemId;
  lo: number;
  hi: number;
  probe: number;
}

/**
 * Merge-engine manual-insert frame: wraps an InsertFrame with the queue
 * sublist it targets, so a user-triggered Insert mini-session can splice
 * the inserting item into the right sublist when it resolves.
 *
 * "Manual" distinguishes this from the auto-insert frame (also binary
 * insertion, but triggered automatically by `advance()` when the next
 * queue pair is skewed enough for binary insertion to beat the full
 * merge). Both share the same `binaryInsertion` primitive — the
 * difference is just who triggers them and whether they're cancelable.
 */
export interface ManualInsertFrame {
  insertingId: ItemId;
  targetQueueIndex: number;
  frame: InsertFrame;
}

/**
 * Merge-engine auto-insert frame: a batch of items being binary-inserted
 * into the `target` sublist (which was popped from the queue). When all
 * items have landed, `target` is pushed back to the queue and the merge
 * engine advances to the next pair.
 *
 * `pendingInserts` drains FIFO from the smaller side's visible items in
 * their input order, which is also the rank order — so we can narrow the
 * next insert's lower bound to (lastInsertedPosition + 1) for rank-aware
 * bound tightening.
 */
export interface AutoInsertFrame {
  /** The larger side popped from the queue; grows as items land. */
  target: ItemId[];
  /** FIFO of items still to insert, in original (rank) order. */
  pendingInserts: ItemId[];
  /** Currently-in-flight binary-insertion frame, or null between inserts. */
  frame: InsertFrame | null;
  /**
   * Position of the most-recently-landed item in `target`, used to
   * narrow the next insert's `lo` bound (rank-aware: the next item
   * ranks AFTER the previous one in user-expressed order). Null before
   * the first insert lands.
   */
  lastInsertedPosition: number | null;
}

/** Fields shared between MergeProgress and InsertionProgress. */
interface SortProgressBase {
  comparisons: number;
  done: boolean;
  hidden: ItemId[];
  /**
   * Running max of `comparisonsRemaining` so the progress bar never goes
   * backwards when mid-sort edits (addItem, appendPreRankedSublist,
   * breakApartSublist, addItems on insertion mode, etc.) increase the
   * work-to-do. Tracks the all-time-high worst-case comparisons this
   * sort has ever needed from any point.
   */
  totalComparisonsEverNeeded: number;
}

/**
 * Merge-engine progress slice. The original SortProgress shape, plus
 * fields for the exile + deferred-Insert + auto-insert mechanics.
 */
export interface MergeProgress extends SortProgressBase {
  engine: 'merge';
  queue: ItemId[][];
  current: MergeFrame | null;
  /**
   * Items that were hidden during an in-flight merge and got swept up
   * at merge-close time. They live here until the user explicitly
   * inserts them (or Forgets them) — see queueMergeSort.manualInsert
   * and queueMergeSort.forgetItem.
   */
  toBeInserted: ItemId[];
  /**
   * FIFO of items the user clicked Insert on while a merge was still
   * running. Drain between merge boundaries.
   */
  pendingManualInserts: ItemId[];
  /**
   * The currently-running manual-insert mini-session (user-triggered),
   * or null. Invariant: (current && currentManualInsert) is never
   * true. Invariant: (currentAutoInsert && currentManualInsert) is
   * never true.
   */
  currentManualInsert: ManualInsertFrame | null;
  /**
   * The currently-running auto-insert frame (engine-triggered when
   * `advance()` decides a popped pair is skewed enough for binary
   * insertion to beat the full merge), or null. Invariant:
   * (current && currentAutoInsert) is never true.
   */
  currentAutoInsert: AutoInsertFrame | null;
}

/**
 * Insertion-engine progress slice. `sorted` is treated as frozen (no
 * re-ranking within a session); `pending` drains FIFO via binary insert.
 */
export interface InsertionProgress extends SortProgressBase {
  engine: 'insertion';
  /** Locked-in order from the seed rank, best→worst. */
  sorted: ItemId[];
  /** New items still to insert, FIFO. */
  pending: ItemId[];
  /** The currently-running binary-insertion frame, or null between items. */
  current: InsertFrame | null;
}

export type SortProgress = MergeProgress | InsertionProgress;

export type MergeState = MergeProgress & { items: Record<ItemId, Item> };
export type InsertionState = InsertionProgress & { items: Record<ItemId, Item> };
export type SortState = MergeState | InsertionState;

export type DedupReason =
  | 'duplicate-in-source'
  | 'duplicate-across-sources';

export interface DedupWarning {
  canonicalKey: ItemId;
  displayLabel: string;
  occurrences: Array<{
    sourceName: string;
    rowNumber: number;
    hadUrl: boolean;
    hadImage: boolean;
  }>;
  winningSource: string;
  winningRow: number;
  mergedFromSources: {
    url?: string;
    image?: string;
  };
  reason: DedupReason;
}

/**
 * Soft warning emitted by the CSV parser when a row has more than the
 * expected 3 non-empty cells. Almost always indicates an unquoted
 * comma inside one of the fields — e.g. a label like `"Foo, Bar, Baz"`
 * that was written without surrounding quotes parses as 3 cells, so
 * the URL slot ends up holding what should have been part of the
 * label and the image slot ends up holding what should have been the
 * URL. We deliberately do NOT block the import: the parsed columns
 * may still be a usable best-effort. ImportPreview surfaces these
 * warnings inline so the user can spot them and either:
 *  - re-export the source CSV with proper quoting, or
 *  - open the row in EditItemModal and copy the right substrings
 *    out of the original-row panel into the right fields.
 *
 * Carrying the full `rawCells` (not just the count) lets the modal
 * show the original row verbatim — once the session starts and the
 * RawRow is dropped, the user has no way to recover the lost data.
 */
export interface ExtraColumnsWarning {
  sourceName: string;
  /** 1-indexed row number within the source, AFTER any header skip — same
   *  numbering as `RawRow.sourceRow` so the user can correlate. */
  rowNumber: number;
  /** Number of NON-EMPTY cells parsed (always > 3 when this warning fires). */
  cellCount: number;
  /** All cells from the parsed row, including empty ones, in their
   *  original order. Used by EditItemModal to render the "Original row"
   *  panel for manual-fix copy/paste. */
  rawCells: string[];
  /** The cells that landed in the `label`/`url`/`imageUrl` slots,
   *  pre-split for the warning text. (Just `rawCells.slice(0,3)`,
   *  duplicated here for callers that don't want to re-derive.) */
  parsedAs: { label: string; url?: string; imageUrl?: string };
}

/**
 * v1: original single-engine merge schema (no `engine` field on progress).
 * v2: engine-discriminated progress; introduced the original "Place"
 *     vocabulary (`pendingPlacements`, `currentPlacement`).
 * v3: renamed Place→ManualInsert on the wire (`pendingManualInserts`,
 *     `currentManualInsert`) and added `currentAutoInsert`.
 * v4: renamed `unplaced` → `toBeInserted` on merge progress for vocabulary
 *     consistency with the rest of the Insert-flavored API.
 *
 * Loaders accept any version 1–4 but the upgrade path is shape-driven
 * and minimal: missing fields default-fill rather than getting
 * translated from their legacy names. See `upgradeProgress` in
 * storage.ts for the per-version acceptable-loss summary. On the next
 * write the blob is persisted as v4.
 */
export interface SaveFile {
  version: 1 | 2 | 3 | 4;
  createdAt: string;
  items: Record<ItemId, Item>;
  progress: SortProgress;
  undoRing: SortProgress[];
}

/**
 * Lightweight per-slot metadata stored in the slots manifest. The full
 * session payload (items / progress / undo ring) lives under a separate
 * per-slot key so the manifest stays cheap to read on boot.
 */
export interface SlotMeta {
  id: string;          // short opaque id (e.g. 8 base36 chars)
  name: string;
  createdAt: string;   // ISO timestamp
  updatedAt: string;   // ISO timestamp; bumped on every autosave write
  totalItems: number;
  comparisons: number;
  done: boolean;
  /**
   * When true, this slot is excluded from `createSlot`'s eviction loop
   * — it won't be auto-deleted to make room for a new slot. The user
   * can still delete it manually via the trashcan. Defaults to false
   * (unpinned); stored as `undefined` on old slots so the absence is
   * indistinguishable from false. Toggle via the per-row pin button in
   * the LIST tab or the gear menu.
   */
  pinned?: boolean;
  /**
   * Cloud-backup fields (tier 0b). All optional; absence on existing
   * slots is indistinguishable from "not opted in" — no migration code
   * needed, same pattern as `pinned?`.
   *
   * cloudOptIn:      user has chosen to back this slot up to cloud.
   * cloudId:         provider-specific id of the cloud-side blob (Drive
   *                  file id). Slot↔file binding is by id, not by
   *                  filename, so a Drive-side rename doesn't break it.
   * cloudPushedAt:   local ISO timestamp of the most-recent local↔cloud
   *                  sync from this device — bumped on Push (we just
   *                  uploaded our copy) AND on Pull (we just downloaded
   *                  the cloud's copy, so local now matches cloud).
   *                  Compared against `updatedAt` to drive the 3-state
   *                  sync indicator: `updatedAt > cloudPushedAt` ⇒ pending.
   * cloudUpdatedAt:  ISO timestamp the cloud copy reports as its own
   *                  last-modified time (from Drive's `modifiedTime`).
   * cloudEtag:       opaque etag the provider returned with the last
   *                  Push or Pull. Used by the pre-Push stale-cache
   *                  check: if the current cloud etag differs from this
   *                  one, somebody else (or another device) changed the
   *                  cloud copy in between and we warn before clobbering.
   *
   * Populated by `setCloud*` helpers in storage.ts; never touched by
   * autosave's normal write path.
   */
  cloudOptIn?: boolean;
  cloudId?: string;
  cloudPushedAt?: string;
  cloudUpdatedAt?: string;
  cloudEtag?: string;
}

/**
 * Manifest stored at LOCAL_KEY. Holds the ordered list of slots and a
 * pointer to the currently-active slot. `activeId === null` means there is
 * no live session — the user is on the START screen with the slot list
 * showing past sessions to resume.
 */
export interface SlotsManifest {
  version: 1;
  activeId: string | null;
  slots: SlotMeta[];
}

// ---------- helpers ----------

/** Discriminate at runtime; useful where TS can't narrow. */
export function isInsertionState(state: SortState): state is InsertionState {
  return state.engine === 'insertion';
}

export function isMergeState(state: SortState): state is MergeState {
  return state.engine === 'merge';
}
