/**
 * Batched AniList GraphQL queries for paginated graph expansions.
 * Each builder aliases N root entities (`c0`, `s0`, …) with per-entity
 * page variables so one transport round-trip can advance many cursors.
 */

import type { AnilistStaffLanguage } from './types';

const CHARACTER_VOICE_MEDIA_CONNECTION_FIELDS = `
  pageInfo { hasNextPage currentPage }
  edges {
    node {
      id
      title { romaji native english }
      synonyms
      type
      format
      coverImage { large }
    }
    characterRole
    voiceActors(language: JAPANESE, sort: RELEVANCE) {
      id
      name { full native }
      image { large }
      age
      gender
      languageV2
      favourites
    }
  }
`.trim();

const MEDIA_CAST_CHARACTERS_CONNECTION_FIELDS = (
  voiceActorLanguage: AnilistStaffLanguage,
) => `
  pageInfo { hasNextPage currentPage }
  edges {
    role
    node {
      id
      name { full native alternative alternativeSpoiler }
      image { large }
      age
      gender
      favourites
    }
    voiceActors(language: ${voiceActorLanguage}) {
      id
      name { full native }
      languageV2
      image { large }
      age
      gender
      favourites
    }
  }
`.trim();

const MEDIA_CAST_STAFF_CONNECTION_FIELDS = `
  pageInfo { hasNextPage currentPage }
  edges {
    role
    node {
      id
      name { full native }
      languageV2
      image { large }
      age
      gender
      favourites
    }
  }
`.trim();

const STAFF_PROFILE_FIELDS = `
  id
  name { full native }
  languageV2
  image { large }
  age
  gender
  favourites
`.trim();

const STAFF_CHARACTER_MEDIA_CONNECTION_FIELDS = `
  pageInfo { hasNextPage currentPage }
  edges {
    characterRole
    characters {
      id
      name { full native alternative alternativeSpoiler }
      image { large }
      age
      gender
      favourites
    }
    node {
      id
      title { romaji native english }
      synonyms
      type
      format
      coverImage { large }
      startDate { year month day }
      endDate { year month day }
      season
      seasonYear
      status
      episodes
      chapters
      meanScore
      favourites
      countryOfOrigin
      genres
      source
    }
  }
`.trim();

const STAFF_STAFF_MEDIA_CONNECTION_FIELDS = `
  pageInfo { hasNextPage currentPage }
  edges {
    staffRole
    node {
      id
      title { romaji native english }
      synonyms
      type
      format
      coverImage { large }
      startDate { year month day }
      endDate { year month day }
      season
      seasonYear
      status
      episodes
      chapters
      meanScore
      favourites
      countryOfOrigin
      genres
      source
    }
  }
`.trim();

const VA_CHARACTER_MEDIA_CONNECTION_FIELDS = `
  pageInfo { hasNextPage currentPage }
  edges {
    characterRole
    node { id }
    characters { id }
  }
`.trim();

export type BatchedPageRequest = {
  id: number;
  page: number;
};

/** `Character.media` page batch for Favourites character expansion. */
export function buildBatchedCharacterVoiceMediaQuery(
  requests: readonly BatchedPageRequest[],
  perPage: number,
): { query: string; variables: Record<string, number> } {
  const varDefs = [
    ...requests.map((_, index) => `$id${index}: Int!, $page${index}: Int!`),
    '$perPage: Int!',
  ].join(', ');
  const fields = requests
    .map(
      (_, index) => `c${index}: Character(id: $id${index}) {
    media(page: $page${index}, perPage: $perPage) {
      ${CHARACTER_VOICE_MEDIA_CONNECTION_FIELDS}
    }
  }`,
    )
    .join('\n');
  const variables: Record<string, number> = { perPage };
  requests.forEach((req, index) => {
    variables[`id${index}`] = req.id;
    variables[`page${index}`] = req.page;
  });
  return {
    query: `query ToolsCharacterVoiceMediaBatch(${varDefs}) {\n${fields}\n}`,
    variables,
  };
}

function buildStaffPageVarDefs(
  requests: readonly BatchedPageRequest[],
  pagePrefix: 'charactersPage' | 'staffMediaPage',
): string {
  return [
    ...requests.map((_, index) => `$id${index}: Int!, $${pagePrefix}${index}: Int!`),
    '$perPage: Int!',
  ].join(', ');
}

function buildStaffPageVariables(
  requests: readonly BatchedPageRequest[],
  pagePrefix: 'charactersPage' | 'staffMediaPage',
  perPage: number,
): Record<string, number> {
  const variables: Record<string, number> = { perPage };
  requests.forEach((req, index) => {
    variables[`id${index}`] = req.id;
    variables[`${pagePrefix}${index}`] = req.page;
  });
  return variables;
}

