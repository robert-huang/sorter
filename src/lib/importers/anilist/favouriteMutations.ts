import type { AnilistFavouriteType } from './types';

/** Per-type GraphQL field names for UpdateFavouriteOrder / ToggleFavourite. */
export const FAVOURITE_MUTATION_FIELDS = {
  ANIME: {
    idsVar: 'animeIds',
    orderVar: 'animeOrder',
    idsArg: 'animeIds',
    orderArg: 'animeOrder',
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
    toggleVar: string;
    toggleArg: string;
    table: string;
    idColumn: string;
    mediaType: 'ANIME' | 'MANGA' | null;
  }
>;

/** Matches AniList's website mutation shape (all type args declared; only active type sent). */
export const UPDATE_FAVOURITE_ORDER_MUTATION = `
mutation UpdateFavouriteOrder(
  $animeIds: [Int],
  $mangaIds: [Int],
  $characterIds: [Int],
  $staffIds: [Int],
  $studioIds: [Int],
  $animeOrder: [Int],
  $mangaOrder: [Int],
  $characterOrder: [Int],
  $staffOrder: [Int],
  $studioOrder: [Int]
) {
  UpdateFavouriteOrder(
    animeIds: $animeIds,
    mangaIds: $mangaIds,
    characterIds: $characterIds,
    staffIds: $staffIds,
    studioIds: $studioIds,
    animeOrder: $animeOrder,
    mangaOrder: $mangaOrder,
    characterOrder: $characterOrder,
    staffOrder: $staffOrder,
    studioOrder: $studioOrder
  ) {
    anime {
      pageInfo {
        total
      }
    }
  }
}`.trim();

export type UpdateFavouriteOrderVariables = {
  ids: readonly number[];
  /** Ascending 1-based rank integers matching AniList favourite order. */
  order: readonly number[];
};

export function buildUpdateFavouriteOrderMutation(
  type: AnilistFavouriteType,
  variables: UpdateFavouriteOrderVariables,
): { query: string; variables: Record<string, number[]> } {
  const fields = FAVOURITE_MUTATION_FIELDS[type];
  return {
    query: UPDATE_FAVOURITE_ORDER_MUTATION,
    variables: {
      [fields.idsVar]: [...variables.ids],
      [fields.orderVar]: [...variables.order],
    },
  };
}

export type UpdateFavouriteOrderResponse = {
  UpdateFavouriteOrder: {
    anime: { pageInfo: { total: number } } | null;
  } | null;
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

/** Build parallel id + ascending 1-based order arrays from a list sorted by desired rank. */
export function favouriteOrderPayload(
  orderedIds: readonly number[],
): UpdateFavouriteOrderVariables {
  return {
    ids: orderedIds,
    order: orderedIds.map((_, index) => index + 1),
  };
}
