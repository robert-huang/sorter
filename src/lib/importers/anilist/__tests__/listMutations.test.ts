import { describe, expect, it } from 'vitest';
import { buildSaveMediaListEntryMutation } from '../listMutations';

describe('buildSaveMediaListEntryMutation', () => {
  it('includes only provided fields in the mutation', () => {
    const built = buildSaveMediaListEntryMutation(
      { mediaId: 42, status: 'CURRENT', scoreRaw: 80 },
      ['status', 'scoreRaw'],
    );
    expect(built.query).toContain('$mediaId: Int!');
    expect(built.query).toContain('$status: MediaListStatus');
    expect(built.query).toContain('$scoreRaw: Int');
    expect(built.query).not.toContain('$notes:');
    expect(built.query).not.toContain('$progress:');
    expect(built.variables).toEqual({ mediaId: 42, status: 'CURRENT', scoreRaw: 80 });
  });
});
