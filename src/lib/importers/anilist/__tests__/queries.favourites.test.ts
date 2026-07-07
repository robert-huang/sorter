import { describe, expect, it } from 'vitest';
import {
  FAVOURITE_ANIME_QUERY,
  FAVOURITE_MANGA_QUERY,
  FAVOURITE_MEDIA_FIELD_SELECTION,
  FAVOURITE_STUDIOS_QUERY,
} from '../queries';

describe('favourites GraphQL queries', () => {
  it('anime/manga favourite media selection omits studios (AniList 500s on favourites+studios)', () => {
    expect(FAVOURITE_MEDIA_FIELD_SELECTION).not.toMatch(/studios\s*\{/);
    expect(FAVOURITE_ANIME_QUERY).toContain(FAVOURITE_MEDIA_FIELD_SELECTION);
    expect(FAVOURITE_MANGA_QUERY).toContain(FAVOURITE_MEDIA_FIELD_SELECTION);
    expect(FAVOURITE_ANIME_QUERY).not.toMatch(/node\s*\{[^}]*studios\s*\{/s);
    expect(FAVOURITE_MANGA_QUERY).not.toMatch(/node\s*\{[^}]*studios\s*\{/s);
  });

  it('studio favourites query requests id + name on studio nodes', () => {
    expect(FAVOURITE_STUDIOS_QUERY).toMatch(/studios\(page: \$page, perPage: \$perPage\)/);
    expect(FAVOURITE_STUDIOS_QUERY).toMatch(/favouriteOrder/);
    expect(FAVOURITE_STUDIOS_QUERY).toMatch(/node\s*\{\s*id\s*name\s*\}/);
  });
});
