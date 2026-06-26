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

  it('requests staff profile fields on the root Staff node', () => {
    const q = buildStaffFilmographyQuery();
    expect(q).toContain('languageV2');
    expect(q).toMatch(/Staff\(id: \$id\)[\s\S]*gender/);
  });
});
