// Better Canvas (Rice) — resizable columns on the Files pages
//
// The new Canvas "Files" page renders the file list as a real <table>
// (#files-table, Instructure UI) with table-layout: fixed, so each column is
// exactly as wide as its <thead> cell. Canvas sets those header widths inline
// (e.g. style="width: 12.5em") and re-writes them on every React re-render —
// a sort click, folder navigation, a window resize — which leaves long file
// names truncated in a Name column that can't be widened.
//
// This script adds a drag handle to the right edge of each header cell.
// Dragging writes per-column rules into an injected <style> sheet:
//   #files-table thead th[data-testid="name"] { width: 342px !important; }
// A stylesheet !important declaration beats React's (non-important) inline
// styles, so custom widths survive re-renders without this script ever
// fighting React over the style attribute. The handles themselves DO live
// inside React's thead, so a MutationObserver puts them back whenever React
// rebuilds the header.
//
// Widths are session-only by design: they live in a Map and the injected
// sheet, and die with the page. Nothing is persisted.
//
// On drag start, every keyed column is first frozen at its current rendered
// width. Without that, table-layout: fixed would redistribute the dragged
// column's delta across all the unsized columns and the drag would feel
// rubbery. A header cell with no data-testid (e.g. the Ally-injected
// "Accessibility" column) can't be keyed, stays unfrozen, and just absorbs
// slack. If the frozen widths outgrow the container, the companion CSS turns
// the table's wrapper (.FileDragOverlayContainer) into a horizontal scroller
// and lifts the table's own max-width: 100% cap.
//
// Double-clicking a handle clears that column's override, handing the width
// back to Canvas.

(function () {
  "use strict";

  var TABLE_ID = "files-table";
  var STYLE_ID = "better-canvas-files-colwidths";
  var HANDLE_CLASS = "bc-col-resize-handle";
  var MIN_PX = 36;
  var MAX_PX = 2000;

  var widths = new Map(); // data-testid -> px, session-only
  var drag = null; // { key, startX, startW, rtl, moved } during a drag
  var lastDragMoved = false; // lets dblclick ignore two quick drags
  var renderQueued = false;

  // ---- Injected stylesheet ------------------------------------------------

  function styleEl() {
    var el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      // document.head is outside React's tree, so the sheet is never removed
      // by a re-render.
      (document.head || document.documentElement).appendChild(el);
    }
    return el;
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape
      ? CSS.escape(value)
      : value.replace(/["\\]/g, "\\$&");
  }

  function render() {
    var rules = [];
    widths.forEach(function (px, key) {
      rules.push(
        '#' + TABLE_ID + ' thead th[data-testid="' + cssEscape(key) + '"] ' +
        "{ width: " + px + "px !important; }"
      );
    });
    styleEl().textContent = rules.join("\n");
  }

  // pointermove can fire faster than frames render; coalesce to one
  // stylesheet write per frame.
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      render();
    });
  }

  // ---- Drag behavior ------------------------------------------------------

  function onPointerDown(e) {
    if (e.button !== 0) return;
    var handle = e.currentTarget;
    var th = handle.closest("th");
    var table = handle.closest("table");
    var key = th && th.getAttribute("data-testid");
    if (!key || !table) return;
    e.preventDefault(); // no text selection, no focus steal from the sort button
    e.stopPropagation();

    // Freeze every keyed column at its rendered width (see header comment).
    table.querySelectorAll("thead th[data-testid]").forEach(function (cell) {
      widths.set(
        cell.getAttribute("data-testid"),
        Math.round(cell.getBoundingClientRect().width)
      );
    });

    drag = {
      key: key,
      startX: e.clientX,
      startW: widths.get(key),
      rtl: getComputedStyle(table).direction === "rtl",
      moved: false
    };
    try {
      // Captured: later pointer events retarget to the handle even when the
      // pointer leaves it, so move/up listeners live on the handle itself.
      handle.setPointerCapture(e.pointerId);
    } catch (err) {
      // A synthetic or already-released pointer can't be captured; dragging
      // still works while the pointer stays over the handle.
    }
    handle.classList.add("bc-active");
    document.documentElement.classList.add("bc-col-resizing");
    render();
  }

  function onPointerMove(e) {
    if (!drag) return;
    var dx = e.clientX - drag.startX;
    if (drag.rtl) dx = -dx;
    if (Math.abs(dx) > 2) drag.moved = true;
    widths.set(
      drag.key,
      Math.round(Math.max(MIN_PX, Math.min(MAX_PX, drag.startW + dx)))
    );
    scheduleRender();
  }

  function onPointerEnd(e) {
    if (!drag) return;
    lastDragMoved = drag.moved;
    drag = null;
    e.currentTarget.classList.remove("bc-active");
    document.documentElement.classList.remove("bc-col-resizing");
  }

  function onDoubleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (lastDragMoved) return; // the tail of two quick drags, not a reset ask
    var th = e.currentTarget.closest("th");
    var key = th && th.getAttribute("data-testid");
    if (key && widths.delete(key)) render();
  }

  function stopClick(e) {
    // The th holds Canvas's sort button; never let a handle click reach it.
    e.stopPropagation();
  }

  // ---- Handle injection ---------------------------------------------------

  function ensureHandles(table) {
    table.querySelectorAll("thead th[data-testid]").forEach(function (th) {
      if (th.querySelector(":scope > ." + HANDLE_CLASS)) return;
      var handle = document.createElement("div");
      handle.className = HANDLE_CLASS;
      handle.setAttribute("aria-hidden", "true");
      handle.addEventListener("pointerdown", onPointerDown);
      handle.addEventListener("pointermove", onPointerMove);
      handle.addEventListener("pointerup", onPointerEnd);
      handle.addEventListener("pointercancel", onPointerEnd);
      handle.addEventListener("dblclick", onDoubleClick);
      handle.addEventListener("click", stopClick);
      th.appendChild(handle);
    });
  }

  // Written around our own appendChild calls. Same microtask caveat as
  // course-tray.js: the guard only stops same-tick re-entry; real safety is
  // that ensureHandles is idempotent.
  var mutating = false;

  function scan() {
    var table = document.getElementById(TABLE_ID);
    if (!table) return;
    mutating = true;
    ensureHandles(table);
    mutating = false;
  }

  // Folder navigation is client-side routing and sorting re-renders the
  // whole thead, so watch for the table (and rebuilt headers) for as long as
  // the page lives.
  var observer = new MutationObserver(function () {
    if (mutating) return;
    scan();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
