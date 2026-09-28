// Better Canvas (Rice) — options page: save or remove the Pangram API key,
// pick the Pangram model, and delete saved Pangram results.
//
// The key goes in chrome.storage.local, where only the background service
// worker reads it (see src/background/service-worker.js). This page shows
// only the last four characters of a saved key. Saved results sit in the same
// area, one item per result, each named "pangramResult:" plus a text hash.
//
// The model menu lists the selectors the saved key can use, which the worker
// gets from Pangram (GET /models). The pick goes in chrome.storage.sync; ""
// means "Newest", which the worker works out again at each check.

(function () {
  "use strict";

  var KEY_NAME = "pangramApiKey";
  var RESULT_PREFIX = "pangramResult:"; // as in src/background/service-worker.js
  var MODEL_SETTING = "pangramModel"; // as in src/background/service-worker.js
  var form = document.getElementById("key-form");
  var input = document.getElementById("api-key");
  var removeButton = document.getElementById("remove-key");
  var status = document.getElementById("status");
  var modelSelect = document.getElementById("model");
  var modelStatus = document.getElementById("model-status");
  var deleteResultsButton = document.getElementById("delete-results");
  var resultsStatus = document.getElementById("results-status");
  var modelsAsked = 0; // so only the latest showModels() fills the menu

  function showSaved(key) {
    status.textContent = key
      ? "A key is saved (ends in …" + key.slice(-4) + ")."
      : "No key is saved.";
  }

  function askWorker(message) {
    return chrome.runtime.sendMessage(message).then(function (response) {
      if (!response) {
        throw new Error("The extension did not answer.");
      }
      if (!response.ok) {
        throw new Error(response.error);
      }
      return response.value;
    });
  }

  function addOption(value, label) {
    var option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    modelSelect.appendChild(option);
  }

  // "Newest" first, with the model it picks now, then each model the key can
  // use. A picked model that is not in the list stays in the menu, so the
  // menu always shows what checks send.
  function fillModels(picked, list) {
    modelSelect.textContent = "";
    addOption("", list.newest ? "Newest (now " + list.newest + ")" : "Newest");
    list.models.forEach(function (name) {
      addOption(name, name);
    });
    if (picked && list.models.indexOf(picked) === -1) {
      addOption(picked, picked + " (not in the list)");
    }
    modelSelect.value = picked;
    modelStatus.textContent = list.note;
  }

  function showModels(key) {
    var asked = ++modelsAsked;
    var picked = "";
    modelSelect.disabled = true;
    modelStatus.textContent = key ? "Loading the models…" : "";
    chrome.storage.sync.get(MODEL_SETTING)
      .then(function (items) {
        picked = typeof items[MODEL_SETTING] === "string" ? items[MODEL_SETTING] : "";
        if (!key) {
          return { models: [], newest: "", note: "Save an API key to list the models it can use." };
        }
        return askWorker({ type: "pangram-models" }).then(
          function (found) {
            found.note = found.newest ? "" : "No model is named pangram-<number>, so Newest sends \"default\".";
            return found;
          },
          function (err) {
            return { models: [], newest: "", note: "Could not list the models: " + err.message };
          }
        );
      })
      .then(function (list) {
        if (asked === modelsAsked) {
          fillModels(picked, list);
          modelSelect.disabled = false;
        }
      });
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
    var key = String(items[KEY_NAME] || "").trim();
    showSaved(key);
    showModels(key);
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
      showModels(key);
    });
  });

  removeButton.addEventListener("click", function () {
    chrome.storage.local.remove(KEY_NAME).then(function () {
      input.value = "";
      showSaved("");
      showModels("");
    });
  });

  modelSelect.addEventListener("change", function () {
    var items = {};
    items[MODEL_SETTING] = modelSelect.value;
    chrome.storage.sync.set(items).then(function () {
      modelStatus.textContent = "Saved.";
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
