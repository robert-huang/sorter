# Sorter — queue merge sort webapp

A pure-client React + TypeScript app for ranking a list of items by doing repeated A-vs-B comparisons. Uses a queue-based merge sort: items start as singleton sublists, you compare them one pair at a time, merged sublists go to the back of the queue, and after `N - 1` merges the queue collapses to a single sorted list — your final ranking.

No backend. No telemetry. No accounts. Everything runs in your browser.

## Quick start

```bash
npm install
npm start       # builds then serves at http://localhost:3000
```

That's the recommended day-to-day way to use it: one command, a real `http://` origin, all features (including autosave) work normally. Close the terminal when you're done.

## Three ways to run

### 1. Local serve via `npm start` — recommended

```bash
npm start
```

Builds the app and serves the `dist/` folder over `http://localhost:3000`. Autosave to `localStorage` works. Nothing is published — the files never leave your machine.

### 2. Dev server (when editing the code)

```bash
npm run dev
```

Vite dev server with hot reload at `http://localhost:5173`.

### 3. Double-click `dist/index.html` (no terminal needed)

```bash
npm run build           # one-time; produces dist/
open dist/index.html    # or just double-click in Finder
```

Works fully offline. **Caveat:** browsers treat `file://` origins as opaque and autosave to `localStorage` is unreliable, so the app detects this and shows a banner — use the Save button to keep progress as a JSON file you can re-load later.

### Optional: free static hosting

The `dist/` folder is a normal static site. Upload it to GitHub Pages, Netlify, Vercel, Cloudflare Pages — anything that serves static files. Not needed for personal use.

## CSV format

```
ITEM, URL (optional), IMAGE (optional)
```

- Column order is positional. Header row names are not used for mapping.
- "First row is a header" checkbox defaults **off**. Check it if your CSV has a header. A soft hint appears if the first row looks like a header.
- Quoted fields (with embedded commas, newlines) are supported.

Example:

```csv
Inception,https://imdb.com/title/tt1375666,https://example.com/inception.jpg
Heat
"Pit, the card game",,https://example.com/pit.png
```

## Two import modes

### Sort from scratch
One CSV (paste or file). Items become N singleton sublists in CSV order. The merge sort starts from there.

### Merge pre-ranked lists
Upload multiple CSVs at once. Each file is treated as a sorted sublist (row order = your expressed ranking within that file). Optional "extras" textarea for unranked singletons that get prepended to the front of the queue (they merge with each other first, then meet the pre-ranked sublists).

### Dedup behavior (applies everywhere CSVs are parsed)

- **Identity**: `canonicalKey(label) = slug(trim(lowercase(label)))`. So `"The Mind"`, `"the mind "`, and `"THE MIND"` are the same item with id `the-mind`.
- **First occurrence wins** for position.
- **Metadata merges** from later occurrences: if the first row had no URL/IMAGE but a later row does, the missing field is filled in. Existing values are never overwritten.
- The import preview shows every dedup conflict with source file + row number and what got merged from where.

## Keyboard shortcuts (on the RANK tab)

| Key       | Action       |
| --------- | ------------ |
| `←`       | Pick left    |
| `→`       | Pick right   |
| `↑`       | Undo         |

Mouse:
- **Click** a card → pick that side.
- **Middle-click** a card → open its URL in a new tab (if present), does not count as a pick.
- **× button** in the corner of a card → remove that item from the sort (reversible via undo).

## Mid-sort editing (LIST tab)

The LIST tab is a live, editable view of the queue — unlike Pub Meeple, opening it does not throw away progress. You can:

- See the queue and the currently-merging frame (merged + left + right slices).
- **Remove** items (reversible).
- **Restore** previously hidden items.
- **Reorder ↑ / ↓** items within any queued sublist.
- **Break apart** a queued sublist into singletons appended to the end of the queue (useful when you decide an inferred ordering is wrong).
- **+ Add item** (Label / URL / Image URL) → appends a new singleton sublist.
- **+ Add pre-ranked list** → upload another CSV mid-sort; new sublist goes to the back of the queue.

Currently-merging sublists are read-only here (only Remove is allowed) — to fix something inside an active merge, undo back past its start.

## Undo

Bounded ring of the last **50** actions. Pick, hide, unhide, add, reorder, break-apart, append — all undoable via `↑` or the Undo button.

## Progress stats

The header shows **`Comparison #N`** where N is the click you're about to make (1-indexed; switches to "Done · N comparisons" when finished).

### Progress bar

The bar is driven by **comparisons remaining** (worst-case), not merges:

