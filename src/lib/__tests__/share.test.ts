import { describe, expect, it } from 'vitest';
import type { Item } from '../types';
import {
  decodeShareLink,
  encodeShareLink,
  readShareParamFromHash,
  shareUrlFor,
} from '../share';

const items3: Item[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta', url: 'https://example.com/b' },
  { id: 'c', label: 'Gamma', imageUrl: 'https://example.com/c.png' },
];

describe('encodeShareLink / decodeShareLink round-trip', () => {
  it('preserves items, order, and optional fields', () => {
    const encoded = encodeShareLink(items3, 'My Top 3');
    const decoded = decodeShareLink(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe('My Top 3');
    expect(decoded!.items).toEqual(items3);
    // Default kind = 'ranking' on both ends of the round-trip.
    expect(decoded!.kind).toBe('ranking');
  });

  it('defaults the name to "Shared sort" when omitted', () => {
    const encoded = encodeShareLink(items3);
    const decoded = decodeShareLink(encoded);
    expect(decoded!.name).toBe('Shared sort');
  });

  it('preserves order (decoded array matches input order exactly)', () => {
    const long: Item[] = Array.from({ length: 50 }, (_, n) => ({
      id: `id${n}`,
      label: `Item ${n}`,
    }));
    const decoded = decodeShareLink(encodeShareLink(long))!;
    expect(decoded.items.map((it) => it.id)).toEqual(long.map((it) => it.id));
  });

  it('survives non-ASCII labels (emoji, CJK)', () => {
    const exotic: Item[] = [
      { id: 'a', label: 'Café ☕' },
      { id: 'b', label: '日本語' },
      { id: 'c', label: '🎉🎊' },
    ];
    const decoded = decodeShareLink(encodeShareLink(exotic))!;
    expect(decoded.items.map((it) => it.label)).toEqual([
      'Café ☕',
      '日本語',
      '🎉🎊',
    ]);
  });

  it('drops undefined optional fields rather than serializing them', () => {
    // No url + no imageUrl → decoded items must not have those keys
    // (not undefined; absent). Matters because Object.keys checks
    // downstream rely on presence, not value.
    const minimal: Item[] = [{ id: 'x', label: 'X' }];
    const decoded = decodeShareLink(encodeShareLink(minimal))!;
    expect(decoded.items[0]).toEqual({ id: 'x', label: 'X' });
    expect('url' in decoded.items[0]).toBe(false);
    expect('imageUrl' in decoded.items[0]).toBe(false);
  });
});

describe('decodeShareLink failure modes', () => {
  it('returns null for empty / falsy input', () => {
    expect(decodeShareLink('')).toBeNull();
  });

  it('returns null for malformed base64', () => {
    // `!!!` isn't valid base64 even after URL-safe substitution
    expect(decodeShareLink('!!!')).toBeNull();
  });

  it('returns null for valid base64 of non-JSON', () => {
    // base64url of "not json{{"
    const encoded = btoa('not json{{').replace(/=+$/, '');
    expect(decodeShareLink(encoded)).toBeNull();
  });

  it('returns null for wrong version', () => {
    const wrongVer = btoa(JSON.stringify({ v: 999, i: [{ i: 'a', l: 'A' }] }))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(decodeShareLink(wrongVer)).toBeNull();
  });

  it('returns null when items is empty', () => {
    const emptyItems = encodeShareLink([]);
    expect(decodeShareLink(emptyItems)).toBeNull();
  });

  it('returns null when an item is missing required id/label', () => {
    const bad = btoa(JSON.stringify({ v: 1, i: [{ l: 'no id' }] }))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(decodeShareLink(bad)).toBeNull();
  });

  it('returns null when an optional field is the wrong type', () => {
    // url is a number instead of a string — hand-edited payload attack.
    const bad = btoa(
      JSON.stringify({ v: 1, i: [{ i: 'a', l: 'A', u: 42 }] }),
    )
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(decodeShareLink(bad)).toBeNull();
  });
});

describe('encodeShareLink / decodeShareLink kind discriminator', () => {
  it('round-trips ranking kind (the default)', () => {
    const encoded = encodeShareLink(items3, 'Top 3', 'ranking');
    const decoded = decodeShareLink(encoded)!;
    expect(decoded.kind).toBe('ranking');
    expect(decoded.items).toEqual(items3);
  });

  it('round-trips template kind', () => {
    const encoded = encodeShareLink(items3, 'My Candidate List', 'template');
    const decoded = decodeShareLink(encoded)!;
    expect(decoded.kind).toBe('template');
    expect(decoded.name).toBe('My Candidate List');
    expect(decoded.items).toEqual(items3);
  });

  it('omits k from the wire for ranking (default) so older builds decode it', () => {
    // The legacy decoder (pre-discriminator) ignored unknown fields,
    // but emitting `k:'ranking'` would still bloat every link by a few
    // bytes for the common case. We encode k only when non-default.
    const encoded = encodeShareLink(items3, 'Top 3'); // defaults to 'ranking'
    const decoded = decodeShareLink(encoded)!;
    // Inspect the raw payload to confirm there's no k field on disk.
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (padded.length % 4)) % 4;
    const json = atob(padded + '='.repeat(pad));
    const parsed = JSON.parse(json) as { k?: string };
    expect('k' in parsed).toBe(false);
    // But decode still reports kind = 'ranking'.
    expect(decoded.kind).toBe('ranking');
  });

  it('emits k=template on the wire when explicitly templated', () => {
    const encoded = encodeShareLink(items3, 'Candidates', 'template');
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (padded.length % 4)) % 4;
    const json = atob(padded + '='.repeat(pad));
    const parsed = JSON.parse(json) as { k?: string };
    expect(parsed.k).toBe('template');
  });

  it('back-compat: legacy payload (k missing) decodes as ranking', () => {
    // Hand-build a payload that mirrors what older builds emitted —
    // no `k` field. The recipient on a newer build must still decode
    // it cleanly with kind = 'ranking'.
    const legacy = btoa(
      JSON.stringify({
        v: 1,
        n: 'Legacy Share',
        i: [
          { i: 'a', l: 'Alpha' },
          { i: 'b', l: 'Beta' },
        ],
      }),
    )
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const decoded = decodeShareLink(legacy)!;
    expect(decoded.kind).toBe('ranking');
    expect(decoded.name).toBe('Legacy Share');
    expect(decoded.items.length).toBe(2);
  });

  it('back-compat: unknown k value falls back to ranking', () => {
    // A future kind ('shopping-list', say) on the wire today is
    // unknown — fall back to the safer ranking interpretation rather
    // than letting the decoder fail.
    const unknown = btoa(
      JSON.stringify({
        v: 1,
        n: 'Future',
        i: [{ i: 'a', l: 'A' }],
        k: 'shopping-list',
      }),
    )
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const decoded = decodeShareLink(unknown)!;
    expect(decoded.kind).toBe('ranking');
  });
});

