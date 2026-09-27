"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var context = { window: {}, console: console };
var source = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "redact.js"), "utf8");
vm.runInNewContext(source, context, { filename: "redact.js" });
var Redact = context.window.BetterCanvasRedact;

var redactor = Redact.createRedactor([
  "Jane Q. Doe", "Doe, Jane Q.", "Janie Doe",
  "Mary-Jane O'Brien", "O'Brien, Mary-Jane",
  "José Núñez", "Núñez, José",
  "Will May", "May, Will",
  "Anna van der Berg", "van der Berg, Anna",
  "Omar al-Farsi", "al-Farsi, Omar",
  "Maria de la Cruz", "de la Cruz, Maria",
  "John Smith III", "Smith, John III",
  "Soren Kjaer", "Łukasz Wójcik", "İlayda Yıldız", "Anna Strauß", "Chloe Lefevre",
  "Anna deWitt", "张伟",
  "Wei (David) Zhang", "Robert \"Bob\" Smithers",
  "Lena Müller", "Karl Mueller", "Søren Holm",
  "Maria Garcia Lopez", "Garcia Lopez, Maria",
  "X Y"
]);

function check(input, expected, counts) {
  var result = redactor.redact(input);
  assert.strictEqual(result.text, expected, JSON.stringify(input));
  if (counts) {
    assert.strictEqual(result.names, counts.names, "names in " + JSON.stringify(input));
    assert.strictEqual(result.emails, counts.emails, "emails in " + JSON.stringify(input));
  }
}

// Whole names, name parts, sortable names, and short names.
check("Jane Q. Doe\nENTR 222", "[name]\nENTR 222", { names: 1, emails: 0 });
check("Doe, Jane Q. wrote this.", "[name]. wrote this."); // an end period may end a sentence
check("Janie said hi to Jane.", "[name] said hi to [name].");
check("Written by Jane Doe.", "Written by [name].");
check("JANE DOE", "[name]");
check("Doe's plan", "[name]'s plan");

// Hyphenated names, apostrophes (straight and curly), and hyphen halves.
check("Mary-Jane O'Brien", "[name]");
check("Mary-Jane O’Brien", "[name]");
check("Mary and Jane and O'Brien", "[name] and [name] and [name]");

// Accents: exact, decomposed (NFD), and typed without accents.
check("José Núñez", "[name]");
check("José Núñez", "[name]");
check("Jose Nunez", "[name]");

// The other direction: the roster has no accents, the paper does.
check("Chloé Lefèvre wrote this.", "[name] wrote this.");
check("Søren Kjær", "[name]");

// Letters that NFD does not split, in both directions.
check("Soren Kjaer", "[name]");
check("Lukasz Wojcik", "[name]");
check("ŁUKASZ WÓJCIK", "[name]");
check("Ilayda YILDIZ", "[name]");
check("Yildiz and Strauss", "[name] and [name]");
check("Anna Strauss", "[name]");

// Whole names match in any case; single words must be capitalized.
check("jane doe\nENTR 222", "[name]\nENTR 222", { names: 1, emails: 0 });
check("Will may go. May will stay.", "[name] go. [name] will stay.");
check("you will see", "you will see", { names: 0, emails: 0 });

// Surnames with particles match as a whole, in any case.
check("Anna van der Berg", "[name]");
check("interviewed van der Berg", "interviewed [name]");
check("Omar al-Farsi and al-Farsi's plan", "[name] and [name]'s plan");
check("De la Cruz said", "[name] said");

// A capital inside the word, and scripts with no letter case.
check("As deWitt argues", "As [name] argues");
check("deWitt 1", "[name] 1");
check("作者：张伟", "作者：[name]");

// Nicknames in parentheses or quotes are names too.
check("David Zhang wrote", "[name] wrote");
check("david zhang wrote", "[name] wrote");
check("Bob Smithers", "[name]");

// The ae/oe/ue spelling of ä, ö, ü, and ø, in both directions.
check("Lena Mueller", "[name]");
check("Mueller 1", "[name] 1");
check("Karl Müller", "[name]");
check("Müller said", "[name] said");
check("Soeren Holm", "[name]");

