import type { MediaTitleFields } from '../../lib/importers/anilist/mediaDisplayLabel';
import type { AnilistMediaListStatus } from '../../lib/importers/anilist/types';
import { franchiseDateSortKey } from './franchiseScoresLogic';

export type AdaptationListStatus = AnilistMediaListStatus;

/** All AniList list statuses available in the status filter chip. */
export const ADAPTATION_LIST_STATUS_OPTIONS: readonly AdaptationListStatus[] = [
  'CURRENT',
  'REPEATING',
  'COMPLETED',
  'PLANNING',
  'PAUSED',
  'DROPPED',
];

/** Default status filter — all statuses so planning/unwatched seeds stay visible. */
export const DEFAULT_ADAPTATION_LIST_STATUSES: readonly AdaptationListStatus[] = [
  ...ADAPTATION_LIST_STATUS_OPTIONS,
];

export const ADAPTATION_EDGE_TYPES = ['SOURCE', 'ADAPTATION'] as const;
export type AdaptationEdgeType = (typeof ADAPTATION_EDGE_TYPES)[number];

export type AdaptationDate = {
  year: number | null;
  month: number | null;
  day: number | null;
};

export type AdaptationMedia = {
  id: number;
  mediaType: 'ANIME' | 'MANGA';
  format: string | null;
  title: string;
  titleSource: MediaTitleFields;
  coverImage: string | null;
  startDate: AdaptationDate;
  listStatus: string | null;
  score: number | null;
  startedAt: AdaptationDate | null;
};

export type AdaptationPair = {
  sourceId: number;
  adaptationId: number;
};

/** A SOURCE/ADAPTATION edge discovered while scanning a specific list entry. */
export type DirectedAdaptationLink = AdaptationPair & {
  seedId: number;
};

export type AdaptationListScope = {
  animeListIds: ReadonlySet<number>;
  mangaListIds: ReadonlySet<number>;
};

export type AdaptationFilters = {
  includeAnime: boolean;
  includeManga: boolean;
  listStatuses: readonly AdaptationListStatus[];
  onlyBothOnList: boolean;
  hideSameMedium: boolean;
};

export const DEFAULT_ADAPTATION_FILTERS: AdaptationFilters = {
  includeAnime: true,
  includeManga: true,
  listStatuses: [...DEFAULT_ADAPTATION_LIST_STATUSES],
  onlyBothOnList: false,
  hideSameMedium: false,
};

export function normalizeAdaptationListStatuses(raw: unknown): AdaptationListStatus[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_ADAPTATION_LIST_STATUSES];
  }
  const selected = ADAPTATION_LIST_STATUS_OPTIONS.filter((status) => raw.includes(status));
  return selected.length > 0 ? [...selected] : [...DEFAULT_ADAPTATION_LIST_STATUSES];
}

export type AdaptationTableCell = {
  media: AdaptationMedia;
  rowSpan: number;
  /** True when this cell continues an active rowspan from a prior row. */
  skipRender: boolean;
  showConsumptionDot: boolean;
};

export type AdaptationTableRow = {
  source: AdaptationTableCell | null;
  adaptation: AdaptationTableCell | null;
  /** Underlying adaptation pair for this row (survives rowspan merges). */
  pair?: AdaptationPair;
  /** Empty source column cell so adaptation-only rows stay in column 2. */
  leadingSourceGap?: boolean;
  /** Dimmed when show-all-rows is on but filters exclude this pair. */
  hiddenByFilter?: boolean;
};

export type AdaptationDisplayBlock = {
  rows: AdaptationTableRow[];
  sortKey: number;
};

export type AdaptationScoresResult =
  | { kind: 'empty'; message: string }
  | { kind: 'table'; blocks: AdaptationDisplayBlock[] };

type PhysicalSlot = {
  mediaId: number;
  rowSpan: number;
};

type PhysicalRow = {
  source?: PhysicalSlot;
  adaptation?: PhysicalSlot;
  pair?: AdaptationPair;
};

type CrossMediumType = AdaptationMedia['mediaType'];

/**
 * Normalize a v2 relation edge from list item L to neighbor N into (source, adaptation).
 *
 * AniList v2 semantics relative to the scan seed:
 * - SOURCE: neighbor is the source of L
 * - ADAPTATION: neighbor is an adaptation of L
 */
