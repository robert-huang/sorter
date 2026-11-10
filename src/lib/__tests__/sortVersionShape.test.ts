import { describe, expect, it } from 'vitest';
import { diffSortVersions } from '../sortVersions';
import {
  itemAtVersion,
  normalizeSortVersions,
  sameVersionContent,
  sortVersionItem,
  storedSortVersions,
} from '../sortVersionShape';
import type { Item, SortVersion } from '../types';

const LYNN_IMAGE = 'https://s4.anilist.co/staff/n118806.jpg';
const MINORI_IMAGE = 'https://s4.anilist.co/staff/n95053.png';

const lynn: Item = {
  id: 'anilist-staff:118806',
  label: 'Lynn',
  url: 'https://anilist.co/staff/118806',
  imageUrl: LYNN_IMAGE,
  source: { kind: 'anilist-staff', externalId: 118806 },
  anilistLabelSource: {
    kind: 'person',
    nameFields: { id: 118806, name_full: 'Lynn', name_native: null },
  },
  anilistImageSource: LYNN_IMAGE,
};
const plain: Item = { id: 'AAAAAAAAAAAAAA', label: 'Alpha', url: 'https://a.example' };
const live = { [lynn.id]: lynn, [plain.id]: plain };

const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-10T10:00:00.000Z';

function version(items: Item[], createdAt: string): SortVersion {
  return {
    id: createdAt,
    createdAt,
    rankedIds: items.map((it) => it.id),
    items: Object.fromEntries(items.map((it) => [it.id, sortVersionItem(it)])),
  };
}

/** Save then load, as storage does. */
function roundTrip(versions: SortVersion[], liveItems: Record<string, Item>) {
  const stored = JSON.parse(JSON.stringify(storedSortVersions(versions, liveItems)));
  return { stored, decoded: normalizeSortVersions(stored.versions, stored.versionItems, liveItems)! };
}

describe('storedSortVersions', () => {
  it('stores nothing per item for automatic names and default images', () => {
    const { stored } = roundTrip([version([lynn], T1)], live);
    expect(stored).toEqual({ versions: [{ id: T1, createdAt: T1, rankedIds: [lynn.id] }] });
  });

  it('keeps custom names, custom images and plain items as overrides', () => {
    const renamed = { ...lynn, label: 'Lynn (best)', anilistLabelMode: 'custom' as const };
    const reimaged = { ...renamed, imageUrl: 'https://mine.example/l.png' };
    const { stored, decoded } = roundTrip([version([reimaged, plain], T1)], live);
    expect(stored.versions[0].overrides).toEqual({
      [lynn.id]: { label: 'Lynn (best)', imageUrl: 'https://mine.example/l.png' },
      [plain.id]: { label: 'Alpha', url: 'https://a.example' },
    });
    expect(decoded[0]!.items[lynn.id]).toMatchObject({
      label: 'Lynn (best)',
      anilistLabelMode: 'custom',
      imageUrl: 'https://mine.example/l.png',
      source: lynn.source,
    });
  });

  it('saves and loads a version name', () => {
    const { stored, decoded } = roundTrip([{ ...version([lynn], T1), name: 'Winter' }], live);
    expect(stored.versions[0].name).toBe('Winter');
    expect(decoded[0]!.name).toBe('Winter');
  });

  it('stores one copy of an item the sort dropped and rebuilds it', () => {
    const { stored, decoded } = roundTrip([version([lynn], T1)], {});
    expect(Object.keys(stored.versionItems)).toEqual([lynn.id]);
    expect(decoded[0]!.items[lynn.id]).toMatchObject({ label: 'Lynn', source: lynn.source });
  });

  it('re-encodes a decoded save byte-identically', () => {
    const renamed = { ...lynn, label: 'Custom', anilistLabelMode: 'custom' as const };
    const { stored, decoded } = roundTrip([version([lynn], T1), version([renamed, plain], T2)], {
      [plain.id]: plain,
    });
    expect(JSON.stringify(storedSortVersions(decoded, { [plain.id]: plain }))).toBe(
      JSON.stringify(stored),
    );
  });
});

