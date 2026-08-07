import type { Item } from '../../types';

export type AnilistHydrationIssueReason =
  | 'unmatched'
  | 'ambiguous_alias'
  | 'duplicate_candidate';

export interface AnilistHydrationIssue {
  index: number;
  label: string;
  reason: AnilistHydrationIssueReason;
}

export interface AnilistHydrationResult {
  items: Item[];
  matchedCount: number;
  issues: AnilistHydrationIssue[];
}

export function normalizeAnilistHydrationName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function candidateAliases(item: Item): Set<string> {
  const aliases = new Set<string>();
  for (const value of [item.label, ...(item.searchTokens ?? [])]) {
    const normalized = normalizeAnilistHydrationName(value);
    if (normalized) aliases.add(normalized);
  }
  return aliases;
}

/**
 * Resolve only globally one-to-one exact aliases. No input-order tiebreak is
 * used: if two rows claim one candidate, both stay manual for explicit repair.
 */
export function hydrateItemsFromExactAnilistNames(
  inputItems: readonly Item[],
  candidateItems: readonly Item[],
): AnilistHydrationResult {
  const candidatesById = new Map<string, Item>();
  for (const candidate of candidateItems) {
    candidatesById.set(candidate.id, candidate);
  }

  const aliases = new Map<string, Set<string>>();
  for (const candidate of candidatesById.values()) {
    for (const alias of candidateAliases(candidate)) {
      const ids = aliases.get(alias) ?? new Set<string>();
      ids.add(candidate.id);
      aliases.set(alias, ids);
    }
  }

  const proposed = new Map<number, string>();
  const issues: AnilistHydrationIssue[] = [];
  inputItems.forEach((item, index) => {
    const normalized = normalizeAnilistHydrationName(item.label);
    const candidateIds = aliases.get(normalized);
    if (!candidateIds || candidateIds.size === 0) {
      issues.push({ index, label: item.label, reason: 'unmatched' });
      return;
    }
    if (candidateIds.size > 1) {
      issues.push({ index, label: item.label, reason: 'ambiguous_alias' });
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
    if (indices.length !== 1) {
      for (const index of indices) {
        const item = inputItems[index];
        if (item) {
          issues.push({
            index,
            label: item.label,
            reason: 'duplicate_candidate',
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
  return { items, matchedCount, issues };
}