// The reverse spelling never turns a roster name into a common word.
var common = Redact.createRedactor(["John Doe", "Ana Noe", "Eva Haas", "Omar Saad", "Min Soe", "Joel Park"]);
["Do you agree?", "No one came.", "Has it ended?", "Sad news.", "So it goes.", "Jol"].forEach(function (text) {
  assert.strictEqual(common.redact(text).text, text, JSON.stringify(text));
});
assert.strictEqual(common.redact("Doe and Haas").text, "[name] and [name]");

// Lowercase short forms of a longer roster name.
check("john smith\nENTR 222", "[name]\nENTR 222");
check("maria garcia wrote", "[name] wrote");

// Longer names: groups of main words, and runs that keep their particles.
var long = Redact.createRedactor([
  "María José García López", "Ana Maria Da Silva", "Tran Minh Anh Nguyen", "Maria De La Cruz"
]);
[
  ["maría josé garcía wrote", "[name] wrote"],
  ["maría garcía lópez wrote", "[name] wrote"],
  ["maria da silva wrote", "[name] wrote"],
  ["minh anh nguyen wrote", "[name] wrote"],
  ["maria de la cruz wrote", "[name] wrote"],
  // Capitalized particles on the roster do not make "de la" a name.
  ["de la mancha, de los santos, van der waals", "de la mancha, de los santos, van der waals"]
].forEach(function (pair) {
  assert.strictEqual(long.redact(pair[0]).text, pair[1], JSON.stringify(pair[0]));
});

// Particle units: a surname that is a particle, a particle surname after a
// skipped middle name, a first-word particle, and hyphen halves.
var units = Redact.createRedactor([
  "Kevin Minh Le", "Le, Kevin Minh",
  "Thanh Van Do",
  "Priya Lakshmi Das",
  "Sofia Maria de la Cruz", "Cruz, Sofia Maria de la",
  "Ana Maria Da Silva", "Silva, Ana Maria Da",
  "Mohamed Ali El Sayed",
  "Pedro Luis dos Santos",
  "Le Thi Hoa",
  "Ana García-López",
  "Juan Carlos Andres Garcia-Lopez",
  "Emre Oezdemir", "Oeyvind Berg"
]);
[
  ["As Das notes", "As [name] notes"],
  ["As Do argued", "As [name] argued"],
  ["sofia cruz wrote", "[name] wrote"],
  ["ana silva wrote", "[name] wrote"],
  ["juan carlos garcia-lopez wrote", "[name] wrote"],
  ["juan garcia wrote", "[name] wrote"],
  ["kevin le wrote", "[name] wrote"],
  ["thanh do wrote", "[name] wrote"],
  ["priya das wrote", "[name] wrote"],
  ["sofia de la cruz\nHIST 101", "[name]\nHIST 101"],
  ["ana da silva wrote", "[name] wrote"],
  ["mohamed el sayed wrote", "[name] wrote"],
  ["pedro dos santos wrote", "[name] wrote"],
  ["De La Cruz argues", "[name] argues"],
  ["le hoa wrote", "[name] wrote"],
  ["ana garcía wrote", "[name] wrote"],
  ["Ana López wrote", "[name] wrote"],
  ["Özdemir 1", "[name] 1"],
  ["Øyvind Berg", "[name]"]
].forEach(function (pair) {
  assert.strictEqual(units.redact(pair[0]).text, pair[1], JSON.stringify(pair[0]));
});

