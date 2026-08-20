// Better Canvas — shared image optimizer (classic script, page context)
//
// Mirrors the image re-encoding pipeline of the Allume browser extension
// (muse-ios/BrowserExtension/src/content/capture-page.js), so freeze-dry
// snapshots and Markdown exports shrink images the same proven way:
//
//   - Only real image/jpeg and image/png inputs are considered; every other
//     type (gif, svg, webp, …) passes through untouched.
//   - The bytes are sniffed before decoding: a mislabeled file, an animated
//     PNG (acTL chunk), or unreasonable dimensions (> 16384 on a side or
//     > 16M pixels) keeps its original bytes.
//   - The image is re-encoded as webp at quality 0.82, and the webp is kept
//     only if it saves at least max(512 bytes, 5% of the original).
//   - At most two encodes run concurrently, each attempt (including waiting
//     for a codec slot) is bounded at 2.5s, and every failure is soft: the
//     original bytes always survive.
//
// One deliberate divergence, used by the Markdown export only: Allume never
// resizes sub-resource images because intrinsic raster size participates in
// layout when an archived .html reloads. Markdown has no such layout
// dependency, so optimizeImageBlob accepts an optional renderedSize ({w, h}
// in CSS px, from buildRenderedSizeMap) and downscales to that size ×
// devicePixelRatio (capped at 2, never upscaled) before encoding. Freeze-dry
// passes null and keeps Allume's natural-size behavior.
//
// Allume also gates re-encoding on HOW an image is referenced: only <img>
// src/srcset and un-typed <picture> sources are eligible — CSS background
// images are inlined untouched. This lib only sees blobs, so that gate is the
// CALLERS' job: capture-page.js builds an eligible-URL set from the live DOM,
// and the Markdown export only ever walks <img> elements.
//
// Injected by the popup ahead of the content scripts that use it; defines the
// BCImageOptimizer global in the extension's isolated world.

