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
import { foldJapaneseRomanization } from '../../lib/importers/anilist/themeSongs/themeSongMatching';
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
  matchBasis?: 'logical-id' | 'source-id' | 'label' | 'alternate-title';
  leftIndex: number | null;
  rightIndex: number | null;
  colorIndex: number;
};

export type BuildBumpConnectionsOptions = {
  bestMatchByTitle?: boolean;
};

export type BumpTimelineColumn = {
  id: string;
  items: readonly BumpChartItem[];
};

export type BumpTimelineSegment = BumpConnection & {
  pairIndex: number;
  lineageKey: string;
};

export type BumpTimelineGap = {
  fromColumnIndex: number;
  toColumnIndex: number;
  fromItemIndex: number;
  toItemIndex: number;
};

export type BumpTimelineLineage = {
  key: string;
  colorIndex: number;
  itemIndexes: Array<number | null>;
  gaps: BumpTimelineGap[];
};

export type BumpTimeline = {
  lineages: BumpTimelineLineage[];
  segments: BumpTimelineSegment[];
  lineageByOccurrence: Map<string, BumpTimelineLineage>;
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

function sourceIdentity(entry: BumpChartItem): string | null {
  const source = entry.item.source;
  if (source && source.kind !== 'manual') {
    return `${source.kind}:${source.externalId}`;
  }
  const logicalId = entry.logicalId ?? '';
  return /^anilist(?::|-character:|-staff:|-studios:)\d+$/.test(logicalId)
    ? logicalId
    : null;
}

function hasSourceIdentity(entry: BumpChartItem): boolean {
  return sourceIdentity(entry) != null;
}

function hasConflictingSourceIdentities(
  leftEntry: BumpChartItem,
  rightEntry: BumpChartItem,
): boolean {
  const leftIdentity = sourceIdentity(leftEntry);
  const rightIdentity = sourceIdentity(rightEntry);
  return (
    leftIdentity != null &&
    rightIdentity != null &&
    leftIdentity !== rightIdentity
  );
}

function canInferSameItem(
  leftEntry: BumpChartItem,
  rightEntry: BumpChartItem,
): boolean {
  // Conflicting source identities are stronger evidence than a shared title.
  return !hasConflictingSourceIdentities(leftEntry, rightEntry);
}

function inferredTitleKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferredSearchTitleMatches(left: string, right: string): boolean {
  const leftKey = inferredTitleKey(left);
  const rightKey = inferredTitleKey(right);
  if (!leftKey || !rightKey) {
    return false;
  }
  return (
    leftKey === rightKey ||
    foldJapaneseRomanization(leftKey) === foldJapaneseRomanization(rightKey)
  );
}

function inferredLabelsMatch(
  leftEntry: BumpChartItem,
  rightEntry: BumpChartItem,
): boolean {
  const left = inferredTitleKey(leftEntry.item.label);
  return left.length > 0 && left === inferredTitleKey(rightEntry.item.label);
}

function alternateTitleMatches(
  leftEntry: BumpChartItem,
  rightEntry: BumpChartItem,
): boolean {
  const leftLabel = inferredTitleKey(leftEntry.item.label);
  const rightLabel = inferredTitleKey(rightEntry.item.label);
  return (
    (rightLabel.length > 0 &&
      leftEntry.item.searchTokens?.some(
        (title) => inferredSearchTitleMatches(title, rightEntry.item.label),
      )) ||
    (leftLabel.length > 0 &&
      rightEntry.item.searchTokens?.some(
        (title) => inferredSearchTitleMatches(title, leftEntry.item.label),
      )) ||
    false
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
 * Match stable logical and upstream source ids before inferring unique titles.
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
    if (
      rightIndex != null &&
      !hasConflictingSourceIdentities(left[leftIndex]!, right[rightIndex]!)
    ) {
      matchedRightByLeft.set(leftIndex, rightIndex);
      matchBasisByLeft.set(leftIndex, 'logical-id');
      usedRight.add(rightIndex);
    }
  }

  const rightBySourceId = new Map<string, number[]>();
  right.forEach((entry, index) => {
    const identity = sourceIdentity(entry);
    if (identity) {
      appendIndex(rightBySourceId, identity, index);
    }
  });
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    if (matchedRightByLeft.has(leftIndex)) {
      continue;
    }
    const identity = sourceIdentity(left[leftIndex]!);
    if (!identity) {
      continue;
    }
    const rightIndex = takeFirstUnused(
      rightBySourceId.get(identity),
      usedRight,
    );
    if (rightIndex != null) {
      matchedRightByLeft.set(leftIndex, rightIndex);
      matchBasisByLeft.set(leftIndex, 'source-id');
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
        inferredLabelsMatch(leftEntry, rightEntry),
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
        inferredLabelsMatch(leftEntry, rightEntry),
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

function occurrenceKey(columnIndex: number, itemIndex: number): string {
  return `${columnIndex}:${itemIndex}`;
}

function assignTimelineColors(
  itemIndexesByLineage: ReadonlyMap<string, readonly (number | null)[]>,
): Map<string, number> {
  const ordered = [...itemIndexesByLineage.entries()].sort(([, left], [, right]) => {
    const leftRank = left.find((index) => index != null) ?? Number.MAX_SAFE_INTEGER;
    const rightRank =
      right.find((index) => index != null) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });
  const colors = new Map<string, number>();
  for (const [lineageKey, itemIndexes] of ordered) {
    const unavailable = new Set<number>();
    for (const [otherKey, otherIndexes] of itemIndexesByLineage) {
      const otherColor = colors.get(otherKey);
      if (otherColor == null) continue;
      const adjacent = itemIndexes.some((itemIndex, columnIndex) => {
        const otherIndex = otherIndexes[columnIndex];
        return (
          itemIndex != null &&
          otherIndex != null &&
          Math.abs(itemIndex - otherIndex) === 1
        );
      });
      if (adjacent) unavailable.add(otherColor);
    }
    const firstIndex = itemIndexes.find((index) => index != null) ?? 0;
    const preferred = firstIndex % BUMP_CHART_COLORS.length;
    let selected = preferred;
    for (let offset = 0; offset < BUMP_CHART_COLORS.length; offset += 1) {
      const candidate = (preferred + offset) % BUMP_CHART_COLORS.length;
      if (!unavailable.has(candidate)) {
        selected = candidate;
        break;
      }
    }
    colors.set(lineageKey, selected);
  }
  return colors;
}

/**
 * Build stable lineages across every timeline column while retaining pairwise
 * add/remove/movement semantics for each adjacent pair.
 */
export function buildBumpTimeline(
  columns: readonly BumpTimelineColumn[],
  options: BuildBumpConnectionsOptions = {},
): BumpTimeline {
  const parent = new Map<string, string>();
  const columnIndexesByRoot = new Map<string, Set<number>>();
  const sourceIdentitiesByRoot = new Map<string, Set<string>>();
  const find = (key: string): string => {
    const current = parent.get(key) ?? key;
    if (current === key) {
      parent.set(key, key);
      return key;
    }
    const root = find(current);
    parent.set(key, root);
    return root;
  };
  const union = (left: string, right: string): boolean => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return true;
    const leftColumns = columnIndexesByRoot.get(leftRoot) ?? new Set();
    const rightColumns = columnIndexesByRoot.get(rightRoot) ?? new Set();
    if ([...leftColumns].some((columnIndex) => rightColumns.has(columnIndex))) {
      return false;
    }
    const identities = new Set([
      ...(sourceIdentitiesByRoot.get(leftRoot) ?? []),
      ...(sourceIdentitiesByRoot.get(rightRoot) ?? []),
    ]);
    if (identities.size > 1) return false;
    parent.set(rightRoot, leftRoot);
    columnIndexesByRoot.set(
      leftRoot,
      new Set([...leftColumns, ...rightColumns]),
    );
    columnIndexesByRoot.delete(rightRoot);
    sourceIdentitiesByRoot.set(leftRoot, identities);
    sourceIdentitiesByRoot.delete(rightRoot);
    return true;
  };

  const occurrences: Array<{
    key: string;
    columnIndex: number;
    itemIndex: number;
    entry: BumpChartItem;
  }> = [];
  columns.forEach((column, columnIndex) => {
    column.items.forEach((entry, itemIndex) => {
      const key = occurrenceKey(columnIndex, itemIndex);
      parent.set(key, key);
      columnIndexesByRoot.set(key, new Set([columnIndex]));
      const identity = sourceIdentity(entry);
      sourceIdentitiesByRoot.set(
        key,
        identity == null ? new Set() : new Set([identity]),
      );
      occurrences.push({ key, columnIndex, itemIndex, entry });
    });
  });

  const byLogicalId = new Map<string, string[]>();
  for (const occurrence of occurrences) {
    const logicalId = occurrence.entry.logicalId;
    if (!logicalId) continue;
    const matches = byLogicalId.get(logicalId);
    if (matches) matches.push(occurrence.key);
    else byLogicalId.set(logicalId, [occurrence.key]);
  }
  for (const matches of byLogicalId.values()) {
    matches.slice(1).forEach((key) => union(matches[0]!, key));
  }

  const bySourceId = new Map<string, string[]>();
  for (const occurrence of occurrences) {
    const identity = sourceIdentity(occurrence.entry);
    if (!identity) continue;
    const matches = bySourceId.get(identity);
    if (matches) matches.push(occurrence.key);
    else bySourceId.set(identity, [occurrence.key]);
  }
  for (const matches of bySourceId.values()) {
    matches.slice(1).forEach((key) => union(matches[0]!, key));
  }

  const pairConnections = columns.slice(0, -1).map((column, pairIndex) => {
    const connections = buildBumpConnections(
      column.items,
      columns[pairIndex + 1]!.items,
      options,
    );
    return connections.flatMap((connection): BumpConnection[] => {
      if (
        connection.kind === 'matched' &&
        connection.leftIndex != null &&
        connection.rightIndex != null
      ) {
        const merged = union(
          occurrenceKey(pairIndex, connection.leftIndex),
          occurrenceKey(pairIndex + 1, connection.rightIndex),
        );
        if (!merged) {
          return [
            {
              ...connection,
              key: `removed:${connection.leftIndex}`,
              kind: 'removed',
              matchBasis: undefined,
              rightIndex: null,
            },
            {
              ...connection,
              key: `added:${connection.rightIndex}`,
              kind: 'added',
              matchBasis: undefined,
              leftIndex: null,
            },
          ];
        }
      }
      return [connection];
    });
  });

  if (options.bestMatchByTitle !== false) {
    const byLabel = new Map<string, typeof occurrences>();
    for (const occurrence of occurrences) {
      const labelKey = inferredTitleKey(occurrence.entry.item.label);
      if (!labelKey) continue;
      const matches = byLabel.get(labelKey);
      if (matches) matches.push(occurrence);
      else byLabel.set(labelKey, [occurrence]);
    }
    for (const matches of byLabel.values()) {
      const columnIndexes = new Set(matches.map(({ columnIndex }) => columnIndex));
      const sourceIds = new Set(
        matches
          .map(({ entry }) => sourceIdentity(entry))
          .filter((id): id is string => id != null),
      );
      if (columnIndexes.size !== matches.length || sourceIds.size > 1) continue;
      matches.slice(1).forEach(({ key }) => union(matches[0]!.key, key));
    }

    const occurrencesByCurrentRoot = new Map<string, typeof occurrences>();
    for (const occurrence of occurrences) {
      const root = find(occurrence.key);
      const matches = occurrencesByCurrentRoot.get(root);
      if (matches) matches.push(occurrence);
      else occurrencesByCurrentRoot.set(root, [occurrence]);
    }
    const roots = [...occurrencesByCurrentRoot.keys()];
    const candidatesByRoot = new Map<string, Set<string>>();
    const addCandidate = (root: string, candidate: string): void => {
      const candidates = candidatesByRoot.get(root);
      if (candidates) candidates.add(candidate);
      else candidatesByRoot.set(root, new Set([candidate]));
    };
    for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
      const leftRoot = roots[leftIndex]!;
      const leftMatches = occurrencesByCurrentRoot.get(leftRoot)!;
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < roots.length;
        rightIndex += 1
      ) {
        const rightRoot = roots[rightIndex]!;
        const rightMatches = occurrencesByCurrentRoot.get(rightRoot)!;
        const leftColumns = new Set(
          leftMatches.map(({ columnIndex }) => columnIndex),
        );
        if (
          rightMatches.some(({ columnIndex }) => leftColumns.has(columnIndex))
        ) {
          continue;
        }
        const sourceIds = new Set(
          [...leftMatches, ...rightMatches]
            .map(({ entry }) => sourceIdentity(entry))
            .filter((id): id is string => id != null),
        );
        if (sourceIds.size > 1) continue;
        const hasAlternateMatch = leftMatches.some(({ entry: leftEntry }) =>
          rightMatches.some(({ entry: rightEntry }) =>
            alternateTitleMatches(leftEntry, rightEntry),
          ),
        );
        if (hasAlternateMatch) {
          addCandidate(leftRoot, rightRoot);
          addCandidate(rightRoot, leftRoot);
        }
      }
    }
    for (const [root, candidates] of candidatesByRoot) {
      if (candidates.size !== 1) continue;
      const candidate = [...candidates][0]!;
      const reverseCandidates = candidatesByRoot.get(candidate);
      if (reverseCandidates?.size === 1 && reverseCandidates.has(root)) {
        union(root, candidate);
      }
    }
  }

  const occurrencesByRoot = new Map<string, typeof occurrences>();
  for (const occurrence of occurrences) {
    const root = find(occurrence.key);
    const matches = occurrencesByRoot.get(root);
    if (matches) matches.push(occurrence);
    else occurrencesByRoot.set(root, [occurrence]);
  }

  const itemIndexesByLineage = new Map<string, Array<number | null>>();
  const lineageKeyByOccurrence = new Map<string, string>();
  const usedLineageKeys = new Set<string>();
  for (const matches of occurrencesByRoot.values()) {
    matches.sort(
      (left, right) =>
        left.columnIndex - right.columnIndex ||
        left.itemIndex - right.itemIndex,
    );
    const logicalId = matches.find(({ entry }) => entry.logicalId)?.entry.logicalId;
    const preferredLineageKey = logicalId
      ? `logical:${logicalId}`
      : `occurrence:${matches[0]!.key}:${matches[0]!.entry.item.id}`;
    const lineageKey = usedLineageKeys.has(preferredLineageKey)
      ? `${preferredLineageKey}:${matches[0]!.key}`
      : preferredLineageKey;
    usedLineageKeys.add(lineageKey);
    const itemIndexes = Array<number | null>(columns.length).fill(null);
    for (const occurrence of matches) {
      itemIndexes[occurrence.columnIndex] = occurrence.itemIndex;
      lineageKeyByOccurrence.set(occurrence.key, lineageKey);
    }
    itemIndexesByLineage.set(lineageKey, itemIndexes);
  }

  const colors = assignTimelineColors(itemIndexesByLineage);
  const lineages: BumpTimelineLineage[] = [];
  const lineageByOccurrence = new Map<string, BumpTimelineLineage>();
  for (const [key, itemIndexes] of itemIndexesByLineage) {
    const presentColumns = itemIndexes.flatMap((itemIndex, columnIndex) =>
      itemIndex == null ? [] : [columnIndex],
    );
    const gaps: BumpTimelineGap[] = [];
    for (let index = 1; index < presentColumns.length; index += 1) {
      const fromColumnIndex = presentColumns[index - 1]!;
      const toColumnIndex = presentColumns[index]!;
      if (toColumnIndex - fromColumnIndex > 1) {
        gaps.push({
          fromColumnIndex,
          toColumnIndex,
          fromItemIndex: itemIndexes[fromColumnIndex]!,
          toItemIndex: itemIndexes[toColumnIndex]!,
        });
      }
    }
    const lineage: BumpTimelineLineage = {
      key,
      colorIndex: colors.get(key) ?? 0,
      itemIndexes,
      gaps,
    };
    lineages.push(lineage);
    itemIndexes.forEach((itemIndex, columnIndex) => {
      if (itemIndex != null) {
        lineageByOccurrence.set(
          occurrenceKey(columnIndex, itemIndex),
          lineage,
        );
      }
    });
  }

  const segments: BumpTimelineSegment[] = pairConnections.flatMap(
    (connections, pairIndex) =>
      connections.map((connection) => {
        const occurrence =
          connection.leftIndex != null
            ? occurrenceKey(pairIndex, connection.leftIndex)
            : occurrenceKey(pairIndex + 1, connection.rightIndex!);
        const lineageKey = lineageKeyByOccurrence.get(occurrence)!;
        return {
          ...connection,
          key: `${lineageKey}:segment:${pairIndex}:${connection.key}`,
          pairIndex,
          lineageKey,
          colorIndex: colors.get(lineageKey) ?? 0,
        };
      }),
  );

  return { lineages, segments, lineageByOccurrence };
}

export function bumpRowCenterOffsets(
  rootTop: number,
  rows: readonly { top: number; height: number }[],
): number[] {
  return rows.map((row) => row.top - rootTop + row.height / 2);
}
