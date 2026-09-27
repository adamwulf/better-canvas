// Better Canvas (Rice) — background service worker: Pangram API calls
//
// The SpeedGrader Pangram check (src/speedgrader/pangram.js) sends its
// redacted text here (reviewed by the grader, unless "Send without preview"
// is on), and this worker calls the Pangram AI-detection API with the key
// saved on the options page. The key never leaves this
// worker: content scripts can only ask whether a key exists.
//
// The key sits in chrome.storage.local. Content scripts can read that area by
// default, so the worker limits it to extension pages and itself each time it
// starts. The SpeedGrader script always messages this worker before it parses
// a student file, which starts the worker first.
//
// Pangram's API is async: POST /task returns a task id, and GET /task/:id is
// polled until the stage is STAGE_SUCCESS or STAGE_FAILED. The content script
// drives the polling with one message per poll, because a pending timer does
// not keep an MV3 service worker alive but each incoming message does.
//
// Check results are saved in the same area, so the content script also reads
// and writes them through this worker. Each result is stored under
// "pangramResult:" plus the SHA-256 hash of the submission text it is for, and
// the worker builds that name itself, so a message can reach no other item.

"use strict";

var API_BASE = "https://text.external-api.pangram.com";
var KEY_NAME = "pangramApiKey";
var RESULT_PREFIX = "pangramResult:"; // the options page deletes these too
var TEXT_HASH = /^[0-9a-f]{64}$/;

// Every message waits for this, so the area is locked before the SpeedGrader
// script hears back and goes on to parse a student file. If the lock fails,
// every message fails too: the check stays off rather than run unprotected.
var storageLocked = chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch(function (err) {
    console.warn("[BetterCanvas] could not restrict storage access", err);
    throw new Error("The extension could not protect the saved API key, so the Pangram check is off.");
  });
storageLocked.catch(function () {}); // reported to each message instead

function loadKey() {
  return chrome.storage.local.get(KEY_NAME).then(function (items) {
    return String(items[KEY_NAME] || "").trim();
  });
}

// A short, plain reason for each HTTP error Pangram documents.
function apiError(status) {
  var reasons = {
    400: "Pangram rejected the request.",
    401: "Pangram did not accept the API key. Check it on the extension options page.",
    402: "The Pangram account has no API credits left.",
    403: "This API key cannot use the Pangram model.",
    404: "Pangram could not find the check.",
    413: "The text is too long for one Pangram check.",
    422: "Pangram could not process the request.",
    429: "Too many Pangram requests. Wait a moment and try again.",
    500: "Pangram had a server error. Try again later.",
    503: "Pangram is not available now. Try again later."
  };
  return new Error(reasons[status] || "Pangram answered with HTTP " + status + ".");
}

function callApi(path, init) {
  return loadKey().then(function (key) {
    if (!key) {
      throw new Error("No Pangram API key. Add one on the extension options page.");
    }
    var headers = { "x-api-key": key, Accept: "application/json" };
    if (init.body) {
      headers["Content-Type"] = "application/json";
    }
    return fetch(API_BASE + path, {
      method: init.method,
      headers: headers,
      body: init.body,
      credentials: "omit"
    }).then(
      function (res) {
        if (!res.ok) {
          throw apiError(res.status);
        }
        return res.json();
      },
      function () {
        throw new Error("Could not reach Pangram. Check the network connection.");
      }
    );
  });
}

function createTask(text) {
  return callApi("/task", {
    method: "POST",
    body: JSON.stringify({ text: text, model: "default", public_dashboard_link: false })
  }).then(function (data) {
    if (!data || !data.task_id) {
      throw new Error("Pangram did not return a task id.");
    }
    return { taskId: data.task_id };
  });
}

function getTask(taskId) {
  return callApi("/task/" + encodeURIComponent(taskId), { method: "GET" }).then(function (data) {
    return { result: data };
  });
}

// Whether any result is saved, so the SpeedGrader script reads a student's
// submission to look for one only when one could be found.
function hasResults() {
  return chrome.storage.local.getKeys().then(function (names) {
    return names.some(function (name) {
      return name.indexOf(RESULT_PREFIX) === 0;
    });
  });
}

function loadResult(hash) {
  var name = RESULT_PREFIX + hash;
  return chrome.storage.local.get(name).then(function (items) {
    return { saved: items[name] || null };
  });
}

function saveResult(hash, saved) {
  var items = {};
  items[RESULT_PREFIX + hash] = saved;
  return chrome.storage.local.set(items).then(function () {
    return {};
  });
}

function handle(message) {
  switch (message && message.type) {
    case "pangram-status":
      return Promise.all([loadKey(), hasResults()]).then(function (found) {
        return { hasKey: found[0] !== "", hasResults: found[1] };
      });
    case "pangram-create-task":
      if (typeof message.text !== "string" || !message.text.trim()) {
        return Promise.reject(new Error("There is no text to check."));
      }
      return createTask(message.text);
    case "pangram-get-task":
      if (typeof message.taskId !== "string" || !message.taskId) {
        return Promise.reject(new Error("Missing Pangram task id."));
      }
      return getTask(message.taskId);
    case "pangram-load-result":
      if (typeof message.hash !== "string" || !TEXT_HASH.test(message.hash)) {
        return Promise.reject(new Error("Missing text hash."));
      }
      return loadResult(message.hash);
    case "pangram-save-result":
      if (typeof message.hash !== "string" || !TEXT_HASH.test(message.hash)) {
        return Promise.reject(new Error("Missing text hash."));
      }
      if (!message.saved || typeof message.saved !== "object") {
        return Promise.reject(new Error("Missing result to save."));
      }
      return saveResult(message.hash, message.saved);
    case "open-options":
      return chrome.runtime.openOptionsPage().then(function () {
        return {};
      });
    default:
      return Promise.reject(new Error("Unknown message."));
  }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (sender.id !== chrome.runtime.id) {
    return false;
  }
  var pending = storageLocked.then(function () {
    return handle(message);
  });
  pending.then(
    function (value) {
      sendResponse({ ok: true, value: value });
    },
    function (err) {
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    }
  );
  return true; // sendResponse is called asynchronously
});