export function normalizeAdaptationPair(
  listMediaId: number,
  relationType: string,
  neighborId: number,
): AdaptationPair | null {
  const type = relationType.trim().toUpperCase();
  if (type === 'SOURCE') {
    return { sourceId: neighborId, adaptationId: listMediaId };
  }
  if (type === 'ADAPTATION') {
    return { sourceId: listMediaId, adaptationId: neighborId };
  }
  return null;
}

export function normalizeDirectedAdaptationLink(
  listMediaId: number,
  relationType: string,
  neighborId: number,
): DirectedAdaptationLink | null {
  const pair = normalizeAdaptationPair(listMediaId, relationType, neighborId);
  if (!pair) {
    return null;
  }
  return { ...pair, seedId: listMediaId };
}

/** Recover the raw AniList relation type from a strictly-normalized directed link. */
export function relationTypeFromDirectedLink(
  link: DirectedAdaptationLink,
): AdaptationEdgeType {
  return link.sourceId === link.seedId ? 'ADAPTATION' : 'SOURCE';
}

function neighborIdFromDirectedLink(link: DirectedAdaptationLink): number {
  return link.sourceId === link.seedId ? link.adaptationId : link.sourceId;
}

function undirectedMediaPairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function isCrossMediumPair(
  leftId: number,
  rightId: number,
  mediaTypes: ReadonlyMap<number, CrossMediumType | null | undefined>,
): boolean {
  const leftType = mediaTypes.get(leftId);
  const rightType = mediaTypes.get(rightId);
  return (
    (leftType === 'ANIME' && rightType === 'MANGA') ||
    (leftType === 'MANGA' && rightType === 'ANIME')
  );
}

/**
 * Resolve one cross-medium pair to a single canonical orientation using the raw
 * relation types observed from each scan seed.
 *
 * - manga SOURCE → anime: anime is the original (pattern A spinoff)
 * - anime SOURCE → manga: manga is the original
 * - bidirectional ADAPTATION: manga → anime (pattern B; AniList quirk on anime pages)
 * - otherwise: trust the single observed ADAPTATION direction
 */
export function resolveCrossMediumAdaptationPair(
  mangaId: number,
  animeId: number,
  links: readonly DirectedAdaptationLink[],
): AdaptationPair {
  let mangaAdaptationToAnime = false;
  let mangaSourceToAnime = false;
  let animeAdaptationToManga = false;
  let animeSourceToManga = false;

  for (const edge of links) {
    const relationType = relationTypeFromDirectedLink(edge);
    const neighborId = neighborIdFromDirectedLink(edge);
    if (edge.seedId === mangaId && neighborId === animeId) {
      if (relationType === 'ADAPTATION') {
        mangaAdaptationToAnime = true;
      } else {
        mangaSourceToAnime = true;
      }
    }
    if (edge.seedId === animeId && neighborId === mangaId) {
      if (relationType === 'ADAPTATION') {
        animeAdaptationToManga = true;
      } else {
        animeSourceToManga = true;
      }
    }
  }

  if (mangaSourceToAnime) {
    return { sourceId: animeId, adaptationId: mangaId };
  }
  if (animeSourceToManga) {
    return { sourceId: mangaId, adaptationId: animeId };
  }
  if (mangaAdaptationToAnime && animeAdaptationToManga) {
    return { sourceId: mangaId, adaptationId: animeId };
  }
  if (mangaAdaptationToAnime) {
    return { sourceId: mangaId, adaptationId: animeId };
  }
  if (animeAdaptationToManga) {
    return { sourceId: animeId, adaptationId: mangaId };
  }

  return { sourceId: links[0]!.sourceId, adaptationId: links[0]!.adaptationId };
}

