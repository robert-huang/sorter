import { describe, expect, it } from 'vitest';
import {
  buildCompareSections,
  finalizeSharedStaffResult,
  mergeVaRoleIntoMap,
  type CreditedEntityMap,
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
      '20': { name: 'VA One', roles: ['MAIN Alice'], relevanceOrder: 0 },
    },
  });
  const showB = bundle(2, 'B', {
    productionStaff: {
      '10': { name: 'Director', roles: ['Storyboard'] },
      '11': { name: 'Composer', roles: ['Music'] },
    },
    voiceActors: {
      '20': { name: 'VA One', roles: ['MAIN Bob'], relevanceOrder: 0 },
    },
  });

  it('buildCompareSections finds common production staff and VAs', () => {
    const sections = buildCompareSections([showA, showB], false);
    const titles = sections.map((s) => s.title);
    expect(titles).toContain('Production Staff');
    expect(titles).toContain('Voice Actors (JP)');

    const prod = sections.find((s) => s.title === 'Production Staff');
    expect(prod?.rows[0]?.entityId).toBe(10);
    expect(prod?.rows[0]?.cells).toEqual(['Director', '']);
    expect(prod?.rows[1]?.cells).toEqual(['', 'Storyboard']);
  });

  it('aligns matching roles on the same row across shows', () => {
    const left = bundle(1, 'Left', {
      productionStaff: {
        '1': { name: 'Person', roles: ['roleA', 'roleB'] },
      },
    });
    const right = bundle(2, 'Right', {
      productionStaff: {
        '1': { name: 'Person', roles: ['roleB'] },
      },
    });
    const sections = buildCompareSections([left, right], false);
    const prod = sections.find((s) => s.title === 'Production Staff');
    expect(prod?.rows.map((row) => row.cells)).toEqual([
      ['roleA', ''],
      ['roleB', 'roleB'],
    ]);
  });

  it('reorders non-anchor show roles to match the anchor order', () => {
    const left = bundle(1, 'Left', {
      productionStaff: {
        '1': { name: 'Person', roles: ['roleB'] },
      },
    });
    const right = bundle(2, 'Right', {
      productionStaff: {
        '1': { name: 'Person', roles: ['roleA', 'roleB'] },
      },
    });
    const sections = buildCompareSections([left, right], false);
    const prod = sections.find((s) => s.title === 'Production Staff');
    expect(prod?.rows.map((row) => row.cells)).toEqual([
      ['roleB', 'roleB'],
      ['', 'roleA'],
    ]);
  });

  it('aligns VA roles by character id across different cast roles', () => {
    const left = bundle(1, 'Left', {
      voiceActors: {
        '20': {
          name: 'VA One',
          roles: ['MAIN Alice'],
          roleCharacterIds: [100],
          relevanceOrder: 0,
        },
      },
    });
    const right = bundle(2, 'Right', {
      voiceActors: {
        '20': {
          name: 'VA One',
          roles: ['SUPPORTING Alice'],
          roleCharacterIds: [100],
          relevanceOrder: 0,
        },
      },
    });
    const sections = buildCompareSections([left, right], false);
    const vas = sections.find((s) => s.title === 'Voice Actors (JP)');
    expect(vas?.rows).toHaveLength(1);
    expect(vas?.rows[0]?.cells).toEqual(['MAIN Alice', 'SUPPORTING Alice']);
  });

  it('mergeVaRoleIntoMap collapses duplicate character credits within a show', () => {
    const map: CreditedEntityMap = {};
    mergeVaRoleIntoMap(map, 20, 'VA One', 100, 'MAIN Alice');
    mergeVaRoleIntoMap(map, 20, 'VA One', 100, 'SUPPORTING Alice');
    expect(map['20']?.roles).toEqual(['MAIN/SUPPORTING Alice']);
    expect(map['20']?.roleCharacterIds).toEqual([100]);
  });

  it('sorts voice actors by first-show relevance order', () => {
    const left = bundle(1, 'Left', {
      voiceActors: {
        '30': { name: 'Later VA', roles: ['MAIN Zed'], relevanceOrder: 5 },
        '20': { name: 'Earlier VA', roles: ['MAIN Amy'], relevanceOrder: 1 },
      },
    });
    const right = bundle(2, 'Right', {
      voiceActors: {
        '30': { name: 'Later VA', roles: ['MAIN Zed'], relevanceOrder: 0 },
        '20': { name: 'Earlier VA', roles: ['MAIN Amy'], relevanceOrder: 0 },
      },
    });
    const sections = buildCompareSections([left, right], false);
    const vas = sections.find((s) => s.title === 'Voice Actors (JP)');
    expect(vas?.rows.filter((row) => row.name).map((row) => row.entityId)).toEqual([20, 30]);
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
