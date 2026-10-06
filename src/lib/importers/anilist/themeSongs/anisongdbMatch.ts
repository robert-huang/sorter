import type { AnisongdbSearchHit } from './anisongdbApi';
import { hitHasPlayableMedia, pickPlayableSource } from './anisongdbApi';
import type { MediaThemeSongRow } from './types';
import type { ThemeSongType } from './types';
import {
  artistsRoughlyMatch,
  collectTitleMatchCandidates,
  foldJapaneseRomanization,
  normalizeThemeDashes,
  titlesMatchStronglyAny,
  titlesRoughlyMatch,
} from './themeSongMatching';

export type AnisongdbMatchInput = {
  mediaId: number;
  animeTitle: string;
  row: MediaThemeSongRow;
  songTitle: string;
  songArtist: string | null;
};

export type AnisongdbPreviewUrls = {
  videoUrl: string;
  audioUrl: string | null;
  annSongId: number;
};

export type ParsedAnisongdbSongType = {
  type: ThemeSongType;
  sortOrder: number | null;
};

export function parseAnisongdbSongType(songType: string): ParsedAnisongdbSongType | null {
  const trimmed = songType.trim();
  const opening = /^opening\s*(\d+)?$/i.exec(trimmed);
  if (opening) {
    const num = opening[1] === undefined ? 1 : Number(opening[1]);
    return {
      type: 'Opening',
      sortOrder: Number.isFinite(num) && num >= 1 ? num - 1 : 0,
    };
  }
  const ending = /^ending\s*(\d+)?$/i.exec(trimmed);
  if (ending) {
    const num = ending[1] === undefined ? 1 : Number(ending[1]);
    return {
      type: 'Ending',
      sortOrder: Number.isFinite(num) && num >= 1 ? num - 1 : 0,
    };
  }
  if (/^insert/i.test(trimmed)) {
    return { type: 'Insert', sortOrder: null };
  }
  return null;
}

