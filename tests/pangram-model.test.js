"use strict";

// Tests the service worker's model choice: the newest "pangram-<number>"
// selector from GET /models, or the model picked on the options page.

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var stored = { local: { pangramApiKey: "test-key" }, sync: {} };
var listed = { models: [] };
var requests = [];

function storageArea(items) {
  return {
    get: function (name) {
      var found = {};
      if (name in items) {
        found[name] = items[name];
      }
      return Promise.resolve(found);
    },
    setAccessLevel: function () {
      return Promise.resolve();
    }
  };
}

var context = {
  console: console,
  chrome: {
    storage: { local: storageArea(stored.local), sync: storageArea(stored.sync) },
    runtime: { onMessage: { addListener: function () {} } }
  },
  fetch: function (url, init) {
    requests.push({ url: url, init: init });
    var body = /\/models$/.test(url) ? listed : { task_id: "task-1" };
    return Promise.resolve({
      ok: true,
      json: function () {
        return Promise.resolve(body);
      }
    });
  }
};
var source = fs.readFileSync(path.join(__dirname, "..", "src", "background", "service-worker.js"), "utf8");
vm.runInNewContext(source, context, { filename: "service-worker.js" });

// The newest numbered selector; other names are ignored.
[
  [["default", "pangram-4"], "pangram-4"],
  [["pangram-3", "pangram-4", "default"], "pangram-4"],
  [["pangram-4", "pangram-4.1"], "pangram-4.1"],
  [["pangram-4.1", "pangram-4"], "pangram-4.1"],
  [["pangram-4.9", "pangram-4.10"], "pangram-4.10"],
  [["pangram-3.3.2", "pangram-3.3", "pangram-3.10"], "pangram-3.10"],
  [["pangram-5", "pangram-4.9.9"], "pangram-5"],
  [["pangram-4", "pangram-4.0"], "pangram-4"],
  [["pangram-4-mini", "pangram-5-beta", "Pangram-6", "pangram-", "pangram-4."], ""],
  [["default"], ""],
  [[], ""]
].forEach(function (row) {
  assert.strictEqual(context.newestModel(row[0]), row[1], JSON.stringify(row[0]));
});

function sentModel() {
  var body = requests[requests.length - 1].init.body;
  return JSON.parse(body).model;
}

Promise.resolve()
  .then(function () {
    // Newest: the highest numbered model from GET /models.
    listed.models = ["default", "pangram-4", "pangram-4.1", 7];
    return context.createTask("some text");
  })
  .then(function (value) {
    assert.strictEqual(value.taskId, "task-1");
    assert.strictEqual(value.model, "pangram-4.1");
    assert.strictEqual(sentModel(), "pangram-4.1");
    // Newest, with no numbered model: "default".
    listed.models = ["default"];
    return context.createTask("some text");
  })
  .then(function (value) {
    assert.strictEqual(value.model, "default");
    assert.strictEqual(sentModel(), "default");
    // Newest picked on the options page, which saves "": as with no pick.
    stored.sync.pangramModel = "";
    listed.models = ["default", "pangram-4"];
    requests = [];
    return context.createTask("some text");
  })
  .then(function (value) {
    assert.strictEqual(value.model, "pangram-4");
    assert.ok(/\/models$/.test(requests[0].url), "GET /models first");
    assert.strictEqual(sentModel(), "pangram-4");
    // A model picked on the options page is sent as is, with no GET /models.
    stored.sync.pangramModel = "pangram-3.3.2";
    requests = [];
    return context.createTask("some text");
  })
  .then(function (value) {
    assert.strictEqual(value.model, "pangram-3.3.2");
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(sentModel(), "pangram-3.3.2");
    console.log("pangram-model tests passed");
  })
  .catch(function (err) {
    console.error(err);
    process.exitCode = 1;
  });
