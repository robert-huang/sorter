import { useMemo, useRef, useState, type DragEvent } from 'react';
import type { SlotRankingImport } from '../lib/slotResultsImport';
import {
  mergeImportedVersions,
  snapshotFromRankedItems,
  snapshotSortVersion,
  sortVersionDiffCounts,
  summarizeSortVersionDiff,
  type MergedSortVersions,
} from '../lib/sortVersions';
import { formatDateTimeLocal, toDateTimeLocal } from '../lib/dateTimeText';
import { loadSaveFromFile } from '../lib/storage';
import type { SlotsManifest, SortVersion } from '../lib/types';
import { DateTimeField } from './DateTimeField';
import { RemoveGlyph } from './RemoveGlyph';
import { SortResultsImportMode } from './SortResultsImportMode';
import { VersionRanking } from './SortVersionsModal';
import { dragEventHasFiles } from './settingsImportDropH';

interface Props {
  /** The active save's versions, oldest first. */
  versions: readonly SortVersion[];
  /** Active slot — hidden from the save picker. */
  excludeSlotId?: string;
  browserSaveManifest?: SlotsManifest;
  onApply: (versions: SortVersion[]) => void;
  onClose: () => void;
}

/** One staged source; `date` is a `datetime-local` value and becomes the version's `createdAt`. */
type StagedSource = {
  key: string;
  name: string;
  date: string;
  snapshot: SortVersion;
  /** The source's own recorded versions, imported with their own dates. */
  nested: SortVersion[];
};

type PendingSave = MergedSortVersions & { deleted: number; redated: number };

const isoToLocal = (iso: string): string => toDateTimeLocal(new Date(iso));

function fromDateTimeLocal(value: string, fallbackIso: string): string {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? fallbackIso : new Date(ms).toISOString();
}

let stagedKeySeq = 0;
const nextStagedKey = (): string => `staged-${++stagedKeySeq}`;

function stagedFromRankingImport(imp: SlotRankingImport): StagedSource | null {
  const createdAt = imp.createdAt ?? new Date().toISOString();
  const snapshot = snapshotFromRankedItems(imp.items, createdAt);
  if (!snapshot) return null;
  return {
    key: nextStagedKey(),
    name: imp.slotName,
    date: isoToLocal(createdAt),
    snapshot,
    nested: imp.versionId ? [] : (imp.versions ?? []),
  };
}

async function stagedFromFile(file: File): Promise<StagedSource> {
  const blob = await loadSaveFromFile(file);
  if (!blob.progress.done) {
    throw new Error('in progress — only finished sorts can be imported');
  }
  const createdAt = new Date(file.lastModified || Date.now()).toISOString();
  const snapshot = snapshotSortVersion(blob, createdAt);
  if (!snapshot) throw new Error('no ranked items');
  return {
    key: nextStagedKey(),
    name: file.name.replace(/\.json$/i, ''),
    date: isoToLocal(createdAt),
    snapshot,
    nested: blob.versions ?? [],
  };
}

