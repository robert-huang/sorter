import { describe, expect, it } from 'vitest';
import {
  anyTrimmedRoleInSet,
  MUSIC_ROLES,
  trimProductionRole,
  trimmedRoleInSet,
  VISUALS_ROLES,
  WRITING_ROLES,
} from '../../lib/importers/anilist/staffRoleBuckets';

describe('trimProductionRole', () => {
  it('strips parentheticals (episode tags, OP/ED markers)', () => {
    expect(trimProductionRole('Storyboard (ep 3)')).toBe('Storyboard');
    expect(trimProductionRole('Theme Song Performance (OP)')).toBe(
      'Theme Song Performance',
    );
  });

  it('strips IGNORABLE_KEYWORDS so Chief/Assistant/etc. collapse', () => {
    expect(trimProductionRole('Chief Director')).toBe('Director');
    expect(trimProductionRole('Assistant Director')).toBe('Director');
    expect(trimProductionRole('Chief Animation Director')).toBe('Animation');
  });

  it('passes already-trimmed roles through unchanged', () => {
    expect(trimProductionRole('Producer')).toBe('Producer');
    expect(trimProductionRole('Key Animation')).toBe('Key Animation');
  });

  it('falls back to "unknown" for empty input', () => {
    expect(trimProductionRole('')).toBe('unknown');
  });

  it('falls back to the last word when every word is ignorable', () => {
    // `Chief Producer` is ALL ignorable words; we keep the trailing word
    // rather than returning an empty bucket key.
    expect(trimProductionRole('Chief Producer')).toBe('Producer');
  });

  it('collapses whitespace via split (multi-space inputs survive)', () => {
    expect(trimProductionRole('  Chief   Director  ')).toBe('Director');
  });
});

describe('trimmedRoleInSet / anyTrimmedRoleInSet bucket membership', () => {
  it('MUSIC bucket: OP/ED theme variants normalize and match', () => {
    expect(trimmedRoleInSet('Theme Song Performance (OP)', MUSIC_ROLES)).toBe(true);
    expect(trimmedRoleInSet('Theme Song Composition (ED)', MUSIC_ROLES)).toBe(true);
    expect(trimmedRoleInSet('Music', MUSIC_ROLES)).toBe(true);
  });

  it('MUSIC bucket: animation roles do NOT match', () => {
    expect(trimmedRoleInSet('Key Animation', MUSIC_ROLES)).toBe(false);
    expect(trimmedRoleInSet('Storyboard', MUSIC_ROLES)).toBe(false);
  });

  it('VISUALS bucket spans both ART and ANIMATION', () => {
    expect(trimmedRoleInSet('Character Design', VISUALS_ROLES)).toBe(true);
    expect(trimmedRoleInSet('Key Animation', VISUALS_ROLES)).toBe(true);
    expect(trimmedRoleInSet('Script', VISUALS_ROLES)).toBe(false);
  });

  it('WRITING bucket: trims episode tags before lookup', () => {
    expect(trimmedRoleInSet('Storyboard (ep 7)', WRITING_ROLES)).toBe(true);
    expect(trimmedRoleInSet('Series Composition', WRITING_ROLES)).toBe(true);
    expect(trimmedRoleInSet('Key Animation', WRITING_ROLES)).toBe(false);
  });

  it('anyTrimmedRoleInSet returns true if at least one role hits', () => {
    expect(
      anyTrimmedRoleInSet(['Producer', 'Storyboard (ep 1)'], WRITING_ROLES),
    ).toBe(true);
    expect(anyTrimmedRoleInSet(['Producer'], WRITING_ROLES)).toBe(false);
    expect(anyTrimmedRoleInSet([], WRITING_ROLES)).toBe(false);
  });
});
