import { useEffect, useMemo, useRef, useState } from 'react';
import type { Item } from '../lib/types';

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
}: Props) {
  const showUrl = fieldsToShow?.url ?? true;
  const showImageUrl = fieldsToShow?.imageUrl ?? true;

  const [label, setLabel] = useState(item.label);
  const [url, setUrl] = useState(item.url ?? '');
  const [imageUrl, setImageUrl] = useState(item.imageUrl ?? '');
  // Default-hidden advanced panel. Once opened we keep it open for
  // the rest of the modal's lifetime (re-mount resets to closed).
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [idDraft, setIdDraft] = useState(currentId ?? item.id);
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
    if (trimmedId.length === 0) return 'ID cannot be empty';
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
  const idDirty =
    allowEditId && showAdvanced && trimmedId !== (currentId ?? item.id);

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
    // reach for the mouse on a single-field fix.
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
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
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Edit item</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 0 }}>
          {helpText}
        </p>
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
                      // Reset draft to the current id so reopening
                      // starts fresh instead of carrying stale typed
                      // text that the user implicitly abandoned.
                      setIdDraft(currentId ?? item.id);
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
                    placeholder="internal identifier (no spaces recommended)"
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
      </div>
    </div>
  );
}