// A capitalized particle-like syllable is a real name part, and a hyphen in a
// roster name also matches a space.
var syllables = Redact.createRedactor([
  "Do-Hyun Kim", "Su-Bin Park", "Do-Yoon Kim", "Kim, Do-Yoon",
  "Jia Le Chen", "Albert \"Al\" Smith", "Mohamed El-Sayed"
]);
[
  ["Do Hyun Kim wrote", "[name] wrote"],
  ["Su Bin Park wrote", "[name] wrote"],
  ["Kim Do Yoon wrote", "[name] wrote"],
  ["Chen Jia Le wrote", "[name] wrote"],
  ["Jia Le wrote", "[name] wrote"],
  ["Al said so", "[name] said so"],
  ["mohamed el sayed wrote", "[name] wrote"],
  ["El Sayed wrote", "[name] wrote"],
  ["Dohyun Kim wrote", "[name] wrote"],
  ["Elsayed wrote", "[name] wrote"],
  // A capitalized particle-like hyphen half alone, and in a lowercase group.
  ["Then Do said so", "Then [name] said so"],
  ["Bin said so", "[name] said so"],
  ["do kim wrote", "[name] wrote"]
].forEach(function (pair) {
  assert.strictEqual(syllables.redact(pair[0]).text, pair[1], JSON.stringify(pair[0]));
});

// A hyphenated name part written as two lowercase words.
var hyphens = Redact.createRedactor([
  "Emily Smith-Jones", "Ana García-López", "Mary-Kate Olsen",
  "In-Young Lee", "Do-Young Park", "So-Young Kim"
]);
[
  ["smith jones wrote", "[name] wrote"],
  ["smith-jones wrote", "[name] wrote"],
  ["garcia lopez wrote", "[name] wrote"],
  ["mary kate wrote", "[name] wrote"],
  // A short-half given name never turns a common phrase into a name.
  ["Obesity in young children", "Obesity in young children"],
  ["why do young people", "why do young people"],
  ["died so young", "died so young"]
].forEach(function (pair) {
  assert.strictEqual(hyphens.redact(pair[0]).text, pair[1], JSON.stringify(pair[0]));
});

// Privacy first: a short name that is also a common capitalized word is
// replaced wherever it is capitalized, even at a sentence start, in a
// heading, after a quote, or in a running head. Only lowercase stays.
var capitals = Redact.createRedactor([
  "Wei He", "Minh An", "Thanh Van Do", "In-Young Lee", "Hye-In Choi", "Linh To",
  "Do-yoon Kim", "\u0110\u1ed7 Minh Anh"
]);
[
  ["He grew up poor. An important factor was school.", "[name] grew up poor. [name] important factor was school."],
  ["I met He at lunch.", "I met [name] at lunch."],
  ["Wei He wrote this.", "[name] wrote this."],
  ["my lab partner\nAn and I", "my lab partner\n[name] and I"],
  ["end of page one.\n\nDo 2\nThe next page", "end of page one.\n\n[name] 2\nThe next page"],
  ["Thanh V. Do wrote", "[name] V. [name] wrote"],
  ["She writes, \u201cThe policy failed.\u201d He then argues.", "She writes, \u201cThe policy failed.\u201d [name] then argues."],
  ["Do-yoon said so. Do-Yoon agreed.", "[name] said so. [name] agreed."],
  ["In-young said hi.", "[name] said hi."],
  ["Submitted by David HE for ENGL 101", "Submitted by David [name] for ENGL 101"],
  ["\u0110\u1ed7 argued.", "[name] argued."],
  // Lowercase words are never replaced alone.
  ["he said it in so many words; do you agree?", "he said it in so many words; do you agree?"],
  ["Obesity in young children", "Obesity in young children"]
].forEach(function (pair) {
  assert.strictEqual(capitals.redact(pair[0]).text, pair[1], JSON.stringify(pair[0]));
});

// A lowercase particle inside a roster name, or as half of a hyphenated
// name, is not a name on its own.
var particles = Redact.createRedactor([
  "Anna van der Berg", "Omar al-Farsi", "Maria de la Cruz", "Juan del Toro",
  "Ana de los Santos", "Maria do Carmo Silva", "Hans zu Berg"
]);
[
  "Van Gogh painted it.", "Al Gore lost in 2000.", "La Niña years are dry.",
  "Del Mar is north.", "Los Angeles is big.", "Do you agree?", "De facto, it failed.",
  "Der Spiegel wrote.", "Al-Qaeda claimed it.", "Zu viel."
].forEach(function (text) {
  assert.strictEqual(particles.redact(text).text, text, JSON.stringify(text));
});

