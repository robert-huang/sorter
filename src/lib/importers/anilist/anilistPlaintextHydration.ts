import type { Item } from '../../types';

export type AnilistHydrationIssueReason =
  | 'unmatched'
  | 'ambiguous_alias'
  | 'duplicate_candidate';

export interface AnilistHydrationIssue {
  index: number;
  /** The row's id when matched; positions shift when callers re-dedupe hydrated rows. */
  itemId: string;
  label: string;
  reason: AnilistHydrationIssueReason;
  /** For `ambiguous_alias`: the entries the name matched, for a manual pick. */
  candidates?: Item[];
  /** For `duplicate_candidate`: labels of the other rows holding or claiming the entry. */
  conflicts?: string[];
}

export interface AnilistHydrationResult {
  items: Item[];
  matchedCount: number;
  /** Rows that needed hydrating; already-hydrated rows are left out of matching. */
  attemptedCount: number;
  issues: AnilistHydrationIssue[];
}

/** Already an AniList entry, e.g. from an earlier hydration against another list. */
function isHydrated(item: Item): boolean {
  if (item.source && item.source.kind !== 'manual') return true;
  return /^anilist(-staff|-character|-studios)?:\d+$/.test(item.id);
}

/** Where a still-unhydrated row is now, found by the id it had when matched. */
function currentIndex(currentItems: readonly Item[], issue: AnilistHydrationIssue): number {
  return currentItems.findIndex((item) => item.id === issue.itemId && !isHydrated(item));
}

/**
 * Applies a manual pick for an ambiguous row on top of the current items. Callers may
 * have re-deduped the list since matching (hydrated rows take AniList ids and can
 * merge), so rows are found by id and remaining issues get their current positions.
 * Null when the row is gone, e.g. the list was edited after matching.
 */
export function resolveAmbiguousHydration(
  result: AnilistHydrationResult,
  currentItems: readonly Item[],
  issue: AnilistHydrationIssue,
  candidate: Item,
): AnilistHydrationResult | null {
  const index = currentIndex(currentItems, issue);
  if (index < 0) return null;
  const items = [...currentItems];
  items[index] = candidate;
  const issues: AnilistHydrationIssue[] = [];
  for (const other of result.issues) {
    if (other === issue) continue;
    const otherIndex = currentIndex(currentItems, other);
    if (otherIndex < 0) continue;
    // The pick is now in the list, so other rows can't take it too.
    const candidates = other.candidates?.filter((c) => c.id !== candidate.id);
    issues.push({ ...other, index: otherIndex, ...(candidates ? { candidates } : {}) });
  }
  return {
    items,
    matchedCount: result.matchedCount + 1,
    attemptedCount: result.attemptedCount,
    issues,
  };
}

export function normalizeAnilistHydrationName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** The label and the entry's real titles or names, in every display language. */
function titleAliases(item: Item): string[] {
  const source = item.anilistLabelSource;
  const values = [item.label];
  if (source?.kind === 'media') {
    const { title_romaji, title_english, title_native } = source.titleFields;
    values.push(...[title_romaji, title_english, title_native].filter((v) => v !== null));
  } else if (source?.kind === 'person' || source?.kind === 'character') {
    const { name_full, name_native } = source.nameFields;
    values.push(...[name_full, name_native].filter((v) => v !== null));
  }
  return values;
}

function normalizedSet(values: readonly string[]): Set<string> {
  const aliases = new Set<string>();
  for (const value of values) {
    const normalized = normalizeAnilistHydrationName(value);
    if (normalized) aliases.add(normalized);
  }
  return aliases;
}

function aliasIndex(
  candidates: Iterable<Item>,
  aliasesOf: (item: Item) => Set<string>,
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    for (const alias of aliasesOf(candidate)) {
      const ids = index.get(alias) ?? new Set<string>();
      ids.add(candidate.id);
      index.set(alias, ids);
    }
  }
  return index;
}

/**
 * Hydrate rows that aren't AniList entries yet; hydrated rows pass through untouched.
 * Resolve only globally one-to-one exact aliases. No input-order tiebreak is
 * used: if two rows claim one candidate, both stay manual for explicit repair.
 * Real titles and names outrank search tokens (AniList synonyms): e.g. the Suntory
 * tie-in lists `Kimi no Na wa.` as a synonym, which mustn't tie with the movie.
 */
export function hydrateItemsFromExactAnilistNames(
  inputItems: readonly Item[],
  candidateItems: readonly Item[],
): AnilistHydrationResult {
  const candidatesById = new Map<string, Item>();
  for (const candidate of candidateItems) {
    candidatesById.set(candidate.id, candidate);
  }

  const titles = aliasIndex(candidatesById.values(), (c) => normalizedSet(titleAliases(c)));
  const tokens = aliasIndex(candidatesById.values(), (c) => normalizedSet(c.searchTokens ?? []));

  const proposed = new Map<number, string>();
  const issues: AnilistHydrationIssue[] = [];
  const presentIds = new Set(inputItems.filter(isHydrated).map((item) => item.id));
  let attemptedCount = 0;
  inputItems.forEach((item, index) => {
    if (isHydrated(item)) return;
    attemptedCount += 1;
    const normalized = normalizeAnilistHydrationName(item.label);
    const candidateIds = titles.get(normalized) ?? tokens.get(normalized);
    if (!candidateIds || candidateIds.size === 0) {
      issues.push({ index, itemId: item.id, label: item.label, reason: 'unmatched' });
      return;
    }
    if (candidateIds.size > 1) {
      const candidates = [...candidateIds]
        .filter((id) => !presentIds.has(id))
        .map((id) => candidatesById.get(id)!);
      issues.push({
        index,
        itemId: item.id,
        label: item.label,
        reason: 'ambiguous_alias',
        candidates,
      });
      return;
    }
    proposed.set(index, [...candidateIds][0]);
  });

  const inputsByCandidate = new Map<string, number[]>();
  for (const [index, candidateId] of proposed) {
    const indices = inputsByCandidate.get(candidateId) ?? [];
    indices.push(index);
    inputsByCandidate.set(candidateId, indices);
  }

  const items = [...inputItems];
  let matchedCount = 0;
  for (const [candidateId, indices] of inputsByCandidate) {
    // A row resolving to an entry the list already has would duplicate it.
    if (indices.length !== 1 || presentIds.has(candidateId)) {
      for (const index of indices) {
        const item = inputItems[index];
        if (item) {
          const conflicts = inputItems
            .filter((other, i) => i !== index && (indices.includes(i) || other.id === candidateId))
            .map((other) => other.label);
          issues.push({
            index,
            itemId: item.id,
            label: item.label,
            reason: 'duplicate_candidate',
            conflicts,
          });
        }
      }
      continue;
    }
    const index = indices[0];
    const candidate = candidatesById.get(candidateId);
    if (candidate && index !== undefined) {
      items[index] = candidate;
      matchedCount += 1;
    }
  }

  issues.sort((a, b) => a.index - b.index);
  return { items, matchedCount, attemptedCount, issues };
}
