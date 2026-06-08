# Sorter — queue merge sort + binary insertion webapp

**Live demo:** [robert-huang.github.io/sorter](https://robert-huang.github.io/sorter/)

A pure-client React + TypeScript app for ranking a list of items by doing repeated A-vs-B comparisons.

It runs one of **two engines** per slot:

- **Merge** (default): a queue-based merge sort. Items start as singleton sublists, you compare them one pair at a time, merged sublists go to the back of the queue, and after `N - 1` merges the queue collapses to a single sorted list — your final ranking.
- **Insertion**: a binary-insertion engine. A frozen `sorted[]` is the existing ranking; new items drain through a FIFO `pending[]` and get binary-inserted into `sorted[]` one at a time. Used when you're seeding a slot from an already-sorted CSV or adding new items into a completed merge sort.

Both engines share the same RANK / LIST / RESULT screens, undo ring, autosave, and save-file format.

Items can come from a pasted/loaded CSV **or be imported from [AniList](https://anilist.co)** — pull a user's anime/manga list or favourites into a local SQLite cache (kept in your browser's OPFS), filter it down, then sort. AniList items get rich **detail panels** (media metadata + cast/voice-actors, and staff filmographies) and also feed a side game, **[Anime to Anime](#anime-to-anime-separate-page)**.

No backend. No telemetry. No accounts. Everything runs in your browser.

> Optional opt-in: per-slot cloud backup via Google Drive (manual Push/Pull). See the Cloud backup section below for details. The local AniList cache can likewise be Pushed/Pulled to Drive — see [Local source database](#local-source-database-anilist-cache).

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

### Anime to Anime (separate page)

A side mini-app: connect a **Start** anime to a **Goal** anime by hopping through shared voice actors (and optional production-staff or franchise hops). It reads the same AniList SQLite cache as the main sorter — import lists on START → AniList first. Full feature list is below; here's how to open and run it:

- Dev: `http://localhost:5173/anime-to-anime.html`
- After `npm run build`: `dist/anime-to-anime.html`
- Source: `anime-to-anime.html`, `src/animeToAnime/`
- Open from either page: floating nav button (**A2A →** on the Sorter, **← Sorter** on A2A), or gear menu footer (**Anime to Anime** / **Sorter**)
- **Local DB:** shares the OPFS-backed `anilist.sqlite` with the Sorter — see [Local source database](#local-source-database-anilist-cache). Workers load via Vite's `?worker` import (not raw `.ts` URLs — those get the wrong `video/mp2t` MIME type on some servers).
- **Theme:** independent from main Sorter (`anime-to-anime-theme` in localStorage); sun/moon toggle in the header; defaults to **dark**

See [Anime to Anime — gameplay](#anime-to-anime--gameplay) further down for setup, modes, hops, and the win/give-up screens.

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

## Import modes (START tab)

The START tab has three source tabs — **Sort from scratch**, **Merge pre-ranked lists**, and **Import from AniList** — plus a shared **Staged Items** panel at the bottom. Items from any tab stack into the staged panel; you choose the engine when you start the sort.

### Sort from scratch
One CSV (paste or file). Items become N singleton sublists in CSV order. The merge sort starts from there.

### Sort from scratch — "already in ranking order" (insertion mode)
Same CSV input as "sort from scratch", but with the **"These items are already in ranking order (skip the sort)"** checkbox enabled. Items become the frozen `sorted[]` of a brand-new insertion-mode slot; the slot opens straight on RESULT in a `done` state with 0 comparisons. You can then "+ Add items" later to binary-insert new items into the ranking.

### Merge pre-ranked lists
Paste or upload multiple CSVs. Each list is treated as a sorted sublist (row order = your expressed ranking within that list). Optional "extras" textarea for unranked singletons that get prepended to the front of the queue (they merge with each other first, then meet the pre-ranked sublists). This always uses the **merge engine** — pre-ranked lists still need to be merged against each other.

### Import from AniList
Pull a user's anime/manga list (or favourites) from AniList into the local cache, filter it, and stage a subset to sort. See the dedicated [Importing from AniList](#importing-from-anilist) section for the full flow.

### Staged Items panel & choosing an engine
All three tabs feed one **Staged Items** panel. Each batch you add is a **staged group**:

- **unranked** (`flat`) — every item becomes its own singleton sublist (competes from scratch). Scratch CSVs and **all AniList groups** stage this way.
- **ranked** (`sublist`) — row order is preserved as an expressed ranking (pre-ranked CSVs, or scratch with "already in ranking order").

Empty state reads: *"Nothing staged yet. Add items from any tab above — clipboard, pre-ranked lists, and AniList all stack into one sort."* You can expand groups, edit labels/URLs, and soft-remove groups or items before starting.

Start with the split button (needs ≥ 2 unique items):

- **Start sort** (default) — *"Classic pairwise merge sort — fewest comparisons overall"* (the merge engine).
- **Insertion sort** — *"Binary-insert items one at a time; pre-ranked lists seed the order"* (the binary-insertion engine; see [the insertion engine](#on-the-insertion-engine)).

If exactly one ranked group is staged with the "already sorted" hint, the button instead offers **Use as ranking** (skip the sort, opens straight on RESULT).

### Dedup behavior (applies everywhere CSVs are parsed)

- **Identity**: `canonicalKey(label) = slug(trim(lowercase(label)))`. So `"The Mind"`, `"the mind "`, and `"THE MIND"` are the same item with id `the-mind`. (AniList items dedup by their AniList id, e.g. `anilist:21`, so two imports of the same show collapse to one.)
- **First occurrence wins** for position — across CSV rows *and* across staged groups from different sources.
- **Metadata merges** from later occurrences: if the first row had no URL/IMAGE but a later row does, the missing field is filled in. Existing values are never overwritten.
- The import preview shows every dedup conflict with source file + row number and what got merged from where.

## Importing from AniList

The **Import from AniList** tab on START pulls a public AniList user's data into a local SQLite cache (see [Local source database](#local-source-database-anilist-cache)), lets you filter it, and stages a subset to sort. The model is deliberately **import everything → filter down → stage subsets → sort** — so you can batch, combine with other sources, and re-use the cache without re-hitting the API.

> No AniList login is needed — just a username (public lists only). The last successful username is remembered.

### 1. Enter a username and choose what to load

Two paths share the username field:

- **List import** — pick **Anime** or **Manga**, then **Import anime / Import manga** (the button reads **Reimport …** when a cache already exists). A full list import pulls **every** entry regardless of status; you filter by status afterward.
- **Favourites import** — pick a type from **Characters / Staff / Studios / Anime / Manga** and **Refresh …**. Counts show when cached (e.g. `Characters (12)`).

Both paths offer **Use cached list / Use cached favourites** to load straight from the local DB with no network call. While fetching you'll see progress like `Connecting to AniList…`, `Resolving "name"…`, `Fetching list (page 1 · 412 items so far)…`, then `Writing N rows to local cache…`.

### 2. Filter and select

After data loads into the preview:

- **Filter chips** (FilterBar) narrow the candidates. Media chips include **list status**, **status**, **genre**, **format**, **year**, **seasonYear**, **score** (your AniList score), **studio**, **voice actor** (with a lazy *"Fetch cast for N shows"* action), **tag** / **tag options** / **exclude tag**. Favourite characters/staff have their own chips (gender, favourites count, role, language, etc.).
  - The **list status** chip defaults to `CURRENT`, `COMPLETED`, `REPEATING` — so PLANNING / PAUSED / DROPPED entries are hidden until you change it.
- **Search…** further narrows visible rows by title (matches romaji/english/native + synonyms).
- Tick the per-row checkboxes (all checked after an import). **Select all visible** / **Clear visible** help; a status line reads `{visible} of {total} shown · {selected} selected`.
- **Append format to title (e.g. Title (TV))** appends the AniList format to each label, e.g. `Shinryaku! Ika Musume (TV)`.

### 3. Stage and sort

Click **Add {N} selected to staged** to append an **unranked** group to the [Staged Items](#staged-items-panel--choosing-an-engine) panel (selection clears so the next batch is explicit). Repeat for multiple batches (e.g. an anime list plus character favourites), optionally mix in CSV/pre-ranked groups, then **Start sort** (merge) or **Insertion sort**.

### Labels, caching, and rate limits

- **Labels** follow the global **Display names** preference (title language romaji/english/native; staff names full/native — see [display preferences](#display-names-titles--staff-names)) and update live if you change it, even for already-staged items.
- **Caching**: imports do a transactional wipe-and-rebuild for that user + type in `anilist.sqlite`, then (when cloud is connected) auto-push the DB to your Drive folder. Incremental edits (detail-panel expansions) require a manual Push.
- **Rate limits**: requests are serialized; on an AniList `429` the app backs off (honoring `Retry-After`, up to ~5 retries). Only one import can run per source at a time (`An import is already running — wait for it to finish.`).

## AniList detail panels

AniList items expose two detail panels that read from the local cache and lazily fetch more from AniList on demand. There is **no back stack** — opening one panel from another replaces it in place (media → staff → media → …, one modal at a time).

### Opening a panel

Only AniList items can open a panel (`canOpenItemDetail`): anime/manga items (and anime/manga favourites) open the **media** panel; staff favourites open the **staff** panel. Manual items and character favourites have no panel.

- **LIST tab** — click a thumbnail, or the **ⓘ** info button next to the edit (✎) button on any row/chip. Tooltip: `Details for "{label}"`.
- **RANK tab** — the **ⓘ** button on each comparison card (`View details`); clicking it doesn't count as a pick.
- **RESULT tab** — click a result thumbnail.
- **Middle-click** a thumbnail or card → opens the item's AniList page in a new tab (doesn't open the panel or count as a pick).

### Media detail panel

Loads cached metadata immediately and shows: cover, resolved **title**, and chips for type/format/status/season+year, episodes or chapters, mean score (`⌀ {n}/100`), favourites (`★`), country, and start/end dates; plus **Genres**, **Studios**, and **Tags** sections.

- **Cast** — characters with role and **`VA:`** voice actors. VA names are clickable → open that person's **staff** panel.
- **Production** — staff credits with a **Key roles** / **All credits** toggle (persisted). Staff names are clickable → staff panel.
- **Lazy expansion** — on first open, cast + production staff are fetched from AniList and cached (metadata stays visible if that fetch fails). Cache lines show `Cast: {date} (complete|incomplete, fresh|stale (>90d))` and the same for staff.
- **↻ Refresh** re-fetches cast & staff (`Re-fetch cast & staff for this entry (does not auto-push)`).
- The media panel has **no synopsis** and **no relations UI** (relations power the Anime-to-Anime game, not this panel). Reach the AniList page via the card/thumb link or middle-click.

### Staff detail panel

Shows the staff image, name (+ native name), language, favourites (`★`), an **AniList ↗** link, and a **Filmography** of merged production + voice credits (one row per media, newest first). Each row shows the cover, title, role line (production roles and/or `voiced {characters}`), and `{year} · {format}`.

- **Filmography rows** — left-click opens that media's panel; **middle-click** opens its AniList page (`Open {title} (middle-click to open on AniList)`).
- **Only items on my list** — a checkbox shown when an AniList user list is cached; filters the filmography to media on your list (anime or manga). The count shows `(N of M)` when active.
- **Lazy expansion** — on first open the filmography is fetched from AniList and cached; later opens read the cache.
- **↻ Refresh** re-fetches the filmography. When the cache is **over 90 days old**, the button turns **amber** with the tooltip `This person's cached filmography is over 90 days old — click to re-fetch from AniList`.

## Local source database (AniList cache)

AniList data lives in a per-source **SQLite database in your browser's OPFS** (`anilist.sqlite`), shared by the main Sorter and the Anime-to-Anime page. It survives reloads when the tab can use persistent OPFS storage; otherwise the tab falls back to **in-memory** SQLite for the session.

### One active tab holds the cache

Each page (Sorter, Anime to Anime) runs its own dedicated DB worker but targets the **same OPFS file**, coordinated by a Web Lock. Only **one tab at a time** can hold the persistent cache:

- Navigating Sorter ↔ Anime to Anime **in the same tab** is fine — the worker is torn down on leave so the next page can open the file.
- A **second tab** falls back to in-memory storage and shows a banner, e.g. *"Another tab of this app has the database open. Close other Sorter / Anime to Anime tabs and reload to use your saved cache."* You can still **Pull** from Drive to load a session copy without closing the other tab.
- OPFS needs a secure context (HTTPS or `http://localhost`) and sync access handles; **no COOP/COEP headers are required**, so it works on GitHub Pages.

### Source databases (gear menu → Databases)

The gear menu has a **Slots** tab and a **Databases** tab. The Databases tab shows a **Source databases** section (and is disabled under `file://` with *"Database sync needs autosave enabled…"*). To **refresh a source's data**, you use START → that source's import mode — *"To refresh a source's data, open the Start tab and pick the source's import mode."*

When cloud backup is connected, each source row offers manual **Push** / **Pull** of the whole `.sqlite` to a `db/` subfolder of your Drive folder, with a sync status (`in sync` / `drifted` / `local changes` / …), last Pushed/Pulled timestamps, and a `{N} pending change(s) — manual push required.` banner with **Push now**. Push is blocked from a non-persistent (in-memory) tab; Pull is allowed. Conflicts surface plain messages (e.g. `Remote has new changes — pull first.`).

> Full **list/favourites imports auto-push** the DB when cloud is ready. Incremental edits (detail-panel cast/staff/filmography expansions) bump a pending-changes counter and need a manual Push.

### Display names (titles & staff names)

Under the AniList row in **Source databases** is a **Display names** panel:

- **entry** (media titles): **Romaji** (default) / **English** / **Native**
- **staff** (person names): **Full** (default) / **Native**

The choice is stored in `localStorage`, shared across the Sorter and Anime-to-Anime pages, and applied live to labels, detail panels, and (in A2A) the path trail.

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
- **ⓘ button** in the corner of a card (AniList items only) → open its [detail panel](#anilist-detail-panels); does not count as a pick.

## Mid-sort editing (LIST tab)

The LIST tab is a live, editable view of the engine state — unlike Pub Meeple, opening it does not throw away progress.

### On the merge engine

- See the queue and the currently-merging frame (merged + left + right slices).
- **Remove** items (reversible).
- **Restore** previously hidden items.
- **Reorder ↑ / ↓** items within any queued sublist, or within the in-flight merge frame (merged / left remaining / right remaining). Swaps never cross those slices; the visible compare heads on left/right remainders are locked so LIST edits don't change the RANK pair.
- **Break apart** a queued sublist into singletons appended to the end of the queue (useful when you decide an inferred ordering is wrong).
- **+ Add item(s)** — see *Add items modal* below.
- **To be inserted (N) section** — items that were hidden mid-merge and then exiled when the merge (or auto-insert) closed live here. Click **↺ Insert** to binary-search them back into a queue sublist via a manual-insert mini-session, or **× Forget** to drop them from the rank permanently. See *Exile + Insert* below.

To fix order inside an active merge without using ↑/↓, undo back past the merge start.

### On the insertion engine

- **Sorted (N)** — the frozen ranking. You can hide individual items here, but you can't re-order (anything that needs to move would go through a fresh binary insert via "+ Add item(s)").
- **Pending (N)** — items waiting to be binary-inserted (FIFO drain). Hide to skip an item from pending.
- **Currently inserting** — the active binary-insertion frame, mirrored on the RANK tab.
- **+ Add item(s)** — see *Add items modal* below.

### Add items modal (LIST tab, both engines)

One button, two tabs:

- **Single** — Label + URL + Image URL fields, identical to the original add-item form.
- **Multiple** — paste a CSV or load a `.csv` file, with the same header-detection hint and dedup behavior as the START-tab importer. Items already in the sort (by canonical label) are skipped with a banner explaining how many were dropped.

On the **merge engine**, the Multiple tab adds a checkbox: **"Treat as one pre-ranked sublist (preserve order)"**.

- Unchecked (default) → each parsed row becomes its own singleton sublist at the back of the queue (equivalent to clicking the Single tab N times in a row).
- Checked → the rows become ONE ranked sublist at the back of the queue; the row order is treated as your expressed ranking within that sublist. Same semantic as the legacy "+ Add pre-ranked list" button, just folded into the unified modal.

On the **insertion engine** the checkbox is hidden — `pending[]` is FIFO either way, so there's no meaningful distinction between the two.

## Exile + Insert (merge engine)

When a merge or auto-insert closes and one or both sides have **hidden** items at that moment, those items are **exiled** into a separate `toBeInserted[]` bucket rather than positioned silently at the tail of the closed sublist (which was the old behavior; it could land hidden items at arbitrary slots if the user later unhid them).

- The user is free to `done` the sort while items sit in `toBeInserted[]` — exile does not block completion. RESULT just doesn't show those items in the ranking (they appear under "removed during sorting").
- Clicking **↺ Insert** on a to-be-inserted item opens a binary-insertion mini-session ("manual insert") that searches the largest queue sublist (or, when `done`, the single result sublist) for the right position, then splices the item in.
- Multiple Inserts queue up: if you click Insert mid-merge, the request waits until the merge closes, then drains. While one manual insert is running you'll see an **"Inserting X into queue sublist"** banner on the RANK tab.
- Cancel an in-flight manual insert with the **Cancel insertion** button on the RANK tab — the item bounces back to the To-be-inserted bucket (comparisons already made for that insert remain "spent"; use Undo to back them out).
- Forget drops the item permanently.

## Auto-insert (merge engine)

Each time `advance()` pops a new pair off the queue, it checks whether **binary-inserting the smaller side into the larger side** is cheaper than the full merge:

- Merge cost (visible sizes `K ≤ N`): `K + N − 1`.
- Auto-insert cost (worst case, rank-blind): `K · ⌈log₂(N + K)⌉`.
- When auto-insert wins **strictly**, the engine installs an `AutoInsertFrame` instead of a normal merge frame. The smaller side becomes `pendingInserts` (FIFO, in rank order); the larger side becomes the `target` they get binary-inserted into.

The frame uses **rank-aware bound tightening**: each subsequent insert starts its lower bound at the previously-landed position + 1, because `pendingInserts` is in rank order. That gives a `Σ ⌈log₂(N + i)⌉` bound — in practice much tighter than the rank-blind worst case. As that gap is realized, the progress bar **jumps forward**.

Examples:

- `[A,B,C,D,E]` + `[F]` → K=1, N=5: insert=3 < merge=5 → auto-insert.
- `[…8 items]` + `[X, Y]` → K=2, N=8: insert=8 < merge=9 → auto-insert.
- `[A,B,C]` + `[D,E,F]` → K=N=3: insert=9 > merge=5 → classic merge.

Behavior notes:

- The banner on the RANK tab reads **"Inserting X into queue sublist"** for both manual and auto inserts. Auto-insert has **no Cancel button** — it's engine-driven, not a user request, and it always runs to completion. To opt out of auto-insert *as a sort strategy*, turn off **Auto-insert skewed pairs** in the gear menu (see below). To opt out of an individual item, hide it: the engine cancels the in-flight insert (if on that id) or drops it from `pendingInserts`.
- Hidden ids in the popped pair are **exiled to `toBeInserted[]` at install time** (same rule as the merge close), since auto-insert doesn't probe them.
- Hidden ids inside the popped `target` ride along until the auto-insert closes; then the **exile rule** applies (they end up in `toBeInserted[]`, not at arbitrary positions in the closed sublist).

### "Auto-insert skewed pairs" toggle

Gear menu → checkbox. **On** by default. When off, every popped pair goes through the classic merge. Useful if you'd rather work through a long ranked sublist via comparisons rather than blind binary insertion — but on average the heuristic is a clear win on skewed inputs.

## "+ Add items" after a sort completes (RESULT tab)

On a completed sort you can click **+ Add items** to add more items in one batch:

- **Insertion engine** → the new items append to `pending[]` and the slot re-enters RANK; you binary-insert them one at a time.
- **Merge engine, done** → the app offers to **switch the slot to insertion mode**: the merge's final ranking becomes the insertion engine's frozen `sorted[]`, and the new items become `pending[]`. This is in-place: the previous merge state goes onto the undo ring (one Undo backs it out), and autosave persists the new shape. A confirmation modal explains the trade-off and reminds you to Download a JSON copy first if you want a long-term safety net.
- **Merge engine, not done** → the new items append as a pre-ranked sublist to the back of the queue (same behavior as "+ Add pre-ranked list" on LIST).

## Undo

Bounded ring of the last **50** actions. Pick, hide, unhide, add, reorder, break-apart, append — all undoable via `↑` or the Undo button.

## Progress stats

The header shows **`Comparison #N`** where N is the click you're about to make (1-indexed; switches to "Done · N comparisons" when finished).

### Progress bar

The bar is driven by **comparisons remaining** (worst-case), not merges:

- For each upcoming pair of visible sizes `a` and `b`, the per-pair cost is **`min(merge, auto-insert)`** when auto-insert is enabled (and just merge cost when off): merge = `a + b − 1`; auto-insert worst case = `K · ⌈log₂(N + K)⌉` with `K = min(a, b)`, `N = max(a, b)`. We simulate forward through the FIFO queue (plus the in-flight `current` / `currentAutoInsert` / `currentManualInsert` frames) to compute the worst-case total remaining.
- This is an **upper bound**: the bar is conservative and never under-promises. Actual merges often finish early when one side is exhausted (one pick auto-appends the entire other side's remainder), and rank-aware bound tightening on auto-insert frames trims their cost below the rank-blind formula above. When that happens the bar visibly **jumps forward**.
- The denominator is a running maximum (`totalComparisonsEverNeeded`) so adding items / pre-ranked sublists / breaking sublists apart mid-sort can only push the bar back, not erase progress retroactively.

### "Show estimated comparisons left" toggle

Gear menu → checkbox. When on, the stat reads `Comparison #N · ~M left` where `M` is `comparisonsRemaining(state)`. Off by default — the bar is usually enough.

## Theme

Sun/moon button in the toolbar toggles light ↔ dark mode. The choice is persisted to `localStorage` and applied to `<html data-theme="…">` on every page load. There is no auto-follow-system mode; pick the one you want.

## Save slots

The app keeps up to **30 named save slots** in your browser. One slot is **active** at a time — it's the one getting the live autosave and undo ring. Other slots are frozen snapshots you can resume any time from the gear menu.

### How slots work

- **Refresh = back to START.** Refreshing the page never auto-loads a session. You always land on the START tab and re-enter a sort explicitly.
- **Last used Resume CTA.** When there's a previously-active slot, START shows a "Resume *[name]*" card at the top — one click and you're back where you left off. The CTA hides itself when you're already sorting in something.
- **Full slot list lives in the gear menu.** Open the ⚙ menu in the toolbar to see every saved sort, switch between them, rename them in place, or delete them. The list is ordered most-recently-touched first.
- **New sort = new slot.** "Start sorting" (scratch or pre-ranked) or "Load save file…" always mints a new slot and activates it. Your previous slot stays intact and selectable from the gear menu.
- **Switching slots** (Resume button in the gear menu) flushes the outgoing slot's autosave and loads the incoming one, including its undo ring.
- **Rename** by clicking the slot's name in the gear menu and editing in place. Enter to commit, Escape to cancel.
- **Delete** with the × in the slot row. Deleting the loaded slot drops you back at START.
- **Download backup** with the ⬇ button in the slot row — exports that slot's JSON without switching to it. Handy before deleting or before hitting the cap.
- **Pin (★)** in the slot row marks a slot as exempt from automatic eviction. Pinned slots are NEVER touched by the slot-cap eviction modal's "Delete oldest" path OR by the safety-net eviction that fires when autosave hits the browser's storage quota. Use it to protect sorts you care about long-term while letting the app freely evict scratch work.
- **Cap of 30.** Once you're at the cap, creating a new slot pops the `SlotCapConfirmModal` listing the oldest *unpinned* slot that would be deleted; you can Cancel, "Download oldest first" (saves a JSON of the victim, then continues), or "Delete oldest & continue". If every slot is pinned, the cap blocks the mint entirely and surfaces a banner — unpin or delete to make room. On the rare safety-net path where the storage layer still has to evict (e.g. multiple paths race to cap), a toast banner names what got deleted.
- **Migration.** If you used a previous build of this app (single autosave under `sorter:v1`), it's auto-converted into your first slot on next launch — nothing is lost.
- **Manifest repair.** If localStorage's manifest blob ever becomes unreadable (corrupted JSON, partial write from a crash), the boot path scans for any remaining slot blobs and rebuilds a fresh manifest from their contents. A one-shot banner reports how many slots were recovered. Slot names from the rebuild come from the items themselves (since the original metadata was lost with the manifest); rename as needed.

### Multi-tab coordination

The app can be open in multiple browser tabs at once. We use the browser's `storage` event to keep them loosely in sync:

- **Manifest changes** (create / delete / rename / pin in another tab) refresh the slot list silently in this tab.
- **Same-slot edits** in another tab — i.e. you've been sorting the same slot in two tabs at the same time — pop a "Another browser tab updated this slot" banner here with a **Reload** action. Reload discards this tab's in-flight autosave (so it doesn't clobber the other tab's writes) and re-reads the slot blob from disk. Dismiss keeps the in-memory state and lets the next autosave overwrite the other tab (last-writer-wins).
- The banner only shows when this tab has in-memory state for the affected slot. Without state, the next visit naturally reads the fresh blob.

### Storage quota recovery

If autosave hits the browser's localStorage quota (you'll typically only see this after years of accumulated slots), recovery runs in two stages before surfacing a hard failure:

1. **Trim the undo ring.** Drops the oldest half of the undo entries on disk AND mirrors that trim in-memory so the next write doesn't immediately re-grow the on-disk ring.
2. **Evict the oldest non-pinned non-active slot.** Same rule as cap eviction — pinned slots are protected. A toast banner names what got deleted.

If neither stage frees enough room (every slot is pinned, or the single remaining slot still doesn't fit), a persistent danger banner appears: "Autosave failed — browser storage is full." Your work continues in-memory for the session; pin / delete a slot or Download the current sort to a JSON file to recover.

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

## Share link

On the RESULT tab of a completed sort, the **Share link** button generates a URL that encodes the final ranking in its hash fragment (`#share=<base64url-payload>`). Anyone who opens the link in any browser sees a preview overlay and can import the ranking as a new slot in their own browser.

- **Encodes only the final ranking** — labels, URLs, and image URLs in rank order. Sort history, hidden items, undo ring, and engine state are intentionally NOT included. The recipient gets a frozen, done sort they can re-rank by hitting Start over.
- **Nothing is sent to a server.** The hash fragment never leaves the user's browser unless they paste the URL somewhere else. The encoder runs entirely client-side; the decoder runs entirely client-side at boot.
- **Size**: the modal shows the payload size in KB and warns above ~50 KB ("may fail to paste in some chat / mail apps") — at that point Download the JSON instead and share the file. Practical ceiling is browser-dependent but generally past 100 KB the hash will still work in URL bars, just not necessarily in every paste destination.
- **Bad / hand-edited payloads** decode to null; the recipient sees a "share link was broken or unreadable" toast and the bad hash is cleared from the URL so a refresh doesn't keep re-prompting.

## Anime to Anime — gameplay

A side game (separate page; see [how to open it](#anime-to-anime-separate-page)) where you connect a **Start** anime to a **Goal** anime by hopping through the AniList graph in your local cache: *"Connect start → goal through voice actors and optional production staff."* You first import some lists on the main Sorter (START → AniList) to populate the cache.

### Setup

Pick a **Start** and a **Goal** (they must differ), then **Start round**. Each endpoint can be filled by:

- **Random from cache** — a random anime already in your local DB
- **Random from AniList** — a random anime from the API
- **Search** — `Title in cache or AniList…` (searches the cache first, then the API)
- **AniList ID** — paste an id and **Load**
- **Swap start and goal** — the arrow button (available in setup and mid-round)

Round rules are **snapshotted** when you press Start round — changing them mid-round only affects the next round. Setup shows the cache size (e.g. *"1,234 anime in local cache."*).

### Round rules & modes (gear → Settings)

- **Production credits** *(on by default)* — show a **Production** staff section on anime pages and allow hopping through production staff.
- **All production roles** *(off; needs Production on)* — when off, only **key** roles (Director, Character Design, Script, Music, …); when on, every credited role.
- **Franchise relations mode** *(off by default)* — show a **Related anime** section and allow direct anime→anime hops via AniList relations (sequel, prequel, side story, …). Each relation hop costs **1 link**.
- **Show page — voice cast** — radio choosing whether cast rows show the **voice actor photo** (default) or the **character photo**.

Titles/names follow the shared [Display names](#display-names-titles--staff-names) preference and relabel the path trail live.

### Playing a round

You move between **anime** nodes and **staff** nodes:

- From an **anime**: hop via a **Voice actor** or **Production** staff member (→ staff node, **free**), or a **Related anime** when franchise mode is on (→ anime node, **1 link**).
- From a **staff** member: hop via their **Anime Voice Roles** or **Anime Staff Roles** filmography (→ anime node, **1 link**).

Notes:
- **Links used** counts every anime→anime hop, **including revisits**; staff hops are free. The header shows `Links used: N`.
- **Filter list…** does an in-round text search over the current hop list (names, titles, roles, relation types). There is **no** "only on my list" restriction — any cached show is fair game.
- The **path trail** shows your route with distinct anime vs staff styling; hovering an edge shows how you hopped (character/role, production role, relation type). **Middle-click** any anime/staff/hop opens its AniList page in a new tab.
- Cast/relations/filmography are fetched into the cache on demand; each section has a refresh (e.g. *Refresh cast from AniList*).
- **Give up** (with confirm) ends the round early; clicking the header title offers **Leave this round?** to return to setup.

### Win / give-up screen

Reaching the Goal shows **Goal reached!** with **Links used** and the path taken; giving up shows **Round ended** with **Links used before giving up**. From here you can:

- **Share Results** (copies a summary like `Anime to Anime: {start} → {goal} in N link(s) used` plus the path and page URL) — the button ticks to **✓ Copied**.
- **Shortest path (cached)** — runs a BFS over your cached graph (respecting the active round rules) to see whether a shorter route exists. After a win it's capped at the links you used (*"Shortest in cache: X link(s) · Your path: Y link(s)"*); after a give-up it's an unbounded search. If nothing is found it suggests expanding more shows/staff or changing rules.
- **Play Again** — returns to setup with your Start/Goal still selected (press Start round again).

## Cloud backup (optional, opt-in per slot)

Slot-level Push / Pull to a Google Drive folder of your choosing. The whole feature is opt-in — both at sign-in time and per-slot — and the app never touches files you didn't explicitly grant access to.

### What gets backed up

- One Drive file per slot, written under a folder you pick on first sign-in. The filename is `<slotName>_<slotId>.sorter.json`. The same v3 save-file envelope the Download button produces, so you can drop a slot file out of Drive and re-import it via "Load save file…" without any reshaping.
- The slot↔file binding is by Drive file id, not by name. Rename the file in Drive's UI and the binding still works (the app overrides the name on the next Push — the local slot name is the source of truth).
- The undo ring is **stripped before upload**. Personal-scale: smaller blobs, no cross-device undo noise, cloud-as-truth means you'll never want to undo something that happened on a different device.

### Setup

1. Click the ⚙ gear → **Sign in to cloud backup…** — a same-window Google OAuth redirect using PKCE. The app requests only the `drive.file` scope, which can see / touch nothing in your Drive *except* files this app creates or files you explicitly grant via the Picker.
2. After OAuth, the gear menu shows **Pick cloud folder…** — opens Google's Picker for you to choose where backups will live. Any folder works (an existing one, or a fresh "Sorter Backups" folder you make).
3. The folder choice is persisted (`sorter:cloud:folder:v1` in localStorage). You can change folders any time via **Change cloud folder…** in the gear menu.

### Per-slot Push / Pull

Open the gear menu, find the slot row in the saved-sorts list:

- **☁ toggle** turns cloud backup on/off for that slot. Turning it off also deletes the cloud copy (the local choice stays honest with what's in your Drive). Turning it back on later creates a fresh file on the next Push.
- **⇡ Push** uploads the current local copy of the slot. Updates the existing Drive file when one is bound, otherwise creates a new one.
- **⇣ Pull** replaces the local copy with the cloud copy in place (keeping the same local slot id and the binding). If the slot is the one currently loaded in memory, the active view reloads to match.

The per-slot meta line shows `cloud ✓` when the local copy matches the last Push from this device, or `cloud ⇡` when there are local changes you haven't pushed yet.

### Conflict handling

- **Cloud copy was changed elsewhere** — if another device (or a hand-edit in Drive) has pushed since this device last synced, the next Push pops a confirm modal. You can Cancel (and Pull first to merge by hand) or **Push anyway**, which overwrites the cloud copy with the local one.
- **Cloud copy was deleted in Drive** — the next Push detects the 404 and creates a fresh file under the chosen folder; the local binding rebinds to the new id and a toast explains what happened.
- **Local storage full on Pull** — if the pulled blob doesn't fit, the app strips its undo ring and retries once. The cloud copy is *not* re-Pushed after the strip, so another device with more quota can still pull the full version.

### Cloud library

Gear menu → **Browse cloud library…** shows every slot file under your chosen folder. Pull from here to adopt a cloud slot as a brand-new local slot (different from the per-row Pull, which replaces an existing one in place).

### Sign-out / Delete-everywhere

- **Sign out of cloud** wipes the tokens and the folder selection from localStorage. Cloud-side files are untouched — they stay in your Drive.
- **Delete a slot that has a cloud copy** — the delete confirm modal grows a third button: **Remove from device** (cloud copy stays) vs **Delete everywhere** (also wipes the cloud blob). The cloud-vs-not choice is always explicit; there's no "Don't ask again" shortcut for cloud-backed slots.

### Sessions / token refresh

The app uses Google's refresh-token flow to silently keep your session alive across page reloads. If the refresh token gets revoked (you removed app access in your Google account, the token aged out, or Safari ITP cleared storage), a yellow **"Cloud session expired — sign in again"** banner appears at the top of the app. No retry queue — re-sign-in and re-trigger whatever you wanted to do.

### Build config

Cloud backup is gated on two build-time env vars:

- **`VITE_GOOGLE_CLIENT_ID`** — your OAuth client id from [Google Cloud Console](https://console.cloud.google.com) (APIs & Services → Credentials → Web application credential type).
- **`VITE_GOOGLE_CLIENT_SECRET`** — the matching "client secret" Google generates alongside the id (same Credentials page, "Client secrets" panel on the right of the OAuth client detail view).

Without either, the gear menu's cloud entry surfaces a "not configured" error on click and the rest of the app still works normally.

> **About the "secret" in a browser bundle.** PKCE-in-the-browser flows usually don't need a client secret, but Google's "Web application" OAuth client type is classified as confidential and rejects token exchange without one — there's no public-client type that accepts arbitrary `https://` redirect URIs the way "Web application" does, so it's the only viable client type for a serverless GitHub-Pages-hosted app. The "secret" therefore ends up inlined into the deployed JS bundle, alongside the client id. The real anti-phishing defense is still the **Authorized redirect URIs** allowlist on the Google Cloud Console side — a stolen id+secret pair can only redirect to URLs you've explicitly registered, which makes phishing your app's consent screen impractical. We treat the secret the same way as the client id: kept out of source so forks don't accidentally consume your Google API quota, but accepted as visible in the built bundle.

For local dev, drop both in a `.env.local` at the repo root (gitignored by `.env*` in `.gitignore`):

```bash
VITE_GOOGLE_CLIENT_ID=123456-abc….apps.googleusercontent.com
VITE_GOOGLE_CLIENT_SECRET=GOCSPX-…
```

Then `npm start` (rebuilds + serves) or `npm run dev` picks them up. **Vite inlines env vars at build time**, so if you change `.env.local` while `npm start` is running you have to Ctrl+C and re-run it before the new value takes effect.

### Deploying to GitHub Pages with cloud backup

The included `.github/workflows/deploy.yml` builds + publishes the app to GitHub Pages on every push to `main`. To enable cloud backup on the deployed copy:

1. **Add two repo secrets** — Repo Settings → Secrets and variables → Actions → **New repository secret**, once for each:
    - Name: `VITE_GOOGLE_CLIENT_ID`, value: your `…apps.googleusercontent.com` OAuth client id
    - Name: `VITE_GOOGLE_CLIENT_SECRET`, value: the matching client secret
   The workflow's `npm run build` step is wired to read both via `${{ secrets.VITE_GOOGLE_CLIENT_ID }}` and `${{ secrets.VITE_GOOGLE_CLIENT_SECRET }}`, so the next push inlines them into the deployed bundle. If either is missing the deployed app falls back to the "not configured" banner with no other ill effects.
2. **Register the GitHub Pages URL with your OAuth client** — in Google Cloud Console → APIs & Services → Credentials → your OAuth client:
    - Authorized JavaScript origins: `https://<your-username>.github.io`
    - Authorized redirect URIs: `https://<your-username>.github.io/<repo-name>/` *(trailing slash is mandatory — Google does exact-string matching on redirect URIs and the app sends `window.location.origin + window.location.pathname`, which for an `index.html` at the directory root resolves to `…/<repo>/`)*

## Where state physically lives

| What | Where |
| --- | --- |
| Explicit JSON downloads | Wherever your browser's download dialog points (default `~/Downloads/`). Real files, user-owned, portable. |
| Slot manifest | `localStorage` key `sorter:slots:v1`. Tracks slot ids, names, and which is active. |
| Slot blobs | `localStorage` key `sorter:slot:<id>:v1` per slot. Holds items, progress, undo ring for that slot. |
| Settings (theme, etc.) | `localStorage` key `sorter:settings:v1`. |
| Cloud OAuth tokens | `localStorage` key `sorter:cloud:tokens:v1`. Access + refresh tokens for Google Drive. Wiped by Sign out. |
| Cloud folder selection | `localStorage` key `sorter:cloud:folder:v1`. Drive folder id + display name. Wiped by Sign out. |
| Cloud PKCE state (transient) | `sessionStorage` key `sorter:cloud:pkce:v1`. Lives only across the OAuth redirect round-trip. |
| Pre-auth URL hash (transient) | `sessionStorage` key `sorter:preAuthHash`. Restores any in-flight `#share=…` payload after the OAuth redirect. |
| Cloud slot files | One JSON file per opted-in slot inside the Drive folder you picked. Named `<slotName>_<slotId>.sorter.json`. |
| AniList cache (source DB) | SQLite in **OPFS**: `/anilist.sqlite` (or `/anilist-mem.sqlite` in the in-memory fallback). Shared by Sorter + Anime to Anime. |
| Source DB sync metadata | `localStorage` key `sorter:db-sync:v1`. Per-source etags, push/pull times, pending-change count, scrape lock. |
| AniList display preferences | `localStorage` key `anilist:display-preferences:v1`. Title language + staff-name format. |
| Cloud source-DB files | One `.sqlite` per source under a `db/` subfolder of your Drive folder (e.g. `db/anilist.sqlite`). |
| Image cache | Browser HTTP cache; auto-managed. |

All `localStorage` entries live inside the browser's profile directory (macOS Chrome: `~/Library/Application Support/Google/Chrome/<profile>/Local Storage/leveldb/`). They survive restarts; vanish if you clear browsing data; scoped to one browser on one machine.

## Tests

```bash
npm test            # one-shot
npm run test:watch  # watch mode
```

Coverage:

- **Merge algorithm** (`queueMergeSort.test.ts`): init, picks, hide/unhide, addItem / addItems (batch singletons), appendPreRanked, reorder, break-apart, undo round-trips, degenerate-frame skipping, exile-on-close, manual Insert / Forget / Cancel insert, auto-insert heuristic / install / drain / rank-aware bounds / hide-id / forecast.
- **Binary-insertion primitive** (`binaryInsertion.test.ts`): `startInsert / applyInsertPick`, zero-comparison collapse, lex oracle, tight-bounds.
- **Insertion engine** (`insertionSort.test.ts`): seed-as-sorted, FIFO drain, add/addItems mid-plan, hide-while-inserting, snapshot/restore.
- **Engine dispatch** (`engine.test.ts`): polymorphic getPair / comparisonsRemaining / hide / unhide / addItems, `transitionMergeDoneToInsertion`, cross-engine undo round-trip.
- **CSV** (`csv.test.ts`): canonical key, header detection, dedup with metadata merging, multi-source parsing.
- **Storage** (`storage.test.ts`): slot CRUD, legacy v1 migration, cap eviction (pin-aware), autosave routing + debounce + force-flush + discard-pending, v1 → v3 and v2 → v3 progress upgrades (including undo ring), v3 round-trip for both engine shapes, two-stage quota recovery (trim undo → evict non-pinned), manifest repair from orphaned slot blobs after manifest corruption.
- **Share link** (`share.test.ts`): encode/decode round-trip (incl. non-ASCII labels, order preservation, dropped-undefined optional fields), failure modes (bad base64, bad JSON, wrong version, empty items, wrong-type optional fields), URL hash extraction.
- **Cloud backup** (`cloud.test.ts`): filename build/parse, etag-mismatch handling, provider proxy behavior.
- **AniList importer & cache** (`lib/importers/anilist/__tests__/`): `importer` / `favourites` (wipe-and-rebuild), `transport` (serialization + 429 backoff), `runners`, `lazyExpansion`, `queries.filmography`, `migration`, `mappers`, `readQueries`, `anilistSource`, label builders (`mediaDisplayLabel`, `personDisplayLabel`, `anilistItemLabel`, `mediaSort`), and filters (`filters`, `characterStaffFilters`, `staffRoleFilter`).
- **Local source DB / OPFS** (`lib/db/__tests__/`): `client`, `workerInit`, `dbWorkerCore`, `dbExec`, `dbTransport`, `opfs` / `opfsLock` / `opfsInstallRetry`, `migration-runner`, `sync`, `syncManifest`, `merge` (row-level pull merge).
- **AniList UI** (`components/__tests__/`): `AnilistDetailModal`, `StaffDetailModal` (lazy expand / refresh / my-list toggle / stale warning / middle-click), `ItemThumb`, `StagedItemsPanel` (engine split button), `FilterBar`, `listScreenH`, `compareScreenH`.
- **Anime to Anime** (`animeToAnime/__tests__/`): `cachedGraph` (0–1 BFS shortest-path), `listFilter`, `pathHopLabels`, `vaCreditDisplay`, `preferences`.
- **Hooks** (`hooks/__tests__/`): `useAnilistWaitCountdown` (rate-limit countdown).

## Save-file format & migration

Save files (both the in-browser `localStorage` blob and downloaded JSON) are versioned.

- **v1** — original single-engine schema (no `engine` field on `progress`).
- **v2** — adds the `engine: 'merge' | 'insertion'` discriminator plus the merge engine's `unplaced / pendingPlacements / currentPlacement` fields (the original "Place" vocabulary).
- **v3** — renames the placement fields to **insert** vocabulary (`pendingManualInserts / currentManualInsert`) and adds **`currentAutoInsert`** for the auto-insert frame.
- **v4** — renames `unplaced → toBeInserted` on merge progress for vocabulary consistency with the rest of the Insert-flavored API.

Loaders accept any version 1–4. The upgrade path is deliberately minimal and shape-driven: missing fields default-fill rather than being translated from legacy names. The per-version acceptable losses are:

- **v1 → current**: no exile/insert fields existed, so all defaults are zero/empty/null. No data lost.
- **v2 → current**: `pendingPlacements` and `currentPlacement` are dropped on load; a save paused mid-Place silently loses its in-flight frame and any queued-to-be-Placed items.
- **v3 → current**: `unplaced` is dropped on load; any items sitting in the "to be inserted" bucket disappear.
- The undo ring is upgraded entry-by-entry the same way.

The next write persists the blob as v4. Older builds that only understand v1 / v2 / v3 will **not** be able to read v4 blobs (the version check is strict — download a JSON copy first if you need to roll back). Rationale for the lossy upgrades: this is a personal-scale app; the simplification was worth more than per-version translation shims.

## Project layout

```
anime-to-anime.html     # Anime to Anime entry (Vite multi-page build)
index.html              # main sorter app
src/
  animeToAnime/         # Anime to Anime game (AnimeToAnimeApp.tsx, EndpointPicker,
                        # VA/production/filmography hop buttons, path trail,
                        # WinScreen, AnimeToAnimeSettingsMenu, cachedGraph 0–1 BFS)
  main.tsx, App.tsx, styles.css, lib/appRoutes.ts
  lib/
    types.ts            # SortState / SortProgress (discriminated union: MergeProgress
                        # | InsertionProgress) / Item / MergeFrame / InsertFrame /
                        # ManualInsertFrame / AutoInsertFrame / SaveFile (v1|v2|v3|v4) /
                        # SlotMeta / SlotsManifest
    binaryInsertion.ts  # pure primitive: startInsert / applyInsertPick / getInsertPair /
                        # worstCaseInsertCost
    queueMergeSort.ts   # merge engine: initSort, seedFromSublists, pickLeft, pickRight,
                        # hideItem, unhideItem, addItem, addItems (batch singletons),
                        # appendPreRankedSublist, reorderInSublist, reorderInCurrentMerge,
                        # breakApartSublist,
                        # manualInsert, forgetItem, cancelManualInsert,
                        # shouldAutoInsert (heuristic), MergeOptions,
                        # mergesRemaining, comparisonsRemaining, getRanking
    insertionSort.ts    # insertion engine: buildInsertionState, seedAsSorted, pickLeft,
                        # pickRight, addItem, addItems, hideItem, unhideItem,
                        # snapshotProgress, restoreProgress, comparisonsRemaining,
                        # getRanking
    engine.ts           # polymorphic dispatch facade (getPair, comparisonsRemaining,
                        # snapshotProgress, restoreProgress, pickLeft/Right, hide/unhide,
                        # addItem, addItems, transitionMergeDoneToInsertion)
    csv.ts              # canonical key, header detection, parse, dedup
    storage.ts          # isAutosaveAvailable, slot CRUD, upgradeProgress (v1/v2/v3 → v4),
                        # migrateLegacyIfNeeded, repairManifestIfCorrupt,
                        # scheduleAutosave/flushAutosave/discardPendingAutosave,
                        # pinSlot, peekEvictionTarget, isAtCapAndAllPinned,
                        # subscribeAutosaveError (two-stage quota recovery),
                        # downloadSave/loadSaveFromFile, settings
    share.ts            # encodeShareLink/decodeShareLink (URL-fragment payload),
                        # shareUrlFor, readShareParamFromHash
    cloud.ts            # provider-agnostic cloud backup interface +
                        # proxy + filename helpers (buildSlotFilename,
                        # parseDisplayNameFromFilename) + CloudEtagMismatchError
    cloud/
      googleDrive.ts    # Google Drive provider impl: PKCE OAuth, token storage,
                        # folder picker integration, list/pull/push/remove,
                        # 404-fallback create-new, version-based etag check
    importers/anilist/  # AniList source: importer + favourites (fetch list/favourites
                        # → SQLite, wipe-and-rebuild), transport (HTTP + 429 backoff),
                        # queries / graphQueries, mappers, readQueries (productionReads),
                        # lazyExpansion + expandStaffFilmography / expandMediaRelations,
                        # runners, filters / characterStaffFilters / staffRoleFilter,
                        # label builders (mediaDisplayLabel / personDisplayLabel /
                        # anilistItemLabel / mediaSort) + displayPreferences, anilistSource
    db/                 # OPFS SQLite layer: client + worker + dbWorkerCore (RPC),
                        # dbTransport, opfs / opfsLock / opfsInstallRetry, migrations +
                        # migration-runner, sync + syncManifest (Drive push/pull, pending
                        # changes, scrape lock), merge (row-level pull merge),
                        # dbPageLifecycle
    __tests__/          # vitest suites
  hooks/                # useKeyboard, useAnilistDisplayPreferences,
                        # useAnilistWaitCountdown, useSourceDbSync
  components/           # Header, SettingsMenu (now with cloud sign-in / browse /
                        # change folder / sign-out entries), StartScreen,
                        # ImportPreview,
                        # SlotList (pin ★ toggle + per-row cloud opt-in /
                        #          Push / Pull controls when cloud is ready),
                        # ListScreen (engine-aware),
                        # CompareScreen (engine indicator + cancel-placement),
                        # ResultScreen (+ Add items, + Share link), ItemCard,
                        # ItemThumb (shared image + onError-fallback initials),
                        # Modal (shared dialog shell: focus trap / Escape /
                        #        restore-focus / role+aria),
                        # AddItemsModal (unified Single / Multiple tabs),
                        # ShareLinkModal (sender: URL + copy + size warn),
                        # SharedImportModal (recipient: preview + import-as-new),
                        # SlotDeleteConfirmModal (split into Remove from device /
                        #                         Delete everywhere when slot
                        #                         has a cloud copy),
                        # SlotCapConfirmModal,
                        # StartOverConfirmModal, EditItemModal,
                        # CloudLibraryModal (read-only browse + Pull-as-new-slot),
                        # CloudPushConflictModal (etag-mismatch confirm),
                        # itemDetailContext (canOpenItemDetail + opener),
                        # AnilistStartMode (START AniList import + FilterBar + preview),
                        # StagedItemsPanel (cross-source staging + engine split button),
                        # FilterBar, AnilistDetailModal (media), StaffDetailModal,
                        # sourceDatabasesSection + AnilistDisplayPreferencesPanel,
                        # CloudBackupSection, AppNavFab, AppBannerStack, SettingsGitHubLink
```

## Roadmap

- **AniList integration** — import lists/favourites into a local OPFS SQLite cache, filter + stage to sort, media/staff detail panels, and Drive backup of the cache. (Shipped — see [Importing from AniList](#importing-from-anilist), [AniList detail panels](#anilist-detail-panels), and [Local source database](#local-source-database-anilist-cache).) Design notes live in `.cursor/plans/`.
- Additional import sources beyond AniList, reusing the same per-source SQLite cache layer.

## License

Personal project. Do whatever you want with it.
