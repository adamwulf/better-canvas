// Better Canvas (Rice) — "Courses" sidebar tray course list
//
// Canvas's global-nav "Courses" button opens a tray (rendered by React into
// #nav-tray-portal) that lists courses under "Published Courses" and
// "Unpublished Courses" headings. This script reorganizes that list into the
// same semester groups as the dashboard:
//   • Next semester
//   • Current semester
//   • Previous semester
//   • Older            (everything else, newest first)
//
// Published and unpublished courses live in the SAME list; unpublished ones
// are styled differently (muted + an "Unpublished" pill) rather than split out.
//
// The tray's own DOM is the data source — each row already carries the course
// link, name, published/unpublished section, and (for teachers) a
// "SIS ID: … | Term: <term name>" detail line. The tray mounts fresh every
// time it opens and loads its rows async, so a MutationObserver watches for
// the loaded list and swaps in our version. Rather than hiding one assumed
// wrapper element, each section heading and each course <ul> is hidden
// individually, so "All Courses" and the tray footer are never touched no
// matter how Canvas nests its sections.

(function () {
  "use strict";

  var Terms = window.BetterCanvasTerms;
  var Grouping = window.BetterCanvasGrouping;
  if (!Terms || !Grouping) {
    console.warn("[BetterCanvas] shared libraries missing; aborting tray list");
    return;
  }

  var LIST_ID = "better-canvas-tray-list";
  var TRAY_SELECTOR = ".navigation-tray-container.courses-tray";

  // Written around our own DOM writes. Note: MutationObserver callbacks are
  // delivered as microtasks, so by the time the observer fires for a write the
  // guard has usually been reset already — it only stops same-tick re-entry.
  // Real safety comes from processTray being idempotent: once our list is in
  // and the originals are hidden, re-running it changes nothing.
  var mutating = false;
  var colorsPromise = null; // lazy, cached course-color fetch

  // ---- Course colors (best-effort, fetched once) --------------------------

  function loadColors() {
    if (!colorsPromise) {
      colorsPromise = fetch("/api/v1/users/self/colors", {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      })
        .then(function (res) {
          if (!res.ok) {
            throw new Error("/api/v1/users/self/colors -> HTTP " + res.status);
          }
          return res.json();
        })
        .then(function (data) {
          return (data && data.custom_colors) || {};
        })
        .catch(function (err) {
          console.warn("[BetterCanvas] course colors unavailable", err);
          colorsPromise = null; // failure is not cached — retry on next open
          return {};
        });
    }
    return colorsPromise;
  }

  // ---- Find Canvas's own headings + course lists --------------------------

  function isOurs(node) {
    return !!node.closest("#" + LIST_ID);
  }

  // The "Published Courses" / "Unpublished Courses" section headings.
  // Deliberately NOT a bare /courses/i: that would also match the tray's
  // "Courses" title and the "All Courses" link.
  function sectionHeadings(tray) {
    var out = [];
    tray.querySelectorAll("h2, h3, h4").forEach(function (h) {
      if (!isOurs(h) && /(?:un)?published\s+courses/i.test(h.textContent || "")) {
        out.push(h);
      }
    });
    return out;
  }

  // Every <ul> holding course rows. "All Courses" links to /courses (no
  // trailing slash) so [href*='/courses/'] cannot match it.
  function courseLists(tray) {
    var out = [];
    tray.querySelectorAll("ul").forEach(function (ul) {
      if (!isOurs(ul) && ul.querySelector("li a[href*='/courses/']")) {
        out.push(ul);
      }
    });
    return out;
  }

  // A list is unpublished when the nearest section heading BEFORE it (in
  // document order — no sibling assumptions) says "Unpublished". Student trays
  // have no headings at all; those courses count as published.
  function listIsUnpublished(ul, headings) {
    var nearest = null;
    headings.forEach(function (h) {
      if (h.compareDocumentPosition(ul) & Node.DOCUMENT_POSITION_FOLLOWING) {
        nearest = h; // headings arrive in document order; last preceding wins
      }
    });
    return !!nearest && /unpublished/i.test(nearest.textContent || "");
  }

  // ---- Parse the tray's own rows ------------------------------------------

  // The term (teacher view only) appears in a detail line as
  // "SIS ID: … | Term: <name>". Capture stops at any later "|" field and the
  // line may sit in any element type, not just a <div>.
  function extractTermName(li) {
    var termName = "";
    li.querySelectorAll("div, span, p").forEach(function (node) {
      var m = (node.textContent || "").match(/(?:^|\|)\s*Term:\s*([^|]+)/);
      if (m) {
        termName = m[1].trim();
      }
    });
    return termName;
  }

  function parseCourses(tray, lists, headings) {
    var out = [];
    var seen = {}; // dedupe by id, in case a course <ul> ever nests in another
    lists.forEach(function (ul) {
      var unpublished = listIsUnpublished(ul, headings);
      ul.querySelectorAll("li").forEach(function (li) {
        var link = li.querySelector("a[href*='/courses/']");
        if (!link) {
          return;
        }
        var href = link.getAttribute("href") || "";
        var idMatch = href.match(/\/courses\/(\d+)/);
        var title = (link.textContent || "").trim();
        if (!title) {
          return;
        }
        var id = idMatch ? idMatch[1] : href;
        if (seen[id]) {
          return;
        }
        seen[id] = true;
        var termName = extractTermName(li);
        var parsed = Terms.parseTerm(termName);
        out.push({
          id: id,
          href: href,
          title: title,
          termName: termName,
          parsed: parsed,
          start: parsed.approxStart,
          end: parsed.approxEnd,
          published: !unpublished
        });
      });
    });
    return out;
  }

  // Fingerprint of everything that affects rendering: a same-length content
  // swap (course replaced, publish state flipped, term changed) still forces
  // a rebuild, not just a count change.
  function coursesSignature(courses) {
    return courses
      .map(function (c) {
        return c.id + ":" + (c.published ? "p" : "u") + ":" + (c.parsed.key || "");
      })
      .sort()
      .join(",");
  }

  // ---- Rendering ----------------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text != null) {
      node.textContent = text;
    }
    return node;
  }

  function renderRow(course, showTermLabel) {
    var item = el("li", "bc-row");

    var row = el("a", "bc-course-row");
    row.href = course.href;
    row.setAttribute("data-bc-course-id", course.id);
    if (!course.published) {
      row.classList.add("bc-unpublished");
    }

    var swatch = el("span", "bc-swatch");
    row.appendChild(swatch);

    var main = el("span", "bc-main");
    main.appendChild(el("span", "bc-title", course.title));

    // Sub-line: term label (Older only) + sub-term.
    var subParts = [];
    if (showTermLabel && course.parsed.label) {
      subParts.push(course.parsed.label);
    } else if (showTermLabel && course.termName) {
      subParts.push(course.termName);
    }
    if (course.parsed.subterm) {
      subParts.push(course.parsed.subterm);
    }
    if (subParts.length) {
      main.appendChild(el("span", "bc-sub", subParts.join(" · ")));
    }
    row.appendChild(main);

    if (!course.published) {
      var badges = el("span", "bc-badges");
      badges.appendChild(el("span", "bc-pill bc-pill-unpublished", "Unpublished"));
      row.appendChild(badges);
    }

    item.appendChild(row);
    return item;
  }

  function renderSection(title, tag, courses, showTermLabel) {
    if (!courses || !courses.length) {
      return null;
    }
    var section = el("section", "bc-section");

    // Real heading + real list, matching the semantics of the native tray
    // (screen readers navigate the tray dialog by heading / list).
    var header = el("div", "bc-section-header");
    header.appendChild(el("h3", "bc-section-title", title));
    if (tag) {
      header.appendChild(el("span", "bc-section-tag", tag));
    }
    var count = el("span", "bc-section-count", String(courses.length));
    count.appendChild(
      el("span", "bc-sr-only", courses.length === 1 ? " course" : " courses")
    );
    header.appendChild(count);
    section.appendChild(header);

    var list = el("ul", "bc-rows");
    courses.forEach(function (c) {
      list.appendChild(renderRow(c, showTermLabel));
    });
    section.appendChild(list);

    return section;
  }

  function buildList(courses) {
    var grouped = Grouping.group(courses, new Date());
    var buckets = grouped.buckets;
    var semMap = grouped.semMap;
    var rel = grouped.rel;

    var container = el("div", null);
    container.id = LIST_ID;

    function labelFor(key) {
      return key != null && semMap[key] ? semMap[key].label : "";
    }

    var sections = [
      renderSection(labelFor(rel.nextKey), "Next semester", buckets.next, false),
      renderSection(labelFor(rel.currentKey), "Current semester", buckets.current, false),
      renderSection(labelFor(rel.previousKey), "Previous semester", buckets.previous, false),
      renderSection("Older", null, buckets.older, true)
    ];
    sections.forEach(function (s) {
      if (s) {
        container.appendChild(s);
      }
    });

    return container;
  }

  function applyColors(container, colors) {
    if (!container.isConnected) {
      return;
    }
    var rows = container.querySelectorAll(".bc-course-row");
    rows.forEach(function (row) {
      var color = colors["course_" + row.getAttribute("data-bc-course-id")];
      if (color) {
        var swatch = row.querySelector(".bc-swatch");
        if (swatch) {
          swatch.style.background = color;
        }
        row.style.borderLeftColor = color;
      }
    });
  }

  // ---- Swap the tray's list for ours --------------------------------------

  // Hide each original heading/list element on its own (display is an
  // attribute mutation, invisible to our childList-only observer).
  function hideOriginals(headings, lists) {
    headings.concat(lists).forEach(function (node) {
      if (node.style.display !== "none") {
        node.style.display = "none";
        node.setAttribute("data-better-canvas-hidden", "");
      }
    });
  }

  function processTray(tray) {
    var headings = sectionHeadings(tray);
    var lists = courseLists(tray);
    var courses = parseCourses(tray, lists, headings);

    var sig = coursesSignature(courses);
    var existing = tray.querySelector("#" + LIST_ID);
    if (existing) {
      // Keep the current list when nothing changed — and also when a React
      // re-render momentarily parses to zero rows: removing the good list
      // then would blank the tray until the rows come back.
      if (!courses.length || existing.getAttribute("data-bc-signature") === sig) {
        // A React re-render can also un-hide the originals; keep them hidden.
        hideOriginals(headings, lists);
        return;
      }
      // The tray's course set changed after our first build (rows can arrive
      // in batches while the tray loads) — rebuild from the fresh parse.
      mutating = true;
      existing.remove();
      mutating = false;
    }

    if (!courses.length) {
      return; // rows not loaded yet
    }
    var anchor = headings[0] || lists[0];
    if (!anchor || !anchor.parentNode) {
      return;
    }

    mutating = true;
    try {
      var list = buildList(courses);
      list.setAttribute("data-bc-signature", sig);
      anchor.parentNode.insertBefore(list, anchor);
      hideOriginals(headings, lists);
      loadColors().then(function (colors) {
        applyColors(list, colors);
      });
    } finally {
      mutating = false;
    }
  }

  // ---- Watch for the tray opening / re-rendering --------------------------

  var observer = new MutationObserver(function () {
    if (mutating) {
      return;
    }
    var tray = document.querySelector(TRAY_SELECTOR);
    if (tray) {
      processTray(tray);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // In case the tray is already open (e.g. script injected late).
  var existing = document.querySelector(TRAY_SELECTOR);
  if (existing) {
    processTray(existing);
  }
})();
