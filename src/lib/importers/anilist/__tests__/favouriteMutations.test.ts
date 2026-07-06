import { describe, expect, it } from 'vitest';
import {
  buildToggleFavouriteMutation,
  buildUpdateFavouriteOrderMutation,
  favouriteOrderPayload,
} from '../favouriteMutations';

describe('buildUpdateFavouriteOrderMutation', () => {
  it('builds character favourite order mutation', () => {
    const built = buildUpdateFavouriteOrderMutation('CHARACTERS', {
      ids: [10, 20],
      order: [0, 1],
    });
    expect(built.query).toContain('UpdateFavouriteOrder');
    expect(built.query).toContain('$characterIds: [Int]');
    expect(built.query).toContain('$characterOrder: [Int]');
    expect(built.variables).toEqual({
      characterIds: [10, 20],
      characterOrder: [0, 1],
    });
  });

  it('builds anime favourite order mutation', () => {
    const built = buildUpdateFavouriteOrderMutation('ANIME', {
      ids: [1],
      order: [0],
    });
    expect(built.query).toContain('$animeIds: [Int]');
    expect(built.variables.animeIds).toEqual([1]);
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
  it('assigns ascending zero-based order', () => {
    expect(favouriteOrderPayload([5, 9, 2])).toEqual({
      ids: [5, 9, 2],
      order: [0, 1, 2],
    });
  });
});
