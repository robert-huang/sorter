/**
 * AniList brand glyph for the source-icon lookup in
 * [src/components/sourceIcons.tsx](src/components/sourceIcons.tsx).
 *
 * Drawn in the same Feather-style line-art convention as the other
 * icons in [src/components/icons.tsx](src/components/icons.tsx)
 * (24x24 viewBox, currentColor stroke, no fill) so the glyph adopts
 * the surrounding button's color and theme via CSS just like the
 * generic cylinder fallback. Kept inside the anilist importer folder
 * so the source descriptor stays self-contained — the sourceIcons
 * registry just imports it.
 *
 * Shape rationale: AniList's real brand mark is a stylized capital
 * "A" with a notch cut from the right leg. We approximate that with
 * a triangle outline plus a tiny horizontal crossbar at the bottom
 * of the right leg to read as the notch at small sizes (16px).
 */
import type { SVGProps } from 'react';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number;
}

export function AnilistIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
      {...rest}
    >
      {/* Triangle "A" outline. */}
      <polyline points="4 20 12 4 20 20" />
      {/* Crossbar of the A. */}
      <line x1="8" y1="14" x2="16" y2="14" />
      {/* Notch in the right leg — the bit that makes it read as AniList
          rather than a plain triangle warning glyph. */}
      <line x1="14" y1="20" x2="20" y2="20" />
    </svg>
  );
}