/** Align cross-medium directed links to one canonical pair per relationship. */
export function canonicalizeDirectedAdaptationLinks(
  links: readonly DirectedAdaptationLink[],
  mediaTypes: ReadonlyMap<number, CrossMediumType | null | undefined>,
): DirectedAdaptationLink[] {
  const crossMediumGroups = new Map<string, DirectedAdaptationLink[]>();
  const passthrough: DirectedAdaptationLink[] = [];

  for (const edge of links) {
    if (!isCrossMediumPair(edge.sourceId, edge.adaptationId, mediaTypes)) {
      passthrough.push(edge);
      continue;
    }
    const key = undirectedMediaPairKey(edge.sourceId, edge.adaptationId);
    const group = crossMediumGroups.get(key);
    if (group) {
      group.push(edge);
    } else {
      crossMediumGroups.set(key, [edge]);
    }
  }

  const out: DirectedAdaptationLink[] = [...passthrough];
  for (const group of crossMediumGroups.values()) {
    const endpointIds = [group[0]!.sourceId, group[0]!.adaptationId];
    const mangaId = endpointIds.find((id) => mediaTypes.get(id) === 'MANGA');
    const animeId = endpointIds.find((id) => mediaTypes.get(id) === 'ANIME');
    if (mangaId == null || animeId == null) {
      out.push(...group);
      continue;
    }
    const canonical = resolveCrossMediumAdaptationPair(mangaId, animeId, group);
    for (const edge of group) {
      out.push({ ...canonical, seedId: edge.seedId });
    }
  }
  return out;
}

export function adaptationPairKey(pair: AdaptationPair): string {
  return `${pair.sourceId}:${pair.adaptationId}`;
}

export function directedAdaptationLinkKey(link: DirectedAdaptationLink): string {
  return `${link.sourceId}:${link.adaptationId}:${link.seedId}`;
}

export function dedupeAdaptationPairs(pairs: readonly AdaptationPair[]): AdaptationPair[] {
  const seen = new Set<string>();
  const out: AdaptationPair[] = [];
  for (const pair of pairs) {
    const key = adaptationPairKey(pair);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(pair);
  }
  return out;
}

export function dedupeDirectedAdaptationLinks(
  links: readonly DirectedAdaptationLink[],
): DirectedAdaptationLink[] {
  const seen = new Set<string>();
  const out: DirectedAdaptationLink[] = [];
  for (const link of links) {
    const key = directedAdaptationLinkKey(link);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(link);
  }
  return out;
}

export function linksToCanonicalPairs(
  links: readonly DirectedAdaptationLink[],
): AdaptationPair[] {
  return dedupeAdaptationPairs(links);
}

export function compareMediaReleaseDate(
  a: Pick<AdaptationMedia, 'id' | 'startDate'>,
  b: Pick<AdaptationMedia, 'id' | 'startDate'>,
): number {
  const keyA = franchiseDateSortKey(a.startDate);
  const keyB = franchiseDateSortKey(b.startDate);
  if (keyA !== keyB) {
    return keyA - keyB;
  }
  return a.id - b.id;
}

export function startedAtSortKey(date: AdaptationDate | null | undefined): number {
  if (date?.year == null) {
    return Number.MAX_SAFE_INTEGER;
  }
  const month = date.month ?? 1;
  const day = date.day ?? 1;
  return date.year * 10000 + month * 100 + day;
}

function lastId(ids: readonly number[]): number | undefined {
  return ids.length > 0 ? ids[ids.length - 1] : undefined;
}

class UnionFind {
  private readonly parent = new Map<number, number>();

  add(id: number): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
    }
  }

  find(id: number): number {
    let root = id;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    let current = id;
    while (this.parent.get(current) !== root) {
      const next = this.parent.get(current)!;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    this.add(a);
    this.add(b);
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) {
      this.parent.set(rootB, rootA);
    }
  }

  components(): Map<number, number[]> {
    const groups = new Map<number, number[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const list = groups.get(root);
      if (list) {
        list.push(id);
      } else {
        groups.set(root, [id]);
      }
    }
    for (const ids of groups.values()) {
      ids.sort((a, b) => a - b);
    }
    return groups;
  }
}

export function groupPairsIntoBlocks(
  pairs: readonly AdaptationPair[],
): AdaptationPair[][] {
  const uf = new UnionFind();
  for (const pair of pairs) {
    uf.union(pair.sourceId, pair.adaptationId);
  }
  const byRoot = new Map<number, AdaptationPair[]>();
  for (const pair of pairs) {
    const root = uf.find(pair.sourceId);
    const list = byRoot.get(root);
    if (list) {
      list.push(pair);
    } else {
      byRoot.set(root, [pair]);
    }
  }
  return [...byRoot.values()];
}

