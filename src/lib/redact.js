// Better Canvas (Rice) — remove student names from text before it leaves the browser
//
// The Pangram check in SpeedGrader sends a submission's text to Pangram. Before
// it does, every student name from the course roster is replaced with "[name]"
// and every email address with "[email]".
//
// A roster name such as "Jane Q. Doe" (plus its sortable form "Doe, Jane Q."
// and its short name) becomes a set of terms: each whole name, its first and
// last word ("Jane Doe"), the surname from the sortable form ("van der
// Berg"), and each part of two or more letters ("Jane", "Doe", and the halves
// of a hyphenated name). Suffixes such as "Jr" and "III" are not terms.
//
// Terms and text are compared in a folded form: accents removed and letters
// such as ł, ø, ß, and ı spelled out in plain Latin letters. So the roster
// spelling "Jose Nunez" matches "José Núñez" in the text, and "Søren" matches
// "Soren", in either direction.
//
// A match must stand alone as a word. A whole name (two or more words, such as
// "jane doe" or "van der Berg") matches in any case. A single word must start
// with a capital letter (Title Case or ALL CAPS) in one of its hyphen or
// apostrophe parts ("Doe", "DOE", "al-Farsi"). Names are proper nouns, so this
// keeps ordinary lowercase words intact when a student is named Will, May, or
// Rose, or has a name particle such as "de" or "al". A lowercase single name
// (a nickname or a user name) is not replaced; the preview shows the text so
// the grader can see it. Email addresses are replaced first, so a lowercase
// name inside one is covered.
//
// Exposed as window.BetterCanvasRedact so sibling content scripts can use it.

