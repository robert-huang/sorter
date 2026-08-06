import { dedupRows, type RawRow } from '../../lib/csv';
import {
  isCustomAnilistItemLabel,
  relabelAnilistItem,
  relabelAnilistItemPreservingFormat,
} from '../../lib/importers/anilist/anilistItemLabel';
import {
  anilistStudioExternalId,
  hydrateAnilistItemEntries,
} from '../../lib/importers/anilist/anilistItemHydration';
import type { Item } from '../../lib/types';

export type BumpChartItem = {
  item: Item;
  /** Present for saved results and source-matched rows; absent for plain pasted rows. */
  logicalId?: string;
  /** Saved slots may predate persisted AniList label metadata. */
  inferLegacyCustomLabel?: boolean;
};

export type BumpConnection = {
  key: string;
  kind: 'matched' | 'removed' | 'added';
  matchBasis?: 'logical-id' | 'label' | 'alternate-title';
  leftIndex: number | null;
  rightIndex: number | null;
  colorIndex: number;
};

export type BuildBumpConnectionsOptions = {
  bestMatchByTitle?: boolean;
};

/** Positive means the item moved up; negative means it moved down. */
export function bumpConnectionMovement(
  connection: BumpConnection,
): number | null {
  if (
    connection.kind !== 'matched' ||
    connection.leftIndex == null ||
    connection.rightIndex == null
  ) {
    return null;
  }
  return connection.leftIndex - connection.rightIndex;
}

export const BUMP_CHART_COLORS = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#9333ea',
  '#ea580c',
  '#0891b2',
  '#db2777',
  '#65a30d',
  '#4f46e5',
  '#ca8a04',
  '#0d9488',
  '#e11d48',
  '#7c3aed',
  '#0284c7',
  '#c2410c',
  '#059669',
  '#be185d',
  '#4338ca',
  '#a16207',
  '#475569',
] as const;

function isAnilistSourceMatched(item: Item): boolean {
  return (
    (item.source != null && item.source.kind !== 'manual') ||
    anilistStudioExternalId(item) != null
  );
}

export function hasCustomAnilistLabels(items: readonly BumpChartItem[]): boolean {
  return items.some(
    ({ item }) =>
      isAnilistSourceMatched(item) &&
      item.anilistLabelSource != null &&
      isCustomAnilistItemLabel(item),
  );
}

export function displayBumpChartItems(
  items: readonly BumpChartItem[],
  preserveCustomLabels: boolean,
): BumpChartItem[] {
  return items.map((entry) => {
    if (preserveCustomLabels) {
      return {
        ...entry,
        item: relabelAnilistItemPreservingFormat(entry.item),
      };
    }
    const source = entry.item.anilistLabelSource;
    const includeFormat =
      entry.item.anilistLabelIncludesFormat ??
      (source?.kind === 'media' &&
        source.format != null &&
        entry.item.label.endsWith(` (${source.format})`));
    return {
      ...entry,
      item: relabelAnilistItem(entry.item, includeFormat, true),
    };
  });
}

export function bumpItemsFromRows(rows: readonly RawRow[]): BumpChartItem[] {
  return dedupRows([...rows]).items.map((item) => ({
    item,
    logicalId: isAnilistSourceMatched(item) ? item.id : undefined,
  }));
}

export function bumpItemsFromSortResults(items: readonly Item[]): BumpChartItem[] {
  const seen = new Set<string>();
  const out: BumpChartItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    out.push({
      item,
      logicalId: item.id,
      inferLegacyCustomLabel:
        isAnilistSourceMatched(item) && !item.anilistLabelSource,
    });
  }
  return out;
}

export function bumpItemsFromImportedItems(
  items: readonly Item[],
): BumpChartItem[] {
  return items.map((item) => ({
    item,
    logicalId: isAnilistSourceMatched(item) ? item.id : undefined,
  }));
}

export function dedupeBumpChartItems(
  groups: readonly (readonly BumpChartItem[])[],
): BumpChartItem[] {
  const seen = new Set<string>();
  const out: BumpChartItem[] = [];
  for (const group of groups) {
    for (const entry of group) {
      if (seen.has(entry.item.id)) {
        continue;
      }
      seen.add(entry.item.id);
      out.push(entry);
    }
  }
  return out;
}