function getSourcesForAdaptation(
  adaptationId: number,
  pairs: readonly AdaptationPair[],
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
): AdaptationMedia[] {
  const sourceIds = new Set<number>();
  for (const pair of pairs) {
    if (pair.adaptationId === adaptationId) {
      sourceIds.add(pair.sourceId);
    }
  }
  return [...sourceIds]
    .map((id) => mediaMap.get(id))
    .filter((media): media is AdaptationMedia => media != null)
    .sort(compareMediaReleaseDate);
}

export function isCrossMediumAdaptationPair(
  pair: AdaptationPair,
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
): boolean {
  const source = mediaMap.get(pair.sourceId);
  const adaptation = mediaMap.get(pair.adaptationId);
  return source?.mediaType !== adaptation?.mediaType;
}

function getAdaptationsInBlock(
  pairs: readonly AdaptationPair[],
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
): AdaptationMedia[] {
  const adaptationIds = new Set<number>();
  for (const pair of pairs) {
    adaptationIds.add(pair.adaptationId);
  }
  return [...adaptationIds]
    .map((id) => mediaMap.get(id))
    .filter((media): media is AdaptationMedia => media != null)
    .sort(compareMediaReleaseDate);
}

function getSortedSourceIdsForAdaptation(
  adaptationId: number,
  pairs: readonly AdaptationPair[],
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
): number[] {
  return getSourcesForAdaptation(adaptationId, pairs, mediaMap).map((media) => media.id);
}

/** True when consecutive adaptations share exactly one boundary source. */
export function canStaggerChain(
  adaptations: readonly AdaptationMedia[],
  pairs: readonly AdaptationPair[],
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
): boolean {
  if (adaptations.length < 2) {
    return false;
  }

  const sourceLists = adaptations.map((adaptation) =>
    getSortedSourceIdsForAdaptation(adaptation.id, pairs, mediaMap),
  );

  for (let i = 0; i < adaptations.length - 1; i++) {
    const left = sourceLists[i]!;
    const right = sourceLists[i + 1]!;
    if (left.length === 0 || right.length === 0 || lastId(left) !== right[0]) {
      return false;
    }
  }

  const adaptationsPerSource = new Map<number, Set<number>>();
  for (const pair of pairs) {
    let set = adaptationsPerSource.get(pair.sourceId);
    if (!set) {
      set = new Set();
      adaptationsPerSource.set(pair.sourceId, set);
    }
    set.add(pair.adaptationId);
  }
  for (const adaptationIds of adaptationsPerSource.values()) {
    if (adaptationIds.size > 2) {
      return false;
    }
  }

  for (let i = 0; i < adaptations.length - 1; i++) {
    const boundaryId = lastId(sourceLists[i]!)!;
    if (sourceLists[i]!.filter((id) => id === boundaryId).length !== 1) {
      return false;
    }
    if (sourceLists[i + 1]!.filter((id) => id === boundaryId).length !== 1) {
      return false;
    }
  }

  return true;
}

