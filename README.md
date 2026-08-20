# Better Canvas (Rice)

A personal, unpacked Chrome extension with quality-of-life tweaks for
[canvas.rice.edu](https://canvas.rice.edu), plus two save-this-page actions that
work on any site: **freeze-dry** (a self-contained `.html` snapshot) and
**Markdown export** (a readable `.md` file). Built for personal use.

## Features

### 1. Custom tab favicon
Every `canvas.rice.edu` tab shows the bundled Canvas logo as its favicon, so
Canvas tabs are easy to pick out. The icon is re-applied if Canvas swaps it back
during single-page navigation.

### 2. Semester-grouped course list on the dashboard and in the sidebar
The dashboard's card grid — and the course list inside the global-nav
**Courses** sidebar tray — are replaced with a compact list, grouped into four
sections:

- **Next semester** (the upcoming semester) — at the top
- **Current semester** (in progress, or most recently active)
- **Previous semester**
- **Older** — everything else, newest first (courses with no term sort last)

A "semester" is a season + year (e.g. `Fall 2026`); sub-terms such as
`MBA Term II` or `Summer Block D1` are shown as a detail line under the course.

Published and unpublished courses stay in the **same** list. Unpublished ones
are visually differentiated (muted, hatched background, and an `Unpublished`
pill) instead of being split into a separate list.

Which semester counts as "current" is decided from real Canvas term start/end
dates when available, and otherwise from an approximate academic calendar built
from the term name. Today (mid-August), Fall is upcoming, so the current
semester is the just-finishing Summer term and Fall shows as **Next**.

In the sidebar tray, Canvas's own "Published Courses" / "Unpublished Courses"
split is replaced by the same four semester groups; the tray's **All Courses**
link and footer text are left as-is.

### 3. Freeze-dry any webpage
Click the extension's toolbar button on **any** site to open a small menu, then
choose **Freeze-dry this page**. The live page — including pages behind a login —
is serialized into one self-contained `.html` file, which downloads to your
computer. CSS, images, and fonts are inlined as `data:` URIs and scripts are
removed, so the saved file opens offline in any browser, with no network access
and no JavaScript. It is a static snapshot of the page as you were seeing it.

To keep snapshots small, jpeg/png images referenced by `<img>`/`<picture>` are
re-encoded as webp (quality 0.82) on the way in, and the webp is kept only when
it saves at least max(512 bytes, 5%). This mirrors the Allume browser
extension's pipeline, including its guards (byte-sniffed type, animated-PNG
bail, dimension limits, fail-soft to the original bytes) and its rule that
images are **never resized** here — intrinsic raster size participates in
layout when the archived page reloads. CSS background images are inlined
untouched, also like Allume.

