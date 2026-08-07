import type { Item } from '../../types';
import { updateItemMetadata } from '../../engine';
import {
  buildAnilistFavouriteUrl,
  buildAnilistMediaUrl,
} from './anilistSource';
import {
  mediaLabelSourceFromRow,
  resolveAnilistItemLabel,
} from './anilistItemLabel';
import {
  formatMediaDisplayLabel,
  mediaTitleSearchParts,
} from './mediaDisplayLabel';
import {
  characterNameSearchParts,
  personNameSearchParts,
  pickCharacterName,
  pickPersonName,
} from './personDisplayLabel';
import {
  productionReads,
  type FavouriteAsItem,
} from './readQueries';
import type {
  AnilistFavouriteType,
  AnilistMediaType,
  CharacterRow,
  MediaRow,
  StaffRow,
} from './types';

const ANILIST_FORMAT_IN_LABEL_LS_KEY = 'anilist:includeFormatInLabel';

export function readIncludeFormatInLabel(): boolean {
  try {
    return localStorage.getItem(ANILIST_FORMAT_IN_LABEL_LS_KEY) === '1';
  } catch {
    return false;
  }
}

export function mediaRowToItem(
  media: MediaRow,
  includeFormatInLabel: boolean,
): Item {
  return {
    id: `anilist:${media.id}`,
    label: formatMediaDisplayLabel(
      media,
      media.format,
      includeFormatInLabel,
    ),
    searchTokens: mediaTitleSearchParts(media),
    anilistLabelSource: mediaLabelSourceFromRow(media),
    url: buildAnilistMediaUrl(media.type, media.id),
    imageUrl: media.cover_image ?? undefined,
    source: { kind: 'anilist', externalId: media.id },
  };
}

function favouriteMediaLabel(
  favourite: FavouriteAsItem,
  includeFormatInLabel: boolean,
): string {
  if (favourite.anilistLabelSource?.kind === 'media') {
    return resolveAnilistItemLabel(
      favourite.anilistLabelSource,
      includeFormatInLabel,
    );
  }
  if (!includeFormatInLabel || !favourite.format) {
    return favourite.label;
  }
  return `${favourite.label} (${favourite.format})`;
}

export function favouriteAsItemToItem(
  favourite: FavouriteAsItem,
  type: AnilistFavouriteType,
  includeFormatInLabel: boolean,
): Item {
  const url = buildAnilistFavouriteUrl(type, favourite.externalId);
  if (type === 'ANIME' || type === 'MANGA') {
    return {
      id: `anilist:${favourite.externalId}`,
      label: favouriteMediaLabel(favourite, includeFormatInLabel),
      url,
      imageUrl: favourite.imageUrl ?? undefined,
      source: { kind: 'anilist', externalId: favourite.externalId },
      searchTokens: favourite.searchTokens,
      anilistLabelSource: favourite.anilistLabelSource,
    };
  }
  if (type === 'CHARACTERS') {
    return {
      id: `anilist-character:${favourite.externalId}`,
      label: favourite.anilistLabelSource
        ? resolveAnilistItemLabel(favourite.anilistLabelSource, false)
        : favourite.label,
      url,
      imageUrl: favourite.imageUrl ?? undefined,
      source: {
        kind: 'anilist-character',
        externalId: favourite.externalId,
      },
      searchTokens: favourite.searchTokens,
      anilistLabelSource: favourite.anilistLabelSource,
    };
  }
  if (type === 'STAFF') {
    return {
      id: `anilist-staff:${favourite.externalId}`,
      label: favourite.anilistLabelSource
        ? resolveAnilistItemLabel(favourite.anilistLabelSource, false)
        : favourite.label,
      url,
      imageUrl: favourite.imageUrl ?? undefined,
      source: { kind: 'anilist-staff', externalId: favourite.externalId },
      searchTokens: favourite.searchTokens,
      anilistLabelSource: favourite.anilistLabelSource,
    };
  }
  return {
    id: `anilist-studios:${favourite.externalId}`,
    label: favourite.label,
    url,
    imageUrl: favourite.imageUrl ?? undefined,
    searchTokens: favourite.searchTokens,
    anilistLabelSource: favourite.anilistLabelSource,
  };
}

export type CachedAnilistSource =
  | {
      kind: 'list';
      userId: number;
      userName: string;
      type: AnilistMediaType;
    }
  | {
      kind: 'favourites';
      userId: number;
      userName: string;
      type: AnilistFavouriteType;
    };

export function cachedAnilistSourceKey(source: CachedAnilistSource): string {
  return `${source.kind}:${source.userId}:${source.type}`;
}

export function cachedAnilistSourceTypeLabel(
  source: CachedAnilistSource,
): string {
  return source.kind === 'list'
    ? `${source.type.toLowerCase()} list`
    : `${source.type.toLowerCase()} favourites`;
}

export interface CachedAnilistSourceSummary {
  source: CachedAnilistSource;
  count: number;
  refreshedAt: number | null;
}

export function cachedAnilistSourcesForUsername(
  sources: readonly CachedAnilistSourceSummary[],
  username: string,
): CachedAnilistSourceSummary[] {
  const normalizedUsername = username.trim().toLowerCase();
  if (!normalizedUsername) return [];
  return sources.filter(
    ({ source }) => source.userName.toLowerCase() === normalizedUsername,
  );
}

export async function listCachedAnilistSources(): Promise<
  CachedAnilistSourceSummary[]
