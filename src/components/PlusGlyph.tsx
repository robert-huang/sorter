/** "+" drawn as a path so it centres in icon buttons like the other glyphs (text "+" sits on the baseline). */
export function PlusGlyph() {
  return (
    <svg
      className="icon-btn-glyph plus-glyph"
      width="1em"
      height="1em"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 2.5v11M2.5 8h11" />
    </svg>
  );
}
