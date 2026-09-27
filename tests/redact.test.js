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

// An empty roster changes nothing but email addresses.
var empty = Redact.createRedactor([]);
assert.strictEqual(empty.termCount, 0);
assert.strictEqual(empty.redact("Jane Doe a@b.co").text, "Jane Doe [email]");

console.log("Name redaction tests passed.");
