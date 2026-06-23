import { describe, expect, it } from 'vitest';
import { pickStaffSearchMatch } from '../panels/sharedCreditsApi';

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
