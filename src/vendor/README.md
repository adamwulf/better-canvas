# Vendored freeze-dry bundle

`freeze-dry.js` is a browser-ready, self-contained bundle of
[WebMemex/freeze-dry](https://github.com/WebMemex/freeze-dry) `@1.0.0` and all of
its runtime dependencies, so the extension executes no remotely hosted code. It
turns the live DOM into one self-contained static `.html` (CSS, images, and fonts
inlined as data URIs; scripts removed). Upstream freeze-dry is released under the
Unlicense.

This file is copied verbatim from the Allume browser extension
(`muse-browserext`), which built it with esbuild (`format: esm`, `minify`,
`target: chrome120`). There is no build step in this repo — the bundle is
committed as-is.

## `process` shim (required)

The first lines of `freeze-dry.js` are a small `process` shim. The bundle pulls
in Node's postcss/`util` code, which references `process.env.LANG`,
`process.nextTick`, `process.pid`, etc. **unguarded**. In a browser / MV3 content
script `process` is undefined, so freeze-dry throws `ReferenceError: process is
not defined` the moment it parses a stylesheet. The shim defines a stub
`globalThis.process` and fixes it.

**If you replace the bundle**, re-prepend the same shim block (or bake it into the
esbuild build with `inject:` or a `banner`) — otherwise the ReferenceError
returns.

## How it is loaded

`src/content/capture-page.js` loads the bundle as an ES module via
`import(chrome.runtime.getURL("src/vendor/freeze-dry.js"))`, so the file must stay
listed under `web_accessible_resources` in `manifest.json`. The bundle exports
`{ default, freezeDry }`.
