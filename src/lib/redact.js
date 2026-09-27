// Better Canvas (Rice) — remove student names from text before it leaves the browser
//
// The Pangram check in SpeedGrader sends a submission's text to Pangram. Before
// it does, this replaces every email address with "[email]", every roster
// NetID (Canvas login ID, such as "jd45") with "[netid]", and every student
// name from the course roster with "[name]". The grader then reviews, and can
// edit, the text before it is sent, so this aims at the common forms of a
// name, not every possible one.
//
// Each roster name (its display name, sortable name "Doe, Jane Q.", and short
// name) gives:
//   - whole names, which match in any case: the full name, the sortable name
//     without its comma ("Doe Jane Q"), and every pair of its main words in
//     either order ("Jane Doe", "Doe Jane");
//   - single words, which must be capitalized in the text: each main word and
//     each half of a hyphenated one ("Jane", "Doe", "Mary" and "Jane" from
//     "Mary-Jane"), so ordinary lowercase words ("will", "may") stay.
// A main word has 2+ letters and is not a suffix ("Jr", "III") or a word the
// roster writes all in lowercase (a particle such as "van" or "de"). Words in
// parentheses or quotes (a nickname) count too.
//
// Names and text are compared with accents removed and letters such as ł, ø,
// ß spelled out, in both directions ("Jose Nunez" matches "José Núñez"); ä, ö,
// ü also match ae, oe, ue ("Müller" matches "Mueller"). An apostrophe may be
// any apostrophe mark or left out ("O'Brien", "O’Brien", "OBrien"), a hyphen
// may be a space or left out ("Do-Hyun", "Do Hyun", "Dohyun"), and the words
// of a whole name may be joined by a space (one line break at most), a
// hyphen, an underscore, or a dot ("Jane Doe", "jane_doe", "jane.doe").
//
// Exposed as window.BetterCanvasRedact so sibling content scripts can use it.

