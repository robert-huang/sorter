/** Null, blank, and literal "Unknown" values share one selectable filter bucket. */
export const UNKNOWN_GENDER = '(unknown)';

export function normaliseGender(raw: string | null | undefined): string {
  if (raw == null) {
    return UNKNOWN_GENDER;
  }
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'unknown') {
    return UNKNOWN_GENDER;
  }
  return trimmed;
}

export function genderMatches(raw: string | null | undefined, selected: string): boolean {
  return normaliseGender(raw) === selected;
}

export function sortGenderOptions(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => {
    if (a === UNKNOWN_GENDER) {
      return 1;
    }
    if (b === UNKNOWN_GENDER) {
      return -1;
    }
    return a.localeCompare(b);
  });
}

export function normalizeGenderFilterSelections(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return sortGenderOptions(
    value
      .filter((gender): gender is string => typeof gender === 'string')
      .map((gender) => normaliseGender(gender)),
  );
}