/** Versions the staged sources contribute, with each row's edited date applied. */
function stagedSourceVersions(rows: readonly StagedSource[]): SortVersion[] {
  return rows.flatMap((row) => [
    ...row.nested,
    { ...row.snapshot, createdAt: fromDateTimeLocal(row.date, row.snapshot.createdAt) },
  ]);
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function previewText(pending: PendingSave): string {
  const parts: string[] = [];
  if (pending.added > 0) parts.push(`Adds ${plural(pending.added, 'version')}`);
  if (pending.deleted > 0) parts.push(`deletes ${pending.deleted}`);
  if (pending.redated > 0) parts.push(`redates ${pending.redated}`);
  if (pending.skipped > 0) parts.push(`${plural(pending.skipped, 'identical ranking')} skipped`);
  const text = parts.join('; ');
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : 'No changes.';
}

/** "2 up · 1 down · 1 removed", with up and down coloured. */
function VersionCounts({ prev, version }: { prev: SortVersion | null; version: SortVersion }) {
  const counts = sortVersionDiffCounts(prev, version);
  if (!counts) return <>First version</>;
  if (counts.length === 0) return <>No changes</>;
  return (
    <>
      {counts.map(({ kind, count }, i) => (
        <span key={kind}>
          {i > 0 && ' · '}
          <span className={`sort-version-count ${kind}`}>{`${count} ${kind}`}</span>
        </span>
      ))}
    </>
  );
}

/**
 * Edits the active save's version history: redate or delete recorded versions and
 * import archived copies (save files, browser saves, Drive saves). Saving re-sorts by
 * date and recalculates each version's changes. The current ranking is untouched.
 */
export function SortHistoryPage({
  versions,
  excludeSlotId,
  browserSaveManifest,
  onApply,
  onClose,
}: Props) {
  const [staged, setStaged] = useState<StagedSource[]>([]);
  const [dateEdits, setDateEdits] = useState<Readonly<Record<string, string>>>({});
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [pending, setPending] = useState<PendingSave | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const existingRows = useMemo(
    () =>
      versions
        .map((version, i) => ({ version, prev: i > 0 ? versions[i - 1]! : null }))
        .reverse(),
    [versions],
  );
  const sortedStaged = useMemo(
    () => [...staged].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)),
    [staged],
  );
  const dirty = staged.length > 0 || deleted.size > 0 || Object.keys(dateEdits).length > 0;

  const touch = (): void => {
    setPending(null);
    setSavedMessage(null);
  };

  const stage = (added: StagedSource[]): void => {
    if (added.length === 0) return;
    setStaged((prev) => [...prev, ...added]);
    touch();
  };

  const addFiles = async (files: readonly File[]): Promise<void> => {
    const results = await Promise.allSettled(files.map(stagedFromFile));
    const failures: string[] = [];
    const added: StagedSource[] = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') added.push(result.value);
      else {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push(`${files[i]!.name}: ${reason}`);
      }
    });
    stage(added);
    setErrors(failures);
  };

  const onDrop = (e: DragEvent<HTMLElement>): void => {
    if (!dragEventHasFiles(e)) return;
    e.preventDefault();
    setDropActive(false);
    void addFiles(Array.from(e.dataTransfer.files));
  };

  const editExistingDate = (version: SortVersion, date: string): void => {
    setDateEdits((prev) => {
      const next = { ...prev };
      if (date === isoToLocal(version.createdAt)) delete next[version.id];
      else next[version.id] = date;
      return next;
    });
    touch();
  };

  const toggleDeleted = (id: string): void => {
    setDeleted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    touch();
  };

  const editStagedDate = (key: string, date: string): void => {
    setStaged((prev) => prev.map((row) => (row.key === key ? { ...row, date } : row)));
    touch();
  };

  const removeStaged = (key: string): void => {
    setStaged((prev) => prev.filter((row) => row.key !== key));
    touch();
  };

  const prepareSave = (): void => {
    const kept = versions
      .filter((v) => !deleted.has(v.id))
      .map((v) => {
        const edit = dateEdits[v.id];
        return edit === undefined ? v : { ...v, createdAt: fromDateTimeLocal(edit, v.createdAt) };
      });
    const redated = Object.keys(dateEdits).filter((id) => !deleted.has(id)).length;
    const merged = mergeImportedVersions(kept, stagedSourceVersions(staged));
    setPending({ ...merged, deleted: deleted.size, redated });
  };

  const confirmSave = (): void => {
    if (!pending) return;
    onApply(pending.versions);
    setSavedMessage(`Saved · ${plural(pending.versions.length, 'version')}`);
    setStaged([]);
    setDateEdits({});
    setDeleted(new Set());
    setPending(null);
  };

  return (
    <div className="page sort-history-page">
      <div className="page-section">
        <div className="sort-history-page-head">
          <h2>Version history</h2>
          <button type="button" className="btn" onClick={onClose}>
            ← Back to results
          </button>
        </div>
        <p className="header-hint">
          Change a version&rsquo;s date or delete it, and import archived copies of this sort.
          Saving re-sorts versions by date and recalculates what changed between them. The
          current ranking and the source saves are not changed.
        </p>

        <h3>Versions</h3>
        {existingRows.length === 0 ? (
          <p className="header-hint">No versions recorded yet.</p>
        ) : (
          <ul className="sort-history-import-rows" aria-label="Recorded versions">
            {existingRows.map(({ version, prev }) => {
              const isDeleted = deleted.has(version.id);
              const date = dateEdits[version.id] ?? isoToLocal(version.createdAt);
              const label = formatDateTimeLocal(isoToLocal(version.createdAt));
              const expanded = expandedId === version.id;
              return (
                <li
                  key={version.id}
                  className={`sort-history-import-row${isDeleted ? ' is-deleted' : ''}`}
                >
                  <DateTimeField
                    label={`Date for version from ${label}`}
                    value={date}
                    disabled={isDeleted}
                    onChange={(next) => editExistingDate(version, next)}
                  />
                  <button
                    type="button"
                    className="sort-history-import-name sort-history-version-toggle"
                    aria-expanded={expanded}
                    title={summarizeSortVersionDiff(prev, version)}
                    onClick={() => setExpandedId(expanded ? null : version.id)}
                  >
                    <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>{' '}
                    <VersionCounts prev={prev} version={version} />
                  </button>
                  {version.live && <span className="sort-versions-current">Current</span>}
                  <span className="sort-history-import-count">
                    {plural(version.rankedIds.length, 'item')}
                  </span>
                  {version.live ? (
                    <span className="sort-history-import-action-spacer" aria-hidden="true" />
                  ) : (
                    <button
                      type="button"
                      className="btn icon-only"
                      aria-label={`${isDeleted ? 'Keep' : 'Delete'} version from ${label}`}
                      title={isDeleted ? 'Keep this version' : 'Delete this version'}
                      onClick={() => toggleDeleted(version.id)}
                    >
                      {isDeleted ? '↺' : <RemoveGlyph size={12} />}
                    </button>
                  )}
                  {expanded && (
                    <div className="sort-history-version-detail">
                      <VersionRanking version={version} prev={prev} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <h3>Import</h3>
        <div
          className={`sort-history-import-drop${dropActive ? ' is-import-drop-target' : ''}`}
          onDragOver={(e) => {
            if (!dragEventHasFiles(e)) return;
            e.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={onDrop}
        >
          <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
            Load save file…
          </button>
          <button type="button" className="btn" onClick={() => setPickerOpen((open) => !open)}>
            {pickerOpen ? 'Hide sorter slots' : 'Import sorter slot…'}
          </button>
          <span className="header-hint">or drop save files here</span>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            multiple
            hidden
            aria-label="Save files to import as versions"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              void addFiles(files);
            }}
          />
        </div>

        {errors.length > 0 && (
          <ul className="sort-history-import-errors">
            {errors.map((message) => (
              <li key={message} className="error-text">
                {message}
              </li>
            ))}
          </ul>
        )}

        {pickerOpen && (
          <SortResultsImportMode
            embedded
            embeddedHint="Pick finished sorter slots. Check specific versions to import those instead of a slot's current ranking; a slot's own history comes along otherwise."
            excludeSlotId={excludeSlotId}
            browserSaveManifest={browserSaveManifest}
            showPreRankedToggle={false}
            pickVersions
            onImportOrderedItems={(imports) =>
              stage(
                imports
                  .map(stagedFromRankingImport)
                  .filter((row): row is StagedSource => row !== null),
              )
            }
            onComplete={() => setPickerOpen(false)}
          />
        )}

        {sortedStaged.length > 0 && (
          <ul className="sort-history-import-rows" aria-label="Staged versions">
            {sortedStaged.map((row) => (
              <li key={row.key} className="sort-history-import-row">
                <DateTimeField
                  label={`Date for ${row.name}`}
                  value={row.date}
                  onChange={(next) => editStagedDate(row.key, next)}
                />
                <span className="sort-history-import-name">{row.name}</span>
                <span className="sort-history-import-count">
                  {plural(row.snapshot.rankedIds.length, 'item')}
                  {row.nested.length > 0
                    ? ` · +${plural(row.nested.length, 'earlier version')}`
                    : ''}
                </span>
                <button
                  type="button"
                  className="btn icon-only"
                  aria-label={`Remove ${row.name}`}
                  title="Remove"
                  onClick={() => removeStaged(row.key)}
                >
                  <RemoveGlyph size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="sort-history-footer">
          <p className="sort-history-import-preview" aria-live="polite">
            {pending ? previewText(pending) : savedMessage}
          </p>
          <div className="sort-history-footer-actions">
            {pending ? (
              <>
                <button className="btn" onClick={() => setPending(null)}>
                  Cancel
                </button>
                <button className="btn primary" onClick={confirmSave}>
                  Confirm
                </button>
              </>
            ) : (
              <button className="btn primary" disabled={!dirty} onClick={prepareSave}>
                Save changes
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
