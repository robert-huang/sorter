import { useEffect, useMemo, useRef, useState } from 'react';
import type { Item } from '../lib/types';
import { encodeShareLink, shareUrlFor, type SharedKind } from '../lib/share';
import { Modal } from './Modal';

interface Props {
  ranking: Item[];
  slotName?: string;
  onClose: () => void;
}

/**
 * Heuristic warning threshold. Most browsers safely handle URL fragments
 * well past 100KB but some chat clients / mail apps choke earlier. We
 * surface a soft caution above ~50KB so the user knows the link is
 * unusually long and might fail to paste into certain destinations.
 *
 * Hard browser limits aren't well-documented but ~2MB is generally
 * accepted as the practical ceiling. We don't block at any specific
 * threshold — let the user copy and try; failure mode is "paste doesn't
 * fit", not corruption.
 */
const LONG_URL_WARN_BYTES = 50_000;

/**
 * "Share this ranking" modal. Surfaces:
 *  - The shareable URL (auto-selected for one-tap copy)
 *  - A copy-to-clipboard button (uses navigator.clipboard when available;
 *    falls back to selecting the textarea so the user can ⌘/Ctrl-C)
 *  - The encoded payload size + a soft warning if it's unusually large
 *  - A reminder that the link encodes ONLY the final ranking (not the
 *    sort history, not hidden items, not the undo ring)
 *
 * The recipient opens the link in any browser; the app's boot path
 * detects `#share=...` and pops a SharedImportModal offering to import
 * the ranking as a new slot.
 */
export function ShareLinkModal({ ranking, slotName, onClose }: Props) {
  // Default to 'ranking' since that's the legacy behavior — the user
  // got here from a button labeled "Share this ranking" on the RESULT
  // screen. Template mode is an opt-in flip.
  const [kind, setKind] = useState<SharedKind>('ranking');
  // Re-encode on every kind change so the textarea + size estimate
  // reflect the actual link the user will copy. Cheap (encode is just
  // a JSON.stringify + base64); the URL only grows by ~10 bytes for
  // the 'k:"template"' field anyway.
  const encoded = useMemo(
    () => encodeShareLink(ranking, slotName, kind),
    [ranking, slotName, kind],
  );
  const url = useMemo(() => shareUrlFor(encoded), [encoded]);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-select the URL on open so the very first Ctrl-C lands the
  // link in the clipboard even when the Copy button isn't used (and
  // when navigator.clipboard is denied, e.g. http:// origins). Also
  // re-selects on kind toggle so the new (different) URL is ready
  // to copy without an extra click.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    ta.select();
  }, [encoded]);

  async function onCopy(): Promise<void> {
    // Try the modern Clipboard API first. It silently fails on
    // insecure contexts or when the permission is denied, so we fall
    // back to the legacy execCommand path via textarea selection +
    // document.execCommand('copy'). Either way, signal success
    // optimistically — the user will see paste failure immediately
    // if the clipboard didn't actually update.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        return;
      }
    } catch {
      // Fall through to the legacy path.
    }
    const ta = textareaRef.current;
    if (!ta) return;
    ta.select();
    try {
      document.execCommand('copy');
      setCopied(true);
    } catch {
      // No clipboard API and no execCommand — let the user Ctrl-C
      // themselves. The textarea is already selected.
    }
  }

  // Reset the "Copied!" indicator after a beat so multiple copies in
  // succession still give visible feedback.
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const bytes = new Blob([url]).size;
  const isLong = bytes > LONG_URL_WARN_BYTES;

  return (
    <Modal label="Share ranking" onClose={onClose} className="modal-wide">
      <h3>Share this {kind === 'ranking' ? 'ranking' : 'list'}</h3>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0 }}>
        Anyone who opens this link imports it as a new slot in their own
        browser. The link encodes only labels, URLs, and images &mdash;
        not your sort history, hidden items, or undo state. Nothing is
        sent to a server.
      </p>
      <fieldset className="share-kind-fieldset">
        <legend className="share-kind-legend">Share as</legend>
        <label className="share-kind-radio">
          <input
            type="radio"
            name="share-kind"
            value="ranking"
            checked={kind === 'ranking'}
            onChange={() => setKind('ranking')}
          />
          <span>
            <strong>Final ranking</strong>
            <span style={{ color: 'var(--text-muted)' }}>
              {' '}&mdash; recipient gets the items in your sorted order as a
              completed sort. Best when you want to show off the result.
            </span>
          </span>
        </label>
        <label className="share-kind-radio">
          <input
            type="radio"
            name="share-kind"
            value="template"
            checked={kind === 'template'}
            onChange={() => setKind('template')}
          />
          <span>
            <strong>Starting list</strong>
            <span style={{ color: 'var(--text-muted)' }}>
              {' '}&mdash; recipient gets the same items but sorts them
              themselves. Best when comparing rankings or running a group
              poll.
            </span>
          </span>
        </label>
      </fieldset>
      <textarea
        ref={textareaRef}
        className="share-url-textarea"
        readOnly
        value={url}
        rows={4}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="share-info-row">
        <span className="share-info-stat">
          {ranking.length} item{ranking.length === 1 ? '' : 's'} &middot;{' '}
          {(bytes / 1024).toFixed(1)} KB
        </span>
        {isLong && (
          <span className="share-info-warn">
            ⚠ Long URL &mdash; may fail to paste in some chat / mail apps.
            Consider sharing a Download (JSON) instead.
          </span>
        )}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button className="btn primary" onClick={onCopy}>
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </div>
    </Modal>
  );
}
