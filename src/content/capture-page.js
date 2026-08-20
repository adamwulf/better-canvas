// Better Canvas — freeze-dry capture (runs in the page context)
//
// Injected on demand into the active tab to serialize the LIVE DOM into one
// self-contained static .html via the vendored WebMemex freeze-dry bundle, then
// hand that file to the user as a download. CSS, images, and fonts are inlined as
// data: URIs and scripts are stripped, so the saved page opens offline in any
// browser with no network and no JavaScript. Eligible <img>/<picture> jpeg/png
// images are re-encoded as webp at natural size on the way in (shared
// BCImageOptimizer, mirroring Allume) when that saves enough bytes.
//
// Because scripts are stripped, the saved DOM must already carry the page's
// current visual state. freeze-dry serializes each <style> by its text, so rules
// that a runtime engine (Emotion, styled-components, adopted stylesheets) injects
// straight into the CSSOM — leaving the <style> element empty — would be lost, and
// components styled that way (e.g. an open sidebar/tray) collapse. We snapshot the
// live CSSOM and re-materialize it onto the clone; see snapshotCssomStyles /
// materializeCssom.
//
// Injected as a single file via chrome.scripting.executeScript({ files: [...] }).
// The whole file is one self-invoking async IIFE, so the injection's completion
// value IS the returned Promise — the popup awaits it and reads results[0].result.
// (Chrome awaits a files: injection's returned Promise; this extension is
// Chrome-only, so the simpler single-injection form is enough.)
//
// The download is triggered HERE, in the page, rather than in the service worker:
// URL.createObjectURL is unavailable in an MV3 service worker, and an in-page
// blob download needs no "downloads" permission and keeps working even if the
// popup is closed before the (possibly slow) capture finishes.

