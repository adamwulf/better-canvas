// Better Canvas (Rice) — Pangram AI-detection check in SpeedGrader
//
// Adds a "Pangram" section to the SpeedGrader grading panel, under the
// submission details. "Check with Pangram" runs these steps for the student
// on screen:
//
//   1. Ask the background worker whether a Pangram API key is saved.
//   2. Load the submission (GET /api/v1/courses/:id/assignments/:id/
//      submissions/:user_id) and every student on the course roster
//      (GET /api/v1/courses/:id/users?enrollment_type[]=student).
//   3. Turn the submission into plain text in the browser: the text-entry
//      body, or each PDF, Word (.docx), or .txt file
//      (BetterCanvasSubmissionText).
//   4. Replace every roster name with "[name]", every roster NetID (the
//      Canvas login_id) with "[netid]", and every email address with
//      "[email]" (BetterCanvasRedact). If the roster cannot load, the check
//      stops here and nothing is sent.
//   5. Show the redacted text in a dialog. Nothing leaves the browser until
//      "Send to Pangram" is clicked.
//   6. The background worker sends only that redacted text to Pangram and
//      the dialog shows the result, with the text colored by segment.
//
// SpeedGrader is a React app that switches students without a page load and
// re-renders the grading panel, so a MutationObserver and the Navigation
// API's currententrychange event keep the section in place and in step with
// the student in the URL. Each section button checks the URL again before it
// acts. Results are kept in memory for this page only; nothing is persisted.

