/**
 * Source-id → React icon component lookup. Lives in the UI layer (not in
 * `src/lib/db/source-registry.ts`) so source descriptors stay framework-
 * agnostic and don't drag JSX into the worker bundle.
 *
 * To add a new source's brand mark: define the icon in `./icons.tsx` (keep
 * the Feather-style 24×24 stroke convention) and add a `sourceId: Icon`
 * entry to `SOURCE_ICONS` below. Sources without an entry fall back to the
 * generic cylinder, which is also what we currently show for the synthetic
 * `test` source — placeholder until a real source ships.
 */
import type { ComponentType, SVGProps } from 'react';
import { DatabaseIcon } from './icons';

export interface SourceIconProps
  extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number;
}

export type SourceIcon = ComponentType<SourceIconProps>;

const SOURCE_ICONS: Record<string, SourceIcon> = {
  // The `test` source is a developer-only fixture; show the generic cylinder
  // until a "real" source (e.g. anilist) registers its own glyph.
  test: DatabaseIcon,
};

export function getSourceIcon(sourceId: string): SourceIcon {
  return SOURCE_ICONS[sourceId] ?? DatabaseIcon;
}
