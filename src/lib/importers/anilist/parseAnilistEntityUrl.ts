import type { Item, ItemId, ItemSource } from '../../types';
import {
  ANILIST_ENTITY_PATH,
  ANILIST_SITE_ORIGIN,
  buildAnilistFavouriteUrl,
  buildAnilistMediaUrl,
} from './anilistSource';
import type { AnilistFavouriteType, AnilistMediaType } from './types';

/** Path segment → AniList entity kind (anime, character, staff, …). */
const ENTITY_PATH_TO_KIND: Record<string, AnilistMediaType | AnilistFavouriteType> =
  {
    [ANILIST_ENTITY_PATH.ANIME]: 'ANIME',
    [ANILIST_ENTITY_PATH.MANGA]: 'MANGA',
    [ANILIST_ENTITY_PATH.CHARACTERS]: 'CHARACTERS',
    [ANILIST_ENTITY_PATH.STAFF]: 'STAFF',
    [ANILIST_ENTITY_PATH.STUDIOS]: 'STUDIOS',
  };

export type ParsedAnilistEntity =
  | { kind: AnilistMediaType; externalId: number; canonicalUrl: string }
  | {
      kind: AnilistFavouriteType;
      externalId: number;
      canonicalUrl: string;
    };

/**
 * Normalise a CSV / paste URL value into an absolute `https://anilist.co/…`
 * form before parsing. Accepts `https://`, bare `anilist.co/…`, and
 * `www.anilist.co/…`.
 */
export function normalizeAnilistSiteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const bare = trimmed.replace(/^www\./i, '');
  if (/^anilist\.co\//i.test(bare)) {
    return `${ANILIST_SITE_ORIGIN}/${bare.slice('anilist.co/'.length)}`;
  }
  if (/^[\w.-]+\.[a-z]{2,}\//i.test(trimmed)) {
    return `https://${trimmed.replace(/^www\./i, '')}`;
  }
  return null;
}

/**
 * Parse a canonical AniList **entity** page URL (`/anime|manga|character|staff|studio/<id>`).
 * Search, user profile, OAuth, and GraphQL endpoints return `null` so import
 * enrichment never mis-tags a row.
 */
export function parseAnilistEntityUrl(url: string): ParsedAnilistEntity | null {
  const normalized = normalizeAnilistSiteUrl(url);
  if (!normalized) return null;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./i, '');
  if (host !== 'anilist.co') return null;

  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return null;

  const pathKind = segments[0]!.toLowerCase();
  const entityKind = ENTITY_PATH_TO_KIND[pathKind];
  if (!entityKind) return null;

  const id = Number.parseInt(segments[1]!, 10);
  if (!Number.isFinite(id) || id <= 0) return null;

  if (entityKind === 'ANIME' || entityKind === 'MANGA') {
    return {
      kind: entityKind,
      externalId: id,
      canonicalUrl: buildAnilistMediaUrl(entityKind, id),
    };
  }
  return {
    kind: entityKind,
    externalId: id,
    canonicalUrl: buildAnilistFavouriteUrl(entityKind, id),
  };
}

/** `Item.source` for a parsed entity. Studios have no source kind yet. */
export function itemSourceFromParsedAnilistEntity(
  parsed: ParsedAnilistEntity,
): ItemSource | undefined {
  switch (parsed.kind) {
    case 'ANIME':
    case 'MANGA':
      return { kind: 'anilist', externalId: parsed.externalId };
    case 'CHARACTERS':
      return { kind: 'anilist-character', externalId: parsed.externalId };
    case 'STAFF':
      return { kind: 'anilist-staff', externalId: parsed.externalId };
    case 'STUDIOS':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Stable item id for a parsed AniList entity — matches
 * {@link AnilistStartMode} materialisers (`anilist:21`, `anilist-character:300`, …).
 */
export function anilistItemIdFromParsedEntity(
  parsed: ParsedAnilistEntity,
): ItemId {
  if (parsed.kind === 'ANIME' || parsed.kind === 'MANGA') {
    return `anilist:${parsed.externalId}`;
  }
  if (parsed.kind === 'CHARACTERS') {
    return `anilist-character:${parsed.externalId}`;
  }
  if (parsed.kind === 'STAFF') {
    return `anilist-staff:${parsed.externalId}`;
  }
  return `anilist-studios:${parsed.externalId}`;
}

export interface EnrichItemFromAnilistUrlOptions {
  /**
   * When true, keep `item.id` even if the URL implies an AniList id.
   * Set for CSV rows with an explicit `idOverride` from the edit modal.
   */
  preserveId?: boolean;
  /**
   * Label-derived slug id (`canonicalKey(label)`). When provided, ids matching
   * this value may be rewritten to the AniList id scheme.
   */
  slugId?: ItemId;
}

/**
 * Attach AniList `source`, canonical `url`, and (when appropriate) a stable
 * `anilist:*` item id from `item.url`. No-op when the URL is not a recognised
 * entity page or when `item.source` is already set to a non-manual kind.
 */
export function enrichItemFromAnilistUrl(
  item: Item,
  options?: EnrichItemFromAnilistUrlOptions,
): Item {
  if (!item.url) return item;
  const parsed = parseAnilistEntityUrl(item.url);
  if (!parsed) return item;

  const kind = item.source?.kind;
  if (
    kind === 'anilist' ||
    kind === 'anilist-character' ||
    kind === 'anilist-staff'
  ) {
    return item;
  }

  const source = itemSourceFromParsedAnilistEntity(parsed);
  const next: Item = {
    ...item,
    url: parsed.canonicalUrl,
    ...(source !== undefined ? { source } : {}),
  };

  if (options?.preserveId) {
    return next;
  }

  const slugId = options?.slugId;
  const mayRewriteId =
    (slugId !== undefined && item.id === slugId) ||
    item.id.startsWith('anilist:') ||
    item.id.startsWith('anilist-');
  if (mayRewriteId) {
    next.id = anilistItemIdFromParsedEntity(parsed);
  }

  return next;
}
