import { describe, expect, it } from 'vitest';
import {
  estimatedSlotMenuHeight,
  shouldOpenSlotMenuUp,
} from '../pathStepVisual';

describe('shouldOpenSlotMenuUp', () => {
  it('keeps the menu below when there is room', () => {
    const anchor = { top: 100, bottom: 140 };
    expect(shouldOpenSlotMenuUp(anchor, estimatedSlotMenuHeight(2), 900)).toBe(false);
  });

  it('opens upward when the slot sits near the bottom of the viewport', () => {
    const anchor = { top: 800, bottom: 840 };
    expect(shouldOpenSlotMenuUp(anchor, estimatedSlotMenuHeight(2), 900)).toBe(true);
  });
});