var BCImageOptimizer = (function () {
  "use strict";

  // Constants mirrored from Allume's capture-page.js.
  const WEBP_QUALITY = 0.82;
  const WEBP_ENCODER_CONCURRENCY = 2;
  const WEBP_ATTEMPT_TIMEOUT_MS = 2500;
  const WEBP_MAX_INPUT_BYTES = 32 * 1024 * 1024;
  const WEBP_MAX_DIMENSION = 16384;
  const WEBP_MAX_PIXELS = 16 * 1024 * 1024;
  const WEBP_MIN_SAVINGS_BYTES = 512;
  const WEBP_MIN_SAVINGS_RATIO = 0.05;
  // Browser zoom inflates devicePixelRatio; capping at 2 keeps a zoomed-in
  // page from inflating every downscale target 4×.
  const MAX_DEVICE_PIXEL_RATIO = 2;

  let activeEncoders = 0;
  const encoderWaiters = [];
  // Latched the first time the canvas hands back a non-webp blob (Allume keeps
  // this for Safari; on Chrome it should never fire, but it is cheap).
  let webpOutputMimeRejected = false;

  // Map of absolute image URL → the largest {w, h} CSS-pixel size at which the
  // document renders it. currentSrc is the srcset/lazy-load candidate actually
  // shown. Images that render at 0×0 (hidden, unlaid-out) are omitted — with
  // no known size the optimizer keeps natural dimensions.
  function buildRenderedSizeMap(doc) {
    const map = new Map();
    const images = doc.images || [];
    for (let i = 0; i < images.length; i += 1) {
      const img = images[i];
      const key = img.currentSrc || img.src;
      if (!key) {
        continue;
      }
      const w = img.width;
      const h = img.height;
      if (w < 1 || h < 1) {
        continue;
      }
      const prev = map.get(key);
      if (!prev || w * h > prev.w * prev.h) {
        map.set(key, { w: w, h: h });
      }
    }
    return map;
  }

  // The URLs Allume's isOrdinaryImageLink gate would re-encode: <img>
  // src/srcset candidates and srcset candidates of un-typed <source> elements
  // under <picture>. A URL that fails to resolve is simply left out, which
  // fails toward Allume's default of leaving the resource untouched.
  function buildEligibleImageUrlSet(doc) {
    const set = new Set();
    function addResolved(raw) {
      if (!raw) {
        return;
      }
      try {
        set.add(new URL(raw, doc.baseURI).href);
      } catch (error) {
        /* unresolvable → not eligible */
      }
    }
    function addSrcset(srcset) {
      if (!srcset) {
        return;
      }
      for (const candidate of srcset.split(",")) {
        addResolved(candidate.trim().split(/\s+/)[0]);
      }
    }
    for (const img of doc.querySelectorAll("img")) {
      addResolved(img.getAttribute("src"));
      addSrcset(img.getAttribute("srcset"));
      if (img.currentSrc) {
        set.add(img.currentSrc);
      }
    }
    for (const source of doc.querySelectorAll("picture > source:not([type])")) {
      addSrcset(source.getAttribute("srcset"));
    }
    return set;
  }

  // Returns the winning webp Blob, or null meaning "keep the original bytes"
  // (wrong type, guard tripped, timeout, or the webp did not save enough).
  // renderedSize is optional — see the divergence note in the header.
  async function optimizeImageBlob(blob, renderedSize) {
    try {
      const mime = normalizeMime(blob.type);
      if (mime !== "image/jpeg" && mime !== "image/png") {
        return null;
      }
      if (blob.size <= 0 || blob.size > WEBP_MAX_INPUT_BYTES) {
        return null;
      }
      if (webpOutputMimeRejected) {
        return null;
      }
      // The timeout covers the whole attempt including the wait for a codec
      // slot; a timed-out attempt keeps running detached (native decode/encode
      // cannot be cancelled) and frees its slot when it settles.
      const encoded = await raceTimeout(
        encodeBlobAsWebp(blob, mime, renderedSize),
        WEBP_ATTEMPT_TIMEOUT_MS
      );
      if (!encoded) {
        return null;
      }
      if (normalizeMime(encoded.type) !== "image/webp") {
        webpOutputMimeRejected = true;
        return null;
      }
      if (encoded.size <= 0) {
        return null;
      }
      const savedBytes = blob.size - encoded.size;
      const requiredSavings = Math.max(
        WEBP_MIN_SAVINGS_BYTES,
        Math.ceil(blob.size * WEBP_MIN_SAVINGS_RATIO)
      );
      if (savedBytes < requiredSavings) {
        return null;
      }
      return encoded;
    } catch (error) {
      return null; // fail-soft: the original bytes always survive
    }
  }

  async function encodeBlobAsWebp(blob, mime, renderedSize) {
    await acquireEncoder();
    let bitmap = null;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const info = mime === "image/png" ? inspectPng(bytes) : inspectJpeg(bytes);
      if (!info.valid || info.animated) {
        throw new Error("unsuitable image");
      }
      if (!dimensionsAreReasonable(info.width, info.height)) {
        throw new Error("unreasonable dimensions");
      }

      bitmap = await decodeImageBlob(blob);
      if (!dimensionsAreReasonable(bitmap.width, bitmap.height)) {
        throw new Error("unreasonable dimensions");
      }

      let width = bitmap.width;
      let height = bitmap.height;
      if (renderedSize && renderedSize.w >= 1 && renderedSize.h >= 1) {
        const dpr = Math.min(
          window.devicePixelRatio || 1,
          MAX_DEVICE_PIXEL_RATIO
        );
        // One uniform factor keeps the aspect ratio, and it is the LARGER of
        // the two axis ratios: an object-fit:cover crop is scaled by that axis
        // on screen, so the smaller ratio would under-resolve the visible part.
        const scale = Math.min(
          1,
          Math.max(
            (renderedSize.w * dpr) / bitmap.width,
            (renderedSize.h * dpr) / bitmap.height
          )
        );
        width = Math.max(1, Math.round(bitmap.width * scale));
        height = Math.max(1, Math.round(bitmap.height * scale));
      }

      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d", { alpha: true });
      if (width < bitmap.width || height < bitmap.height) {
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, width, height);
      } else {
        ctx.drawImage(bitmap, 0, 0);
      }
      return await canvas.convertToBlob({
        type: "image/webp",
        quality: WEBP_QUALITY
      });
    } finally {
      if (bitmap && bitmap.close) {
        bitmap.close();
      }
      releaseEncoder();
    }
  }

  async function decodeImageBlob(blob) {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch (error) {
      // Older engines reject the options overload but accept the plain form.
      return await createImageBitmap(blob);
    }
  }

  function dimensionsAreReasonable(width, height) {
    return Number.isSafeInteger(width) && Number.isSafeInteger(height) &&
      width > 0 && height > 0 &&
      width <= WEBP_MAX_DIMENSION && height <= WEBP_MAX_DIMENSION &&
      width * height <= WEBP_MAX_PIXELS;
  }

  // PNG byte sniff, ported from Allume: validates the signature and chunk
  // stream, reads IHDR dimensions, and reports an acTL chunk (animated PNG).
  function inspectPng(bytes) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 33 ||
        signature.some(function (value, index) { return bytes[index] !== value; })) {
      return { valid: false };
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    let width = 0;
    let height = 0;
    let firstChunk = true;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      if (length > bytes.length - offset - 12) {
        return { valid: false };
      }
      const type = String.fromCharCode(
        bytes[offset + 4], bytes[offset + 5],
        bytes[offset + 6], bytes[offset + 7]
      );
      if (firstChunk) {
        if (type !== "IHDR" || length !== 13) {
          return { valid: false };
        }
        width = view.getUint32(offset + 8);
        height = view.getUint32(offset + 12);
        firstChunk = false;
      }
      if (type === "acTL") {
        return { valid: true, animated: true, width: width, height: height };
      }
      offset += 12 + length;
      if (type === "IEND") {
        return { valid: true, animated: false, width: width, height: height };
      }
    }
    return { valid: false };
  }

  // JPEG byte sniff, ported from Allume: walks the marker stream to the first
  // start-of-frame and reads the dimensions from it.
  function inspectJpeg(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      return { valid: false };
    }
    const sofMarkers = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
      0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
    ]);
    let offset = 2;
    while (offset < bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 0xff) {
        offset += 1;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) {
        offset += 1;
      }
      if (offset >= bytes.length) {
        break;
      }
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xd9 || marker === 0xda) {
        break;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        continue;
      }
      if (offset + 2 > bytes.length) {
        return { valid: false };
      }
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2 || length > bytes.length - offset) {
        return { valid: false };
      }
      if (sofMarkers.has(marker)) {
        if (length < 7) {
          return { valid: false };
        }
        const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
        const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
        return { valid: true, animated: false, width: width, height: height };
      }
      offset += length;
    }
    return { valid: false };
  }

  // Two-slot codec semaphore (Allume's WEBP_ENCODER_CONCURRENCY). A released
  // slot is handed straight to the next waiter, so the active count never
  // exceeds the cap.
  function acquireEncoder() {
    if (activeEncoders < WEBP_ENCODER_CONCURRENCY) {
      activeEncoders += 1;
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      encoderWaiters.push(resolve);
    });
  }

  function releaseEncoder() {
    const next = encoderWaiters.shift();
    if (next) {
      next(); // slot transfers; activeEncoders stays counted
    } else {
      activeEncoders = Math.max(0, activeEncoders - 1);
    }
  }

  // Resolve to null if the promise has not settled (or rejects) in time.
  function raceTimeout(promise, timeoutMs) {
    return new Promise(function (resolve) {
      const timer = setTimeout(function () {
        resolve(null);
      }, timeoutMs);
      promise.then(
        function (value) { clearTimeout(timer); resolve(value); },
        function () { clearTimeout(timer); resolve(null); }
      );
    });
  }

  // A bare lowercase mime type — parameters ("; charset=…") would put a space
  // inside a data: URI, which breaks Markdown link destinations.
  function normalizeMime(contentType) {
    return String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  }

  function blobToDataUri(blob) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = function () {
        reject(reader.error || new Error("Could not read blob"));
      };
      reader.readAsDataURL(blob);
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

  return {
    buildRenderedSizeMap: buildRenderedSizeMap,
    buildEligibleImageUrlSet: buildEligibleImageUrlSet,
    optimizeImageBlob: optimizeImageBlob,
    blobToDataUri: blobToDataUri,
    base64ToBytes: base64ToBytes,
    normalizeMime: normalizeMime
  };
})();
