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
// words of a whole name may be joined by an underscore, a dot, or nothing
// ("Jane_Doe", "jane.doe", "JaneDoe", "delacruz"; see wholeName).
//
// A match must stand alone as a word: no letter may touch it, but a digit or
// an underscore may ("@JaneDoe2026"), except for a single-word name of fewer
// than 4 letters (see singleName). A whole name (two or more words, such as
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
  var JOINED_MIN_LETTERS = 6;

  // Letters and combining marks make up a word. A name match may not touch
  // one of these on either side. A digit or an underscore may touch it, so
  // the names in "Jane_Doe" and "@JaneDoe2026" still stand alone.
  var WORD_CHAR = "[\\p{L}\\p{M}]";

  var EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

  // Letters that NFKD does not split into a base letter and an accent, and
  // the marks used as an apostrophe in names (the Hawaiian ʻokina, the
  // modifier-letter apostrophe, a left single quote, an acute accent, a
  // backtick: "O´Brien", "D`Souza").
  var PLAIN_LETTERS = {
    "ʻ": "'", "ʼ": "'", "‘": "'", "´": "'", "`": "'", // ʻ ʼ ‘ ´ `
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
  // "O’Brien", "OBrien"), and a hyphen may be any hyphen, one space, an
  // underscore, a dot, or nothing ("Do-Hyun", "Do Hyun", "Dohyun",
  // "garcia_lopez"). The space inside a whole name may be a hyphen, an
  // underscore, a dot, nothing ("smith-jones", "Jane_Doe", "jane.doe",
  // "JaneDoe"), or any run of whitespace with at most one line break: a name
  // can wrap to the next line, but a blank line ends it.
  function termPattern(term) {
    return escapeRegExp(term)
      .replace(/['’]/g, "['’]?")
      .replace(/ /g, "(?:\\u2010|\\u2011|\\x2d|_|\\.|(?=\\s)[^\\S\\n]*\\n?[^\\S\\n]*)?")
      .replace(/[-‐‑]/g, "[-‐‑ _.]?");
  }

  // The roster's NetIDs (Canvas login IDs, such as "jd45"), lowercased and
  // without repeats. A login ID in email form ("jd45@rice.edu") gives its
  // local part too, since a paper may write the bare NetID; the email pass
  // replaces the full address. An ID shorter than 3 characters is left out.
  function netIdList(ids) {
    var unique = Object.create(null);
    (ids || []).forEach(function (id) {
      id = String(id || "").trim();
      var at = id.indexOf("@");
      if (at !== -1) {
        id = id.slice(0, at);
      }
      if (id.length >= 3) {
        unique[id.toLowerCase()] = true;
      }
    });
    return Object.keys(unique);
  }

  // One case-insensitive regex for the NetIDs, each standing alone as a word.
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
  //   - each unit that has particles: "de la Cruz" (which, as a whole name,
  //     also catches "DeLaCruz" and "delacruz");
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

  // Folded terms, split into whole names (with a space) and single words,
  // plus two sets of lowercase joined keys that wholeName() treats with care:
  // the halves of hyphenated names, and short surname-first names.
  function collectTerms(names) {
    var whole = Object.create(null);
    var single = Object.create(null);
    var joinedHalves = Object.create(null);
    var reversedShort = Object.create(null);

    // plain: skip the second spellings (see spellings), for a term made by
    // joining two words, where an ae/oe/ue across the join is no umlaut.
    function add(term, plain) {
      term = trimEdges(tidy(term));
      if (letterCount(term) < MIN_LETTERS || SUFFIX.test(term)) {
        return;
      }
      (plain ? [term] : spellings(term)).forEach(function (form) {
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
      // Surname first, no comma: "Kim Seoyeon Grace", and the surname with
      // each given word ("Kim Seoyeon", "Doe Jane" for "Doe, Jane Q.").
      var reversed = [name.replace(/\s*,\s*/, " ")];
      var last = surname(name);
      if (last) {
        nameWords(name.slice(name.indexOf(",") + 1)).forEach(function (given) {
          reversed.push(last + " " + given);
        });
      }
      reversed.forEach(function (form) {
        add(form);
        // Joined, a short one may be an English word ("Like" for "Li, Ke",
        // "Human" for "Hu, Man"); wholeName() treats it with care.
        var key = fold(tidy(form)).replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
        if (letterCount(key) < JOINED_MIN_LETTERS) {
          reversedShort[key] = true;
        }
      });
      add(last);
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
        // Two neighboring words joined, as one capitalized word: "Subin" for
        // "Su Bin Park", "Jiale" for "Jia Le Chen" -- a capitalized syllable
        // that looks like a particle joins its next word as a unit, so no
        // group holds this pair. Two lowercase particles ("van der") never
        // make a pair.
        var next = words[index + 1];
        if (next && !(lowercaseParticle(word) && lowercaseParticle(next))) {
          add(word + next, true); // "MaeKing" must not become "MaKing"
        }
        var halves = word.split(/[-‐‑]/);
        if (halves.length > 1) {
          // "smith jones" for "Smith-Jones", in any case -- but only when
          // each half has 3+ letters, so "In-Young" never makes the phrase
          // "in young".
          if (halves.every(function (half) { return letterCount(half) >= 3; })) {
            add(halves.join(" "));
            // Its halves joined in lowercase ("wanting" for "Wan-Ting") may
            // be an ordinary word, so wholeName() does not take that form.
            joinedHalves[fold(halves.join("")).toLowerCase()] = true;
          }
          halves.forEach(function (half) {
            if (!lowercaseParticle(half)) {
              add(half);
            }
          });
        }
      });
    });
    return { whole: whole, single: single, joinedHalves: joinedHalves, reversedShort: reversedShort };
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

  // True when text[start, end) is part of a path, URL, file name, or handle:
  // the run of non-space characters around it holds an @ / \ _ or =, or a
  // dot between two letters or digits ("seoyeon-essay.docx", "seoyeon.2026",
  // "?user=seoyeon").
  function inPathOrHandle(text, start, end) {
    var from = start;
    var to = end;
    while (from > 0 && !/\s/.test(text[from - 1])) {
      from--;
    }
    while (to < text.length && !/\s/.test(text[to])) {
      to++;
    }
    var token = text.slice(from, to);
    return /[@\/\\_=]/.test(token) || /[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(token);
  }

  // A single-word name must be capitalized. One of fewer than 4 letters that
  // touches a digit is more likely a chemical formula or a code ("Li2O" for a
  // student named Li) than a name, so it is kept.
  function singleName(word, text, start) {
    if (!capitalized(word)) {
      return false;
    }
    var end = start + word.length;
    return letterCount(word) >= 4 ||
      !(/\p{N}/u.test(text[start - 1] || "") || /\p{N}/u.test(text[end] || ""));
  }

  // Replaces each match of pattern (run on the folded text) that accept()
  // allows, judged on the original spelling and its place in the text.
  // Returns the new text and count.
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
      if (accept(text.slice(start, end), text, start)) {
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
    var idList = netIdList(ids);
    var netIds = idRegExp(idList);

    // A whole name matches in any case. Written with no space at all, it is
    // a name when it is part of a path, URL, file name, or handle
    // ("/Users/seoyeon/", "@liwei", "maryjane_essay.pdf") or touches a digit
    // ("liwei2026"), or when it has a capital ("JaneDoe", "Jimin" for "Ji
    // Min") -- except that a short surname-first join with a single capital
    // may be an English word ("Like" for "Li, Ke", "Human" for "Hu, Man"), so
    // it needs a second capital ("LiKe"). In lowercase prose it needs 6+
    // letters ("janedoe", "delacruz"), so a short join ("anle" for "An Le")
    // is not taken for a word, and it may not be just the two halves of one
    // hyphenated name, which may be an ordinary word ("wanting" for
    // "Wan-Ting").
    function wholeName(match, text, start) {
      if (/[\s\-‐‑_.'’]/.test(match)) {
        return true;
      }
      var end = start + match.length;
      if (inPathOrHandle(text, start, end) ||
          /\p{N}/u.test(text[start - 1] || "") || /\p{N}/u.test(text[end] || "")) {
        return true;
      }
      var key = fold(match).toLowerCase();
      if (capitalized(match)) {
        return !terms.reversedShort[key] || (match.match(/\p{Lu}/gu) || []).length >= 2;
      }
      return letterCount(match) >= JOINED_MIN_LETTERS && !terms.joinedHalves[key];
    }

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
      var wholePass = replaceTerms(current, wholeNames, wholeName);
      var singlePass = replaceTerms(wholePass.text, singleWords, singleName);
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
      idCount: idList.length // NetIDs it can replace
    };
  }

  window.BetterCanvasRedact = {
    createRedactor: createRedactor,
    NAME_MARK: NAME_MARK,
    EMAIL_MARK: EMAIL_MARK,
    ID_MARK: ID_MARK
  };
})();
