import { describe, expect, it } from 'vitest';
import {
  buildBatchedCharacterVoiceMediaQuery,
  buildBatchedMediaCharactersQuery,
  buildBatchedMediaStaffQuery,
  buildBatchedStaffFilmographyCharacterMediaQuery,
} from '../batchGraphQueries';

describe('batchGraphQueries', () => {
  it('builds aliased character voice media batch query', () => {
    const { query, variables } = buildBatchedCharacterVoiceMediaQuery(
      [
        { id: 1, page: 1 },
        { id: 2, page: 3 },
      ],
      50,
    );
    expect(query).toContain('c0: Character(id: $id0)');
    expect(query).toContain('c1: Character(id: $id1)');
    expect(query).toContain('media(page: $page0, perPage: $perPage)');
    expect(query).toContain('media(page: $page1, perPage: $perPage)');
    expect(variables).toEqual({
      perPage: 50,
      id0: 1,
      page0: 1,
      id1: 2,
      page1: 3,
    });
  });

  it('builds aliased staff filmography character-media batch query', () => {
    const { query, variables } = buildBatchedStaffFilmographyCharacterMediaQuery(
      [{ id: 99, page: 2 }],
      25,
    );
    expect(query).toContain('s0: Staff(id: $id0)');
    expect(query).toContain('characterMedia(page: $charactersPage0, perPage: $perPage)');
    expect(variables).toEqual({
      perPage: 25,
      id0: 99,
      charactersPage0: 2,
    });
  });

  it('builds aliased media characters batch query', () => {
    const { query, variables } = buildBatchedMediaCharactersQuery(
      [
        { id: 10, page: 1 },
        { id: 20, page: 2 },
      ],
      25,
      'JAPANESE',
    );
    expect(query).toContain('m0: Media(id: $id0)');
    expect(query).toContain('m1: Media(id: $id1)');
    expect(query).toContain('characters(page: $charactersPage0, perPage: $perPage');
    expect(query).toContain('voiceActors(language: JAPANESE)');
    expect(variables).toEqual({
      perPage: 25,
      id0: 10,
      charactersPage0: 1,
      id1: 20,
      charactersPage1: 2,
    });
  });

  it('builds aliased media staff batch query', () => {
    const { query, variables } = buildBatchedMediaStaffQuery([{ id: 5, page: 3 }], 25);
    expect(query).toContain('m0: Media(id: $id0)');
    expect(query).toContain('staff(page: $staffPage0, perPage: $perPage)');
    expect(variables).toEqual({
      perPage: 25,
      id0: 5,
      staffPage0: 3,
    });
  });
});
