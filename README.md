# Better Canvas (Rice)

A personal, unpacked Chrome extension with quality-of-life tweaks for
[canvas.rice.edu](https://canvas.rice.edu) and
[hq.globaltech.org](https://hq.globaltech.org) (a partner org's Canvas site that
hosts a Rice course), a Pangram AI-detection check in SpeedGrader, plus study
and photo-download tools on the Esther course roster. Built for personal use.

> The freeze-dry / Markdown "save this page" actions that used to live here have
> moved to a separate, standalone extension.

## Features

### 1. Custom tab favicon
Every Canvas tab (`canvas.rice.edu` or `hq.globaltech.org`) shows the bundled Canvas logo as its favicon, so
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

### 3. Semester on the course breadcrumb
On every course page that shows a breadcrumb, the course crumb at the top of
the page gets the course's semester, so `UNIV 285 901 > Assignments` reads
`UNIV 285 901 (Fall 2026) > Assignments`. The semester is the season + year of
the course's term (the full term name, such as `Fall Semester 2026 Full Term`,
is what Canvas shows above the course menu). A course whose term has no season
and year gets no label, and neither does a course whose name already contains
its semester.

### 4. Resizable columns on Files pages
On the course/group/user **Files** pages, every column header gets a thin
drag handle on its right edge. Drag it to resize the column — most usefully
to widen **Name** so long file names stop truncating. If the columns outgrow
the window, the table scrolls horizontally inside its own container.
Double-click a handle to hand that column's width back to Canvas.

Widths are deliberately session-only: they survive sorting and folder
navigation (both are client-side re-renders of the same page) but reset on
the next real page load. Nothing is persisted.

### 5. Name flashcards on the Esther course roster
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

### 6. Download student face photos

On the same Esther **Class Roster** page, **⬇ Download Face Photos** collects
every available roster photo into one `face-photos.zip` download. Each image is
converted to PNG and named in natural order, such as `First Last.png`.
Duplicate names receive a numeric suffix instead of overwriting one another.

The conversion and ZIP creation happen entirely in the browser. Photos are
fetched only from their existing roster URLs using the active Esther session;
nothing is uploaded to a service or sent to a third party. Students without a
photo and any failed downloads are reported after the remaining photos finish.

### 7. Pangram AI check in SpeedGrader

