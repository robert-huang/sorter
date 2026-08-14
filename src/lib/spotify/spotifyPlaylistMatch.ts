import { mergeSpotifyTrackIdSources } from '../importers/anilist/themeSongs/spotifyLinks';
import { collectTitleMatchCandidates } from '../importers/anilist/themeSongs/themeSongMatching';
import type { MediaThemeSongRow } from '../importers/anilist/themeSongs/types';
import type {
  CachedPlaylistTrackMetadata,
  SpotifyPlaylistCache,
} from './spotifyPlaylist';
import type { SpotifyLocalFileMatchMode } from './spotifyLocalFileMatchPreferences';

export type PlaylistMatchStatus = 'in' | 'out' | 'unknown';

export type PlaylistMatchResult = {
  status: PlaylistMatchStatus;
  /** Present when title/artist metadata matched after exact id/ISRC checks failed. */
  metadataMatch: PlaylistMetadataMatch | null;
  /** One-based playlist position for an exact track-id or ISRC match. */
  playlistPosition?: number;
};

export type PlaylistMetadataMatch = {
  kind: 'local' | 'spotify';
  track: CachedPlaylistTrackMetadata;
};

/** Show-level aggregate over resolvable theme rows (unknown rows excluded). */
export type PlaylistAggregateStatus = 'in' | 'out' | 'mixed';

export type PlaylistMatchOptions = {
  /** Theme track ID → ISRC (lazy cache / persisted expansion). */
  trackIsrcById?: ReadonlyMap<string, string>;
  /** False while lazy theme ISRC fetches are still in flight. */
  isrcLookupReady?: boolean;
  /** Persisted precedence for descriptive title/artist matches. */
  localFileMatchMode?: SpotifyLocalFileMatchMode;
  /** Scope used to invalidate only one show's cached row results. */
  mediaId?: number;
  /** Spotify account market used for availability indicators. */
  spotifyCountry?: string | null;
};

type PlaylistIndex = {
  cache: SpotifyPlaylistCache;
  trackIds: Set<string>;
  isrcs: Set<string>;
  playlistPositionByTrackId: Map<string, number>;
  playlistPositionByIsrc: Map<string, number>;
  metadataTracks: IndexedPlaylistMetadataTrack[] | null;
  metadataByTitle: Map<string, IndexedPlaylistMetadataTrack[]> | null;
};

type IndexedPlaylistMetadataTrack = {
  match: PlaylistMetadataMatch;
  normalizedTitle: string;
  artistCandidates: string[];
  identity: string;
};

type ScoredPlaylistTrack = {
  match: PlaylistMetadataMatch;
  score: number;
  identity: string;
  exact: boolean;
};

const METADATA_TITLE_WITH_ARTIST_THRESHOLD = 0.86;
const METADATA_ARTIST_THRESHOLD = 0.78;
const METADATA_TITLE_ONLY_THRESHOLD = 0.94;
const METADATA_MATCH_MARGIN = 0.04;
const DISTINCTIVE_EXACT_TITLE_MIN_LENGTH = 8;
const MAX_RESULT_CACHE_ENTRIES = 10_000;
const ARTIST_CREDIT_PREFIX = /^c\s*[.]?\s*v\s*[.:]?\s*/iu;
const ARTIST_SEPARATOR =
  /\s*(?:,|、|&|;|\/|\+|×|\b(?:and|with)\b|\bfeat(?:uring)?\.?)\s*/iu;
const ARTIST_BRACKET_PATTERNS = [
  /\(([^()]*)\)/gu,
  /\[([^[\]]*)\]/gu,
  /【([^【】]*)】/gu,
  /<([^<>]*)>/gu,
] as const;
const IGNORED_ARTIST_CANDIDATES = new Set(['and others', 'others', 'unknown', 'various artists']);

const playlistIndexCache = new WeakMap<SpotifyPlaylistCache, PlaylistIndex>();
const playlistIndexesByRevision = new Map<string, PlaylistIndex>();
const matchResultCache = new Map<string, PlaylistMatchResult>();
const mediaMatchRevisions = new Map<number, number>();
let metadataScoreEvaluationCount = 0;

type ArtistScript = 'latin' | 'han' | 'hiragana' | 'katakana' | 'hangul' | 'cyrillic';

