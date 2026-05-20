/**
 * Small inline SVG icon set in the Feather "line art" style (1.5–2px
 * stroke, no fill, rounded line caps/joins, `currentColor` for both
 * stroke and fill so they inherit the surrounding button's color — and
 * theme automatically with light/dark).
 *
 * Inlined rather than pulled from a library because (a) we're not allowed
 * to add new dependencies, (b) it keeps the icons in lockstep with our
 * theme variables via `currentColor`, and (c) two-or-three icons aren't
 * worth a tree-shaken package.
 *
 * All icons take an optional pixel `size` (square) and `className` so the
 * caller can position/space them inside a button. The 24×24 viewBox is
 * the Feather convention; rendering smaller (e.g. 14px) still looks crisp
 * because everything is stroked.
 */
import type { SVGProps } from 'react';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number;
}

function baseProps(size: number): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
  };
}

export function TrashIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size)} {...rest}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export function FloppyIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size)} {...rest}>
      {/* Outer disk body with the snipped corner where the label sits. */}
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      {/* Bottom label panel. */}
      <polyline points="17 21 17 13 7 13 7 21" />
      {/* Top metal shutter slot. */}
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}

export function CheckIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size)} {...rest}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
