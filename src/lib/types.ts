export type ItemId = string;

export interface Item {
  id: ItemId;
  label: string;
  url?: string;
  imageUrl?: string;
}

export interface MergeFrame {
  left: ItemId[];
  right: ItemId[];
  merged: ItemId[];
}

/**
 * The mutable progress slice. This is what we snapshot into the undo ring and
 * write into the save file. Items dict lives at SortState level and never
 * changes shape after import (we only ever ADD items, never mutate existing).
 */
export interface SortProgress {
  queue: ItemId[][];
  current: MergeFrame | null;
  comparisons: number;
  done: boolean;
  hidden: ItemId[];
  /**
   * Running max of `comparisonsRemaining` so the progress bar never goes
   * backwards when mid-sort edits (addItem, appendPreRankedSublist,
   * breakApartSublist) increase the work-to-do. Tracks the all-time-high
   * worst-case comparisons this sort has ever needed from any point.
   */
  totalComparisonsEverNeeded: number;
}

export interface SortState extends SortProgress {
  items: Record<ItemId, Item>;
}

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

export interface SaveFile {
  version: 1;
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
