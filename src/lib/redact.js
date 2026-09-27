// Better Canvas (Rice) — remove student names from text before it leaves the browser
//
// The Pangram check in SpeedGrader sends a submission's text to Pangram. Before
// it does, every student name from the course roster is replaced with "[name]",
// every roster NetID (Canvas login ID, such as "jd45") with "[netid]", and
// every email address with "[email]".
//
// A roster name such as "Jane Q. Doe" (plus its sortable form "Doe, Jane Q."
// and its short name) becomes a set of terms: each whole name, its shorter
// forms ("Jane Doe"; see shortForms), the surname from the sortable form
// ("van der Berg"), and each part of two or more letters ("Jane", "Doe", the
// halves of a hyphenated name, a nickname in parentheses or quotes). A
// particle that the roster writes in lowercase inside the name ("van" in
// "Anna van der Berg", "al" in "Omar al-Farsi") is not a term on its own.
// Suffixes such as "Jr" and "III" are not terms. A hyphen in a term also
// matches a space or nothing, so "Do-Hyun" catches "Do Hyun" and "Dohyun",
// and a hyphenated word whose halves all have 3+ letters is also a
// whole-name term with spaces, so "Smith-Jones" catches a lowercase
// "smith jones" (but "In-Young" does not make the phrase "in young").
//
// Terms and text are compared in a folded form: accents removed, letters
// such as ł, ø, ß, and ı spelled out in plain Latin letters, full-width
// letters and ligatures spelled out, and the ʻokina read as an apostrophe. So
// the roster spelling "Jose Nunez" matches "José Núñez" in the text, and
// "Søren" matches "Soren", in either direction. A term with ä, ö, ü, å, or ø
// also gets its ae/oe/ue/aa spelling ("Müller" and "Mueller"), in either
// direction. An apostrophe may be left out ("OBrien" for "O'Brien"), and the
// words of a whole name may be joined by an underscore or a dot ("Jane_Doe").
//
// A match must stand alone as a word. A whole name (two or more words, such as
// "jane doe" or "van der Berg") matches in any case. A single word must have
// an upper-case letter ("Doe", "DOE", "deWitt"), or be in a script with no
// letter case. Names are proper nouns, so this keeps ordinary lowercase words
// intact when a student is named Will, May, or Rose, or has a name particle
// such as "de" or "al". Privacy comes first: a name part that is also a
// common capitalized word ("He" or "An" as a surname, "In" or "Do" as a name
// syllable) is replaced wherever it is capitalized, even where it opens a
// sentence as the ordinary word ("He grew up poor."). A lowercase single name
// (a nickname or a user name) is not replaced; the preview dialog says so and
// shows the text so the grader can read it. Email addresses are replaced
// first, so a lowercase name inside one is covered.
//
// Exposed as window.BetterCanvasRedact so sibling content scripts can use it.

