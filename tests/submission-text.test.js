"use strict";

var assert = require("assert");
var childProcess = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");
var vm = require("vm");

var context = {
  window: {},
  console: console,
  Blob: Blob,
  DataView: DataView,
  DecompressionStream: DecompressionStream,
  Promise: Promise,
  Response: Response,
  TextDecoder: TextDecoder,
  Uint8Array: Uint8Array
};
var source = fs.readFileSync(
  path.join(__dirname, "..", "src", "speedgrader", "submission-text.js"),
  "utf8"
);
vm.runInNewContext(source, context, { filename: "submission-text.js" });
var SubmissionText = context.window.BetterCanvasSubmissionText;

// kindOf: by content type first, then by file extension.
assert.strictEqual(SubmissionText.kindOf({ "content-type": "application/pdf", filename: "a" }), "pdf");
assert.strictEqual(SubmissionText.kindOf({ "content-type": "", filename: "Plan.PDF" }), "pdf");
assert.strictEqual(SubmissionText.kindOf({
  "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  display_name: "plan"
}), "docx");
assert.strictEqual(SubmissionText.kindOf({ display_name: "notes.docx" }), "docx");
assert.strictEqual(SubmissionText.kindOf({ "content-type": "text/plain", filename: "a.txt" }), "text");
assert.strictEqual(SubmissionText.kindOf({ "content-type": "application/msword", filename: "old.doc" }), null);
assert.strictEqual(SubmissionText.kindOf({ "content-type": "image/png", filename: "scan.png" }), null);

// tidyText: collapses spaces, trims lines, keeps one blank line at most.
assert.strictEqual(
  SubmissionText.tidyText("  One \t two\r\n\r\n\r\n  three  four  \n"),
  "One two\n\nthree four"
);

var documentXml = "<?xml version=\"1.0\"?><w:document xmlns:w=\"x\"><w:body>" +
  "<w:p><w:r><w:t>José wrote this plan.</w:t></w:r></w:p>".repeat(40) +
  "</w:body></w:document>";

var temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "better-canvas-docx-"));

function makeZip(name, flags) {
  var zipPath = path.join(temporaryDirectory, name);
  childProcess.execFileSync(
    "zip",
    ["-q", "-X"].concat(flags, [zipPath, "[Content_Types].xml", "word/document.xml"]),
    { cwd: temporaryDirectory, stdio: "pipe" }
  );
  return new Uint8Array(fs.readFileSync(zipPath));
}

function entryText(bytes, name) {
  return SubmissionText.readZipEntry(bytes, name).then(function (data) {
    return data === null ? null : new TextDecoder("utf-8").decode(data);
  });
}

fs.mkdirSync(path.join(temporaryDirectory, "word"));
fs.writeFileSync(path.join(temporaryDirectory, "[Content_Types].xml"), "<Types/>");
fs.writeFileSync(path.join(temporaryDirectory, "word", "document.xml"), documentXml);

var deflated = makeZip("deflated.docx", []);
var stored = makeZip("stored.docx", ["-0"]);
var descriptors = makeZip("descriptors.docx", ["-fd"]);

function localFlags(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(6, true);
}
assert.strictEqual(localFlags(descriptors) & 0x0008, 0x0008, "-fd writes a data descriptor");
assert.strictEqual(localFlags(deflated) & 0x0008, 0, "a plain zip has no data descriptor");

// The central-directory record for word/document.xml in a ZIP.
function directoryEntry(bytes) {
  var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  var end = bytes.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) {
    end--;
  }
  var offset = view.getUint32(end + 16, true);
  for (var n = 0; n < view.getUint16(end + 10, true); n++) {
    var nameLength = view.getUint16(offset + 28, true);
    var name = Buffer.from(bytes.subarray(offset + 46, offset + 46 + nameLength)).toString();
    if (name === "word/document.xml") {
      return { view: view, offset: offset, compressed: view.getUint32(offset + 20, true) };
    }
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  throw new Error("no word/document.xml");
}

// A copy that claims its document is 10 bytes once uncompressed.
var lying = new Uint8Array(deflated);
var lyingEntry = directoryEntry(lying);
lyingEntry.view.setUint32(lyingEntry.offset + 24, 10, true);
var limit = lyingEntry.compressed + 1; // passes the header checks, not the stream

function errorOf(promise) {
  return promise.then(
    function () { return "no error"; },
    function (err) { return err.message; }
  );
}

Promise.all([
  entryText(deflated, "word/document.xml"),
  entryText(stored, "word/document.xml"),
  entryText(descriptors, "word/document.xml"),
  entryText(deflated, "word/missing.xml"),
  errorOf(SubmissionText.readZipEntry(new Uint8Array(64), "word/document.xml")),
  errorOf(SubmissionText.readZipEntry(deflated, "word/document.xml", 100)),
  errorOf(SubmissionText.readZipEntry(lying, "word/document.xml", limit)),
  entryText(lying, "word/document.xml")
])
  .then(function (results) {
    assert.strictEqual(results[0], documentXml, "deflated entry");
    assert.strictEqual(results[1], documentXml, "stored entry");
    assert.strictEqual(results[2], documentXml, "entry with a data descriptor");
    assert.strictEqual(results[3], null, "missing entry");
    assert.strictEqual(results[4], "the file is not a ZIP archive");
    assert.strictEqual(results[5], "the document text is too large to read", "size in the header");
    assert.strictEqual(results[6], "the document text is too large to read", "size while inflating");
    assert.strictEqual(results[7], documentXml, "under the default limit");
    console.log("Submission text tests passed.");
  })
  .catch(function (err) {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(function () {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });
