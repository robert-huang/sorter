import { describe, expect, it } from 'vitest';
import { peekImportFileKind } from '../importFileKind';

describe('peekImportFileKind', () => {
  it('detects a single-slot save file', () => {
    const json = JSON.stringify({
      version: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
      items: { a: { id: 'a', label: 'A' } },
      progress: {
        engine: 'merge',
        queue: [],
        current: null,
        comparisons: 0,
        done: true,
        hidden: [],
        totalComparisonsEverNeeded: 0,
      },
      undoRing: [],
    });
    expect(peekImportFileKind(json)).toBe('single-slot');
  });

  it('detects a backup archive envelope', () => {
    const json = JSON.stringify({
      archiveVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      manifest: { version: 1, activeId: null, slots: [] },
      blobs: {},
    });
    expect(peekImportFileKind(json)).toBe('archive');
  });

  it('returns null for unrelated JSON', () => {
    expect(peekImportFileKind('{"foo":1}')).toBeNull();
    expect(peekImportFileKind('not json')).toBeNull();
  });
});
