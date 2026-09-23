// Better Canvas (Rice) — favicon swap
//
// Replaces the browser-tab favicon on every Canvas page (canvas.rice.edu and
// hq.globaltech.org) with the bundled Canvas logo. Canvas can rewrite the favicon at runtime (for unread
// badges, SPA navigation, etc.), so a MutationObserver re-applies our icon
// whenever the <head> changes.

(function () {
  "use strict";

  var ICON_URL = chrome.runtime.getURL("assets/canvas-favicon-32.png");
  var MARK = "data-better-canvas-favicon";

  // Guard so re-entrant DOM writes from our own observer do not loop.
  var applying = false;

  function apply() {
    var head = document.head || document.documentElement;
    if (!head) {
      return;
    }
    applying = true;
    try {
      // Drop every favicon link Canvas declared so ours is the only one left.
      var links = document.querySelectorAll(
        'link[rel~="icon"]:not([' + MARK + "]), link[rel~='shortcut']:not([" + MARK + "])"
      );
      for (var i = 0; i < links.length; i++) {
        links[i].parentNode && links[i].parentNode.removeChild(links[i]);
      }

      // Ensure exactly one marked icon link that points at our asset.
      var ours = document.querySelector("link[" + MARK + "]");
      if (!ours) {
        ours = document.createElement("link");
        ours.setAttribute(MARK, "");
        ours.rel = "icon";
        ours.type = "image/png";
        ours.setAttribute("sizes", "any");
        head.appendChild(ours);
      }
      if (ours.href !== ICON_URL) {
        ours.href = ICON_URL;
      }
    } finally {
      applying = false;
    }
  }

  apply();

  // Re-apply if Canvas swaps the favicon back or navigates within the SPA.
  var observer = new MutationObserver(function () {
    if (applying) {
      return;
    }
    apply();
  });

  function startObserving() {
    var target = document.head || document.documentElement;
    if (!target) {
      return;
    }
    observer.observe(target, { childList: true, subtree: true });
  }

  if (document.head) {
    startObserving();
  } else {
    // At document_start <head> may not exist yet; wait for it.
    var boot = new MutationObserver(function () {
      if (document.head) {
        apply();
        startObserving();
        boot.disconnect();
      }
    });
    boot.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
