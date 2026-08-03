import { mergeSpotifyTrackIdSources } from '../importers/anilist/themeSongs/spotifyLinks';
import { collectTitleMatchCandidates } from '../importers/anilist/themeSongs/themeSongMatching';
import type { MediaThemeSongRow } from '../importers/anilist/themeSongs/types';
import type {
  CachedPlaylistTrackMetadata,
  SpotifyPlaylistCache,
} from './spotifyPlaylist';

export type PlaylistMatchStatus = 'in' | 'out' | 'unknown';

export type PlaylistMatchResult = {
  status: PlaylistMatchStatus;
  /** Present when title/artist metadata matched after exact id/ISRC checks failed. */
  metadataMatch: PlaylistMetadataMatch | null;
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
};

type PlaylistIndex = {
  trackIds: Set<string>;
  isrcs: Set<string>;
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

function playlistTrackIdentity(track: CachedPlaylistTrackMetadata): string {
  return `${normalizePlaylistTitleForMatch(track.title)}\u0000${playlistTrackArtistCandidates(track)
    .sort()
    .join('\u0000')}`;
}

function scorePlaylistTrackMetadata(
  titleCandidates: readonly string[],
  artistCandidates: readonly string[],
  match: PlaylistMetadataMatch,
): ScoredPlaylistTrack | null {
  const { track } = match;
  const playlistTitle = normalizePlaylistTitleForMatch(track.title);
  const titleScore = bestSimilarity(titleCandidates, playlistTitle ? [playlistTitle] : []);
  if (titleScore == null) {
    return null;
  }

  const playlistArtists = playlistTrackArtistCandidates(track);
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
        identity: playlistTrackIdentity(track),
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
      identity: playlistTrackIdentity(track),
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
    identity: playlistTrackIdentity(track),
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

function findPlaylistMetadataMatch(
  row: MediaThemeSongRow,
  cache: SpotifyPlaylistCache,
): PlaylistMetadataMatch | null {
  const playlistTracks = playlistMetadataCandidates(cache);
  if (playlistTracks.length === 0) {
    return null;
  }
  const titles = rowTitleCandidates(row);
  if (titles.length === 0) {
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
  const trackIds = new Set<string>();
  const isrcs = new Set<string>();
  for (const track of cache.tracks) {
    trackIds.add(track.id);
    for (const linkedId of track.linkedFromIds) {
      trackIds.add(linkedId);
    }
    if (track.isrc) {
      isrcs.add(track.isrc.toLowerCase());
    }
  }
  return { trackIds, isrcs };
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
  const index = buildPlaylistIndex(cache);
  const spotifyTrackIds = rowSpotifyTrackIds(row);

  for (const trackId of spotifyTrackIds) {
    if (index.trackIds.has(trackId)) {
      return { status: 'in', metadataMatch: null };
    }
  }

  const rowIsrcs = collectRowIsrcs(row, options?.trackIsrcById);
  for (const isrc of rowIsrcs) {
    if (index.isrcs.has(isrc)) {
      return { status: 'in', metadataMatch: null };
    }
  }

  const metadataMatch = findPlaylistMetadataMatch(row, cache);
  if (metadataMatch) {
    return { status: 'in', metadataMatch };
  }

  const hasResolvableLink = spotifyTrackIds.length > 0 || row.spotifyIsrc != null;
  if (hasResolvableLink) {
    if (options?.isrcLookupReady === false && rowIsrcs.size === 0) {
      return { status: 'unknown', metadataMatch: null };
    }
    return { status: 'out', metadataMatch: null };
  }

  return { status: 'unknown', metadataMatch: null };
}

export function buildPlaylistIndexForTests(
  cache: SpotifyPlaylistCache,
): { trackIds: Set<string>; isrcs: Set<string> } {
  return buildPlaylistIndex(cache);
}
