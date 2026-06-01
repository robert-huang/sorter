import { useEffect, useRef, useState } from 'react';
import type { SlotMeta } from '../lib/types';

interface Props {
  slots: SlotMeta[];
  /**
   * Id of the slot whose blob is currently loaded into memory (i.e. the
   * one the user is sorting in *right now*). Null on START when nothing
   * is loaded. The "Active" tag is shown only for this slot — having a
   * "lastUsed" pointer in the manifest is not enough; we want the tag to
   * mean "you are currently sorting here", not "this was your last
   * session".
   */
  loadedSlotId: string | null;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  /** Download a JSON copy of this slot's on-disk blob — for backup
   *  before deleting / starting over / hitting the cap. */
  onDownload: (id: string) => void;
  /** Toggle the pinned flag on a slot. Pinned slots survive the
   *  `createSlot` eviction loop when the cap is hit, so the user can
   *  protect favorite sorts from being auto-deleted. */
  onTogglePin: (id: string, pinned: boolean) => void;
  // ---------- cloud backup (tier 0b) ----------
  /**
   * When false, the per-row cloud controls (opt-in toggle + Push/Pull
   * buttons) are hidden entirely. Driven from the same `cloudStatus`
   * the gear-menu cloud section uses — only the 'ready' tier exposes
   * per-row controls because earlier tiers can't actually push or pull.
   */
  cloudControlsVisible: boolean;
  onCloudToggleOptIn: (id: string, optIn: boolean) => void;
  onCloudPush: (id: string) => void;
  onCloudPull: (id: string) => void;
  /** Ids of slots whose Push call is in flight. The matching button
   *  in those rows shows a rotating spinner glyph instead of the
   *  up-arrow, and is `disabled` to suppress further clicks. */
  cloudPushingIds: ReadonlySet<string>;
  /** Same as cloudPushingIds, but for Pull. */
  cloudPullingIds: ReadonlySet<string>;
  /**
   * Click handler for the small "[NEW]" affordance on the right edge
   * of the "Saved sorts" header row. Wired to "navigate to the START
   * tab" — the START screen owns the actual mint flow, so creating a
   * list there will flush any pending autosave on the previously
   * active slot before adopting the new session (the standard
   * `createSlot` ordering already takes care of that). Optional so
   * the SlotList can still render outside of the gear menu without
   * forcing every consumer to wire a handler.
   */
  onNewSort?: () => void;
  /**
   * Optional bulk-push handler. When provided AND `cloudControlsVisible`
   * is true, the header gains a "[⇡ ALL]" button that pushes every
   * opted-in slot to the cloud (App-side handler does the filter and
   * fans out to per-slot push). Hidden when no slot is opted in so we
   * don't dangle a no-op affordance in front of users who haven't
   * enabled cloud sync on anything yet.
   */
  onCloudPushAll?: () => void;
  /** Same shape as `onCloudPushAll`, but for bulk pull. Renders only
   *  when at least one slot is BOTH opted-in and has a cloud binding
   *  (cloudId set) — otherwise there's nothing to pull. */
  onCloudPullAll?: () => void;
  /**
   * Class on the scrollable rows region only (header + search stay
   * pinned above). Gear menu passes `.settings-slots-scroll` so the
   * thumb starts below the search field.
   */
  listScrollClassName?: string;
}

/**
 * Loose "X minutes ago" formatter — keeps the slot list compact without a
 * date lib dependency. Falls back to absolute YYYY-MM-DD for anything older
 * than ~6 days.
 */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  if (secs < 90) return '1 min ago';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return iso.slice(0, 10);
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Below this slot count the list fits comfortably on one screen, so a
 * search box would just be visual noise. At/above this count the user
 * may have trouble scanning by name — the input appears (and stays
 * sticky-ish via the popover) so they can narrow the list to one
 * candidate quickly. Tuned to match the height of the gear-menu
 * popover before vertical scrolling kicks in.
 */
const SEARCH_THRESHOLD = 5;

