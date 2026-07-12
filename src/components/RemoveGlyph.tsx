/**
 * Centered × for square `icon-btn` remove buttons. Unicode U+00D7 sits
 * low in the em-box on Windows UI fonts; SVG geometry is platform-neutral.
 */
export function RemoveGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg
      className="icon-btn-glyph"
      width={size}
      height={size}
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      {/* Two stroked arms can leave a subpixel hole where they cross on some
         DPI/zoom combos — a pin behind the junction fills it in. */}
      <circle cx="6" cy="6" r="0.75" fill="currentColor" />
      <path
        d="M2.5 2.5l7 7M9.5 2.5l-7 7"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
      />
    </svg>
  );
}
