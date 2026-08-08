import type { CloudSlotMeta } from '../lib/cloud';
import { readSettings, updateSettings } from '../lib/storage';

export type CloudSlotSortKey = 'title' | 'date';
export type CloudSlotSortDirection = 'asc' | 'desc';

export interface CloudSlotSortPreference {
  sortKey: CloudSlotSortKey;
  direction: CloudSlotSortDirection;
}

export const DEFAULT_CLOUD_SLOT_SORT: CloudSlotSortPreference = {
  sortKey: 'date',
  direction: 'desc',
};

export function readCloudSlotSortPreference(): CloudSlotSortPreference {
  const settings = readSettings();
  return {
    sortKey:
      settings.cloudSlotSortKey === 'title' ||
      settings.cloudSlotSortKey === 'date'
        ? settings.cloudSlotSortKey
        : DEFAULT_CLOUD_SLOT_SORT.sortKey,
    direction:
      settings.cloudSlotSortDirection === 'asc' ||
      settings.cloudSlotSortDirection === 'desc'
        ? settings.cloudSlotSortDirection
        : DEFAULT_CLOUD_SLOT_SORT.direction,
  };
}

export function persistCloudSlotSortPreference(
  preference: CloudSlotSortPreference,
): void {
  updateSettings({
    cloudSlotSortKey: preference.sortKey,
    cloudSlotSortDirection: preference.direction,
  });
}

export function sortCloudSlotRows<T>(
  rows: readonly T[],
  metadata: (row: T) => CloudSlotMeta,
  preference: CloudSlotSortPreference,
): T[] {
  const multiplier = preference.direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, meta: metadata(row) }))
    .sort((left, right) => {
      const comparison =
        preference.sortKey === 'title'
          ? left.meta.displayName.localeCompare(right.meta.displayName, undefined, {
              numeric: true,
              sensitivity: 'base',
            })
          : left.meta.updatedAt.localeCompare(right.meta.updatedAt);
      return comparison === 0
        ? left.index - right.index
        : comparison * multiplier;
    })
    .map(({ row }) => row);
}

export function CloudSlotSortControls({
  preference,
  onChange,
}: {
  preference: CloudSlotSortPreference;
  onChange: (preference: CloudSlotSortPreference) => void;
}) {
  return (
    <div
      className="cloud-library-sort-controls"
      aria-label="Cloud file sorting"
    >
      <span className="cloud-library-sort-label">Sort by</span>
      <div
        className="cloud-library-sort-fields"
        role="group"
        aria-label="Sort field"
      >
        <button
          type="button"
          className={`btn${preference.sortKey === 'title' ? ' active' : ''}`}
          aria-pressed={preference.sortKey === 'title'}
          onClick={() => onChange({ ...preference, sortKey: 'title' })}
        >
          Title
        </button>
        <button
          type="button"
          className={`btn${preference.sortKey === 'date' ? ' active' : ''}`}
          aria-pressed={preference.sortKey === 'date'}
          onClick={() => onChange({ ...preference, sortKey: 'date' })}
        >
          Date
        </button>
      </div>
      <button
        type="button"
        className="btn cloud-library-sort-direction"
        aria-label={`Sort ${
          preference.direction === 'asc' ? 'descending' : 'ascending'
        }`}
        onClick={() =>
          onChange({
            ...preference,
            direction: preference.direction === 'asc' ? 'desc' : 'asc',
          })
        }
      >
        {preference.direction === 'asc' ? '↑ Ascending' : '↓ Descending'}
      </button>
    </div>
  );
}