> {
  const users = await productionReads.getCachedAnilistUsers();
  const summaries: CachedAnilistSourceSummary[] = [];
  const favouriteTypes: AnilistFavouriteType[] = [
    'ANIME',
    'MANGA',
    'CHARACTERS',
    'STAFF',
    'STUDIOS',
  ];
  for (const user of users) {
    const listTypes: AnilistMediaType[] = ['ANIME', 'MANGA'];
    const [listCounts, listRefreshes, favouriteRows, favouriteRefreshes] =
      await Promise.all([
        Promise.all(
          listTypes.map((type) =>
            productionReads.getListedMediaCount(user.id, type),
          ),
        ),
        Promise.all(
          listTypes.map((type) =>
            productionReads.getLastFullRefresh(user.id, type),
          ),
        ),
        Promise.all(
          favouriteTypes.map((type) =>
            productionReads.getFavouritesAsItems(user.id, type),
          ),
        ),
        Promise.all(
          favouriteTypes.map((type) =>
            productionReads.getLastFavouritesRefresh(user.id, type),
          ),
        ),
      ]);
    listTypes.forEach((type, index) => {
      const count = listCounts[index] ?? 0;
      const refreshedAt = listRefreshes[index] ?? null;
      if (count <= 0 && refreshedAt === null) return;
      summaries.push({
        source: { kind: 'list', userId: user.id, userName: user.name, type },
        count,
        refreshedAt,
      });
    });
    favouriteRows.forEach((rows, index) => {
      const type = favouriteTypes[index];
      if (!type) return;
      const refreshedAt = favouriteRefreshes[index] ?? null;
      if (rows.length === 0 && refreshedAt === null) return;
      summaries.push({
        source: {
          kind: 'favourites',
          userId: user.id,
          userName: user.name,
          type,
        },
        count: rows.length,
        refreshedAt,
      });
    });
  }
  return summaries;
}

export async function materializeCachedAnilistSource(
  source: CachedAnilistSource,
  includeFormatInLabel = readIncludeFormatInLabel(),
): Promise<Item[]> {
  if (source.kind === 'list') {
    const rows = await productionReads.getListedMedia(
      source.userId,
      source.type,
    );
    return rows.map((row) => mediaRowToItem(row, includeFormatInLabel));
  }
  const rows = await productionReads.getFavouritesAsItems(
    source.userId,
    source.type,
  );
  return rows.map((row) =>
    favouriteAsItemToItem(row, source.type, includeFormatInLabel),
  );
}

export type ParsedCanonicalAnilistItemId =
  | { kind: 'media'; externalId: number }
  | { kind: 'character'; externalId: number }
  | { kind: 'staff'; externalId: number };

export function parseCanonicalAnilistItemId(
  value: string,
): ParsedCanonicalAnilistItemId | null {
  const match = /^(anilist|anilist-character|anilist-staff):([1-9]\d*)$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const externalId = Number(match[2]);
  if (!Number.isSafeInteger(externalId)) return null;
  if (match[1] === 'anilist') return { kind: 'media', externalId };
  if (match[1] === 'anilist-character') {
    return { kind: 'character', externalId };
  }
  return { kind: 'staff', externalId };
}

export async function resolveCachedAnilistItemId(
  value: string,
  includeFormatInLabel = readIncludeFormatInLabel(),
): Promise<Item | null> {
  const parsed = parseCanonicalAnilistItemId(value);
  if (!parsed) return null;
  if (parsed.kind === 'media') {
    const rows = await productionReads.getMediaByIds([parsed.externalId]);
    const row = rows[0];
    return row ? mediaRowToItem(row, includeFormatInLabel) : null;
  }
  const type: AnilistFavouriteType =
    parsed.kind === 'character' ? 'CHARACTERS' : 'STAFF';
  const rows =
    parsed.kind === 'character'
      ? await productionReads.getCharactersByIds([parsed.externalId])
      : await productionReads.getStaffByIds([parsed.externalId]);
  const row = rows[0];
  if (!row) return null;
  if (parsed.kind === 'character') {
    const character = row as CharacterRow;
    const nameFields = {
      id: character.id,
      name_full: character.name_full,
      name_native: character.name_native,
    };
    const enriched: FavouriteAsItem = {
      externalId: character.id,
      label: pickCharacterName(nameFields, undefined, 'Character'),
      imageUrl: character.image,
      searchTokens: characterNameSearchParts(character),
      anilistLabelSource: {
        kind: 'character',
        nameFields,
        fallbackLabel: 'Character',
      },
    };
    return favouriteAsItemToItem(
      enriched,
      type,
      includeFormatInLabel,
    );
  }
  const staff = row as StaffRow;
  const nameFields = {
    id: staff.id,
    name_full: staff.name_full,
    name_native: staff.name_native,
  };
  const enriched: FavouriteAsItem = {
    externalId: staff.id,
    label: pickPersonName(nameFields, undefined, 'Staff'),
    imageUrl: staff.image,
    searchTokens: personNameSearchParts(nameFields),
    anilistLabelSource: {
      kind: 'person',
      nameFields,
      fallbackLabel: 'Staff',
    },
  };
  return favouriteAsItemToItem(
    enriched,
    type,
    includeFormatInLabel,
  );
}

export interface CachedItemEditPatch {
  label?: string;
  url?: string;
  imageUrl?: string;
  id?: string;
  useAutomaticAnilistLabel?: boolean;
  hydratedItem?: Item;
}

/** Apply explicit edits over a cache-hydrated base; untouched fields adopt cache data. */
export function applyCachedAnilistItemEdit(
  original: Item,
  patch: CachedItemEditPatch,
): Item {
  const base = patch.hydratedItem ?? original;
  const updated = updateItemMetadata(base, {
    label: patch.label,
    url: patch.url,
    imageUrl: patch.imageUrl,
    useAutomaticAnilistLabel: patch.useAutomaticAnilistLabel,
  });
  return patch.id && patch.id !== updated.id
    ? { ...updated, id: patch.id }
    : updated;
}