- For each upcoming merge of visible sizes `a` and `b`, the cost is `a + b − 1` comparisons (with `a, b > 0`); the merged result has size `a + b`. We simulate forward through the FIFO queue (plus the in-flight `current` frame) to compute the worst-case total remaining.
- This is an **exact upper bound**: the bar is conservative and never under-promises. Actual merges often finish early when one side is exhausted (one pick auto-appends the entire other side's remainder), and when that happens the bar visibly **jumps forward**.
- The denominator is a running maximum (`totalComparisonsEverNeeded`) so adding items / pre-ranked sublists / breaking sublists apart mid-sort can only push the bar back, not erase progress retroactively.

### "Show estimated comparisons left" toggle

Gear menu → checkbox. When on, the stat reads `Comparison #N · ~M left` where `M` is `comparisonsRemaining(state)`. Off by default — the bar is usually enough.

## Theme

Sun/moon button in the toolbar toggles light ↔ dark mode. The choice is persisted to `localStorage` and applied to `<html data-theme="…">` on every page load. There is no auto-follow-system mode; pick the one you want.

## Save slots

The app keeps up to **10 named save slots** in your browser. One slot is **active** at a time — it's the one getting the live autosave and undo ring. Other slots are frozen snapshots you can resume any time from the gear menu.

### How slots work

- **Refresh = back to START.** Refreshing the page never auto-loads a session. You always land on the START tab and re-enter a sort explicitly.
- **Last used Resume CTA.** When there's a previously-active slot, START shows a "Resume *[name]*" card at the top — one click and you're back where you left off. The CTA hides itself when you're already sorting in something.
- **Full slot list lives in the gear menu.** Open the ⚙ menu in the toolbar to see every saved sort, switch between them, rename them in place, or delete them. The list is ordered most-recently-touched first.
- **New sort = new slot.** "Start sorting" (scratch or pre-ranked) or "Load save file…" always mints a new slot and activates it. Your previous slot stays intact and selectable from the gear menu.
- **Switching slots** (Resume button in the gear menu) flushes the outgoing slot's autosave and loads the incoming one, including its undo ring.
- **Rename** by clicking the slot's name in the gear menu and editing in place. Enter to commit, Escape to cancel.
- **Delete** with the × in the slot row. Deleting the loaded slot drops you back at START.
- **Cap of 10.** Creating an 11th slot auto-evicts the slot with the oldest `updatedAt`.
- **Migration.** If you used a previous build of this app (single autosave under `sorter:v1`), it's auto-converted into your first slot on next launch — nothing is lost.

### Autosave (per-slot, in `localStorage`)

When available, the app writes the active slot's full session (items, progress, undo ring) to `localStorage` automatically:

- Debounced 500ms after every change.
- Forced flush every 10 seconds OR every 20 comparisons of continuous activity.
- Synchronous flush on tab close / refresh / backgrounding.

Worst-case data loss in a hard crash: ≤20 comparisons OR ≤10 seconds of clicks. Zero in normal exits.

### Toolbar Save vs. Download

These two buttons are deliberately different:

- **Save (`💾`)** — force-flushes the autosave for the active slot to in-browser storage *right now*, bypassing the debounce. Shows a brief `✓ Saved` tick on success. Disabled under `file://` where localStorage isn't available; use Download in that case.
- **Download (`⬇`)** — downloads a JSON file (`sorter-YYYYMMDD-HHMM.json`) containing the active slot's full session. Works everywhere including `file://`.

### Load

Gear menu → "Load save file…" → pick a previously-downloaded JSON. It's imported as a brand-new slot (auto-named from the file's basename) and activated.

## Where state physically lives

| What | Where |
| --- | --- |
| Explicit JSON downloads | Wherever your browser's download dialog points (default `~/Downloads/`). Real files, user-owned, portable. |
| Slot manifest | `localStorage` key `sorter:slots:v1`. Tracks slot ids, names, and which is active. |
| Slot blobs | `localStorage` key `sorter:slot:<id>:v1` per slot. Holds items, progress, undo ring for that slot. |
| Settings (theme, etc.) | `localStorage` key `sorter:settings:v1`. |
| Image cache | Browser HTTP cache; auto-managed. |

All `localStorage` entries live inside the browser's profile directory (macOS Chrome: `~/Library/Application Support/Google/Chrome/<profile>/Local Storage/leveldb/`). They survive restarts; vanish if you clear browsing data; scoped to one browser on one machine.

## Tests

```bash
npm test            # one-shot
npm run test:watch  # watch mode
```

Algorithm tests (init, picks, hide/unhide, add, append, reorder, break-apart, undo round-trips, degenerate-frame skipping), CSV tests (canonical key, header detection, dedup with metadata merging, multi-source parsing), and storage tests (slot CRUD, legacy migration, cap eviction, autosave routing to the active slot).

## Project layout

```
src/
  main.tsx, App.tsx, styles.css
  lib/
    types.ts            # SortState / SortProgress / Item / SaveFile / DedupWarning,
                        # SlotMeta / SlotsManifest
    queueMergeSort.ts   # pure algorithm: initSort, seedFromSublists, pickLeft, pickRight,
                        # hideItem, unhideItem, addItem, appendPreRankedSublist,
                        # reorderInSublist, breakApartSublist, mergesRemaining,
                        # comparisonsRemaining, getRanking
    csv.ts              # canonical key, header detection, parse, dedup
    storage.ts          # isAutosaveAvailable, slot CRUD (createSlot, setActiveSlot,
                        # deleteSlot, renameSlot), migrateLegacyIfNeeded,
                        # scheduleAutosave/flushAutosave (per-active-slot),
                        # downloadSave/loadSaveFromFile, settings
    __tests__/          # vitest suites
  hooks/useKeyboard.ts
  components/           # Header, SettingsMenu, StartScreen, ImportPreview,
                        # SlotList, ListScreen, CompareScreen, ResultScreen,
                        # ItemCard, AddItemModal, AddPreRankedModal, SlotDeleteConfirmModal
```

## License

Personal project. Do whatever you want with it.
