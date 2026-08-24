// Better Canvas (Rice) — term parsing & semester grouping
//
// Canvas term names look like:
//   "Fall Semester 2023 Full Term"
//   "Spring Semester 2026 MBA Term II"
//   "Summer Semester 2026 Summer Block D1 (10 Wk)"
//   ""  (some courses have no term)
//
// A "semester" is a (season, year) pair — e.g. "Fall 2026". Several sub-terms
// (Full Term, MBA Term II, Summer Block D1, ...) can share one semester.
//
// This library parses a term name, gives every semester a sortable key plus an
// approximate calendar start/end, and picks which semester is next / current /
// previous relative to a reference date. Approximate dates are only a fallback:
// when Canvas gives real term start/end dates, callers should prefer those.
//
// Exposed as window.BetterCanvasTerms so sibling content scripts can use it.

(function () {
  "use strict";

  // These seasons are in calendar order. A higher index is later in the year.
  // The approximate start/end dates (month is 0-based) show a typical academic
  // calendar. The code uses them only when Canvas gives no real term dates.
  // Each season "start" is also its fallback changeover date: on that date the
  // code makes the season "current" (see pickRelativeSemesters). The summer to
  // fall changeover is Aug 20. When Canvas gives a real term start,
  // switchoverFromRealStart moves the changeover to one day before it instead.
  var SEASONS = {
    winter: { index: 0, label: "Winter", start: [0, 2], end: [0, 31] },
    january: { index: 0, label: "January", start: [0, 2], end: [0, 31] },
    spring: { index: 1, label: "Spring", start: [0, 12], end: [4, 10] },
    summer: { index: 2, label: "Summer", start: [5, 1], end: [7, 15] },
    fall: { index: 3, label: "Fall", start: [7, 20], end: [11, 18] }
  };

  // REAL_START_LEAD_DAYS is the number of days before a real Canvas term start.
  // On that earlier day the code makes the semester "current". Canvas gives the
  // official first day; the new semester must read as current one day before it.
  var REAL_START_LEAD_DAYS = 1;

  // switchoverFromRealStart returns the changeover date for a real Canvas term
  // start. This date is REAL_START_LEAD_DAYS before the official start. It
  // returns null when there is no real date, so the caller can fall back to the
  // SEASONS approximation with "|| parsed.approxStart".
  function switchoverFromRealStart(realStart) {
    if (!realStart) {
      return null;
    }
    var d = new Date(realStart.getTime());
    d.setDate(d.getDate() - REAL_START_LEAD_DAYS);
    return d;
  }

  function seasonFromName(name) {
    var lower = name.toLowerCase();
    var keys = ["fall", "spring", "summer", "winter", "january"];
    for (var i = 0; i < keys.length; i++) {
      if (lower.indexOf(keys[i]) !== -1) {
        return keys[i];
      }
    }
    return null;
  }

  // Parse a raw Canvas term name into structured semester info.
  function parseTerm(rawName) {
    var raw = (rawName || "").trim();
    var result = {
      raw: raw,
      hasTerm: false,
      seasonKey: null,
      seasonLabel: "",
      seasonIndex: null,
      year: null,
      subterm: "",
      key: null,
      label: "",
      approxStart: null,
      approxEnd: null
    };

    if (!raw) {
      return result;
    }

    var seasonKey = seasonFromName(raw);
    var yearMatch = raw.match(/\b(19|20)\d{2}\b/);
    if (!seasonKey || !yearMatch) {
      // Not a recognizable season+year; treat as "no term" for grouping.
      return result;
    }

    var season = SEASONS[seasonKey];
    var year = parseInt(yearMatch[0], 10);

    result.hasTerm = true;
    result.seasonKey = seasonKey;
    result.seasonLabel = season.label;
    result.seasonIndex = season.index;
    result.year = year;
    result.key = year * 10 + season.index;
    result.label = season.label + " " + year;
    result.approxStart = new Date(year, season.start[0], season.start[1]);
    result.approxEnd = new Date(year, season.end[0], season.end[1]);

    // Everything after "<Season> Semester <Year>" is the sub-term detail.
    var stripped = raw
      .replace(/^\s*\w+\s+semester\s+\d{4}\s*/i, "")
      .replace(/^\s*\w+\s+\d{4}\s*/i, "")
      .trim();
    result.subterm = stripped;

    return result;
  }

  // Given the distinct semesters present, decide which is current / next /
  // previous relative to `now`.
  //
  // semesters: array of { key, start: Date, end: Date|null }
  // Returns { currentKey, nextKey, previousKey } (any may be null).
  function pickRelativeSemesters(semesters, now) {
    var out = { currentKey: null, nextKey: null, previousKey: null };
    if (!semesters || !semesters.length) {
      return out;
    }

    // Unique by key, sorted ascending in time.
    var byKey = {};
    semesters.forEach(function (s) {
      if (s && s.key != null) {
        byKey[s.key] = s;
      }
    });
    var sorted = Object.keys(byKey)
      .map(function (k) {
        return byKey[k];
      })
      .sort(function (a, b) {
        var sa = a.start ? a.start.getTime() : a.key;
        var sb = b.start ? b.start.getTime() : b.key;
        if (sa !== sb) {
          return sa - sb;
        }
        return a.key - b.key;
      });

    var nowMs = now.getTime();

    // Current = the latest semester that has already started. If today falls in
    // a gap between semesters, that is the most-recently-active one, which reads
    // naturally as "current" with the upcoming semester as "next".
    var currentIndex = -1;
    for (var i = 0; i < sorted.length; i++) {
      var start = sorted[i].start ? sorted[i].start.getTime() : null;
      if (start != null && start <= nowMs) {
        currentIndex = i;
      }
    }

    if (currentIndex === -1) {
      // Nothing has started yet; the earliest upcoming semester is "next".
      out.nextKey = sorted[0].key;
      return out;
    }

    out.currentKey = sorted[currentIndex].key;
    if (currentIndex - 1 >= 0) {
      out.previousKey = sorted[currentIndex - 1].key;
    }
    if (currentIndex + 1 < sorted.length) {
      out.nextKey = sorted[currentIndex + 1].key;
    }
    return out;
  }

  window.BetterCanvasTerms = {
    SEASONS: SEASONS,
    REAL_START_LEAD_DAYS: REAL_START_LEAD_DAYS,
    parseTerm: parseTerm,
    switchoverFromRealStart: switchoverFromRealStart,
    pickRelativeSemesters: pickRelativeSemesters
  };
})();
