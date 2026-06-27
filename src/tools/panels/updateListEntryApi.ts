import {
  findAnilistAccountByName,
  requireAccessTokenForUsername,
} from '../../lib/importers/anilist/anilistAuth';
import { makeAnilistImportContext } from '../../lib/importers/anilist/context';
import {
  LIST_ENTRY_FOR_MEDIA_QUERY,
  type ListEntryForMediaResponse,
  type SaveMediaListEntryResponse,
} from '../../lib/importers/anilist/listMutations';
import { getAnilistUserByName } from '../../lib/importers/anilist/readQueries';
import { sessionMemoDelete } from '../../lib/importers/anilist/toolsSessionMemo';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import type { AnilistMediaListStatus } from '../../lib/importers/anilist/types';
import {
  formatUpdateSuccessMessage,
  validateAndResolveUpdate,
  wantsNotesUpdate,
  type UpdateListEntryForm,
} from './updateListEntryLogic';

export type UpdateListEntryResult = {
  message: string;
  mediaId: number;
};

async function fetchCurrentListEntryNotes(
  mediaId: number,
  accessToken: string,
  authFailureUserId: number | undefined,
): Promise<string | null | undefined> {
  const ctx = makeAnilistImportContext({ accessToken, authFailureUserId });
  const data = await ctx.executeQuery<ListEntryForMediaResponse>(
    LIST_ENTRY_FOR_MEDIA_QUERY,
    { mediaId },
  );
  const entry = data?.Media?.mediaListEntry;
  if (!entry) {
    return undefined;
  }
  return entry.notes ?? null;
}

async function patchLocalListEntry(
  username: string,
  mediaId: number,
  patch: {
    status?: string;
    score?: number | null;
    notes?: string | null;
  },
): Promise<void> {
  const ctx = getToolsImportContext();
  const user = await getAnilistUserByName(ctx.db, username.trim());
  if (!user) {
    return;
  }

  const existing = await ctx.db.exec(
    `SELECT 1 AS ok FROM media_list_entry WHERE anilist_user_id = ? AND media_id = ?`,
    [user.id, mediaId],
  );
  if (existing.length === 0) {
    return;
  }

  const sets: string[] = ['updated_at = ?'];
  const params: Array<string | number | null> = [ctx.now()];

  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.score !== undefined) {
    sets.push('score = ?');
    params.push(patch.score);
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?');
    params.push(patch.notes);
  }

  if (sets.length === 1) {
    return;
  }

  params.push(user.id, mediaId);
  await ctx.db.exec(
    `UPDATE media_list_entry
        SET ${sets.join(', ')}
      WHERE anilist_user_id = ?
        AND media_id = ?`,
    params,
  );

  await ctx.onDirtyIncrement?.();
  sessionMemoDelete(`seasonal:list:${username.trim().toLowerCase()}`);
}

export async function updateListEntry(
  form: UpdateListEntryForm,
  signal?: AbortSignal,
): Promise<UpdateListEntryResult> {
  signal?.throwIfAborted();

  const username = form.username.trim();
  if (!username) {
    throw new Error('Username is required.');
  }

  const account = findAnilistAccountByName(username);
  const accessToken = requireAccessTokenForUsername(username);

  const notesInput = { find: form.notesFind, replace: form.notesReplace };
  let currentNotes: string | null | undefined;
  if (wantsNotesUpdate(notesInput)) {
    currentNotes = await fetchCurrentListEntryNotes(
      Number(form.mediaId.trim()),
      accessToken,
      account?.userId,
    );
  }

  const resolved = validateAndResolveUpdate(form, currentNotes);
  if (resolved.kind === 'validation') {
    throw new Error(resolved.message);
  }

  signal?.throwIfAborted();

  const ctx = makeAnilistImportContext({
    accessToken,
    authFailureUserId: account?.userId,
  });
  const response = await ctx.executeQuery<SaveMediaListEntryResponse>(
    resolved.mutation.query,
    resolved.mutation.variables,
  );

  if (!response?.SaveMediaListEntry) {
    throw new Error('AniList did not return an updated list entry.');
  }

  const patch: {
    status?: string;
    score?: number | null;
    notes?: string | null;
  } = {};

  if (resolved.variables.status !== undefined) {
    patch.status = resolved.variables.status;
  }
  if (resolved.variables.scoreRaw !== undefined) {
    patch.score = resolved.variables.scoreRaw;
  }
  if (resolved.variables.notes !== undefined) {
    patch.notes = resolved.variables.notes;
  }

  if (Object.keys(patch).length > 0) {
    await patchLocalListEntry(username, resolved.mediaId, patch);
  }

  return {
    mediaId: resolved.mediaId,
    message: formatUpdateSuccessMessage(resolved.appliedLabels, resolved.skippedNotesReason),
  };
}

export type { AnilistMediaListStatus };