export function buildChainPhysicalRows(
  adaptations: readonly AdaptationMedia[],
  pairs: readonly AdaptationPair[],
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
): PhysicalRow[] {
  const rows: PhysicalRow[] = [];
  const n = adaptations.length;

  for (let i = 0; i < n; i++) {
    const adaptation = adaptations[i]!;
    const sortedSourceIds = getSortedSourceIdsForAdaptation(adaptation.id, pairs, mediaMap);
    const hasNext = i < n - 1;
    const adaptSpan = sortedSourceIds.length;

    if (i === 0) {
      const exclusives = hasNext ? sortedSourceIds.slice(0, -1) : sortedSourceIds;
      for (let j = 0; j < exclusives.length; j++) {
        rows.push({
          source: { mediaId: exclusives[j]!, rowSpan: 1 },
          adaptation:
            j === 0 ? { mediaId: adaptation.id, rowSpan: adaptSpan } : undefined,
          pair: { sourceId: exclusives[j]!, adaptationId: adaptation.id },
        });
      }
      if (hasNext) {
        if (exclusives.length === 0) {
          rows.push({
            source: { mediaId: lastId(sortedSourceIds)!, rowSpan: 2 },
            adaptation: { mediaId: adaptation.id, rowSpan: 1 },
            pair: {
              sourceId: lastId(sortedSourceIds)!,
              adaptationId: adaptation.id,
            },
          });
        } else {
          rows.push({
            source: { mediaId: lastId(sortedSourceIds)!, rowSpan: 2 },
            pair: {
              sourceId: lastId(sortedSourceIds)!,
              adaptationId: adaptation.id,
            },
          });
        }
      } else if (exclusives.length === 0 && sortedSourceIds.length === 1) {
        rows.push({
          source: { mediaId: sortedSourceIds[0]!, rowSpan: 1 },
          adaptation: { mediaId: adaptation.id, rowSpan: 1 },
          pair: { sourceId: sortedSourceIds[0]!, adaptationId: adaptation.id },
        });
      }
    } else if (hasNext) {
      rows.push({ adaptation: { mediaId: adaptation.id, rowSpan: adaptSpan } });
      for (const sourceId of sortedSourceIds.slice(1, -1)) {
        rows.push({ source: { mediaId: sourceId, rowSpan: 1 } });
      }
      rows.push({ source: { mediaId: lastId(sortedSourceIds)!, rowSpan: 2 } });
    } else {
      rows.push({ adaptation: { mediaId: adaptation.id, rowSpan: adaptSpan } });
      for (const sourceId of sortedSourceIds.slice(1)) {
        rows.push({ source: { mediaId: sourceId, rowSpan: 1 } });
      }
    }
  }

  return rows;
}

function buildDuplicatePhysicalRows(
  adaptations: readonly AdaptationMedia[],
  pairs: readonly AdaptationPair[],
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
): PhysicalRow[] {
  const rows: PhysicalRow[] = [];
  for (const adaptation of adaptations) {
    const sources = getSourcesForAdaptation(adaptation.id, pairs, mediaMap);
    for (const source of sources) {
      rows.push({
        source: { mediaId: source.id, rowSpan: 1 },
        adaptation: { mediaId: adaptation.id, rowSpan: 1 },
        pair: { sourceId: source.id, adaptationId: adaptation.id },
      });
    }
  }
  return rows;
}

function countSourcesForAdaptation(
  adaptationId: number,
  pairs: readonly AdaptationPair[],
): number {
  const sources = new Set<number>();
  for (const pair of pairs) {
    if (pair.adaptationId === adaptationId) {
      sources.add(pair.sourceId);
    }
  }
  return sources.size;
}

function applyDuplicateRowspans(
  physical: PhysicalRow[],
  pairs: readonly AdaptationPair[],
): PhysicalRow[] {
  if (physical.length === 0) {
    return physical;
  }

  const out = physical.map((row) => ({
    source: row.source ? { ...row.source } : undefined,
    adaptation: row.adaptation ? { ...row.adaptation } : undefined,
    pair: row.pair,
  }));

  // Adaptation column: merge within consecutive runs per adaptation id
  let adaptStart = 0;
  while (adaptStart < out.length) {
    const adaptId = out[adaptStart]?.adaptation?.mediaId;
    if (adaptId == null) {
      adaptStart++;
      continue;
    }
    let adaptEnd = adaptStart + 1;
    while (
      adaptEnd < out.length &&
      out[adaptEnd]?.adaptation?.mediaId === adaptId &&
      out[adaptEnd]?.adaptation?.rowSpan === 1
    ) {
      adaptEnd++;
    }
    const span = adaptEnd - adaptStart;
    if (span > 1 && out[adaptStart]?.adaptation) {
      out[adaptStart]!.adaptation!.rowSpan = span;
      for (let i = adaptStart + 1; i < adaptEnd; i++) {
        if (out[i]?.adaptation) {
          out[i]!.adaptation = undefined;
        }
      }
    }
    adaptStart = adaptEnd;
  }

  // Source column: merge consecutive same sourceId when each adaptation in the
  // run is exclusively sourced (multi-source adaptations get their own row).
  let sourceStart = 0;
  while (sourceStart < out.length) {
    const sourceId = out[sourceStart]?.source?.mediaId;
    if (sourceId == null) {
      sourceStart++;
      continue;
    }
    let sourceEnd = sourceStart + 1;
    while (sourceEnd < out.length) {
      const next = out[sourceEnd];
      if (next?.source?.mediaId !== sourceId || next?.source?.rowSpan !== 1) {
        break;
      }
      const adaptationId =
        next.pair?.adaptationId ?? next.adaptation?.mediaId ?? null;
      if (adaptationId != null && countSourcesForAdaptation(adaptationId, pairs) > 1) {
        break;
      }
      sourceEnd++;
    }
    const span = sourceEnd - sourceStart;
    if (span > 1 && out[sourceStart]?.source) {
      out[sourceStart]!.source!.rowSpan = span;
      for (let i = sourceStart + 1; i < sourceEnd; i++) {
        if (out[i]?.source) {
          out[i]!.source = undefined;
        }
      }
    }
    sourceStart = sourceEnd;
  }

  return out;
}

