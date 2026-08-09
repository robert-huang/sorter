function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function isLegacySorterSaveFile(
  value: unknown,
): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.version === 1 ||
      value.version === 2 ||
      value.version === 3 ||
      value.version === 4) &&
    isRecord(value.items) &&
    isRecord(value.progress)
  );
}

export function isLegacySorterManifest(
  value: unknown,
): value is { version: 1; slots: unknown[]; activeId?: unknown } {
  return (
    isRecord(value) && value.version === 1 && Array.isArray(value.slots)
  );
}

export function isSorterSlotMeta(value: unknown): value is {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  totalItems: number;
  comparisons: number;
  done: boolean;
} {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    typeof value.totalItems !== 'number' ||
    typeof value.comparisons !== 'number' ||
    typeof value.done !== 'boolean'
  ) {
    return false;
  }
  return (
    (value.pinned === undefined || typeof value.pinned === 'boolean') &&
    (value.cloudOptIn === undefined || typeof value.cloudOptIn === 'boolean') &&
    (value.cloudId === undefined || typeof value.cloudId === 'string') &&
    (value.cloudPushedAt === undefined ||
      typeof value.cloudPushedAt === 'string') &&
    (value.cloudUpdatedAt === undefined ||
      typeof value.cloudUpdatedAt === 'string') &&
    (value.cloudEtag === undefined || typeof value.cloudEtag === 'string')
  );
}

export function isSorterManifest(
  value: unknown,
): value is { version: 1; slots: unknown[] } {
  return (
    isLegacySorterManifest(value) &&
    value.slots.every(isSorterSlotMeta)
  );
}

export function isLegacyBumpChartSideSnapshot(
  value: unknown,
): boolean {
  if (!isRecord(value) || !Array.isArray(value.items)) return false;
  return value.items.every(
    (entry) =>
      isRecord(entry) &&
      isRecord(entry.item) &&
      typeof entry.item.id === 'string' &&
      typeof entry.item.label === 'string',
  );
}

export function isLegacyBumpChartWorkspace(
  value: unknown,
): boolean {
  return (
    isRecord(value) &&
    value.version === 1 &&
    (value.view === 'staging' || value.view === 'chart') &&
    isLegacyBumpChartSideSnapshot(value.before) &&
    isLegacyBumpChartSideSnapshot(value.after)
  );
}

export function isBumpChartColumnSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    (value.kind === 'previous' || value.kind === 'current') &&
    (value.name === undefined || typeof value.name === 'string') &&
    isLegacyBumpChartSideSnapshot(value)
  );
}

export function isBumpChartWorkspace(value: unknown): boolean {
  const columns = isRecord(value) ? value.columns : null;
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    (value.view !== 'staging' && value.view !== 'chart') ||
    !Array.isArray(columns) ||
    columns.length < 2 ||
    !columns.every(isBumpChartColumnSnapshot)
  ) {
    return false;
  }
  const ids = new Set(
    columns.map((column) => (column as { id: string }).id),
  );
  return (
    ids.size === columns.length &&
    columns.every(
      (column, index) =>
        (column as { kind: string }).kind ===
        (index === columns.length - 1 ? 'current' : 'previous'),
    )
  );
}

export function isLegacyBumpChartManifest(
  value: unknown,
): value is { version: 1; slots: unknown[] } {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.slots)) {
    return false;
  }
  return value.slots.every(isBumpChartMeta);
}

export function isBumpChartMeta(value: unknown): value is {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
} {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  );
}

export function isLegacySavedBumpChartRecord(
  value: unknown,
): boolean {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isLegacyBumpChartWorkspace(value.workspace)
  );
}