/** Attach cached AniList title/name metadata before label selection. */
export async function hydrateBumpChartItems(
  entries: readonly BumpChartItem[],
): Promise<BumpChartItem[]> {
  return hydrateAnilistItemEntries(entries);
}

function appendIndex(
  buckets: Map<string, number[]>,
  key: string,
  index: number,
): void {
  const bucket = buckets.get(key);
  if (bucket) {
    bucket.push(index);
  } else {
    buckets.set(key, [index]);
  }
}

function takeFirstUnused(
  bucket: number[] | undefined,
  used: ReadonlySet<number>,
): number | null {
  if (!bucket) {
    return null;
  }
  while (bucket.length > 0) {
    const index = bucket.shift()!;
    if (!used.has(index)) {
      return index;
    }
  }
  return null;
}

function hasSourceIdentity(entry: BumpChartItem): boolean {
  return (
    isAnilistSourceMatched(entry.item) ||
    /^anilist(?::|-character:|-staff:|-studios:)\d+$/.test(
      entry.logicalId ?? '',
    )
  );
}

function canInferSameItem(
  leftEntry: BumpChartItem,
  rightEntry: BumpChartItem,
): boolean {
  // Conflicting source identities are stronger evidence than a shared title.
  return !(hasSourceIdentity(leftEntry) && hasSourceIdentity(rightEntry));
}

function alternateTitleMatches(
  leftEntry: BumpChartItem,
  rightEntry: BumpChartItem,
): boolean {
  return (
    leftEntry.item.searchTokens?.includes(rightEntry.item.label) === true ||
    rightEntry.item.searchTokens?.includes(leftEntry.item.label) === true
  );
}

function assignUniqueInferredMatches(
  left: readonly BumpChartItem[],
  right: readonly BumpChartItem[],
  matchedRightByLeft: Map<number, number>,
  matchBasisByLeft: Map<number, BumpConnection['matchBasis']>,
  usedRight: Set<number>,
  matchBasis: 'label' | 'alternate-title',
  matches: (leftEntry: BumpChartItem, rightEntry: BumpChartItem) => boolean,
): void {
  const candidatesByLeft = new Map<number, number[]>();
  const candidateLeftCountByRight = new Map<number, number>();

  left.forEach((leftEntry, leftIndex) => {
    if (matchedRightByLeft.has(leftIndex)) {
      return;
    }
    const candidates: number[] = [];
    right.forEach((rightEntry, rightIndex) => {
      if (!usedRight.has(rightIndex) && matches(leftEntry, rightEntry)) {
        candidates.push(rightIndex);
        candidateLeftCountByRight.set(
          rightIndex,
          (candidateLeftCountByRight.get(rightIndex) ?? 0) + 1,
        );
      }
    });
    candidatesByLeft.set(leftIndex, candidates);
  });

  candidatesByLeft.forEach((candidates, leftIndex) => {
    if (candidates.length !== 1) {
      return;
    }
    const rightIndex = candidates[0]!;
    if (
      candidateLeftCountByRight.get(rightIndex) !== 1 ||
      usedRight.has(rightIndex)
    ) {
      return;
    }
    matchedRightByLeft.set(leftIndex, rightIndex);
    matchBasisByLeft.set(leftIndex, matchBasis);
    usedRight.add(rightIndex);
  });
}

/**
 * Match stable logical ids first, then optionally infer unique title matches.
 * Two conflicting source identities are never collapsed solely by title.
 */
