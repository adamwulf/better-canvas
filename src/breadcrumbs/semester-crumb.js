// Better Canvas (Rice) — semester label on the course breadcrumb
//
// On every page inside a course, Canvas's top breadcrumb reads
//   UNIV 285 901 > Assignments
// and the course menu sidebar shows the full term name above the nav links
// (#section-tabs-header-subtitle, e.g. "Fall Semester 2026 Full Term").
// This script appends the short semester to the course crumb:
//   UNIV 285 901 (Fall 2026) > Assignments
//
// The term name comes from the sidebar subtitle when Canvas renders it. A
// course menu (#section-tabs) with no subtitle means the course has no named
// term, so nothing is added. Only pages that render no course menu at all fall
// back to one same-origin API call (GET /api/v1/courses/:id?include[]=term).
// The label is the season + year from BetterCanvasTerms.parseTerm; a term name
// with no season + year adds nothing, and neither does a crumb whose course
// name already contains the label. Pages with no breadcrumb (SpeedGrader,
// full-screen tools, non-HTML documents) are skipped before any work.
//
// Canvas re-renders the breadcrumb client-side on some pages (Files folder
// navigation, for example), so a MutationObserver re-applies the label. The
// apply step is idempotent: a crumb that already carries our label is left
// alone, so our own insert cannot loop the observer.

(function () {
  "use strict";

  var Terms = window.BetterCanvasTerms;
  if (!Terms) {
    console.warn("[BetterCanvas] term library missing; aborting semester crumb");
    return;
  }

  var MARK = "data-better-canvas-semester";

  var idMatch = location.pathname.match(/^\/courses\/(\d+)/);
  if (!idMatch || !document.getElementById("breadcrumbs")) {
    return;
  }
  var courseId = idMatch[1];
  var coursePath = "/courses/" + courseId;

  // ---- Term name ----------------------------------------------------------

  function termNameFromApi() {
    var url = "/api/v1" + coursePath + "?include[]=term";
    return fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error(url + " -> HTTP " + res.status);
        }
        return res.json();
      })
      .then(function (course) {
        return (course && course.term && course.term.name) || "";
      })
      .catch(function (err) {
        console.warn("[BetterCanvas] course term unavailable", err);
        return "";
      });
  }

  function loadTermName() {
    var subtitle = document.getElementById("section-tabs-header-subtitle");
    if (subtitle) {
      return Promise.resolve((subtitle.textContent || "").trim());
    }
    if (document.getElementById("section-tabs")) {
      return Promise.resolve(""); // course menu shown, but no named term
    }
    return termNameFromApi();
  }

  // ---- Breadcrumb ---------------------------------------------------------

  // The course crumb is the breadcrumb link to the course home itself. Match
  // on the resolved path (Canvas may write it relative or absolute) so the
  // current-page crumb ("/courses/:id/assignments") never matches.
  function findCourseCrumb() {
    var links = document.querySelectorAll("#breadcrumbs a");
    for (var i = 0; i < links.length; i++) {
      if (links[i].pathname.replace(/\/+$/, "") === coursePath) {
        return links[i];
      }
    }
    return null;
  }

  // The label goes in its own span after Canvas's name span (not inside it),
  // so Canvas's text is never rewritten and the label stays part of the link.
  function apply(label) {
    var crumb = findCourseCrumb();
    if (!crumb || crumb.querySelector("[" + MARK + "]")) {
      return;
    }
    var name = (crumb.textContent || "").toLowerCase();
    if (name.indexOf(label.toLowerCase()) !== -1) {
      return; // e.g. "UNIV 285 Fall 2026" already names its semester
    }
    var span = document.createElement("span");
    span.setAttribute(MARK, "");
    span.textContent = " (" + label + ")";
    crumb.appendChild(span);
  }

  // ---- Boot ---------------------------------------------------------------

  loadTermName()
    .then(function (termName) {
      var label = Terms.parseTerm(termName).label;
      if (!label) {
        return;
      }
      apply(label);
      new MutationObserver(function () {
        apply(label);
      }).observe(document.body, { childList: true, subtree: true });
    })
    .catch(function (err) {
      console.warn("[BetterCanvas] semester crumb failed", err);
    });
})();
