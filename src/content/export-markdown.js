// Better Canvas — Markdown export (runs in the page context)
//
// Injected on demand into the active tab AFTER the vendored readability.js,
// turndown.js, and turndown-plugin-gfm.js classic scripts (the popup injects
// those first, into the same isolated world), so this file can assume the
// Readability / TurndownService / turndownPluginGfm globals exist.
//
// The page's readable article is extracted with Readability and converted to
// GitHub-flavored Markdown with Turndown. When Readability finds no real
// article (a company homepage, a dashboard, …) the WHOLE page body is converted
// instead — stripped of scripts/styles/hidden chrome — so the export never
// comes back empty.
//
// Images are inlined as data: URIs by fetching each one through the service
// worker (the same BC_FETCH_RESOURCE proxy + SSRF guard freeze-dry uses), so
// the .md is self-contained even for images behind the user's login. Each one
// runs through the shared Allume-mirrored optimizer (BCImageOptimizer):
// jpeg/png re-encodes as webp @0.82 and is kept only when it saves enough;
// everything else (gif, svg, webp, …) keeps its original bytes. Unlike
// freeze-dry — where intrinsic image size participates in layout when the
// archive reloads — Markdown has no such dependency, so this flow also
// downscales to the image's rendered size on the page (CSS px ×
// devicePixelRatio, capped at 2, never upscaled) before encoding. The base64
// blobs are emitted as reference-style definitions at the BOTTOM of the file
// so the Markdown body stays human-readable; an image that cannot be fetched
// keeps its absolute remote URL instead.
//
// Injected as a single file via chrome.scripting.executeScript({ files: [...] }).
// The whole file is one self-invoking async IIFE, so the injection's completion
// value IS the returned Promise — the popup awaits it and reads results[0].result.
// The download is triggered here, in the page, for the same reasons as in
// capture-page.js (no "downloads" permission, survives the popup closing).

