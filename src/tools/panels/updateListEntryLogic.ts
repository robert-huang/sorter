import type { AnilistMediaListStatus } from '../../lib/importers/anilist/types';
import type {
  SaveMediaListEntryMutationField,
  SaveMediaListEntryVariables,
} from '../../lib/importers/anilist/listMutations';
import { buildSaveMediaListEntryMutation } from '../../lib/importers/anilist/listMutations';

/** Matches {@link ALL_LIST_STATUSES} / list-status filter chip order. */
export const MEDIA_LIST_STATUSES: readonly AnilistMediaListStatus[] = [
  'CURRENT',
  'REPEATING',
  'COMPLETED',
  'PLANNING',
  'PAUSED',
  'DROPPED',
];

export type UpdateListEntryForm = {
  username: string;
  mediaId: string;
  status: string;
  progress: string;
  progressVolumes: string;
  score: string;
  notesFind: string;
  notesReplace: string;
};

export type NotesUpdateInput = {
  find: string;
  replace: string;
};

export type NotesResolveResult =
  | { kind: 'set'; notes: string }
  | { kind: 'skip'; reason: 'find-not-found' | 'blank-only' | 'not-on-list' }
  | { kind: 'none' };

export type UpdateListEntryValidationError = {
  kind: 'validation';
  message: string;
};

export type ResolvedListEntryUpdate = {
  kind: 'resolved';
  mediaId: number;
  mutationFields: SaveMediaListEntryMutationField[];
  variables: SaveMediaListEntryVariables;
  mutation: ReturnType<typeof buildSaveMediaListEntryMutation>;
  appliedLabels: string[];
  skippedNotesReason: string | null;
};

function parseOptionalInt(
  raw: string,
  label: string,
): { value: number } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: `${label} is empty.` };
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) {
    return { error: `${label} must be a non-negative integer.` };
  }
  return { value };
}

function parseOptionalScore(raw: string): { value: number } | { error: string } | { omit: true } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { omit: true };
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    return { error: 'Score must be an integer from 0 to 100.' };
  }
  return { value };
}

export function wantsNotesUpdate(input: NotesUpdateInput): boolean {
  return input.replace.trim().length > 0 || input.find.trim().length > 0;
}

/**
 * mass_tagger-style notes resolution:
 * - replace only → set notes directly
 * - find `*` → replace entire notes
 * - find non-empty → first match replace, else skip
 * - find empty + replace → blank notes only
 */
export function resolveNotesUpdate(
  currentNotes: string | null,
  input: NotesUpdateInput,
): NotesResolveResult {
  const find = input.find;
  const replace = input.replace;
  const findTrimmed = find.trim();
  const replaceTrimmed = replace.trim();

  if (!replaceTrimmed && !findTrimmed) {
    return { kind: 'none' };
  }

  const current = currentNotes ?? '';

  if (!findTrimmed && replaceTrimmed) {
    return { kind: 'set', notes: replace };
  }

  if (findTrimmed === '*') {
    return { kind: 'set', notes: replace };
  }

  if (findTrimmed === '') {
    if (!current.trim()) {
      return replaceTrimmed ? { kind: 'set', notes: replace } : { kind: 'none' };
    }
    return { kind: 'skip', reason: 'blank-only' };
  }

  if (current.includes(find)) {
    return { kind: 'set', notes: current.replace(find, replace) };
  }

  return { kind: 'skip', reason: 'find-not-found' };
}

export function skippedNotesMessage(reason: NotesResolveResult): string | null {
  if (reason.kind !== 'skip') {
    return null;
  }
  switch (reason.reason) {
    case 'find-not-found':
      return 'Notes skipped (find string not found).';
    case 'blank-only':
      return 'Notes skipped (entry already has notes; blank-only mode).';
    case 'not-on-list':
      return 'Notes skipped (media is not on your list).';
    default:
      return 'Notes skipped.';
  }
}