(function () {
  "use strict";

  var NAME_MARK = "[name]";
  var EMAIL_MARK = "[email]";
  var MIN_LETTERS = 2;
  var SUFFIX = /^(?:jr|sr|ii|iii|iv)$/i;

  // Letters, combining marks, and digits make up a word. A name match may not
  // touch one of these on either side.
  var WORD_CHAR = "[\\p{L}\\p{M}\\p{N}_]";

  var EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

  // Letters that NFD does not split into a base letter and an accent.
  var PLAIN_LETTERS = {
    "ł": "l", "Ł": "L", // ł Ł
    "ø": "o", "Ø": "O", // ø Ø
    "ß": "ss", "ẞ": "SS", // ß ẞ
    "ı": "i", // ı (dotless i)
    "đ": "d", "Đ": "D", // đ Đ
    "ð": "d", "Ð": "D", // ð Ð
    "æ": "ae", "Æ": "AE", // æ Æ
    "œ": "oe", "Œ": "OE", // œ Œ
    "þ": "th", "Þ": "TH" // þ Þ
  };

  function tidy(value) {
    return String(value || "").normalize("NFC").replace(/\s+/g, " ").trim();
  }

  function foldChar(ch) {
    return PLAIN_LETTERS[ch] || ch.normalize("NFD").replace(/\p{M}+/gu, "");
  }

  function fold(value) {
    return Array.from(value, foldChar).join("");
  }

  // The folded text plus, for each of its UTF-16 units, the index of the
  // original character it came from, so a match in the folded text maps back
  // to the same span of the original.
  function foldWithMap(text) {
    var folded = "";
    var map = [];
    for (var i = 0; i < text.length; ) {
      var ch = String.fromCodePoint(text.codePointAt(i));
      var out = foldChar(ch);
      for (var k = 0; k < out.length; k++) {
        map.push(i);
      }
      folded += out;
      i += ch.length;
    }
    map.push(text.length);
    return { folded: folded, map: map };
  }

  function letterCount(value) {
    var letters = value.match(/\p{L}/gu);
    return letters ? letters.length : 0;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Straight and curly apostrophes, and the hyphen variants, are the same
  // character in a name. The space inside a whole name may be any run of
  // whitespace with at most one line break: a name can wrap to the next line,
  // but a blank line ends it.
  function termPattern(term) {
    return escapeRegExp(term)
      .replace(/['’]/g, "['’]")
      .replace(/[-‐‑]/g, "[-‐‑]")
      .replace(/ /g, "(?=\\s)[^\\S\\n]*\\n?[^\\S\\n]*");
  }

  // "Doe, Jane Q." -> "Jane Q. Doe"
  function firstLast(sortable) {
    var comma = sortable.indexOf(",");
    return comma === -1 ? "" : tidy(sortable.slice(comma + 1) + " " + sortable.slice(0, comma));
  }

  // "van der Berg, Anna" -> "van der Berg"
  function surname(sortable) {
    var comma = sortable.indexOf(",");
    return comma === -1 ? "" : sortable.slice(0, comma);
  }

  // "Jane Q. Doe" -> "Jane Doe", "John A. Smith III" -> "John Smith": how a
  // student often writes a roster name that has a middle name.
  function firstAndLast(name) {
    var words = name.split(" ").filter(function (word) {
      return !SUFFIX.test(word.replace(/[.,]/g, ""));
    });
    return words.length >= 3 ? words[0] + " " + words[words.length - 1] : "";
  }

  // Folded terms, split into whole names (with a space) and single words.
  function collectTerms(names) {
    var whole = Object.create(null);
    var single = Object.create(null);

    function add(term) {
      term = fold(tidy(term).replace(/^[.,'’-]+|[.,'’-]+$/g, ""));
      if (letterCount(term) < MIN_LETTERS || SUFFIX.test(term)) {
        return;
      }
      (/ /.test(term) ? whole : single)[term.toLowerCase()] = term;
    }

    names.forEach(function (raw) {
      var name = tidy(raw);
      if (!name) {
        return;
      }
      var ordered = firstLast(name) || name;
      add(name);
      add(ordered);
      add(firstAndLast(ordered));
      add(surname(name));
      name.split(/[\s,]+/).forEach(function (part) {
        add(part);
        part.split(/[-‐‑]/).forEach(add);
      });
    });
    return { whole: whole, single: single };
  }

  // One regex for a set of terms, longest first, so "Mary-Jane" wins over
  // "Mary" at the same position.
  function termRegExp(terms) {
    var keys = Object.keys(terms);
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

  function anyCase() {
    return true;
  }

  // "Doe", "DOE", "al-Farsi", "d'Artagnan" -- not "will" or "de".
  function capitalized(word) {
    return word.split(/[-‐‑'’]/).some(function (part) {
      return /^\p{Lu}/u.test(part);
    });
  }

  // Replaces each match of pattern (run on the folded text) that accept()
  // allows, judged on the original spelling. Returns the new text and count.
  function replaceTerms(text, pattern, accept) {
    if (!pattern) {
      return { text: text, count: 0 };
    }
    var folded = foldWithMap(text);
    var out = "";
    var last = 0;
    var count = 0;
    var match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(folded.folded)) !== null) {
      var start = folded.map[match.index];
      var end = folded.map[match.index + match[0].length];
      if (accept(text.slice(start, end))) {
        out += text.slice(last, start) + NAME_MARK;
        last = end;
        count++;
      }
    }
    return { text: out + text.slice(last), count: count };
  }

  // Builds a redactor for a list of roster names. The returned redact(text)
  // gives { text, names, emails }: the redacted text and how many names and
  // email addresses it replaced.
  function createRedactor(names) {
    var terms = collectTerms(names || []);
    // Whole names go first; the single-word pass then sees what is left.
    var wholeNames = termRegExp(terms.whole);
    var singleWords = termRegExp(terms.single);

    // NFC here too, so composed and decomposed accents in the text fold the
    // same way; lines and paragraphs are left as they are.
    function redact(text) {
      var emails = 0;
      var current = String(text || "").normalize("NFC").replace(EMAIL, function () {
        emails++;
        return EMAIL_MARK;
      });
      var wholePass = replaceTerms(current, wholeNames, anyCase);
      var singlePass = replaceTerms(wholePass.text, singleWords, capitalized);
      return {
        // "Jane Doe" may become "[name] [name]"; one person reads as one mark.
        text: singlePass.text.replace(/\[name\](?:[ \t]+\[name\])+/g, NAME_MARK),
        names: wholePass.count + singlePass.count,
        emails: emails
      };
    }

    return {
      redact: redact,
      termCount: Object.keys(terms.whole).length + Object.keys(terms.single).length
    };
  }

  window.BetterCanvasRedact = {
    createRedactor: createRedactor,
    NAME_MARK: NAME_MARK,
    EMAIL_MARK: EMAIL_MARK
  };
})();
