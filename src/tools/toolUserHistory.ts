export const TOOL_USER_HISTORY_LS_KEY = 'anime-tools-user-history';
const MAX_HISTORY = 50;

/** Previously used usernames, most recent first. Shared by every multi-user tool. */
export function loadToolUserHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TOOL_USER_HISTORY_LS_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  } catch {
    return [];
  }
}

function saveToolUserHistory(history: readonly string[]): string[] {
  const next = history.slice(0, MAX_HISTORY);
  try {
    localStorage.setItem(TOOL_USER_HISTORY_LS_KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable; the dropdown just won't remember this name.
  }
  return next;
}

const sameUser = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function rememberToolUser(username: string): string[] {
  const handle = username.trim();
  if (!handle) return loadToolUserHistory();
  const rest = loadToolUserHistory().filter((name) => !sameUser(name, handle));
  return saveToolUserHistory([handle, ...rest]);
}

export function forgetToolUser(username: string): string[] {
  return saveToolUserHistory(loadToolUserHistory().filter((name) => !sameUser(name, username)));
}

/** History entries matching the typed text (substring, case-insensitive), minus users already added. */
export function suggestToolUsers(
  history: readonly string[],
  text: string,
  exclude: readonly string[],
): string[] {
  const query = text.trim().toLowerCase();
  return history.filter(
    (name) =>
      !exclude.some((added) => sameUser(added, name)) &&
      (!query || name.toLowerCase().includes(query)),
  );
}
