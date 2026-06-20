import { describe, expect, it } from 'vitest';
import type { CloudSlotMeta } from '../cloud';
import type { SlotMeta } from '../types';
import { deriveCloudSyncState, isFullySyncedWithCloudListing } from '../cloudSync';

function slot(overrides: Partial<SlotMeta> = {}): SlotMeta {
  return {
    id: 'slotaaaa',
    name: 'Test',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-06-01T12:00:00.000Z',
    totalItems: 10,
    comparisons: 5,
    done: false,
    cloudOptIn: true,
    cloudId: 'drive-file-1',
    cloudPushedAt: '2024-06-01T12:00:00.000Z',
    cloudUpdatedAt: '2024-06-01T12:00:00.000Z',
    ...overrides,
  };
}

function cloud(overrides: Partial<CloudSlotMeta> = {}): CloudSlotMeta {
  return {
    cloudId: 'drive-file-1',
    displayName: 'Test',
    filename: 'test.json',
    updatedAt: '2024-06-01T12:00:00.000Z',
    sizeBytes: 1024,
    etag: 'etag-1',
    ...overrides,
  };
}

describe('deriveCloudSyncState', () => {
  it('returns synced when updatedAt equals cloudPushedAt', () => {
    expect(deriveCloudSyncState(slot())).toBe('synced');
  });

  it('returns pending when local updatedAt is newer than cloudPushedAt', () => {
    expect(
      deriveCloudSyncState(
        slot({
          updatedAt: '2024-06-02T00:00:00.000Z',
          cloudPushedAt: '2024-06-01T12:00:00.000Z',
        }),
      ),
    ).toBe('pending');
  });
});

describe('isFullySyncedWithCloudListing', () => {
  it('is true when local and cloud timestamps match', () => {
    expect(isFullySyncedWithCloudListing(slot(), cloud())).toBe(true);
  });

  it('is false when cloud listing is newer than local cloudUpdatedAt', () => {
    expect(
      isFullySyncedWithCloudListing(
        slot({ cloudUpdatedAt: '2024-06-01T12:00:00.000Z' }),
        cloud({ updatedAt: '2024-06-02T00:00:00.000Z' }),
      ),
    ).toBe(false);
  });

  it('is false when local has unpushed changes', () => {
    expect(
      isFullySyncedWithCloudListing(
        slot({
          updatedAt: '2024-06-03T00:00:00.000Z',
          cloudPushedAt: '2024-06-01T12:00:00.000Z',
        }),
        cloud(),
      ),
    ).toBe(false);
  });
});
