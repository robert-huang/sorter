import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ANILIST_ACCOUNTS_CHANGED,
  findAnilistAccountByName,
} from '../../lib/importers/anilist/anilistAuth';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import type { ToolPanelProps } from '../toolTypes';
import { ToolClearableInput } from '../ToolClearableInput';
import { ToolRunButton } from '../ToolRunButton';
import { updateListEntry } from './updateListEntryApi';
import {
  MEDIA_LIST_STATUSES,
  type UpdateListEntryForm,
} from './updateListEntryLogic';

const LS_KEY = 'anime-tools-update-list-entry-form';

const FIELD_IDS = {
  username: 'update-list-entry-username',
  mediaId: 'update-list-entry-media-id',
  status: 'update-list-entry-status',
  progress: 'update-list-entry-progress',
  progressVolumes: 'update-list-entry-progress-volumes',
  score: 'update-list-entry-score',
  notesFind: 'update-list-entry-notes-find',
  notesReplace: 'update-list-entry-notes-replace',
} as const;

const DEFAULT_FORM: UpdateListEntryForm = {
  username: '',
  mediaId: '',
  status: '',
  progress: '',
  progressVolumes: '',
  score: '',
  notesFind: '',
  notesReplace: '',
};

type PersistedForm = Pick<UpdateListEntryForm, 'username'>;

function loadForm(): UpdateListEntryForm {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedForm>;
      return {
        ...DEFAULT_FORM,
        username: withLastAnilistUsername(parsed.username ?? ''),
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_FORM, username: withLastAnilistUsername('') };
}

function saveUsername(username: string): void {
  try {
    const persisted: PersistedForm = { username };
    localStorage.setItem(LS_KEY, JSON.stringify(persisted));
  } catch {
    /* ignore */
  }
}

function authHintForUsername(username: string): string | null {
  const handle = username.trim();
  if (!handle) {
    return null;
  }
  const account = findAnilistAccountByName(handle);
  if (!account) {
    return 'Not signed in — gear → Databases → Sign in to AniList.';
  }
  if (account.status !== 'ok') {
    return `Sign-in expired for @${account.userName} — sign in again.`;
  }
  return `Signed in as @${account.userName}.`;
}