const ARTIST_SCRIPT_PATTERNS: ReadonlyArray<{
  script: ArtistScript;
  pattern: RegExp;
}> = [
  { script: 'latin', pattern: /\p{Script=Latin}/u },
  { script: 'han', pattern: /\p{Script=Han}/u },
  { script: 'hiragana', pattern: /\p{Script=Hiragana}/u },
  { script: 'katakana', pattern: /\p{Script=Katakana}/u },
  { script: 'hangul', pattern: /\p{Script=Hangul}/u },
  { script: 'cyrillic', pattern: /\p{Script=Cyrillic}/u },
];

function normalizeIsrc(isrc: string): string {
  return isrc.toLowerCase();
}

function normalizeMatchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, (mark) => (mark === '\u3099' || mark === '\u309a' ? mark : ''))
    .normalize('NFC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizePlaylistTitleForMatch(value: string): string {
  return normalizeMatchText(value)
    .replace(
      /\b(?:tv|anime|short|full|op|ed|opening|ending)\s*(?:size|version|ver|edit)\b/gu,
      ' ',
    )
    .replace(/\b(?:tv|anime|short|op|ed)\s*サイズ/gu, ' ')
    .replace(/\b(?:saishuu|final)\s+(?:hanashi|episode)\s+(?:version|ver)\b$/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function uniqueNormalized(
  values: ReadonlyArray<string | null | undefined>,
  normalize: (value: string) => string,
): string[] {
  return [
    ...new Set(
      values
        .map((value) => (value ? normalize(value) : ''))
        .filter((value) => value.length > 0),
    ),
  ];
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let aIndex = 1; aIndex <= a.length; aIndex++) {
    const current = [aIndex];
    for (let bIndex = 1; bIndex <= b.length; bIndex++) {
      const substitutionCost = a[aIndex - 1] === b[bIndex - 1] ? 0 : 1;
      current[bIndex] = Math.min(
        (current[bIndex - 1] ?? 0) + 1,
        (previous[bIndex] ?? 0) + 1,
        (previous[bIndex - 1] ?? 0) + substitutionCost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

function stringSimilarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) {
    return 1;
  }
  return 1 - levenshteinDistance(a, b) / maxLength;
}

function bestSimilarity(left: readonly string[], right: readonly string[]): number | null {
  if (left.length === 0 || right.length === 0) {
    return null;
  }
  let best = 0;
  for (const leftValue of left) {
    for (const rightValue of right) {
      best = Math.max(best, stringSimilarity(leftValue, rightValue));
    }
  }
  return best;
}

function addArtistVariant(variants: Set<string>, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  const normalized = normalizeMatchText(trimmed);
  if (!normalized || IGNORED_ARTIST_CANDIDATES.has(normalized)) {
    return;
  }
  variants.add(trimmed);
}

function splitMiddleDotArtists(value: string): string[] {
  const parts = value
    .split('・')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length <= 1) {
    return [value];
  }
  const hasSpacedSeparator = /\s・|・\s/u.test(value);
  const allPartsAreJapaneseNames = parts.every(
    (part) =>
      !/\p{Script=Katakana}/u.test(part) &&
      /^[\p{Script=Han}\p{Script=Hiragana}\s]+$/u.test(part),
  );
  return hasSpacedSeparator || allPartsAreJapaneseNames ? parts : [value];
}

function splitArtistSegments(value: string): string[] {
  return value
    .split(ARTIST_SEPARATOR)
    .flatMap((segment) => splitMiddleDotArtists(segment));
}

function collectArtistExpressionVariants(
  expression: string,
  variants: Set<string>,
  depth = 0,
): void {
  if (depth > 3) {
    return;
  }
  const normalizedStructure = expression.normalize('NFKC').trim();
  if (!normalizedStructure) {
    return;
  }
  addArtistVariant(variants, normalizedStructure);

  let withoutBracketedCredits = normalizedStructure;
  for (const bracketPattern of ARTIST_BRACKET_PATTERNS) {
    for (const match of normalizedStructure.matchAll(bracketPattern)) {
      const content = match[1]?.replace(ARTIST_CREDIT_PREFIX, '').trim();
      if (content) {
        addArtistVariant(variants, content);
        collectArtistExpressionVariants(content, variants, depth + 1);
      }
    }
    withoutBracketedCredits = withoutBracketedCredits.replace(bracketPattern, ' ');
  }
  addArtistVariant(variants, withoutBracketedCredits);

  for (const segment of splitArtistSegments(withoutBracketedCredits)) {
    addArtistVariant(variants, segment);
  }
}

function artistValueVariants(value: string): string[] {
  const variants = new Set<string>();
  collectArtistExpressionVariants(value, variants);
  return [...variants];
}

function artistTokenOrderVariant(value: string): string | null {
  const tokens = value.split(' ');
  if (tokens.length < 2 || tokens.length > 4) {
    return null;
  }
  return [...tokens].sort().join(' ');
}

export function collectPlaylistArtistMatchCandidates(
  values: ReadonlyArray<string | null | undefined>,
): string[] {
  const normalized = uniqueNormalized(
    values.flatMap((value) => (value ? artistValueVariants(value) : [])),
    normalizeMatchText,
  );
  return [
    ...new Set([
      ...normalized,
      ...normalized.flatMap((value) => {
        const tokenOrderVariant = artistTokenOrderVariant(value);
        return tokenOrderVariant ? [tokenOrderVariant] : [];
      }),
    ]),
  ];
}

function bestArtistSimilarity(left: readonly string[], right: readonly string[]): number | null {
  return bestSimilarity(left, right);
}

function collectArtistScripts(values: readonly string[]): Set<ArtistScript> {
  const scripts = new Set<ArtistScript>();
  for (const value of values) {
    for (const { script, pattern } of ARTIST_SCRIPT_PATTERNS) {
      if (pattern.test(value)) {
        scripts.add(script);
      }
    }
  }
  return scripts;
}

function artistScriptsAreIncomparable(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftScripts = collectArtistScripts(left);
  const rightScripts = collectArtistScripts(right);
  if (leftScripts.size === 0 || rightScripts.size === 0) {
    return false;
  }
  return [...leftScripts].every((script) => !rightScripts.has(script));
}

function rowTitleCandidates(row: MediaThemeSongRow): string[] {
  return uniqueNormalized(
    [row.displayTitle, row.malTitle, ...(row.aniTitles ?? [])].flatMap((title) =>
      title ? collectTitleMatchCandidates(title) : [],
    ),
    normalizePlaylistTitleForMatch,
  );
}

function rowArtistCandidates(row: MediaThemeSongRow): string[] {
  return collectPlaylistArtistMatchCandidates([
    row.displayArtist,
    row.malArtist,
    ...(row.aniArtists ?? []),
  ]);
}

function playlistTrackArtistCandidates(track: CachedPlaylistTrackMetadata): string[] {
  return collectPlaylistArtistMatchCandidates([...track.artists, track.artists.join(' ')]);
}

function scorePlaylistTrackMetadata(
  titleCandidates: readonly string[],
  artistCandidates: readonly string[],
  indexedTrack: IndexedPlaylistMetadataTrack,
): ScoredPlaylistTrack | null {
  metadataScoreEvaluationCount += 1;
  const { match, normalizedTitle: playlistTitle, artistCandidates: playlistArtists } =
    indexedTrack;
  const titleScore = bestSimilarity(titleCandidates, playlistTitle ? [playlistTitle] : []);
  if (titleScore == null) {
    return null;
  }

  const artistScore = bestArtistSimilarity(artistCandidates, playlistArtists);
  if (artistScore != null) {
    if (
      titleScore === 1 &&
      playlistTitle.length >= DISTINCTIVE_EXACT_TITLE_MIN_LENGTH &&
      artistScriptsAreIncomparable(artistCandidates, playlistArtists)
    ) {
      // Let exact substantial titles bridge Romanized/Japanese tags; the
      // identity-margin check below still rejects multiple plausible tracks.
      return {
        match,
        score: METADATA_TITLE_ONLY_THRESHOLD,
        identity: indexedTrack.identity,
        exact: false,
      };
    }
    if (
      titleScore < METADATA_TITLE_WITH_ARTIST_THRESHOLD ||
      artistScore < METADATA_ARTIST_THRESHOLD
    ) {
      return null;
    }
    return {
      match,
      score: titleScore * 0.8 + artistScore * 0.2,
      identity: indexedTrack.identity,
      exact: titleScore === 1 && artistScore === 1,
    };
  }

  // Without artist metadata, require a near-exact title and reject fuzzy matches
  // for very short names where one character would be a large semantic change.
  if (
    titleScore < METADATA_TITLE_ONLY_THRESHOLD ||
    (titleScore < 1 && playlistTitle.length < 6)
  ) {
    return null;
  }
  return {
    match,
    score: titleScore,
    identity: indexedTrack.identity,
    exact: false,
  };
}

function playlistMetadataCandidates(cache: SpotifyPlaylistCache): PlaylistMetadataMatch[] {
  const localMatches: PlaylistMetadataMatch[] = (cache.localTracks ?? []).map((track) => ({
    kind: 'local',
    track,
  }));
  const spotifyMatches: PlaylistMetadataMatch[] = cache.tracks.flatMap((track) =>
    track.metadata ? [{ kind: 'spotify' as const, track: track.metadata }] : [],
  );
  return [...localMatches, ...spotifyMatches];
}

function indexPlaylistMetadataTrack(
  match: PlaylistMetadataMatch,
): IndexedPlaylistMetadataTrack | null {
  const normalizedTitle = normalizePlaylistTitleForMatch(match.track.title);
  if (!normalizedTitle) {
    return null;
  }
  const artistCandidates = playlistTrackArtistCandidates(match.track);
  return {
    match,
    normalizedTitle,
    artistCandidates,
    identity: `${normalizedTitle}\u0000${[...artistCandidates].sort().join('\u0000')}`,
  };
}

function findPlaylistMetadataMatch(
  row: MediaThemeSongRow,
  index: PlaylistIndex,
): PlaylistMetadataMatch | null {
  ensurePlaylistMetadataIndex(index);
  const metadataTracks = index.metadataTracks ?? [];
  const metadataByTitle = index.metadataByTitle ?? new Map();
  const titles = rowTitleCandidates(row);
  if (titles.length === 0) {
    return null;
  }
  const exactTitleTracks = titles.flatMap(
    (title) => metadataByTitle.get(title) ?? [],
  );
  const playlistTracks =
    exactTitleTracks.length > 0
      ? [...new Set(exactTitleTracks)]
      : metadataTracks.filter((track) =>
          titles.some((title) => {
            const shorterLength = Math.min(title.length, track.normalizedTitle.length);
            const longerLength = Math.max(title.length, track.normalizedTitle.length);
            return (
              longerLength > 0 &&
              shorterLength / longerLength >= METADATA_TITLE_WITH_ARTIST_THRESHOLD
            );
          }),
        );
  if (playlistTracks.length === 0) {
    return null;
  }
  const artists = rowArtistCandidates(row);
  const candidates = playlistTracks
    .map((track) => scorePlaylistTrackMetadata(titles, artists, track))
    .filter((candidate): candidate is ScoredPlaylistTrack => candidate !== null)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.match.track.playlistPosition - b.match.track.playlistPosition,
    );
  const best = candidates[0];
  if (!best) {
    return null;
  }
  const nextDifferentTrack = candidates.find(
    (candidate) => candidate.identity !== best.identity,
  );
  if (
    !best.exact &&
    nextDifferentTrack &&
    best.score - nextDifferentTrack.score < METADATA_MATCH_MARGIN
  ) {
    return null;
  }
  return best.match;
}

function rowSpotifyTrackIds(row: MediaThemeSongRow): string[] {
  return mergeSpotifyTrackIdSources(row.spotifyTrackIds, row.spotifyUrl);
}

function collectRowIsrcs(
  row: MediaThemeSongRow,
  trackIsrcById?: ReadonlyMap<string, string>,
): Set<string> {
  const isrcs = new Set<string>();
  if (row.spotifyIsrc) {
    isrcs.add(normalizeIsrc(row.spotifyIsrc));
  }
  for (const trackId of rowSpotifyTrackIds(row)) {
    const isrc = trackIsrcById?.get(trackId);
    if (isrc) {
      isrcs.add(normalizeIsrc(isrc));
    }
  }
  return isrcs;
}

function buildPlaylistIndex(cache: SpotifyPlaylistCache): PlaylistIndex {
  const cached = playlistIndexCache.get(cache);
  if (cached) {
    return cached;
  }
  const revisionKey = `${cache.playlistId}:${cache.revision ?? cache.fetchedAt}`;
  const shared = playlistIndexesByRevision.get(revisionKey);
  if (shared) {
    playlistIndexCache.set(cache, shared);
    return shared;
  }
  const trackIds = new Set<string>();
  const isrcs = new Set<string>();
  const playlistPositionByTrackId = new Map<string, number>();
  const playlistPositionByIsrc = new Map<string, number>();
  for (const track of cache.tracks) {
    trackIds.add(track.id);
    const playlistPosition = track.metadata?.playlistPosition;
    if (playlistPosition && !playlistPositionByTrackId.has(track.id)) {
      playlistPositionByTrackId.set(track.id, playlistPosition);
    }
    for (const linkedId of track.linkedFromIds) {
      trackIds.add(linkedId);
      if (playlistPosition && !playlistPositionByTrackId.has(linkedId)) {
        playlistPositionByTrackId.set(linkedId, playlistPosition);
      }
    }
    if (track.isrc) {
      const normalizedIsrc = track.isrc.toLowerCase();
      isrcs.add(normalizedIsrc);
      if (playlistPosition && !playlistPositionByIsrc.has(normalizedIsrc)) {
        playlistPositionByIsrc.set(normalizedIsrc, playlistPosition);
      }
    }
  }
  const index: PlaylistIndex = {
    cache,
    trackIds,
    isrcs,
    playlistPositionByTrackId,
    playlistPositionByIsrc,
    metadataTracks: null,
    metadataByTitle: null,
  };
  playlistIndexCache.set(cache, index);
  if (playlistIndexesByRevision.size >= 4) {
    const oldest = playlistIndexesByRevision.keys().next().value;
    if (oldest !== undefined) {
      playlistIndexesByRevision.delete(oldest);
    }
  }
  playlistIndexesByRevision.set(revisionKey, index);
  return index;
}

function ensurePlaylistMetadataIndex(index: PlaylistIndex): void {
  if (index.metadataTracks && index.metadataByTitle) {
    return;
  }
  const metadataTracks = playlistMetadataCandidates(index.cache)
    .map(indexPlaylistMetadataTrack)
    .filter((track): track is IndexedPlaylistMetadataTrack => track !== null);
  const metadataByTitle = new Map<string, IndexedPlaylistMetadataTrack[]>();
  for (const track of metadataTracks) {
    const matches = metadataByTitle.get(track.normalizedTitle) ?? [];
    matches.push(track);
    metadataByTitle.set(track.normalizedTitle, matches);
  }
  index.metadataTracks = metadataTracks;
  index.metadataByTitle = metadataByTitle;
}

function rowMatchFingerprint(row: MediaThemeSongRow): string {
  return JSON.stringify([
    row.type,
    row.songKey ?? null,
    row.displayTitle,
    row.displayArtist ?? null,
    row.malTitle ?? null,
    row.malArtist ?? null,
    row.aniTitles ?? [],
    row.aniArtists ?? [],
    row.spotifyUrl,
    row.spotifyTrackIds,
    row.spotifyIsrc,
  ]);
}

function rowIsrcLookupFingerprint(
  row: MediaThemeSongRow,
  trackIsrcById: ReadonlyMap<string, string> | undefined,
): string {
  return rowSpotifyTrackIds(row)
    .sort()
    .map((trackId) => `${trackId}:${trackIsrcById?.get(trackId) ?? ''}`)
    .join(',');
}

function playlistMatchCacheKey(
  row: MediaThemeSongRow,
  cache: SpotifyPlaylistCache,
  options: PlaylistMatchOptions | undefined,
  mode: SpotifyLocalFileMatchMode,
): string {
  const mediaRevision =
    options?.mediaId == null ? 0 : (mediaMatchRevisions.get(options.mediaId) ?? 0);
  return JSON.stringify([
    cache.playlistId,
    cache.revision ?? cache.fetchedAt,
    mode,
    options?.mediaId ?? null,
    mediaRevision,
    options?.isrcLookupReady !== false,
    rowIsrcLookupFingerprint(row, options?.trackIsrcById),
    rowMatchFingerprint(row),
  ]);
}

function cacheMatchResult(key: string, result: PlaylistMatchResult): PlaylistMatchResult {
  if (matchResultCache.size >= MAX_RESULT_CACHE_ENTRIES) {
    const oldest = matchResultCache.keys().next().value;
    if (oldest !== undefined) {
      matchResultCache.delete(oldest);
    }
  }
  matchResultCache.set(key, result);
  return result;
}

/** Invalidate cached matches after a show's theme-song payload changes. */
export function invalidateThemeSongPlaylistMatches(mediaId: number): void {
  mediaMatchRevisions.set(mediaId, (mediaMatchRevisions.get(mediaId) ?? 0) + 1);
}

/**
 * Show-level aggregate for chart badges. Exact ids/ISRCs and metadata matches
 * count as in; unresolved rows are ignored. Mixed when some match and some do not.
 */
export function aggregatePlaylistMatchForRows(
  rows: readonly MediaThemeSongRow[],
  cache: SpotifyPlaylistCache | null,
  options?: PlaylistMatchOptions,
): PlaylistAggregateStatus | null {
  if (!cache || rows.length === 0) {
    return null;
  }
  let anyIn = false;
  let anyOut = false;
  let anyResolvable = false;
  for (const row of rows) {
    const status = matchThemeRowToPlaylist(row, cache, options);
    if (status === 'unknown') {
      continue;
    }
    anyResolvable = true;
    if (status === 'out') {
      anyOut = true;
    } else if (status === 'in') {
      anyIn = true;
    }
  }
  if (!anyResolvable) {
    return null;
  }
  if (anyIn && anyOut) {
    return 'mixed';
  }
  if (anyOut) {
    return 'out';
  }
  return 'in';
}

export function matchThemeRowToPlaylist(
  row: MediaThemeSongRow,
  cache: SpotifyPlaylistCache | null,
  options?: PlaylistMatchOptions,
): PlaylistMatchStatus {
  return matchThemeRowToPlaylistDetails(row, cache, options).status;
}

export function matchThemeRowToPlaylistDetails(
  row: MediaThemeSongRow,
  cache: SpotifyPlaylistCache | null,
  options?: PlaylistMatchOptions,
): PlaylistMatchResult {
  if (!cache) {
    return { status: 'unknown', metadataMatch: null };
  }
  const mode = options?.localFileMatchMode ?? 'off';
  const resultCacheKey = playlistMatchCacheKey(row, cache, options, mode);
  const cachedResult = matchResultCache.get(resultCacheKey);
  if (cachedResult) {
    return cachedResult;
  }
  const index = buildPlaylistIndex(cache);
  const spotifyTrackIds = rowSpotifyTrackIds(row);

  for (const trackId of spotifyTrackIds) {
    if (index.trackIds.has(trackId)) {
      const playlistPosition = index.playlistPositionByTrackId.get(trackId);
      return cacheMatchResult(resultCacheKey, {
        status: 'in',
        metadataMatch: null,
        ...(playlistPosition ? { playlistPosition } : {}),
      });
    }
  }

  const rowIsrcs = collectRowIsrcs(row, options?.trackIsrcById);
  for (const isrc of rowIsrcs) {
    if (index.isrcs.has(isrc)) {
      const playlistPosition = index.playlistPositionByIsrc.get(isrc);
      return cacheMatchResult(resultCacheKey, {
        status: 'in',
        metadataMatch: null,
        ...(playlistPosition ? { playlistPosition } : {}),
      });
    }
  }

  const hasResolvableLink = spotifyTrackIds.length > 0 || row.spotifyIsrc != null;
  if (
    hasResolvableLink &&
    options?.isrcLookupReady === false &&
    rowIsrcs.size === 0
  ) {
    // Do not let a metadata match temporarily replace an exact green match
    // while alternate-edition ISRC resolution is still in flight.
    return cacheMatchResult(resultCacheKey, {
      status: 'unknown',
      metadataMatch: null,
    });
  }

  if (mode === 'local-first') {
    const metadataMatch = findPlaylistMetadataMatch(row, index);
    if (metadataMatch) {
      return cacheMatchResult(resultCacheKey, {
        status: 'in',
        metadataMatch,
      });
    }
  }

  if (hasResolvableLink) {
    return cacheMatchResult(resultCacheKey, {
      status: 'out',
      metadataMatch: null,
    });
  }

  if (mode === 'spotify-first') {
    const metadataMatch = findPlaylistMetadataMatch(row, index);
    if (metadataMatch) {
      return cacheMatchResult(resultCacheKey, {
        status: 'in',
        metadataMatch,
      });
    }
  }

  return cacheMatchResult(resultCacheKey, {
    status: 'unknown',
    metadataMatch: null,
  });
}

export function buildPlaylistIndexForTests(
  cache: SpotifyPlaylistCache,
): { trackIds: Set<string>; isrcs: Set<string> } {
  return buildPlaylistIndex(cache);
}

/** Test-only matcher cache reset and performance counter. */
export function _resetPlaylistMatchCacheForTesting(): void {
  playlistIndexesByRevision.clear();
  matchResultCache.clear();
  mediaMatchRevisions.clear();
  metadataScoreEvaluationCount = 0;
}

export function _getMetadataScoreEvaluationCountForTesting(): number {
  return metadataScoreEvaluationCount;
}
