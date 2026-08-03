/**
 * Pin artwork supplied in Fe19V01.svg. Keeping it inline lets the icon inherit
 * the surrounding text color in both light and dark themes.
 */
export function PinIcon() {
  return (
    <svg
      className="pin-icon"
      viewBox="0 0 330 330"
      aria-hidden="true"
      focusable="false"
    >
      <g transform="translate(0 330) scale(0.1 -0.1)" fill="currentColor">
        <path d="M1392 2575 c-164 -42 -299 -121 -339 -198 -20 -40 -12 -112 15 -140 11 -11 42 -32 68 -46 l48 -26 63 -279 64 -278 -49 -52 c-105 -110 -122 -275 -39 -364 62 -67 187 -92 359 -72 62 7 123 13 136 14 22 1 33 -23 145 -322 67 -177 123 -318 125 -313 1 4 -29 154 -68 332 -38 178 -70 330 -70 337 0 7 26 24 57 38 31 14 90 48 131 77 158 109 222 232 177 340 -30 73 -124 137 -230 159 l-54 11 -111 278 -112 278 26 55 c14 30 26 68 26 83 0 104 -159 142 -368 88z m397 -552 c61 -150 111 -285 111 -300 0 -21 -12 -40 -42 -70 -38 -36 -125 -90 -133 -81 -1 2 -33 118 -70 258 -37 140 -77 295 -90 343 l-24 88 62 28 c42 19 64 25 68 17 4 -6 57 -133 118 -283z" />
      </g>
    </svg>
  );
}
