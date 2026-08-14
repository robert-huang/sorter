import type { AniplaylistArtist, AniplaylistHit } from './aniplaylistApi';
import { normalizeAniplaylistThemeType } from './aniplaylistApi';

/**
 * Fold common Japanese romanization variants so `Oohara` / `Ohara`, `Yuuko` / `Yuko`,
 * `Toukyo` / `Tokyo`, etc. compare equal. Safe in narrow same-anime matching sets.
 */
export function foldJapaneseRomanization(s: string): string {
  let out = s.toLowerCase();
  for (let i = 0; i < 3; i += 1) {
    const next = out
      .replace(/ou/g, 'o')
      .replace(/oo/g, 'o')
      .replace(/uu/g, 'u')
      .replace(/aa/g, 'a')
      .replace(/ei/g, 'e')
      .replace(/ii/g, 'i');
    if (next === out) {
      break;
    }
    out = next;
  }
  return out;
}

/** MAL uses ASCII `~`; AniPlaylist/JP credits often use wave dash `〜` / fullwidth `～`. */
export function normalizeThemeDashes(s: string): string {
  return s.replace(/[~〜～−–—]/g, '~');
}

function normalizeKey(s: string): string {
  return normalizeThemeDashes(
    foldJapaneseRomanization(s.normalize('NFKC'))
      .replace(/[\u2018\u2019\u201b]/g, "'")
      .replace(/\s*([\p{S}\p{Pd}])\s*/gu, '$1')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function comparableKey(s: string): string {
  return normalizeKey(s);
}

function stringsRoughlyMatch(a: string, b: string): boolean {
  const na = comparableKey(a);
  const nb = comparableKey(b);
  if (!na || !nb) {
    return false;
  }
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** Substring / equality match on a single title string pair. */
export function titlesRoughlyMatch(a: string, b: string): boolean {
  return stringsRoughlyMatch(a, b);
}

const CV_CREDIT_RE = /\(CV:\s*([^)]+)\)/i;

function extractCvCredit(artist: string): string | null {
  const match = CV_CREDIT_RE.exec(artist);
  return match?.[1]?.trim() ?? null;
}

/** Drop parenthetical credits so token sets compare performer names only. */
function stripArtistParentheticals(artist: string): string {
  return artist
    .replace(/\(CV:[^)]*\)/gi, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeArtistName(artist: string): Set<string> {
  const stripped = stripArtistParentheticals(artist);
  const tokens = stripped.split(/[\s,]+/).filter((token) => token.length > 0);
  return new Set(tokens.map((token) => comparableKey(token)));
}

function artistTokenSetsMatch(a: string, b: string): boolean {
  const tokensA = tokenizeArtistName(a);
  const tokensB = tokenizeArtistName(b);
  if (tokensA.size === 0 || tokensB.size === 0 || tokensA.size !== tokensB.size) {
    return false;
  }
  for (const token of tokensA) {
    if (!tokensB.has(token)) {
      return false;
    }
  }
  return true;
}

/** Looser artist match: substring, CV credits, and token-set (word-order insensitive). */
export function artistsRoughlyMatch(a: string, b: string): boolean {
  if (titlesRoughlyMatch(a, b)) {
    return true;
  }
  const cvA = extractCvCredit(a);
  const cvB = extractCvCredit(b);
  if (cvA && cvB && titlesRoughlyMatch(cvA, cvB)) {
    return true;
  }
  if (artistTokenSetsMatch(a, b)) {
    return true;
  }
  if (cvA && artistTokenSetsMatch(cvA, b)) {
    return true;
  }
  if (cvB && artistTokenSetsMatch(cvB, a)) {
    return true;
  }
  return false;
}

/**
 * MAL/Tenrai theme strings often bundle alternate titles in parentheses, e.g.
 * `Kanade (奏（かなで）)`. AniPlaylist may store each language separately.
 */
type ParentheticalRange = {
  start: number;
  end: number;
  depth: number;
};

function collectParentheticalRanges(value: string): ParentheticalRange[] {
  const stack: Array<{ character: '(' | '（'; index: number }> = [];
  const ranges: ParentheticalRange[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '(' || character === '（') {
      stack.push({ character, index });
      continue;
    }
    if (character !== ')' && character !== '）') {
      continue;
    }
    const opener = stack[stack.length - 1];
    const closesOpener =
      (opener?.character === '(' && character === ')') ||
      (opener?.character === '（' && character === '）');
    if (!opener || !closesOpener) {
      continue;
    }
    stack.pop();
    ranges.push({
      start: opener.index,
      end: index + 1,
      depth: stack.length,
    });
  }
  return ranges.sort((left, right) => left.start - right.start || right.end - left.end);
}

function removeTopLevelParentheticals(
  value: string,
  ranges: readonly ParentheticalRange[],
): string {
  let cursor = 0;
  let base = '';
  for (const range of ranges) {
    if (range.depth !== 0) {
      continue;
    }
    base += `${value.slice(cursor, range.start)} `;
    cursor = range.end;
  }
  return `${base}${value.slice(cursor)}`.replace(/\s+/g, ' ').trim();
}

export function collectTitleMatchCandidates(title: string): string[] {
  const trimmed = title.trim();
  if (!trimmed) {
    return [];
  }

  const out = new Set<string>([trimmed]);
  const ranges = collectParentheticalRanges(trimmed);
  for (const range of ranges) {
    const inner = trimmed.slice(range.start + 1, range.end - 1).trim();
    if (inner) {
      out.add(inner);
    }
  }

  // Repeatedly remove complete trailing aliases while preserving earlier
  // qualifiers such as `(feat. Kana Adachi)`.
  let prefix = trimmed;
  while (true) {
    const trailingRanges = collectParentheticalRanges(prefix).filter(
      (range) => range.depth === 0 && !prefix.slice(range.end).trim(),
    );
    const trailingRange = trailingRanges[trailingRanges.length - 1];
    if (!trailingRange) {
      break;
    }
    prefix = prefix.slice(0, trailingRange.start).trim();
    if (prefix) {
      out.add(prefix);
    }
  }

  const base = removeTopLevelParentheticals(trimmed, ranges);
  if (base) {
    out.add(base);
  }

  return [...out];
}

export function titlesRoughlyMatchAny(
  left: readonly string[],
  right: readonly string[],
): boolean {
  for (const a of left) {
    for (const b of right) {
      if (titlesRoughlyMatch(a, b)) {
        return true;
      }
    }
  }
  return false;
}

/** Exact title match after romanization fold — used to skip artist for cross-source pairs. */
export function titlesMatchStrongly(a: string, b: string): boolean {
  return comparableKey(a) === comparableKey(b);
}

export function titlesMatchStronglyAny(
  hitTitles: readonly string[],
  malTitleVariants: readonly string[],
): boolean {
  for (const hitTitle of hitTitles) {
    for (const malTitle of malTitleVariants) {
      if (titlesMatchStrongly(hitTitle, malTitle)) {
        return true;
      }
    }
  }
  return false;
}

/** Avoid pairing unrelated songs that only share a short substring (e.g. `Zero` vs `Zero Centimeter`). */
function titlesCloseEnoughForArtistPairing(
  hitTitles: readonly string[],
  malTitleVariants: readonly string[],
): boolean {
  for (const hitTitle of hitTitles) {
    for (const malTitle of malTitleVariants) {
      if (titlesMatchStrongly(hitTitle, malTitle)) {
        return true;
      }
      const nh = comparableKey(hitTitle);
      const nm = comparableKey(malTitle);
      if (!nh || !nm) {
        continue;
      }
      const shorter = nh.length <= nm.length ? nh : nm;
      const longer = nh.length > nm.length ? nh : nm;
      if (longer.includes(shorter) && shorter.length >= longer.length * 0.6) {
        return true;
      }
    }
  }
  return false;
}

export function artistsRoughlyMatchAny(
  hitArtists: readonly AniplaylistArtist[],
  malArtist: string | null,
): boolean {
  if (!malArtist) {
    return true;
  }
  for (const artist of hitArtists) {
    for (const name of artist.names ?? []) {
      if (artistsRoughlyMatch(name, malArtist)) {
        return true;
      }
    }
  }
  return false;
}

export type MalThemeMatchInput = {
  type: string;
  title: string;
  artist: string | null;
};

/** Shared MAL ↔ AniPlaylist hit match used by merge and cluster selection. */
export function malThemeMatchesAniplaylistHit(
  mal: MalThemeMatchInput,
  hit: Pick<AniplaylistHit, 'song_type' | 'song_key' | 'titles' | 'artists'>,
): boolean {
  const aniType = normalizeAniplaylistThemeType(hit.song_type, hit.song_key);
  if (!aniType || mal.type !== aniType) {
    return false;
  }

  const malTitleVariants = collectTitleMatchCandidates(mal.title);
  const titleOk = hit.titles.some((hitTitle) =>
    malTitleVariants.some((malTitle) => titlesRoughlyMatch(hitTitle, malTitle)),
  );
  if (!titleOk) {
    return false;
  }

  // Same type + same song title (after romanization fold) is enough for MAL↔AniPlaylist.
  // Artist strings vary too much across sources (Oohara/Ohara, romaji vs 大原ゆい子).
  if (titlesMatchStronglyAny(hit.titles, malTitleVariants)) {
    return true;
  }

  if (!titlesCloseEnoughForArtistPairing(hit.titles, malTitleVariants)) {
    return false;
  }

  return artistsRoughlyMatchAny(hit.artists ?? [], mal.artist);
}
