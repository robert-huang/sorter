import { describe, expect, it, vi } from 'vitest';
import { bindSettingsImportDropHandlers } from '../settingsImportDropH';

function fileWithText(name: string, json: string): File {
  const file = new File([json], name, { type: 'application/json' });
  Object.defineProperty(file, 'text', {
    value: () => Promise.resolve(json),
  });
  return file;
}

function makeDropEvent(file: File, fileCount = 1): {
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
  currentTarget: HTMLElement;
  dataTransfer: DataTransfer;
} {
  const fileList = fileCount === 1 ? [file] : [file, file];
  const dt = {
    types: ['Files'],
    files: Object.assign(fileList, { length: fileList.length }),
    dropEffect: 'none',
  } as unknown as DataTransfer;
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget: document.createElement('button'),
    dataTransfer: dt,
  };
}

describe('bindSettingsImportDropHandlers', () => {
  it('routes a matching single-slot file to onMatch', async () => {
    const onMatch = vi.fn();
    const onReject = vi.fn();
    let dragOver = false;
    const handlers = bindSettingsImportDropHandlers(
      'single-slot',
      onMatch,
      onReject,
      (v) => {
        dragOver = v;
      },
    );
    const json = JSON.stringify({
      version: 3,
      createdAt: 't',
      items: {},
      progress: { engine: 'merge', queue: [], comparisons: 0, done: true },
    });
    const file = fileWithText('slot.json', json);
    const event = makeDropEvent(file);
    handlers.onDrop(event as unknown as React.DragEvent<HTMLElement>);
    await vi.waitFor(() => expect(onMatch).toHaveBeenCalled());
    expect(onMatch).toHaveBeenCalledWith(file);
    expect(onReject).not.toHaveBeenCalled();
    expect(dragOver).toBe(false);
  });

  it('rejects an archive dropped on the single-slot target', async () => {
    const onMatch = vi.fn();
    const onReject = vi.fn();
    const handlers = bindSettingsImportDropHandlers(
      'single-slot',
      onMatch,
      onReject,
      () => {},
    );
    const json = JSON.stringify({
      archiveVersion: 1,
      manifest: { slots: [] },
      blobs: {},
    });
    const file = fileWithText('backup.json', json);
    const event = makeDropEvent(file);
    handlers.onDrop(event as unknown as React.DragEvent<HTMLElement>);
    await vi.waitFor(() => expect(onReject).toHaveBeenCalled());
    expect(onMatch).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith(
      'That file looks like a backup archive. Drop it on Restore from backup… instead.',
    );
  });
});
