import type { CloudSlotMeta } from './cloud';
import type { SlotMeta } from './types';

/**
 * Three-state per-slot cloud sync status (local view):
 *  - 'off'      → not opted in
 *  - 'pending'  → local ahead of last push/pull
 *  - 'synced'   → local matches last push/pull on this device
 */
export type CloudSyncState = 'off' | 'pending' | 'synced';

export function deriveCloudSyncState(slot: SlotMeta): CloudSyncState {
  if (!slot.cloudOptIn) return 'off';
  if (!slot.cloudId || !slot.cloudPushedAt) return 'pending';
  return slot.updatedAt > slot.cloudPushedAt ? 'pending' : 'synced';
}

/**
 * True when the local slot matches the cloud-library listing row —
 * safe to remove the local copy and keep the Drive backup.
 *
 * Requires local "synced" state AND that Drive's `modifiedTime` is not
 * newer than what we last recorded from cloud (`cloudUpdatedAt`).
 */
export function isFullySyncedWithCloudListing(
  slot: SlotMeta | undefined,
  cloud: CloudSlotMeta,
): boolean {
  if (!slot || slot.cloudId !== cloud.cloudId) return false;
  if (deriveCloudSyncState(slot) !== 'synced') return false;
  if (slot.cloudUpdatedAt && cloud.updatedAt.localeCompare(slot.cloudUpdatedAt) > 0) {
    return false;
  }
  return true;
}
