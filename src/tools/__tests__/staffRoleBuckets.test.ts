import { describe, expect, it } from 'vitest';
import {
  MUSIC_ROLES,
  trimProductionRole,
  trimmedRoleInSet,
} from '../../lib/importers/anilist/staffRoleBuckets';

describe('staffRoleBuckets', () => {
  it('trimProductionRole strips parentheticals and ignorable words', () => {
    expect(trimProductionRole('Storyboard (ep 3)')).toBe('Storyboard');
    expect(trimProductionRole('Chief Director')).toBe('Director');
    expect(trimProductionRole('Producer')).toBe('Producer');
  });

  it('trimmedRoleInSet matches bucket entries', () => {
    expect(trimmedRoleInSet('Theme Song Performance (OP)', MUSIC_ROLES)).toBe(true);
    expect(trimmedRoleInSet('Key Animation', MUSIC_ROLES)).toBe(false);
  });
});
