import { executeAnilistQuery } from '../../lib/importers/anilist/transport';
import { fetchMalOfficialJson } from '../../lib/importers/anilist/themeSongs/malOfficialApi';
import { foldJapaneseRomanization } from '../../lib/importers/anilist/themeSongs/themeSongMatching';
import {
  clearDisposableCacheNamespace,
  deleteDisposableCacheEntry,
  getDisposableCacheStats,
  listDisposableCacheEntries,
  putDisposableCache,
} from '../../lib/disposableCacheDb';
import { registerDisposableCacheOwner } from '../../lib/disposableCacheRegistry';
import type { Item } from '../../lib/types';

const TENRAI_BASE_URL = 'https://api.tenrai.org/v1';
const MAL_IMAGE_URL_CACHE_KEY = 'queue-sorter:bump-mal-export-image-urls:v1';
const MAL_IMAGE_URL_CACHE_NAMESPACE = 'bump-image-urls';
const TENRAI_REQUEST_INTERVAL_MS = import.meta.env.MODE === 'test' ? 0 : 1_050;
const MAX_LINKED_MEDIA_LOOKUPS = 6;
const MAX_TENRAI_RETRIES = 2;

type AnilistMediaType = 'ANIME' | 'MANGA';

type AnilistMediaRef = {
  id: number;
  idMal: number | null;
  type: AnilistMediaType;
};

type LinkedMalMediaRef = AnilistMediaRef & {
  idMal: number;
};

type AnilistName = {
  full: string | null;
  native: string | null;
  alternative?: string[] | null;
  alternativeSpoiler?: string[] | null;
};

type TenraiImages = {
  jpg?: { image_url?: string | null };
  webp?: { image_url?: string | null };
};

type TenraiEntity = {
  mal_id: number;
  name?: string;
  name_kanji?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  alternate_names?: string[] | null;
  images?: TenraiImages;
};

type TenraiCharacterCredit = {
  character: TenraiEntity;
};

type TenraiFetchResult<T> = {
  data: T | null;
  status: number | null;
};

type TenraiPersonFull = TenraiEntity & {
  voices?: Array<{
    anime?: { mal_id?: number };
    character?: { name?: string };
  }>;
  anime?: Array<{ anime?: { mal_id?: number } }>;
  manga?: Array<{ manga?: { mal_id?: number } }>;
};

type MalMainPicture = {
  medium?: string | null;
  large?: string | null;
};

type MalMediaResponse = {
  main_picture?: MalMainPicture | null;
};

type MalCharacterNode = {
  id: number;
  first_name?: string | null;
  last_name?: string | null;
  alternative_name?: string | null;
  main_picture?: MalMainPicture | null;
};

type MalCharactersResponse = {
  data?: Array<{ node: MalCharacterNode }>;
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
        characters: Array<{ name: AnilistName } | null>;
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
  matchKind: 'exact' | 'fuzzy';
};

type ResolvedMalImage = Pick<BumpMalExportImage, 'url' | 'matchKind'>;

type PendingResolution = {
  forceRefresh: boolean;
  promise: Promise<BumpMalExportImage | null>;
};

const pendingResolutions = new Map<string, PendingResolution>();
let persistedUrlCache: Map<string, ResolvedMalImage> | null = null;
let urlCacheInitialization: Promise<Map<string, ResolvedMalImage>> | null = null;
let urlCacheGeneration = 0;
let tenraiQueueTail: Promise<unknown> = Promise.resolve();
let lastTenraiRequestAt = 0;

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

