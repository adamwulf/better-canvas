"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var context = { window: {}, console: console };
var source = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "redact.js"), "utf8");
vm.runInNewContext(source, context, { filename: "redact.js" });
var Redact = context.window.BetterCanvasRedact;

function checkAll(redactor, rows) {
  rows.forEach(function (row) {
    assert.strictEqual(redactor.redact(row[0]).text, row[1], JSON.stringify(row[0]));
  });
}

var roster = Redact.createRedactor(
  [
    "Jane Q. Doe", "Doe, Jane Q.",
    "José Núñez", "Núñez, José",
    "Mary-Jane O'Brien", "O'Brien, Mary-Jane",
    "Wei (David) Zhang",
    "Anna van der Berg", "van der Berg, Anna",
    "Lena Müller",
    "Łukasz Wójcik",
    "Will May", "May, Will",
    "John Smith III",
    "Do-Hyun Kim",
    "张伟"
  ],
  ["jd45", "jn3@rice.edu", "x1"]
);

// Full names, first + last in either order, and single name parts.
checkAll(roster, [
  ["Jane Q. Doe\nENTR 222", "[name]\nENTR 222"],
  ["Written by Jane Doe.", "Written by [name]."],
  ["Doe, Jane wrote it. Doe Jane agreed.", "[name], [name] wrote it. [name] agreed."],
  ["jane doe and JANE DOE", "[name] and [name]"],
  ["Janie said hi to Jane.", "Janie said hi to [name]."],
  ["Doe's plan", "[name]'s plan"],
  ["John Smith and Smith III", "[name] and [name] III"]
]);

// Accents both ways, ł/ø/ß, and ä/ö/ü as ae/oe/ue.
checkAll(roster, [
  ["Jose Nunez wrote", "[name] wrote"],
  ["José Núñez wrote", "[name] wrote"],
  ["Lukasz Wojcik wrote", "[name] wrote"],
  ["Lena Mueller wrote", "[name] wrote"]
]);

// Apostrophes, hyphens, nicknames, particles, and joined words of a name.
checkAll(roster, [
  ["Mary-Jane O’Brien", "[name]"],
  ["OBrien 2 and Mary Jane", "[name] 2 and [name]"],
  ["Mary and Jane", "[name] and [name]"],
  ["David Zhang and david zhang", "[name] and [name]"],
  ["Anna van der Berg and Berg", "[name] and [name]"],
  ["Do Hyun Kim and Dohyun", "[name] and [name]"],
  ["jane_doe.pdf and jane.doe", "[name].pdf and [name]"],
  ["作者：张伟", "作者：[name]"]
]);

// Ordinary words stay: lowercase single words, particles, and names inside words.
checkAll(roster, [
  ["You will see that it may rain.", "You will see that it may rain."],
  ["de facto, drove the van", "de facto, drove the van"],
  ["Janet and Doering", "Janet and Doering"]
]);

// Emails and NetIDs: an email goes first; a NetID is a whole word, any case.
checkAll(roster, [
  ["Email jane.doe@rice.edu today", "Email [email] today"],
  ["By jd45 and JN3 (jd456 is not one)", "By [netid] and [netid] (jd456 is not one)"],
  ["x1 is too short", "x1 is too short"]
]);
assert.strictEqual(roster.idCount, 2);

// Counts, and lines kept.
var result = roster.redact("Jane Doe (jd45, jd45@rice.edu)\n\nThanks, Jane");
assert.strictEqual(result.text, "[name] ([netid], [email])\n\nThanks, [name]");
assert.strictEqual(result.names, 2);
assert.strictEqual(result.ids, 1);
assert.strictEqual(result.emails, 1);

// An empty roster changes nothing but email addresses.
var empty = Redact.createRedactor([]);
assert.strictEqual(empty.termCount, 0);
assert.strictEqual(empty.idCount, 0);
assert.strictEqual(empty.redact("Jane Doe a@b.co").text, "Jane Doe [email]");

console.log("Name redaction tests passed.");
