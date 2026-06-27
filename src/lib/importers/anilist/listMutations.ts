/**
 * Authenticated list-entry reads and SaveMediaListEntry mutations.
 * Foundation for Tools list updates (see updateListEntryLogic).
 */

/** Viewer-scoped list entry for one media id (requires bearer token). */
export const LIST_ENTRY_FOR_MEDIA_QUERY = `
query ListEntryForMedia($mediaId: Int!) {
  Media(id: $mediaId) {
    mediaListEntry {
      id
      notes
      status
      progress
      progressVolumes
      score(format: POINT_100)
    }
  }
}
`.trim();

export type ListEntryForMediaResponse = {
  Media: {
    mediaListEntry: {
      id: number;
      notes: string | null;
      status: string | null;
      progress: number | null;
      progressVolumes: number | null;
      score: number | null;
    } | null;
  } | null;
};

export type SaveMediaListEntryMutationField =
  | 'status'
  | 'progress'
  | 'progressVolumes'
  | 'scoreRaw'
  | 'notes';

export type SaveMediaListEntryVariables = {
  mediaId: number;
  status?: string;
  progress?: number;
  progressVolumes?: number;
  scoreRaw?: number;
  notes?: string | null;
};

export type SaveMediaListEntryMutation = {
  query: string;
  variables: SaveMediaListEntryVariables;
};

const FIELD_SPECS: Record<
  SaveMediaListEntryMutationField,
  { varDecl: string; arg: string; responseField: string }
> = {
  status: {
    varDecl: '$status: MediaListStatus',
    arg: 'status: $status',
    responseField: 'status',
  },
  progress: {
    varDecl: '$progress: Int',
    arg: 'progress: $progress',
    responseField: 'progress',
  },
  progressVolumes: {
    varDecl: '$progressVolumes: Int',
    arg: 'progressVolumes: $progressVolumes',
    responseField: 'progressVolumes',
  },
  scoreRaw: {
    varDecl: '$scoreRaw: Int',
    arg: 'scoreRaw: $scoreRaw',
    responseField: 'scoreRaw',
  },
  notes: {
    varDecl: '$notes: String',
    arg: 'notes: $notes',
    responseField: 'notes',
  },
};

/** Build a partial SaveMediaListEntry mutation — only declared fields are sent. */
export function buildSaveMediaListEntryMutation(
  variables: SaveMediaListEntryVariables,
  fields: readonly SaveMediaListEntryMutationField[],
): SaveMediaListEntryMutation {
  const varDecls = ['$mediaId: Int!'];
  const args = ['mediaId: $mediaId'];
  const responseFields = ['id'];

  for (const field of fields) {
    const spec = FIELD_SPECS[field];
    varDecls.push(spec.varDecl);
    args.push(spec.arg);
    responseFields.push(spec.responseField);
  }

  const query = `
mutation SaveMediaListEntry(${varDecls.join(', ')}) {
  SaveMediaListEntry(${args.join(', ')}) {
    ${responseFields.join('\n    ')}
  }
}`.trim();

  return { query, variables };
}

export type SaveMediaListEntryResponse = {
  SaveMediaListEntry: {
    id: number;
    status?: string | null;
    progress?: number | null;
    progressVolumes?: number | null;
    scoreRaw?: number | null;
    notes?: string | null;
  } | null;
};
