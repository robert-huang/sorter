import { useEffect, useMemo, useRef, useState } from 'react';
import type { Item } from '../lib/types';
import { Modal } from './Modal';

/**
 * Save payload. All four fields are optional:
 *  - `label / url / imageUrl` — metadata patch (existing behavior).
 *  - `id` — new logical id, set when the user opens the "Show
 *    advanced" panel and types a new id. Caller is responsible for
 *    propagating the rename through the engine state and the undo
 *    ring (see `engine.updateItemId` + `engine.rewriteIdInProgress`).
 */
export interface EditItemSavePayload {
  label?: string;
  url?: string;
  imageUrl?: string;
  id?: string;
}

interface Props {
  item: Item;
  onCancel: () => void;
  onSave: (patch: EditItemSavePayload) => void;
  /**
   * Which optional fields to render. Defaults to `{ url: true,
   * imageUrl: true }`. The START tab passes `{ url: false, imageUrl:
   * false }` because pre-parse rows don't carry URL / image yet —
   * those columns live on the source CSV and are picked up when the
   * row is committed.
   */
  fieldsToShow?: { url?: boolean; imageUrl?: boolean };
  /**
   * When true, reveals the "Show advanced" toggle that exposes the
   * logical-id editor. Requires `currentId` (pre-fill) and `otherIds`
   * (collision check).
   */
  allowEditId?: boolean;
  /** Current id, pre-fill for the advanced id input. */
  currentId?: string;
  /**
   * Map of OTHER existing ids → display label, used to validate that
   * the user-typed id doesn't collide with anything else. Must
   * exclude the item-being-edited's own id (so editing the label
   * without touching the id never trips the validator).
   */
  otherIds?: Map<string, string>;
  /**
   * Verbatim parsed cells for the originating CSV row. When present,
   * the modal renders a read-only "Original row" panel above the
   * form so the user can manually copy the right substrings into the
   * label / url / image fields when an unquoted comma broke the parse.
   *
   * Provided by the START tab when opening the modal for a row that
   * tripped an `ExtraColumnsWarning`. Undefined for normal edit flows
   * (no warning, no need to surface the row text).
   */
  rawRow?: string[];
}

/**
 * In-place metadata editor for a single item. Driving use-case: a pasted
 * list whose label contains a comma gets mis-parsed by the CSV path
 * (`"Foo, Inc, https://example.com"` → label=`"Foo"`, url=`" Inc"`,
 * imageUrl=`"https://example.com"`). The user wants to fix the
 * affected item without starting the sort over.
 *
 * URL / Image URL fields treat an empty string as "clear it" — this is
 * how the user removes a bogus URL that came from the comma split.
 *
 * With `allowEditId`, a "Show advanced" toggle reveals an optional
 * "Logical ID" input. The id is otherwise hidden because it's internal
 * — the user normally never sees it. Surfacing it lets the user
 * disambiguate the rare case where two genuinely different labels
 * slug to the same id (e.g. Kaguya-sama S1 vs S2) without changing
 * the displayed label.
 */
