import { describe, expect, it } from 'vitest';
import {
  pushAnilistDetailTarget,
  type AnilistDetailTarget,
} from '../AnilistDetailModalStack';

const media = (
  mediaId: number,
  fallbackTitle = `Media ${mediaId}`,
): AnilistDetailTarget => ({
  kind: 'media',
  mediaId,
  fallbackTitle,
});

const staff = (
  staffId: number,
  fallbackName = `Staff ${staffId}`,
): AnilistDetailTarget => ({
  kind: 'staff',
  staffId,
  fallbackName,
});

describe('AniList detail modal stack', () => {
  it('keeps media behind a staff modal opened from it', () => {
    const withMedia = pushAnilistDetailTarget([], media(1));
    const stack = pushAnilistDetailTarget(withMedia, staff(10));

    expect(stack).toEqual([media(1), staff(10)]);
  });

  it('keeps the opposite type and replaces the previous same-type modal', () => {
    let stack = pushAnilistDetailTarget([], media(1));
    stack = pushAnilistDetailTarget(stack, staff(10));
    stack = pushAnilistDetailTarget(stack, media(2));

    expect(stack).toEqual([staff(10), media(2)]);

    stack = pushAnilistDetailTarget(stack, staff(20));

    expect(stack).toEqual([media(2), staff(20)]);
    expect(stack).toHaveLength(2);
  });

  it('promotes the retained previous media without duplicating it', () => {
    let stack = pushAnilistDetailTarget([], media(1));
    stack = pushAnilistDetailTarget(stack, staff(10));
    stack = pushAnilistDetailTarget(stack, media(1));

    expect(stack).toEqual([staff(10), media(1)]);
    expect(stack).toHaveLength(2);
  });

  it('never retains more than two layers', () => {
    const oversizedStack: AnilistDetailTarget[] = [
      media(1),
      staff(10),
      media(2),
    ];

    expect(pushAnilistDetailTarget(oversizedStack, staff(20))).toEqual([
      media(2),
      staff(20),
    ]);
  });
});
