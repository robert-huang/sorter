import {
  findAnilistAccountByName,
  requireAccessTokenForUsername,
} from '../../lib/importers/anilist/anilistAuth';
import { makeAnilistImportContext } from '../../lib/importers/anilist/context';
import {
  buildSaveMediaListEntryMutation,
  LIST_NOTES_COLLECTION_QUERY,
  LIST_ENTRY_FOR_MEDIA_QUERY,
  type ListEntryForMediaResponse,
  type ListNotesCollectionEntry,
  type ListNotesCollectionResponse,
  type SaveMediaListEntryResponse,
} from '../../lib/importers/anilist/listMutations';
import { getAnilistUserByName } from '../../lib/importers/anilist/readQueries';
import { sessionMemoDelete } from '../../lib/importers/anilist/toolsSessionMemo';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import type { AnilistMediaType } from '../../lib/importers/anilist/types';
import {
  formatMassNotesSuccessMessage,
  formatUpdateSuccessMessage,
  planMassNotesUpdates,
  validateAndResolveUpdate,
  validateMassNotesMode,
  wantsNotesUpdate,
  type ListEntryNotesRow,
  type UpdateListEntryForm,
} from './updateListEntryLogic';

export type UpdateListEntryResult = {
  message: string;
  mediaId?: number;
  updatedCount?: number;
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

const LIST_NOTES_PER_CHUNK = 500;

function dedupeListNotesEntries(
  entries: readonly ListNotesCollectionEntry[],
): ListEntryNotesRow[] {
  const byMediaId = new Map<number, ListEntryNotesRow>();
  for (const entry of entries) {
    const mediaId = entry.media?.id;
    if (mediaId == null) {
      continue;
    }
    if (!byMediaId.has(mediaId)) {
      byMediaId.set(mediaId, {
        mediaId,
        notes: entry.notes ?? null,
      });
    }
  }
  return [...byMediaId.values()];
}

async function fetchListNotesForType(
  username: string,
  type: AnilistMediaType,
  accessToken: string,
  authFailureUserId: number | undefined,
  signal?: AbortSignal,
): Promise<ListEntryNotesRow[]> {
  const ctx = makeAnilistImportContext({ accessToken, authFailureUserId });
  const accumulated: ListNotesCollectionEntry[] = [];
  let chunk = 1;

  while (true) {
    signal?.throwIfAborted();
    const response = await ctx.executeQuery<ListNotesCollectionResponse>(
      LIST_NOTES_COLLECTION_QUERY,
      { username, type, chunk, perChunk: LIST_NOTES_PER_CHUNK },
    );
    const collection = response?.MediaListCollection;
    for (const group of collection?.lists ?? []) {
      if (group?.entries) {
        accumulated.push(...group.entries);
      }
    }
    if (!collection?.hasNextChunk) {
      break;
    }
    chunk += 1;
  }

  return dedupeListNotesEntries(accumulated);
}

async function fetchAllListNotes(
  username: string,
  accessToken: string,
  authFailureUserId: number | undefined,
  signal?: AbortSignal,
): Promise<ListEntryNotesRow[]> {
  const [anime, manga] = await Promise.all([
    fetchListNotesForType(username, 'ANIME', accessToken, authFailureUserId, signal),
    fetchListNotesForType(username, 'MANGA', accessToken, authFailureUserId, signal),
  ]);
  const byMediaId = new Map<number, ListEntryNotesRow>();
  for (const row of [...anime, ...manga]) {
    if (!byMediaId.has(row.mediaId)) {
      byMediaId.set(row.mediaId, row);
    }
  }
  return [...byMediaId.values()];
}

async function runMassUpdateListEntryNotes(
  form: UpdateListEntryForm,
  username: string,
  accessToken: string,
  authFailureUserId: number | undefined,
  signal?: AbortSignal,
): Promise<UpdateListEntryResult> {
  const validated = validateMassNotesMode(form);
  if (validated.kind === 'validation') {
    throw new Error(validated.message);
  }

  signal?.throwIfAborted();
  const entries = await fetchAllListNotes(
    username,
    accessToken,
    authFailureUserId,
    signal,
  );
  const plan = planMassNotesUpdates(entries, validated.notesInput);

  if (plan.updates.length === 0) {
    return {
      message: formatMassNotesSuccessMessage(plan.stats),
      updatedCount: 0,
    };
  }

  const ctx = makeAnilistImportContext({ accessToken, authFailureUserId });
  for (const update of plan.updates) {
    signal?.throwIfAborted();
    const mutation = buildSaveMediaListEntryMutation(
      { mediaId: update.mediaId, notes: update.notes },
      ['notes'],
    );
    const response = await ctx.executeQuery<SaveMediaListEntryResponse>(
      mutation.query,
      mutation.variables,
    );
    if (!response?.SaveMediaListEntry) {
      throw new Error(`AniList did not return an updated list entry for media ${update.mediaId}.`);
    }
    await patchLocalListEntry(username, update.mediaId, { notes: update.notes });
  }

  return {
    message: formatMassNotesSuccessMessage(plan.stats),
    updatedCount: plan.stats.updated,
  };
}

export async function massUpdateListEntryNotes(
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

  return runMassUpdateListEntryNotes(
    form,
    username,
    accessToken,
    account?.userId,
    signal,
  );
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

export type { AnilistMediaListStatus } from '../../lib/importers/anilist/types';