// The index map handles multi-unit folds, surrogate pairs, and combining
// marks that NFC cannot compose.
check("Strauß's essay", "[name]'s essay");
check("😀 Jane Doe 😀", "😀 [name] 😀");
check("D̲o̲e̲, ok", "[name], ok");

// Lowercase particles and suffixes are not names on their own.
check("Smith et al. (2020) found", "[name] et al. (2020) found");
check("de facto, a la carte, drove the van", "de facto, a la carte, drove the van", { names: 0, emails: 0 });
check("World War III and Part II", "World War III and Part II", { names: 0, emails: 0 });

// A name inside another word does not match.
check("Janet and Doering", "Janet and Doering", { names: 0, emails: 0 });

// Single letters are not names.
check("X marks the spot, Y not?", "X marks the spot, Y not?");

// Email addresses go first, so a lowercase name inside one is gone too.
check("Contact jane.doe@rice.edu today", "Contact [email] today", { names: 0, emails: 1 });
check("jd45@rice.edu, Jane Doe", "[email], [name]", { names: 1, emails: 1 });

// A whole name may wrap to the next line; paragraphs are kept.
check("by Jane\nDoe today", "by [name] today", { names: 1, emails: 0 });
check("Jane\n\nDoe", "[name]\n\n[name]");

// NetIDs: case-insensitive, whole words only; an email address goes first.
var netids = Redact.createRedactor(["Jane Doe"], ["jd45", "ab123", "x1", "jd45@rice.edu", ""]);
[
  ["Submitted by jd45 on Monday", "Submitted by [netid] on Monday", 1],
  ["JD45 and Ab123 worked together.", "[netid] and [netid] worked together.", 2],
  ["jd456 and xjd45 are not NetIDs.", "jd456 and xjd45 are not NetIDs.", 0],
  ["(jd45) jd45_notes.docx", "([netid]) [netid]_notes.docx", 2],
  ["x1 is too short to count.", "x1 is too short to count.", 0]
].forEach(function (row) {
  var result = netids.redact(row[0]);
  assert.strictEqual(result.text, row[1], JSON.stringify(row[0]));
  assert.strictEqual(result.ids, row[2], "ids in " + JSON.stringify(row[0]));
});
var mailed = netids.redact("Email jd45@rice.edu or Jane Doe");
assert.strictEqual(mailed.text, "Email [email] or [name]");
assert.strictEqual(mailed.emails, 1);
assert.strictEqual(mailed.ids, 0);

// More name variants: a left-out apostrophe, the ʻokina, full-width letters
// and ligatures, and names joined by an underscore or a dot.
var variants = Redact.createRedactor([
  "Mary-Jane O'Brien", "Kaʻiulani Akana", "Lani Ka'ahanui", "Griffin Lee", "Jane Q. Doe"
]);
[
  ["OBrien 2", "[name] 2"],
  ["O’Brien said", "[name] said"],
  ["Ka'iulani wrote", "[name] wrote"],
  ["Kaiulani wrote", "[name] wrote"],
  ["Kaʻahanui wrote", "[name] wrote"],
  ["Ｊａｎｅ Ｄｏｅ wrote", "[name] wrote"],
  ["Griﬃn wrote", "[name] wrote"],
  ["Jane_Doe_essay.pdf", "[name]_essay.pdf"],
  ["see jane.doe on the forum", "see [name] on the forum"],
  // Lowercase single words still stay.
  ["obrien", "obrien"]
].forEach(function (pair) {
  assert.strictEqual(variants.redact(pair[0]).text, pair[1], JSON.stringify(pair[0]));
});

// An empty roster changes nothing but email addresses.
var empty = Redact.createRedactor([]);
assert.strictEqual(empty.termCount, 0);
assert.strictEqual(empty.redact("Jane Doe a@b.co").text, "Jane Doe [email]");
assert.strictEqual(empty.redact("Jane Doe").ids, 0);

console.log("Name redaction tests passed.");
