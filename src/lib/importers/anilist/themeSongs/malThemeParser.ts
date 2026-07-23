export type ParsedMalTheme = {
  type: 'Opening' | 'Ending';
  sortOrder: number;
  raw: string;
  title: string;
  artist: string | null;
  episodes: string | null;
};

const EPISODES_RE = /\((eps?\.?\s*[^)]+)\)\s*$/i;
const NUMBERED_PREFIX_RE = /^#?(\d+)\s*:\s*/;
const WRAPPING_QUOTE_RE = /^["'`\u2018\u2019\u201c\u201d]|["'`\u2018\u2019\u201c\u201d]$/;

/** Strip mismatched / doubled quote wrappers from Jikan/MAL theme titles. */
function stripWrappingQuotes(title: string): string {
  let out = title.trim();
  while (WRAPPING_QUOTE_RE.test(out)) {
    out = out
      .replace(/^["'`\u2018\u2019\u201c\u201d]/, '')
      .replace(/["'`\u2018\u2019\u201c\u201d]$/, '')
      .trim();
  }
  return out;
}

/**
 * Parse a MAL/Jikan theme string like:
 *   `"Zero Centimeter" by Yuiko Oohara`
 *   `1: "Kanade" by Takagi-san (Rie Takahashi) (eps 1)`
 */
export function parseMalThemeString(
  raw: string,
  type: 'Opening' | 'Ending',
  index: number,
): ParsedMalTheme {
  let text = raw.trim();
  let sortOrder = index;

  const numbered = NUMBERED_PREFIX_RE.exec(text);
  if (numbered) {
    sortOrder = Number(numbered[1]) - 1;
    text = text.slice(numbered[0].length).trim();
  }

  let episodes: string | null = null;
  const epMatch = EPISODES_RE.exec(text);
  if (epMatch) {
    episodes = epMatch[1].trim();
    text = text.slice(0, epMatch.index).trim();
  }

  let title = text;
  let artist: string | null = null;

  const byIdx = text.lastIndexOf(' by ');
  if (byIdx > 0) {
    title = text.slice(0, byIdx).trim();
    artist = text.slice(byIdx + 4).trim() || null;
  }

  title = stripWrappingQuotes(title);

  return {
    type,
    sortOrder,
    raw,
    title,
    artist,
    episodes,
  };
}

export function parseMalThemes(openings: readonly string[], endings: readonly string[]): ParsedMalTheme[] {
  const out: ParsedMalTheme[] = [];
  openings.forEach((line, i) => {
    out.push(parseMalThemeString(line, 'Opening', i));
  });
  endings.forEach((line, i) => {
    out.push(parseMalThemeString(line, 'Ending', i));
  });
  return out;
}
