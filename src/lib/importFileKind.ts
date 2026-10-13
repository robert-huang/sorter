/**
 * Lightweight sniff of a JSON file before import — used by drag-and-drop
 * on the gear-menu actions so each button only accepts its own shape.
 */
export type ImportFileKind = 'single-slot' | 'archive';

export function peekImportFileKind(text: string): ImportFileKind | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.archiveVersion === 1 && record.manifest != null) {
    return 'archive';
  }
  const version = record.version;
  if (
    (version === 1 ||
      version === 2 ||
      version === 3 ||
      version === 4) &&
    record.items != null &&
    record.progress != null
  ) {
    return 'single-slot';
  }
  return null;
}