function activeSpanRowCount(spans: ReadonlyMap<number, number>): number {
  let count = 0;
  for (const remaining of spans.values()) {
    count += remaining;
  }
  return count;
}

function consumeImplicitRowspans(spans: Map<number, number>): void {
  for (const [id, remaining] of [...spans.entries()]) {
    const next = remaining - 1;
    if (next <= 0) {
      spans.delete(id);
    } else {
      spans.set(id, next);
    }
  }
}

function physicalRowsToTableRows(
  physical: readonly PhysicalRow[],
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
  consumptionDotId: number | null,
): AdaptationTableRow[] {
  const activeSourceSpans = new Map<number, number>();
  const activeAdaptSpans = new Map<number, number>();

  return physical.map((row) => {
    const sourceColumnOccupied = activeSpanRowCount(activeSourceSpans) > 0;
    let sourceCell: AdaptationTableCell | null = null;
    let adaptationCell: AdaptationTableCell | null = null;

    if (row.source) {
      const remaining = activeSourceSpans.get(row.source.mediaId) ?? 0;
      if (remaining > 0) {
        activeSourceSpans.set(row.source.mediaId, remaining - 1);
        sourceCell = {
          media: mediaMap.get(row.source.mediaId)!,
          rowSpan: row.source.rowSpan,
          skipRender: true,
          showConsumptionDot: false,
        };
      } else {
        const media = mediaMap.get(row.source.mediaId);
        if (media) {
          if (row.source.rowSpan > 1) {
            activeSourceSpans.set(row.source.mediaId, row.source.rowSpan - 1);
          }
          sourceCell = {
            media,
            rowSpan: row.source.rowSpan,
            skipRender: false,
            showConsumptionDot: consumptionDotId === media.id,
          };
        }
      }
    }

    if (row.adaptation) {
      const remaining = activeAdaptSpans.get(row.adaptation.mediaId) ?? 0;
      if (remaining > 0) {
        activeAdaptSpans.set(row.adaptation.mediaId, remaining - 1);
        adaptationCell = {
          media: mediaMap.get(row.adaptation.mediaId)!,
          rowSpan: row.adaptation.rowSpan,
          skipRender: true,
          showConsumptionDot: false,
        };
      } else {
        const media = mediaMap.get(row.adaptation.mediaId);
        if (media) {
          if (row.adaptation.rowSpan > 1) {
            activeAdaptSpans.set(row.adaptation.mediaId, row.adaptation.rowSpan - 1);
          }
          adaptationCell = {
            media,
            rowSpan: row.adaptation.rowSpan,
            skipRender: false,
            showConsumptionDot: consumptionDotId === media.id,
          };
        }
      }
    }

    const leadingSourceGap =
      adaptationCell != null &&
      !adaptationCell.skipRender &&
      (sourceCell == null || sourceCell.skipRender) &&
      !sourceColumnOccupied;

    if (row.source == null) {
      consumeImplicitRowspans(activeSourceSpans);
    }
    if (row.adaptation == null) {
      consumeImplicitRowspans(activeAdaptSpans);
    }

    return {
      source: sourceCell,
      adaptation: adaptationCell,
      pair: row.pair,
      leadingSourceGap,
    };
  });
}

