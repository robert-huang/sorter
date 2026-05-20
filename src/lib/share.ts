import type { Item } from './types';

/**
 * Share-link version. Bump when the wire shape changes incompatibly.
 * The decoder accepts only the current version — older versions will
 * fail-decode and the recipient sees a friendly error rather than a
 * corrupted partial import.
 */
const SHARE_VERSION = 1;

/**
 * Wire shape. Field names are intentionally one-letter to keep URL
 * fragments short — at 100+ items the difference between `imageUrl`
 * and `m` is ~1.5KB per share. We pay readability tax in this file
 * but not in the URL.
 *
 *   v: schema version
 *   n: optional ranking name (defaults to "Shared sort" when missing)
 *   i: items (rank order when k='ranking'; arbitrary order when k='template')
 *     - i: id
 *     - l: label
 *     - u: optional url
 *     - m: optional imageUrl
 *   k: optional kind discriminator (defaults to 'ranking' for back-compat).
 *      'ranking'  = encoded order IS the rank; recipient imports as a
 *                   finished sort.
 *      'template' = candidate list, no rank; recipient starts a fresh
 *                   sort over these items.
 */
interface SharedPayloadV1 {
  v: 1;
  n?: string;
  i: Array<{ i: string; l: string; u?: string; m?: string }>;
  k?: SharedKind;
}

/**
 * What the recipient is being handed:
 *  - 'ranking'  → items are in final rank order; pre-rank a new slot
 *  - 'template' → items are a candidate list; run a fresh sort
 */
export type SharedKind = 'ranking' | 'template';

/**
 * What `decodeShareLink` hands back to the App layer. `kind` always
 * has a value (defaults to 'ranking' for legacy payloads that predate
 * the discriminator).
 */
export interface SharedRanking {
  name: string;
  items: Item[];
  kind: SharedKind;
}

/**
 * Convert a UTF-8 string to URL-safe base64. We have to round-trip
 * through TextEncoder first so non-ASCII labels (e.g. CJK, emoji)
 * survive — naive `btoa(s)` throws on any code point > 0xff.
 */
function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Inverse of `toBase64Url`. Re-pads to a multiple of 4, swaps the
 * URL-safe chars back, runs `atob`, then UTF-8 decodes the byte stream.
 * Throws on malformed input — callers must catch and treat as a bad link.
 */
function fromBase64Url(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const padCount = (4 - (padded.length % 4)) % 4;
  const bin = atob(padded + '='.repeat(padCount));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Encode an item list into a share URL fragment payload. The output
 * is the value to put after `#share=` in a URL — call sites typically
 * splice it into `location.origin + location.pathname + '#share=' + encoded`.
 *
 * When `kind` defaults to (or is explicitly) `'ranking'`, `items` MUST
 * be in rank order (index 0 = top). Hidden items are NOT shared — the
 * share-link is a finished ranking, not the full sort history.
 *
 * When `kind = 'template'`, item order is irrelevant — the recipient
 * runs their own sort, so this is purely a "share my candidate list"
 * payload. The wire format is identical (saves us a second envelope
 * shape); only the recipient-side action differs.
 *
 * Implementation note: we keep only the four fields the recipient
 * needs to recreate a slot. Internal engine bookkeeping (the merge
 * queue, the undo ring, the comparison count) is intentionally
 * dropped — the recipient either imports as DONE (ranking) or starts
 * a fresh sort (template), so engine state from the sender doesn't
 * apply either way.
 *
 * `kind` is omitted from the wire when 'ranking' so existing share
 * links produced by older builds remain byte-identical to ones
 * produced by this function. Only template payloads carry the `k`
 * field. Decoders default missing `k` to 'ranking'.
 */
export function encodeShareLink(
  items: Item[],
  name?: string,
  kind: SharedKind = 'ranking',
): string {
  const payload: SharedPayloadV1 = {
    v: SHARE_VERSION,
    i: items.map((it) => {
      const out: { i: string; l: string; u?: string; m?: string } = {
        i: it.id,
        l: it.label,
      };
      if (it.url) out.u = it.url;
      if (it.imageUrl) out.m = it.imageUrl;
      return out;
    }),
  };
  if (name) payload.n = name;
  if (kind !== 'ranking') payload.k = kind;
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Build the full share URL using the current page's origin + path
 * and the supplied encoded fragment. Separated from `encodeShareLink`
 * so the encoder is independently unit-testable (no `window` dep).
 */
export function shareUrlFor(encoded: string): string {
  if (typeof window === 'undefined') return `#share=${encoded}`;
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#share=${encoded}`;
}

/**
 * Decode a share-link fragment payload back to a SharedRanking. Returns
 * null on any failure (bad base64, bad JSON, wrong shape, wrong version,
 * empty items array). The caller surfaces null as "this share link is
 * broken" rather than throwing — recipients should never see a stack trace.
 *
 * Intentionally strict on shape: every item must have a non-empty id +
 * label string. We allow url/imageUrl to be missing but reject if they're
 * present-and-non-string (defends against hand-edited payloads).
 */
export function decodeShareLink(encoded: string): SharedRanking | null {
  if (!encoded) return null;
  let raw: string;
  try {
    raw = fromBase64Url(encoded);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Partial<SharedPayloadV1>;
  if (p.v !== SHARE_VERSION) return null;
  if (!Array.isArray(p.i) || p.i.length === 0) return null;
  // `k` is optional. Missing or unrecognized values default to
  // 'ranking' — that's both the original (pre-discriminator) behavior
  // and the safer fallback (recipient sees the items as a sort result
  // rather than starting a sort they didn't ask for).
  const kind: SharedKind = p.k === 'template' ? 'template' : 'ranking';
  const items: Item[] = [];
  for (const entry of p.i) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as { i?: unknown; l?: unknown; u?: unknown; m?: unknown };
    if (typeof e.i !== 'string' || e.i.length === 0) return null;
    if (typeof e.l !== 'string' || e.l.length === 0) return null;
    if (e.u !== undefined && typeof e.u !== 'string') return null;
    if (e.m !== undefined && typeof e.m !== 'string') return null;
    const it: Item = { id: e.i, label: e.l };
    if (e.u) it.url = e.u;
    if (e.m) it.imageUrl = e.m;
    items.push(it);
  }
  return {
    name: typeof p.n === 'string' && p.n.length > 0 ? p.n : 'Shared sort',
    items,
    kind,
  };
}

/**
 * Pluck the `share=...` value out of a URL's hash fragment, or null if
 * there isn't one. Tolerates hashes that contain other key/value pairs
 * (e.g. `#share=...&foo=bar`) by splitting on `&`. Returns the still-encoded
 * payload — caller is responsible for `decodeShareLink`.
 */
export function readShareParamFromHash(hash: string): string | null {
  if (!hash) return null;
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!trimmed) return null;
  for (const part of trimmed.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) === 'share') return part.slice(eq + 1);
  }
  return null;
}
