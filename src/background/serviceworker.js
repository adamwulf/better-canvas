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
  //
  // Two limits are inherent to a lexical guard in a browser and are accepted:
  //   1. A public DNS name that resolves to an internal IP (DNS-rebinding style)
  //      passes the name check — the browser resolves DNS, we never see the IP.
  //   2. redirect: "follow" below issues the request to a redirected host before
  //      the post-redirect check can run, so a public->internal 3xx still makes a
  //      blind GET; only inlining the response is blocked. (redirect: "manual"
  //      cannot read the cross-origin Location to validate hops, and redirect:
  //      "error" would drop legitimate redirected resources like Canvas file URLs.)
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

// Chrome serializes IPv4-mapped IPv6 to hex — http://[::ffff:127.0.0.1]/ has
// hostname [::ffff:7f00:1], and 169.254.169.254 becomes [::ffff:a9fe:a9fe] — so a
// string match on the dotted form misses them. We parse the address to 16 bytes
// and range-check, including the IPv4 embedded by the mapped (::ffff:0:0/96),
// compatible (::/96), and NAT64 (64:ff9b::/96) prefixes. Unparseable → unsafe.
function isInternalIPv6(host) {
  var bytes = parseIPv6ToBytes(host);
  if (!bytes) {
    return true; // fail closed: an address we cannot decode is not proven safe
  }
  var leading15Zero = bytes.slice(0, 15).every(function (x) { return x === 0; });
  if (leading15Zero && (bytes[15] === 0 || bytes[15] === 1)) {
    return true; // :: unspecified / ::1 loopback
  }
  if (bytes[0] === 0xfe && (bytes[1] & 0x80) === 0x80) {
    return true; // fe80::/9: fe80::/10 link-local + fec0::/10 deprecated site-local
  }
  if ((bytes[0] & 0xfe) === 0xfc) {
    return true; // fc00::/7 unique local
  }
  var isMapped = bytes.slice(0, 10).every(function (x) { return x === 0; }) &&
    bytes[10] === 0xff && bytes[11] === 0xff; // ::ffff:0:0/96
  var isCompat = bytes.slice(0, 12).every(function (x) { return x === 0; }); // ::/96
  var isNat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff &&
    bytes[3] === 0x9b && bytes.slice(4, 12).every(function (x) { return x === 0; }); // 64:ff9b::/96
  if (isMapped || isCompat || isNat64) {
    return isInternalIPv4(bytes.slice(12, 16).join(".")); // IPv4 in the low 32 bits
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isInternalIPv4(bytes.slice(2, 6).join(".")); // 6to4 2002::/16: IPv4 in bytes 2-5
  }
  return false;
}

// Parse a bracket-stripped, lowercased IPv6 host (optionally with one "::"
// compression and/or an embedded trailing dotted IPv4) into a 16-byte array, or
// null if it is not a well-formed IPv6 literal.
function parseIPv6ToBytes(host) {
  var text = host;
  // Fold an embedded trailing dotted IPv4 (::ffff:1.2.3.4) into two hex groups.
  var tail = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    var quad = tail[2].split(".").map(function (n) { return parseInt(n, 10); });
    if (quad.some(function (n) { return isNaN(n) || n < 0 || n > 255; })) {
      return null;
    }
    text = tail[1] +
      (((quad[0] << 8) | quad[1]).toString(16)) + ":" +
      (((quad[2] << 8) | quad[3]).toString(16));
  }
  var halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  var head = toHexGroups(halves[0]);
  var back = halves.length === 2 ? toHexGroups(halves[1]) : [];
  if (head === null || back === null) {
    return null;
  }
  var groups;
  if (halves.length === 2) {
    var missing = 8 - (head.length + back.length);
    if (missing < 1) {
      return null; // "::" must stand for at least one zero group
    }
    groups = head.concat(new Array(missing).fill("0")).concat(back);
  } else {
    groups = head;
  }
  if (groups.length !== 8) {
    return null;
  }
  var bytes = [];
  for (var i = 0; i < 8; i += 1) {
    var value = parseInt(groups[i], 16);
    bytes.push((value >> 8) & 255, value & 255);
  }
  return bytes;
}

function toHexGroups(part) {
  if (part === "") {
    return [];
  }
  var groups = part.split(":");
  for (var i = 0; i < groups.length; i += 1) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) {
      return null;
    }
  }
  return groups;
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
