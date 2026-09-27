// Better Canvas (Rice) — remove student names from text before it leaves the browser
//
// The Pangram check in SpeedGrader sends a submission's text to Pangram. Before
// it does, every student name from the course roster is replaced with "[name]"
// and every email address with "[email]".
//
// A roster name such as "Jane Q. Doe" (plus its sortable form "Doe, Jane Q."
// and its short name) becomes a set of terms: each whole name, its shorter
// forms ("Jane Doe"; see shortForms), the surname from the sortable form
// ("van der Berg"), and each part of two or more letters ("Jane", "Doe", the
// halves of a hyphenated name, a nickname in parentheses or quotes).
// Suffixes such as "Jr" and "III" are not terms.
//
// Terms and text are compared in a folded form: accents removed and letters
// such as ł, ø, ß, and ı spelled out in plain Latin letters. So the roster
// spelling "Jose Nunez" matches "José Núñez" in the text, and "Søren" matches
// "Soren", in either direction. A term with ä, ö, ü, å, or ø also gets its
// ae/oe/ue/aa spelling ("Müller" and "Mueller"), in either direction.
//
// A match must stand alone as a word. A whole name (two or more words, such as
// "jane doe" or "van der Berg") matches in any case. A single word must have
// an upper-case letter ("Doe", "DOE", "deWitt"), or be in a script with no
// letter case. Names are proper nouns, so this keeps ordinary lowercase words
// intact when a student is named Will, May, or Rose, or has a name particle
// such as "de" or "al". A lowercase single name (a nickname or a user name) is
// not replaced; the preview dialog says so and shows the text so the grader
// can read it. Email addresses are replaced first, so a lowercase name inside
// one is covered.
//
// Exposed as window.BetterCanvasRedact so sibling content scripts can use it.

(function () {
  "use strict";

  var NAME_MARK = "[name]";
  var EMAIL_MARK = "[email]";
  var MIN_LETTERS = 2;
  var SUFFIX = /^(?:jr|sr|ii|iii|iv)$/i;
  var PARTICLE = /^(?:al|bin|ibn|da|das|de|del|della|den|der|di|do|dos|du|el|la|las|le|les|lo|los|ten|ter|van|von|zu)$/i;
  var MAX_MAIN_WORDS = 5;

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

  // A name part: split on spaces, commas, and the parentheses and quotes of a
  // nickname ("Wei (David) Zhang", 'Robert "Bob" Smith').
  var PART_SPLIT = /[\s,()"“”]+/;

  function trimEdges(term) {
    return term.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  }

  // An upper-case letter anywhere ("Doe", "DOE", "deWitt"), or no cased
  // letter at all (a name in Chinese, Arabic, or Devanagari) -- not "will",
  // "de", or "van".
  function capitalized(word) {
    return /\p{Lu}/u.test(word) || !/[\p{Lu}\p{Ll}\p{Lt}]/u.test(word);
  }

  // The shorter forms of a name that a student often writes in a paper. The
  // main words are the capitalized ones that are not particles; initials and
  // suffixes are left out. The forms are:
  //   - every ordered group of two or more main words: "Jane Doe" for
  //     "Jane Q. Doe", "John Smith" for "John Smith III", "María García
  //     López" for "María José García López", "David Zhang" for
  //     "Wei (David) Zhang" (only pairs for a name with more than 5 main
  //     words, to keep the term list small);
  //   - every run of the name's own words that starts and ends on a main
  //     word, so particles inside it stay: "Maria Da Silva" for
  //     "Ana Maria Da Silva".
  // A particle is never part of a group on its own, so "de la" or "van der"
  // in a paper is never taken for a name.
  function shortForms(name) {
    var words = name.split(PART_SPLIT).map(trimEdges).filter(function (word) {
      return letterCount(word) >= MIN_LETTERS && !SUFFIX.test(word);
    });
    function isMain(word) {
      return capitalized(word) && !PARTICLE.test(word);
    }
    var main = words.filter(isMain);
    var forms = [];
    if (main.length <= MAX_MAIN_WORDS) {
      for (var mask = 1; mask < (1 << main.length); mask++) {
        var group = main.filter(function (word, index) {
          return mask & (1 << index);
        });
        if (group.length >= 2) {
          forms.push(group.join(" "));
        }
      }
    } else {
      for (var a = 0; a < main.length; a++) {
        for (var b = a + 1; b < main.length; b++) {
          forms.push(main[a] + " " + main[b]);
        }
      }
    }
    for (var i = 0; i < words.length; i++) {
      for (var j = i + 2; j < words.length && isMain(words[i]); j++) {
        if (isMain(words[j])) {
          forms.push(words.slice(i, j + 1).join(" "));
        }
      }
    }
    return forms;
  }

  // The second common spelling of ä, ö, ü, å, and ø ("Müller" and "Mueller"),
  // both ways: a roster "Mueller" also gets "Muller", which is how the folded
  // text spells "Müller". The reverse applies only to ae/oe/ue inside a word,
  // and a made-up spelling needs four or more letters, so a roster "Doe",
  // "Noe", or "Haas" never becomes the common word "Do", "No", or "Has".
  var DIGRAPHS = {
    "ä": "ae", "ö": "oe", "ü": "ue", "å": "aa", "ø": "oe",
    "Ä": "Ae", "Ö": "Oe", "Ü": "Ue", "Å": "Aa", "Ø": "Oe"
  };
  var VARIANT_MIN_LETTERS = 4;

  function spellings(term) {
    var forms = [term];
    var digraphs = term.replace(/[äöüåøÄÖÜÅØ]/g, function (ch) {
      return DIGRAPHS[ch];
    });
    var singles = term.replace(/(\p{L})([aouAOU])e(?=\p{L})/gu, "$1$2");
    [digraphs, singles].forEach(function (form) {
      if (form !== term && letterCount(form) >= VARIANT_MIN_LETTERS) {
        forms.push(form);
      }
    });
    return forms;
  }

  // Folded terms, split into whole names (with a space) and single words.
  function collectTerms(names) {
    var whole = Object.create(null);
    var single = Object.create(null);

    function add(term) {
      term = trimEdges(tidy(term));
      if (letterCount(term) < MIN_LETTERS || SUFFIX.test(term)) {
        return;
      }
      spellings(term).forEach(function (form) {
        form = fold(form);
        if (letterCount(form) >= MIN_LETTERS) {
          (/ /.test(form) ? whole : single)[form.toLowerCase()] = form;
        }
      });
    }

    names.forEach(function (raw) {
      var name = tidy(raw);
      if (!name) {
        return;
      }
      var ordered = firstLast(name) || name;
      add(name);
      add(ordered);
      add(surname(name));
      shortForms(ordered).forEach(add);
      name.split(PART_SPLIT).forEach(function (part) {
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