export function EditItemModal({
  item,
  onCancel,
  onSave,
  fieldsToShow,
  allowEditId,
  currentId,
  otherIds,
  rawRow,
}: Props) {
  const showUrl = fieldsToShow?.url ?? true;
  const showImageUrl = fieldsToShow?.imageUrl ?? true;

  const [label, setLabel] = useState(item.label);
  const [url, setUrl] = useState(item.url ?? '');
  const [imageUrl, setImageUrl] = useState(item.imageUrl ?? '');
  // Default-hidden advanced panel. Once opened we keep it open for
  // the rest of the modal's lifetime (re-mount resets to closed).
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Logical ID draft starts EMPTY rather than prefilled with the
  // current id. The current id is shown as the input's placeholder so
  // the user can see it for reference, but clicking into the field
  // doesn't dump prefilled text into their selection — they can just
  // start typing the new id. An empty draft on Save is treated as
  // "no rename intended" (idDirty stays false), so the user can open
  // the advanced panel, look at the current id, and back out without
  // any save-blocking validation noise.
  const [idDraft, setIdDraft] = useState('');
  const labelRef = useRef<HTMLInputElement | null>(null);

  // Autofocus the label and select its contents so the most common edit
  // (overwriting a mis-parsed label) is one keystroke.
  useEffect(() => {
    labelRef.current?.focus();
    labelRef.current?.select();
  }, []);

  const trimmedLabel = label.trim();
  const trimmedId = idDraft.trim();

  // id validation (only meaningful when allowEditId is on and the
  // advanced panel is open). Returns either null (valid) or a string
  // (error message to render inline + block Save).
  const idError = useMemo<string | null>(() => {
    if (!allowEditId || !showAdvanced) return null;
    // Empty draft = user has not entered a new id; the current id is
    // shown as a placeholder. Treat as no-op, not an error.
    if (trimmedId.length === 0) return null;
    // No-op id (same as current) is valid; we just won't include it
    // in the save payload.
    if (trimmedId === (currentId ?? item.id)) return null;
    const collision = otherIds?.get(trimmedId);
    if (collision !== undefined) {
      return `ID "${trimmedId}" is already used by "${collision}"`;
    }
    return null;
  }, [allowEditId, showAdvanced, trimmedId, currentId, item.id, otherIds]);

  const labelDirty = trimmedLabel !== item.label;
  const urlDirty = showUrl && url.trim() !== (item.url ?? '');
  const imageUrlDirty = showImageUrl && imageUrl.trim() !== (item.imageUrl ?? '');
  // Empty draft means the user didn't enter a new id, so we leave the
  // existing one alone — only flag dirty when a non-empty draft
  // differs from the current id.
  const idDirty =
    allowEditId &&
    showAdvanced &&
    trimmedId.length > 0 &&
    trimmedId !== (currentId ?? item.id);

  const canSave =
    trimmedLabel.length > 0 &&
    idError === null &&
    (labelDirty || urlDirty || imageUrlDirty || idDirty);

  function commit(): void {
    if (!canSave) return;
    const payload: EditItemSavePayload = { label: trimmedLabel };
    if (showUrl) payload.url = url.trim();
    if (showImageUrl) payload.imageUrl = imageUrl.trim();
    if (idDirty) payload.id = trimmedId;
    onSave(payload);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    // Enter on any field commits the form so the user doesn't have to
    // reach for the mouse on a single-field fix. Escape is handled by
    // the Modal wrapper (focus is inside the panel so the wrapper's
    // keydown still fires).
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  }

  // Friendly help text varies depending on which optional fields are
  // visible — the START tab usage doesn't show URL/image so we don't
  // mention them.
  const helpText =
    showUrl || showImageUrl
      ? 'Fix a mis-parsed label, URL, or image. The item\u2019s position in the sort is preserved. Leave URL or Image URL blank to clear.'
      : 'Rename this row so it no longer collides with another row in the import preview.';

  return (
    <Modal label="Edit item" onClose={onCancel}>
      <h3>Edit item</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 0 }}>
        {helpText}
      </p>
      {rawRow && rawRow.length > 0 && <OriginalRowPanel rawRow={rawRow} />}
      <div className="edit-item-form">
        <label className="edit-item-field">
          <span className="edit-item-label">Label</span>
          <input
            ref={labelRef}
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Item name"
          />
        </label>
        {showUrl && (
          <label className="edit-item-field">
            <span className="edit-item-label">URL</span>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="https://… (optional)"
            />
          </label>
        )}
        {showImageUrl && (
          <label className="edit-item-field">
            <span className="edit-item-label">Image URL</span>
            <input
              type="text"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="https://… (optional)"
            />
          </label>
        )}
      </div>
      {allowEditId && (
        <div className="edit-item-advanced">
          {!showAdvanced ? (
            <button
              type="button"
              className="link-btn"
              onClick={() => setShowAdvanced(true)}
            >
              Show advanced
            </button>
          ) : (
            <>
              <div className="edit-item-advanced-header">
                <span className="edit-item-advanced-title">Advanced</span>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setShowAdvanced(false);
                    // Reset draft to empty so reopening the panel
                    // shows the current id as a placeholder again
                    // rather than carrying stale typed text the user
                    // implicitly abandoned.
                    setIdDraft('');
                  }}
                >
                  Hide
                </button>
              </div>
              <label className="edit-item-field">
                <span className="edit-item-label">Logical ID</span>
                <input
                  type="text"
                  value={idDraft}
                  onChange={(e) => setIdDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                  // Show the current id as a faded placeholder rather
                  // than as a prefilled value — clicking into the
                  // field gives the user a clean slate, and leaving
                  // it blank means "keep the existing id."
                  placeholder={currentId ?? item.id}
                  aria-invalid={idError !== null}
                />
              </label>
              {idError !== null && (
                <div className="edit-item-id-error" role="alert">
                  {idError}
                </div>
              )}
              <p
                style={{
                  fontSize: 12,
                  color: 'var(--text-muted)',
                  margin: '4px 0 0',
                }}
              >
                The id is the item&rsquo;s internal handle. Change it
                only when you need two differently-spelled labels to
                stay distinct from one whose label collapses to the
                same canonical form.
              </p>
            </>
          )}
        </div>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn primary"
          onClick={commit}
          disabled={!canSave}
          title={
            !canSave
              ? trimmedLabel.length === 0
                ? 'Label cannot be blank'
                : idError !== null
                  ? idError
                  : 'No changes to save'
              : 'Save changes'
          }
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

/**
 * Read-only panel that renders the verbatim parsed cells for a row
 * that tripped an `ExtraColumnsWarning`, joined with commas so the
 * user sees the row exactly as it appeared in the source CSV (the
 * warning only fires on unquoted-comma rows, so `cells.join(',')`
 * faithfully reconstructs the original line — papaparse preserves
 * the literal cell text including any leading whitespace from after
 * a comma).
 *
 * The user repairs the row by selecting any contiguous substring of
 * the panel and either dragging it into the form field below or
 * copy-pasting. Both are native browser behaviors for text-selectable
 * elements + `<input>` drop targets, so the panel itself doesn't need
 * any apply buttons or selection-mirroring state — that earlier
 * implementation made the common case (drop the whole row into the
 * label) finicky around Cmd+A / triple-click selection extension.
 */
function OriginalRowPanel({ rawRow }: { rawRow: string[] }) {
  // papaparse keeps leading whitespace on cells after a comma, so the
  // `,`-join reconstructs the user's original line for any row that
  // tripped the >3-cells warning (which by definition was unquoted).
  const text = useMemo(() => rawRow.join(','), [rawRow]);

  return (
    <div className="edit-item-rawrow">
      <div className="edit-item-rawrow-header">
        <strong>Original row</strong>
        <span className="edit-item-rawrow-hint">
          Parsed {rawRow.length} columns. Select any part of the row
          below (you can span across commas) and drag it into a field,
          or copy-paste. Or fix the source CSV by adding {'"quotes"'}{' '}
          around fields that contain commas.
        </span>
      </div>
      <div
        className="edit-item-rawrow-text"
        // tabIndex makes the text element keyboard-focusable so the
        // user can Tab into it and use Shift+Arrow to select without
        // touching the mouse. user-select is set in CSS.
        tabIndex={0}
      >
        {text}
      </div>
    </div>
  );
}
