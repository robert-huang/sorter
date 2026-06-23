import { describe, expect, it } from 'vitest';
import {
  bestProductionRolePriorityIndex,
  compareProductionStaffByRolePriority,
  productionRolePriorityIndex,
  sortProductionRolesByPriority,
} from '../productionRolePriority';

describe('productionRolePriority', () => {
  it('normalizes chief/assistant and parentheticals for priority lookup', () => {
    expect(productionRolePriorityIndex('Chief Animation Director')).toBe(
      productionRolePriorityIndex('Animation Director'),
    );
    expect(productionRolePriorityIndex('Episode Director (ep 3)')).toBe(
      productionRolePriorityIndex('Episode Director'),
    );
  });

  it('sortProductionRolesByPriority lists highest-priority role first', () => {
    expect(
      sortProductionRolesByPriority(['Music', 'Director', 'Theme Song Lyrics (ED)']),
    ).toEqual(['Director', 'Music', 'Theme Song Lyrics (ED)']);
  });

  it('bestProductionRolePriorityIndex uses the most senior role', () => {
    expect(bestProductionRolePriorityIndex(['Music', 'Director'])).toBe(
      productionRolePriorityIndex('Director'),
    );
  });

  it('compareProductionStaffByRolePriority breaks ties on minSortOrder then staff id', () => {
    const directorFirst = compareProductionStaffByRolePriority(
      { roles: ['Director'], minSortOrder: 5, staffId: 2 },
      { roles: ['Music'], minSortOrder: 0, staffId: 1 },
    );
    expect(directorFirst).toBeLessThan(0);

    const sameRoleLowerSort = compareProductionStaffByRolePriority(
      { roles: ['Animation Director'], minSortOrder: 1, staffId: 9 },
      { roles: ['Animation Director'], minSortOrder: 4, staffId: 1 },
    );
    expect(sameRoleLowerSort).toBeLessThan(0);

    const sameRoleSameSort = compareProductionStaffByRolePriority(
      { roles: ['Script'], minSortOrder: 0, staffId: 2 },
      { roles: ['Script'], minSortOrder: 0, staffId: 5 },
    );
    expect(sameRoleSameSort).toBeLessThan(0);
  });
});
