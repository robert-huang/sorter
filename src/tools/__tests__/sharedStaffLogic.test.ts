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

  it('aligns roles shared only on later shows when the anchor lacks them', () => {
    const kimi = bundle(1, 'Kimi no Na Wa', {
      productionStaff: {
        '1': {
          name: 'Makoto Shinkai',
          roles: ['Storyboard', 'Editing'],
        },
      },
    });
    const tenki = bundle(2, 'Tenki no Ko', {
      productionStaff: {
        '1': {
          name: 'Makoto Shinkai',
          roles: ['Storyboard', 'Image Board'],
        },
      },
    });
    const suzume = bundle(3, 'Suzume', {
      productionStaff: {
        '1': {
          name: 'Makoto Shinkai',
          roles: ['Storyboard', 'Editing', 'Image Board'],
        },
      },
    });
    const sections = buildCompareSections([kimi, tenki, suzume], false);
    const prod = sections.find((s) => s.title === 'Production Staff');
    expect(prod?.rows.map((row) => row.cells)).toEqual([
      ['Storyboard', 'Storyboard', 'Storyboard'],
      ['Editing', '', 'Editing'],
      ['', 'Image Board', 'Image Board'],
    ]);
  });

  it('keeps studio Main/Supporting on one row per show', () => {
    const left = bundle(1, 'Left', {
      studios: {
        '5': { name: 'CoMix Wave', roles: ['Main'] },
      },
    });
    const right = bundle(2, 'Right', {
      studios: {
        '5': { name: 'CoMix Wave', roles: ['Supporting', 'Main'] },
      },
    });
    const sections = buildCompareSections([left, right], false);
    const studios = sections.find((s) => s.title === 'Studios');
    expect(studios?.rows).toHaveLength(1);
    expect(studios?.rows[0]?.cells).toEqual(['Main', 'Supporting, Main']);
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

  it('aligns VA roles by character id when the anchor show lacks that character', () => {
    const yukinoId = 88530;
    const tenki = bundle(1, 'Tenki no Ko', {
      voiceActors: {
        '95079': {
          name: 'Kana Hanazawa',
          roles: ['MAIN Natsumi'],
          roleCharacterIds: [1001],
          relevanceOrder: 0,
        },
      },
    });
    const kimi = bundle(2, 'Kimi no Na Wa', {
      voiceActors: {
        '95079': {
          name: 'Kana Hanazawa',
          roles: ['MAIN Mitsuha Miyamizu', 'BACKGROUND Yukari Yukino'],
          roleCharacterIds: [1002, yukinoId],
          relevanceOrder: 1,
        },
      },
    });
    const kotonoha = bundle(3, 'Kotonoha no Niwa', {
      voiceActors: {
        '95079': {
          name: 'Kana Hanazawa',
          roles: ['MAIN Yukari Yukino'],
          roleCharacterIds: [yukinoId],
          relevanceOrder: 0,
        },
      },
    });
    const sections = buildCompareSections([tenki, kimi, kotonoha], false);
    const vas = sections.find((s) => s.title === 'Voice Actors (JP)');
    expect(vas?.rows.map((row) => row.cells)).toEqual([
      ['MAIN Natsumi', '', ''],
      ['', 'MAIN Mitsuha Miyamizu', ''],
      ['', 'BACKGROUND Yukari Yukino', 'MAIN Yukari Yukino'],
    ]);
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

  it('includeAll=true unions entities across shows and leaves cells blank where missing', () => {
    const left = bundle(1, 'Left', {
      studios: {
        '5': { name: 'Studio A', roles: ['Main'] },
      },
      productionStaff: {
        '10': { name: 'Director', roles: ['Director'] },
      },
    });
    const right = bundle(2, 'Right', {
      studios: {
        '6': { name: 'Studio B', roles: ['Main'] },
      },
      productionStaff: {
        '10': { name: 'Director', roles: ['Storyboard'] },
        '11': { name: 'Composer', roles: ['Music'] },
      },
    });
    const sections = buildCompareSections([left, right], true);

    const studios = sections.find((s) => s.title === 'Studios');
    expect(studios?.rows).toEqual([
      expect.objectContaining({ entityId: 5, name: 'Studio A', cells: ['Main', ''] }),
      expect.objectContaining({ entityId: 6, name: 'Studio B', cells: ['', 'Main'] }),
    ]);

    const prod = sections.find((s) => s.title === 'Production Staff');
    expect(prod?.rows.map((row) => ({ id: row.entityId, name: row.name, cells: row.cells }))).toEqual([
      { id: 10, name: 'Director', cells: ['Director', ''] },
      { id: 10, name: '', cells: ['', 'Storyboard'] },
      { id: 11, name: 'Composer', cells: ['', 'Music'] },
    ]);
  });

  it('finalizeSharedStaffResult returns empty when no overlap', () => {
    const onlyA = bundle(3, 'Lonely', {
      studios: { '5': { name: 'Studio', roles: ['Main'] } },
    });
    const onlyB = bundle(4, 'Also Lonely', {
      studios: { '6': { name: 'Other', roles: ['Main'] } },
    });
    const result = finalizeSharedStaffResult([onlyA, onlyB], { includeAll: false });
    expect(result.kind).toBe('empty');
  });

  it('finalizeSharedStaffResult keeps single-show report without overlap table', () => {
    const source = bundle(1, 'Source');
    const top = bundle(2, 'Top Match');
    const result = finalizeSharedStaffResult(
      [source, top],
      { includeAll: false },
      {
        sourceTitle: 'Source',
        topOverall: [{ mediaId: 2, title: 'Top Match', coverImage: null, sharedStaffCount: 4 }],
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