(async function betterCanvasFreezeDryCapture() {
  "use strict";

  const FREEZE_DRY_VERSION = "freeze-dry@1.0.0";
  const CAPTURE_META_NAME = "better-canvas-capture";
  const FREEZE_DRY_TIMEOUT_MS = 30000; // freeze-dry's own crawl budget
  const HARD_DEADLINE_MS = 90000; // backstop: one dead sub-resource must not hang forever

  // Build capture metadata at function scope so the dryResource callback below —
  // which freeze-dry invokes on the CLONE — can close over it and stamp a small,
  // self-describing meta tag into the saved file.
  const capturedAt = new Date();
  const metadata = {
    v: 1,
    url: document.URL,
    title: document.title,
    capture_ts: capturedAt.toISOString(),
    freeze_dry_version: FREEZE_DRY_VERSION
  };

  // The host of the page being captured, sent with every sub-resource fetch so
  // the worker's SSRF guard can tell a capture of a local page (whose own local
  // sub-resources are legitimate) from a public page reaching at internal hosts.
  const pageHost = location.hostname;

  // Shared Allume-mirrored image optimizer (src/lib/image-optimizer.js), which
  // the popup injects before this script. Eligible <img>/<picture> images are
  // re-encoded as webp at their NATURAL size before inlining — never resized,
  // because intrinsic raster size participates in layout when the archive
  // reloads. CSS background images are inlined untouched, like Allume. If the
  // lib is missing (this script injected on its own), captures simply skip
  // the optimization.
  const imageOptimizer =
    typeof BCImageOptimizer === "object" && BCImageOptimizer !== null
      ? BCImageOptimizer
      : null;
  const optimizableImageUrls = imageOptimizer
    ? imageOptimizer.buildEligibleImageUrlSet(document)
    : null;

  // Aborting this stops freeze-dry's crawl if the hard deadline fires; freeze-dry
  // threads the signal into fetchResource so no new sub-resource fetches start.
  const captureController = new AbortController();

  // The live-CSSOM snapshot, assigned just before freeze-dry clones (see below).
  // Declared at function scope — NOT inside the try — so the dryResource callback,
  // itself a function-scope declaration freeze-dry invokes during the crawl, can
  // close over it. A const inside the try would be block-scoped and invisible to
  // dryResource, raising "cssomSnapshot is not defined" when the crawl runs.
  let cssomSnapshot = null;

  try {
    const freezeDryModule = await import(
      chrome.runtime.getURL("src/vendor/freeze-dry.js")
    );
    const freezeDry =
      freezeDryModule.freezeDry ||
      freezeDryModule.default?.freezeDry ||
      freezeDryModule.default?.default ||
      freezeDryModule.default;

    if (typeof freezeDry !== "function") {
      throw new Error("The vendored freeze-dry function could not be loaded.");
    }

    // Snapshot the CSSOM before freeze-dry clones the live document. Runtime
    // styling engines (Emotion, styled-components) and constructable/adopted
    // stylesheets inject their rules straight into a sheet via insertRule, so the
    // owning <style> element serializes EMPTY — its rules live only in
    // sheet.cssRules, which freeze-dry never reads. We capture that text now, from
    // the live sheets that are the source of truth, and re-materialize it onto the
    // clone in dryResource. Taken here, before the clone, so element order still
    // matches what freeze-dry will clone. See materializeCssom. Assigns the
    // function-scope binding declared above so dryResource can read it.
    cssomSnapshot = snapshotCssomStyles();

    const html = await withHardDeadline(
      freezeDry(document, {
        now: capturedAt,
        dryResource: dryResource,
        fetchResource: fetchResource,
        signal: captureController.signal,
        timeout: FREEZE_DRY_TIMEOUT_MS
      }),
      HARD_DEADLINE_MS,
      function () {
        captureController.abort();
      }
    );

    const filename = makeFilename(document.title, location.hostname);
    // True byte size (UTF-8), not html.length (UTF-16 code units).
    const blob = new Blob([html], { type: "text/html" });
    const byteSize = blob.size;

    triggerDownload(blob, filename);

    return {
      ok: true,
      filename: filename,
      bytes: byteSize
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  // --- Save the finished snapshot -----------------------------------------

  // Download the blob from the page via a throwaway <a download>. This happens
  // AFTER freeze-dry has already cloned the DOM, so the anchor never appears in
  // the saved file. URL.createObjectURL is available in this (content-script)
  // context, unlike in the service worker.
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Give the browser a moment to start the download before releasing the URL.
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 60000);
  }

  // --- freeze-dry callbacks ------------------------------------------------

  // Runs for every resource freeze-dry processes, on the CLONE (resource.doc),
  // never the live page. For the root document we stamp a small self-describing
  // meta tag; for every document we drop non-archival resource hints.
  function dryResource(resource, isRootDocument) {
    resource.dry();

    if (!resource.doc) {
      return;
    }

    if (isRootDocument) {
      let head = resource.doc.head;
      if (!head) {
        head = resource.doc.createElement("head");
        resource.doc.documentElement.insertBefore(
          head, resource.doc.documentElement.firstChild
        );
      }
      const meta = resource.doc.createElement("meta");
      meta.setAttribute("name", CAPTURE_META_NAME);
      // Built with DOM APIs so the JSON content is quote-escaped on serialize.
      meta.setAttribute("content", JSON.stringify(metadata));
      head.appendChild(meta);

      // Re-inject the runtime-only CSS captured from the live CSSOM (Emotion,
      // styled-components, adopted stylesheets) that would otherwise be lost.
      // Root document only: cssomSnapshot describes the top document, so applying
      // it to a nested frame's <style> elements would be wrong.
      materializeCssom(resource.doc, cssomSnapshot);
    }

    // Preload/prefetch/etc. hints describe a live network the archive can't use.
    const nonArchivalRelations = new Set([
      "dns-prefetch", "manifest", "modulepreload",
      "preconnect", "prefetch", "preload", "prerender"
    ]);
    for (const link of resource.doc.querySelectorAll("link[rel]")) {
      const relations = link.rel.toLowerCase().split(/\s+/);
      if (relations.some(function (relation) {
        return nonArchivalRelations.has(relation);
      })) {
        link.remove();
      }
    }
  }

  // A content script cannot fetch cross-origin sub-resources — CORS blocks the
  // read. So every http(s) sub-resource is fetched through the service worker,
  // which carries the extension's host permission and bypasses CORS. Non-http(s)
  // URLs (data:, blob:, etc.) are fetched directly.
  async function fetchResource(resourceUrl, options = {}) {
    const url = new URL(resourceUrl, location.href);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      if (!imageOptimizer || !optimizableImageUrls.has(url.href)) {
        return fetch(url.href, options);
      }
      const directResponse = await fetch(url.href, options);
      const directBlob = await directResponse.blob();
      return {
        blob: await optimizeIfSmaller(directBlob),
        url: directResponse.url || url.href
      };
    }
    if (options.signal?.aborted) {
      throw new DOMException("The capture was aborted.", "AbortError");
    }

    const response = await chrome.runtime.sendMessage({
      command: "BC_FETCH_RESOURCE",
      url: url.href,
      pageHost: pageHost
    });

    if (!response?.ok) {
      throw new Error(response?.error || ("Could not fetch " + url.href));
    }

    let blob = new Blob([base64ToBytes(response.base64)], {
      type: response.contentType
    });
    if (imageOptimizer && optimizableImageUrls.has(url.href)) {
      blob = await optimizeIfSmaller(blob);
    }
    return {
      blob: blob,
      url: response.url
    };
  }

  // Natural size only (null renderedSize): a freeze-dried page reflows from
  // intrinsic image dimensions when it reloads. The optimizer is fail-soft and
  // returns null whenever the original should be kept.
  async function optimizeIfSmaller(blob) {
    const optimized = await imageOptimizer.optimizeImageBlob(blob, null);
    return optimized || blob;
  }

  // --- helpers -------------------------------------------------------------

  // Reject if the capture has not settled by deadlineMs, so a single dead
  // sub-resource cannot keep the whole crawl open indefinitely (gotcha: freeze-
  // dry awaits every in-flight sub-resource promise). onTimeout aborts the crawl.
  function withHardDeadline(promise, deadlineMs, onTimeout) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        if (onTimeout) {
          try {
            onTimeout();
          } catch (error) {
            /* aborting is best-effort */
          }
        }
        reject(new Error("Freeze-dry timed out after " + deadlineMs + " ms."));
      }, deadlineMs);
      promise.then(
        function (value) { clearTimeout(timer); resolve(value); },
        function (error) { clearTimeout(timer); reject(error); }
      );
    });
  }

  // --- CSSOM materialization ----------------------------------------------

  // Serialize a live CSSStyleSheet back to CSS text from its cssRules — the
  // authoritative record of what the browser applies, reflecting the original
  // text PLUS any runtime insertRule/deleteRule/mutation. Returns null for a
  // cross-origin sheet (reading cssRules throws SecurityError), an empty sheet, or
  // a DISABLED sheet — its rules are not applied on the live page, so re-emitting
  // them active would add styling the user does not see. In each case we leave
  // freeze-dry's default handling untouched.
  function serializeSheetToCss(sheet) {
    if (sheet.disabled) {
      return null;
    }
    try {
      const rules = sheet.cssRules;
      if (!rules || rules.length === 0) {
        return null;
      }
      let css = "";
      for (const rule of rules) {
        css += rule.cssText + "\n";
      }
      return css;
    } catch (error) {
      return null; // cross-origin sheet: not readable, fetched by freeze-dry instead
    }
  }

  // Read the live document's CSSOM once, before freeze-dry clones it. styleTexts
  // is aligned by index with document.querySelectorAll("style") so the clone's
  // <style> elements (same order) can be matched positionally. adopted holds the
  // serialized constructable stylesheets, which have no backing element at all.
  // Limitation (c): only the top document's adoptedStyleSheets are read. A shadow
  // root's adopted sheets are skipped because freeze-dry does not capture shadow
  // DOM at all, so there is no cloned shadow tree to attach them to.
  function snapshotCssomStyles() {
    const styleTexts = [];
    for (const styleEl of document.querySelectorAll("style")) {
      styleTexts.push(styleEl.sheet ? serializeSheetToCss(styleEl.sheet) : null);
    }
    const adopted = [];
    for (const sheet of document.adoptedStyleSheets || []) {
      const css = serializeSheetToCss(sheet);
      if (css) {
        adopted.push(css);
      }
    }
    return { styleTexts: styleTexts, adopted: adopted };
  }

  // Write the snapshotted CSSOM text into the CLONE. We only fill a <style> whose
  // clone serialized EMPTY: a non-empty one was already captured — and had its
  // url()s rewritten to data: URIs — by freeze-dry's crawl, so overwriting it
  // would REGRESS a page that works today. That "fill only the empty ones" seam is
  // exactly the set of sheets freeze-dry loses (rules injected via the CSSOM, not
  // present in the element's text). Positional match by index; if the live DOM
  // mutated between snapshot and clone the counts diverge, and we skip rather than
  // risk mis-pairing.
  // Limitation (a): url()/@font-face assets referenced only by these materialized
  //   rules are not re-crawled (this runs after freeze-dry's crawl), so such sub-
  //   resources stay as URLs; layout and color rules inline fine.
  // Limitation (b): the mixed case — a <style> with authored text that ALSO had
  //   rules added later via insertRule — keeps only the authored text. Its clone
  //   serialized non-empty, so fill-only-empty skips it; recovering just the extra
  //   rules would risk clobbering the url()s freeze-dry already inlined there.
  function materializeCssom(cloneDoc, snapshot) {
    const cloneStyles = cloneDoc.querySelectorAll("style");
    if (cloneStyles.length === snapshot.styleTexts.length) {
      cloneStyles.forEach(function (styleEl, index) {
        const css = snapshot.styleTexts[index];
        if (css && styleEl.textContent.trim() === "") {
          styleEl.textContent = css;
        }
      });
    }
    // Adopted stylesheets have no <style> of their own; emit fresh ones. They
    // apply after the document's author sheets; appending at the end of <head> is
    // an approximation of that cascade position — faithful unless an author <style>
    // in <body> was meant to sit between the two, which is uncommon.
    if (snapshot.adopted.length > 0) {
      const head = cloneDoc.head || cloneDoc.documentElement;
      for (const css of snapshot.adopted) {
        const styleEl = cloneDoc.createElement("style");
        styleEl.setAttribute("data-freezedry-adopted", "");
        styleEl.textContent = css;
        head.appendChild(styleEl);
      }
    }
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function makeFilename(title, hostname) {
    const base = (title || hostname || "saved-page")
      .normalize("NFKC")
      .replace(/[<>:"/\\|?* -]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "")
      .slice(0, 120);
    return (base || "saved-page") + ".html";
  }
})()
