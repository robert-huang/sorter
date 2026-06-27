import { describe, expect, it } from 'vitest';
import { buildSaveMediaListEntryMutation } from '../../lib/importers/anilist/listMutations';
import {
  formatUpdateSuccessMessage,
  resolveNotesUpdate,
  validateAndResolveUpdate,
  wantsNotesUpdate,
} from '../panels/updateListEntryLogic';

const BASE_FORM = {
  username: 'testuser',
  mediaId: '123',
  status: '',
  progress: '',
  progressVolumes: '',
  score: '',
  notesFind: '',
  notesReplace: '',
};

describe('resolveNotesUpdate', () => {
  it('sets notes directly when only replace is provided', () => {
    expect(resolveNotesUpdate('old', { find: '', replace: 'new' })).toEqual({
      kind: 'set',
      notes: 'new',
    });
  });

  it('replaces first find match', () => {
    expect(resolveNotesUpdate('foo #airing bar', { find: '#airing', replace: '#done' })).toEqual({
      kind: 'set',
      notes: 'foo #done bar',
    });
  });

  it('skips when find is not found', () => {
    expect(resolveNotesUpdate('hello', { find: '#airing', replace: 'x' })).toEqual({
      kind: 'skip',
      reason: 'find-not-found',
    });
  });

  it('supports * for full replace', () => {
    expect(resolveNotesUpdate('anything', { find: '*', replace: 'replaced' })).toEqual({
      kind: 'set',
      notes: 'replaced',
    });
  });
});

describe('validateAndResolveUpdate', () => {
  it('rejects when media id missing', () => {
    const result = validateAndResolveUpdate(
      { ...BASE_FORM, mediaId: '' },
      null,
    );
    expect(result).toEqual({
      kind: 'validation',
      message: 'Media ID is required and must be a positive integer.',
    });
  });

  it('rejects when no update fields provided', () => {
    const result = validateAndResolveUpdate(BASE_FORM, null);
    expect(result).toMatchObject({ kind: 'validation' });
  });

  it('builds mutation with only status', () => {
    const result = validateAndResolveUpdate(
      { ...BASE_FORM, status: 'PLANNING' },
      null,
    );
    if (result.kind === 'validation') {
      throw new Error('expected success');
    }
    expect(result.mutationFields).toEqual(['status']);
    expect(result.mutation.query).toContain('status: $status');
    expect(result.mutation.query).not.toContain('$notes:');
  });

  it('skips notes when find not found but still updates status', () => {
    const result = validateAndResolveUpdate(
      {
        ...BASE_FORM,
        status: 'CURRENT',
        notesFind: '#missing',
        notesReplace: 'x',
      },
      'no tag here',
    );
    if (result.kind === 'validation') {
      throw new Error('expected success');
    }
    expect(result.mutationFields).toEqual(['status']);
    expect(result.skippedNotesReason).toContain('find string not found');
  });

  it('errors when notes-only update and media not on list', () => {
    const result = validateAndResolveUpdate(
      { ...BASE_FORM, notesReplace: 'tag' },
      undefined,
    );
    expect(result).toEqual({
      kind: 'validation',
      message: 'This media is not on your AniList — cannot update notes.',
    });
  });

  it('includes notes in mutation when replace resolves', () => {
    const result = validateAndResolveUpdate(
      { ...BASE_FORM, notesReplace: '#airing' },
      '',
    );
    if (result.kind === 'validation') {
      throw new Error('expected success');
    }
    expect(result.mutationFields).toContain('notes');
    expect(result.variables.notes).toBe('#airing');
  });
});

describe('formatUpdateSuccessMessage', () => {
  it('combines applied fields and skip reason', () => {
    expect(formatUpdateSuccessMessage(['status'], 'Notes skipped (find string not found).')).toBe(
      'Updated: status. Notes skipped (find string not found).',
    );
  });
});

describe('wantsNotesUpdate', () => {
  it('is true when replace or find is non-empty', () => {
    expect(wantsNotesUpdate({ find: '', replace: 'a' })).toBe(true);
    expect(wantsNotesUpdate({ find: 'a', replace: '' })).toBe(true);
    expect(wantsNotesUpdate({ find: '', replace: '' })).toBe(false);
  });
});

describe('buildSaveMediaListEntryMutation integration', () => {
  it('produces executable notes-only mutation', () => {
    const built = buildSaveMediaListEntryMutation(
      { mediaId: 9, notes: 'hello' },
      ['notes'],
    );
    expect(built.query).toMatch(/mutation SaveMediaListEntry/);
    expect(built.query).toContain('notes: $notes');
  });
});
