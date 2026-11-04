import type { ItemId, SectionResort } from './types';

/** Deep copy for undo snapshots; `undefined` stays absent. */
export function cloneSection(section: SectionResort | undefined): SectionResort | undefined {
  if (!section) return undefined;
  return {
    ...section,
    before: section.before.slice(),
    after: section.after.slice(),
    tailPlaceholders: section.tailPlaceholders.slice(),
    originalOrder: section.originalOrder.slice(),
    originalHidden: section.originalHidden.slice(),
    ...(section.originalToBeInserted
      ? { originalToBeInserted: section.originalToBeInserted.slice() }
      : {}),
  };
}

/** Spread into a progress object so a missing section doesn't add an `undefined` key. */
export function sectionField(
  section: SectionResort | undefined,
): { section?: SectionResort } {
  const copy = cloneSection(section);
  return copy ? { section: copy } : {};
}

/** e.g. "Re-sorting ranks 40–55". */
export function sectionResortLabel(section: SectionResort): string {
  return `Re-sorting ranks ${section.startRank}–${section.endRank}`;
}

/** Frozen ids (visible or hidden) that sit outside the re-sorted range. */
export function frozenSectionIds(section: SectionResort | undefined): Set<ItemId> {
  if (!section) return new Set();
  return new Set([...section.before, ...section.tailPlaceholders, ...section.after]);
}
