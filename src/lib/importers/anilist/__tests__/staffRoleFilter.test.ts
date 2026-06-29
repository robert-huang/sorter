import { describe, expect, it } from 'vitest';
import {
  isKeyProductionRole,
  normalizeProductionRoleForCompare,
  normalizeProductionRoleForMatch,
  productionRoleRankIndex,
  sortProductionRoleRowsByRank,
} from '../staffRoleFilter';

describe('normalizeProductionRoleForMatch', () => {
  it('strips trailing parentheticals and chief / assistant prefixes', () => {
    expect(normalizeProductionRoleForMatch('Episode Director (ep 1)')).toBe('episode director');
    expect(normalizeProductionRoleForMatch('Chief Animation Director (ep 4)')).toBe(
      'animation director',
    );
    expect(normalizeProductionRoleForMatch('Assistant Director')).toBe('director');
    expect(normalizeProductionRoleForMatch('Chief Assistant Animation Director')).toBe(
      'animation director',
    );
  });
});

describe('normalizeProductionRoleForCompare', () => {
  it('strips parentheticals but keeps rank prefixes distinct', () => {
    expect(normalizeProductionRoleForCompare('Animation Director (eps 1-4)')).toBe(
      'animation director',
    );
    expect(normalizeProductionRoleForCompare('Chief Animation Director')).toBe(
      'chief animation director',
    );
    expect(normalizeProductionRoleForCompare('Animation Director')).toBe('animation director');
  });
});

describe('productionRoleRankIndex', () => {
  it('orders Executive before Chief before base before Assistant', () => {
    expect(productionRoleRankIndex('Executive Animation Director')).toBe(0);
    expect(productionRoleRankIndex('Chief Animation Director')).toBe(1);
    expect(productionRoleRankIndex('Animation Director')).toBe(2);
    expect(productionRoleRankIndex('Assistant Animation Director')).toBe(3);
    expect(productionRoleRankIndex('Chief Animation Director')).toBeLessThan(
      productionRoleRankIndex('Animation Director'),
    );
  });
});

describe('sortProductionRoleRowsByRank', () => {
  it('orders rank variants of the same base role senior-first', () => {
    expect(
      sortProductionRoleRowsByRank([
        ['Animation Director', ''],
        ['', 'Chief Animation Director'],
      ]),
    ).toEqual([
      ['', 'Chief Animation Director'],
      ['Animation Director', ''],
    ]);
  });
});

describe('isKeyProductionRole', () => {
  it('matches director roles exactly, including episode suffixes', () => {
    expect(isKeyProductionRole('Director')).toBe(true);
    expect(isKeyProductionRole('Chief Animation Director')).toBe(true);
    expect(isKeyProductionRole('Episode Director')).toBe(true);
    expect(isKeyProductionRole('Episode Director (ep 1)')).toBe(true);
    expect(isKeyProductionRole('Chief Animation Director (ep 4)')).toBe(true);
  });

  it('rejects roles that only partially overlap a key title', () => {
    expect(isKeyProductionRole('Mechanical Episode Director')).toBe(false);
    expect(isKeyProductionRole('Key Animation')).toBe(false);
    expect(isKeyProductionRole('In-Between Animation')).toBe(false);
  });

  it('matches assistant-prefixed key roles after prefix strip', () => {
    expect(isKeyProductionRole('Assistant Director')).toBe(true);
    expect(isKeyProductionRole('Assistant Animation Director (ep 2)')).toBe(true);
  });

  it('matches character design and color roles', () => {
    expect(isKeyProductionRole('Character Design')).toBe(true);
    expect(isKeyProductionRole('Original Character Design')).toBe(true);
    expect(isKeyProductionRole('Color Design')).toBe(true);
  });

  it('matches writing and creator roles', () => {
    expect(isKeyProductionRole('Original Creator')).toBe(true);
    expect(isKeyProductionRole('Original Story')).toBe(true);
    expect(isKeyProductionRole('Script')).toBe(true);
    expect(isKeyProductionRole('Series Composition')).toBe(true);
    expect(isKeyProductionRole('Script (ep 3)')).toBe(true);
  });

  it('matches music and theme song credits, including format suffixes', () => {
    expect(isKeyProductionRole('Music')).toBe(true);
    expect(isKeyProductionRole('Music Performance')).toBe(true);
    expect(isKeyProductionRole('Music Composition (OP)')).toBe(true);
    expect(isKeyProductionRole('Music Lyrics')).toBe(true);
    expect(isKeyProductionRole('Theme Song Performance')).toBe(true);
    expect(isKeyProductionRole('Theme Song Composition (ED)')).toBe(true);
  });

  it('rejects non-key production credits', () => {
    expect(isKeyProductionRole('Theme Song Arrangement (ED)')).toBe(false);
    expect(isKeyProductionRole('Music Producer')).toBe(false);
  });
});
