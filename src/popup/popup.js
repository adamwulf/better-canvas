// Better Canvas — popup ("menu") logic
//
// Wires the toolbar-button menu. Each action injects a content script into the
// active tab and reports the result. The injected script does the work AND
// triggers the download itself (in the page), so the save still completes even
// if this popup is closed first; the status shown here is a best-effort
// confirmation while the popup remains open.
//
// Both actions need helper classic scripts in the tab before their own script
// runs: the shared image optimizer (src/lib/image-optimizer.js) for freeze-dry,
// plus the vendored Readability/Turndown libraries for "Export as Markdown".
// Injections into the same tab land in the same isolated world, where
// classic-script globals persist across executeScript calls (the dashboard
// scripts rely on the same behavior), so the action's file groups are injected
// sequentially and the LAST group's result is the outcome.

(function () {
  "use strict";

  var statusEl = document.getElementById("bc-status");
  var busy = false;

  var ACTIONS = [
    {
      buttonId: "bc-freeze-dry",
      workingText: "Freeze-drying this page…",
      injections: [
        ["src/lib/image-optimizer.js"],
        ["src/content/capture-page.js"]
      ]
    },
    {
      buttonId: "bc-export-md",
      workingText: "Converting this page to Markdown…",
      injections: [
        [
          "src/vendor/readability.js",
          "src/vendor/turndown.js",
          "src/vendor/turndown-plugin-gfm.js",
          "src/lib/image-optimizer.js"
        ],
        ["src/content/export-markdown.js"]
      ]
    }
  ];

  var buttons = ACTIONS.map(function (action) {
    return document.getElementById(action.buttonId);
  });

  function setStatus(text, kind) {
    statusEl.textContent = text || "";
    statusEl.className = "bc-status" + (kind ? " is-" + kind : "");
  }

  function setBusy(value) {
    busy = value;
    buttons.forEach(function (button) {
      if (value) {
        button.setAttribute("disabled", "");
      } else {
        button.removeAttribute("disabled");
      }
    });
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

  // "Saved foo.md (12 KB, article)" — the Markdown export reports whether the
  // readable article or the whole page was converted; freeze-dry has no mode.
  function describeResult(result) {
    var details = [];
    var size = formatBytes(result.bytes);
    if (size) {
      details.push(size);
    }
    if (result.mode === "article") {
      details.push("article");
    } else if (result.mode === "page") {
      details.push("full page");
    }
    return (
      "Saved " + result.filename +
      (details.length ? " (" + details.join(", ") + ")" : "")
    );
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

  // Inject each file group in order into the same tab; resolve with the LAST
  // group's results (the action's own script — vendor groups only define
  // globals for it).
  function injectSequentially(tabId, injections) {
    var chain = Promise.resolve(null);
    injections.forEach(function (files) {
      chain = chain.then(function () {
        return chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: files
        });
      });
    });
    return chain;
  }

  function runAction(action) {
    if (busy) {
      return;
    }
    setBusy(true);
    setStatus(action.workingText, "working");

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
        return injectSequentially(tab.id, action.injections);
      })
      .then(function (results) {
        var result = results && results[0] ? results[0].result : null;
        // Errors thrown from here are real capture results — their messages come
        // from the injected script and should be shown verbatim, not rewritten
        // below.
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
        setStatus(describeResult(result), "ok");
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
        setBusy(false);
      });
  }

  ACTIONS.forEach(function (action, index) {
    buttons[index].addEventListener("click", function () {
      runAction(action);
    });
  });
})();
