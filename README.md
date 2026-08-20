# Better Canvas (Rice)

A personal, unpacked Chrome extension with quality-of-life tweaks for
[canvas.rice.edu](https://canvas.rice.edu), plus a **freeze-dry** action that
saves any webpage as a self-contained `.html` snapshot. Built for personal use.

## Features

### 1. Custom tab favicon
Every `canvas.rice.edu` tab shows the bundled Canvas logo as its favicon, so
Canvas tabs are easy to pick out. The icon is re-applied if Canvas swaps it back
during single-page navigation.

### 2. Semester-grouped course list on the dashboard
The dashboard's card grid is replaced with a compact list, grouped into four
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

### 3. Freeze-dry any webpage
Click the extension's toolbar button on **any** site to open a small menu, then
choose **Freeze-dry this page**. The live page — including pages behind a login —
is serialized into one self-contained `.html` file, which downloads to your
computer. CSS, images, and fonts are inlined as `data:` URIs and scripts are
removed, so the saved file opens offline in any browser, with no network access
and no JavaScript. It is a static snapshot of the page as you were seeing it.

Browser pages (`chrome://…`) and the Chrome Web Store can't be scripted by
extensions, so those show a short "can't be saved" message instead. Local
`file://` pages work only if the extension's **Allow access to file URLs** toggle
is on (`chrome://extensions` → the extension's Details); otherwise they show the
same "can't be saved" message.

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
  dashboard cards. Grouping logic lives in `src/lib/terms.js`.

- **Freeze-dry** — clicking the toolbar button opens `src/popup/popup.html`. On
  **Freeze-dry this page** the popup injects `src/content/capture-page.js` into
  the active tab (`chrome.scripting.executeScript`). That script dynamic-imports
  the vendored [WebMemex freeze-dry](https://github.com/WebMemex/freeze-dry)
  bundle (`src/vendor/freeze-dry.js`), which clones the DOM and inlines every
  sub-resource. Cross-origin sub-resources (CDN images, fonts) can't be read by a
  content script because of CORS, so each one is fetched through the service
  worker (`src/background/serviceworker.js`), which carries the extension's host
  permission. The finished `.html` is downloaded from the page itself via a
  `Blob` URL — nothing is uploaded anywhere.

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
  lib/terms.js                  term parsing + semester grouping
  dashboard/dashboard.js        builds the grouped course list
  dashboard/dashboard.css       list styling
  popup/popup.html              toolbar-button menu
  popup/popup.css               menu styling
  popup/popup.js                menu logic (runs the freeze-dry)
  content/capture-page.js       freeze-dries the page + downloads it
  background/serviceworker.js   cross-origin sub-resource fetch proxy
  vendor/freeze-dry.js          vendored WebMemex freeze-dry bundle
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
- To regenerate the freeze-dry bundle, see `src/vendor/README.md` — the file is
  committed as-is and this repo has no build step.
