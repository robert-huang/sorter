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

export function GitHubIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size)} {...rest}>
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  );
}

export function DatabaseIcon({ size = 16, ...rest }: IconProps) {
  // Classic cylinder/database: a perspective ellipse on top + two parallel
  // arcs below for the side walls. Kept generic so it works as the fallback
  // icon when a source doesn't ship its own brand mark.
  return (
    <svg {...baseProps(size)} {...rest}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v6c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      <path d="M3 11v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6" />
    </svg>
  );
}

export function UserIcon({ size = 16, ...rest }: IconProps) {
  // Feather "user": a head circle over a shoulders bust. Reads as a
  // single person (vs the two-person "users" glyph) — used for the
  // "random from a user's list" action.
  return (
    <svg {...baseProps(size)} {...rest}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

export function InfoIcon({ size = 16, ...rest }: IconProps) {
  // Feather "info" circle: opens the per-item media detail panel.
  return (
    <svg {...baseProps(size)} {...rest}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}
