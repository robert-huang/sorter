/**
 * Tiny localStorage-backed history for a single text input. Used by
 * the AniList username field as a reliable fallback to native browser
 * autofill — `<input autoComplete="username">` SHOULD trigger Chrome's
 * own per-origin autofill suggestions, but the heuristics that decide
 * whether to record an entry are undocumented and notoriously flaky
 * (preventDefault submits, dev URLs, controlled inputs, and form-less
 * inputs all have edge cases). A `<datalist>` wired to the values
 * returned here ALWAYS produces a dropdown on focus, regardless of
 * browser quirks, so the user gets a predictable experience.
 *
 * Entries are stored most-recent-first and capped at `MAX_ENTRIES`
 * so the dropdown stays scannable. Storage is keyed by an arbitrary
 * caller-supplied key so future inputs (e.g. Spotify username,
 * Steam id) can reuse the helper without colliding.
 *
 * Failures to read/write localStorage (private mode quota, disabled
 * storage, etc.) are swallowed — the input still works as a plain
 * text field, the autocomplete just won't accumulate.
 */

const MAX_ENTRIES = 12;

function safeRead(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Defensive: filter to non-empty strings in case a previous
    // schema or external write left junk in storage.
    return parsed.filter(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
  } catch {
    return [];
  }
}

function safeWrite(key: string, values: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    /* ignore — see file header */
  }
}

/**
 * Return the current history for `storageKey`, most-recent first.
 * Always returns an array (never null) so callers can spread it into
 * UI lists unconditionally.
 */
export function loadUsernameHistory(storageKey: string): string[] {
  return safeRead(storageKey);
}

/**
 * Record `value` as the most-recently-used entry. Trims and dedups
 * case-sensitively (AniList usernames are case-sensitive on the
 * platform side, so 'Robert' and 'robert' are distinct accounts).
 * Caps at `MAX_ENTRIES` to keep the dropdown short.
 *
 * Returns the new list so the caller can update local React state
 * without a re-read round-trip.
 */
export function addUsernameToHistory(
  storageKey: string,
  value: string,
): string[] {
  const trimmed = value.trim();
  if (!trimmed) return loadUsernameHistory(storageKey);
  const current = loadUsernameHistory(storageKey);
  const filtered = current.filter((v) => v !== trimmed);
  const next = [trimmed, ...filtered].slice(0, MAX_ENTRIES);
  safeWrite(storageKey, next);
  return next;
}

/**
 * Remove a specific entry by value. Used by the "× clear this one"
 * affordance in the UI — gives users the per-entry deletion that
 * `<datalist>` itself doesn't support (native browser autofill has
 * Shift+Delete, but our localStorage fallback needs its own
 * removal handle).
 */
export function removeUsernameFromHistory(
  storageKey: string,
  value: string,
): string[] {
  const current = loadUsernameHistory(storageKey);
  const next = current.filter((v) => v !== value);
  if (next.length === current.length) return current;
  safeWrite(storageKey, next);
  return next;
}

/**
 * Wipe the entire history for `storageKey`. Used by the "Clear
 * history" link next to the input.
 */
export function clearUsernameHistory(storageKey: string): void {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    /* ignore */
  }
}