(function () {
  "use strict";

  var Redact = window.BetterCanvasRedact;
  var SubmissionText = window.BetterCanvasSubmissionText;
  if (!Redact || !SubmissionText) {
    console.warn("[BetterCanvas] Pangram check libraries missing; aborting");
    return;
  }

  var courseMatch = location.pathname.match(/^\/courses\/(\d+(?:~\d+)?)\/gradebook\/speed_grader\/?$/);
  if (!courseMatch) {
    return;
  }
  var courseId = courseMatch[1];

  var SECTION_MARK = "data-bc-pangram";
  var POLL_MS = 2000;
  var POLL_LIMIT_MS = 5 * 60 * 1000;
  var MAX_FILE_BYTES = 30 * 1024 * 1024;
  var ROSTER_STATES = ["active", "invited", "completed", "inactive"];
  var CANVAS_ID = /^\d+(?:~\d+)?$/;
  var ANONYMOUS_ID = /^[A-Za-z0-9]+$/;

  var checks = Object.create(null); // submission key -> check state
  var rosterReady = null; // Promise<{ names, ids }>, loaded once per page
  var dialog = null; // { key, root, body, footer }

  // ---- Small helpers --------------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  // The second click of a double-click is ignored: the first click often
  // opens the dialog or swaps its buttons, and the second would then land on
  // the backdrop or on a new button (such as "Close" where "Send" was).
  function button(label, className, onClick) {
    var node = el("button", "bc-pg-button " + (className || ""), label);
    node.type = "button";
    node.addEventListener("click", function (event) {
      if (event.detail <= 1) {
        onClick(event);
      }
    });
    return node;
  }

  function percent(fraction) {
    return Math.round((Number(fraction) || 0) * 100) + "%";
  }

  function wordCount(text) {
    var words = text.match(/\S+/g);
    return words ? words.length : 0;
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function errorText(err) {
    var message = (err && err.message) || String(err);
    if (/Extension context invalidated/i.test(message)) {
      return "The extension was reloaded. Reload this page and try again.";
    }
    return message;
  }

  function sendMessage(message) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(message, function (response) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!response) {
          reject(new Error("The extension did not answer."));
        } else if (response.ok) {
          resolve(response.value);
        } else {
          reject(new Error(response.error));
        }
      });
    });
  }

  // ---- Canvas API -----------------------------------------------------------

  function canvasFetch(url) {
    return fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    }).then(function (res) {
      if (!res.ok) {
        throw new Error("Canvas answered HTTP " + res.status + " for " + url.split("?")[0]);
      }
      return res;
    });
  }

  // Follows Canvas's Link: <…>; rel="next" pagination, same origin only.
  function canvasAllPages(url, collected) {
    collected = collected || [];
    return canvasFetch(url).then(function (res) {
      var next = (res.headers.get("Link") || "").match(/<([^>]+)>;\s*rel="next"/);
      return res.json().then(function (page) {
        collected = collected.concat(page);
        if (next) {
          var nextUrl = new URL(next[1], location.href);
          if (nextUrl.origin === location.origin) {
            return canvasAllPages(nextUrl.href, collected);
          }
        }
        return collected;
      });
    });
  }

  function userNames(user) {
    return user ? [user.name, user.sortable_name, user.short_name].filter(Boolean) : [];
  }

  // A user's NetID: the Canvas login ID, which Canvas includes only when the
  // grader may see login IDs.
  function userIds(user) {
    return user && user.login_id ? [String(user.login_id)] : [];
  }

  // { names, ids } for every student on the roster.
  function loadRoster() {
    if (!rosterReady) {
      var url = "/api/v1/courses/" + courseId + "/users?enrollment_type[]=student&per_page=100" +
        ROSTER_STATES.map(function (state) { return "&enrollment_state[]=" + state; }).join("");
      rosterReady = canvasAllPages(url)
        .then(function (users) {
          var roster = { names: [], ids: [] };
          users.forEach(function (user) {
            roster.names = roster.names.concat(userNames(user));
            roster.ids = roster.ids.concat(userIds(user));
          });
          if (!roster.names.length) {
            throw new Error("the roster came back empty");
          }
          return roster;
        })
        .catch(function (err) {
          rosterReady = null; // let a later check try again
          throw new Error("Could not load the course roster, so nothing was sent (" + errorText(err) + ").");
        });
    }
    return rosterReady;
  }

  function loadSubmission(target) {
    var base = "/api/v1/courses/" + courseId + "/assignments/" + target.assignmentId;
    var url = target.studentId
      ? base + "/submissions/" + target.studentId + "?include[]=user"
      : base + "/anonymous_submissions/" + target.anonymousId;
    return canvasFetch(url).then(function (res) {
      return res.json();
    });
  }

  // Attachment URLs are Canvas download links on this same site; Canvas may
  // redirect them to its file store.
  function downloadAttachment(attachment) {
    var url = new URL(attachment.url, location.href);
    if (url.origin !== location.origin) {
      return Promise.reject(new Error("the download link is not on this Canvas site"));
    }
    if (attachment.size > MAX_FILE_BYTES) {
      return Promise.reject(new Error("the file is larger than 30 MB"));
    }
    return fetch(url.href, { credentials: "same-origin" }).then(function (res) {
      if (!res.ok) {
        throw new Error("the download failed (HTTP " + res.status + ")");
      }
      return res.arrayBuffer();
    });
  }

  // ---- Submission text ------------------------------------------------------

  // { text, sources, skipped } for a submission, or an error for a submission
  // type the check cannot read.
  function submissionText(submission) {
    var type = submission.submission_type;
    if (!type || submission.workflow_state === "unsubmitted") {
      return Promise.reject(new Error("This student has not submitted anything yet."));
    }
    if (type === "online_text_entry") {
      return Promise.resolve({
        text: SubmissionText.htmlToText(submission.body),
        sources: ["Text entry"],
        skipped: []
      });
    }
    if (type !== "online_upload") {
      return Promise.reject(new Error(
        "The Pangram check reads text entries and PDF, Word (.docx), and .txt files. " +
        "This submission type (" + type + ") is not supported."
      ));
    }

    var texts = [];
    var sources = [];
    var skipped = [];
    var attachments = submission.attachments || [];

    function next(index) {
      if (index >= attachments.length) {
        return Promise.resolve({ text: texts.join("\n\n"), sources: sources, skipped: skipped });
      }
      var attachment = attachments[index];
      var name = attachment.display_name || attachment.filename || "file " + (index + 1);
      var kind = SubmissionText.kindOf(attachment);
      if (!kind) {
        skipped.push(name + " (file type not supported)");
        return next(index + 1);
      }
      return downloadAttachment(attachment)
        .then(function (buffer) {
          return SubmissionText.fileToText(kind, buffer);
        })
        .then(
          function (text) {
            if (text) {
              texts.push(text);
              sources.push(name);
            } else {
              skipped.push(name + " (no text found; it may be a scan)");
            }
          },
          function (err) {
            skipped.push(name + " (" + errorText(err) + ")");
          }
        )
        .then(function () {
          return next(index + 1);
        });
    }

    return next(0);
  }

  // ---- Check flow -----------------------------------------------------------

  function currentTarget() {
    var params = new URLSearchParams(location.search);
    var assignmentId = params.get("assignment_id") || "";
    var studentId = params.get("student_id") || "";
    var anonymousId = params.get("anonymous_id") || "";
    if (!CANVAS_ID.test(assignmentId)) {
      return null;
    }
    if (CANVAS_ID.test(studentId)) {
      return { assignmentId: assignmentId, studentId: studentId, key: assignmentId + ":" + studentId };
    }
    if (ANONYMOUS_ID.test(anonymousId)) {
      return { assignmentId: assignmentId, anonymousId: anonymousId, key: assignmentId + ":anon:" + anonymousId };
    }
    return null;
  }

  function stateFor(key) {
    if (!checks[key]) {
      checks[key] = { key: key, status: "idle", version: 0 };
    }
    return checks[key];
  }

  function update(state, changes) {
    Object.keys(changes).forEach(function (name) {
      state[name] = changes[name];
    });
    state.version++;
    renderSection();
    renderDialog();
  }

  function prepare(target) {
    var state = stateFor(target.key);
    update(state, { status: "preparing", error: "", needsKey: false, result: null, preview: null });
    openDialog(target.key);

    // The key check runs first: it also starts the background worker, which
    // locks the key away from content scripts before any student file is
    // parsed here.
    sendMessage({ type: "pangram-status" })
      .then(function (status) {
        if (!status.hasKey) {
          var err = new Error("Add your Pangram API key on the extension options page first.");
          err.needsKey = true;
          throw err;
        }
        return Promise.all([loadRoster(), loadSubmission(target)]);
      })
      .then(function (loaded) {
        var names = loaded[0].names.concat(userNames(loaded[1].user));
        var ids = loaded[0].ids.concat(userIds(loaded[1].user));
        return submissionText(loaded[1]).then(function (extracted) {
          if (!extracted.text) {
            var detail = extracted.skipped.length ? " Skipped: " + extracted.skipped.join("; ") + "." : "";
            throw new Error("No text was found in this submission." + detail);
          }
          var redactor = Redact.createRedactor(names, ids);
          var redacted = redactor.redact(extracted.text);
          update(state, {
            status: "ready",
            attempt: loaded[1].attempt,
            preview: {
              text: redacted.text,
              names: redacted.names,
              ids: redacted.ids,
              idsKnown: redactor.idCount > 0,
              emails: redacted.emails,
              words: wordCount(redacted.text),
              sources: extracted.sources,
              skipped: extracted.skipped
            }
          });
        });
      })
      .catch(function (err) {
        update(state, { status: "error", error: errorText(err), needsKey: !!err.needsKey });
      });
  }

  function send(state) {
    update(state, { status: "checking", stage: "" });
    var started = Date.now();

    function poll(taskId) {
      return delay(POLL_MS)
        .then(function () {
          return sendMessage({ type: "pangram-get-task", taskId: taskId });
        })
        .then(function (value) {
          var result = value.result || {};
          if (result.stage === "STAGE_SUCCESS") {
            update(state, { status: "done", result: result });
            return null;
          }
          if (result.stage === "STAGE_FAILED") {
            throw new Error("Pangram could not check this text: " + (result.headline || "unknown error") + ".");
          }
          if (Date.now() - started > POLL_LIMIT_MS) {
            throw new Error("Pangram did not finish within 5 minutes. Try again later.");
          }
          update(state, { stage: result.stage || "" });
          return poll(taskId);
        });
    }

    sendMessage({ type: "pangram-create-task", text: state.preview.text })
      .then(function (value) {
        return poll(value.taskId);
      })
      .catch(function (err) {
        update(state, { status: "error", error: errorText(err), needsKey: false });
      });
  }

  // ---- Grading-panel section ------------------------------------------------

  // The section goes right after the last submission-details block: the file
  // list, else the word count, else the "Submitted:" line.
  function findAnchor() {
    var candidates = [
      document.querySelector('[data-testid="submission-attachments-container"]'),
      document.querySelector('[data-testid="submission-word-count"]'),
      document.getElementById("single-submission-info")
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i]) {
        return candidates[i].closest("section") || candidates[i];
      }
    }
    return null;
  }

  function summaryText(result) {
    return (result.prediction_short || result.headline || "Result") + " — " +
      percent(result.fraction_ai) + " AI, " +
      percent(result.fraction_ai_assisted) + " AI-assisted, " +
      percent(result.fraction_human) + " human";
  }

  // A section button acts only if its student is still the one in the URL;
  // otherwise the section is out of date, so it is redrawn instead.
  function forStudent(key, action) {
    return function () {
      var target = currentTarget();
      if (target && target.key === key) {
        action(target);
      } else {
        renderSection();
      }
    };
  }

  function showDialog(target) {
    openDialog(target.key);
  }

  function fillSection(section, target, state) {
    section.textContent = "";
    section.appendChild(el("h3", "bc-pg-section-title", "Pangram"));
    var row = el("div", "bc-pg-section-row");
    section.appendChild(row);

    if (state.status === "preparing" || state.status === "checking" || state.status === "ready") {
      var label = state.status === "ready" ? "Ready to send — review the text" : "Working…";
      row.appendChild(button(label, "", forStudent(target.key, showDialog)));
      return;
    }
    if (state.status === "done") {
      row.appendChild(el("span", "bc-pg-summary bc-pg-verdict-" + verdictClass(state.result), summaryText(state.result)));
      row.appendChild(button("Details", "bc-pg-link", forStudent(target.key, showDialog)));
      return;
    }
    if (state.status === "error") {
      row.appendChild(el("span", "bc-pg-section-error", "Last check failed."));
    }
    row.appendChild(button("Check with Pangram", "bc-pg-primary", forStudent(target.key, prepare)));
  }

  function renderSection() {
    var target = currentTarget();
    var anchor = target && findAnchor();
    var section = document.querySelector("section[" + SECTION_MARK + "]");
    if (!anchor) {
      if (section) {
        section.remove();
      }
      return;
    }
    if (!section) {
      section = el("section", "bc-pg-section");
      section.setAttribute(SECTION_MARK, "");
    }
    if (section.previousElementSibling !== anchor) {
      anchor.after(section);
    }
    var state = stateFor(target.key);
    var stamp = target.key + "#" + state.version;
    if (section.getAttribute(SECTION_MARK) !== stamp) {
      section.setAttribute(SECTION_MARK, stamp);
      fillSection(section, target, state);
    }
    if (dialog && dialog.key !== target.key) {
      closeDialog(); // the grader moved to another student
    }
  }

  // ---- Dialog ---------------------------------------------------------------

  function verdictClass(result) {
    var verdict = String((result && result.prediction_short) || "").toLowerCase();
    return verdict === "ai" || verdict === "mixed" || verdict === "human" ? verdict : "unknown";
  }

  function segmentClass(label) {
    if (/assist/i.test(label)) {
      return "bc-pg-seg-assisted";
    }
    if (/\bai\b/i.test(label)) {
      return "bc-pg-seg-ai";
    }
    return "bc-pg-seg-human";
  }

  // The redacted text, with each [name], [netid], and [email] mark highlighted.
  function previewText(text) {
    var box = el("div", "bc-pg-text");
    text.split(/(\[name\]|\[netid\]|\[email\])/).forEach(function (part) {
      if (part === Redact.NAME_MARK || part === Redact.ID_MARK || part === Redact.EMAIL_MARK) {
        box.appendChild(el("mark", "bc-pg-redacted", part));
      } else if (part) {
        box.appendChild(document.createTextNode(part));
      }
    });
    return box;
  }

  // Pangram's returned text, colored by the label of each window. Windows may
  // overlap; each character takes the first window that covers it.
  function resultText(result) {
    var text = String(result.text || "");
    var box = el("div", "bc-pg-text");
    var windows = (result.windows || []).slice().sort(function (a, b) {
      return a.start_index - b.start_index;
    });
    var cursor = 0;
    windows.forEach(function (win) {
      var start = Math.max(cursor, Number(win.start_index) || 0);
      var end = Math.min(text.length, Number(win.end_index) || 0);
      if (end <= start) {
        return;
      }
      if (start > cursor) {
        box.appendChild(document.createTextNode(text.slice(cursor, start)));
      }
      var span = el("span", segmentClass(win.label || ""), text.slice(start, end));
      span.title = (win.label || "") + (win.confidence ? " (" + win.confidence + " confidence)" : "");
      box.appendChild(span);
      cursor = end;
    });
    if (cursor < text.length) {
      box.appendChild(document.createTextNode(text.slice(cursor)));
    }
    return box;
  }

  function fractionBar(result) {
    var bar = el("div", "bc-pg-bar");
    [
      ["bc-pg-seg-ai", result.fraction_ai, "AI"],
      ["bc-pg-seg-assisted", result.fraction_ai_assisted, "AI-assisted"],
      ["bc-pg-seg-human", result.fraction_human, "Human"]
    ].forEach(function (part) {
      var piece = el("span", part[0]);
      piece.style.flexGrow = String(Number(part[1]) || 0);
      piece.title = part[2] + " " + percent(part[1]);
      bar.appendChild(piece);
    });
    var legend = el("div", "bc-pg-legend");
    legend.appendChild(el("span", "bc-pg-key bc-pg-seg-ai", "AI " + percent(result.fraction_ai)));
    legend.appendChild(el("span", "bc-pg-key bc-pg-seg-assisted", "AI-assisted " + percent(result.fraction_ai_assisted)));
    legend.appendChild(el("span", "bc-pg-key bc-pg-seg-human", "Human " + percent(result.fraction_human)));
    var wrap = el("div");
    wrap.appendChild(bar);
    wrap.appendChild(legend);
    return wrap;
  }

  function facts(preview) {
    var list = el("ul", "bc-pg-facts");
    list.appendChild(el("li", "", "Names replaced: " + preview.names));
    if (preview.idsKnown) {
      list.appendChild(el("li", "", "NetIDs replaced: " + preview.ids));
    } else {
      list.appendChild(el("li", "bc-pg-skipped",
        "NetIDs: Canvas did not share the roster's login IDs, so NetIDs were not replaced"));
    }
    list.appendChild(el("li", "", "Email addresses replaced: " + preview.emails));
    list.appendChild(el("li", "", "Words: " + preview.words.toLocaleString()));
    list.appendChild(el("li", "", "From: " + preview.sources.join(", ")));
    preview.skipped.forEach(function (item) {
      list.appendChild(el("li", "bc-pg-skipped", "Skipped: " + item));
    });
    return list;
  }

  function fillDialog(state) {
    var body = dialog.body;
    var footer = dialog.footer;
    body.textContent = "";
    footer.textContent = "";
    var attempt = state.attempt ? " (attempt " + state.attempt + ")" : "";
    dialog.title.textContent = "Pangram check" + attempt;

    if (state.status === "preparing") {
      body.appendChild(el("p", "bc-pg-busy", "Getting the submission text and removing names…"));
      footer.appendChild(button("Close", "", closeDialog));
      return;
    }
    if (state.status === "ready") {
      var netIdText = state.preview.idsKnown ? ", their NetIDs with [netid]," : "";
      body.appendChild(el("p", "", "This is the exact text that will go to Pangram. Student names from " +
        "the course roster are replaced with [name]" + netIdText + " and email addresses with [email]. " +
        "Lowercase names, user names, and nicknames that are not on the roster are not replaced, so read " +
        "the text before you send it. Nothing has been sent yet."));
      body.appendChild(facts(state.preview));
      body.appendChild(previewText(state.preview.text));
      footer.appendChild(button("Cancel", "", function () {
        update(state, { status: "idle", preview: null });
        closeDialog();
      }));
      footer.appendChild(button("Send to Pangram", "bc-pg-primary", function () {
        send(state);
      }));
      return;
    }
    if (state.status === "checking") {
      var stage = state.stage ? " (" + state.stage.replace(/^STAGE_/, "").toLowerCase().replace(/_/g, " ") + ")" : "";
      body.appendChild(el("p", "bc-pg-busy", "Pangram is checking the text" + stage + "…"));
      body.appendChild(el("p", "bc-pg-note", "You can close this dialog. The result will show in the grading panel."));
      footer.appendChild(button("Close", "", closeDialog));
      return;
    }
    if (state.status === "done") {
      var result = state.result;
      var head = el("div", "bc-pg-result-head bc-pg-verdict-" + verdictClass(result));
      head.appendChild(el("strong", "", result.headline || result.prediction_short || "Result"));
      if (result.prediction) {
        head.appendChild(el("p", "", result.prediction));
      }
      body.appendChild(head);
      body.appendChild(fractionBar(result));
      body.appendChild(resultText(result));
      footer.appendChild(button("Check again", "", function () {
        var target = currentTarget();
        if (target && target.key === state.key) {
          prepare(target);
        }
      }));
      footer.appendChild(button("Close", "bc-pg-primary", closeDialog));
      return;
    }
    if (state.status === "error") {
      body.appendChild(el("p", "bc-pg-error", state.error));
      if (state.needsKey) {
        footer.appendChild(button("Open options", "bc-pg-primary", function () {
          sendMessage({ type: "open-options" }).catch(function (err) {
            console.warn("[BetterCanvas] could not open options", err);
          });
        }));
      }
      footer.appendChild(button("Close", "", closeDialog));
      return;
    }
    closeDialog();
  }

  function onDialogKey(event) {
    if (event.key === "Escape" && dialog) {
      event.stopPropagation();
      closeDialog();
    }
  }

  function openDialog(key) {
    if (dialog && dialog.key !== key) {
      closeDialog();
    }
    if (!dialog) {
      var root = el("div", "bc-pg-overlay");
      var panel = el("div", "bc-pg-dialog");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-labelledby", "bc-pg-dialog-title");
      var header = el("div", "bc-pg-dialog-header");
      var title = el("h2", "bc-pg-dialog-title");
      title.id = "bc-pg-dialog-title";
      header.appendChild(title);
      var close = button("×", "bc-pg-close", closeDialog);
      close.setAttribute("aria-label", "Close");
      header.appendChild(close);
      var body = el("div", "bc-pg-dialog-body");
      var footer = el("div", "bc-pg-dialog-footer");
      panel.appendChild(header);
      panel.appendChild(body);
      panel.appendChild(footer);
      root.appendChild(panel);
      // Close on a backdrop click only when the press also started on the
      // backdrop: a drag that selects dialog text and ends outside the
      // dialog makes Chrome send the click to the backdrop too.
      var pressedBackdrop = false;
      root.addEventListener("pointerdown", function (event) {
        pressedBackdrop = event.target === root;
      });
      root.addEventListener("click", function (event) {
        if (event.target === root && pressedBackdrop && event.detail <= 1) {
          closeDialog();
        }
      });
      document.body.appendChild(root);
      document.addEventListener("keydown", onDialogKey, true);
      dialog = { key: key, root: root, title: title, body: body, footer: footer, version: -1 };
    }
    renderDialog();
    var primary = dialog.footer.querySelector(".bc-pg-primary") || dialog.footer.querySelector("button");
    if (primary) {
      primary.focus();
    }
  }

  function renderDialog() {
    if (!dialog) {
      return;
    }
    var state = stateFor(dialog.key);
    if (dialog.version !== state.version) {
      dialog.version = state.version;
      fillDialog(state);
    }
  }

  function closeDialog() {
    if (!dialog) {
      return;
    }
    document.removeEventListener("keydown", onDialogKey, true);
    dialog.root.remove();
    dialog = null;
  }

  // ---- Boot -----------------------------------------------------------------

  var queued = false;
  function scheduleRender() {
    if (queued) {
      return;
    }
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      renderSection();
    });
  }

  // SpeedGrader may switch students by only rewriting text in place, which a
  // childList observer does not see, so a URL change also redraws.
  renderSection();
  new MutationObserver(scheduleRender).observe(document.body, { childList: true, subtree: true });
  navigation.addEventListener("currententrychange", scheduleRender);
})();
