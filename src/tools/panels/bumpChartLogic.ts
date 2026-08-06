import { dedupRows, type RawRow } from '../../lib/csv';
import {
  isCustomAnilistItemLabel,
  relabelAnilistItem,
  relabelAnilistItemPreservingFormat,
  resolveCachedAnilistMediaItem,
} from '../../lib/importers/anilist/anilistItemLabel';
import { personNameSearchParts } from '../../lib/importers/anilist/personDisplayLabel';
import { productionReads } from '../../lib/importers/anilist/readQueries';
import type { AnilistItemLabelSource, Item } from '../../lib/types';

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
  leftIndex: number | null;
  rightIndex: number | null;
  colorIndex: number;
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

const ANILIST_STUDIO_ID_PREFIX = 'anilist-studios:';

function studioExternalId(item: Item): number | null {
  if (!item.id.startsWith(ANILIST_STUDIO_ID_PREFIX)) {
    return null;
  }
  const externalId = Number(item.id.slice(ANILIST_STUDIO_ID_PREFIX.length));
  return Number.isSafeInteger(externalId) && externalId > 0 ? externalId : null;
}

function isAnilistSourceMatched(item: Item): boolean {
  return (
    (item.source != null && item.source.kind !== 'manual') ||
    studioExternalId(item) != null
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

function finishSourceHydration(
  entry: BumpChartItem,
  resolved: Item,
): BumpChartItem {
  if (!entry.inferLegacyCustomLabel) {
    return {
      ...entry,
      item:
        resolved.anilistLabelMode === 'custom'
          ? resolved
          : relabelAnilistItemPreservingFormat(resolved, true),
    };
  }

  const candidate = { ...resolved, label: entry.item.label };
  if (isCustomAnilistItemLabel(candidate)) {
    const source = candidate.anilistLabelSource;
    const includesFormat =
      candidate.anilistLabelIncludesFormat ??
      (source?.kind === 'media' && source.format != null
        ? candidate.label.endsWith(` (${source.format})`)
        : undefined);
    return {
      ...entry,
      item: {
        ...candidate,
        anilistLabelMode: 'custom',
        ...(includesFormat === undefined
          ? {}
          : { anilistLabelIncludesFormat: includesFormat }),
      },
    };
  }
  return {
    ...entry,
    item: relabelAnilistItemPreservingFormat(candidate, true),
  };
}

function hydratePersonEntry(
  entry: BumpChartItem,
  row: { id: number; name_full: string | null; name_native: string | null },
  kind: 'character' | 'person',
): BumpChartItem {
  const nameFields = {
    id: row.id,
    name_full: row.name_full,
    name_native: row.name_native,
  };
  const anilistLabelSource: AnilistItemLabelSource = {
    kind,
    nameFields,
    fallbackLabel: kind === 'character' ? 'Character' : 'Staff',
  };
  return finishSourceHydration(entry, {
    ...entry.item,
    anilistLabelSource,
    searchTokens: personNameSearchParts(nameFields),
  });
}

/** Attach cached AniList title/name metadata before label selection. */
export async function hydrateBumpChartItems(
  entries: readonly BumpChartItem[],
): Promise<BumpChartItem[]> {
  const mediaIds = entries
    .map(({ item }) =>
      item.source?.kind === 'anilist' && !item.anilistLabelSource
        ? item.source.externalId
        : null,
    )
    .filter((id): id is number => id != null);
  const characterIds = entries
    .map(({ item }) =>
      item.source?.kind === 'anilist-character' && !item.anilistLabelSource
        ? item.source.externalId
        : null,
    )
    .filter((id): id is number => id != null);
  const staffIds = entries
    .map(({ item }) =>
      item.source?.kind === 'anilist-staff' && !item.anilistLabelSource
        ? item.source.externalId
        : null,
    )
    .filter((id): id is number => id != null);
  const studioIds = entries
    .map(({ item }) =>
      !item.anilistLabelSource ? studioExternalId(item) : null,
    )
    .filter((id): id is number => id != null);
  if (
    mediaIds.length === 0 &&
    characterIds.length === 0 &&
    staffIds.length === 0 &&
    studioIds.length === 0
  ) {
    return [...entries];
  }

  try {
    const [mediaRows, characterRows, staffRows, studioRows] = await Promise.all([
      mediaIds.length > 0
        ? productionReads.getMediaByIds([...new Set(mediaIds)])
        : Promise.resolve([]),
      characterIds.length > 0
        ? productionReads.getCharactersByIds([...new Set(characterIds)])
        : Promise.resolve([]),
      staffIds.length > 0
        ? productionReads.getStaffByIds([...new Set(staffIds)])
        : Promise.resolve([]),
      studioIds.length > 0
        ? productionReads.getStudiosByIds([...new Set(studioIds)])
        : Promise.resolve([]),
    ]);
    const mediaById = new Map(mediaRows.map((row) => [row.id, row]));
    const charactersById = new Map(characterRows.map((row) => [row.id, row]));
    const staffById = new Map(staffRows.map((row) => [row.id, row]));
    const studiosById = new Map(studioRows.map((row) => [row.id, row]));
    return entries.map((entry) => {
      if (entry.item.anilistLabelSource) {
        return entry;
      }
      const studioId = studioExternalId(entry.item);
      if (studioId != null) {
        const row = studiosById.get(studioId);
        return row
          ? finishSourceHydration(entry, {
              ...entry.item,
              anilistLabelSource: { kind: 'studio', label: row.name },
              searchTokens: [row.name],
            })
          : entry;
      }
      const source = entry.item.source;
      if (!source) return entry;
      if (source.kind === 'anilist') {
        const row = mediaById.get(source.externalId);
        if (!row) return entry;
        const resolved = resolveCachedAnilistMediaItem(entry.item, row);
        return finishSourceHydration(entry, {
          ...resolved,
          imageUrl: resolved.imageUrl ?? row.cover_image ?? undefined,
        });
      }
      if (source.kind === 'anilist-character') {
        const row = charactersById.get(source.externalId);
        return row ? hydratePersonEntry(entry, row, 'character') : entry;
      }
      if (source.kind === 'anilist-staff') {
        const row = staffById.get(source.externalId);
        return row ? hydratePersonEntry(entry, row, 'person') : entry;
      }
      return entry;
    });
  } catch {
    // The chart remains usable when the optional local source database is unavailable.
    return [...entries];
  }
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

/**
 * Match stable logical ids first. Exact labels are a fallback only when at
 * least one side lacks a logical id, so two different source entities with
 * the same display name are never collapsed together.
 */
export function buildBumpConnections(
  left: readonly BumpChartItem[],
  right: readonly BumpChartItem[],
): BumpConnection[] {
  const usedRight = new Set<number>();
  const matchedRightByLeft = new Map<number, number>();
  const rightByLogicalId = new Map<string, number[]>();
  const rightByLabel = new Map<string, number[]>();
  const rightPlainByLabel = new Map<string, number[]>();
  right.forEach((entry, index) => {
    if (entry.logicalId) {
      appendIndex(rightByLogicalId, entry.logicalId, index);
    } else {
      appendIndex(rightPlainByLabel, entry.item.label, index);
    }
    appendIndex(rightByLabel, entry.item.label, index);
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
      usedRight.add(rightIndex);
    }
  }

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    if (matchedRightByLeft.has(leftIndex)) {
      continue;
    }
    const leftEntry = left[leftIndex]!;
    const rightIndex = takeFirstUnused(
      leftEntry.logicalId
        ? rightPlainByLabel.get(leftEntry.item.label)
        : rightByLabel.get(leftEntry.item.label),
      usedRight,
    );
    if (rightIndex != null) {
      matchedRightByLeft.set(leftIndex, rightIndex);
      usedRight.add(rightIndex);
    }
  }

  const connections: BumpConnection[] = left.map((_, leftIndex) => {
    const rightIndex = matchedRightByLeft.get(leftIndex);
    return {
      key:
        rightIndex == null
          ? `removed:${leftIndex}`
          : `matched:${leftIndex}:${rightIndex}`,
      kind: rightIndex == null ? 'removed' : 'matched',
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
