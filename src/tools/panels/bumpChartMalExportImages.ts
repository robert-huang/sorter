import { executeAnilistQuery } from '../../lib/importers/anilist/transport';
import { foldJapaneseRomanization } from '../../lib/importers/anilist/themeSongs/themeSongMatching';
import type { Item } from '../../lib/types';

const JIKAN_BASE_URL = 'https://api.jikan.moe/v4';
const MAL_IMAGE_URL_CACHE_KEY = 'queue-sorter:bump-mal-export-image-urls:v1';
const JIKAN_REQUEST_INTERVAL_MS = import.meta.env.MODE === 'test' ? 0 : 1_050;
const MAX_LINKED_MEDIA_LOOKUPS = 6;
const MAX_JIKAN_RETRIES = 2;

type AnilistMediaType = 'ANIME' | 'MANGA';

type AnilistMediaRef = {
  id: number;
  idMal: number | null;
  type: AnilistMediaType;
};

type AnilistName = {
  full: string | null;
  native: string | null;
  alternative?: string[] | null;
  alternativeSpoiler?: string[] | null;
};

type JikanImages = {
  jpg?: { image_url?: string | null };
  webp?: { image_url?: string | null };
};

type JikanEntity = {
  mal_id: number;
  name?: string;
  name_kanji?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  alternate_names?: string[] | null;
  images?: JikanImages;
};

type JikanCharacterCredit = {
  character: JikanEntity;
};

type JikanPersonFull = JikanEntity & {
  voices?: Array<{
    anime?: { mal_id?: number };
    character?: { name?: string };
  }>;
  anime?: Array<{ anime?: { mal_id?: number } }>;
  manga?: Array<{ manga?: { mal_id?: number } }>;
};

type CharacterMetadataResponse = {
  Character: {
    name: AnilistName;
    media: { nodes: AnilistMediaRef[] };
  } | null;
};

type StaffMetadataResponse = {
  Staff: {
    name: AnilistName;
    characterMedia: {
      edges: Array<{
        node: AnilistMediaRef;
        characters: Array<{ name: AnilistName }>;
      }>;
    };
    staffMedia: {
      edges: Array<{ node: AnilistMediaRef }>;
    };
  } | null;
};

type MediaMetadataResponse = {
  Media: AnilistMediaRef | null;
};

export type BumpMalExportImage = {
  url: string;
  cacheKey: string;
};

const pendingResolutions = new Map<
  string,
  Promise<BumpMalExportImage | null>
>();
const sessionMisses = new Set<string>();
let persistedUrlCache: Record<string, string> | null = null;
let jikanQueueTail: Promise<unknown> = Promise.resolve();
let lastJikanRequestAt = 0;

function entityCacheKey(item: Item): string | null {
  const source = item.source;
  if (
    !source ||
    (source.kind !== 'anilist' &&
      source.kind !== 'anilist-character' &&
      source.kind !== 'anilist-staff')
  ) {
    return null;
  }
  return `${source.kind}:${source.externalId}`;
}

function imageCacheRequestKey(entityKey: string): string {
  return `https://queue-sorter.invalid/bump-mal-export/v1/${encodeURIComponent(entityKey)}`;
}

function loadPersistedUrlCache(): Record<string, string> {
  if (persistedUrlCache) {
    return persistedUrlCache;
  }
  try {
    const parsed = JSON.parse(
      localStorage.getItem(MAL_IMAGE_URL_CACHE_KEY) ?? '{}',
    ) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      persistedUrlCache = Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === 'string' && isMalImageUrl(entry[1]),
        ),
      );
      return persistedUrlCache;
    }
  } catch {
    // Fall through to an empty cache.
  }
  persistedUrlCache = {};
  return persistedUrlCache;
}

function persistResolvedUrl(entityKey: string, url: string): void {
  const cache = loadPersistedUrlCache();
  cache[entityKey] = url;
  try {
    localStorage.setItem(MAL_IMAGE_URL_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // The in-memory mapping still prevents repeated matching this session.
  }
}

function isMalImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' && parsed.hostname === 'cdn.myanimelist.net'
    );
  } catch {
    return false;
  }
}