describe('readShareParamFromHash', () => {
  it('extracts the share= value from a hash starting with #', () => {
    expect(readShareParamFromHash('#share=abc')).toBe('abc');
  });

  it('extracts the share= value from a hash without #', () => {
    expect(readShareParamFromHash('share=abc')).toBe('abc');
  });

  it('returns null when no share= key is present', () => {
    expect(readShareParamFromHash('#other=foo')).toBeNull();
    expect(readShareParamFromHash('#')).toBeNull();
    expect(readShareParamFromHash('')).toBeNull();
  });

  it('handles multiple & -separated keys, picking only share=', () => {
    expect(readShareParamFromHash('#foo=bar&share=xyz&baz=qux')).toBe('xyz');
  });

  it('returns the raw value untouched (decoding is the caller’s job)', () => {
    // We never URL-decode here — share= values are already URL-safe
    // base64 (no chars needing escape). Double-decoding would corrupt
    // valid payloads that happen to contain `+` or `_`.
    const encoded = encodeShareLink(items3);
    expect(readShareParamFromHash(`#share=${encoded}`)).toBe(encoded);
  });
});

describe('shareUrlFor', () => {
  it('builds a full URL from window.location origin + pathname', () => {
    // jsdom defaults to http://localhost:3000 / (path /).
    const url = shareUrlFor('hello');
    expect(url).toBe('http://localhost:3000/#share=hello');
  });
});
