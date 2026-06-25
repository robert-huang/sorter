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

// Most existing tests assert raw role passthrough — they predate the
// "key production roles" filter, so they opt back into the old "all roles"
// behavior. The filter has its own dedicated test below.
const OPTS_INTERSECT_ALL_ROLES = {
  includeAll: false,
  productionAllRoles: true,
} as const;

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
    const sections = buildCompareSections([showA, showB], OPTS_INTERSECT_ALL_ROLES);
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
    const sections = buildCompareSections([left, right], OPTS_INTERSECT_ALL_ROLES);
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
    const sections = buildCompareSections([left, right], OPTS_INTERSECT_ALL_ROLES);
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
    const sections = buildCompareSections([kimi, tenki, suzume], OPTS_INTERSECT_ALL_ROLES);
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
    const sections = buildCompareSections([left, right], OPTS_INTERSECT_ALL_ROLES);
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
    const sections = buildCompareSections([left, right], OPTS_INTERSECT_ALL_ROLES);
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
    const sections = buildCompareSections([tenki, kimi, kotonoha], OPTS_INTERSECT_ALL_ROLES);
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
    const sections = buildCompareSections([left, right], OPTS_INTERSECT_ALL_ROLES);
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
    const sections = buildCompareSections([left, right], { includeAll: true, productionAllRoles: true });

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

  it('productionAllRoles=false keeps only key production roles and drops staff with no key roles', () => {
    // Director + Music are key; Storyboard + Production Assistant are not.
    const left = bundle(1, 'Left', {
      productionStaff: {
        '10': { name: 'Director-san', roles: ['Director', 'Storyboard'] },
        '11': { name: 'Storyboard-only', roles: ['Storyboard'] },
        '12': { name: 'Music-san', roles: ['Music'] },
      },
    });
    const right = bundle(2, 'Right', {
      productionStaff: {
        '10': { name: 'Director-san', roles: ['Storyboard', 'Director'] },
        '11': { name: 'Storyboard-only', roles: ['Storyboard'] },
        '12': { name: 'Music-san', roles: ['Music'] },
      },
    });

    const filteredSections = buildCompareSections([left, right], {
      includeAll: false,
      productionAllRoles: false,
    });
    const prod = filteredSections.find((s) => s.title === 'Production Staff');
    // Storyboard-only is dropped entirely; Director-san's Storyboard cell is stripped.
    expect(prod?.rows.map((row) => ({ id: row.entityId, cells: row.cells }))).toEqual([
      { id: 10, cells: ['Director', 'Director'] },
      { id: 12, cells: ['Music', 'Music'] },
    ]);

    // Sanity: turning the flag on restores Storyboard credits.
    const allSections = buildCompareSections([left, right], {
      includeAll: false,
      productionAllRoles: true,
    });
    const allProd = allSections.find((s) => s.title === 'Production Staff');
    const allRoleCells = allProd?.rows.flatMap((row) => row.cells) ?? [];
    expect(allRoleCells).toContain('Storyboard');
    expect(allProd?.rows.some((row) => row.entityId === 11)).toBe(true);
  });

  it('productionAllRoles=false leaves Studios and Voice Actors untouched', () => {
    // Studios use 'Main'/'Supporting' labels — those would be filtered out
    // if the filter were applied indiscriminately. VAs use free-form
    // character labels and would also be wiped.
    const left = bundle(1, 'Left', {
      studios: { '5': { name: 'Studio A', roles: ['Main'] } },
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
      studios: { '5': { name: 'Studio A', roles: ['Main'] } },
      voiceActors: {
        '20': {
          name: 'VA One',
          roles: ['MAIN Alice'],
          roleCharacterIds: [100],
          relevanceOrder: 0,
        },
      },
    });

    const sections = buildCompareSections([left, right], {
      includeAll: false,
      productionAllRoles: false,
    });
    expect(sections.find((s) => s.title === 'Studios')?.rows).toHaveLength(1);
    expect(sections.find((s) => s.title === 'Voice Actors (JP)')?.rows).toHaveLength(1);
  });

  it('finalizeSharedStaffResult returns empty when no overlap', () => {
    const onlyA = bundle(3, 'Lonely', {
      studios: { '5': { name: 'Studio', roles: ['Main'] } },
    });
    const onlyB = bundle(4, 'Also Lonely', {
      studios: { '6': { name: 'Other', roles: ['Main'] } },
    });
    const result = finalizeSharedStaffResult([onlyA, onlyB], OPTS_INTERSECT_ALL_ROLES);
    expect(result.kind).toBe('empty');
  });

  it('finalizeSharedStaffResult keeps single-show report without overlap table', () => {
    const source = bundle(1, 'Source');
    const top = bundle(2, 'Top Match');
    const result = finalizeSharedStaffResult(
      [source, top],
      OPTS_INTERSECT_ALL_ROLES,
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
