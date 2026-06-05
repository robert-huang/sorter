import { getPersonNameDisplayMode, type PersonNameDisplayMode } from './displayPreferences';

export type PersonNameFields = {
  id: number;
  name_full: string | null;
  name_native: string | null;
};

export function pickPersonName(
  fields: PersonNameFields,
  mode: PersonNameDisplayMode = getPersonNameDisplayMode(),
  fallbackLabel = 'Person',
): string {
  const fallback = `${fallbackLabel} #${fields.id}`;
  if (mode === 'native') {
    return fields.name_native ?? fields.name_full ?? fallback;
  }
  return fields.name_full ?? fields.name_native ?? fallback;
}

/** Character rows also carry alternative/nickname names (JSON arrays). */
export type CharacterNameFields = PersonNameFields & {
  name_alternatives_json?: string | null;
  name_alternatives_spoiler_json?: string | null;
};

function parseNameArrayJson(json: string | null | undefined): string[] {
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0,
      );
    }
  } catch {
    /* ignore malformed alternatives json */
  }
  return [];
}

/**
 * All person name variants for substring search (display mode
 * independent). `extraNames` lets callers fold in alternatives /
 * nicknames not present on the base {full, native} pair.
 */
export function personNameSearchParts(
  fields: PersonNameFields,
  extraNames: readonly (string | null | undefined)[] = [],
): readonly string[] {
  const parts: string[] = [];
  const push = (value: string | null | undefined): void => {
    if (value && !parts.includes(value)) {
      parts.push(value);
    }
  };
  push(fields.name_full);
  push(fields.name_native);
  for (const name of extraNames) {
    push(name);
  }
  return parts;
}

/**
 * Search variants for a character: full + native + every alternative /
 * spoiler-alternative name. Matching is display-mode independent and
 * never reveals spoilers (it only matches text the user already typed).
 */
export function characterNameSearchParts(
  fields: CharacterNameFields,
): readonly string[] {
  return personNameSearchParts(fields, [
    ...parseNameArrayJson(fields.name_alternatives_json),
    ...parseNameArrayJson(fields.name_alternatives_spoiler_json),
  ]);
}
