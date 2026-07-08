import { describe, expect, it } from 'vitest';
import {
  ANILIST_MEDIA_RELATION_TYPE_VERSION,
  ANILIST_MEDIA_SOURCE_VERSION,
  ANILIST_MEDIA_STATUS_VERSION,
  FAVOURITE_ANIME_QUERY,
  FAVOURITE_MEDIA_FIELD_SELECTION,
  LIST_COLLECTION_QUERY,
  TOOLS_MEDIA_RELATION_TYPE_FIELD,
  TOOLS_MEDIA_RELATIONS_QUERY,
  TOOLS_MEDIA_RELATIONS_V2_QUERY,
  buildMediaRelationsQuery,
} from '../queries';

describe('AniList versioned Media fields', () => {
  it('uses source(version: 3) and status(version: 2) in shared media selection', () => {
    expect(LIST_COLLECTION_QUERY).toContain(`source(version: ${ANILIST_MEDIA_SOURCE_VERSION})`);
    expect(LIST_COLLECTION_QUERY).toContain(`status(version: ${ANILIST_MEDIA_STATUS_VERSION})`);
    expect(LIST_COLLECTION_QUERY).toMatch(
      /media\s*\{[\s\S]*status\(version: 2\)/,
    );
    expect(FAVOURITE_MEDIA_FIELD_SELECTION).toContain(
      `source(version: ${ANILIST_MEDIA_SOURCE_VERSION})`,
    );
    expect(FAVOURITE_MEDIA_FIELD_SELECTION).toContain(
      `status(version: ${ANILIST_MEDIA_STATUS_VERSION})`,
    );
    expect(FAVOURITE_ANIME_QUERY).toContain(FAVOURITE_MEDIA_FIELD_SELECTION);
  });

  it('uses relationType(version: 2) on every relation fetch query', () => {
    expect(TOOLS_MEDIA_RELATION_TYPE_FIELD).toBe(
      `relationType(version: ${ANILIST_MEDIA_RELATION_TYPE_VERSION})`,
    );
    expect(buildMediaRelationsQuery()).toContain(TOOLS_MEDIA_RELATION_TYPE_FIELD);
    expect(TOOLS_MEDIA_RELATIONS_V2_QUERY).toContain(TOOLS_MEDIA_RELATION_TYPE_FIELD);
    expect(TOOLS_MEDIA_RELATIONS_QUERY).toContain(TOOLS_MEDIA_RELATION_TYPE_FIELD);
  });
});
