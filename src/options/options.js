// Better Canvas (Rice) — options page: save or remove the Pangram API key.
//
// The key goes in chrome.storage.local, where only the background service
// worker reads it (see src/background/service-worker.js). This page shows
// only the last four characters of a saved key.

(function () {
  "use strict";

  var KEY_NAME = "pangramApiKey";
  var form = document.getElementById("key-form");
  var input = document.getElementById("api-key");
  var removeButton = document.getElementById("remove-key");
  var status = document.getElementById("status");

  function showSaved(key) {
    status.textContent = key
      ? "A key is saved (ends in …" + key.slice(-4) + ")."
      : "No key is saved.";
  }

  chrome.storage.local.get(KEY_NAME).then(function (items) {
    showSaved(String(items[KEY_NAME] || ""));
  });

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
})();
