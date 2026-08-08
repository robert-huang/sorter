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

function defaultDirection(sortKey: CloudSlotSortKey): CloudSlotSortDirection {
  return sortKey === 'title' ? 'asc' : 'desc';
}

function oppositeDirection(
  direction: CloudSlotSortDirection,
): CloudSlotSortDirection {
  return direction === 'asc' ? 'desc' : 'asc';
}

function activeSortArrow(
  preference: CloudSlotSortPreference,
  sortKey: CloudSlotSortKey,
): string {
  if (preference.sortKey !== sortKey) return '';
  return preference.direction === 'asc' ? ' ↑' : ' ↓';
}

export function CloudSlotSortControls({
  preference,
  onChange,
}: {
  preference: CloudSlotSortPreference;
  onChange: (preference: CloudSlotSortPreference) => void;
}) {
  function chooseSort(sortKey: CloudSlotSortKey): void {
    const direction =
      preference.sortKey === sortKey
        ? oppositeDirection(preference.direction)
        : defaultDirection(sortKey);
    onChange({
      sortKey,
      direction,
    });
  }

  function nextDirectionLabel(sortKey: CloudSlotSortKey): string {
    const nextDirection =
      preference.sortKey === sortKey
        ? oppositeDirection(preference.direction)
        : defaultDirection(sortKey);
    return nextDirection === 'asc' ? 'ascending' : 'descending';
  }

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
          aria-label={`Sort by title ${nextDirectionLabel('title')}`}
          onClick={() => chooseSort('title')}
        >
          Title{activeSortArrow(preference, 'title')}
        </button>
        <button
          type="button"
          className={`btn${preference.sortKey === 'date' ? ' active' : ''}`}
          aria-pressed={preference.sortKey === 'date'}
          aria-label={`Sort by date ${nextDirectionLabel('date')}`}
          onClick={() => chooseSort('date')}
        >
          Date{activeSortArrow(preference, 'date')}
        </button>
      </div>
    </div>
  );
}
