// Better Canvas (Rice) — remove student names from text before it leaves the browser
//
// The Pangram check in SpeedGrader sends a submission's text to Pangram. Before
// it does, every student name from the course roster is replaced with "[name]"
// and every email address with "[email]", so no name data reaches Pangram.
//
// A roster name such as "Jane Q. Doe" (plus its sortable form "Doe, Jane Q."
// and its short name) becomes a set of terms: each whole name, and each part of
// two or more letters ("Jane", "Doe", and the halves of a hyphenated name). An
// accented part also matches without its accents ("José" matches "Jose").
//
// A match must stand alone as a word, and it must start with a capital letter
// (Title Case or ALL CAPS), or be spelled exactly as on the roster. Names are
// proper nouns, so this keeps ordinary lowercase words intact when a student is
// named Will, May, Rose, or Young. Lowercase names inside email addresses are
// covered because the whole address is replaced first.
//
// Exposed as window.BetterCanvasRedact so sibling content scripts can use it.

(function () {
  "use strict";

  var NAME_MARK = "[name]";
  var EMAIL_MARK = "[email]";
  var MIN_LETTERS = 2;

  // Letters, combining marks, and digits make up a word. A name match may not
  // touch one of these on either side.
  var WORD_CHAR = "[\\p{L}\\p{M}\\p{N}_]";

  var EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

  function tidy(value) {
    return String(value || "").normalize("NFC").replace(/\s+/g, " ").trim();
  }

  function stripAccents(value) {
    return value.normalize("NFD").replace(/\p{M}+/gu, "").normalize("NFC");
  }

  function letterCount(value) {
    var letters = value.match(/\p{L}/gu);
    return letters ? letters.length : 0;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Straight and curly apostrophes, and the hyphen variants, are the same
  // character in a name. Whitespace inside a whole name may be any run.
  function termPattern(term) {
    return escapeRegExp(term)
      .replace(/['’]/g, "['’]")
      .replace(/[-‐‑]/g, "[-‐‑]")
      .replace(/ /g, "\\s+");
  }

  // "Doe, Jane Q." -> "Jane Q. Doe"
  function firstLast(sortable) {
    var comma = sortable.indexOf(",");
    if (comma === -1) {
      return "";
    }
    return tidy(sortable.slice(comma + 1) + " " + sortable.slice(0, comma));
  }

  function collectTerms(names) {
    var terms = Object.create(null); // lowercased term -> roster spelling

    function add(term) {
      term = tidy(term).replace(/^[.,'’-]+|[.,'’-]+$/g, "");
      if (letterCount(term) < MIN_LETTERS) {
        return;
      }
      [term, stripAccents(term)].forEach(function (form) {
        var key = form.toLowerCase();
        if (!terms[key]) {
          terms[key] = form;
        }
      });
    }

    names.forEach(function (raw) {
      var name = tidy(raw);
      if (!name) {
        return;
      }
      add(name);
      add(firstLast(name));
      name.split(/[\s,]+/).forEach(function (part) {
        add(part);
        part.split(/[-‐‑]/).forEach(add);
      });
    });
    return terms;
  }

  // Builds a redactor for a list of roster names. The returned redact(text)
  // gives { text, names, emails }: the redacted text and how many names and
  // email addresses it replaced.
  // One regex for a set of terms, longest first, so "Mary-Jane" wins over
  // "Mary" at the same position.
  function termRegExp(terms, keys) {
    if (!keys.length) {
      return null;
    }
    keys.sort(function (a, b) {
      return b.length - a.length;
    });
    return new RegExp(
      "(?<!" + WORD_CHAR + ")(?:" +
        keys.map(function (key) { return termPattern(terms[key]); }).join("|") +
        ")(?!" + WORD_CHAR + ")",
      "giu"
    );
  }

  // Builds a redactor for a list of roster names. The returned redact(text)
  // gives { text, names, emails }: the redacted text and how many names and
  // email addresses it replaced.
  function createRedactor(names) {
    var terms = collectTerms(names || []);
    var keys = Object.keys(terms);
    var exact = Object.create(null);
    keys.forEach(function (key) {
      exact[terms[key]] = true;
    });

    // Whole names go first. A whole name that is rejected (such as "Will may"
    // for a student named Will May) is left as text, so the single-word pass
    // still sees each of its words.
    var wholeNames = termRegExp(terms, keys.filter(function (key) { return / /.test(key); }));
    var singleWords = termRegExp(terms, keys.filter(function (key) { return !/ /.test(key); }));

    function isName(match) {
      var words = match.split(/\s+/);
      var capitalized = words.every(function (word) {
        return /^\p{Lu}/u.test(word);
      });
      return capitalized || exact[words.join(" ")] === true;
    }

    // NFC here too, so composed and decomposed accents in the text match the
    // roster; lines and paragraphs are left as they are.
    function redact(text) {
      var result = { text: String(text || "").normalize("NFC"), names: 0, emails: 0 };

      function replaceNames(match) {
        if (!isName(match)) {
          return match; // a lowercase word such as "will" or "may"
        }
        result.names++;
        return NAME_MARK;
      }

      result.text = result.text.replace(EMAIL, function () {
        result.emails++;
        return EMAIL_MARK;
      });
      [wholeNames, singleWords].forEach(function (pattern) {
        if (pattern) {
          result.text = result.text.replace(pattern, replaceNames);
        }
      });
      // "Jane Doe" became "[name] [name]"; one person reads as one mark.
      result.text = result.text.replace(/\[name\](?:[ \t]+\[name\])+/g, NAME_MARK);
      return result;
    }

    return { redact: redact, termCount: keys.length };
  }

  window.BetterCanvasRedact = {
    createRedactor: createRedactor,
    NAME_MARK: NAME_MARK,
    EMAIL_MARK: EMAIL_MARK
  };
})();