function stripSeasonQualifiers(title: string): string {
  return title
    .replace(/\b\d+(?:st|nd|rd|th)\s+season\b/gi, '')
    .replace(/\bseason\s+\d+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function animeNamesForHit(hit: AnisongdbSearchHit): string[] {
  const names = [hit.animeENName, hit.animeJPName, ...(hit.animeAltName ?? [])];
  return names.filter((name) => name.trim().length > 0);
}

function animeCompareKey(title: string): string {
  return foldJapaneseRomanization(
    normalizeThemeDashes(title).replace(/-/g, '').replace(/\s+/g, ' ').trim().toLowerCase(),
  );
}

function animeNamesRoughlyMatch(left: string, right: string): boolean {
  if (titlesRoughlyMatch(left, right)) {
    return true;
  }
  const a = animeCompareKey(left);
  const b = animeCompareKey(right);
  return a.length > 0 && b.length > 0 && (a === b || a.includes(b) || b.includes(a));
}

function animeRowMatchesHit(input: AnisongdbMatchInput, hit: AnisongdbSearchHit): boolean {
  if (hit.linked_ids?.anilist === input.mediaId) {
    return true;
  }
  if (!input.animeTitle.trim()) {
    return false;
  }
  return animeTitleMatchesHit(input.animeTitle, hit);
}

function animeTitleMatchCandidates(animeTitle: string): string[] {
  const trimmed = animeTitle.trim();
  const out = new Set<string>();
  if (trimmed) {
    out.add(trimmed);
    const stripped = stripSeasonQualifiers(trimmed);
    if (stripped) {
      out.add(stripped);
    }
    for (const candidate of collectTitleMatchCandidates(trimmed)) {
      out.add(candidate);
      const strippedCandidate = stripSeasonQualifiers(candidate);
      if (strippedCandidate) {
        out.add(strippedCandidate);
      }
    }
  }
  return [...out];
}

function animeTitleMatchesHit(animeTitle: string, hit: AnisongdbSearchHit): boolean {
  const candidates = animeTitleMatchCandidates(animeTitle);
  const hitNames = animeNamesForHit(hit);
  for (const candidate of candidates) {
    for (const hitName of hitNames) {
      if (animeNamesRoughlyMatch(candidate, hitName)) {
        return true;
      }
      const strippedHit = stripSeasonQualifiers(hitName);
      if (strippedHit && animeNamesRoughlyMatch(candidate, strippedHit)) {
        return true;
      }
    }
  }
  return false;
}

export function songTypeMatchesRow(hit: AnisongdbSearchHit, row: MediaThemeSongRow): boolean {
  const parsed = parseAnisongdbSongType(hit.songType);
  if (!parsed || parsed.type !== row.type) {
    return false;
  }
  if (parsed.sortOrder === null || row.type === 'Insert') {
    return true;
  }
  return parsed.sortOrder === row.sortOrder;
}

export function titleMatchesSongQuery(hit: AnisongdbSearchHit, songTitle: string): boolean {
  const variants = collectTitleMatchCandidates(songTitle);
  if (titlesMatchStronglyAny([hit.songName], variants)) {
    return true;
  }
  return variants.some((variant) => titlesRoughlyMatch(variant, hit.songName));
}

export function artistMatchesSongQuery(hit: AnisongdbSearchHit, songArtist: string | null): boolean {
  if (!songArtist?.trim()) {
    return true;
  }
  return artistsRoughlyMatch(hit.songArtist, songArtist);
}

/**
 * On API results (title search): title → anime → artist → song type.
 * Tie-break with AniList id when still ambiguous.
 */
export function pickBestAnisongdbHit(
  hits: readonly AnisongdbSearchHit[],
  input: AnisongdbMatchInput,
): AnisongdbSearchHit | null {
  let pool = hits.filter(
    (hit) => hitHasPlayableMedia(hit) && titleMatchesSongQuery(hit, input.songTitle),
  );
  if (pool.length === 0) {
    return null;
  }

  if (input.animeTitle.trim() || input.mediaId > 0) {
    const animeMatches = pool.filter((hit) => animeRowMatchesHit(input, hit));
    if (animeMatches.length === 0) {
      return null;
    }
    pool = animeMatches;
  }

  if (input.songArtist?.trim()) {
    const artistMatches = pool.filter((hit) => artistMatchesSongQuery(hit, input.songArtist));
    if (artistMatches.length === 0) {
      return null;
    }
    pool = artistMatches;
  }

  const typeMatches = pool.filter((hit) => songTypeMatchesRow(hit, input.row));
  if (typeMatches.length === 0) {
    return null;
  }
  pool = typeMatches;

  const anilistMatches = pool.filter((hit) => hit.linked_ids?.anilist === input.mediaId);
  if (anilistMatches.length === 1) {
    return anilistMatches[0];
  }
  if (anilistMatches.length > 1) {
    pool = anilistMatches;
  }

  if (pool.length === 0) {
    return null;
  }
  if (pool.length === 1) {
    return pool[0];
  }

  let best: AnisongdbSearchHit = pool[0];
  let bestScore = -1;
  for (const hit of pool) {
    let score = 0;
    if (hit.linked_ids?.anilist === input.mediaId) {
      score += 40;
    }
    if (animeTitleMatchesHit(input.animeTitle, hit)) {
      score += 20;
    }
    if (artistMatchesSongQuery(hit, input.songArtist)) {
      score += 10;
    }
    if (songTypeMatchesRow(hit, input.row)) {
      score += 5;
    }
    if (titlesMatchStronglyAny([hit.songName], collectTitleMatchCandidates(input.songTitle))) {
      score += 2;
    }
    if (hit.HQ) {
      score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = hit;
    }
  }
  return best;
}

export function resolveAnisongdbPreviewFromHits(
  hits: readonly AnisongdbSearchHit[],
  input: AnisongdbMatchInput,
): AnisongdbPreviewUrls | null {
  const hit = pickBestAnisongdbHit(hits, input);
  if (!hit) {
    return null;
  }
  const source = pickPlayableSource(hit);
  const primary = source.videoUrl ?? source.audioUrl;
  if (!primary) {
    return null;
  }
  const fallbackAudio =
    source.videoUrl && source.audioUrl && source.videoUrl !== source.audioUrl
      ? source.audioUrl
      : null;
  return {
    annSongId: source.annSongId,
    videoUrl: primary,
    audioUrl: fallbackAudio,
  };
}