(function () {
  "use strict";

  var NAME_MARK = "[name]";
  var EMAIL_MARK = "[email]";
  var ID_MARK = "[netid]";
  var MIN_LETTERS = 2;
  var SUFFIX = /^(?:jr|sr|ii|iii|iv)$/i;

  // A name match may not touch a letter, mark, or digit on either side.
  var WORD_CHAR = "[\\p{L}\\p{M}\\p{N}]";

  var EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

  // Letters that NFKD does not split into a base letter and an accent, and
  // marks used as an apostrophe in names.
  var PLAIN_LETTERS = {
    "ł": "l", "Ł": "L", "ø": "o", "Ø": "O", // ł Ł ø Ø
    "ß": "ss", "ẞ": "SS", "ı": "i", // ß ẞ ı
    "đ": "d", "Đ": "D", "ð": "d", "Ð": "D", // đ Đ ð Ð
    "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE", // æ Æ œ Œ
    "þ": "th", "Þ": "TH", // þ Þ
    "’": "'", "‘": "'", "ʻ": "'", "ʼ": "'", "´": "'", "`": "'"
  };

  // The ae/oe/ue spelling of ä, ö, ü.
  var DIGRAPHS = { "ä": "ae", "ö": "oe", "ü": "ue", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue" };

  function tidy(value) {
    return String(value || "").normalize("NFC").replace(/\s+/g, " ").trim();
  }

  // NFKD also spells out full-width letters and ligatures.
  function foldChar(ch) {
    return PLAIN_LETTERS[ch] || ch.normalize("NFKD").replace(/\p{M}+/gu, "");
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

  // Terms are folded, so their apostrophes are all "'". The separator between
  // words is written with escapes (\x2d is a hyphen) so the hyphen step after
  // it does not rewrite it.
  function termPattern(term) {
    return escapeRegExp(term)
      .replace(/'/g, "'?")
      .replace(/ /g, "(?:\\x2d|\\u2010|\\u2011|_|\\.|(?=\\s)[^\\S\\n]*\\n?[^\\S\\n]*)")
      .replace(/[-‐‑]/g, "[-‐‑ ]?");
  }

  function termRegExp(terms) {
    var keys = Object.keys(terms).sort(function (a, b) {
      return b.length - a.length; // longest first: "Mary-Jane" before "Mary"
    });
    if (!keys.length) {
      return null;
    }
    return new RegExp(
      "(?<!" + WORD_CHAR + ")(?:" +
        keys.map(function (key) { return termPattern(terms[key]); }).join("|") +
        ")(?!" + WORD_CHAR + ")",
      "giu"
    );
  }

  // An upper-case letter anywhere ("Doe", "DOE", "deWitt"), or no cased
  // letter at all (a name in Chinese or Arabic).
  function capitalized(word) {
    return /\p{Lu}/u.test(word) || !/[\p{Lu}\p{Ll}]/u.test(word);
  }

  // The main words of a name, in order: 2+ letters, not a suffix, and not
  // written all in lowercase on the roster (a particle such as "van").
  function mainWords(name) {
    return name.split(/[\s,()"“”]+/)
      .map(function (word) {
        return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      })
      .filter(function (word) {
        return letterCount(word) >= MIN_LETTERS && !SUFFIX.test(word) && capitalized(word);
      });
  }

  // "Doe, Jane Q." -> "Jane Q. Doe"
  function firstLast(sortable) {
    var comma = sortable.indexOf(",");
    return comma === -1 ? sortable : tidy(sortable.slice(comma + 1) + " " + sortable.slice(0, comma));
  }

  function collectTerms(names) {
    var whole = Object.create(null);
    var single = Object.create(null);

    function add(term) {
      term = tidy(term);
      if (letterCount(term) < MIN_LETTERS) {
        return;
      }
      var digraphs = term.replace(/[äöüÄÖÜ]/g, function (ch) {
        return DIGRAPHS[ch];
      });
      [term, digraphs].forEach(function (form) {
        form = fold(form);
        (/ /.test(form) ? whole : single)[form.toLowerCase()] = form;
      });
    }

    names.forEach(function (raw) {
      var name = tidy(raw);
      if (!name) {
        return;
      }
      add(firstLast(name));
      add(name.replace(/\s*,\s*/, " "));
      var words = mainWords(firstLast(name));
      words.forEach(function (word, i) {
        add(word);
        word.split(/[-‐‑]/).forEach(function (half) {
          if (capitalized(half)) {
            add(half);
          }
        });
        words.forEach(function (other, j) {
          if (i !== j) {
            add(word + " " + other);
          }
        });
      });
    });
    return { whole: whole, single: single };
  }

  // The roster's NetIDs, lowercased. A login ID in email form ("jd45@rice.edu")
  // gives its part before the @, since a paper may write the bare NetID. An ID
  // shorter than 3 characters is left out.
  function netIdList(ids) {
    var unique = Object.create(null);
    (ids || []).forEach(function (id) {
      id = String(id || "").trim().split("@")[0];
      if (id.length >= 3) {
        unique[id.toLowerCase()] = true;
      }
    });
    return Object.keys(unique);
  }

  function idRegExp(list) {
    if (!list.length) {
      return null;
    }
    var keys = list.slice().sort(function (a, b) {
      return b.length - a.length;
    });
    return new RegExp(
      "(?<![\\p{L}\\p{N}])(?:" + keys.map(escapeRegExp).join("|") + ")(?![\\p{L}\\p{N}])",
      "giu"
    );
  }

  function anyCase() {
    return true;
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

  // Builds a redactor for the roster's names and NetIDs. redact(text) gives
  // { text, names, ids, emails }: the redacted text and how many names,
  // NetIDs, and email addresses it replaced. idCount is how many NetIDs it
  // can replace (0 when Canvas shared none).
  function createRedactor(names, ids) {
    var terms = collectTerms(names || []);
    var wholeNames = termRegExp(terms.whole);
    var singleWords = termRegExp(terms.single);
    var idList = netIdList(ids);
    var netIds = idRegExp(idList);

    function redact(text) {
      var emails = 0;
      var idCount = 0;
      var current = String(text || "").normalize("NFC").replace(EMAIL, function () {
        emails++;
        return EMAIL_MARK;
      });
      if (netIds) {
        current = current.replace(netIds, function () {
          idCount++;
          return ID_MARK;
        });
      }
      // Whole names first; the single-word pass then sees what is left.
      var wholePass = replaceTerms(current, wholeNames, anyCase);
      var singlePass = replaceTerms(wholePass.text, singleWords, capitalized);
      return {
        // "Jane Doe" may become "[name] [name]"; one person reads as one mark.
        text: singlePass.text.replace(/\[name\](?:[ \t]+\[name\])+/g, NAME_MARK),
        names: wholePass.count + singlePass.count,
        ids: idCount,
        emails: emails
      };
    }

    return {
      redact: redact,
      termCount: Object.keys(terms.whole).length + Object.keys(terms.single).length,
      idCount: idList.length
    };
  }

  window.BetterCanvasRedact = {
    createRedactor: createRedactor,
    NAME_MARK: NAME_MARK,
    EMAIL_MARK: EMAIL_MARK,
    ID_MARK: ID_MARK
  };
})();
