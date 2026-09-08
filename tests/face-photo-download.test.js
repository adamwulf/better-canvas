"use strict";

var assert = require("assert");
var childProcess = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");
var vm = require("vm");

function mockElement(tagName) {
  return {
    tagName: tagName.toUpperCase(),
    className: "",
    style: {},
    textContent: "",
    addEventListener: function (type, listener) {
      this.listeners = this.listeners || {};
      this.listeners[type] = listener;
    }
  };
}

var rosterDownload = mockElement("input");
var buttonRow = {
  children: [rosterDownload],
  insertBefore: function (element, reference) {
    this.children.splice(this.children.indexOf(reference), 0, element);
  }
};
rosterDownload.parentNode = buttonRow;

var hooks = {};
var context = {
  Blob: Blob,
  TextEncoder: TextEncoder,
  Uint8Array: Uint8Array,
  console: console,
  document: {
    readyState: "complete",
    body: { appendChild: function () {} },
    createElement: mockElement,
    querySelector: function (selector) {
      if (selector === "table.reporttable") return {};
      if (selector === 'input[name="p_download"]') return rosterDownload;
      if (selector.charAt(0) === ".") {
        var wantedClass = selector.slice(1);
        return buttonRow.children.find(function (element) {
          return element.className.split(/\s+/).indexOf(wantedClass) !== -1;
        }) || null;
      }
      return null;
    }
  },
  window: {
    __bcTestHooks: hooks
  }
};

var source = fs.readFileSync(
  path.join(__dirname, "..", "src", "flashcards", "flashcards.js"),
  "utf8"
);
vm.runInNewContext(source, context, { filename: "flashcards.js" });

assert.deepStrictEqual(
  buttonRow.children.map(function (element) { return element.textContent; }),
  ["🃏 Flashcard Mode", "⬇ Download Face Photos", ""]
);
assert.strictEqual(buttonRow.children[1].type, "button");
assert.strictEqual(typeof buttonRow.children[1].listeners.click, "function");

assert.strictEqual(hooks.toFirstLast("Watanabe, Kenji Taro"), "Kenji Taro Watanabe");
assert.strictEqual(hooks.toFirstLast("Single Name"), "Single Name");
assert.strictEqual(hooks.safeFilename("Example, Pat/Chris"), "Pat_Chris Example");
assert.strictEqual(hooks.safeFilename("NUL"), "_NUL");

var usedNames = Object.create(null);
assert.strictEqual(hooks.uniquePhotoName("Smith, Alex", usedNames), "Alex Smith.png");
assert.strictEqual(hooks.uniquePhotoName("Smith, Alex", usedNames), "Alex Smith (2).png");
assert.strictEqual(hooks.uniquePhotoName("SMITH, ALEX", usedNames), "ALEX SMITH (3).png");

var files = [
  { name: "Alex Smith.png", data: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) },
  { name: "Jos\u00e9 N\u00fa\u00f1ez.png", data: new Uint8Array([137, 80, 78, 71, 4, 5, 6]) }
];
var zipBytes = hooks.makeZip(files);
var temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "better-canvas-zip-"));
var zipPath = path.join(temporaryDirectory, "face-photos.zip");

try {
  fs.writeFileSync(zipPath, zipBytes);
  childProcess.execFileSync("unzip", ["-t", zipPath], { stdio: "pipe" });

  var view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  var decoder = new TextDecoder("utf-8");
  var offset = 0;
  files.forEach(function (file) {
    assert.strictEqual(view.getUint32(offset, true), 0x04034b50);
    assert.strictEqual(view.getUint16(offset + 6, true) & 0x0800, 0x0800);
    var dataLength = view.getUint32(offset + 18, true);
    var nameLength = view.getUint16(offset + 26, true);
    var nameStart = offset + 30;
    var dataStart = nameStart + nameLength;
    assert.strictEqual(decoder.decode(zipBytes.slice(nameStart, dataStart)), file.name);
    assert.deepStrictEqual(
      Array.from(zipBytes.slice(dataStart, dataStart + dataLength)),
      Array.from(file.data)
    );
    offset = dataStart + dataLength;
  });
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("Face photo filename and ZIP tests passed.");
