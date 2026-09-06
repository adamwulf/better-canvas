# Better Canvas (Rice)

A personal, unpacked Chrome extension with quality-of-life tweaks for
[canvas.rice.edu](https://canvas.rice.edu), plus a name-flashcard study mode on
the Esther course roster. Built for personal use.

> The freeze-dry / Markdown "save this page" actions that used to live here have
> moved to a separate, standalone extension.

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

### 3. Resizable columns on Files pages
On the course/group/user **Files** pages, every column header gets a thin
drag handle on its right edge. Drag it to resize the column — most usefully
to widen **Name** so long file names stop truncating. If the columns outgrow
the window, the table scrolls horizontally inside its own container.
Double-click a handle to hand that column's width back to Canvas.

Widths are deliberately session-only: they survive sorting and folder
navigation (both are client-side re-renders of the same page) but reset on
the next real page load. Nothing is persisted.

### 4. Name flashcards on the Esther course roster
On the Esther **Class Roster** page (`esther.rice.edu/selfserve/swkrost.main`),
a **🃏 Flashcard Mode** button appears next to **Download Roster**. Pressing it
dims the page and deals a deck of study cards:

- The card **front** shows the student photo.
- Clicking the card **flips** it to the name and the roster's own name-pronunciation
  player.
- **✅ Correct** / **❌ Incorrect** buttons grade the guess, send the card to the
  back of the deck, and deal the next student.

The deck shows every student once in random order (one "pass"), then reshuffles
for the next pass, so the whole class is covered each round. A live score
(correct / incorrect / percent) shows at the top. Keyboard: **Space** flips,
**C**/**X** grade, **Esc** closes. Nothing is persisted; the score resets when
the overlay closes.

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

- **Roster flashcards** — a content script (`src/flashcards/flashcards.js`, on
  the Esther `…/swkrost*` roster page only) reads each student from
  `<table class="reporttable">`, locating the **Photo**, **Name**, and **Name
  Pronunciation** columns by their header text so a column reorder cannot break
  it. The launch button is inserted before `input[name="p_download"]`. When a
  card is dealt, the student's photo `<img>` and the NameCoach `<iframe>` are
  cloned straight out of the page onto the card, so the real pronunciation play
  button keeps working without the script reaching into a cross-origin `data:`
  iframe. The overlay, deck, flip, scoring, and shuffle are all in that one file;
  its styling is in `src/flashcards/flashcards.css`.

The Canvas features send only same-origin requests to `canvas.rice.edu` using
your existing session. The roster flashcards send no network requests at all —
they only read what the roster page already rendered.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and choose this folder.
4. Open [canvas.rice.edu](https://canvas.rice.edu) and reload. For the flashcards,
   open your Esther class roster (`esther.rice.edu/selfserve/swkrost.main`).

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
  dashboard/dashboard.js        builds the grouped course list
  dashboard/dashboard.css       list styling
  tray/course-tray.js           regroups the "Courses" sidebar tray
  tray/course-tray.css          tray list styling
  files/column-resize.js        drag-resizable Files-page columns
  files/column-resize.css       handle styling + overflow scrolling
  flashcards/flashcards.js      name-flashcard deck on the Esther roster
  flashcards/flashcards.css     overlay / card / deck styling
```

## Notes & next steps

- Only `canvas.rice.edu` is wired up for the Canvas features. `courses.rice.edu`
  support is planned but not implemented yet.
- The "current vs. next" boundary uses an approximate calendar when Canvas does
  not expose real term dates. If a specific semester should land differently,
  the season date ranges are in `src/lib/terms.js` (`SEASONS`).
