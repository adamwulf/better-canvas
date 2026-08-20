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
    fetchResource(message.url)
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

async function fetchResource(rawUrl) {
    var url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Unsupported resource URL: " + url.protocol);
    }

    var controller = new AbortController();
    var timeout = setTimeout(function () {
        controller.abort();
    }, FETCH_TIMEOUT_MS);
    try {
        var response = await fetch(url.href, {
            cache: "force-cache",
            credentials: "include",
            redirect: "follow",
            signal: controller.signal
        });
        if (!response.ok) {
            throw new Error("HTTP " + response.status + " while fetching " + url.href);
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

function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var chunkSize = 0x8000; // 32 KB chunks keep String.fromCharCode off the arg limit
    var binary = "";
    for (var offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}
