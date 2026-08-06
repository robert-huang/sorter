import { describe, expect, it } from 'vitest';
import { updateSortResultSelection } from '../SortResultsImportMode';

describe('updateSortResultSelection', () => {
  it('replaces the previous selection in single-selection mode', () => {
    const selected = updateSortResultSelection(
      new Set(['slot-a']),
      'slot-b',
      true,
      'single',
    );
    expect([...selected]).toEqual(['slot-b']);
  });

  it('preserves independent selections in multiple-selection mode', () => {
    const selected = updateSortResultSelection(
      new Set(['slot-a']),
      'slot-b',
      true,
      'multiple',
    );
    expect([...selected]).toEqual(['slot-a', 'slot-b']);
  });
});
