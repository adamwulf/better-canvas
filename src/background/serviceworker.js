// Better Canvas — service worker (Manifest V3)
//
// Sole job: proxy cross-origin sub-resource fetches for the freeze-dry capture.
//
// A content script running in the page cannot read cross-origin sub-resources
// (images, fonts, stylesheets on CDNs) — CORS blocks the response body. This
// worker fetches them instead: its request carries the extension's identity and
// host permission (<all_urls>), so CORS does not apply, and it returns the bytes
// base64-encoded for the page to rebuild into a Blob. Without this proxy, cross-
// origin fonts and images silently drop out of the saved page.
//
// The worker can be torn down when idle and restarted on the next message; this
// listener re-registers on every cold load, so no persistent state is required.

"use strict";

console.log("[BetterCanvas] service worker loaded");

var MAX_RESOURCE_BYTES = 32 * 1024 * 1024; // 32 MB per sub-resource
var FETCH_TIMEOUT_MS = 30000;

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.command !== "BC_FETCH_RESOURCE") {
    return false;
  }
  fetchResource(message.url, message.pageHost)
    .then(function (resource) {
      sendResponse({ ok: true, ...resource });
    })
    .catch(function (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  return true; // keep the message channel open for the async sendResponse
});

async function fetchResource(rawUrl, pageHost) {
  var url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Unsupported resource URL: " + url.protocol);
  }

  // SSRF guard. This proxy fetches with the extension's <all_urls> permission and
  // credentials, which bypasses CORS — a capability the page itself does not have.
  // So a CAPTURED PAGE must not be able to point it at internal/loopback/link-
  // local hosts (e.g. cloud metadata at 169.254.169.254, or a LAN router). But if
  // the page being captured is ITSELF an internal/local page, its own internal
  // sub-resources are legitimate, so we only block internal targets when the
  // page's own host is not internal.
  var pageIsInternal = isInternalHost(pageHost);
  if (isInternalHost(url.hostname) && !pageIsInternal) {
    throw new Error("Refusing to fetch internal host: " + url.hostname);
  }

  var controller = new AbortController();
  var timeout = setTimeout(function () {
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  try {
    var response = await fetch(url.href, {
      cache: "force-cache",
      // "include" so resources behind the user's own session (logged-in images,
      // Canvas file redirects) inline correctly. The SSRF guard keeps this
      // credentialed fetch away from internal hosts.
      credentials: "include",
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error("HTTP " + response.status + " while fetching " + url.href);
    }
    // Re-check after redirects: a public URL can 3xx into an internal host.
    var finalHost = safeHostname(response.url) || url.hostname;
    if (isInternalHost(finalHost) && !pageIsInternal) {
      throw new Error("Refusing to fetch internal host (after redirect): " + finalHost);
    }
    var declaredSize = Number(response.headers.get("content-length"));
    if (declaredSize > MAX_RESOURCE_BYTES) {
      throw new Error("Resource is larger than " + MAX_RESOURCE_BYTES + " bytes");
    }
    var buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESOURCE_BYTES) {
      throw new Error("Resource is larger than " + MAX_RESOURCE_BYTES + " bytes");
    }
    return {
      base64: arrayBufferToBase64(buffer),
      contentType: response.headers.get("content-type") || "application/octet-stream",
      url: response.url || url.href
    };
  } finally {
    clearTimeout(timeout);
  }
}

function safeHostname(value) {
  try {
    return new URL(value).hostname;
  } catch (error) {
    return "";
  }
}

// True for loopback / private / link-local / unique-local / reserved hosts and
// internal-only names (localhost, *.local, *.internal). The WHATWG URL parser
// already canonicalizes IPv4 written in hex/octal/decimal form to dotted-decimal,
// so the dotted-quad check below also covers those encodings. Exotic IPv6
// encodings are not exhaustively covered; the common metadata/LAN targets are.
function isInternalHost(hostname) {
  if (!hostname) {
    return false;
  }
  var host = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (host === "localhost" || host === "ip6-localhost" || host === "ip6-loopback") {
    return true;
  }
  // Exact "local"/"internal", or any *.local / *.internal / *.localhost name.
  if (/(^|\.)(local|internal|localhost)$/.test(host)) {
    return true;
  }
  // IPv4-mapped IPv6 in dotted form (::ffff:127.0.0.1) → test the embedded IPv4.
  var mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) {
    return isInternalIPv4(mapped[1]);
  }
  if (host.indexOf(":") !== -1) {
    return isInternalIPv6(host);
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return isInternalIPv4(host);
  }
  return false;
}

function isInternalIPv4(ip) {
  var parts = ip.split(".").map(function (n) {
    return parseInt(n, 10);
  });
  if (parts.length !== 4 || parts.some(function (n) {
    return isNaN(n) || n < 0 || n > 255;
  })) {
    return true; // malformed → treat as unsafe
  }
  var a = parts[0];
  var b = parts[1];
  var c = parts[2];
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 10) return true;                         // 10.0.0.0/8 private
  if (a === 127) return true;                        // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local (+ metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true;  // 192.0.0.0/24 protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true;                         // 224.0.0.0/4 multicast + 240/4 reserved
  return false;
}

function isInternalIPv6(host) {
  if (host === "::1" || host === "::") {
    return true; // loopback / unspecified
  }
  if (/^fe[89a-f]/.test(host)) {
    return true; // fe80::/10 link-local (+ deprecated fec0::/10 site-local)
  }
  if (/^f[cd]/.test(host)) {
    return true; // fc00::/7 unique local
  }
  return false;
}

function arrayBufferToBase64(buffer) {
  var bytes = new Uint8Array(buffer);
  var chunkSize = 0x8000; // 32 KB chunks keep String.fromCharCode off the arg limit
  var binary = "";
  for (var offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
