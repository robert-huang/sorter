/**
 * Closed set of AniList format / mediaType tokens emitted by the
 * Franchise Scores tool's "Copy titles" button (see
 * `buildFranchiseClipboardText` + `franchiseFormatLabel`). Lines pasted
 * straight from that clipboard payload look like `Title (TV)` /
 * `Title (MOVIE)` / `Title (MANGA)` etc.; we strip exactly these
 * tokens so users don't have to hand-edit the format suffix off
 * every line before feeding them into another tool's title input.
 *
 * Kept narrow on purpose: a generic "strip any trailing `(...)`"
 * would mangle real titles that legitimately end in parens
 * (e.g. `Steins;Gate (2011)`, `Fate/stay night (2006)`). Matching
 * against a known token list keeps those untouched.
 */
const FRANCHISE_FORMAT_TOKENS = [
  'TV',
  'TV_SHORT',
  'MOVIE',
  'SPECIAL',
  'OVA',
  'ONA',
  'MUSIC',
  'MANGA',
  'NOVEL',
  'ONE_SHOT',
  'ANIME',
] as const;

const FORMAT_SUFFIX_REGEX = new RegExp(
  `\\s+\\((?:${FRANCHISE_FORMAT_TOKENS.join('|')})\\)$`,
);

/**
 * Drop a trailing ` (FORMAT)` suffix when FORMAT matches the franchise
 * tool's output vocabulary. Idempotent — no-op when the line has no
 * such suffix.
 */
export function stripFranchiseFormatSuffix(line: string): string {
  return line.replace(FORMAT_SUFFIX_REGEX, '');
}

/** Split a tools textarea into non-empty lines (one entry per line only). */
export function parseLinesOnePerLine(text: string): string[] {
  // Strip a leading UTF-8 BOM (Excel/Notepad CSV exports include one),
  // otherwise the first line would silently fail to match its keyword.
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return stripped
    .split(/\n+/)
    .map((line) => stripFranchiseFormatSuffix(line.trim()))
    .filter(Boolean);
}
