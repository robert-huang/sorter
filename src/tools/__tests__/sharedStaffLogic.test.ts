import { describe, expect, it } from 'vitest';
import {
  buildCompareSections,
  finalizeSharedStaffResult,
  type ShowStaffBundle,
} from '../panels/sharedStaffLogic';

function bundle(
  id: number,
  title: string,
  overrides: Partial<Pick<ShowStaffBundle, 'studios' | 'productionStaff' | 'voiceActors'>> = {},
): ShowStaffBundle {
  return {
    id,
    title,
    studios: {},
    productionStaff: {},
    voiceActors: {},
    ...overrides,
  };
}

describe('sharedStaffLogic', () => {
  const showA = bundle(1, 'A', {
    productionStaff: {
      '10': { name: 'Director', roles: ['Director'] },
    },
    voiceActors: {
      '20': { name: 'VA One', roles: ['MAIN Alice'] },
    },
  });
  const showB = bundle(2, 'B', {
    productionStaff: {
      '10': { name: 'Director', roles: ['Storyboard'] },
      '11': { name: 'Composer', roles: ['Music'] },
    },
    voiceActors: {
      '20': { name: 'VA One', roles: ['MAIN Bob'] },
    },
  });

  it('buildCompareSections finds common production staff and VAs', () => {
    const sections = buildCompareSections([showA, showB], false);
    const titles = sections.map((s) => s.title);
    expect(titles).toContain('Production Staff');
    expect(titles).toContain('Voice Actors (JP)');

    const prod = sections.find((s) => s.title === 'Production Staff');
    expect(prod?.rows[0]?.entityId).toBe(10);
    expect(prod?.rows[0]?.cells).toEqual(['Director', 'Storyboard']);
  });

  it('finalizeSharedStaffResult returns empty when no overlap', () => {
    const onlyA = bundle(3, 'Lonely', {
      studios: { '5': { name: 'Studio', roles: ['Main'] } },
    });
    const onlyB = bundle(4, 'Also Lonely', {
      studios: { '6': { name: 'Other', roles: ['Main'] } },
    });
    const result = finalizeSharedStaffResult([onlyA, onlyB], { diffMode: false });
    expect(result.kind).toBe('empty');
  });

  it('finalizeSharedStaffResult keeps single-show report without overlap table', () => {
    const source = bundle(1, 'Source');
    const top = bundle(2, 'Top Match');
    const result = finalizeSharedStaffResult(
      [source, top],
      { diffMode: false },
      {
        sourceTitle: 'Source',
        topOverall: [{ mediaId: 2, title: 'Top Match', sharedStaffCount: 4 }],
        byCategory: [],
      },
    );
    expect(result.kind).toBe('compare');
    if (result.kind === 'compare') {
      expect(result.sections).toHaveLength(0);
      expect(result.singleShowReport?.topOverall).toHaveLength(1);
    }
  });
});