export function isAnilistCdnImageUrl(url: string): boolean {
  try {
    return new URL(url).hostname === 's4.anilist.co';
  } catch {
    return false;
  }
}

function preferredImageUrl(
  entity: JikanEntity | null | undefined,
): string | null {
  const url =
    entity?.images?.jpg?.image_url ?? entity?.images?.webp?.image_url ?? null;
  return url && isMalImageUrl(url) ? url : null;
}

function normalizeName(value: string): string {
  return foldJapaneseRomanization(value.normalize('NFKC'))
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameKeys(value: string): string[] {
  const normalized = normalizeName(value);
  if (!normalized) {
    return [];
  }
  const tokens = normalized.split(' ');
  return tokens.length > 1
    ? [normalized, [...tokens].sort().join(' ')]
    : [normalized];
}

function namesMatch(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftKeys = new Set(left.flatMap(nameKeys));
  return right.some((name) => nameKeys(name).some((key) => leftKeys.has(key)));
}

function anilistNames(item: Item, metadataName?: AnilistName | null): string[] {
  const values: Array<string | null | undefined> = [
    item.label,
    ...(item.searchTokens ?? []),
    metadataName?.full,
    metadataName?.native,
    ...(metadataName?.alternative ?? []),
    ...(metadataName?.alternativeSpoiler ?? []),
  ];
  const labelSource = item.anilistLabelSource;
  if (labelSource?.kind === 'person' || labelSource?.kind === 'character') {
    values.push(
      labelSource.nameFields.name_full,
      labelSource.nameFields.name_native,
    );
  }
  return values.filter(
    (value, index, all): value is string =>
      typeof value === 'string' &&
      value.trim().length > 0 &&
      all.indexOf(value) === index,
  );
}

function metadataNames(name: AnilistName): string[] {
  return [
    name.full,
    name.native,
    ...(name.alternative ?? []),
    ...(name.alternativeSpoiler ?? []),
  ].filter((value): value is string => Boolean(value?.trim()));
}

function jikanEntityNames(entity: JikanEntity): string[] {
  const combined =
    entity.given_name && entity.family_name
      ? [
          `${entity.given_name} ${entity.family_name}`,
          `${entity.family_name} ${entity.given_name}`,
        ]
      : [];
  return [
    entity.name,
    entity.name_kanji,
    ...(entity.alternate_names ?? []),
    ...combined,
  ].filter((value): value is string => Boolean(value?.trim()));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function runJikanRequest<T>(path: string): Promise<T | null> {
  for (let attempt = 0; attempt <= MAX_JIKAN_RETRIES; attempt += 1) {
    const delay = Math.max(
      0,
      lastJikanRequestAt + JIKAN_REQUEST_INTERVAL_MS - Date.now(),
    );
    if (delay > 0) {
      await wait(delay);
    }
    lastJikanRequestAt = Date.now();

    let response: Response;
    try {
      response = await fetch(`${JIKAN_BASE_URL}${path}`, {
        headers: { Accept: 'application/json' },
      });
    } catch {
      return null;
    }
    if (response.status === 429 && attempt < MAX_JIKAN_RETRIES) {
      const retryAfterSeconds = Number(response.headers.get('Retry-After'));
      await wait(
        Number.isFinite(retryAfterSeconds)
          ? (retryAfterSeconds + 1) * 1_000
          : (attempt + 1) * 2_000,
      );
      continue;
    }
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  }
  return null;
}

function fetchJikan<T>(path: string): Promise<T | null> {
  const result = jikanQueueTail.then(
    () => runJikanRequest<T>(path),
    () => runJikanRequest<T>(path),
  );
  jikanQueueTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function uniqueLinkedMedia(
  refs: readonly AnilistMediaRef[],
): AnilistMediaRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (!Number.isInteger(ref.idMal) || (ref.idMal ?? 0) <= 0) {
      return false;
    }
    const key = `${ref.type}:${ref.idMal}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function resolveMediaImage(item: Item): Promise<string | null> {
  if (item.source?.kind !== 'anilist') {
    return null;
  }
  const metadata = await executeAnilistQuery<MediaMetadataResponse>(
    `query BumpMalMedia($id: Int!) {
      Media(id: $id) { id idMal type }
    }`,
    { id: item.source.externalId },
  );
  const media = metadata?.Media;
  if (!media?.idMal) {
    return null;
  }
  const typePath = media.type === 'MANGA' ? 'manga' : 'anime';
  const response = await fetchJikan<{ data?: JikanEntity }>(
    `/${typePath}/${media.idMal}`,
  );
  return preferredImageUrl(response?.data);
}

async function resolveCharacterImage(item: Item): Promise<string | null> {
  if (item.source?.kind !== 'anilist-character') {
    return null;
  }
  const metadata = await executeAnilistQuery<CharacterMetadataResponse>(
    `query BumpMalCharacter($id: Int!) {
      Character(id: $id) {
        name { full native alternative alternativeSpoiler }
        media(page: 1, perPage: 25, sort: [POPULARITY_DESC]) {
          nodes { id idMal type }
        }
      }
    }`,
    { id: item.source.externalId },
  );
  const character = metadata?.Character;
  if (!character) {
    return null;
  }

  const sourceNames = anilistNames(item, character.name);
  const matches = new Map<number, string>();
  const linkedMedia = uniqueLinkedMedia(character.media.nodes).slice(
    0,
    MAX_LINKED_MEDIA_LOOKUPS,
  );
  for (const media of linkedMedia) {
    const typePath = media.type === 'MANGA' ? 'manga' : 'anime';
    const response = await fetchJikan<{ data?: JikanCharacterCredit[] }>(
      `/${typePath}/${media.idMal}/characters`,
    );
    for (const credit of response?.data ?? []) {
      if (namesMatch(sourceNames, jikanEntityNames(credit.character))) {
        const imageUrl = preferredImageUrl(credit.character);
        if (imageUrl) {
          matches.set(credit.character.mal_id, imageUrl);
        }
      }
    }
  }
  return matches.size === 1 ? [...matches.values()][0]! : null;
}

function staffCandidateMatchesCredit(
  candidate: JikanPersonFull,
  voiceLinks: ReadonlyMap<number, readonly string[]>,
  animeStaffIds: ReadonlySet<number>,
  mangaStaffIds: ReadonlySet<number>,
): boolean {
  const voiceMatch = (candidate.voices ?? []).some((credit) => {
    const animeId = credit.anime?.mal_id;
    const characterName = credit.character?.name;
    const linkedNames = animeId == null ? undefined : voiceLinks.get(animeId);
    return (
      linkedNames != null &&
      characterName != null &&
      namesMatch(linkedNames, [characterName])
    );
  });
  const animeStaffMatch = (candidate.anime ?? []).some((credit) => {
    const id = credit.anime?.mal_id;
    return id != null && animeStaffIds.has(id);
  });
  const mangaStaffMatch = (candidate.manga ?? []).some((credit) => {
    const id = credit.manga?.mal_id;
    return id != null && mangaStaffIds.has(id);
  });
  return voiceLinks.size > 0 ? voiceMatch : animeStaffMatch || mangaStaffMatch;
}

async function resolveStaffImage(item: Item): Promise<string | null> {
  if (item.source?.kind !== 'anilist-staff') {
    return null;
  }
  const metadata = await executeAnilistQuery<StaffMetadataResponse>(
    `query BumpMalStaff($id: Int!) {
      Staff(id: $id) {
        name { full native alternative }
        characterMedia(page: 1, perPage: 25, sort: [POPULARITY_DESC]) {
          edges {
            node { id idMal type }
            characters {
              id
              name { full native alternative alternativeSpoiler }
            }
          }
        }
        staffMedia(page: 1, perPage: 25, sort: [POPULARITY_DESC]) {
          edges {
            node { id idMal type }
          }
        }
      }
    }`,
    { id: item.source.externalId },
  );
  const staff = metadata?.Staff;
  if (!staff) {
    return null;
  }

  const sourceNames = anilistNames(item, staff.name);
  const voiceLinks = new Map<number, string[]>();
  for (const edge of staff.characterMedia.edges) {
    if (edge.node.type !== 'ANIME' || !edge.node.idMal) {
      continue;
    }
    const names = edge.characters.flatMap((character) =>
      metadataNames(character.name),
    );
    voiceLinks.set(edge.node.idMal, [
      ...(voiceLinks.get(edge.node.idMal) ?? []),
      ...names,
    ]);
  }
  const animeStaffIds = new Set<number>();
  const mangaStaffIds = new Set<number>();
  for (const edge of staff.staffMedia.edges) {
    if (!edge.node.idMal) {
      continue;
    }
    (edge.node.type === 'MANGA' ? mangaStaffIds : animeStaffIds).add(
      edge.node.idMal,
    );
  }
  if (
    voiceLinks.size === 0 &&
    animeStaffIds.size === 0 &&
    mangaStaffIds.size === 0
  ) {
    return null;
  }

  const candidates = new Map<number, JikanEntity>();
  for (const queryName of sourceNames.slice(0, 2)) {
    const response = await fetchJikan<{ data?: JikanEntity[] }>(
      `/people?q=${encodeURIComponent(queryName)}&limit=10`,
    );
    for (const candidate of response?.data ?? []) {
      if (namesMatch(sourceNames, jikanEntityNames(candidate))) {
        candidates.set(candidate.mal_id, candidate);
      }
    }
  }

  const verified = new Map<number, string>();
  for (const candidate of candidates.values()) {
    const response = await fetchJikan<{ data?: JikanPersonFull }>(
      `/people/${candidate.mal_id}/full`,
    );
    const person = response?.data;
    if (
      person &&
      namesMatch(sourceNames, jikanEntityNames(person)) &&
      staffCandidateMatchesCredit(
        person,
        voiceLinks,
        animeStaffIds,
        mangaStaffIds,
      )
    ) {
      const imageUrl =
        preferredImageUrl(person) ?? preferredImageUrl(candidate);
      if (imageUrl) {
        verified.set(person.mal_id, imageUrl);
      }
    }
  }
  return verified.size === 1 ? [...verified.values()][0]! : null;
}

async function resolveUncached(item: Item): Promise<string | null> {
  switch (item.source?.kind) {
    case 'anilist':
      return resolveMediaImage(item);
    case 'anilist-character':
      return resolveCharacterImage(item);
    case 'anilist-staff':
      return resolveStaffImage(item);
    default:
      return null;
  }
}

export async function resolveBumpMalExportImage(
  item: Item,
): Promise<BumpMalExportImage | null> {
  const entityKey = entityCacheKey(item);
  if (!entityKey || sessionMisses.has(entityKey)) {
    return null;
  }
  const persistedUrl = loadPersistedUrlCache()[entityKey];
  if (persistedUrl && isMalImageUrl(persistedUrl)) {
    return {
      url: persistedUrl,
      cacheKey: imageCacheRequestKey(entityKey),
    };
  }

  const pending = pendingResolutions.get(entityKey);
  if (pending) {
    return pending;
  }
  const resolution = resolveUncached(item)
    .then((url): BumpMalExportImage | null => {
      if (!url) {
        sessionMisses.add(entityKey);
        return null;
      }
      persistResolvedUrl(entityKey, url);
      return { url, cacheKey: imageCacheRequestKey(entityKey) };
    })
    .catch(() => {
      sessionMisses.add(entityKey);
      return null;
    })
    .finally(() => {
      pendingResolutions.delete(entityKey);
    });
  pendingResolutions.set(entityKey, resolution);
  return resolution;
}

export function _resetBumpMalExportImagesForTesting(): void {
  pendingResolutions.clear();
  sessionMisses.clear();
  persistedUrlCache = null;
  jikanQueueTail = Promise.resolve();
  lastJikanRequestAt = 0;
}
