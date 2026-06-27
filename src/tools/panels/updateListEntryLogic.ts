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

export type ListEntryNotesRow = {
  mediaId: number;
  notes: string | null;
};

export type MassNotesPlan = {
  kind: 'mass-notes';
  notesInput: NotesUpdateInput;
  updates: Array<{ mediaId: number; notes: string }>;
  stats: {
    examined: number;
    updated: number;
    skippedBlankOnly: number;
    skippedFindNotFound: number;
    unchanged: number;
  };
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

export function isMediaIdEmpty(mediaId: string): boolean {
  return mediaId.trim() === '';
}

/** Empty media id + at least one notes field → mass_tagger-style list pass. */
export function wantsMassNotesMode(form: UpdateListEntryForm): boolean {
  return (
    isMediaIdEmpty(form.mediaId) &&
    wantsNotesUpdate({ find: form.notesFind, replace: form.notesReplace })
  );
}

export function hasNonNotesListFields(form: UpdateListEntryForm): boolean {
  return (
    form.status.trim().length > 0 ||
    form.progress.trim().length > 0 ||
    form.progressVolumes.trim().length > 0 ||
    form.score.trim().length > 0
  );
}

export function validateMassNotesMode(
  form: UpdateListEntryForm,
): UpdateListEntryValidationError | { kind: 'ok'; notesInput: NotesUpdateInput } {
  if (!wantsMassNotesMode(form)) {
    return {
      kind: 'validation',
      message:
        'Leave Media ID empty and fill Notes Find or Replace to run mass notes tagging across your list.',
    };
  }
  if (hasNonNotesListFields(form)) {
    return {
      kind: 'validation',
      message:
        'Mass notes mode only updates notes — clear status, progress, volumes, and score, or provide a Media ID.',
    };
  }
  return {
    kind: 'ok',
    notesInput: { find: form.notesFind, replace: form.notesReplace },
  };
}

export function planMassNotesUpdates(
  entries: readonly ListEntryNotesRow[],
  notesInput: NotesUpdateInput,
): MassNotesPlan {
  const updates: Array<{ mediaId: number; notes: string }> = [];
  let skippedBlankOnly = 0;
  let skippedFindNotFound = 0;
  let unchanged = 0;

  for (const entry of entries) {
    const result = resolveNotesUpdate(entry.notes, notesInput);
    if (result.kind === 'set') {
      const previous = entry.notes ?? '';
      if (result.notes === previous) {
        unchanged += 1;
      } else {
        updates.push({ mediaId: entry.mediaId, notes: result.notes });
      }
    } else if (result.kind === 'skip') {
      if (result.reason === 'blank-only') {
        skippedBlankOnly += 1;
      } else if (result.reason === 'find-not-found') {
        skippedFindNotFound += 1;
      }
    } else {
      unchanged += 1;
    }
  }

  return {
    kind: 'mass-notes',
    notesInput,
    updates,
    stats: {
      examined: entries.length,
      updated: updates.length,
      skippedBlankOnly,
      skippedFindNotFound,
      unchanged,
    },
  };
}

export function formatMassNotesSuccessMessage(stats: MassNotesPlan['stats']): string {
  if (stats.updated === 0) {
    const skipped =
      stats.skippedBlankOnly + stats.skippedFindNotFound + stats.unchanged;
    if (skipped === 0) {
      return 'No list entries found to update.';
    }
    return `No list entries updated (${stats.examined} examined).`;
  }

  const skipParts: string[] = [];
  if (stats.skippedBlankOnly > 0) {
    skipParts.push(`${stats.skippedBlankOnly} blank-only`);
  }
  if (stats.skippedFindNotFound > 0) {
    skipParts.push(`${stats.skippedFindNotFound} find not found`);
  }
  const skipSuffix =
    skipParts.length > 0 ? `; skipped: ${skipParts.join(', ')}` : '';
  return `Updated notes on ${stats.updated} entries (${stats.examined} examined${skipSuffix}).`;
}

/**
 * mass_tagger-style notes resolution:
 * - find empty + replace → set notes only when current notes are blank
 * - find `*` → replace entire notes
 * - find non-empty → first match replace, else skip
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

  if (!findTrimmed) {
    if (!current.trim()) {
      return { kind: 'set', notes: replace };
    }
    return { kind: 'skip', reason: 'blank-only' };
  }

  if (findTrimmed === '*') {
    return { kind: 'set', notes: replace };
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
  if (isMediaIdEmpty(form.mediaId)) {
    if (wantsMassNotesMode(form)) {
      return {
        kind: 'validation',
        message: 'Mass notes updates are handled separately from single-entry updates.',
      };
    }
    return {
      kind: 'validation',
      message:
        'Media ID is required unless running mass notes tagging (leave Media ID empty and fill Notes Find or Replace).',
    };
  }

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