export function buildBumpConnections(
  left: readonly BumpChartItem[],
  right: readonly BumpChartItem[],
  options: BuildBumpConnectionsOptions = {},
): BumpConnection[] {
  const bestMatchByTitle = options.bestMatchByTitle ?? true;
  const usedRight = new Set<number>();
  const matchedRightByLeft = new Map<number, number>();
  const matchBasisByLeft = new Map<number, BumpConnection['matchBasis']>();
  const rightByLogicalId = new Map<string, number[]>();
  right.forEach((entry, index) => {
    if (entry.logicalId) {
      appendIndex(rightByLogicalId, entry.logicalId, index);
    }
  });

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const logicalId = left[leftIndex]!.logicalId;
    if (!logicalId) {
      continue;
    }
    const rightIndex = takeFirstUnused(
      rightByLogicalId.get(logicalId),
      usedRight,
    );
    if (rightIndex != null) {
      matchedRightByLeft.set(leftIndex, rightIndex);
      matchBasisByLeft.set(leftIndex, 'logical-id');
      usedRight.add(rightIndex);
    }
  }

  if (bestMatchByTitle) {
    // Prefer bridging a source-backed item to a manual/auto-id item.
    assignUniqueInferredMatches(
      left,
      right,
      matchedRightByLeft,
      matchBasisByLeft,
      usedRight,
      'label',
      (leftEntry, rightEntry) =>
        hasSourceIdentity(leftEntry) !== hasSourceIdentity(rightEntry) &&
        leftEntry.item.label === rightEntry.item.label,
    );

    // Remaining non-source items may carry different auto-assigned ids.
    assignUniqueInferredMatches(
      left,
      right,
      matchedRightByLeft,
      matchBasisByLeft,
      usedRight,
      'label',
      (leftEntry, rightEntry) =>
        canInferSameItem(leftEntry, rightEntry) &&
        leftEntry.item.label === rightEntry.item.label,
    );

    assignUniqueInferredMatches(
      left,
      right,
      matchedRightByLeft,
      matchBasisByLeft,
      usedRight,
      'alternate-title',
      (leftEntry, rightEntry) =>
        canInferSameItem(leftEntry, rightEntry) &&
        alternateTitleMatches(leftEntry, rightEntry),
    );
  }

  const connections: BumpConnection[] = left.map((_, leftIndex) => {
    const rightIndex = matchedRightByLeft.get(leftIndex);
    return {
      key:
        rightIndex == null
          ? `removed:${leftIndex}`
          : `matched:${leftIndex}:${rightIndex}`,
      kind: rightIndex == null ? 'removed' : 'matched',
      matchBasis:
        rightIndex == null ? undefined : matchBasisByLeft.get(leftIndex),
      leftIndex,
      rightIndex: rightIndex ?? null,
      colorIndex: 0,
    };
  });

  right.forEach((_, rightIndex) => {
    if (!usedRight.has(rightIndex)) {
      connections.push({
        key: `added:${rightIndex}`,
        kind: 'added',
        leftIndex: null,
        rightIndex,
        colorIndex: 0,
      });
    }
  });
  return assignBumpConnectionColors(connections);
}

/**
 * Adjacent ranks on either side cannot share a color. This includes short
 * added/removed paths, so inserting a new row recolors nearby paths safely.
 */
export function assignBumpConnectionColors(
  connections: readonly BumpConnection[],
): BumpConnection[] {
  const ordered = [...connections].sort((a, b) => {
    const aRank = Math.min(
      a.leftIndex ?? Number.POSITIVE_INFINITY,
      a.rightIndex ?? Number.POSITIVE_INFINITY,
    );
    const bRank = Math.min(
      b.leftIndex ?? Number.POSITIVE_INFINITY,
      b.rightIndex ?? Number.POSITIVE_INFINITY,
    );
    return aRank - bRank;
  });
  const assigned = new Map<string, number>();
  for (const connection of ordered) {
    const unavailable = new Set<number>();
    for (const other of connections) {
      const otherColor = assigned.get(other.key);
      if (otherColor == null) {
        continue;
      }
      const adjacentLeft =
        connection.leftIndex != null &&
        other.leftIndex != null &&
        Math.abs(connection.leftIndex - other.leftIndex) === 1;
      const adjacentRight =
        connection.rightIndex != null &&
        other.rightIndex != null &&
        Math.abs(connection.rightIndex - other.rightIndex) === 1;
      if (adjacentLeft || adjacentRight) {
        unavailable.add(otherColor);
      }
    }
    const preferredIndex =
      (connection.leftIndex ?? connection.rightIndex ?? 0) %
      BUMP_CHART_COLORS.length;
    let colorIndex = preferredIndex;
    for (let offset = 0; offset < BUMP_CHART_COLORS.length; offset += 1) {
      const candidate =
        (preferredIndex + offset) % BUMP_CHART_COLORS.length;
      if (!unavailable.has(candidate)) {
        colorIndex = candidate;
        break;
      }
    }
    assigned.set(connection.key, colorIndex);
  }
  return connections.map((connection) => ({
    ...connection,
    colorIndex: assigned.get(connection.key) ?? 0,
  }));
}

export function bumpRowCenterOffsets(
  rootTop: number,
  rows: readonly { top: number; height: number }[],
): number[] {
  return rows.map((row) => row.top - rootTop + row.height / 2);
}
