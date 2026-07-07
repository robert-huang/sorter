import { describe, expect, it } from 'vitest';
import {
  buildToggleFavouriteMutation,
  buildUpdateFavouriteOrderMutation,
  favouriteOrderPayload,
  UPDATE_FAVOURITE_ORDER_MUTATION,
} from '../favouriteMutations';

describe('buildUpdateFavouriteOrderMutation', () => {
  it('uses the full AniList mutation shape with only the active type in variables', () => {
    const built = buildUpdateFavouriteOrderMutation('CHARACTERS', {
      ids: [10, 20],
      order: [1, 2],
    });
    expect(built.query).toBe(UPDATE_FAVOURITE_ORDER_MUTATION);
    expect(built.query).toContain('$characterIds: [Int]');
    expect(built.query).toContain('$staffOrder: [Int]');
    expect(built.query).toContain('pageInfo');
    expect(built.variables).toEqual({
      characterIds: [10, 20],
      characterOrder: [1, 2],
    });
  });

  it('builds staff variables for staff favourites', () => {
    const built = buildUpdateFavouriteOrderMutation('STAFF', {
      ids: [118806, 127117],
      order: [1, 2],
    });
    expect(built.variables).toEqual({
      staffIds: [118806, 127117],
      staffOrder: [1, 2],
    });
  });
});

describe('buildToggleFavouriteMutation', () => {
  it('builds staff toggle mutation', () => {
    const built = buildToggleFavouriteMutation('STAFF', 99);
    expect(built.query).toContain('ToggleFavourite');
    expect(built.query).toContain('$staffId: Int');
    expect(built.variables).toEqual({ staffId: 99 });
  });
});

describe('favouriteOrderPayload', () => {
  it('assigns ascending one-based order', () => {
    expect(favouriteOrderPayload([5, 9, 2])).toEqual({
      ids: [5, 9, 2],
      order: [1, 2, 3],
    });
  });
});
