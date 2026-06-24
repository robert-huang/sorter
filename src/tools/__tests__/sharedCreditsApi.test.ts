import { describe, expect, it } from 'vitest';
import {
  normalizeStaffNameFieldsFromCache,
  normalizeStaffShowMapFromCache,
  pickStaffSearchMatch,
} from '../panels/sharedCreditsApi';

describe('pickStaffSearchMatch', () => {
  const hit = { id: 95185, name: { full: 'Kana Hanazawa' } };

  it('reads a singleton Staff search result', () => {
    expect(pickStaffSearchMatch(hit)).toEqual(hit);
  });

  it('reads the first row from a Page-style staff list', () => {
    expect(pickStaffSearchMatch([hit, { id: 2, name: { full: 'Other' } }])).toEqual(hit);
  });

  it('returns null for empty results', () => {
    expect(pickStaffSearchMatch(null)).toBeNull();
    expect(pickStaffSearchMatch([])).toBeNull();
  });
});

describe('normalizeStaffNameFieldsFromCache', () => {
  it('upgrades legacy plain-string name caches', () => {
    expect(
      normalizeStaffNameFieldsFromCache([10, 20], {
        10: 'VA A',
        20: 'VA B',
      }),
    ).toEqual({
      10: { id: 10, name_full: 'VA A', name_native: null, image: null },
      20: { id: 20, name_full: 'VA B', name_native: null, image: null },
    });
  });

  it('accepts current PersonNameFields rows', () => {
    expect(
      normalizeStaffNameFieldsFromCache([10], {
        10: { id: 10, name_full: 'VA A', name_native: 'ネイティブ', image: 'img' },
      }),
    ).toEqual({
      10: { id: 10, name_full: 'VA A', name_native: 'ネイティブ', image: 'img' },
    });
  });
});

describe('normalizeStaffShowMapFromCache', () => {
  it('upgrades legacy string role lists', () => {
    expect(
      normalizeStaffShowMapFromCache({
        1: {
          title: 'Show A',
          roles: ['Alice (MAIN)', 'Bob (SUPPORTING)'],
          startDate: '20200101',
        },
      }),
    ).toEqual({
      1: {
        title: 'Show A',
        coverImage: null,
        roles: [{ label: 'Alice (MAIN)' }, { label: 'Bob (SUPPORTING)' }],
        startDate: '20200101',
        titleSource: undefined,
      },
    });
  });
});
