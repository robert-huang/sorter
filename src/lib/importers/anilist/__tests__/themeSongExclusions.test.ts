import { describe, expect, it } from 'vitest';
import { applyThemeSongExclusions, mergeExcludedRowKeys } from '../themeSongs/themeSongExclusions';
import { themeSongRowKey } from '../themeSongs/themeSongRowKey';
import type { MediaThemeSongRow } from '../themeSongs/types';

function row(partial: Partial<MediaThemeSongRow> & Pick<MediaThemeSongRow, 'type' | 'displayTitle'>): MediaThemeSongRow {
  return {
    sortOrder: 0,
    displayArtist: null,
    spotifyUrl: null,
    spotifyTrackIds: [],
    spotifyIsrc: null,
    hasResolvableTrackId: false,
    ...partial,
  };
}

describe('themeSongRowKey', () => {
  it('uses ani song key when present', () => {
    const key = themeSongRowKey(
      row({
        type: 'Ending',
        songKey: 'ED',
        displayTitle: 'Soarin',
        displayArtist: 'Ginger Root',
      }),
    );
    expect(key).toContain('ani:Ending:ed:');
  });
});

describe('applyThemeSongExclusions', () => {
  it('filters rows by stable keys', () => {
    const kept = row({ type: 'Opening', displayTitle: 'OP Song' });
    const removed = row({
      type: 'Ending',
      songKey: 'ED',
      displayTitle: 'Wrong Show ED',
    });
    const excluded = [themeSongRowKey(removed)];
    const out = applyThemeSongExclusions([kept, removed], excluded);
    expect(out).toEqual([kept]);
  });
});

describe('mergeExcludedRowKeys', () => {
  it('dedupes keys', () => {
    expect(mergeExcludedRowKeys(['a'], 'a')).toEqual(['a']);
    expect(mergeExcludedRowKeys(['a'], 'b').sort()).toEqual(['a', 'b']);
  });
});
