// Better Canvas — Markdown export (runs in the page context)
//
// Injected on demand into the active tab AFTER the vendored readability.js,
// turndown.js, and turndown-plugin-gfm.js classic scripts (the popup injects
// those first, into the same isolated world), so this file can assume the
// Readability / TurndownService / turndownPluginGfm globals exist.
//
// A page that looks like a prose article (isProbablyReaderable) is extracted
// with Readability and converted to GitHub-flavored Markdown with Turndown.
// Everything else — a dashboard, a list, an app screen — takes the full-page
// path instead: the whole body is converted, but FIRST every element the
// browser does not actually render is dropped (display:none from ANY
// stylesheet, not just [hidden]), along with scripts/styles, navigation
// landmarks, and interactive chrome (buttons, menus, form controls). Exporting
// only what the reader can see keeps pop-up menus, off-screen panels, and
// hidden forms out of the Markdown, and the export never comes back empty.
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

  // Readerable classifier regexes (see isProbablyReaderable below). Declared here,
  // before the try block, because the article path calls isProbablyReaderable while
  // top-level execution is still inside that block — a `const` placed next to the
  // function would still be in its temporal dead zone at that point and throw
  // "Cannot access 'READERABLE_UNLIKELY' before initialization".
  const READERABLE_UNLIKELY =
    /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i;
  const READERABLE_MAYBE = /and|article|body|column|content|main|shadow/i;

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

    // --- 1. Try Readability, but only when the page looks like an article ---
    // isProbablyReaderable keeps Readability away from list/dashboard/app pages
    // it would otherwise mangle (dropping most rows and leaving bare bullets);
    // those take the full-page path below. Readability mutates its input, so it
    // still runs on a clone.
    let article = null;
    if (isProbablyReaderable(document)) {
      try {
        article = new Readability(cloneDocumentWithLiveImages()).parse();
      } catch (error) {
        article = null; // an unparseable page just falls back to full-page mode
      }
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
      // Full-page path: clone only what the browser actually renders, then drop
      // scripts/styles/hidden decoration and interactive chrome.
      container = buildVisiblePageClone();
      stripNonContent(container);
      stripChrome(container);
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

  // --- article detection ----------------------------------------------------

  // Ported from @mozilla/readability's Readability-readerable.js (Apache-2.0,
  // the same project as the vendored Readability). Returns true when it reads like
  // a prose article: it sums sqrt(text length) over visible <p>/<pre>/<article>
  // blocks (ignoring boilerplate-looking ones) and asks whether that clears a
  // small score. A list/dashboard/app screen has no such prose and scores ~0,
  // so it takes the full-page path instead of being mangled by Readability.
  // The READERABLE_UNLIKELY/READERABLE_MAYBE regexes it uses are declared at the
  // top of the IIFE so they are initialized before the article path calls this.
  function isProbablyReaderable(doc) {
    const minContentLength = 140;
    const minScore = 20;
    const nodes = Array.prototype.slice.call(
      doc.querySelectorAll("p, pre, article")
    );
    // A <div> whose only "paragraph" is a run of <br>s counts too.
    for (const br of doc.querySelectorAll("div > br")) {
      if (br.parentNode && nodes.indexOf(br.parentNode) === -1) {
        nodes.push(br.parentNode);
      }
    }

    let score = 0;
    return nodes.some(function (node) {
      if (!isReaderableNodeVisible(node)) {
        return false;
      }
      const matchString = (node.className || "") + " " + (node.id || "");
      if (READERABLE_UNLIKELY.test(matchString) && !READERABLE_MAYBE.test(matchString)) {
        return false;
      }
      if (node.matches && node.matches("li p")) {
        return false;
      }
      const textContentLength = node.textContent.trim().length;
      if (textContentLength < minContentLength) {
        return false;
      }
      score += Math.sqrt(textContentLength - minContentLength);
      return score > minScore;
    });
  }

  // The visibility test Mozilla pairs with isProbablyReaderable: inline style
  // and the hidden attributes only (it must stay cheap and run before layout is
  // trusted). fallback-image nodes stay visible on purpose.
  function isReaderableNodeVisible(node) {
    return (
      (!node.style || node.style.display !== "none") &&
      (!node.style || node.style.visibility !== "hidden") &&
      !node.hasAttribute("hidden") &&
      (!node.hasAttribute("aria-hidden") ||
        node.getAttribute("aria-hidden") !== "true" ||
        (node.className &&
          typeof node.className === "string" &&
          node.className.indexOf("fallback-image") !== -1))
    );
  }

  // --- full-page fallback cleanup -------------------------------------------

  // Drop elements that can never contribute to Markdown (code, styling, frames,
  // media chrome) plus anything the page itself marks as hidden. Navigation
  // landmarks and interactive controls are removed separately by stripChrome;
  // ordinary link lists that are neither (a plain footer, say) stay — in the
  // full-page path the user asked for the whole page.
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

  // Clone the body, carry each live image's currentSrc onto its clone, and drop
  // every element the browser does not actually render — display:none from ANY
  // stylesheet (not just [hidden]), which is how sites hide pop-up menus,
  // inactive tab panels, and edit forms. The clone must be measured against the
  // LIVE tree, so a single index-aligned pass does the currentSrc copy and the
  // hidden-node marking together, before any node is removed. getElementsByTagName
  // walks both trees in the same document order, so element i lines up with
  // element i as long as we mutate only after the loop.
  function buildVisiblePageClone() {
    const liveRoot = document.body || document.documentElement;
    const clone = liveRoot.cloneNode(true);
    const view = document.defaultView;
    const liveEls = liveRoot.getElementsByTagName("*");
    const cloneEls = clone.getElementsByTagName("*");
    const count = Math.min(liveEls.length, cloneEls.length);
    for (let i = 0; i < count; i += 1) {
      const live = liveEls[i];
      const twin = cloneEls[i];
      if (live.tagName === "IMG" && live.currentSrc) {
        twin.setAttribute("src", live.currentSrc);
      }
      if (isRenderedHidden(live, view)) {
        twin.setAttribute("data-bc-hidden", "");
      }
    }
    for (const node of clone.querySelectorAll("[data-bc-hidden]")) {
      node.remove();
    }
    return clone;
  }

  // True when the live element paints nothing AND removing it drops nothing the
  // reader can see. No client rects usually means display:none (from any source)
  // — the whole subtree is hidden, safe to drop. The exception is display:contents:
  // it also has no box of its own, but its children render in its place, so it is
  // KEPT (a hidden child, if any, is dropped on its own). visibility:hidden/collapse
  // still occupies space (it has rects) and a descendant may set visibility:visible
  // to re-show itself, so it is treated as hidden only for a childless element —
  // otherwise a hidden wrapper could take a visible child down with it. Screen-
  // reader-only text (clipped / off-screen) still paints, so it too is KEPT — it
  // often carries the accessible label we want (a due date, the points possible).
  // Reads only the live DOM; never mutates it.
  function isRenderedHidden(el, view) {
    const computeStyle =
      view && typeof view.getComputedStyle === "function"
        ? function () { return view.getComputedStyle(el); }
        : function () { return null; };
    if (
      typeof el.getClientRects === "function" &&
      el.getClientRects().length === 0
    ) {
      const style = computeStyle();
      return !(style && style.display === "contents");
    }
    if (el.childElementCount === 0) {
      const style = computeStyle();
      if (
        style &&
        (style.visibility === "hidden" || style.visibility === "collapse")
      ) {
        return true;
      }
    }
    return false;
  }

  // Chrome, not document content: navigation landmarks (global/section nav,
  // breadcrumbs) and interactive controls (form controls and ARIA widgets —
  // buttons, menus, toolbars, tabs, dialogs). Removing these generically leaves
  // the readable body behind; links and text inside real content are untouched,
  // so it reads the same on any site.
  function stripChrome(container) {
    const selector = [
      "nav", '[role="navigation"]',
      "button", "input", "select", "textarea",
      '[role="button"]', '[role="menu"]', '[role="menubar"]',
      '[role="toolbar"]', '[role="tab"]', '[role="tablist"]',
      '[role="dialog"]', '[role="alertdialog"]', '[role="search"]',
      '[role="tooltip"]'
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