/** `Staff.characterMedia` page batch for filmography expansion. */
export function buildBatchedStaffFilmographyCharacterMediaQuery(
  requests: readonly BatchedPageRequest[],
  perPage: number,
): { query: string; variables: Record<string, number> } {
  const varDefs = buildStaffPageVarDefs(requests, 'charactersPage');
  const fields = requests
    .map(
      (_, index) => `s${index}: Staff(id: $id${index}) {
    ${STAFF_PROFILE_FIELDS}
    characterMedia(page: $charactersPage${index}, perPage: $perPage) {
      ${STAFF_CHARACTER_MEDIA_CONNECTION_FIELDS}
    }
  }`,
    )
    .join('\n');
  return {
    query: `query ToolsStaffFilmographyCharacterBatch(${varDefs}) {\n${fields}\n}`,
    variables: buildStaffPageVariables(requests, 'charactersPage', perPage),
  };
}

/** `Staff.staffMedia` page batch for filmography expansion. */
export function buildBatchedStaffFilmographyStaffMediaQuery(
  requests: readonly BatchedPageRequest[],
  perPage: number,
): { query: string; variables: Record<string, number> } {
  const varDefs = buildStaffPageVarDefs(requests, 'staffMediaPage');
  const fields = requests
    .map(
      (_, index) => `s${index}: Staff(id: $id${index}) {
    ${STAFF_PROFILE_FIELDS}
    staffMedia(page: $staffMediaPage${index}, perPage: $perPage) {
      ${STAFF_STAFF_MEDIA_CONNECTION_FIELDS}
    }
  }`,
    )
    .join('\n');
  return {
    query: `query ToolsStaffFilmographyStaffMediaBatch(${varDefs}) {\n${fields}\n}`,
    variables: buildStaffPageVariables(requests, 'staffMediaPage', perPage),
  };
}

function buildMediaPageVarDefs(
  requests: readonly BatchedPageRequest[],
  pagePrefix: 'charactersPage' | 'staffPage',
): string {
  return [
    ...requests.map((_, index) => `$id${index}: Int!, $${pagePrefix}${index}: Int!`),
    '$perPage: Int!',
  ].join(', ');
}

function buildMediaPageVariables(
  requests: readonly BatchedPageRequest[],
  pagePrefix: 'charactersPage' | 'staffPage',
  perPage: number,
): Record<string, number> {
  const variables: Record<string, number> = { perPage };
  requests.forEach((req, index) => {
    variables[`id${index}`] = req.id;
    variables[`${pagePrefix}${index}`] = req.page;
  });
  return variables;
}

/** `Media.characters` page batch for cast expansion. */
export function buildBatchedMediaCharactersQuery(
  requests: readonly BatchedPageRequest[],
  perPage: number,
  voiceActorLanguage: AnilistStaffLanguage,
): { query: string; variables: Record<string, number> } {
  const varDefs = buildMediaPageVarDefs(requests, 'charactersPage');
  const connectionFields = MEDIA_CAST_CHARACTERS_CONNECTION_FIELDS(voiceActorLanguage);
  const fields = requests
    .map(
      (_, index) => `m${index}: Media(id: $id${index}) {
    characters(page: $charactersPage${index}, perPage: $perPage, sort: [ROLE, RELEVANCE, ID]) {
      ${connectionFields}
    }
  }`,
    )
    .join('\n');
  return {
    query: `query ToolsMediaCharactersBatch(${varDefs}) {\n${fields}\n}`,
    variables: buildMediaPageVariables(requests, 'charactersPage', perPage),
  };
}

/** `Media.staff` page batch for cast expansion. */
export function buildBatchedMediaStaffQuery(
  requests: readonly BatchedPageRequest[],
  perPage: number,
): { query: string; variables: Record<string, number> } {
  const varDefs = buildMediaPageVarDefs(requests, 'staffPage');
  const fields = requests
    .map(
      (_, index) => `m${index}: Media(id: $id${index}) {
    staff(page: $staffPage${index}, perPage: $perPage) {
      ${MEDIA_CAST_STAFF_CONNECTION_FIELDS}
    }
  }`,
    )
    .join('\n');
  return {
    query: `query ToolsMediaStaffBatch(${varDefs}) {\n${fields}\n}`,
    variables: buildMediaPageVariables(requests, 'staffPage', perPage),
  };
}

/** Slim `Staff.characterMedia` batch for VA totals (ids only on nodes). */
export function buildBatchedVaCharacterMediaQuery(
  requests: readonly BatchedPageRequest[],
  perPage: number,
): { query: string; variables: Record<string, number> } {
  const varDefs = buildStaffPageVarDefs(requests, 'charactersPage');
  const fields = requests
    .map(
      (_, index) => `s${index}: Staff(id: $id${index}) {
    characterMedia(page: $charactersPage${index}, perPage: $perPage) {
      ${VA_CHARACTER_MEDIA_CONNECTION_FIELDS}
    }
  }`,
    )
    .join('\n');
  return {
    query: `query ToolsVaCharacterMediaBatch(${varDefs}) {\n${fields}\n}`,
    variables: buildStaffPageVariables(requests, 'charactersPage', perPage),
  };
}
