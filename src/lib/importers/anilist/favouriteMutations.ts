import type { AnilistFavouriteType } from './types';

/** Per-type GraphQL field names for UpdateFavouriteOrder / ToggleFavourite. */
export const FAVOURITE_MUTATION_FIELDS = {
  ANIME: {
    idsVar: 'animeIds',
    orderVar: 'animeOrder',
    idsArg: 'animeIds',
    orderArg: 'animeOrder',
    responseField: 'animeIds',
    toggleVar: 'animeId',
    toggleArg: 'animeId',
    table: 'media_favourite',
    idColumn: 'media_id',
    mediaType: 'ANIME' as const,
  },
  MANGA: {
    idsVar: 'mangaIds',
    orderVar: 'mangaOrder',
    idsArg: 'mangaIds',
    orderArg: 'mangaOrder',
    responseField: 'mangaIds',
    toggleVar: 'mangaId',
    toggleArg: 'mangaId',
    table: 'media_favourite',
    idColumn: 'media_id',
    mediaType: 'MANGA' as const,
  },
  CHARACTERS: {
    idsVar: 'characterIds',
    orderVar: 'characterOrder',
    idsArg: 'characterIds',
    orderArg: 'characterOrder',
    responseField: 'characterIds',
    toggleVar: 'characterId',
    toggleArg: 'characterId',
    table: 'character_favourite',
    idColumn: 'character_id',
    mediaType: null,
  },
  STAFF: {
    idsVar: 'staffIds',
    orderVar: 'staffOrder',
    idsArg: 'staffIds',
    orderArg: 'staffOrder',
    responseField: 'staffIds',
    toggleVar: 'staffId',
    toggleArg: 'staffId',
    table: 'staff_favourite',
    idColumn: 'staff_id',
    mediaType: null,
  },
  STUDIOS: {
    idsVar: 'studioIds',
    orderVar: 'studioOrder',
    idsArg: 'studioIds',
    orderArg: 'studioOrder',
    responseField: 'studioIds',
    toggleVar: 'studioId',
    toggleArg: 'studioId',
    table: 'studio_favourite',
    idColumn: 'studio_id',
    mediaType: null,
  },
} as const satisfies Record<
  AnilistFavouriteType,
  {
    idsVar: string;
    orderVar: string;
    idsArg: string;
    orderArg: string;
    responseField: string;
    toggleVar: string;
    toggleArg: string;
    table: string;
    idColumn: string;
    mediaType: 'ANIME' | 'MANGA' | null;
  }
>;

export type UpdateFavouriteOrderVariables = {
  ids: readonly number[];
  /** Ascending order integers matching AniList `favouriteOrder` (0-based). */
  order: readonly number[];
};

export function buildUpdateFavouriteOrderMutation(
  type: AnilistFavouriteType,
  variables: UpdateFavouriteOrderVariables,
): { query: string; variables: Record<string, number[]> } {
  const fields = FAVOURITE_MUTATION_FIELDS[type];
  const query = `
mutation UpdateFavouriteOrder($${fields.idsVar}: [Int], $${fields.orderVar}: [Int]) {
  UpdateFavouriteOrder(${fields.idsArg}: $${fields.idsVar}, ${fields.orderArg}: $${fields.orderVar}) {
    ${fields.responseField}
  }
}`.trim();

  return {
    query,
    variables: {
      [fields.idsVar]: [...variables.ids],
      [fields.orderVar]: [...variables.order],
    },
  };
};

export type UpdateFavouriteOrderResponse = {
  UpdateFavouriteOrder: Partial<Record<string, number[] | null>> | null;
};

export function buildToggleFavouriteMutation(
  type: AnilistFavouriteType,
  entityId: number,
): { query: string; variables: Record<string, number> } {
  const fields = FAVOURITE_MUTATION_FIELDS[type];
  const query = `
mutation ToggleFavourite($${fields.toggleVar}: Int) {
  ToggleFavourite(${fields.toggleArg}: $${fields.toggleVar}) {
    __typename
  }
}`.trim();

  return {
    query,
    variables: { [fields.toggleVar]: entityId },
  };
}

export type ToggleFavouriteResponse = {
  ToggleFavourite: { __typename: string } | null;
};

/** Build parallel id + ascending order arrays from a list sorted by desired rank. */
export function favouriteOrderPayload(
  orderedIds: readonly number[],
): UpdateFavouriteOrderVariables {
  return {
    ids: orderedIds,
    order: orderedIds.map((_, index) => index),
  };
}
