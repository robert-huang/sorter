/**
 * Return a new array containing the same elements in a uniformly random
 * order (Fisher–Yates). Does not mutate the input. No-op copy for length
 * ≤ 1.
 */
export function shuffledCopy<T>(
  items: readonly T[],
  random: () => number = Math.random,
): T[] {
  if (items.length <= 1) return [...items];
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
