import type { DragEvent } from 'react';
import {
  type ImportFileKind,
  peekImportFileKind,
} from '../lib/importFileKind';

export function dragEventHasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

function wrongTargetMessage(kind: ImportFileKind): string {
  return kind === 'archive'
    ? 'That file looks like a backup archive. Drop it on Restore from backup… instead.'
    : 'That file looks like a single-slot save. Drop it on Load save file… instead.';
}

async function handleSettingsImportDrop(
  e: DragEvent<HTMLElement>,
  expectedKind: ImportFileKind,
  onMatch: (file: File) => void,
  onReject: (message: string) => void,
): Promise<void> {
  const file = e.dataTransfer.files?.[0];
  if (!file) {
    onReject('No file was dropped.');
    return;
  }
  if (e.dataTransfer.files.length > 1) {
    onReject('Drop one JSON file at a time.');
    return;
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    onReject('Could not read the dropped file.');
    return;
  }
  const kind = peekImportFileKind(text);
  if (kind === null) {
    onReject('Not a recognized sorter JSON file.');
    return;
  }
  if (kind !== expectedKind) {
    onReject(wrongTargetMessage(kind));
    return;
  }
  onMatch(file);
}

export function bindSettingsImportDropHandlers(
  expectedKind: ImportFileKind,
  onMatch: (file: File) => void,
  onReject: (message: string) => void,
  setDragOver: (active: boolean) => void,
): {
  onDragEnter: (e: DragEvent<HTMLElement>) => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
} {
  return {
    onDragEnter: (e) => {
      if (!dragEventHasFiles(e)) return;
      e.preventDefault();
      setDragOver(true);
    },
    onDragOver: (e) => {
      if (!dragEventHasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDragOver(true);
    },
    onDragLeave: (e) => {
      if (!dragEventHasFiles(e)) return;
      const related = e.relatedTarget as Node | null;
      if (related && e.currentTarget.contains(related)) return;
      setDragOver(false);
    },
    onDrop: (e) => {
      if (!dragEventHasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      void handleSettingsImportDrop(e, expectedKind, onMatch, onReject);
    },
  };
}