(async function betterCanvasMarkdownExport() {
  "use strict";

  const MIN_ARTICLE_CHARS = 500; // below this, Readability's pick counts as "blank"
  const INLINE_DEADLINE_MS = 30000; // budget for the whole image-inlining phase
  const INLINE_MAX_BYTES = 8 * 1024 * 1024; // bigger images keep their remote URL
  // Placeholder scheme swapped into <img src> before Turndown runs; the regex in
  // referenceizeImages() below must match this prefix.
  const TOKEN_PREFIX = "bc-inline-img:";

  const pageHost = location.hostname;
  const capturedAt = new Date();

  try {
    if (
      typeof Readability !== "function" ||
      typeof TurndownService !== "function" ||
      typeof turndownPluginGfm !== "object" ||
      typeof BCImageOptimizer !== "object"
    ) {
      throw new Error(
        "The vendored Markdown libraries or the shared image optimizer could not be loaded."
      );
    }

    // Rendered sizes must be read off the LIVE document before any cloning —
    // they drive the Markdown-only downscale in the image optimizer.
    const renderedSizes = BCImageOptimizer.buildRenderedSizeMap(document);

    // --- 1. Try Readability on a clone (Readability mutates its input) ------
    let article = null;
    try {
      article = new Readability(cloneDocumentWithLiveImages()).parse();
    } catch (error) {
      article = null; // an unparseable page just falls back to full-page mode
    }
    const articleText =
      article && article.textContent ? article.textContent.trim() : "";
    const useArticle = articleText.length >= MIN_ARTICLE_CHARS;

    // --- 2. Build the DOM container to convert ------------------------------
    let container;
    let title = "";
    if (useArticle) {
      // article.content is an HTML string whose URLs Readability already made
      // absolute (and whose lazy-loaded images it already fixed).
      const parsed = new DOMParser().parseFromString(
        article.content,
        "text/html"
      );
      container = parsed.body;
      title = (article.title || "").trim();
    } else {
      const clone = cloneDocumentWithLiveImages();
      container = clone.body || clone.documentElement;
      stripNonContent(container);
      absolutizeUrls(container);
    }
    if (!title) {
      title = (document.title || "").trim() || location.hostname;
    }

    // --- 3. Inline images as data: URIs, behind placeholder tokens ---------
    const imageStats = { inlined: 0, total: 0 };
    const imageRefs = await inlineImages(container, imageStats, renderedSizes);

    // --- 4. Convert to Markdown ---------------------------------------------
    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      hr: "---",
      bulletListMarker: "-"
    });
    turndown.use(turndownPluginGfm.gfm);
    turndown.remove(["script", "style", "noscript", "template"]);
    const body = turndown.turndown(container);

    const byline =
      useArticle && article.byline ? String(article.byline).trim() : "";
    const markdown = composeDocument(body, imageRefs, title, byline);

    // --- 5. Download ---------------------------------------------------------
    const filename = makeFilename(title, location.hostname);
    const blob = new Blob([markdown], { type: "text/markdown" });
    triggerDownload(blob, filename);

    return {
      ok: true,
      filename: filename,
      bytes: blob.size,
      mode: useArticle ? "article" : "page",
      imagesInlined: imageStats.inlined,
      imagesTotal: imageStats.total
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  // --- document assembly ----------------------------------------------------

  // Title heading, a small provenance list, a rule, the converted body, then
  // the data: URI reference definitions (kept at the bottom so the body stays
  // readable in a text editor). Only refs actually used by the body are kept.
  function composeDocument(body, imageRefs, title, byline) {
    const swapped = referenceizeImages(body, imageRefs);

    const header = ["# " + title];
    header.push("");
    header.push("- Source: <" + document.URL + ">");
    if (byline) {
      header.push("- Author: " + byline);
    }
    header.push("- Captured: " + capturedAt.toISOString());

    let markdown =
      header.join("\n") + "\n\n---\n\n" + swapped.body.trim() + "\n";
    if (swapped.refs.length > 0) {
      markdown += "\n" + swapped.refs.join("\n") + "\n";
    }
    return markdown;
  }

  // Replace every `![alt](bc-inline-img:N)` with `![alt][imgN]` and build the
  // matching `[imgN]: data:…` definition list, dropping refs Turndown never
  // emitted (e.g. an image that collapsed away with its hidden parent).
  function referenceizeImages(body, imageRefs) {
    const seen = new Set();
    const replaced = body.replace(
      /\]\(bc-inline-img:(\d+)\)/g,
      function (match, num) {
        seen.add(Number(num));
        return "][img" + num + "]";
      }
    );
    const refs = [];
    for (const entry of imageRefs) {
      if (seen.has(entry[0])) {
        refs.push("[img" + entry[0] + "]: " + entry[1]);
      }
    }
    return { body: replaced, refs: refs };
  }

  // --- image inlining -------------------------------------------------------

  // Group the container's <img> elements by (absolute) source URL, fetch each
  // unique URL once, optimize it (shared Allume pipeline + rendered-size
  // downscale), and swap successful ones to placeholder tokens that map to
  // data: URIs. Failures, over-size images, and non-image responses keep their
  // remote URL — the export must degrade, never fail, on a bad image.
  async function inlineImages(container, stats, renderedSizes) {
    const groups = new Map(); // absolute URL → { dataUri, imgs: [] }

    for (const img of container.querySelectorAll("img")) {
      const raw = img.getAttribute("src");
      if (!raw) {
        continue;
      }
      let url;
      try {
        url = new URL(raw, document.baseURI);
      } catch (error) {
        continue;
      }
      const isDataImage =
        url.protocol === "data:" && /^data:image\//i.test(url.href);
      const isFetchable =
        url.protocol === "http:" ||
        url.protocol === "https:" ||
        url.protocol === "blob:";
      if (!isDataImage && !isFetchable) {
        continue;
      }
      stats.total += 1;
      let group = groups.get(url.href);
      if (!group) {
        group = { url: url, dataUri: null, imgs: [] };
        groups.set(url.href, group);
      }
      group.imgs.push(img);
    }

    await Promise.all(
      Array.from(groups.values()).map(async function (group) {
        group.dataUri = await raceDeadline(
          fetchImageAsDataUri(group.url, renderedSizes.get(group.url.href)),
          INLINE_DEADLINE_MS,
          null
        );
        // A data: src is already inline — if fetching/optimizing it failed,
        // fall back to the original URI rather than leaving it in the body.
        if (!group.dataUri && group.url.protocol === "data:") {
          group.dataUri = group.url.href;
        }
      })
    );

    const refs = new Map(); // token number → data: URI
    let nextToken = 0;
    for (const group of groups.values()) {
      if (!group.dataUri) {
        continue;
      }
      const token = nextToken;
      nextToken += 1;
      refs.set(token, group.dataUri);
      for (const img of group.imgs) {
        img.setAttribute("src", TOKEN_PREFIX + token);
        // Turndown appends title/srcset details we can't carry through the
        // token swap; drop them so the emitted form is exactly ![alt](token).
        img.removeAttribute("title");
        img.removeAttribute("srcset");
        stats.inlined += 1;
      }
    }
    return refs;
  }

  // http(s) images go through the service worker (extension host permission +
  // SSRF guard, same as freeze-dry); blob: and data: URLs belong to this page
  // and are fetched directly. The blob then runs through the shared optimizer
  // (webp-or-original, downscaled to renderedSize — the Markdown-only
  // divergence from Allume). Returns a data: URI, or null for anything
  // unusable.
  async function fetchImageAsDataUri(url, renderedSize) {
    try {
      let blob;
      if (url.protocol === "blob:" || url.protocol === "data:") {
        blob = await (await fetch(url.href)).blob();
      } else {
        const response = await chrome.runtime.sendMessage({
          command: "BC_FETCH_RESOURCE",
          url: url.href,
          pageHost: pageHost
        });
        if (!response || !response.ok || !response.base64) {
          return null;
        }
        blob = new Blob([BCImageOptimizer.base64ToBytes(response.base64)], {
          type: BCImageOptimizer.normalizeMime(response.contentType)
        });
      }

      const originalMime = BCImageOptimizer.normalizeMime(blob.type);
      if (!originalMime.startsWith("image/")) {
        return null;
      }
      const optimized = await BCImageOptimizer.optimizeImageBlob(
        blob,
        renderedSize || null
      );
      let chosen = optimized || blob;
      if (chosen.size > INLINE_MAX_BYTES) {
        return null;
      }
      // FileReader stamps blob.type into the data: URI verbatim; re-wrap if it
      // carries parameters that would break a Markdown link destination.
      if (BCImageOptimizer.normalizeMime(chosen.type) !== chosen.type) {
        chosen = new Blob([chosen], {
          type: BCImageOptimizer.normalizeMime(chosen.type) || originalMime
        });
      }
      return await BCImageOptimizer.blobToDataUri(chosen);
    } catch (error) {
      return null;
    }
  }

  // --- full-page fallback cleanup -------------------------------------------

  // Drop elements that can never contribute to Markdown (code, styling, frames,
  // media chrome) plus anything the page itself marks as hidden. Nav/footer
  // link lists are deliberately KEPT — in fallback mode the user asked for the
  // whole page.
  function stripNonContent(container) {
    const selector = [
      "script", "style", "noscript", "template", "iframe", "frame",
      "object", "embed", "canvas", "audio", "video", "svg", "math",
      "link", "meta", "dialog", "[hidden]", '[aria-hidden="true"]'
    ].join(", ");
    for (const node of container.querySelectorAll(selector)) {
      node.remove();
    }
  }

  // Readability absolutizes URLs for the article path; the fallback path must
  // do it itself so links and images survive outside the page's base URL.
  function absolutizeUrls(container) {
    for (const anchor of container.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href");
      try {
        const url = new URL(href, document.baseURI);
        if (url.protocol === "javascript:") {
          anchor.removeAttribute("href"); // Turndown then keeps just the text
        } else {
          anchor.setAttribute("href", url.href);
        }
      } catch (error) {
        anchor.removeAttribute("href");
      }
    }
    for (const img of container.querySelectorAll("img[src]")) {
      try {
        img.setAttribute(
          "src",
          new URL(img.getAttribute("src"), document.baseURI).href
        );
      } catch (error) {
        img.removeAttribute("src");
      }
    }
  }

  // --- helpers -------------------------------------------------------------

  // Clone the whole document, then copy each live image's currentSrc onto its
  // clone: currentSrc reflects the srcset candidate / lazy-loaded URL actually
  // rendered, and it is lost by a plain cloneNode. (document.images and
  // clone.images enumerate the same tree in the same order.)
  function cloneDocumentWithLiveImages() {
    const clone = document.cloneNode(true);
    const liveImages = document.images;
    const cloneImages = clone.images;
    if (
      liveImages && cloneImages &&
      liveImages.length === cloneImages.length
    ) {
      for (let i = 0; i < liveImages.length; i += 1) {
        if (liveImages[i].currentSrc) {
          cloneImages[i].setAttribute("src", liveImages[i].currentSrc);
        }
      }
    }
    return clone;
  }

  // Resolve to fallbackValue if the promise has not settled (or rejects)
  // within deadlineMs — a slow image must not stall the whole export.
  function raceDeadline(promise, deadlineMs, fallbackValue) {
    return new Promise(function (resolve) {
      const timer = setTimeout(function () {
        resolve(fallbackValue);
      }, deadlineMs);
      promise.then(
        function (value) { clearTimeout(timer); resolve(value); },
        function () { clearTimeout(timer); resolve(fallbackValue); }
      );
    });
  }

  // Same sanitization as capture-page.js, with a .md extension.
  function makeFilename(title, hostname) {
    const base = (title || hostname || "saved-page")
      .normalize("NFKC")
      .replace(/[<>:"/\\|?* -]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "")
      .slice(0, 120);
    return (base || "saved-page") + ".md";
  }

  // Identical to capture-page.js: download from the page via a throwaway
  // <a download>; the DOM was already cloned, so the anchor can't leak into
  // the export.
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
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 60000);
  }
})()