(function () {
  "use strict";

  var NAME_MARK = "[name]";
  var EMAIL_MARK = "[email]";
  var ID_MARK = "[netid]";
  var MIN_LETTERS = 2;
  var SUFFIX = /^(?:jr|sr|ii|iii|iv)$/i;
  var PARTICLE = /^(?:al|bin|ibn|da|das|de|del|della|den|der|di|do|dos|du|el|het|la|las|le|les|lo|los|op|ten|ter|van|vom|von|zu|zum|zur)$/i;
  var MAX_SLOTS = 5;

  // Letters, combining marks, and digits make up a word. A name match may not
  // touch one of these on either side. An underscore is not one, so the names
  // in "Jane_Doe" still stand alone.
  var WORD_CHAR = "[\\p{L}\\p{M}\\p{N}]";

  var EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

  // Letters that NFKD does not split into a base letter and an accent, and
  // the marks used as an apostrophe in names (the Hawaiian ʻokina, the
  // modifier-letter apostrophe, a left single quote).
  var PLAIN_LETTERS = {
    "ʻ": "'", "ʼ": "'", "‘": "'", // ʻ ʼ ‘
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

  // NFKD also spells out full-width letters and ligatures ("Ｊａｎｅ", "ﬃ").
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

  // An apostrophe in a name may be straight, curly, or left out ("O'Brien",
  // "O’Brien", "OBrien"), and a hyphen may be any hyphen, one space, or
  // nothing ("Do-Hyun", "Do Hyun", "Dohyun"). The space inside a whole name
  // may be a hyphen, an underscore, or a dot ("smith-jones", "Jane_Doe",
  // "jane.doe"), or any run of whitespace with at most one line break: a
  // name can wrap to the next line, but a blank line ends it.
  function termPattern(term) {
    return escapeRegExp(term)
      .replace(/['’]/g, "['’]?")
      .replace(/ /g, "(?:\\u2010|\\u2011|\\x2d|_|\\.|(?=\\s)[^\\S\\n]*\\n?[^\\S\\n]*)")
      .replace(/[-‐‑]/g, "[-‐‑ ]?");
  }

  // One case-insensitive regex for the roster's NetIDs (Canvas login IDs,
  // such as "jd45"), each standing alone as a word. An ID shorter than 3
  // characters is left out, and one with an @ is an email address, which the
  // email pass already replaces.
  function idRegExp(ids) {
    var unique = Object.create(null);
    (ids || []).forEach(function (id) {
      id = String(id || "").trim();
      if (id.length >= 3 && id.indexOf("@") === -1) {
        unique[id.toLowerCase()] = id;
      }
    });
    var keys = Object.keys(unique).sort(function (a, b) {
      return b.length - a.length;
    });
    if (!keys.length) {
      return null;
    }
    return new RegExp(
      "(?<![\\p{L}\\p{N}])(?:" + keys.map(escapeRegExp).join("|") + ")(?![\\p{L}\\p{N}])",
      "giu"
    );
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

  // A particle the roster writes in lowercase ("van", "de", "al"). A
  // capitalized one may be a real name syllable ("Le" in "Jia Le Chen", "Do"
  // in "Do-Hyun Kim", "Bin" in "Su-Bin Park").
  function lowercaseParticle(word) {
    return PARTICLE.test(word) && !/\p{Lu}/u.test(word);
  }

  // The words of a name (in first-last order), without initials or suffixes.
  function nameWords(name) {
    return name.split(PART_SPLIT).map(trimEdges).filter(function (word) {
      return letterCount(word) >= MIN_LETTERS && !SUFFIX.test(word);
    });
  }

  // A name as slots, one for each word that is not a particle, holding the
  // units that word can stand for. The first unit is the word with the
  // particles just before it ("de la Cruz", "Da Silva", "dos Santos"); a
  // hyphenated word also has a unit for each half ("García" and "López" for
  // "García-López"), except a lowercase particle half ("al" in "al-Farsi"). A
  // particle that is the first word ("Van" in "Van Nguyen", "Le" in "Le Thi
  // Hoa") or has no word after it ("Le" in "Minh Anh Le") is a real name, so
  // it gets its own slot. "full" keeps a unit's particles; "bare" drops them.
  function nameSlots(words) {
    var slots = [];
    var pending = [];
    words.forEach(function (word, index) {
      if (index > 0 && PARTICLE.test(word)) {
        pending.push(word);
        return;
      }
      var slot = [{ full: pending.concat(word).join(" "), bare: word }];
      pending = [];
      var halves = word.split(/[-‐‑]/);
      if (halves.length > 1) {
        halves.forEach(function (half) {
          if (letterCount(half) >= MIN_LETTERS && !lowercaseParticle(half)) {
            slot.push({ full: half, bare: half });
          }
        });
      }
      slots.push(slot);
    });
    pending.forEach(function (word) {
      slots.push([{ full: word, bare: word }]);
    });
    return slots;
  }

  // Every ordered group of two or more slots, with one unit from each: all
  // groups for up to MAX_SLOTS slots, only pairs past that (to keep the term
  // list small).
  function slotGroups(slots) {
    var groups = [];
    function walk(index, group, pairsOnly) {
      if (index === slots.length || (pairsOnly && group.length === 2)) {
        if (group.length >= 2) {
          groups.push(group);
        }
        return;
      }
      walk(index + 1, group, pairsOnly);
      slots[index].forEach(function (unit) {
        walk(index + 1, group.concat([unit]), pairsOnly);
      });
    }
    walk(0, [], slots.length > MAX_SLOTS);
    return groups;
  }

  // The shorter forms of a name that a student often writes in a paper:
  //   - each unit that has particles: "de la Cruz";
  //   - every group of units (see slotGroups), with and without their
  //     particles: "Jane Doe" for "Jane Q. Doe", "John Smith" for "John Smith
  //     III", "María García López" for "María José García López", "Sofia de
  //     la Cruz" and "Sofia Cruz" for "Sofia Maria de la Cruz", "Anh Le" for
  //     "Minh Anh Le", "Ana García" for "Ana García-López", "David Zhang" for
  //     "Wei (David) Zhang".
  // A particle joins a group only with the word it belongs to, so "de la" or
  // "van der" alone in a paper is never taken for a name, and a group never
  // holds a word together with its own half ("García-López García").
  function shortForms(name) {
    var slots = nameSlots(nameWords(name));
    var forms = [];
    slots.forEach(function (slot) {
      if (slot[0].full !== slot[0].bare) {
        forms.push(slot[0].full);
      }
    });
    slotGroups(slots).forEach(function (group) {
      forms.push(group.map(function (unit) { return unit.full; }).join(" "));
      forms.push(group.map(function (unit) { return unit.bare; }).join(" "));
    });
    return forms;
  }

  // The second common spelling of ä, ö, ü, å, and ø ("Müller" and "Mueller"),
  // both ways: a roster "Mueller" also gets "Muller", which is how the folded
  // text spells "Müller" ("Oezdemir" gets "Ozdemir" the same way). The reverse
  // applies only to ae/oe/ue with a letter after it, and a made-up spelling
  // needs four or more letters, so a roster "Doe", "Noe", or "Haas" never
  // becomes the common word "Do", "No", or "Has".
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
    var singles = term.replace(/([aouAOU])e(?=\p{L})/gu, "$1");
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
      // Single words. A lowercase particle inside the name ("van" in "Anna van
      // der Berg") or as half of a hyphenated name ("al" in "al-Farsi") does
      // not identify anyone on its own, so it is not a term. A capitalized
      // one ("Le" in "Jia Le Chen", "Bin" in "Su-Bin Park"), or one that is
      // the first or last word ("Van Nguyen", "Minh Anh Le"), can be a real
      // name, so it is.
      var words = nameWords(ordered);
      words.forEach(function (word, index) {
        var edge = index === 0 || index === words.length - 1;
        if (edge || !lowercaseParticle(word)) {
          add(word);
        }
        var halves = word.split(/[-‐‑]/);
        if (halves.length > 1) {
          // "smith jones" for "Smith-Jones", in any case -- but only when
          // each half has 3+ letters, so "In-Young" never makes the phrase
          // "in young".
          if (halves.every(function (half) { return letterCount(half) >= 3; })) {
            add(halves.join(" "));
          }
          halves.forEach(function (half) {
            if (!lowercaseParticle(half)) {
              add(half);
            }
          });
        }
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

  // Builds a redactor for the roster's names and NetIDs. The returned
  // redact(text) gives { text, names, ids, emails }: the redacted text and
  // how many names, NetIDs, and email addresses it replaced.
  function createRedactor(names, ids) {
    var terms = collectTerms(names || []);
    // Whole names go first; the single-word pass then sees what is left.
    var wholeNames = termRegExp(terms.whole);
    var singleWords = termRegExp(terms.single);
    var netIds = idRegExp(ids);

    // NFC here too, so composed and decomposed accents in the text fold the
    // same way; lines and paragraphs are left as they are. Email addresses go
    // first (a NetID or a name inside one goes with it), then NetIDs, then
    // names.
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
      termCount: Object.keys(terms.whole).length + Object.keys(terms.single).length
    };
  }

  window.BetterCanvasRedact = {
    createRedactor: createRedactor,
    NAME_MARK: NAME_MARK,
    EMAIL_MARK: EMAIL_MARK,
    ID_MARK: ID_MARK
  };
})();
