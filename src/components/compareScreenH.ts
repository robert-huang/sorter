/** Named item labels in each compare peek deck (depths 1…COMPARE_PEEK_DEPTH). */
export const COMPARE_PEEK_DEPTH = 4;

export function peekOverflowLabel(count: number): string {
  const noun = count === 1 ? 'item' : 'items';
  return `...${count} ${noun}`;
}