export function SlotList({
  slots,
  loadedSlotId,
  onSwitch,
  onDelete,
  onRename,
  onDownload,
  onTogglePin,
  cloudControlsVisible,
  onCloudToggleOptIn,
  onCloudPush,
  onCloudPull,
  cloudPushingIds,
  cloudPullingIds,
  onNewSort,
  onCloudPushAll,
  onCloudPullAll,
  listScrollClassName = 'slot-list-scroll',
}: Props) {
  // Local-only state — search is a render filter, never persisted.
  // Reset is implicit (close + reopen the gear menu remounts SlotList).
  const [query, setQuery] = useState('');

  if (slots.length === 0) {
    return (
      <div className="slot-list empty">
        <div className="slot-list-empty">No saved sorts yet.</div>
      </div>
    );
  }

  // Pinned first (so favorites stay visible at the top), then by
  // most-recently-touched. Inside each group the order matches the
  // user's recents intuition.
  const ordered = slots
    .slice()
    .sort((a, b) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return b.updatedAt.localeCompare(a.updatedAt);
    });

  // Apply the case-insensitive contains filter AFTER the sort so the
  // pinned-first + recency ordering survives. Trim the query so a
  // stray trailing space (common when typing fast) doesn't drop every
  // row to zero results.
  const showSearch = slots.length >= SEARCH_THRESHOLD;
  const trimmedQuery = query.trim();
  const filtered = trimmedQuery
    ? ordered.filter((s) =>
        s.name.toLowerCase().includes(trimmedQuery.toLowerCase()),
      )
    : ordered;

  // Bulk cloud actions are only meaningful when (a) cloud is wired up
  // (`cloudControlsVisible` mirrors the App-level 'ready' gate) AND
  // (b) there's at least one eligible slot. Push needs `cloudOptIn`;
  // pull additionally needs an established `cloudId` binding (a slot
  // opted in but never pushed has nothing to pull). Counted up front
  // because both the visibility test and the tooltip need the
  // numbers — folding into a single pass avoids reiterating `slots`.
  let pushAllEligible = 0;
  let pullAllEligible = 0;
  for (const s of slots) {
    if (s.cloudOptIn) {
      pushAllEligible++;
      if (s.cloudId) pullAllEligible++;
    }
  }
  const showPushAll = cloudControlsVisible && !!onCloudPushAll;
  const showPullAll = cloudControlsVisible && !!onCloudPullAll;

  return (
    <div className="slot-list">
      <div className="slot-list-header">
        <div className="slot-list-header-left">
          <span className="slot-list-header-title">Saved sorts</span>
          {showPushAll && (
            <button
              type="button"
              className="slot-list-bulk-icon"
              onClick={onCloudPushAll}
              disabled={pushAllEligible === 0}
              aria-label="Push all opted-in slots to cloud"
              title={
                pushAllEligible === 0
                  ? 'No slots opted in for cloud — toggle the cloud icon on a row first'
                  : `Push ${pushAllEligible} opted-in slot${pushAllEligible === 1 ? '' : 's'} to cloud`
              }
            >
              ⇡
            </button>
          )}
          {showPullAll && (
            <button
              type="button"
              className="slot-list-bulk-icon"
              onClick={onCloudPullAll}
              disabled={pullAllEligible === 0}
              aria-label="Pull all opted-in slots from cloud"
              title={
                pullAllEligible === 0
                  ? 'No opted-in slots have a cloud copy yet — push at least once first'
                  : `Pull ${pullAllEligible} opted-in slot${pullAllEligible === 1 ? '' : 's'} from cloud (overwrites local)`
              }
            >
              ⇣
            </button>
          )}
        </div>
        {onNewSort && (
          <button
            type="button"
            className="slot-list-header-btn primary"
            onClick={onNewSort}
            title="Start a new sort (returns to the START tab; any in-progress slot is autosaved first)"
          >
            NEW
          </button>
        )}
      </div>
      {showSearch && (
        <input
          type="search"
          className="slot-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${slots.length} slot${slots.length === 1 ? '' : 's'}…`}
          aria-label="Filter saved sorts by name"
        />
      )}
      <div className={listScrollClassName}>
        {filtered.length === 0 ? (
          <div className="slot-list-empty">
            {trimmedQuery
              ? <>No slots match &ldquo;{trimmedQuery}&rdquo;.</>
              : 'No saved sorts yet.'}
          </div>
        ) : (
          filtered.map((s) => (
            <SlotRow
              key={s.id}
              slot={s}
              isLoaded={loadedSlotId === s.id}
              onSwitch={onSwitch}
              onDelete={onDelete}
              onRename={onRename}
              onDownload={onDownload}
              onTogglePin={onTogglePin}
              cloudControlsVisible={cloudControlsVisible}
              onCloudToggleOptIn={onCloudToggleOptIn}
              onCloudPush={onCloudPush}
              onCloudPull={onCloudPull}
              cloudPushing={cloudPushingIds.has(s.id)}
              cloudPulling={cloudPullingIds.has(s.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface RowProps {
  slot: SlotMeta;
  /** True when this slot's blob is the one loaded into memory right now. */
  isLoaded: boolean;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDownload: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  cloudControlsVisible: boolean;
  onCloudToggleOptIn: (id: string, optIn: boolean) => void;
  onCloudPush: (id: string) => void;
  onCloudPull: (id: string) => void;
  /** True while this row's Push call is in flight (spinner + disabled). */
  cloudPushing: boolean;
  /** True while this row's Pull call is in flight (spinner + disabled). */
  cloudPulling: boolean;
}

/**
 * Three-state per-row cloud sync status:
 *  - 'off'      → user hasn't opted this slot in. Cloud icon hidden /
 *                 gray.
 *  - 'pending'  → opted in but the local copy has changed since the
 *                 last push (or never pushed yet). Yellow up-arrow.
 *  - 'synced'   → opted in, local matches the cloud copy on this device
 *                 as of the last push. Green check.
 *
 * Pull-vs-cloud-newer is intentionally NOT a state here — Phase 1 has
 * no fresh listing on every render so we can't reliably know "the
 * cloud is ahead of me" without an extra fetch on every gear-menu
 * open. The CloudLibraryModal is the path for discovering newer
 * cloud copies.
 */
type CloudSyncState = 'off' | 'pending' | 'synced';

function deriveSyncState(slot: SlotMeta): CloudSyncState {
  if (!slot.cloudOptIn) return 'off';
  if (!slot.cloudId || !slot.cloudPushedAt) return 'pending';
  // Local updates bump `updatedAt`; pushes stamp `cloudPushedAt`. If
  // updatedAt > cloudPushedAt, local has unpushed changes. Strict-
  // greater because the autosave write that follows a push can land
  // on the same millisecond as cloudPushedAt without representing a
  // real change.
  return slot.updatedAt > slot.cloudPushedAt ? 'pending' : 'synced';
}

function SlotRow({
  slot,
  isLoaded,
  onSwitch,
  onDelete,
  onRename,
  onDownload,
  onTogglePin,
  cloudControlsVisible,
  onCloudToggleOptIn,
  onCloudPush,
  onCloudPull,
  cloudPushing,
  cloudPulling,
}: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(slot.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Keep the draft in sync if the slot meta changes underneath us (e.g.
  // autosave updates from another React render path).
  useEffect(() => {
    if (!editing) setDraft(slot.name);
  }, [slot.name, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commitRename(): void {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== slot.name) {
      onRename(slot.id, trimmed);
    } else {
      // Revert visible draft if nothing usable was typed.
      setDraft(slot.name);
    }
  }

  function cancelRename(): void {
    setEditing(false);
    setDraft(slot.name);
  }

  const isPinned = !!slot.pinned;
  const syncState = deriveSyncState(slot);
  const meta = [
    pluralize(slot.totalItems, 'item'),
    pluralize(slot.comparisons, 'comparison'),
    slot.done ? 'done' : null,
    relativeTime(slot.updatedAt),
    isPinned ? 'pinned' : null,
    cloudControlsVisible && syncState === 'synced' ? 'cloud ✓' : null,
    cloudControlsVisible && syncState === 'pending' ? 'cloud ⇡' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={`slot-row${isLoaded ? ' active' : ''}`}>
      <div className="slot-row-main">
        {editing ? (
          <input
            ref={inputRef}
            className="slot-name-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelRename();
              }
            }}
          />
        ) : (
          <button
            className="slot-name"
            type="button"
            // Title surfaces the full name so users can read it via
            // hover when the row width forces a `text-overflow: ellipsis`
            // truncation (e.g. long names in the narrow gear-menu
            // popover). The rename hint is appended so we don't lose
            // the affordance that used to be the sole title.
            title={`${slot.name}\n(click to rename)`}
            onClick={() => setEditing(true)}
          >
            {slot.name}
          </button>
        )}
        <div className="slot-meta">{meta}</div>
      </div>
      <div className="slot-actions">
        {isLoaded ? (
          <span className="slot-active-tag">Active</span>
        ) : (
          <button
            className="btn primary"
            onClick={() => onSwitch(slot.id)}
            title="Switch to this sort"
          >
            Resume
          </button>
        )}
        <button
          className={`icon-button${isPinned ? ' pinned' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(slot.id, !isPinned);
          }}
          title={
            isPinned
              ? `Unpin "${slot.name}" — allow auto-eviction when storage fills up`
              : `Pin "${slot.name}" — exclude from auto-eviction when storage fills up`
          }
          aria-label={isPinned ? `Unpin ${slot.name}` : `Pin ${slot.name}`}
          aria-pressed={isPinned}
        >
          {isPinned ? '★' : '☆'}
        </button>
        {cloudControlsVisible && (
          <CloudRowControls
            slot={slot}
            syncState={syncState}
            onToggleOptIn={onCloudToggleOptIn}
            onPush={onCloudPush}
            onPull={onCloudPull}
            pushing={cloudPushing}
            pulling={cloudPulling}
          />
        )}
        <button
          className="icon-button download-icon"
          onClick={(e) => {
            e.stopPropagation();
            onDownload(slot.id);
          }}
          title={`Download "${slot.name}" as JSON`}
          aria-label={`Download ${slot.name}`}
        >
          {/* "Down arrow above bar" (U+2913) — visually distinct from the
              cloud Pull glyph "⇣" (U+21E3) on the same row, since both
              were just "down arrows" before and the only difference was
              line weight, which read as a render glitch rather than two
              distinct affordances. The companion `.download-icon` class
              boosts font-weight so the bar stays visible at icon-button
              sizes. */}
          ⤓
        </button>
        <button
          className="x-button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(slot.id);
          }}
          title={`Delete ${slot.name}`}
          aria-label={`Delete ${slot.name}`}
        >
          ×
        </button>
      </div>
    </div>
  );
}

interface CloudRowControlsProps {
  slot: SlotMeta;
  syncState: CloudSyncState;
  onToggleOptIn: (id: string, optIn: boolean) => void;
  onPush: (id: string) => void;
  onPull: (id: string) => void;
  /** Whether a Push for this slot is currently in flight. Drives the
   *  spinner glyph swap on the Push button and disables the button so
   *  the user can't queue a second click. The opt-in toggle is also
   *  disabled while either operation is in flight — opting out
   *  mid-push would race the upload's manifest write. */
  pushing: boolean;
  /** Whether a Pull for this slot is currently in flight. */
  pulling: boolean;
}

/**
 * Per-row cloud controls. Renders the opt-in toggle (cloud icon with
 * sync-state coloring) plus Push / Pull buttons gated on opt-in
 * state. Pulled into its own subcomponent to keep `SlotRow` focused
 * on the non-cloud bits.
 *
 * Three icon states, all the same glyph (`☁`) — colored differently
 * via CSS so the click target stays in a stable position regardless
 * of state and the visual scan reads as "this column is the cloud
 * status indicator":
 *
 *  - 'off' (no cloud-on class):  faint outline — "click to back up"
 *  - 'pending' (cloud-on .cloud-pending):  amber — "local has unpushed
 *                                          changes; click to unlink"
 *  - 'synced'  (cloud-on .cloud-synced):   green — "in sync with cloud;
 *                                          click to unlink (deletes
 *                                          cloud copy, keeps local)"
 *
 * Tooltip wording mirrors that: it tells the user what clicking will
 * do, since the icon is also the toggle button.
 *
 * Pull is hidden until there's an established cloud binding (cloudId
 * present) — without one there's nothing to pull. The Cloud library
 * modal is the path for adopting cloud copies that have no local
 * counterpart yet.
 */
function CloudRowControls({
  slot,
  syncState,
  onToggleOptIn,
  onPush,
  onPull,
  pushing,
  pulling,
}: CloudRowControlsProps) {
  const optedIn = syncState !== 'off';
  const hasCloudBinding = !!slot.cloudId;
  const inFlight = pushing || pulling;

  // Tooltip telegraphs the action a click will perform, since the
  // icon doubles as the toggle button. When opted in, opting out
  // destroys the cloud copy — the App-level handler shows a confirm
  // modal first, but the tooltip should still warn so users don't
  // click expecting a no-op. When a push/pull is in flight the
  // toggle is disabled (changing opt-in state mid-upload would race
  // the in-flight call's manifest write), so we surface that in the
  // tooltip too.
  const toggleTitle = inFlight
    ? `Sync in progress for "${slot.name}"…`
    : optedIn
      ? hasCloudBinding
        ? `Stop backing up "${slot.name}" to cloud (deletes the cloud copy; local stays)`
        : `Stop backing up "${slot.name}" to cloud`
      : `Back up "${slot.name}" to cloud`;

  const cloudIcon = '☁';

  // Per-button glyph swap during in-flight calls. The spinner is a
  // simple text glyph rather than an SVG/Lottie so it stays in the
  // monochrome icon-button column (matches ★ / ⇡ / ⇣ / ⤓ / ×) and
  // doesn't require any asset pipeline work. Rotation comes from the
  // `.spinning` CSS class — see `styles.css`.
  const SPINNER_GLYPH = '↻';

  const cloudClassExtra =
    syncState === 'synced'
      ? ' cloud-on cloud-synced'
      : syncState === 'pending'
        ? ' cloud-on cloud-pending'
        : '';

  return (
    <>
      <button
        className={`icon-button${cloudClassExtra}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleOptIn(slot.id, !optedIn);
        }}
        title={toggleTitle}
        aria-label={toggleTitle}
        aria-pressed={optedIn}
        // Block opt-out clicks while a push or pull is mid-flight —
        // the in-flight handler is about to write the manifest, and
        // a concurrent opt-out would race it and either leak the
        // Drive file or roll back the sync metadata to a stale
        // value. Re-enables automatically when the operation
        // releases its in-flight gate.
        disabled={inFlight}
      >
        {cloudIcon}
      </button>
      {optedIn && (
        <button
          className={`icon-button${pushing ? ' spinning' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onPush(slot.id);
          }}
          title={
            pushing
              ? `Pushing "${slot.name}" to cloud…`
              : syncState === 'pending'
                ? `Push "${slot.name}" to cloud (local changes pending)`
                : `Push "${slot.name}" to cloud now`
          }
          aria-label={
            pushing ? `Pushing ${slot.name} to cloud` : `Push ${slot.name} to cloud`
          }
          aria-busy={pushing}
          disabled={pushing}
        >
          {pushing ? SPINNER_GLYPH : '⇡'}
        </button>
      )}
      {optedIn && hasCloudBinding && (
        <button
          className={`icon-button${pulling ? ' spinning' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onPull(slot.id);
          }}
          title={
            pulling
              ? `Pulling "${slot.name}" from cloud…`
              : `Replace "${slot.name}" with the cloud copy`
          }
          aria-label={
            pulling
              ? `Pulling ${slot.name} from cloud`
              : `Pull ${slot.name} from cloud`
          }
          aria-busy={pulling}
          disabled={pulling}
        >
          {pulling ? SPINNER_GLYPH : '⇣'}
        </button>
      )}
    </>
  );
}