async function migrateLegacyUrlCache(): Promise<void> {
  if (typeof localStorage === 'undefined') {
    return;
  }
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(MAL_IMAGE_URL_CACHE_KEY);
    if (!raw) {
      return;
    }
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return;
  }
  const mappings = Object.entries(parsed).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === 'string' && isMalImageUrl(entry[1]),
  );
  let migratedAll = true;
  for (const [entityKey, url] of mappings) {
    const persisted = await putDisposableCache(
      MAL_IMAGE_URL_CACHE_NAMESPACE,
      entityKey,
      { url, matchKind: 'exact' } satisfies ResolvedMalImage,
    );
    migratedAll = migratedAll && persisted;
  }
  if (migratedAll) {
    try {
      localStorage.removeItem(MAL_IMAGE_URL_CACHE_KEY);
    } catch {
      // A duplicate legacy map is harmless and retried next session.
    }
  }
}

function cachedImage(value: unknown): ResolvedMalImage | null {
  if (typeof value === 'string') {
    return isMalImageUrl(value) ? { url: value, matchKind: 'exact' } : null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Partial<ResolvedMalImage>;
  return typeof candidate.url === 'string' &&
    isMalImageUrl(candidate.url) &&
    (candidate.matchKind === 'exact' || candidate.matchKind === 'fuzzy')
    ? { url: candidate.url, matchKind: candidate.matchKind }
    : null;
}

async function loadPersistedUrlCache(): Promise<Map<string, ResolvedMalImage>> {
  if (persistedUrlCache) {
    return persistedUrlCache;
  }
  if (!urlCacheInitialization) {
    urlCacheInitialization = (async () => {
      await migrateLegacyUrlCache();
      const entries = await listDisposableCacheEntries<unknown>(
        MAL_IMAGE_URL_CACHE_NAMESPACE,
      );
      const mappings: Array<[string, ResolvedMalImage]> = [];
      for (const entry of entries) {
        const image = cachedImage(entry.value);
        if (image) {
          mappings.push([entry.key, image]);
        }
      }
      return new Map(mappings);
    })();
  }
  persistedUrlCache = await urlCacheInitialization;
  return persistedUrlCache;
}

async function persistResolvedUrl(
  entityKey: string,
  image: ResolvedMalImage,
  generation: number,
): Promise<void> {
  const cache = await loadPersistedUrlCache();
  if (generation !== urlCacheGeneration) {
    return;
  }
  cache.set(entityKey, image);
  await putDisposableCache(MAL_IMAGE_URL_CACHE_NAMESPACE, entityKey, image);
  if (generation !== urlCacheGeneration) {
    cache.delete(entityKey);
    await deleteDisposableCacheEntry(MAL_IMAGE_URL_CACHE_NAMESPACE, entityKey);
  }
}

async function invalidateResolvedUrl(entityKey: string): Promise<void> {
  const cache = await loadPersistedUrlCache();
  cache.delete(entityKey);
  await deleteDisposableCacheEntry(MAL_IMAGE_URL_CACHE_NAMESPACE, entityKey);
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
  entity: TenraiEntity | null | undefined,
): string | null {
  const url =
    entity?.images?.jpg?.image_url ?? entity?.images?.webp?.image_url ?? null;
  return url && isMalImageUrl(url) ? url : null;
}

function malPictureUrl(
  picture: MalMainPicture | null | undefined,
): string | null {
  const url = picture?.large?.trim() || picture?.medium?.trim() || null;
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

const FUZZY_NAME_MIN_SCORE = 0.82;
const FUZZY_TOKEN_MIN_SCORE = 0.5;
const FUZZY_CANDIDATE_MARGIN = 0.08;

// Linked casts provide the identity gate; token anchors and a winner margin
// prevent broad spelling similarity from selecting unrelated cast members.
function nameTokens(value: string): string[] {
  return [
    ...new Set(
      normalizeName(value)
        .split(' ')
        .filter((token) => token.length > 1),
    ),
  ].sort();
}

function levenshteinDistance(left: string, right: string): number {
  let previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

function tokenSimilarity(left: string, right: string): number {
  const longest = Math.max(left.length, right.length);
  return longest === 0
    ? 1
    : 1 - levenshteinDistance(left, right) / longest;
}

function exactTokenSubsetScore(
  leftTokens: readonly string[],
  rightTokens: readonly string[],
): number | null {
  const [shorter, longer] =
    leftTokens.length <= rightTokens.length
      ? [leftTokens, rightTokens]
      : [rightTokens, leftTokens];
  if (
    shorter.length < 2 ||
    !shorter.every((token) => longer.includes(token))
  ) {
    return null;
  }
  return 0.96 - Math.min(0.08, (longer.length - shorter.length) * 0.02);
}

function sameLengthFuzzyScore(
  leftTokens: readonly string[],
  rightTokens: readonly string[],
): number | null {
  if (leftTokens.length < 2 || leftTokens.length !== rightTokens.length) {
    return null;
  }
  const remainingLeft = [...leftTokens];
  const remainingRight = [...rightTokens];
  let exactCount = 0;
  let score = 0;

  for (let index = remainingLeft.length - 1; index >= 0; index -= 1) {
    const rightIndex = remainingRight.indexOf(remainingLeft[index]!);
    if (rightIndex < 0) {
      continue;
    }
    exactCount += 1;
    score += 1;
    remainingLeft.splice(index, 1);
    remainingRight.splice(rightIndex, 1);
  }
  if (exactCount === 0) {
    return null;
  }

  while (remainingLeft.length > 0) {
    let bestLeftIndex = 0;
    let bestRightIndex = 0;
    let bestScore = -1;
    for (let leftIndex = 0; leftIndex < remainingLeft.length; leftIndex += 1) {
      for (
        let rightIndex = 0;
        rightIndex < remainingRight.length;
        rightIndex += 1
      ) {
        const candidateScore = tokenSimilarity(
          remainingLeft[leftIndex]!,
          remainingRight[rightIndex]!,
        );
        if (candidateScore > bestScore) {
          bestLeftIndex = leftIndex;
          bestRightIndex = rightIndex;
          bestScore = candidateScore;
        }
      }
    }
    if (bestScore < FUZZY_TOKEN_MIN_SCORE) {
      return null;
    }
    score += bestScore;
    remainingLeft.splice(bestLeftIndex, 1);
    remainingRight.splice(bestRightIndex, 1);
  }

  const average = score / leftTokens.length;
  return average >= FUZZY_NAME_MIN_SCORE ? average : null;
}

function fuzzyNameScore(left: string, right: string): number | null {
  const leftTokens = nameTokens(left);
  const rightTokens = nameTokens(right);
  return (
    exactTokenSubsetScore(leftTokens, rightTokens) ??
    sameLengthFuzzyScore(leftTokens, rightTokens)
  );
}

function bestFuzzyNameScore(
  sourceNames: readonly string[],
  candidateNames: readonly string[],
): number | null {
  let best: number | null = null;
  for (const sourceName of sourceNames) {
    for (const candidateName of candidateNames) {
      const score = fuzzyNameScore(sourceName, candidateName);
      if (score != null && (best == null || score > best)) {
        best = score;
      }
    }
  }
  return best;
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

type CharacterSourceNames = {
  canonical: string[];
  aliases: string[];
};

function characterSourceNames(
  item: Item,
  metadataName: AnilistName,
): CharacterSourceNames {
  const labelSource = item.anilistLabelSource;
  const canonical = [
    metadataName.full,
    metadataName.native,
    ...(labelSource?.kind === 'character'
      ? [
          labelSource.nameFields.name_full,
          labelSource.nameFields.name_native,
        ]
      : []),
  ].filter(
    (value, index, all): value is string =>
      typeof value === 'string' &&
      value.trim().length > 0 &&
      all.indexOf(value) === index,
  );
  const canonicalKeys = new Set(canonical.flatMap(nameKeys));
  const aliases = anilistNames(item, metadataName).filter(
    (name) => !nameKeys(name).some((key) => canonicalKeys.has(key)),
  );
  return { canonical, aliases };
}

function metadataNames(name: AnilistName): string[] {
  return [
    name.full,
    name.native,
    ...(name.alternative ?? []),
    ...(name.alternativeSpoiler ?? []),
  ].filter((value): value is string => Boolean(value?.trim()));
}

function tenraiEntityNames(entity: TenraiEntity): string[] {
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

function malCharacterNames(character: MalCharacterNode): string[] {
  const first = character.first_name?.trim() ?? '';
  const last = character.last_name?.trim() ?? '';
  const alternatives =
    character.alternative_name
      ?.split(/[,;/]/)
      .map((name) => name.trim())
      .filter(Boolean) ?? [];
  return [
    `${first} ${last}`.trim(),
    `${last} ${first}`.trim(),
    ...alternatives,
  ].filter(Boolean);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function runTenraiRequest<T>(
  path: string,
): Promise<TenraiFetchResult<T>> {
  for (let attempt = 0; attempt <= MAX_TENRAI_RETRIES; attempt += 1) {
    const delay = Math.max(
      0,
      lastTenraiRequestAt + TENRAI_REQUEST_INTERVAL_MS - Date.now(),
    );
    if (delay > 0) {
      await wait(delay);
    }
    lastTenraiRequestAt = Date.now();

    let response: Response;
    try {
      response = await fetch(`${TENRAI_BASE_URL}${path}`, {
        headers: { Accept: 'application/json' },
      });
    } catch {
      return { data: null, status: null };
    }
    if (response.status === 429 && attempt < MAX_TENRAI_RETRIES) {
      const retryAfterSeconds = Number(response.headers.get('Retry-After'));
      await wait(
        Number.isFinite(retryAfterSeconds)
          ? (retryAfterSeconds + 1) * 1_000
          : (attempt + 1) * 2_000,
      );
      continue;
    }
    if (!response.ok) {
      return { data: null, status: response.status };
    }
    return { data: (await response.json()) as T, status: response.status };
  }
  return { data: null, status: null };
}

function fetchTenraiResult<T>(path: string): Promise<TenraiFetchResult<T>> {
  const result = tenraiQueueTail.then(
    () => runTenraiRequest<T>(path),
    () => runTenraiRequest<T>(path),
  );
  tenraiQueueTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function fetchTenrai<T>(path: string): Promise<T | null> {
  return (await fetchTenraiResult<T>(path)).data;
}

function uniqueLinkedMedia(
  refs: readonly AnilistMediaRef[],
): LinkedMalMediaRef[] {
  const seen = new Set<string>();
  const linkedMedia: LinkedMalMediaRef[] = [];
  for (const ref of refs) {
    const malId = ref.idMal;
    if (typeof malId !== 'number' || !Number.isInteger(malId) || malId <= 0) {
      continue;
    }
    const key = `${ref.type}:${malId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    linkedMedia.push({ ...ref, idMal: malId });
  }
  return linkedMedia;
}

async function resolveMediaImage(item: Item): Promise<ResolvedMalImage | null> {
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
  const response = await fetchMalOfficialJson<MalMediaResponse>(
    `/v2/${typePath}/${media.idMal}?fields=main_picture`,
  );
  const url = malPictureUrl(response.data?.main_picture);
  return url ? { url, matchKind: 'exact' } : null;
}

type FuzzyCharacterCandidate = {
  url: string;
  score: number;
};

function addCharacterCandidate(
  malId: number,
  candidateNames: readonly string[],
  imageUrl: string | null,
  sourceNames: CharacterSourceNames,
  canonicalMatches: Map<number, string>,
  aliasMatches: Map<number, string>,
  fuzzyCandidates: Map<number, FuzzyCharacterCandidate>,
): void {
  if (!imageUrl) {
    return;
  }
  if (namesMatch(sourceNames.canonical, candidateNames)) {
    canonicalMatches.set(malId, imageUrl);
    return;
  }
  if (namesMatch(sourceNames.aliases, candidateNames)) {
    aliasMatches.set(malId, imageUrl);
    return;
  }
  const score = bestFuzzyNameScore(
    [...sourceNames.canonical, ...sourceNames.aliases],
    candidateNames,
  );
  const current = fuzzyCandidates.get(malId);
  if (score != null && (current == null || score > current.score)) {
    fuzzyCandidates.set(malId, { url: imageUrl, score });
  }
}

function selectCharacterImage(
  canonicalMatches: ReadonlyMap<number, string>,
  aliasMatches: ReadonlyMap<number, string>,
  fuzzyCandidates: ReadonlyMap<number, FuzzyCharacterCandidate>,
): ResolvedMalImage | null {
  if (canonicalMatches.size === 1) {
    return {
      url: [...canonicalMatches.values()][0]!,
      matchKind: 'exact',
    };
  }
  if (canonicalMatches.size > 1) {
    return null;
  }
  if (aliasMatches.size === 1) {
    return {
      url: [...aliasMatches.values()][0]!,
      matchKind: 'fuzzy',
    };
  }
  if (aliasMatches.size > 1) {
    return null;
  }

  const ranked = [...fuzzyCandidates.values()].sort(
    (left, right) => right.score - left.score,
  );
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (
    !best ||
    (runnerUp != null && best.score - runnerUp.score < FUZZY_CANDIDATE_MARGIN)
  ) {
    return null;
  }
  return { url: best.url, matchKind: 'fuzzy' };
}

async function addMalAnimeCharacterCandidates(
  malId: number,
  sourceNames: CharacterSourceNames,
  canonicalMatches: Map<number, string>,
  aliasMatches: Map<number, string>,
  fuzzyCandidates: Map<number, FuzzyCharacterCandidate>,
): Promise<void> {
  const fields = encodeURIComponent(
    'id,first_name,last_name,alternative_name,main_picture',
  );
  const response = await fetchMalOfficialJson<MalCharactersResponse>(
    `/v2/anime/${malId}/characters?fields=${fields}&limit=500`,
  );
  for (const entry of response.data?.data ?? []) {
    addCharacterCandidate(
      entry.node.id,
      malCharacterNames(entry.node),
      malPictureUrl(entry.node.main_picture),
      sourceNames,
      canonicalMatches,
      aliasMatches,
      fuzzyCandidates,
    );
  }
}

async function resolveCharacterImage(
  item: Item,
): Promise<ResolvedMalImage | null> {
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

  const sourceNames = characterSourceNames(item, character.name);
  const canonicalMatches = new Map<number, string>();
  const aliasMatches = new Map<number, string>();
  const fuzzyCandidates = new Map<number, FuzzyCharacterCandidate>();
  const linkedMedia = uniqueLinkedMedia(character.media.nodes).slice(
    0,
    MAX_LINKED_MEDIA_LOOKUPS,
  );
  for (const media of linkedMedia) {
    const typePath = media.type === 'MANGA' ? 'manga' : 'anime';
    const response = await fetchTenraiResult<{
      data?: TenraiCharacterCredit[];
    }>(
      `/${typePath}/${media.idMal}/characters`,
    );
    for (const credit of response.data?.data ?? []) {
      addCharacterCandidate(
        credit.character.mal_id,
        tenraiEntityNames(credit.character),
        preferredImageUrl(credit.character),
        sourceNames,
        canonicalMatches,
        aliasMatches,
        fuzzyCandidates,
      );
    }
    // MAL's corresponding hidden manga cast route returns 404.
    if (response.status === 504 && media.type === 'ANIME') {
      await addMalAnimeCharacterCandidates(
        media.idMal,
        sourceNames,
        canonicalMatches,
        aliasMatches,
        fuzzyCandidates,
      );
    }
  }
  return selectCharacterImage(
    canonicalMatches,
    aliasMatches,
    fuzzyCandidates,
  );
}

function staffCandidateMatchesCredit(
  candidate: TenraiPersonFull,
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

async function resolveStaffImage(item: Item): Promise<ResolvedMalImage | null> {
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
      character ? metadataNames(character.name) : [],
    );
    if (names.length === 0) {
      continue;
    }
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

  const candidates = new Map<number, TenraiEntity>();
  for (const queryName of sourceNames.slice(0, 2)) {
    const response = await fetchTenrai<{ data?: TenraiEntity[] }>(
      `/people?q=${encodeURIComponent(queryName)}&limit=10`,
    );
    for (const candidate of response?.data ?? []) {
      if (namesMatch(sourceNames, tenraiEntityNames(candidate))) {
        candidates.set(candidate.mal_id, candidate);
      }
    }
  }

  const verified = new Map<number, string>();
  for (const candidate of candidates.values()) {
    const response = await fetchTenrai<{ data?: TenraiPersonFull }>(
      `/people/${candidate.mal_id}/full`,
    );
    const person = response?.data;
    if (
      person &&
      namesMatch(sourceNames, tenraiEntityNames(person)) &&
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
  return verified.size === 1
    ? { url: [...verified.values()][0]!, matchKind: 'exact' }
    : null;
}

async function resolveUncached(item: Item): Promise<ResolvedMalImage | null> {
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
  options?: { forceRefresh?: boolean },
): Promise<BumpMalExportImage | null> {
  const entityKey = entityCacheKey(item);
  if (!entityKey) {
    return null;
  }
  const pendingBeforeRefresh = pendingResolutions.get(entityKey);
  if (options?.forceRefresh) {
    if (pendingBeforeRefresh?.forceRefresh) {
      return pendingBeforeRefresh.promise;
    }
    if (pendingBeforeRefresh) {
      await pendingBeforeRefresh.promise;
    }
    await invalidateResolvedUrl(entityKey);
  }
  const persistedImage = (await loadPersistedUrlCache()).get(entityKey);
  if (persistedImage) {
    return {
      ...persistedImage,
      cacheKey: imageCacheRequestKey(entityKey),
    };
  }

  const pending = pendingResolutions.get(entityKey);
  if (pending) {
    return pending.promise;
  }
  const generation = urlCacheGeneration;
  const resolution = resolveUncached(item)
    .then(async (image): Promise<BumpMalExportImage | null> => {
      if (!image) {
        return null;
      }
      await persistResolvedUrl(entityKey, image, generation);
      return { ...image, cacheKey: imageCacheRequestKey(entityKey) };
    })
    .catch(() => null)
    .finally(() => {
      if (pendingResolutions.get(entityKey)?.promise === resolution) {
        pendingResolutions.delete(entityKey);
      }
    });
  pendingResolutions.set(entityKey, {
    forceRefresh: options?.forceRefresh === true,
    promise: resolution,
  });
  return resolution;
}

export function _resetBumpMalExportImagesForTesting(): void {
  pendingResolutions.clear();
  persistedUrlCache = null;
  urlCacheInitialization = null;
  urlCacheGeneration = 0;
  tenraiQueueTail = Promise.resolve();
  lastTenraiRequestAt = 0;
}

export async function clearBumpMalExportImageUrls(): Promise<void> {
  urlCacheGeneration += 1;
  const cache = await loadPersistedUrlCache();
  cache.clear();
  await clearDisposableCacheNamespace(MAL_IMAGE_URL_CACHE_NAMESPACE);
  try {
    localStorage.removeItem(MAL_IMAGE_URL_CACHE_KEY);
  } catch {
    throw new Error('Failed to clear the legacy Bump Chart image URL cache.');
  }
}

registerDisposableCacheOwner({
  id: 'bump-image-urls',
  label: 'Bump Chart image URL cache',
  deletionEffect: 'Image URLs are resolved again from the existing MAL APIs.',
  measure: () => getDisposableCacheStats(MAL_IMAGE_URL_CACHE_NAMESPACE),
  clear: clearBumpMalExportImageUrls,
});
