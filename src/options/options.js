// Better Canvas (Rice) — options page: save or remove the Pangram API key,
// and delete saved Pangram results.
//
// The key goes in chrome.storage.local, where only the background service
// worker reads it (see src/background/service-worker.js). This page shows
// only the last four characters of a saved key. Saved results sit in the same
// area, one item per result, each named "pangramResult:" plus a text hash.

(function () {
  "use strict";

  var KEY_NAME = "pangramApiKey";
  var RESULT_PREFIX = "pangramResult:"; // as in src/background/service-worker.js
  var form = document.getElementById("key-form");
  var input = document.getElementById("api-key");
  var removeButton = document.getElementById("remove-key");
  var status = document.getElementById("status");
  var deleteResultsButton = document.getElementById("delete-results");
  var resultsStatus = document.getElementById("results-status");

  function showSaved(key) {
    status.textContent = key
      ? "A key is saved (ends in …" + key.slice(-4) + ")."
      : "No key is saved.";
  }

  function savedResultNames() {
    return chrome.storage.local.getKeys().then(function (names) {
      return names.filter(function (name) {
        return name.indexOf(RESULT_PREFIX) === 0;
      });
    });
  }

  function showResultCount() {
    return savedResultNames().then(function (names) {
      resultsStatus.textContent = names.length === 1
        ? "1 result is saved."
        : names.length + " results are saved.";
      deleteResultsButton.disabled = names.length === 0;
    });
  }

  chrome.storage.local.get(KEY_NAME).then(function (items) {
    showSaved(String(items[KEY_NAME] || ""));
  });
  showResultCount();

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var key = input.value.trim();
    if (!key) {
      status.textContent = "Type a key first.";
      return;
    }
    var items = {};
    items[KEY_NAME] = key;
    chrome.storage.local.set(items).then(function () {
      input.value = "";
      showSaved(key);
    });
  });

  removeButton.addEventListener("click", function () {
    chrome.storage.local.remove(KEY_NAME).then(function () {
      input.value = "";
      showSaved("");
    });
  });

  deleteResultsButton.addEventListener("click", function () {
    savedResultNames()
      .then(function (names) {
        return chrome.storage.local.remove(names);
      })
      .then(showResultCount);
  });
})();