export function pickConsumptionDotMediaId(
  mediaIds: readonly number[],
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
): number | null {
  let bestId: number | null = null;
  let bestKey = Number.MAX_SAFE_INTEGER;
  let bestIsSource = false;

  for (const id of mediaIds) {
    const media = mediaMap.get(id);
    if (!media || media.listStatus == null || !media.startedAt?.year) {
      continue;
    }
    const key = startedAtSortKey(media.startedAt);
    const isSource = mediaIds.indexOf(id) < mediaIds.length / 2;
    if (
      key < bestKey ||
      (key === bestKey && isSource && !bestIsSource)
    ) {
      bestKey = key;
      bestId = id;
      bestIsSource = isSource;
    }
  }

  return bestId;
}

function pickConsumptionDotForBlock(
  pairs: readonly AdaptationPair[],
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
): number | null {
  const ids = new Set<number>();
  for (const pair of pairs) {
    ids.add(pair.sourceId);
    ids.add(pair.adaptationId);
  }
  const onList = [...ids].filter((id) => {
    const media = mediaMap.get(id);
    return media?.listStatus != null && media.startedAt?.year != null;
  });
  if (onList.length === 0) {
    return null;
  }
  let bestId = onList[0]!;
  let bestKey = startedAtSortKey(mediaMap.get(bestId)?.startedAt);
  let bestIsSource = pairs.some((pair) => pair.sourceId === bestId);
  for (const id of onList.slice(1)) {
    const key = startedAtSortKey(mediaMap.get(id)?.startedAt);
    const isSource = pairs.some((pair) => pair.sourceId === id);
    if (key < bestKey || (key === bestKey && isSource && !bestIsSource)) {
      bestKey = key;
      bestId = id;
      bestIsSource = isSource;
    }
  }
  return bestId;
}