In SpeedGrader, a **Pangram** box appears in the grading panel under the
submission details. **Check with Pangram** checks the student on screen with
[Pangram](https://www.pangram.com)'s AI-detection API:

1. The submission text is read in the browser: a text entry, or each PDF,
   Word (`.docx`), or `.txt` file. Other files (images, old `.doc` files) are
   listed as skipped. A scanned PDF with no text layer has no text to check.
2. Every student name on the course roster is replaced with `[name]`, every
   roster NetID (the Canvas login ID, such as `jd45`; for a login ID in email
   form, its part before the `@`) with `[netid]`, and every email address
   with `[email]`.
3. A dialog shows the exact redacted text, how many names, NetIDs, and email
   addresses were replaced, and the word count. **Nothing is sent until you
   click Send to Pangram.** If Canvas does not share the roster's login IDs
   with you, the dialog says that NetIDs were not replaced.
4. The result shows in the dialog — Pangram's verdict (AI / Mixed / Human),
   the AI, AI-assisted, and human percentages, and the text colored by
   segment — and as a one-line summary in the grading panel.

Name matching covers each roster name, its sortable form (`Doe, Jane`), its
short name, its shorter forms (`Jane Doe` for `Jane Q. Doe`, `Maria Garcia`
for `Maria Garcia Lopez`, `Ana da Silva` for `Ana Maria Da Silva`, `Kevin Le`
for `Kevin Minh Le`, `Ana García` for `Ana García-López`; a particle such as
`de` or `van` joins a form only with the word it belongs to), the surname
from the sortable form (`van der Berg`), and each part of two or more letters
(`Jane`, `Doe`, the halves of `Mary-Jane`, a nickname such as `David` in
`Wei (David) Zhang`) except a particle that the roster writes in lowercase
inside the name, such as the `van` of `Anna van der Berg` or the `al` of
`Omar al-Farsi` (a capitalized one, such as the `Le` of `Jia Le Chen`, is
kept, since it can be a real name syllable). A hyphen in a name also matches
a space or nothing, so `Do-Hyun Kim` catches `Do Hyun Kim` and `Dohyun Kim`,
and `Smith-Jones` catches a lowercase `smith jones` (only when each half has
3 or more letters, so `In-Young` never turns the phrase `in young` into a
name). Accents and letters such as
ł, ø, and ß are ignored in both directions, so a roster spelling of
`Jose Nunez` also catches `José Núñez`, and `Müller` also catches `Mueller`
(and the reverse). Full-width letters and ligatures are read as plain
letters, the ʻokina counts as an apostrophe, an apostrophe may be left out
(`OBrien` for `O'Brien`), and the words of a whole name (and the halves of a
hyphenated one) may be joined by an underscore, a dot, or nothing
(`Jane_Doe`, `jane.doe`, `maria_garcia_lopez`, `JaneDoe`, `@janedoe`,
`DeLaCruz`, `Jimin` for `Ji Min Park`, `Subin` for `Su Bin Park`). A joined
name in all lowercase needs 6 or more letters (so `anle` is not taken for a
word), and it is not replaced when it is only the two halves of one
hyphenated name, which may be an ordinary word (`wanting` for `Wan-Ting`;
`Wanting` with a capital is still replaced). A whole
name (two or more words) matches in any case, such as `jane doe`. A single
word must have a capital letter (`Doe`, `DOE`, `deWitt`) or be in a script
with no letter case, so ordinary lowercase words stay intact when a student
is named Will, May, or Rose, or has a particle such as `de` or `al` in their
name; suffixes such as `Jr` and `III` are never replaced alone. Privacy comes
first: a name part that is also a common capitalized word (`He` or `An` as a
surname, `In` or `Do` as a name syllable) is replaced wherever it is
capitalized, so in a course with a student named He, a sentence that starts
"He grew up…" also becomes "[name] grew up…". A lowercase
name inside an email address is covered because the whole address is
replaced. The preview dialog reminds you to read the text for any other form
of a name (a lowercase nickname or user name) before you send.

Results are kept only until the page reloads. The check always reads the
student's latest attempt.

**Setup:** make an API key in your Pangram account, then open the extension's
**Details → Extension options** on `chrome://extensions` and save the key. It
is stored only in this browser. Each check uses Pangram API credits.

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

- **Course breadcrumb semester** — a content script
  (`src/breadcrumbs/semester-crumb.js`, on `/courses/*` pages) first skips a
  page with no breadcrumb link to the course home (SpeedGrader, for example,
  has no breadcrumb). Otherwise it reads the term name from the course menu's
  subtitle (`#section-tabs-header-subtitle`). A course menu with no subtitle
  means the course has no named term. Only on a page with no course menu does
  it ask `GET /api/v1/courses/:id?include[]=term` instead. `parseTerm` (in
  `src/lib/terms.js`) turns the name into the season + year label, and the
  script appends that label in its own `<span>` inside the breadcrumb link to
  the course home (`#breadcrumbs a` whose path is `/courses/:id`), unless the
  course name already contains the label. Canvas re-renders the breadcrumb
  client-side on some pages (Files folder navigation, for example), so a
  `MutationObserver` puts the label back when it disappears.

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

- **Roster tools** — a content script (`src/flashcards/flashcards.js`, on
  the Esther `…/swkrost*` roster page only) reads each student from
  `<table class="reporttable">`, locating the **Photo**, **Name**, and **Name
  Pronunciation** columns by their header text so a column reorder cannot break
  it. Both roster-tool buttons are inserted before `input[name="p_download"]`.
  When a card is dealt, the student's photo `<img>` and the NameCoach `<iframe>` are
  cloned straight out of the page onto the card, so the real pronunciation play
  button keeps working without the script reaching into a cross-origin `data:`
  iframe. For a photo download, the script fetches the roster image with the
  existing Esther session, converts it to PNG on a browser canvas, and writes a
  standards-compliant ZIP locally. The overlay, deck, flip, scoring, download,
  and ZIP logic are all in that one file; its styling is in
  `src/flashcards/flashcards.css`.

- **Pangram check** — a content script (`src/speedgrader/pangram.js`, on
  `/courses/*/gradebook/speed_grader*` only) adds its section after the last
  submission-details block of the React SpeedGrader grading panel (the file
  list, else the word count, else the "Submitted:" line). A
  `MutationObserver` and the Navigation API's `currententrychange` event keep
  it there and in step with the `student_id` in the URL as SpeedGrader
  switches students, and each of its buttons reads the URL again before it
  acts, so it never checks a student who is no longer on screen. The submission is shown in Canvas
  DocViewer, a cross-origin iframe that draws each page, so the script does
  not read the page. It asks Canvas for the submission instead
  (`GET /api/v1/courses/:id/assignments/:id/submissions/:user_id?include[]=user`,
  or `…/anonymous_submissions/:anonymous_id` for anonymous grading) and
  downloads each attachment from its Canvas URL. `src/speedgrader/submission-text.js`
  turns that into plain text: DOMParser for the text-entry HTML; for `.docx`,
  a small ZIP reader plus the browser's `DecompressionStream` to get
  `word/document.xml`, then a walk of its `w:t` runs (skipping deleted text,
  field codes, and the duplicate fallback copy of text boxes); for `.pdf`,
  the bundled [pdf.js](https://mozilla.github.io/pdf.js/) (`vendor/pdfjs`, the
  pdfjs-dist 6.3.289 legacy build, whose polyfills cover the newest JavaScript
  features pdf.js uses; loaded only when a PDF is checked, and parsed on the
  page thread because a worker from the extension would be cross-origin). A
  `.docx` whose document text would expand past 50 MB is refused.
  The roster comes from
  `GET /api/v1/courses/:id/users?enrollment_type[]=student` (all enrollment
  states, every page), with each student's `login_id` (the NetID) when
  Canvas includes it, and `src/lib/redact.js` replaces names, NetIDs, and
  email addresses. If the roster cannot load, the check stops and nothing is
  sent.
  After you click **Send to Pangram**, the redacted text goes to the
  background service worker (`src/background/service-worker.js`), which calls
  `POST https://text.external-api.pangram.com/task` with the saved key and
  then `GET /task/:id` once per content-script message until the task
  finishes. The key stays in `chrome.storage.local`, which the worker limits
  to extension pages; the options page (`src/options/`) saves or removes it.

The Canvas features send only same-origin requests to the Canvas site you are
on (`canvas.rice.edu` or `hq.globaltech.org`) using your existing session
(Canvas may redirect a file download to its own file store). The roster
flashcards send no network requests at all; the face-photo downloader requests
only the image URLs already present on the Esther roster, using your existing
session. The one exception to "no third party" is the Pangram check: when you
click **Send to Pangram**, and only then, the redacted text you see in the
preview goes to Pangram's API. No student name, file, file name, or Canvas ID
is sent with it.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and choose this folder.
4. Open [canvas.rice.edu](https://canvas.rice.edu) or
   [hq.globaltech.org](https://hq.globaltech.org) and reload. For the roster
   tools, open your Esther class roster (`esther.rice.edu/selfserve/swkrost.main`).
5. For the Pangram check, click **Details → Extension options** on the
   extension card and save your Pangram API key.

After editing any file, return to `chrome://extensions` and click the reload
icon on the extension card, then reload the Canvas tab.

## Project layout

```
manifest.json                   MV3 manifest
icons/                          extension icons (16 / 48 / 128)
assets/                         tab favicon PNGs (16 / 32 / 48)
vendor/pdfjs/                   pdf.js 6.3.289 legacy build + LICENSE (PDF text)
src/
  favicon/favicon.js            swaps the tab favicon
  lib/terms.js                  term parsing (season/year/sub-term)
  lib/grouping.js               semester bucketing (next/current/previous/older)
  lib/redact.js                 replaces roster names, NetIDs, and emails in text
  dashboard/dashboard.js        builds the grouped course list
  dashboard/dashboard.css       list styling
  tray/course-tray.js           regroups the "Courses" sidebar tray
  tray/course-tray.css          tray list styling
  breadcrumbs/semester-crumb.js adds the semester to the course breadcrumb
  files/column-resize.js        drag-resizable Files-page columns
  files/column-resize.css       handle styling + overflow scrolling
  flashcards/flashcards.js      flashcards + local face-photo ZIP download
  flashcards/flashcards.css     roster buttons + card/deck styling
  speedgrader/pangram.js        SpeedGrader Pangram section + dialog
  speedgrader/pangram.css       section + dialog styling
  speedgrader/submission-text.js  text from text entries, PDF, DOCX, TXT
  background/service-worker.js  holds the API key, calls the Pangram API
  options/                      options page for the Pangram API key
tests/
  face-photo-download.test.js   filename and ZIP-format tests
  redact.test.js                name and email redaction tests
  submission-text.test.js       file-type and DOCX ZIP-reader tests
```

Run the tests with Node (`node tests/<name>.test.js`); the ZIP tests also use
the system `zip` and `unzip` tools.

## Notes & next steps

- The Canvas features are wired up for `canvas.rice.edu` and
  `hq.globaltech.org`. All Canvas API calls use relative paths, so adding
  another Canvas host only needs new `matches` patterns in `manifest.json`.
  `courses.rice.edu` support is planned but not implemented yet.
- Term grouping needs a season and a year in the term name (e.g. `Fall 2026`).
  A course whose term name has no season + year (or no term at all) always
  sorts under **Older**, even if Canvas exposes real term dates for it, and
  gets no semester label on its breadcrumb. If another Canvas site names its
  terms differently, teach `parseTerm` in `src/lib/terms.js` the new format.
- The "current vs. next" boundary uses an approximate calendar when Canvas does
  not expose real term dates. If a specific semester should land differently,
  the season date ranges are in `src/lib/terms.js` (`SEASONS`).
