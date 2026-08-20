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
// the loaded list and swaps in our version.

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

  var mutating = false; // guard so our own DOM writes do not retrigger observers
  var colorsPromise = null; // lazy, cached course-color fetch

  // ---- Course colors (best-effort, fetched once) --------------------------

  function loadColors() {
    if (!colorsPromise) {
      colorsPromise = fetch("/api/v1/users/self/colors", {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      })
        .then(function (res) {
          return res.ok ? res.json() : {};
        })
        .then(function (data) {
          return (data && data.custom_colors) || {};
        })
        .catch(function (err) {
          console.warn("[BetterCanvas] course colors unavailable", err);
          return {};
        });
    }
    return colorsPromise;
  }

  // ---- Parse the tray's own rows ------------------------------------------

  // Is this <li> under an "Unpublished Courses" heading? The heading is a
  // sibling <h3> before the list; walk back from the containing <ul>.
  function isUnpublished(li) {
    var ul = li.closest("ul");
    var node = ul ? ul.previousElementSibling : null;
    while (node) {
      if (/^h\d$/i.test(node.tagName)) {
        return /unpublished/i.test(node.textContent || "");
      }
      node = node.previousElementSibling;
    }
    return false;
  }

  function parseCourses(tray) {
    var out = [];
    var items = tray.querySelectorAll("li");
    items.forEach(function (li) {
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

      // The detail lines are sibling <div>s of the link; the term (teacher
      // view only) appears as "SIS ID: … | Term: <name>".
      var termName = "";
      var divs = li.querySelectorAll("div");
      divs.forEach(function (d) {
        var m = (d.textContent || "").match(/(?:^|\|)\s*Term:\s*(.+?)\s*$/);
        if (m) {
          termName = m[1];
        }
      });

      var parsed = Terms.parseTerm(termName);
      out.push({
        id: idMatch ? idMatch[1] : href,
        href: href,
        title: title,
        termName: termName,
        parsed: parsed,
        start: parsed.approxStart,
        end: parsed.approxEnd,
        published: !isUnpublished(li)
      });
    });
    return out;
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

    return row;
  }

  function renderSection(title, tag, courses, showTermLabel) {
    if (!courses || !courses.length) {
      return null;
    }
    var section = el("section", "bc-section");

    var header = el("div", "bc-section-header");
    header.appendChild(el("span", "bc-section-title", title));
    if (tag) {
      header.appendChild(el("span", "bc-section-tag", tag));
    }
    header.appendChild(el("span", "bc-section-count", String(courses.length)));
    section.appendChild(header);

    var list = el("div", "bc-rows");
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

  // The published/unpublished sections live in one wrapper element (the shared
  // parent of the <h3> headings / the course <ul>s). Hide that wrapper and put
  // our grouped list in its place, leaving "All Courses" etc. untouched.
  function sectionWrapper(tray) {
    var headings = tray.querySelectorAll("h3");
    for (var i = 0; i < headings.length; i++) {
      if (/courses/i.test(headings[i].textContent || "")) {
        return headings[i].parentElement;
      }
    }
    // Student trays may have no headings — fall back to the course list itself.
    var link = tray.querySelector("ul li a[href*='/courses/']");
    var ul = link ? link.closest("ul") : null;
    return ul ? ul.parentElement : null;
  }

  function processTray(tray) {
    if (tray.querySelector("#" + LIST_ID)) {
      // Already ours — but a React re-render can un-hide the original wrapper.
      var hidden = sectionWrapper(tray);
      if (hidden && hidden.style.display !== "none") {
        mutating = true;
        hidden.style.display = "none";
        hidden.setAttribute("data-better-canvas-hidden", "");
        mutating = false;
      }
      return;
    }
    var courses = parseCourses(tray);
    if (!courses.length) {
      return; // rows not loaded yet
    }
    var wrapper = sectionWrapper(tray);
    if (!wrapper || !wrapper.parentNode) {
      return;
    }

    mutating = true;
    try {
      var list = buildList(courses);
      wrapper.parentNode.insertBefore(list, wrapper);
      wrapper.style.display = "none";
      wrapper.setAttribute("data-better-canvas-hidden", "");
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