export function UpdateListEntryPanel(_props: ToolPanelProps) {
  const [form, setForm] = useState<UpdateListEntryForm>(() => loadForm());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [authRevision, setAuthRevision] = useState(0);

  useEffect(() => {
    saveUsername(form.username);
  }, [form.username]);

  useEffect(() => {
    const onAccountsChanged = (): void => {
      setAuthRevision((n) => n + 1);
    };
    window.addEventListener(ANILIST_ACCOUNTS_CHANGED, onAccountsChanged);
    return () => {
      window.removeEventListener(ANILIST_ACCOUNTS_CHANGED, onAccountsChanged);
    };
  }, []);

  const authHint = useMemo(
    () => authHintForUsername(form.username),
    [form.username, authRevision],
  );

  const patchForm = useCallback((patch: Partial<UpdateListEntryForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const onSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setRunning(true);
      setError(null);
      setSuccess(null);
      try {
        const result = await updateListEntry(form);
        setSuccess(result.message);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Update failed.');
      } finally {
        setRunning(false);
      }
    },
    [form],
  );

  return (
    <section className="tool-panel">
      <p className="tool-panel-lead">
        Patch one AniList list entry via <code>SaveMediaListEntry</code>. Only filled
        fields are sent (blank fields are ignored). Notes support find-and-replace (
        <code>*</code> replaces the entire note).
      </p>

      <form className="tool-form-card tool-update-list-entry-form" onSubmit={onSubmit}>
        <div className="tool-update-list-entry-grid">
          <label className="tool-update-list-entry-label" htmlFor={FIELD_IDS.username}>
            Username
          </label>
          <div className="tool-update-list-entry-control">
            <input
              id={FIELD_IDS.username}
              className="slot-search tool-update-list-entry-username-input"
              type="text"
              disabled={running}
              placeholder="AL Username"
              value={form.username}
              onChange={(e) => patchForm({ username: e.target.value })}
            />
            {authHint && <span className="tool-field-hint tool-field-hint-inline">{authHint}</span>}
          </div>

          <label className="tool-update-list-entry-label" htmlFor={FIELD_IDS.mediaId}>
            Media ID
          </label>
          <div className="tool-update-list-entry-control">
            <ToolClearableInput
              id={FIELD_IDS.mediaId}
              className="tool-update-list-entry-media-id"
              type="number"
              min={1}
              step={1}
              disabled={running}
              placeholder="AniList Media ID"
              value={form.mediaId}
              onChange={(mediaId) => patchForm({ mediaId })}
            />
          </div>

          <label className="tool-update-list-entry-label" htmlFor={FIELD_IDS.status}>
            Status
          </label>
          <div className="tool-update-list-entry-control">
            <select
              id={FIELD_IDS.status}
              className="slot-search tool-update-list-entry-status"
              disabled={running}
              value={form.status}
              onChange={(e) => patchForm({ status: e.target.value })}
            >
              <option value="">(unchanged)</option>
              {MEDIA_LIST_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>

          <label className="tool-update-list-entry-label" htmlFor={FIELD_IDS.progress}>
            Progress
          </label>
          <div className="tool-update-list-entry-control">
            <ToolClearableInput
              id={FIELD_IDS.progress}
              className="tool-update-list-entry-number"
              type="number"
              min={0}
              step={1}
              disabled={running}
              placeholder="Episodes / Chapters"
              value={form.progress}
              onChange={(progress) => patchForm({ progress })}
            />

            <label
              className="tool-update-list-entry-label"
              htmlFor={FIELD_IDS.progressVolumes}
            >
              Progress Volumes
            </label>
            <ToolClearableInput
              id={FIELD_IDS.progressVolumes}
              className="tool-update-list-entry-number"
              type="number"
              min={0}
              step={1}
              disabled={running}
              placeholder="Manga Volumes"
              value={form.progressVolumes}
              onChange={(progressVolumes) => patchForm({ progressVolumes })}
            />
          </div>

          <label className="tool-update-list-entry-label" htmlFor={FIELD_IDS.score}>
            Score
          </label>
          <div className="tool-update-list-entry-control">
            <ToolClearableInput
              id={FIELD_IDS.score}
              className="tool-update-list-entry-number"
              type="number"
              min={0}
              max={100}
              step={1}
              disabled={running}
              placeholder=""
              value={form.score}
              onChange={(score) => patchForm({ score })}
            />
          </div>

          <label className="tool-update-list-entry-label" htmlFor={FIELD_IDS.notesFind}>
            Notes Find
          </label>
          <div className="tool-update-list-entry-control">
            <ToolClearableInput
              id={FIELD_IDS.notesFind}
              className="tool-update-list-entry-notes-input"
              disabled={running}
              placeholder="Find (* = full replace)"
              value={form.notesFind}
              onChange={(notesFind) => patchForm({ notesFind })}
            />

            <label
              className="tool-update-list-entry-label"
              htmlFor={FIELD_IDS.notesReplace}
            >
              Notes Replace
            </label>
            <ToolClearableInput
              id={FIELD_IDS.notesReplace}
              className="tool-update-list-entry-notes-input"
              disabled={running}
              placeholder="Replace With"
              value={form.notesReplace}
              onChange={(notesReplace) => patchForm({ notesReplace })}
            />
          </div>

          <p className="tool-field-hint tool-update-list-entry-hint-row">
            Leave Find empty to set notes directly on all entries with no notes. Find must match to replace (first match only).
          </p>

          <div className="tool-actions tool-update-list-entry-actions">
            <ToolRunButton
              label="Update"
              running={running}
              disabled={running}
              onRun={() => {
                /* mutation tool — no force-refresh */
              }}
              forceRefreshTitle=""
            />
          </div>
        </div>
      </form>

      {error && <p className="tool-error">{error}</p>}
      {success && <p className="tool-field-hint">{success}</p>}
    </section>
  );
}
