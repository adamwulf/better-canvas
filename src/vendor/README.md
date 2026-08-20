# Vendored bundles

All third-party code the extension executes lives here, committed as-is — this
repo has no build step and nothing is loaded from a CDN at runtime.

## `freeze-dry.js`

A browser-ready, self-contained bundle of
[WebMemex/freeze-dry](https://github.com/WebMemex/freeze-dry) `@1.0.0` and all of
its runtime dependencies, so the extension executes no remotely hosted code. It
turns the live DOM into one self-contained static `.html` (CSS, images, and fonts
inlined as data URIs; scripts removed). Upstream freeze-dry is released under the
Unlicense.

This file is copied verbatim from the Allume browser extension
(`muse-browserext`), which built it with esbuild (`format: esm`, `minify`,
`target: chrome120`).

### `process` shim (required)

The first lines of `freeze-dry.js` are a small `process` shim. The bundle pulls
in Node's postcss/`util` code, which references `process.env.LANG`,
`process.nextTick`, `process.pid`, etc. **unguarded**. In a browser / MV3 content
script `process` is undefined, so freeze-dry throws `ReferenceError: process is
not defined` the moment it parses a stylesheet. The shim defines a stub
`globalThis.process` and fixes it.

**If you replace the bundle**, re-prepend the same shim block (or bake it into the
esbuild build with `inject:` or a `banner`) — otherwise the ReferenceError
returns.

### How it is loaded

`src/content/capture-page.js` loads the bundle as an ES module via
`import(chrome.runtime.getURL("src/vendor/freeze-dry.js"))`, so the file must stay
listed under `web_accessible_resources` in `manifest.json`. The bundle exports
`{ default, freezeDry }`.

## `readability.js`, `turndown.js`, `turndown-plugin-gfm.js`

The Markdown export's extractor and converter, each downloaded verbatim from
unpkg (no modifications):

| File | Package | Version | License | Source |
|---|---|---|---|---|
| `readability.js` | `@mozilla/readability` | 0.6.0 | Apache-2.0 | `unpkg.com/@mozilla/readability@0.6.0/Readability.js` |
| `turndown.js` | `turndown` | 7.2.4 | MIT | `unpkg.com/turndown@7.2.4/dist/turndown.js` |
| `turndown-plugin-gfm.js` | `turndown-plugin-gfm` | 1.0.2 | MIT | `unpkg.com/turndown-plugin-gfm@1.0.2/dist/turndown-plugin-gfm.js` |

### How they are loaded

Unlike freeze-dry these are **classic scripts**, not ES modules — each defines a
plain global (`Readability`, `TurndownService`, `turndownPluginGfm`). The popup
injects them with `chrome.scripting.executeScript({ files: [...] })` into the
active tab, then injects `src/content/export-markdown.js` in a second call; both
land in the extension's isolated world for the tab, where globals persist across
calls. Because they are injected (never fetched by the page), they do **not**
need a `web_accessible_resources` entry.

**If you upgrade them**, keep the same download sources, update the version
table above, and re-check that each file still defines its global when run as a
classic script (Readability's file, for instance, is a bare
`function Readability(...)` plus a CommonJS guard that stays inert in the
browser).
