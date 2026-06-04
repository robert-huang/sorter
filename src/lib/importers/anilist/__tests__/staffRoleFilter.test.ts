import { describe, expect, it } from 'vitest';
import { isKeyProductionRole } from '../staffRoleFilter';

describe('isKeyProductionRole', () => {
  it('matches director bucket including Chief Animation Director', () => {
    expect(isKeyProductionRole('Director')).toBe(true);
    expect(isKeyProductionRole('Chief Animation Director')).toBe(true);
    expect(isKeyProductionRole('Episode Director')).toBe(true);
  });

  it('does not treat Chief Animation Director as character design', () => {
    expect(isKeyProductionRole('Character Design')).toBe(true);
    expect(isKeyProductionRole('Chief Animation Director')).toBe(true);
  });

  it('rejects animator-heavy roles', () => {
    expect(isKeyProductionRole('Key Animation')).toBe(false);
    expect(isKeyProductionRole('In-Between Animation')).toBe(false);
  });

  it('matches music and theme song credits', () => {
    expect(isKeyProductionRole('Music')).toBe(true);
    expect(isKeyProductionRole('Theme Song Performance')).toBe(true);
  });
});
