// Better Canvas (Rice) — semester bucketing shared by the dashboard list and
// the "Courses" sidebar tray.
//
// Takes courses that already carry a parsed term (see lib/terms.js) and splits
// them into four buckets relative to "now":
//   next / current / previous  — one semester each
//   older                      — everything else, newest first
//
// A course object must have: parsed (from Terms.parseTerm), title, and
// optionally start/end Dates (real Canvas term dates trump the approximation).
//
// Exposed as window.BetterCanvasGrouping so sibling content scripts can use it.

(function () {
  "use strict";

  var Terms = window.BetterCanvasTerms;

  // Returns { buckets: {next, current, previous, older}, rel, semMap }.
  function group(courses, now) {
    var semMap = {}; // key -> { key, label, start, end }
    courses.forEach(function (c) {
      var k = c.parsed.key;
      if (k == null) {
        return;
      }
      if (!semMap[k]) {
        semMap[k] = {
          key: k,
          label: c.parsed.label,
          start: c.start || c.parsed.approxStart,
          end: c.end || c.parsed.approxEnd
        };
      } else {
        if (c.start && (!semMap[k].start || c.start < semMap[k].start)) {
          semMap[k].start = c.start;
        }
        if (c.end && (!semMap[k].end || c.end > semMap[k].end)) {
          semMap[k].end = c.end;
        }
      }
    });

    var semesters = Object.keys(semMap).map(function (k) {
      return semMap[k];
    });
    var rel = Terms.pickRelativeSemesters(semesters, now);

    var buckets = { next: [], current: [], previous: [], older: [] };
    courses.forEach(function (c) {
      var k = c.parsed.key;
      if (k != null && k === rel.nextKey) {
        buckets.next.push(c);
      } else if (k != null && k === rel.currentKey) {
        buckets.current.push(c);
      } else if (k != null && k === rel.previousKey) {
        buckets.previous.push(c);
      } else {
        buckets.older.push(c);
      }
    });

    // Sort within a single-semester bucket: sub-term, then title.
    function bySubtermThenTitle(a, b) {
      var sa = a.parsed.subterm || "";
      var sb = b.parsed.subterm || "";
      if (sa !== sb) {
        return sa.localeCompare(sb);
      }
      return a.title.localeCompare(b.title);
    }
    buckets.next.sort(bySubtermThenTitle);
    buckets.current.sort(bySubtermThenTitle);
    buckets.previous.sort(bySubtermThenTitle);

    // Older: newest semester first; undated courses last; then by title.
    buckets.older.sort(function (a, b) {
      var ka = a.parsed.key;
      var kb = b.parsed.key;
      if (ka == null && kb == null) {
        return a.title.localeCompare(b.title);
      }
      if (ka == null) {
        return 1;
      }
      if (kb == null) {
        return -1;
      }
      if (ka !== kb) {
        return kb - ka; // descending
      }
      return a.title.localeCompare(b.title);
    });

    return { buckets: buckets, rel: rel, semMap: semMap };
  }

  window.BetterCanvasGrouping = {
    group: group
  };
})();
