import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROUND_CONFIG_KEY,
  STAFF_GENDER_FILTER_KEY,
  loadRoundConfig,
  loadStaffGenderFilter,
  matchesStaffGender,
  mergeLiveProductionRules,
  saveRoundConfig,
  saveStaffGenderFilter,
} from '../preferences';

describe('round config persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('returns defaults when nothing stored', () => {
    expect(loadRoundConfig()).toEqual({
      allowProduction: true,
      allowRelations: false,
      productionAllRoles: false,
    });
  });

  it('round-trips saved config', () => {
    saveRoundConfig({
      allowProduction: false,
      allowRelations: true,
      productionAllRoles: true,
    });
    expect(loadRoundConfig()).toEqual({
      allowProduction: false,
      allowRelations: true,
      productionAllRoles: true,
    });
    expect(localStorage.getItem(ROUND_CONFIG_KEY)).toBeTruthy();
  });
});

describe('mergeLiveProductionRules', () => {
  it('overlays live production toggles onto snapshotted round rules', () => {
    const snapshotted = {
      allowProduction: false,
      allowRelations: true,
      productionAllRoles: false,
    };
    expect(
      mergeLiveProductionRules(snapshotted, {
        allowProduction: true,
        productionAllRoles: true,
      }),
    ).toEqual({
      allowProduction: true,
      allowRelations: true,
      productionAllRoles: true,
    });
  });
});

describe('staff gender filter persistence', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to "any" when nothing stored', () => {
    expect(loadStaffGenderFilter()).toBe('any');
  });

  it('round-trips a saved filter', () => {
    saveStaffGenderFilter('female');
    expect(loadStaffGenderFilter()).toBe('female');
    expect(localStorage.getItem(STAFF_GENDER_FILTER_KEY)).toBe('female');
  });

  it('falls back to "any" for an unrecognized stored value', () => {
    localStorage.setItem(STAFF_GENDER_FILTER_KEY, 'other');
    expect(loadStaffGenderFilter()).toBe('any');
  });
});

describe('matchesStaffGender', () => {
  it('matches everyone under "any"', () => {
    expect(matchesStaffGender('Male', 'any')).toBe(true);
    expect(matchesStaffGender('Female', 'any')).toBe(true);
    expect(matchesStaffGender('Non-binary', 'any')).toBe(true);
    expect(matchesStaffGender(null, 'any')).toBe(true);
  });

  it('matches only the exact gender (case-insensitive)', () => {
    expect(matchesStaffGender('Male', 'male')).toBe(true);
    expect(matchesStaffGender('male', 'male')).toBe(true);
    expect(matchesStaffGender('Female', 'male')).toBe(false);
    expect(matchesStaffGender('Female', 'female')).toBe(true);
  });

  it('excludes missing and non-binary gender from male/female', () => {
    expect(matchesStaffGender(null, 'male')).toBe(false);
    expect(matchesStaffGender(undefined, 'female')).toBe(false);
    expect(matchesStaffGender('Non-binary', 'male')).toBe(false);
    expect(matchesStaffGender('Non-binary', 'female')).toBe(false);
  });
});
