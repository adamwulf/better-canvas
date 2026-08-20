// Better Canvas — freeze-dry capture (runs in the page context)
//
// Injected on demand into the active tab to serialize the LIVE DOM into one
// self-contained static .html via the vendored WebMemex freeze-dry bundle, then
// hand that file to the user as a download. CSS, images, and fonts are inlined as
// data: URIs and scripts are stripped, so the saved page opens offline in any
// browser with no network and no JavaScript.
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

  // Aborting this stops freeze-dry's crawl if the hard deadline fires; freeze-dry
  // threads the signal into fetchResource so no new sub-resource fetches start.
  const captureController = new AbortController();

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
      return fetch(url.href, options);
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

    return {
      blob: new Blob([base64ToBytes(response.base64)], {
        type: response.contentType
      }),
      url: response.url
    };
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
