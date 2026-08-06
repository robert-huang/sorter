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

export function isLegacyBumpChartManifest(
  value: unknown,
): value is { version: 1; slots: unknown[] } {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.slots)) {
    return false;
  }
  return value.slots.every(
    (slot) =>
      isRecord(slot) &&
      typeof slot.id === 'string' &&
      typeof slot.name === 'string' &&
      typeof slot.createdAt === 'number' &&
      typeof slot.updatedAt === 'number',
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
