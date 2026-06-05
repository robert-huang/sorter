import { describe, expect, it } from 'vitest';
import { anilistWaitSecondsRemaining } from '../useAnilistWaitCountdown';

describe('anilistWaitSecondsRemaining', () => {
  it('returns ceiling seconds until deadline', () => {
    const now = 1_000_000;
    expect(anilistWaitSecondsRemaining(now + 3500, now)).toBe(4);
    expect(anilistWaitSecondsRemaining(now + 3000, now)).toBe(3);
    expect(anilistWaitSecondsRemaining(now + 1, now)).toBe(1);
  });

  it('returns 0 after the deadline', () => {
    const now = 1_000_000;
    expect(anilistWaitSecondsRemaining(now, now)).toBe(0);
    expect(anilistWaitSecondsRemaining(now - 500, now)).toBe(0);
  });
});
