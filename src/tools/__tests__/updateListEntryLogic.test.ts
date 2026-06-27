import { describe, expect, it } from 'vitest';
import { buildSaveMediaListEntryMutation } from '../../lib/importers/anilist/listMutations';
import {
  formatMassNotesSuccessMessage,
  formatUpdateSuccessMessage,
  planMassNotesUpdates,
  resolveNotesUpdate,
  validateAndResolveUpdate,
  validateMassNotesMode,
  wantsMassNotesMode,
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
  it('sets notes when only replace is provided and current notes are blank', () => {
    expect(resolveNotesUpdate('', { find: '', replace: '#airing' })).toEqual({
      kind: 'set',
      notes: '#airing',
    });
    expect(resolveNotesUpdate(null, { find: '', replace: 'new' })).toEqual({
      kind: 'set',
      notes: 'new',
    });
  });

  it('skips replace-only when current notes already exist', () => {
    expect(resolveNotesUpdate('old', { find: '', replace: 'new' })).toEqual({
      kind: 'skip',
      reason: 'blank-only',
    });
  });

  it('replaces first find match', () => {
    expect(resolveNotesUpdate('foo #airing bar', { find: '#airing', replace: '#done' })).toEqual({
      kind: 'set',
      notes: 'foo #done bar',
    });
  });

  it('preserves leading spaces in find and replace (no trim on mutation)', () => {
    expect(
      resolveNotesUpdate('aa #airing', { find: ' #airing', replace: ' #aired' }),
    ).toEqual({
      kind: 'set',
      notes: 'aa #aired',
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

  describe('does not trim find/replace values written to notes', () => {
    it('keeps trailing spaces on blank-only replace', () => {
      expect(resolveNotesUpdate('', { find: '', replace: ' #airing ' })).toEqual({
        kind: 'set',
        notes: ' #airing ',
      });
    });

    it('keeps trailing spaces on * full replace', () => {
      expect(resolveNotesUpdate('old', { find: '*', replace: ' new ' })).toEqual({
        kind: 'set',
        notes: ' new ',
      });
    });

    it('keeps trailing spaces in substring find and replace', () => {
      expect(
        resolveNotesUpdate('tag #airing ', { find: '#airing ', replace: '#done ' }),
      ).toEqual({
        kind: 'set',
        notes: 'tag #done ',
      });
    });

    it('does not match a spaced find against an unspaced occurrence', () => {
      expect(
        resolveNotesUpdate('aa#airing', { find: ' #airing', replace: ' #aired' }),
      ).toEqual({
        kind: 'skip',
        reason: 'find-not-found',
      });
    });
  });

  describe('trims only for empty/filled routing', () => {
    it('treats whitespace-only find and replace as no notes update', () => {
      expect(resolveNotesUpdate('notes', { find: '   ', replace: '  ' })).toEqual({
        kind: 'none',
      });
    });

    it('treats whitespace-only find as blank-only when replace has content', () => {
      expect(resolveNotesUpdate('', { find: '   ', replace: '#airing' })).toEqual({
        kind: 'set',
        notes: '#airing',
      });
    });

    it('treats whitespace-only current notes as blank for replace-only', () => {
      expect(resolveNotesUpdate('   ', { find: '', replace: '#airing' })).toEqual({
        kind: 'set',
        notes: '#airing',
      });
    });

    it('treats whitespace-only current notes as non-blank when trimmed content exists', () => {
      expect(resolveNotesUpdate('  x  ', { find: '', replace: '#airing' })).toEqual({
        kind: 'skip',
        reason: 'blank-only',
      });
    });

    it('treats padded * find as full replace', () => {
      expect(resolveNotesUpdate('old', { find: '  *  ', replace: 'new' })).toEqual({
        kind: 'set',
        notes: 'new',
      });
    });
  });
});

describe('validateAndResolveUpdate', () => {
  it('rejects when media id missing and notes fields empty', () => {
    const result = validateAndResolveUpdate(
      { ...BASE_FORM, mediaId: '' },
      null,
    );
    expect(result).toEqual({
      kind: 'validation',
      message:
        'Media ID is required unless running mass notes tagging (leave Media ID empty and fill Notes Find or Replace).',
    });
  });

  it('rejects mass notes mode when routed through single-entry resolver', () => {
    const result = validateAndResolveUpdate(
      { ...BASE_FORM, mediaId: '', notesReplace: '#airing' },
      null,
    );
    expect(result).toEqual({
      kind: 'validation',
      message: 'Mass notes updates are handled separately from single-entry updates.',
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

  it('skips replace-only notes when entry has notes but still updates status', () => {
    const result = validateAndResolveUpdate(
      {
        ...BASE_FORM,
        status: 'CURRENT',
        notesReplace: '#airing',
      },
      'existing note',
    );
    if (result.kind === 'validation') {
      throw new Error('expected success');
    }
    expect(result.mutationFields).toEqual(['status']);
    expect(result.skippedNotesReason).toContain('blank-only');
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

  it('is false when find and replace are whitespace-only', () => {
    expect(wantsNotesUpdate({ find: '   ', replace: '' })).toBe(false);
    expect(wantsNotesUpdate({ find: '', replace: '\t' })).toBe(false);
    expect(wantsNotesUpdate({ find: '  ', replace: '  ' })).toBe(false);
  });

  it('is true when find or replace has non-whitespace surrounded by spaces', () => {
    expect(wantsNotesUpdate({ find: '  #airing  ', replace: '' })).toBe(true);
    expect(wantsNotesUpdate({ find: '', replace: '  tag  ' })).toBe(true);
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

describe('mass notes mode', () => {
  it('detects empty media id with notes fields', () => {
    expect(
      wantsMassNotesMode({ ...BASE_FORM, mediaId: '', notesReplace: '#airing' }),
    ).toBe(true);
    expect(wantsMassNotesMode({ ...BASE_FORM, mediaId: '' })).toBe(false);
    expect(wantsMassNotesMode({ ...BASE_FORM, notesReplace: '#airing' })).toBe(false);
  });

  it('rejects mass mode when other list fields are filled', () => {
    expect(
      validateMassNotesMode({
        ...BASE_FORM,
        mediaId: '',
        notesReplace: '#airing',
        status: 'CURRENT',
      }),
    ).toEqual({
      kind: 'validation',
      message:
        'Mass notes mode only updates notes — clear status, progress, volumes, and score, or provide a Media ID.',
    });
  });

  it('plans per-entry updates with mass_tagger skip counts', () => {
    const plan = planMassNotesUpdates(
      [
        { mediaId: 1, notes: '' },
        { mediaId: 2, notes: 'aa #airing' },
        { mediaId: 3, notes: 'has notes' },
        { mediaId: 4, notes: 'no tag' },
      ],
      { find: '#airing', replace: '#aired' },
    );

    expect(plan.updates).toEqual([
      { mediaId: 2, notes: 'aa #aired' },
    ]);
    expect(plan.stats).toMatchObject({
      examined: 4,
      updated: 1,
      skippedBlankOnly: 0,
      skippedFindNotFound: 3,
    });
  });

  it('formats mass success message with skip breakdown', () => {
    expect(
      formatMassNotesSuccessMessage({
        examined: 10,
        updated: 3,
        skippedBlankOnly: 2,
        skippedFindNotFound: 4,
        unchanged: 1,
      }),
    ).toBe(
      'Updated notes on 3 entries (10 examined; skipped: 2 blank-only, 4 find not found).',
    );
  });
});
