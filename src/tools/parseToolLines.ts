/** Split a tools textarea into non-empty lines (one entry per line only). */
export function parseLinesOnePerLine(text: string): string[] {
  // Strip a leading UTF-8 BOM (Excel/Notepad CSV exports include one),
  // otherwise the first line would silently fail to match its keyword.
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return stripped
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}
