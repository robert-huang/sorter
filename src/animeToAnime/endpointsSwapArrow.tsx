/** Right-pointing arrow centered in 24×24 for in-place rotation (no Unicode glyph drift). */
export function EndpointsSwapArrow() {
  return (
    <svg
      className="anime-to-anime-swap-arrow-icon"
      viewBox="0 0 24 24"
      width={20}
      height={20}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M6 12h10M14 8l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
