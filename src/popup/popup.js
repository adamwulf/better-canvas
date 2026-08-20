// Better Canvas — popup ("menu") logic
//
// Wires the toolbar-button menu. "Freeze-dry this page" injects the capture
// script into the active tab and reports the result. The injected script does the
// freeze-dry AND triggers the download itself (in the page), so the save still
// completes even if this popup is closed first; the status shown here is a
// best-effort confirmation while the popup remains open.

(function () {
  "use strict";

  var button = document.getElementById("bc-freeze-dry");
  var statusEl = document.getElementById("bc-status");
  var busy = false;

  function setStatus(text, kind) {
    statusEl.textContent = text || "";
    statusEl.className = "bc-status" + (kind ? " is-" + kind : "");
  }

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) {
      return "";
    }
    if (bytes < 1024) {
      return bytes + " B";
    }
    var kb = bytes / 1024;
    if (kb < 1024) {
      return Math.round(kb) + " KB";
    }
    return (kb / 1024).toFixed(1) + " MB";
  }

  // Pages the browser refuses to let extensions script. We check the scheme up
  // front so we can show a friendly message instead of a raw injection error.
  function captureBlockedReason(url) {
    if (!url) {
      return "This page can't be saved.";
    }
    var lower = url.toLowerCase();
    if (
      lower.indexOf("chrome:") === 0 ||
      lower.indexOf("edge:") === 0 ||
      lower.indexOf("brave:") === 0 ||
      lower.indexOf("about:") === 0 ||
      lower.indexOf("chrome-extension:") === 0 ||
      lower.indexOf("devtools:") === 0 ||
      lower.indexOf("view-source:") === 0
    ) {
      return "Browser pages can't be saved.";
    }
    if (
      lower.indexOf("https://chrome.google.com/webstore") === 0 ||
      lower.indexOf("https://chromewebstore.google.com") === 0
    ) {
      return "The Chrome Web Store can't be saved.";
    }
    return null;
  }

  function getActiveTab() {
    return chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(function (tabs) {
        return tabs && tabs[0];
      });
  }

  function runCapture() {
    if (busy) {
      return;
    }
    busy = true;
    button.setAttribute("disabled", "");
    setStatus("Freeze-drying this page…", "working");

    getActiveTab()
      .then(function (tab) {
        if (!tab || tab.id == null) {
          throw new Error("No active tab to save.");
        }
        var blocked = captureBlockedReason(tab.url);
        if (blocked) {
          var friendly = new Error(blocked);
          friendly.friendly = true;
          throw friendly;
        }
        return chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["src/content/capture-page.js"]
        });
      })
      .then(function (results) {
        var result = results && results[0] ? results[0].result : null;
        // Errors thrown from here are real capture results — their messages come
        // from freeze-dry and should be shown verbatim, not rewritten below.
        var captured;
        if (!result) {
          captured = new Error("The page could not be captured.");
        } else if (!result.ok) {
          captured = new Error(result.error || "The page could not be captured.");
        }
        if (captured) {
          captured.captured = true;
          throw captured;
        }
        var size = formatBytes(result.bytes);
        setStatus(
          "Saved " + result.filename + (size ? " (" + size + ")" : ""),
          "ok"
        );
      })
      .catch(function (error) {
        var message = error && error.message ? error.message : String(error);
        // Injecting into a disallowed page rejects executeScript with a generic
        // Chrome error ("Cannot access …", "Missing host permission …"). Only
        // those get the friendly rewrite; a friendly-thrown or captured error is
        // already user-ready.
        var isInjectionFailure =
            !(error && (error.friendly || error.captured)) &&
            /cannot access|missing host permission|cannot be scripted|extension manifest/i.test(message);
        setStatus(isInjectionFailure ? "This page can't be saved." : message, "error");
      })
      .then(function () {
        busy = false;
        button.removeAttribute("disabled");
      });
  }

  button.addEventListener("click", runCapture);
})();
