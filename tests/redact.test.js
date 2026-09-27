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
  "Will May",
  "Anna van der Berg", "van der Berg, Anna",
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

// Common words that are also names stay intact when lowercase.
check("Will may go. May will stay.", "[name] may go. [name] will stay.");
check("you will see", "you will see", { names: 0, emails: 0 });

// Lowercase roster spellings still match exactly as written.
check("Anna van der Berg", "[name]");
check("interviewed van der Berg", "interviewed [name]");

// A name inside another word does not match.
check("Janet and Doering", "Janet and Doering", { names: 0, emails: 0 });

// Single letters are not names.
check("X marks the spot, Y not?", "X marks the spot, Y not?");

// Email addresses go first, so a lowercase name inside one is gone too.
check("Contact jane.doe@rice.edu today", "Contact [email] today", { names: 0, emails: 1 });
check("jd45@rice.edu, Jane Doe", "[email], [name]", { names: 2, emails: 1 });

// Lines and paragraphs are kept.
check("Jane\n\nDoe", "[name]\n\n[name]");

// An empty roster changes nothing but email addresses.
var empty = Redact.createRedactor([]);
assert.strictEqual(empty.termCount, 0);
assert.strictEqual(empty.redact("Jane Doe a@b.co").text, "Jane Doe [email]");

console.log("Name redaction tests passed.");
