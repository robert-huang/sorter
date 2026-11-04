import { useCallback, useMemo, useState } from 'react';
import { parseCsvRows, parseSources } from '../lib/csv';
import type { AnilistHydrationResult } from '../lib/importers/anilist/anilistPlaintextHydration';
import type { EditItemSavePayload } from './EditItemModal';
import {
  applyImportEditPayload,
  applyImportEdits,
  applyStartScreenHydration,
  buildImportEditTarget,
  excludePreviewItemFromSource,
  filterCommaInLabelForExcluded,
  filterExtraColumnsForExcluded,
  type ExcludedRows,
  type ImportEditTarget,
  type OverlayMap,
} from './importEditsH';

export const STAGED_ROWS_SOURCE = 'add items';

interface RowEdits {
  /** Source text + header toggle the edits were made against. */
  sourceKey: string;
  overrides: OverlayMap;
  excluded: ExcludedRows;
}

const NO_OVERRIDES: OverlayMap = new Map();
const NO_EXCLUSIONS: ExcludedRows = new Set();

/**
 * Parses pasted CSV for the Add items staging area and applies per-row
 * edits and removals. Edits only apply to the text they were made
 * against: once the text or header toggle changes, row numbers shift
 * and stale edits would land on other rows.
 */
export function useStagedRowEdits(text: string, skipHeader: boolean) {
  const sourceKey = `${skipHeader ? 1 : 0}:${text}`;
  const [edits, setEdits] = useState<RowEdits | null>(null);
  const [editTarget, setEditTarget] = useState<ImportEditTarget | null>(null);

  const current = edits?.sourceKey === sourceKey ? edits : null;
  const overrides = current?.overrides ?? NO_OVERRIDES;
  const excluded = current?.excluded ?? NO_EXCLUSIONS;

  const updateEdits = useCallback(
    (patch: (prev: { overrides: OverlayMap; excluded: ExcludedRows }) => Partial<RowEdits>) => {
      setEdits((prev) => {
        const base =
          prev?.sourceKey === sourceKey
            ? prev
            : { sourceKey, overrides: NO_OVERRIDES, excluded: NO_EXCLUSIONS };
        return { ...base, ...patch(base) };
      });
    },
    [sourceKey],
  );

  const parsedRows = useMemo(
    () =>
      text.trim() ? parseCsvRows(text, STAGED_ROWS_SOURCE, skipHeader) : null,
    [text, skipHeader],
  );

  const result = useMemo(
    () =>
      parseSources(
        parsedRows
          ? [
              {
                sourceName: STAGED_ROWS_SOURCE,
                rawRows: applyImportEdits(parsedRows.rows, overrides, excluded),
                detectedHeader: parsedRows.detectedHeader,
                extraColumns: filterExtraColumnsForExcluded(
                  parsedRows.extraColumns,
                  excluded,
                ),
                commaInLabel: filterCommaInLabelForExcluded(
                  parsedRows.commaInLabel,
                  excluded,
                ),
              },
            ]
          : [],
      ),
    [parsedRows, overrides, excluded],
  );

  const openEdit = useCallback(
    (sourceName: string, rowNumber: number): void => {
      if (!parsedRows) return;
      setEditTarget(
        buildImportEditTarget(
          parsedRows.rows,
          overrides,
          result.items,
          sourceName,
          rowNumber,
        ),
      );
    },
    [parsedRows, overrides, result.items],
  );

  const removeRow = useCallback(
    (sourceName: string, rowNumber: number): void => {
      if (!parsedRows) return;
      updateEdits((prev) => ({
        excluded: excludePreviewItemFromSource(
          parsedRows.rows,
          prev.overrides,
          prev.excluded,
          sourceName,
          rowNumber,
        ),
      }));
    },
    [parsedRows, updateEdits],
  );

  const saveEdit = useCallback(
    (payload: EditItemSavePayload): void => {
      if (!editTarget) return;
      updateEdits((prev) => ({
        overrides: applyImportEditPayload(prev.overrides, editTarget, payload),
      }));
      setEditTarget(null);
    },
    [editTarget, updateEdits],
  );

  const cancelEdit = useCallback(() => setEditTarget(null), []);

  const applyHydration = useCallback(
    (hydration: AnilistHydrationResult): void => {
      updateEdits((prev) => ({
        overrides: applyStartScreenHydration(
          prev.overrides,
          result.items,
          result.perSource,
          hydration,
        ),
      }));
    },
    [result.items, result.perSource, updateEdits],
  );

  return {
    result,
    editTarget,
    openEdit,
    removeRow,
    saveEdit,
    cancelEdit,
    applyHydration,
  };
}
