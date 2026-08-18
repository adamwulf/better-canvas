# Better Canvas (Rice)

A personal, unpacked Chrome extension with quality-of-life tweaks for
[canvas.rice.edu](https://canvas.rice.edu). Built for personal use.

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

No data leaves the browser; every request is a same-origin call to
`canvas.rice.edu` using your existing session.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and choose this folder.
4. Open [canvas.rice.edu](https://canvas.rice.edu) and reload.

After editing any file, return to `chrome://extensions` and click the reload
icon on the extension card, then reload the Canvas tab.

## Project layout

```
manifest.json              MV3 manifest
icons/                     extension icons (16 / 48 / 128)
assets/                    tab favicon PNGs (16 / 32 / 48)
src/
  favicon/favicon.js       swaps the tab favicon
  lib/terms.js             term parsing + semester grouping
  dashboard/dashboard.js   builds the grouped course list
  dashboard/dashboard.css  list styling
```

## Notes & next steps

- Only `canvas.rice.edu` is wired up so far. `courses.rice.edu` support is
  planned but not implemented yet.
- The "current vs. next" boundary uses an approximate calendar when Canvas does
  not expose real term dates. If a specific semester should land differently,
  the season date ranges are in `src/lib/terms.js` (`SEASONS`).
