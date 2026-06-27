import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ANILIST_ACCOUNTS_CHANGED,
  findAnilistAccountByName,
} from '../../lib/importers/anilist/anilistAuth';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { updateListEntry } from './updateListEntryApi';
import {
  MEDIA_LIST_STATUSES,
  type UpdateListEntryForm,
} from './updateListEntryLogic';

const LS_KEY = 'anime-tools-update-list-entry-form';

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
    return 'Not signed in — open gear menu → Databases tab → Sign in to AniList.';
  }
  if (account.status !== 'ok') {
    return `Sign-in expired or invalid for @${account.userName} — sign in again from the gear menu.`;
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
        fields are sent (blanks fields are ignored). Notes support find-and-replace (<code>*</code> replaces the
        entire note).
      </p>

      <form className="tool-form" onSubmit={onSubmit}>
        <div className="tool-form-section">
          <ToolUsernameField
            label="Username"
            value={form.username}
            disabled={running}
            onChange={(username) => patchForm({ username })}
          />
          {authHint && <p className="tool-field-hint">{authHint}</p>}

          <label className="tool-field tool-field-label-row">
            <span className="tool-field-label">Media ID</span>
            <input
              className="slot-search"
              type="number"
              min={1}
              step={1}
              disabled={running}
              placeholder="AniList Media ID"
              value={form.mediaId}
              onChange={(e) => patchForm({ mediaId: e.target.value })}
            />
          </label>

          <label className="tool-field tool-field-label-row">
            <span className="tool-field-label">Status</span>
            <select
              className="slot-search"
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
          </label>

          <div className="tool-field-row">
            <label className="tool-field tool-field-label-row tool-field-grow">
              <span className="tool-field-label">Progress</span>
              <input
                className="slot-search"
                type="number"
                min={0}
                step={1}
                disabled={running}
                placeholder="Episodes / Chapters"
                value={form.progress}
                onChange={(e) => patchForm({ progress: e.target.value })}
              />
            </label>
            <label className="tool-field tool-field-label-row tool-field-grow">
              <span className="tool-field-label">Progress volumes</span>
              <input
                className="slot-search"
                type="number"
                min={0}
                step={1}
                disabled={running}
                placeholder="Manga Volumes"
                value={form.progressVolumes}
                onChange={(e) => patchForm({ progressVolumes: e.target.value })}
              />
            </label>
          </div>

          <label className="tool-field tool-field-label-row">
            <span className="tool-field-label">Score</span>
            <input
              className="slot-search"
              type="number"
              min={0}
              max={100}
              step={1}
              disabled={running}
              placeholder="0–100 (blank = unchanged)"
              value={form.score}
              onChange={(e) => patchForm({ score: e.target.value })}
            />
          </label>

          <div className="tool-field-row">
            <label className="tool-field tool-field-label-row tool-field-grow">
              <span className="tool-field-label">Notes Find</span>
              <input
                className="slot-search"
                type="text"
                disabled={running}
                placeholder="Find (* for full replace)"
                value={form.notesFind}
                onChange={(e) => patchForm({ notesFind: e.target.value })}
              />
            </label>
            <label className="tool-field tool-field-label-row tool-field-grow">
              <span className="tool-field-label">Notes Replace</span>
              <input
                className="slot-search"
                type="text"
                disabled={running}
                placeholder="Replace With"
                value={form.notesReplace}
                onChange={(e) => patchForm({ notesReplace: e.target.value })}
              />
            </label>
          </div>
          <p className="tool-field-hint">
            Leave find empty to set notes directly. Find must match to replace (first match only).
          </p>
        </div>

        <ToolRunButton
          label="Update"
          running={running}
          disabled={running}
          onRun={() => {
            /* mutation tool — no force-refresh */
          }}
          forceRefreshTitle=""
        />
      </form>

      {error && <p className="tool-error">{error}</p>}
      {success && <p className="tool-field-hint">{success}</p>}
    </section>
  );
}
