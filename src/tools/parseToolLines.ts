/** Split a tools textarea into non-empty lines (one entry per line only). */
export function parseLinesOnePerLine(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}