function blockSortKey(
  pairs: readonly AdaptationPair[],
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
): number {
  const adaptations = getAdaptationsInBlock(pairs, mediaMap);
  if (adaptations.length === 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.min(...adaptations.map((media) => franchiseDateSortKey(media.startDate)));
}

function buildBlockLayoutRows(
  pairs: readonly AdaptationPair[],
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
  consumptionDotId: number | null,
): AdaptationTableRow[] {
  const adaptations = getAdaptationsInBlock(pairs, mediaMap);
  if (adaptations.length === 0) {
    return [];
  }

  let physical: PhysicalRow[];
  if (adaptations.length >= 2 && canStaggerChain(adaptations, pairs, mediaMap)) {
    physical = buildChainPhysicalRows(adaptations, pairs, mediaMap);
  } else {
    physical = buildDuplicatePhysicalRows(adaptations, pairs, mediaMap);
    physical = applyDuplicateRowspans(physical, pairs);
  }

  return physicalRowsToTableRows(physical, mediaMap, consumptionDotId);
}

export function buildAdaptationBlockRows(
  pairs: readonly AdaptationPair[],
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
): AdaptationTableRow[] {
  if (pairs.length === 0) {
    return [];
  }

  const consumptionDotId = pickConsumptionDotForBlock(pairs, mediaMap);
  return buildBlockLayoutRows(pairs, mediaMap, consumptionDotId);
}

export function linkPassesListScopeFilter(
  link: DirectedAdaptationLink,
  scope: AdaptationListScope,
  filters: AdaptationFilters,
): boolean {
  if (!filters.includeAnime && !filters.includeManga) {
    return false;
  }

  const seedOnAnime = scope.animeListIds.has(link.seedId);
  const seedOnManga = scope.mangaListIds.has(link.seedId);

  if (filters.includeAnime && filters.includeManga) {
    return seedOnAnime || seedOnManga;
  }
  if (filters.includeAnime) {
    return seedOnAnime;
  }
  return seedOnManga;
}

export function linkPassesListStatusFilter(
  link: DirectedAdaptationLink,
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
  filters: AdaptationFilters,
): boolean {
  const listStatuses = filters.listStatuses;
  if (listStatuses.length === 0) {
    return false;
  }
  if (listStatuses.length >= ADAPTATION_LIST_STATUS_OPTIONS.length) {
    return true;
  }
  const status = mediaMap.get(link.seedId)?.listStatus;
  return status != null && new Set<string>(listStatuses).has(status);
}

export function pairPassesDoublyConnectedFilter(
  pair: AdaptationPair,
  passingLinks: readonly DirectedAdaptationLink[],
): boolean {
  const seeds = new Set(passingLinks.map((link) => link.seedId));
  return seeds.has(pair.sourceId) && seeds.has(pair.adaptationId);
}

export function pairPassesSameMediumFilter(
  pair: AdaptationPair,
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
  hideSameMedium: boolean,
): boolean {
  if (!hideSameMedium) {
    return true;
  }
  const source = mediaMap.get(pair.sourceId);
  const adaptation = mediaMap.get(pair.adaptationId);
  return source?.mediaType !== adaptation?.mediaType;
}

export function applyAdaptationFilters(
  links: readonly DirectedAdaptationLink[],
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
  scope: AdaptationListScope,
  filters: AdaptationFilters,
): AdaptationPair[] {
  if (!filters.includeAnime && !filters.includeManga) {
    return [];
  }

  const passingLinks = links.filter(
    (link) =>
      linkPassesListScopeFilter(link, scope, filters) &&
      linkPassesListStatusFilter(link, mediaMap, filters) &&
      pairPassesSameMediumFilter(link, mediaMap, filters.hideSameMedium),
  );

  const byPairKey = new Map<string, DirectedAdaptationLink[]>();
  for (const link of passingLinks) {
    const key = adaptationPairKey(link);
    const group = byPairKey.get(key);
    if (group) {
      group.push(link);
    } else {
      byPairKey.set(key, [link]);
    }
  }

  const out: AdaptationPair[] = [];
  for (const groupLinks of byPairKey.values()) {
    const pair = {
      sourceId: groupLinks[0]!.sourceId,
      adaptationId: groupLinks[0]!.adaptationId,
    };
    if (filters.onlyBothOnList && !pairPassesDoublyConnectedFilter(pair, groupLinks)) {
      continue;
    }
    out.push(pair);
  }
  return out;
}

export function buildAdaptationDisplay(
  links: readonly DirectedAdaptationLink[],
  mediaMap: ReadonlyMap<number, AdaptationMedia>,
  scope: AdaptationListScope,
  filters: AdaptationFilters,
  options?: { showAllRows?: boolean },
): AdaptationScoresResult {
  const showAllRows = options?.showAllRows ?? false;
  const filtered = applyAdaptationFilters(links, mediaMap, scope, filters);
  const allPairs = linksToCanonicalPairs(links);
  const workingPairs = showAllRows ? allPairs : filtered;
  if (workingPairs.length === 0) {
    return { kind: 'empty', message: 'No adaptation pairs match the current filters.' };
  }

  const filteredKeys = new Set(filtered.map((pair) => adaptationPairKey(pair)));

  const resolveRowPair = (
    row: AdaptationTableRow,
    blockPairs: readonly AdaptationPair[],
  ): AdaptationPair | null => {
    if (row.pair) {
      return row.pair;
    }
    const sourceId = row.source?.media.id ?? null;
    const adaptationId = row.adaptation?.media.id ?? null;
    if (sourceId != null && adaptationId != null) {
      return { sourceId, adaptationId };
    }
    if (adaptationId != null) {
      const matches = blockPairs.filter((pair) => pair.adaptationId === adaptationId);
      if (matches.length === 1) {
        return matches[0]!;
      }
    }
    if (sourceId != null) {
      const matches = blockPairs.filter((pair) => pair.sourceId === sourceId);
      if (matches.length === 1) {
        return matches[0]!;
      }
    }
    return null;
  };

  const blocks = groupPairsIntoBlocks(workingPairs)
    .map((blockPairs) => ({
      rows: buildAdaptationBlockRows(blockPairs, mediaMap).map((row) => {
        if (!showAllRows) {
          return row;
        }
        const pair = resolveRowPair(row, blockPairs);
        if (pair == null) {
          return row;
        }
        const hiddenByFilter = !filteredKeys.has(adaptationPairKey(pair));
        return hiddenByFilter ? { ...row, hiddenByFilter: true } : row;
      }),
      sortKey: blockSortKey(blockPairs, mediaMap),
    }))
    .filter((block) => block.rows.length > 0)
    .sort((a, b) => a.sortKey - b.sortKey);

  if (blocks.length === 0) {
    return { kind: 'empty', message: 'No adaptation pairs match the current filters.' };
  }

  return { kind: 'table', blocks };
}