export function validateAndResolveUpdate(
  form: UpdateListEntryForm,
  currentNotes: string | null | undefined,
): ResolvedListEntryUpdate | UpdateListEntryValidationError {
  const mediaParsed = parseOptionalInt(form.mediaId, 'Media ID');
  if ('error' in mediaParsed) {
    return { kind: 'validation', message: 'Media ID is required and must be a positive integer.' };
  }
  if (mediaParsed.value <= 0) {
    return { kind: 'validation', message: 'Media ID is required and must be a positive integer.' };
  }

  const mutationFields: SaveMediaListEntryMutationField[] = [];
  const variables: SaveMediaListEntryVariables = { mediaId: mediaParsed.value };
  const appliedLabels: string[] = [];
  let skippedNotesReason: string | null = null;

  const status = form.status.trim();
  if (status) {
    if (!(MEDIA_LIST_STATUSES as readonly string[]).includes(status)) {
      return { kind: 'validation', message: `Invalid status "${status}".` };
    }
    mutationFields.push('status');
    variables.status = status;
    appliedLabels.push('status');
  }

  if (form.progress.trim()) {
    const parsed = parseOptionalInt(form.progress, 'Progress');
    if ('error' in parsed) {
      return { kind: 'validation', message: parsed.error };
    }
    mutationFields.push('progress');
    variables.progress = parsed.value;
    appliedLabels.push('progress');
  }

  if (form.progressVolumes.trim()) {
    const parsed = parseOptionalInt(form.progressVolumes, 'Progress volumes');
    if ('error' in parsed) {
      return { kind: 'validation', message: parsed.error };
    }
    mutationFields.push('progressVolumes');
    variables.progressVolumes = parsed.value;
    appliedLabels.push('progress volumes');
  }

  const scoreParsed = parseOptionalScore(form.score);
  if ('error' in scoreParsed) {
    return { kind: 'validation', message: scoreParsed.error };
  }
  if (!('omit' in scoreParsed)) {
    mutationFields.push('scoreRaw');
    variables.scoreRaw = scoreParsed.value;
    appliedLabels.push('score');
  }

  const notesInput: NotesUpdateInput = {
    find: form.notesFind,
    replace: form.notesReplace,
  };

  if (wantsNotesUpdate(notesInput)) {
    if (currentNotes === undefined) {
      const otherFieldsRequested =
        status.length > 0 ||
        form.progress.trim().length > 0 ||
        form.progressVolumes.trim().length > 0 ||
        !('omit' in scoreParsed);
      if (!otherFieldsRequested) {
        return {
          kind: 'validation',
          message: 'This media is not on your AniList — cannot update notes.',
        };
      }
      skippedNotesReason = skippedNotesMessage({ kind: 'skip', reason: 'not-on-list' });
    } else {
      const notesResult = resolveNotesUpdate(currentNotes ?? null, notesInput);
      if (notesResult.kind === 'set') {
        mutationFields.push('notes');
        variables.notes = notesResult.notes;
        appliedLabels.push('notes');
      } else if (notesResult.kind === 'skip') {
        skippedNotesReason = skippedNotesMessage(notesResult);
      }
    }
  }

  if (mutationFields.length === 0) {
    return {
      kind: 'validation',
      message: 'Fill in at least one field to update (status, progress, score, or notes).',
    };
  }

  return {
    kind: 'resolved',
    mediaId: mediaParsed.value,
    mutationFields,
    variables,
    mutation: buildSaveMediaListEntryMutation(variables, mutationFields),
    appliedLabels,
    skippedNotesReason,
  };
}

export function formatUpdateSuccessMessage(
  appliedLabels: string[],
  skippedNotesReason: string | null,
): string {
  const applied =
    appliedLabels.length > 0
      ? `Updated: ${appliedLabels.join(', ')}.`
      : 'Update completed.';
  if (!skippedNotesReason) {
    return applied;
  }
  return `${applied} ${skippedNotesReason}`;
}
