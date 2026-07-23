import type { AniplaylistArtist, AniplaylistHit } from './aniplaylistApi';

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

function normalizeKey(s: string): string {
  return foldJapaneseRomanization(s).replace(/\s+/g, ' ').trim();
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
 * MAL/Jikan theme strings often bundle alternate titles in parentheses, e.g.
 * `Kanade (奏（かなで）)`. AniPlaylist may store each language separately.
 */
export function collectTitleMatchCandidates(title: string): string[] {
  const trimmed = title.trim();
  if (!trimmed) {
    return [];
  }

  const out = new Set<string>([trimmed]);

  const asciiParenRe = /\(([^)]+)\)/g;
  let match: RegExpExecArray | null = asciiParenRe.exec(trimmed);
  while (match) {
    const inner = match[1].trim();
    if (inner) {
      out.add(inner);
    }
    match = asciiParenRe.exec(trimmed);
  }

  const fullwidthParenRe = /（([^）]+)）/g;
  match = fullwidthParenRe.exec(trimmed);
  while (match) {
    const inner = match[1].trim();
    if (inner) {
      out.add(inner);
    }
    match = fullwidthParenRe.exec(trimmed);
  }

  const base = trimmed
    .replace(/\([^)]*\)/g, ' ')
    .replace(/（[^）]*）/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  hit: Pick<AniplaylistHit, 'song_type' | 'titles' | 'artists'>,
): boolean {
  if (mal.type !== hit.song_type) {
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