describe('normalizeSortVersions legacy repair', () => {
  const minoriSnap = {
    label: 'Minori Chihara',
    imageUrl: MINORI_IMAGE,
    url: 'https://anilist.co/staff/95053',
  };
  const legacy = [
    {
      id: 'v0',
      createdAt: T1,
      rankedIds: ['anilist-staff:95053', lynn.id],
      items: { 'anilist-staff:95053': minoriSnap, [lynn.id]: { label: 'Lynn', imageUrl: LYNN_IMAGE } },
    },
    { id: 'v1', createdAt: T2, rankedIds: [lynn.id], items: { [lynn.id]: { label: 'Lynn' } } },
  ];

  it('gives a dropped AniList item its source so its detail modal can open', () => {
    const out = normalizeSortVersions(legacy, undefined, { [lynn.id]: lynn })!;
    expect(out[0]!.items['anilist-staff:95053']).toMatchObject({
      label: 'Minori Chihara',
      imageUrl: MINORI_IMAGE,
      source: { kind: 'anilist-staff', externalId: 95053 },
    });
  });

  it('treats legacy AniList names as automatic and keeps the dropped item on save', () => {
    const out = normalizeSortVersions(legacy, undefined, { [lynn.id]: lynn })!;
    expect(out[1]!.items[lynn.id]).toMatchObject({ label: 'Lynn', anilistLabelMode: 'automatic' });
    const stored = storedSortVersions(out, { [lynn.id]: lynn });
    expect(stored.versionItems?.['anilist-staff:95053']?.source).toEqual({
      kind: 'anilist-staff',
      externalId: 95053,
    });
    // Images matching AniList's are defaults, so nothing is stored per version.
    expect(stored.versions.every((v) => v.overrides === undefined)).toBe(true);
  });

  it('agrees with the current ranking on unmarked custom names and images', () => {
    const current: Item = { ...lynn, label: 'Lynn!', imageUrl: 'https://s4.anilist.co/staff/pick.jpg' };
    const raw = [
      {
        id: 'v0',
        createdAt: T1,
        rankedIds: [lynn.id],
        items: { [lynn.id]: { label: 'Lynn!', imageUrl: 'https://s4.anilist.co/staff/pick.jpg' } },
      },
    ];
    const out = normalizeSortVersions(raw, undefined, { [lynn.id]: current })!;
    // Otherwise the first live-version commit after loading would record a change.
    expect(sameVersionContent(out[0]!, version([current], T2))).toBe(true);
  });

  it("drops covers AniList has since replaced but keeps the user's own images", () => {
    const raw = [
      {
        id: 'v0',
        createdAt: T1,
        rankedIds: [lynn.id],
        items: { [lynn.id]: { label: 'Lynn', imageUrl: 'https://s4.anilist.co/staff/old.jpg' } },
      },
      {
        id: 'v1',
        createdAt: T2,
        rankedIds: [lynn.id],
        items: { [lynn.id]: { label: 'Lynn', imageUrl: 'https://mine.example/l.png' } },
      },
    ];
    const out = normalizeSortVersions(raw, undefined, { [lynn.id]: lynn })!;
    expect(out.map((v) => v.items[lynn.id]!.imageUrl)).toEqual([
      LYNN_IMAGE,
      'https://mine.example/l.png',
    ]);
  });
});

describe('version content', () => {
  it('treats a custom rename as a change and lists it in the diff', () => {
    const before = version([lynn, plain], T1);
    const after = version([{ ...lynn, label: 'L', anilistLabelMode: 'custom' }, plain], T2);
    expect(sameVersionContent(before, after)).toBe(false);
    expect(diffSortVersions(before, after).renamed).toEqual([lynn.id]);
  });

  it('ignores automatic relabels such as a display-language switch', () => {
    const bilingual: Item = {
      ...lynn,
      anilistLabelSource: {
        kind: 'person',
        nameFields: { id: 118806, name_full: 'Lynn', name_native: 'リン' },
      },
    };
    const before = version([bilingual], T1);
    // Unmarked (legacy) automatic names are recognised too.
    const after = version([{ ...bilingual, label: 'リン' }], T2);
    expect(sameVersionContent(before, after)).toBe(true);
    expect(diffSortVersions(before, after).renamed).toEqual([]);
  });
});

describe('itemAtVersion', () => {
  it("restores the version's custom name on the sort's current metadata", () => {
    const snap = sortVersionItem({ ...lynn, label: 'Old name', anilistLabelMode: 'custom' });
    const current = { ...lynn, imageUrl: 'https://mine.example/now.png', searchTokens: ['Lynn'] };
    expect(itemAtVersion(current, lynn.id, snap)).toMatchObject({
      label: 'Old name',
      anilistLabelMode: 'custom',
      imageUrl: LYNN_IMAGE,
      searchTokens: ['Lynn'],
    });
  });

  it('drops a current custom name when the version used the automatic one', () => {
    const current = { ...lynn, label: 'Renamed later', anilistLabelMode: 'custom' as const };
    expect(itemAtVersion(current, lynn.id, sortVersionItem(lynn))).toMatchObject({
      label: 'Lynn',
      anilistLabelMode: 'automatic',
    });
  });
});
