import {
  isCustomAnilistItemLabel,
  resolveAnilistItemLabel,
} from './importers/anilist/anilistItemLabel';
import type {
  Item,
  ItemId,
  ItemSource,
  SortVersion,
  SortVersionItem,
  SortVersionOverride,
  StoredSortVersion,
} from './types';

// Kept free of storage/engine imports so storage.ts and slotResultsImport.ts can use it without an import cycle.

export function newSortVersionId(): string {
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** AniList items get automatic names and images; e.g. `anilist-staff:95053`. */
function isAnilistItemId(id: ItemId): boolean {
  return /^anilist(-staff|-character|-studios)?:\d+$/.test(id);
}

const SOURCE_KINDS = ['anilist', 'anilist-character', 'anilist-staff'] as const;

/** AniList item IDs are `${source.kind}:${externalId}`; studios have no source kind. */
export function sourceFromItemId(id: ItemId): ItemSource | undefined {
  const match = /^([a-z-]+):(\d+)$/.exec(id);
  const kind = SOURCE_KINDS.find((k) => k === match?.[1]);
  return kind && match ? { kind, externalId: Number(match[2]) } : undefined;
}

/** In-memory version item: the whole item, so a dropped item keeps its metadata. */
export function sortVersionItem(item: Item): SortVersionItem {
  const { id: _id, ...rest } = item;
  return rest;
}

/**
 * What a version has to store for an item: only what the user chose. AniList items
 * keep a name only when it's custom and an image only when it isn't AniList's
 * (`''` = image removed); plain items keep their name, image and URL.
 * e.g. an automatic `Frieren` with AniList's cover → `{}`.
 */
export function versionItemOverride(id: ItemId, item: SortVersionItem): SortVersionOverride {
  const out: SortVersionOverride = {};
  if (!isAnilistItemId(id)) {
    out.label = item.label;
    if (item.imageUrl) out.imageUrl = item.imageUrl;
    if (item.url) out.url = item.url;
    return out;
  }
  // Like hydration, an explicit marker wins; only unmarked (legacy) names are inferred.
  const custom =
    item.anilistLabelMode === undefined
      ? isCustomAnilistItemLabel({ ...item, id })
      : item.anilistLabelMode === 'custom';
  if (custom) out.label = item.label;
  if (item.imageUrl !== item.anilistImageSource) out.imageUrl = item.imageUrl ?? '';
  return out;
}

/** The automatic name, keeping the item's "(TV)"-suffix choice. */
function automaticLabel(item: SortVersionItem): string {
  const source = item.anilistLabelSource;
  if (!source) return item.label;
  const suffix = source.kind === 'media' && source.format ? ` (${source.format})` : null;
  const includeFormat =
    item.anilistLabelIncludesFormat ?? (suffix !== null && item.label.endsWith(suffix));
  return resolveAnilistItemLabel(source, includeFormat);
}

/**
 * The item as a version had it: the version's overrides on top of `base` (the sort's
 * current copy, or the stored copy of a dropped item), which supplies the metadata
 * and the default name and image. A dropped item gets its source from the ID so its
 * detail modal can open.
 */
export function resolveVersionItem(
  base: Item | undefined,
  id: ItemId,
  override: SortVersionOverride,
): SortVersionItem {
  const item: SortVersionItem = base ? sortVersionItem(base) : { label: id };
  const source = item.source ?? sourceFromItemId(id);
  if (source) item.source = source;
  if (!isAnilistItemId(id)) {
    item.label = override.label ?? item.label;
    setOptional(item, 'imageUrl', override.imageUrl);
    setOptional(item, 'url', override.url);
    return item;
  }
  if (override.label !== undefined) {
    item.label = override.label;
    item.anilistLabelMode = 'custom';
  } else {
    item.label = automaticLabel(item);
    item.anilistLabelMode = 'automatic';
  }
  if (override.imageUrl !== undefined) setOptional(item, 'imageUrl', override.imageUrl);
  else if (item.anilistImageSource) item.imageUrl = item.anilistImageSource;
  return item;
}

/**
 * The item to use when a version is restored or imported: the version's names, images
 * and URLs the user chose, on the sort's current copy (newer AniList metadata) when it
 * still has the item, otherwise on the version's own copy.
 */
export function itemAtVersion(current: Item | undefined, id: ItemId, snap: SortVersionItem): Item {
  const base = current ?? { ...snap, id };
  return { ...resolveVersionItem(base, id, versionItemOverride(id, snap)), id };
}

function setOptional(item: SortVersionItem, key: 'imageUrl' | 'url', value: string | undefined) {
  if (value) item[key] = value;
  else delete item[key];
}

function sameOverride(a: SortVersionOverride, b: SortVersionOverride): boolean {
  return a.label === b.label && a.imageUrl === b.imageUrl && a.url === b.url;
}

/** Whether a name the user chose differs, e.g. a custom name added, edited or reset. */
export function versionItemRenamed(id: ItemId, a: SortVersionItem, b: SortVersionItem): boolean {
  return versionItemOverride(id, a).label !== versionItemOverride(id, b).label;
}

/** Same ranking and the same user-chosen names, images and URLs. */
export function sameVersionContent(
  a: Pick<SortVersion, 'rankedIds' | 'items'>,
  b: Pick<SortVersion, 'rankedIds' | 'items'>,
): boolean {
  if (a.rankedIds.length !== b.rankedIds.length) return false;
  return a.rankedIds.every((id, i) => {
    if (id !== b.rankedIds[i]) return false;
    const before = a.items[id];
    const after = b.items[id];
    if (!before || !after) return before === after;
    return sameOverride(versionItemOverride(id, before), versionItemOverride(id, after));
  });
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Local date, e.g. "2026-10-28", or "2026-10-28 14:05" with `withTime`. */
export interface VersionSummary {
  count: number;
  /** ISO date of the newest version; absent when there are none. */
  latestAt?: string;
}

/** Version count and newest date, e.g. for Drive metadata and importer rows. */
export function summarizeVersions(
  versions: readonly { createdAt: string }[] | undefined,
): VersionSummary {
  let latest: string | undefined;
  for (const v of versions ?? []) {
    if (latest === undefined || Date.parse(v.createdAt) > Date.parse(latest)) latest = v.createdAt;
  }
  const count = versions?.length ?? 0;
  return latest === undefined ? { count } : { count, latestAt: latest };
}

export function formatSortVersionDate(iso: string, withTime = false): string {
  const d = new Date(iso);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return withTime ? `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Stored per-item data: an override, or a whole legacy snapshot (`{label, imageUrl, url}`). */
type ParsedVersion = Omit<StoredSortVersion, 'overrides'> & {
  entries: Record<ItemId, Record<string, unknown>>;
  legacy: boolean;
};

function parseVersion(raw: unknown): ParsedVersion | null {
  if (!isRecord(raw)) return null;
  const { id, createdAt, rankedIds } = raw;
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return null;
  if (!Array.isArray(rankedIds)) return null;
  // Versions written before the item table carry a full snapshot per ranked item.
  const legacy = isRecord(raw.items);
  const entries = (legacy ? raw.items : raw.overrides) ?? {};
  if (!isRecord(entries)) return null;
  const isEntry = (v: unknown): v is string =>
    typeof v === 'string' && (legacy ? isRecord(entries[v]) : !(v in entries) || isRecord(entries[v]));
  const ids = rankedIds.filter(isEntry);
  if (ids.length === 0) return null;
  return {
    id: typeof id === 'string' && id ? id : newSortVersionId(),
    createdAt,
    rankedIds: ids,
    entries: entries as Record<ItemId, Record<string, unknown>>,
    legacy,
    ...(raw.live === true ? { live: true as const } : {}),
  };
}

function parseOverride(raw: Record<string, unknown> | undefined): SortVersionOverride {
  const out: SortVersionOverride = {};
  const label = optionalString(raw?.label);
  const imageUrl = optionalString(raw?.imageUrl);
  const url = optionalString(raw?.url);
  if (label !== undefined) out.label = label;
  if (imageUrl !== undefined) out.imageUrl = imageUrl;
  if (url !== undefined) out.url = url;
  return out;
}

/** Same test hydration uses for images saved before `anilistImageSource` existed. */
function isAnilistCdnImageUrl(value: string): boolean {
  try {
    return new URL(value).hostname === 's4.anilist.co';
  } catch {
    return false;
  }
}

/**
 * Legacy snapshots stored every name and image, so custom AniList names can't be told
 * apart from automatic ones; they're treated as automatic. AniList's own images
 * (including covers AniList has since replaced) aren't overrides either.
 */
function legacyOverride(id: ItemId, snap: Record<string, unknown>, base: Item | undefined) {
  const parsed = parseOverride(snap);
  if (!isAnilistItemId(id)) return parsed;
  const out: SortVersionOverride = {};
  const defaultImage = base?.anilistImageSource ?? base?.imageUrl;
  const { imageUrl } = parsed;
  if (imageUrl && imageUrl !== defaultImage && !isAnilistCdnImageUrl(imageUrl)) {
    out.imageUrl = imageUrl;
  }
  return out;
}

/** Stored copy of a dropped item, from its newest legacy snapshot. */
function droppedItemFromLegacy(id: ItemId, snap: Record<string, unknown>): Item {
  const { label, imageUrl, url } = parseOverride(snap);
  const item: Item = { id, label: label ?? id };
  if (url) item.url = url;
  if (imageUrl) {
    item.imageUrl = imageUrl;
    if (isAnilistItemId(id)) item.anilistImageSource = imageUrl;
  }
  const source = sourceFromItemId(id);
  if (source) item.source = source;
  return item;
}

function parseVersionItems(raw: unknown): Map<ItemId, Item> {
  const table = new Map<ItemId, Item>();
  if (!isRecord(raw)) return table;
  for (const [id, value] of Object.entries(raw)) {
    if (isRecord(value) && typeof value.label === 'string') {
      table.set(id, { ...(value as unknown as Item), id });
    }
  }
  return table;
}

/** Freezes every version but the newest, which keeps its `live` flag if it had one. */
export function onlyNewestLive(versions: SortVersion[]): SortVersion[] {
  return versions.map((v, i) => {
    if (!v.live || i === versions.length - 1) return v;
    return frozenVersion(v);
  });
}

export function frozenVersion(v: SortVersion): SortVersion {
  if (!v.live) return v;
  const { live: _live, ...frozen } = v;
  return frozen;
}

/**
 * Decodes stored versions into whole items: each version's overrides on top of the
 * sort's current item, or the stored copy (`rawVersionItems`) of an item the sort
 * no longer has. Legacy saves are repaired on the way (see `legacyOverride`).
 * Malformed entries are dropped; returns undefined when nothing valid remains.
 */
export function normalizeSortVersions(
  raw: unknown,
  rawVersionItems?: unknown,
  liveItems: Readonly<Record<ItemId, Item>> = {},
): SortVersion[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parsed = raw.map(parseVersion).filter((v): v is ParsedVersion => v !== null);
  if (parsed.length === 0) return undefined;
  const table = parseVersionItems(rawVersionItems);
  for (const v of [...parsed].reverse()) {
    if (!v.legacy) continue;
    for (const id of v.rankedIds) {
      if (!liveItems[id] && !table.has(id)) table.set(id, droppedItemFromLegacy(id, v.entries[id]!));
    }
  }
  const versions = parsed.map(({ entries, legacy, ...v }): SortVersion => {
    const items: Record<ItemId, SortVersionItem> = {};
    for (const id of v.rankedIds) {
      const base = liveItems[id] ?? table.get(id);
      const override = legacy ? legacyOverride(id, entries[id]!, base) : parseOverride(entries[id]);
      items[id] = resolveVersionItem(base, id, override);
    }
    return { ...v, items };
  });
  return onlyNewestLive(versions);
}

/**
 * Encodes versions for a save: per-version overrides, plus one stored copy of each
 * item the sort no longer has (`versionItems`; the sort's own items are saved anyway).
 */
export function storedSortVersions(
  versions: readonly SortVersion[],
  liveItems: Readonly<Record<ItemId, Item>>,
): { versions: StoredSortVersion[]; versionItems?: Record<ItemId, Item> } {
  const versionItems: Record<ItemId, Item> = {};
  const stored = versions.map(({ items, ...v }): StoredSortVersion => {
    const overrides: Record<ItemId, SortVersionOverride> = {};
    for (const id of v.rankedIds) {
      const item = items[id];
      if (!item) continue;
      // Defaults only (automatic name, AniList image): the overrides carry the rest,
      // and a canonical copy keeps re-encoding a decoded blob byte-identical.
      if (!liveItems[id]) versionItems[id] = { ...resolveVersionItem({ ...item, id }, id, {}), id };
      const override = versionItemOverride(id, item);
      if (Object.keys(override).length > 0) overrides[id] = override;
    }
    const { live, ...rest } = v;
    return {
      ...rest,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
      ...(live ? { live } : {}),
    };
  });
  return Object.keys(versionItems).length > 0
    ? { versions: stored, versionItems }
    : { versions: stored };
}