Browser pages (`chrome://…`) and the Chrome Web Store can't be scripted by
extensions, so those show a short "can't be saved" message instead. Local
`file://` pages work only if the extension's **Allow access to file URLs** toggle
is on (`chrome://extensions` → the extension's Details); otherwise they show the
same "can't be saved" message. (Both restrictions apply to the Markdown export
too.)

### 4. Export any webpage as Markdown
The same toolbar menu has **Export as Markdown**. The page's readable article is
extracted with Mozilla's [Readability](https://github.com/mozilla/readability)
(the Firefox Reader View engine) and converted to GitHub-flavored Markdown with
[Turndown](https://github.com/mixmark-io/turndown), then downloaded as a `.md`
file. When Readability finds no real article — a company homepage, a dashboard —
the **whole page body** is converted instead (scripts, styles, and hidden
elements stripped), so the export never comes back empty. The popup's status
line says which mode ran: `article` or `full page`.

Images are inlined as `data:` URIs (fetched through the same service-worker
proxy and SSRF guard as freeze-dry), so the `.md` stays self-contained even for
images behind your login. Each one runs through the same Allume-mirrored
webp-or-original pipeline as freeze-dry, with one Markdown-only addition: since
a `.md` file has no layout dependency on intrinsic image size, each image is
also downscaled to the size it actually occupied on the page (rendered CSS size
× devicePixelRatio, capped at 2 — never upscaled) before encoding. The base64
blobs sit at the *bottom* of the file as reference-style definitions
(`![alt][img0]` … `[img0]: data:…`), keeping the body readable in a text
editor. An image that can't be fetched (or is bigger than 8 MB after
optimization) keeps its absolute remote URL instead. Note that some renderers —
GitHub, notably — refuse `data:` images; Obsidian, VS Code, and Typora render
them fine.

### 5. Resizable columns on Files pages
On the course/group/user **Files** pages, every column header gets a thin
drag handle on its right edge. Drag it to resize the column — most usefully
to widen **Name** so long file names stop truncating. If the columns outgrow
the window, the table scrolls horizontally inside its own container.
Double-click a handle to hand that column's width back to Canvas.

Widths are deliberately session-only: they survive sorting and folder
navigation (both are client-side re-renders of the same page) but reset on
the next real page load. Nothing is persisted.

## How it works

- **Favicon** — a content script (`src/favicon/favicon.js`, `document_start`)
  removes Canvas's `<link rel="icon">` tags and installs the bundled PNG, with a
  `MutationObserver` to keep it applied.
- **Dashboard** — a content script (`src/dashboard/dashboard.js`) reads course
  data from Canvas's own authenticated JSON API:
  - `GET /api/v1/dashboard/dashboard_cards` — the courses shown on the dashboard
    (includes published + unpublished).
  - `GET /api/v1/courses?include[]=term...` — real term start/end dates.
  - `GET /api/v1/users/self/colors` — each course's color swatch.

  If the API is unreachable, it falls back to scraping the already-rendered
  dashboard cards. Term parsing lives in `src/lib/terms.js` and the semester
  bucketing shared with the tray in `src/lib/grouping.js`.

- **Sidebar tray** — Canvas renders the "Courses" tray with React into
  `#nav-tray-portal` each time it opens, loading the rows async. A content
  script (`src/tray/course-tray.js`, injected on every Canvas page) watches
  with a `MutationObserver`, and when the loaded tray appears it reads the
  courses straight from the tray's own DOM: link + title from each row,
  published/unpublished from the section heading the row sits under, and the
  term from the row's `… | Term: <name>` detail line. It then hides Canvas's
  section wrapper and inserts the semester-grouped list in its place. Course
  colors come from `GET /api/v1/users/self/colors` (fetched lazily, once,
  best-effort).

- **Files column resize** — the new Files page renders the file list as a real
  `<table id="files-table">` (Instructure UI) with `table-layout: fixed`, so
  each column is exactly as wide as its `<thead>` cell — widths Canvas sets
  inline and re-writes on every React re-render. A content script
  (`src/files/column-resize.js`, on `…/files*` pages only) appends a drag
  handle to each header cell and writes dragged widths into an injected
  `<style>` sheet as
  `#files-table thead th[data-testid="name"] { width: …px !important; }` — a
  stylesheet `!important` beats React's inline styles, so the widths survive
  re-renders without the script ever fighting React over the `style`
  attribute. A `MutationObserver` re-inserts the handles whenever React
  rebuilds the header. On drag start all keyed columns are frozen at their
  rendered widths first; otherwise `table-layout: fixed` would redistribute
  the dragged delta across the unsized columns and the drag would feel
  rubbery. The companion CSS makes the table's wrapper
  (`.FileDragOverlayContainer`) a horizontal scroller and lifts the table's
  `max-width: 100%` cap so widened columns can overflow gracefully.

- **Freeze-dry** — clicking the toolbar button opens `src/popup/popup.html`. On
  **Freeze-dry this page** the popup injects `src/content/capture-page.js` into
  the active tab (`chrome.scripting.executeScript`). That script dynamic-imports
  the vendored [WebMemex freeze-dry](https://github.com/WebMemex/freeze-dry)
  bundle (`src/vendor/freeze-dry.js`), which clones the DOM and inlines every
  sub-resource. Cross-origin sub-resources (CDN images, fonts) can't be read by a
  content script because of CORS, so each one is fetched through the service
  worker (`src/background/serviceworker.js`), which carries the extension's host
  permission. Fetched jpeg/png images referenced by `<img>`/`<picture>` are run
  through the shared optimizer (`src/lib/image-optimizer.js`, injected first)
  before inlining. The finished `.html` is downloaded from the page itself via a
  `Blob` URL — nothing is uploaded anywhere.

- **Markdown export** — on **Export as Markdown** the popup first injects the
  vendored classic scripts (`src/vendor/readability.js`, `turndown.js`,
  `turndown-plugin-gfm.js`) plus the shared optimizer, then
  `src/content/export-markdown.js`, into the active tab. That script runs
  Readability on a *clone* of the document (Readability mutates its input; each
  live image's `currentSrc` is copied onto the clone first so
  lazy-loaded/srcset images survive). If the extracted article's text is under
  500 characters the page counts as "no article" and a cleaned clone of the
  whole `<body>` is converted instead. Article images are fetched through the
  same `BC_FETCH_RESOURCE` worker proxy as freeze-dry, optimized
  (webp-or-original + rendered-size downscale), and swapped to `data:` URIs,
  and Turndown (+ its GFM plugin) produces the final Markdown, downloaded via a
  `Blob` URL like freeze-dry.

- **Image optimizer** — `src/lib/image-optimizer.js` (global
  `BCImageOptimizer`) is a port of the image pipeline in the Allume browser
  extension (`muse-ios/BrowserExtension/src/content/capture-page.js`): its
  constants (webp quality 0.82, 32 MB input cap, 16384-px / 16M-pixel dimension
  guards, ≥ max(512 B, 5%) savings rule, two-slot codec semaphore, 2.5 s
  per-attempt budget) and its byte-sniffing guards (`inspectPng`,
  `inspectJpeg`) are copied from there. The rendered-size downscale is this
  repo's Markdown-only extension of that pipeline.

The Canvas features send only same-origin requests to `canvas.rice.edu` using
your existing session. Freeze-dry fetches a page's own sub-resources (the same
ones the page already loaded) purely to inline them into the local file; the
snapshot is never sent to any third party.

Because the worker fetches with your session cookies, it refuses to pull
internal/loopback/link-local resources (`127.0.0.1`, `169.254.169.254`, RFC-1918,
`*.local`, …) into a snapshot of a **public** page, so a captured page cannot use
the extension to reach your intranet. A snapshot of a **local** page (e.g. a
`localhost` dev server) can still inline its own local resources.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and choose this folder.
4. Open [canvas.rice.edu](https://canvas.rice.edu) and reload.

After editing any file, return to `chrome://extensions` and click the reload
icon on the extension card, then reload the Canvas tab.

## Project layout

```
manifest.json                   MV3 manifest
icons/                          extension icons (16 / 48 / 128)
assets/                         tab favicon PNGs (16 / 32 / 48)
src/
  favicon/favicon.js            swaps the tab favicon
  lib/terms.js                  term parsing (season/year/sub-term)
  lib/grouping.js               semester bucketing (next/current/previous/older)
  lib/image-optimizer.js        shared Allume-mirrored image shrinker
  dashboard/dashboard.js        builds the grouped course list
  dashboard/dashboard.css       list styling
  tray/course-tray.js           regroups the "Courses" sidebar tray
  tray/course-tray.css          tray list styling
  files/column-resize.js        drag-resizable Files-page columns
  files/column-resize.css       handle styling + overflow scrolling
  popup/popup.html              toolbar-button menu
  popup/popup.css               menu styling
  popup/popup.js                menu logic (runs the actions)
  content/capture-page.js       freeze-dries the page + downloads it
  content/export-markdown.js    Readability→Turndown export + download
  background/serviceworker.js   cross-origin sub-resource fetch proxy
  vendor/freeze-dry.js          vendored WebMemex freeze-dry bundle
  vendor/readability.js         vendored @mozilla/readability 0.6.0
  vendor/turndown.js            vendored turndown 7.2.4
  vendor/turndown-plugin-gfm.js vendored turndown-plugin-gfm 1.0.2
  vendor/README.md              bundle provenance + the process shim
```

## Notes & next steps

- Only `canvas.rice.edu` is wired up for the Canvas features. `courses.rice.edu`
  support is planned but not implemented yet.
- The "current vs. next" boundary uses an approximate calendar when Canvas does
  not expose real term dates. If a specific semester should land differently,
  the season date ranges are in `src/lib/terms.js` (`SEASONS`).
- Freeze-dry targets Chrome (MV3). Very large pages produce large files, and a
  page that keeps rendering after "load" is captured as it looked at that
  instant. If a sub-resource hangs, the capture gives up after a hard deadline.
- The Markdown export decides article-vs-full-page with a 500-character
  threshold (`MIN_ARTICLE_CHARS` in `src/content/export-markdown.js`); adjust it
  if a page lands in the wrong mode.
- To regenerate the freeze-dry bundle, see `src/vendor/README.md` — the file is
  committed as-is and this repo has no build step.
