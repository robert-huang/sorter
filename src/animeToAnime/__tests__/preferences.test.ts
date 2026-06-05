import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROUND_CONFIG_KEY,
  loadRoundConfig,
  saveRoundConfig,
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
