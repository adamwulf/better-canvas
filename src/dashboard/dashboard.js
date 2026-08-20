// Better Canvas (Rice) — dashboard course list
//
// Replaces the dashboard's card grid with a compact, semester-grouped list:
//   • Next semester    (upcoming)
//   • Current semester  (in progress / most recently active)
//   • Previous semester
//   • Older            (everything else, newest first)
//
// Published and unpublished courses live in the SAME list; unpublished ones are
// styled differently (muted + an "Unpublished" pill) rather than split out.
//
// Data comes from Canvas's own authenticated JSON API. If that fails we fall
// back to scraping the already-rendered cards so the list still appears.

(function () {
  "use strict";

  var Terms = window.BetterCanvasTerms;
  var Grouping = window.BetterCanvasGrouping;
  if (!Terms || !Grouping) {
    console.warn("[BetterCanvas] shared libraries missing; aborting dashboard list");
    return;
  }

  var LIST_ID = "better-canvas-course-list";
  var ORIG_SELECTOR = "#DashboardCard_Container";

  var cachedCourses = null; // last successfully loaded course list, for re-render
  var mutating = false; // guard so our own DOM writes do not retrigger observers

  // ---- Canvas API helpers -------------------------------------------------

  function apiGet(path) {
    return fetch(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    }).then(function (res) {
      if (!res.ok) {
        throw new Error(path + " -> HTTP " + res.status);
      }
      return res.json();
    });
  }

  function termNameFromCard(card) {
    var t = card.term;
    if (typeof t === "string" && t) {
      return t;
    }
    if (t && typeof t === "object" && t.name) {
      return t.name;
    }
    return card.subtitle || "";
  }

  // Real term dates + workflow state, keyed by course id. Best-effort.
  function loadCoursesMap() {
    var url =
      "/api/v1/courses?include[]=term&per_page=100" +
      "&state[]=unpublished&state[]=available&state[]=completed";
    return apiGet(url)
      .then(function (list) {
        var map = {};
        (list || []).forEach(function (c) {
          var t = c.term || {};
          map[String(c.id)] = {
            termName: t.name || "",
            termStart: t.start_at || null,
            termEnd: t.end_at || null,
            workflowState: c.workflow_state || ""
          };
        });
        return map;
      })
      .catch(function (err) {
        console.warn("[BetterCanvas] course/term details unavailable", err);
        return {};
      });
  }

  // Per-user custom course colors, keyed as "course_<id>". Best-effort.
  function loadColors() {
    return apiGet("/api/v1/users/self/colors")
      .then(function (data) {
        return (data && data.custom_colors) || {};
      })
      .catch(function (err) {
        console.warn("[BetterCanvas] course colors unavailable", err);
        return {};
      });
  }

  function buildCourse(card, coursesMap, colors) {
    var id = String(card.id);
    var info = coursesMap[id] || {};
    var termName = info.termName || termNameFromCard(card);
    var parsed = Terms.parseTerm(termName);
    var realStart = info.termStart ? new Date(info.termStart) : null;
    var realEnd = info.termEnd ? new Date(info.termEnd) : null;

    var published;
    if (typeof card.published === "boolean") {
      published = card.published;
    } else if (info.workflowState) {
      published = info.workflowState === "available";
    } else {
      published = true;
    }

    return {
      id: id,
      href: card.href || "/courses/" + id,
      title: card.shortName || card.courseCode || card.originalName || "Course " + id,
      courseCode: card.courseCode || "",
      originalName: card.originalName || "",
      termName: termName,
      parsed: parsed,
      start: realStart || parsed.approxStart,
      end: realEnd || parsed.approxEnd,
      published: published,
      color: colors["course_" + id] || card.color || card.backgroundColor || null,
      enrollmentType: card.enrollmentType || ""
    };
  }

  function loadData() {
    return apiGet("/api/v1/dashboard/dashboard_cards").then(function (cards) {
      return Promise.all([loadCoursesMap(), loadColors()]).then(function (extra) {
        var coursesMap = extra[0];
        var colors = extra[1];
        return (cards || []).map(function (card) {
          return buildCourse(card, coursesMap, colors);
        });
      });
    });
  }

  // ---- DOM scrape fallback ------------------------------------------------

  function scrapeCards() {
    var els = document.querySelectorAll(".ic-DashboardCard");
    var out = [];
    els.forEach(function (el) {
      var titleEl = el.querySelector(".ic-DashboardCard__header-title");
      var linkEl = el.querySelector("a.ic-DashboardCard__link, a[href*='/courses/']");
      var termEl = el.querySelector(".ic-DashboardCard__header-term");
      var title = titleEl ? titleEl.textContent.trim() : "";
      if (!title) {
        return;
      }
      var href = linkEl ? linkEl.getAttribute("href") : "";
      var idMatch = href && href.match(/\/courses\/(\d+)/);
      var id = idMatch ? idMatch[1] : href || title;
      var termName = termEl
        ? (termEl.getAttribute("title") || termEl.textContent || "").trim()
        : "";
      var parsed = Terms.parseTerm(termName);
      var colorSpan = titleEl ? titleEl.querySelector("span[style*='color']") : null;
      var color = colorSpan && colorSpan.style.color ? colorSpan.style.color : null;
      out.push({
        id: String(id),
        href: href,
        title: title,
        courseCode: title,
        originalName: title,
        termName: termName,
        parsed: parsed,
        start: parsed.approxStart,
        end: parsed.approxEnd,
        published: true, // not reliably detectable from the DOM
        color: color,
        enrollmentType: ""
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

  var ROLE_LABELS = {
    TeacherEnrollment: "Teacher",
    TaEnrollment: "TA",
    DesignerEnrollment: "Designer",
    ObserverEnrollment: "Observer"
  };

  function renderRow(course, showTermLabel) {
    var row = el("a", "bc-course-row");
    row.href = course.href;
    if (course.color) {
      row.style.borderLeftColor = course.color;
    }
    if (!course.published) {
      row.classList.add("bc-unpublished");
    }

    var swatch = el("span", "bc-swatch");
    if (course.color) {
      swatch.style.background = course.color;
    }
    row.appendChild(swatch);

    var main = el("span", "bc-main");
    main.appendChild(el("span", "bc-title", course.title));

    // Sub-line: term label (Older only) + sub-term + teaching role.
    var subParts = [];
    if (showTermLabel && course.parsed.label) {
      subParts.push(course.parsed.label);
    } else if (showTermLabel && course.termName) {
      subParts.push(course.termName);
    }
    if (course.parsed.subterm) {
      subParts.push(course.parsed.subterm);
    }
    var role = ROLE_LABELS[course.enrollmentType];
    if (role) {
      subParts.push(role);
    }
    if (subParts.length) {
      main.appendChild(el("span", "bc-sub", subParts.join(" · ")));
    }
    row.appendChild(main);

    var badges = el("span", "bc-badges");
    if (!course.published) {
      badges.appendChild(el("span", "bc-pill bc-pill-unpublished", "Unpublished"));
    }
    row.appendChild(badges);

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
    var now = new Date();
    var grouped = Grouping.group(courses, now);
    var buckets = grouped.buckets;
    var semMap = grouped.semMap;
    var rel = grouped.rel;

    var container = el("div", null);
    container.id = LIST_ID;

    var head = el("div", "bc-list-head");
    head.appendChild(el("span", "bc-list-head-title", "Courses"));
    head.appendChild(
      el("span", "bc-list-head-count", courses.length + " total")
    );
    container.appendChild(head);

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

  function render(courses) {
    mutating = true;
    try {
      var existing = document.getElementById(LIST_ID);
      if (existing) {
        existing.remove();
      }
      var list = buildList(courses);
      var anchor = document.querySelector(ORIG_SELECTOR);
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(list, anchor);
        anchor.style.display = "none";
        anchor.setAttribute("data-better-canvas-hidden", "");
      } else {
        var fallback =
          document.querySelector("#dashboard, #content, .ic-Dashboard-header__layout") ||
          document.body;
        fallback.insertBefore(list, fallback.firstChild);
      }
    } finally {
      mutating = false;
    }
  }

  // ---- Keep our list in place across Canvas re-renders --------------------

  function startObserver() {
    var observer = new MutationObserver(function () {
      if (mutating) {
        return;
      }
      var anchor = document.querySelector(ORIG_SELECTOR);
      if (anchor && anchor.style.display !== "none") {
        mutating = true;
        anchor.style.display = "none";
        anchor.setAttribute("data-better-canvas-hidden", "");
        mutating = false;
      }
      if (cachedCourses && !document.getElementById(LIST_ID)) {
        render(cachedCourses);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---- Boot ---------------------------------------------------------------

  function waitFor(selector, timeoutMs) {
    return new Promise(function (resolve) {
      var found = document.querySelector(selector);
      if (found) {
        resolve(found);
        return;
      }
      var done = false;
      var obs = new MutationObserver(function () {
        var elp = document.querySelector(selector);
        if (elp && !done) {
          done = true;
          obs.disconnect();
          resolve(elp);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      if (timeoutMs) {
        setTimeout(function () {
          if (!done) {
            done = true;
            obs.disconnect();
            resolve(document.querySelector(selector));
          }
        }, timeoutMs);
      }
    });
  }

  Promise.all([
    waitFor(ORIG_SELECTOR, 15000),
    loadData().catch(function (err) {
      console.warn("[BetterCanvas] dashboard API load failed", err);
      return null;
    })
  ]).then(function (results) {
    var courses = results[1];
    if (!courses || !courses.length) {
      courses = scrapeCards();
    }
    if (!courses.length) {
      console.warn("[BetterCanvas] no courses found; leaving dashboard unchanged");
      return;
    }
    cachedCourses = courses;
    render(courses);
    startObserver();
  });
})();
