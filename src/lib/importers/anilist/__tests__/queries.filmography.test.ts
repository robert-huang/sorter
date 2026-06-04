import { describe, expect, it } from 'vitest';
import { buildStaffFilmographyQuery } from '../queries';

describe('buildStaffFilmographyQuery', () => {
  it('uses characterMedia with characterRole and staffRole (no bare role on MediaEdge)', () => {
    const q = buildStaffFilmographyQuery();
    expect(q).toContain('characterMedia');
    expect(q).toContain('characterRole');
    expect(q).toContain('staffRole');
    expect(q).not.toMatch(/edges\s*\{\s*role/m);
  });
});
