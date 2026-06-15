/**
 * AniList brand glyph for the source-icon lookup in
 * [src/components/sourceIcons.tsx](src/components/sourceIcons.tsx).
 *
 * These are AniList's own icon paths, taken verbatim from their official
 * mark at https://anilist.co/img/icons/icon.svg (172x172 viewBox, two
 * even-odd paths — the blue shape and the white "A"). The only change is
 * colour: the "A" uses `currentColor` instead of the official near-white
 * so the glyph stays legible in either theme without a background plate
 * (the official file is itself transparent), while the other shape keeps
 * AniList's brand blue. It intentionally deviates from the Feather-style
 * line-art in [src/components/icons.tsx](src/components/icons.tsx)
 * because the mark only reads as AniList when the letterforms are solid.
 *
 * Default render size is 16px (overridable via `size`).
 */
import type { SVGProps } from 'react';

/** AniList's official brand blue (from icon.svg). */
const ANILIST_BLUE = '#02a9ff';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number;
}

export function AnilistIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 172 172"
      fill="none"
      aria-hidden
      focusable={false}
      {...rest}
    >
      <path
        d="M111.322,111.157 L111.322,41.029 C111.322,37.010 109.105,34.792 105.086,34.792 L91.365,34.792 C87.346,34.792 85.128,37.010 85.128,41.029 C85.128,41.029 85.128,56.337 85.128,74.333 C85.128,75.271 94.165,79.626 94.401,80.547 C101.286,107.449 95.897,128.980 89.370,129.985 C100.042,130.513 101.216,135.644 93.267,132.138 C94.483,117.784 99.228,117.812 112.869,131.610 C112.986,131.729 115.666,137.351 115.833,137.351 C131.170,137.351 148.050,137.351 148.050,137.351 C152.069,137.351 154.286,135.134 154.286,131.115 L154.286,117.394 C154.286,113.375 152.069,111.157 148.050,111.157 L111.322,111.157 Z"
        fill={ANILIST_BLUE}
        fillRule="evenodd"
      />
      <path
        d="M54.365,34.792 L18.331,137.351 L46.327,137.351 L52.425,119.611 L82.915,119.611 L88.875,137.351 L116.732,137.351 L80.836,34.792 L54.365,34.792 ZM58.800,96.882 L67.531,68.470 L77.094,96.882 L58.800,96.882 Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}
