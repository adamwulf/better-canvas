// Better Canvas (Rice) — Pangram AI-detection check in SpeedGrader
//
// Adds a "Pangram" section to the SpeedGrader grading panel, under the
// submission details. The section shows two steps for the submission on
// screen: "Prepare text for Pangram" and "Send to Pangram". Preparing runs
// these steps:
//
//   1. Ask the background worker whether a Pangram API key is saved.
//   2. Load the submission with all its attempts (GET /api/v1/courses/:id/
//      assignments/:id/submissions/:user_id?include[]=submission_history),
//      and take the attempt on screen: the one the URL's attempt parameter
//      names (SpeedGrader adds it when the grader picks an earlier
//      submission in "Submission to view"), else the latest.
//   3. Turn that attempt into plain text in the browser: the text-entry
//      body, or each PDF, Word (.docx), or .txt file
//      (BetterCanvasSubmissionText), joined into one text. If a result is
//      saved for that text, show it and stop here (see below); showing it
//      needs no API key and no roster. Otherwise, with no key, stop here.
//   4. Load every student on the course roster (GET /api/v1/courses/:id/
//      users?enrollment_type[]=student), and replace every roster name with
//      "[name]", every roster NetID (the Canvas login_id) with "[netid]", and
//      every email address with "[email]" (BetterCanvasRedact). If the
//      roster cannot load, the check stops here and nothing is sent.
//   5. Show "Text prepared" in the section. No dialog opens by itself:
//      "Details" opens the redacted text in an editable box in a dialog,
//      where the grader removes anything the rules missed. Nothing leaves
//      the browser until "Send to Pangram" is clicked.
//
// "Send to Pangram", in the dialog or in the section, closes the dialog, and
// the background worker sends only the text in that box to Pangram. The
// section shows the progress and then the result; "Details" opens the result
// in the dialog, with the text colored by segment. The dialog's "Check again"
// closes it and prepares the text again in the section.
//
// With "Send without preview" checked, the section shows only "Send to
// Pangram", which prepares the text (steps 1-4) and sends it at once, with no
// dialog. The Details dialog's "Check again" button then reads "Send to
// Pangram again" and does the same. That one setting is saved in
// chrome.storage.sync.
//
// SpeedGrader is a React app that switches students and attempts without a
// page load and re-renders the grading panel, so a MutationObserver and the
// Navigation API's currententrychange event keep the section in place and in
// step with the student and attempt in the URL. Each attempt has its own
// section state, and each section button checks the URL again before it
// acts.
//
// Each result is saved in chrome.storage.local, through the background worker
// (which keeps that area from content scripts), under the SHA-256 hash of the
// text from step 3: the attempt's joined text before redaction and before
// any edit in the dialog, so each attempt finds the result for its own text.
// Preparing a text with a saved result shows that result and sends nothing.
// Each time a student or attempt comes up with an idle section and any
// result is saved, steps 1-3 run by themselves to look for that attempt's
// saved result, so a submission already checked shows its result with no
// click; with none, the section stays at step 1 and keeps the
// text for "Prepare text for Pangram" during that visit. "Check again" (or
// "Send to Pangram again") always sends a new check, and its result replaces
// the saved one. A saved result holds Pangram's answer (with the redacted
// text Pangram scored and the model version), the facts shown with it, the
// model selector the check sent, and the time of the check. Results saved
// before the selector was kept show only the version.

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
  var ATTEMPT = /^[1-9]\d*$/;
  var SEND_WITHOUT_PREVIEW = "pangramSendWithoutPreview"; // chrome.storage.sync key
  var CATEGORIES = [
    { key: "ai", label: "AI", field: "fraction_ai" },
    { key: "assisted", label: "AI-assisted", field: "fraction_ai_assisted" },
    { key: "human", label: "Human", field: "fraction_human" }
  ];

  var checks = Object.create(null); // submission key -> check state
  var latestAttempts = Object.create(null); // student key -> latest attempt number, from the last read of the latest
  var rosterReady = null; // Promise<{ names, ids }>, loaded once per page
  var dialog = null; // { key, root, body, footer }
  var sendWithoutPreview = false;
  var shownKey = ""; // the student and attempt last on screen

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
  // opens or closes the dialog or redraws the section, and the second would
  // then land on the backdrop or on a new button.
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

  function wordsText(count) {
    return "Words: " + count.toLocaleString();
  }

  function checkedText(time) {
    return "Checked " + new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  // The model selector the check sent, and the version Pangram reports in
  // its result.
  function modelText(model, result) {
    var version = result && result.version ? String(result.version) : "";
    if (model && version) {
      return "Model: " + model + " (version " + version + ")";
    }
    if (model) {
      return "Model: " + model;
    }
    return version ? "Model version: " + version : "Model: unknown";
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

  function openOptions() {
    sendMessage({ type: "open-options" }).catch(function (err) {
      console.warn("[BetterCanvas] could not open options", err);
    });
  }

  function setSendWithoutPreview(value) {
    sendWithoutPreview = value;
    var items = {};
    items[SEND_WITHOUT_PREVIEW] = value;
    Promise.resolve()
      .then(function () {
        return chrome.storage.sync.set(items);
      })
      .catch(function (err) {
        console.warn("[BetterCanvas] could not save the Pangram setting", err);
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

  // The submission, with each of its attempts in submission_history.
  function loadSubmission(target) {
    var base = "/api/v1/courses/" + courseId + "/assignments/" + target.assignmentId;
    var url = target.studentId
      ? base + "/submissions/" + target.studentId + "?include[]=user&include[]=submission_history"
      : base + "/anonymous_submissions/" + target.anonymousId + "?include[]=submission_history";
    return canvasFetch(url).then(function (res) {
      return res.json();
    });
  }

  // The attempt on screen: the one the URL names, else the latest (the
  // submission itself). Each submission_history entry is one attempt, with
  // its own type, text, and files.
  function shownAttempt(submission, attempt) {
    if (!attempt) {
      return submission;
    }
    var found = (submission.submission_history || []).filter(function (entry) {
      return String(entry.attempt) === attempt;
    })[0];
    if (!found) {
      throw new Error("Canvas did not return attempt " + attempt + " of this submission.");
    }
    return found;
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

  // ---- Saved results --------------------------------------------------------

  // The hex SHA-256 hash of a text: the name its result is saved under.
  function textHash(text) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (digest) {
      return Array.from(new Uint8Array(digest), function (byte) {
        return byte.toString(16).padStart(2, "0");
      }).join("");
    });
  }

  // The saved result for a text hash, or null. A failed read counts as no
  // saved result, so the check can still run.
  function loadSaved(hash) {
    return sendMessage({ type: "pangram-load-result", hash: hash }).then(
      function (value) {
        var saved = value.saved;
        return saved && saved.result && saved.preview && typeof saved.checkedAt === "number" ? saved : null;
      },
      function (err) {
        console.warn("[BetterCanvas] could not read the saved Pangram result", err);
        return null;
      }
    );
  }

  // Saves a finished check under its text hash, in place of any older result
  // for the same text. The preview's text is left out: Pangram's result
  // already holds the text it scored.
  function saveResult(state) {
    var preview = state.preview;
    sendMessage({
      type: "pangram-save-result",
      hash: state.hash,
      saved: {
        checkedAt: state.checkedAt,
        model: state.model,
        result: state.result,
        preview: {
          names: preview.names,
          ids: preview.ids,
          idsKnown: preview.idsKnown,
          emails: preview.emails,
          words: preview.words,
          sources: preview.sources,
          skipped: preview.skipped
        }
      }
    }).catch(function (err) {
      console.warn("[BetterCanvas] could not save the Pangram result", err);
    });
  }

  // ---- Check flow -----------------------------------------------------------

  // The student and attempt on screen. SpeedGrader adds attempt=N to the URL
  // when the grader picks a submission in "Submission to view"; without it,
  // the latest attempt is on screen. Each attempt has its own check state,
  // under a key that names the attempt. The latest attempt has one key, with
  // or without attempt=N in the URL, once a read with no attempt in the URL
  // has found its number.
  function currentTarget() {
    var params = new URLSearchParams(location.search);
    var assignmentId = params.get("assignment_id") || "";
    var studentId = params.get("student_id") || "";
    var anonymousId = params.get("anonymous_id") || "";
    var attempt = params.get("attempt") || "";
    var target;
    if (!CANVAS_ID.test(assignmentId)) {
      return null;
    }
    if (CANVAS_ID.test(studentId)) {
      target = { assignmentId: assignmentId, studentId: studentId, studentKey: assignmentId + ":" + studentId };
    } else if (ANONYMOUS_ID.test(anonymousId)) {
      target = { assignmentId: assignmentId, anonymousId: anonymousId, studentKey: assignmentId + ":anon:" + anonymousId };
    } else {
      return null;
    }
    target.attempt = ATTEMPT.test(attempt) ? attempt : "";
    var named = target.attempt && target.attempt !== latestAttempts[target.studentKey];
    target.key = target.studentKey + (named ? ":attempt:" + target.attempt : "");
    return target;
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

  // { submission, user, extracted, hash }: the attempt on screen, the student
  // (when Canvas includes them), the attempt's text, and that text's hash.
  // The caller messages the background worker first, which starts it, so it
  // locks the key away from content scripts before any student file is
  // parsed here.
  function readSubmission(target) {
    var submission, user, extracted;
    return loadSubmission(target)
      .then(function (loaded) {
        // Only a read of the latest records its number, so a state under a
        // key that names the attempt is not moved to the latest one's key
        // while it is in use.
        if (!target.attempt && loaded.attempt) {
          latestAttempts[target.studentKey] = String(loaded.attempt);
        }
        user = loaded.user;
        submission = shownAttempt(loaded, target.attempt);
        return submissionText(submission);
      })
      .then(function (found) {
        if (!found.text) {
          var detail = found.skipped.length ? " Skipped: " + found.skipped.join("; ") + "." : "";
          throw new Error("No text was found in this submission." + detail);
        }
        extracted = found;
        return textHash(found.text);
      })
      .then(function (hash) {
        return { submission: submission, user: user, extracted: extracted, hash: hash };
      });
  }

  function showSavedResult(state, read, saved) {
    update(state, {
      status: "done",
      attempt: read.submission.attempt,
      hash: read.hash,
      result: saved.result,
      model: typeof saved.model === "string" ? saved.model : "",
      preview: saved.preview,
      checkedAt: saved.checkedAt
    });
  }

  // Looks for a saved result each time a student or attempt comes up with an
  // idle section, so a submission already checked shows its result with no
  // click. It reads the text but needs no key or roster, and nothing leaves
  // the browser. It runs only when some result is saved, and only if the
  // attempt is still on screen, so paging through students does not read
  // every submission. With no saved result, the section goes back to step 1 and
  // keeps the text it read for "Prepare text for Pangram" during this visit;
  // Prepare also shows any error.
  function lookup(target) {
    var state = stateFor(target.key);
    state.lookedUp = true;
    var read;
    // As in prepare(), this message starts the background worker first.
    sendMessage({ type: "pangram-status" })
      .then(function (status) {
        if (state.status !== "idle") {
          return null; // the grader clicked a button meanwhile
        }
        var current = currentTarget();
        if (!current || current.key !== target.key) {
          return null; // renderSection() looks again when the attempt is back
        }
        if (!status.hasResults) {
          return null;
        }
        update(state, { status: "looking" });
        return readSubmission(target)
          .then(function (found) {
            read = found;
            return loadSaved(read.hash);
          })
          .then(function (saved) {
            if (saved) {
              showSavedResult(state, read, saved);
            } else {
              update(state, { status: "idle", read: read });
            }
          });
      })
      .catch(function () {
        if (state.status === "looking") {
          update(state, { status: "idle" });
        }
      });
  }

  // Gets the submission text and redacts it. No dialog opens: the section
  // shows the progress, and then "Details" opens the text for review. With
  // thenSend the text goes to Pangram as soon as it is ready. A result saved
  // for the same text is shown instead, unless recheck asks for a new check.
  // Text the lookup already read is used again, except by a recheck, which
  // reads the submission again.
  function prepare(target, thenSend, recheck) {
    var state = stateFor(target.key);
    var alreadyRead = recheck ? null : state.read;
    update(state, { status: "preparing", error: "", needsKey: false, result: null, model: "", preview: null, hash: "", checkedAt: 0, read: null });
    var hasKey, read;

    // The key check runs first: it also starts the background worker, which
    // locks the key away from content scripts before any student file is
    // parsed here. A missing key stops only a new check, after the saved
    // result lookup, because showing a saved result needs no key.
    sendMessage({ type: "pangram-status" })
      .then(function (status) {
        hasKey = status.hasKey;
        return alreadyRead || readSubmission(target);
      })
      .then(function (found) {
        read = found;
        return recheck ? null : loadSaved(read.hash);
      })
      .then(function (saved) {
        if (saved) {
          showSavedResult(state, read, saved);
          return null;
        }
        if (!hasKey) {
          var err = new Error("Add your Pangram API key on the extension options page first.");
          err.needsKey = true;
          throw err;
        }
        // Only a new check needs the roster, so a saved result still shows
        // when the roster cannot load.
        return loadRoster().then(function (roster) {
          var submission = read.submission;
          var extracted = read.extracted;
          var names = roster.names.concat(userNames(read.user));
          var ids = roster.ids.concat(userIds(read.user));
          var redactor = Redact.createRedactor(names, ids);
          var redacted = redactor.redact(extracted.text);
          update(state, {
            status: "ready",
            attempt: submission.attempt,
            hash: read.hash,
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
          if (thenSend) {
            send(state);
          }
        });
      })
      .catch(function (err) {
        update(state, { status: "error", error: errorText(err), needsKey: !!err.needsKey });
      });
  }

  // The section shows the progress and the result, so the dialog closes.
  function send(state) {
    if (dialog && dialog.key === state.key) {
      closeDialog();
    }
    update(state, { status: "checking", stage: "" });
    var started = Date.now();

    // model: the selector the background worker sent with the text.
    function poll(taskId, model) {
      return delay(POLL_MS)
        .then(function () {
          return sendMessage({ type: "pangram-get-task", taskId: taskId });
        })
        .then(function (value) {
          var result = value.result || {};
          if (result.stage === "STAGE_SUCCESS") {
            update(state, { status: "done", result: result, model: model, checkedAt: Date.now() });
            saveResult(state);
            return null;
          }
          if (result.stage === "STAGE_FAILED") {
            throw new Error("Pangram could not check this text: " + (result.headline || "unknown error") + ".");
          }
          if (Date.now() - started > POLL_LIMIT_MS) {
            throw new Error("Pangram did not finish within 5 minutes. Try again later.");
          }
          update(state, { stage: result.stage || "" });
          return poll(taskId, model);
        });
    }

    // The editor's current text, as the grader left it.
    sendMessage({ type: "pangram-create-task", text: state.preview.text })
      .then(function (value) {
        return poll(value.taskId, value.model);
      })
      .catch(function (err) {
        update(state, { status: "error", error: errorText(err), needsKey: false });
      });
  }

  // Sends the prepared text as the grader left it, or, when no text is
  // prepared yet ("Send without preview"), prepares it and sends it at once.
  function sendNow(target) {
    var state = stateFor(target.key);
    if (state.preview) {
      send(state);
    } else {
      prepare(target, true);
    }
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

  function fraction(result, category) {
    return Number(result[category.field]) || 0;
  }

  // The category with the largest share; the first one listed wins a tie.
  function winner(result) {
    return CATEGORIES.reduce(function (best, category) {
      return fraction(result, category) > fraction(result, best) ? category : best;
    });
  }

  // One line per category, the winner in bold.
  function scoreLines(result, top) {
    var lines = el("div", "bc-pg-scores");
    CATEGORIES.forEach(function (category) {
      lines.appendChild(el("div", category === top ? "bc-pg-winner" : "",
        category.label + ": " + percent(fraction(result, category))));
    });
    return lines;
  }

  // What the redaction could not cover, shown with the result because a
  // check sent without preview never showed the review dialog.
  function sentNotes(preview) {
    var notes = [];
    if (!preview.idsKnown) {
      notes.push("NetIDs were not replaced.");
    }
    if (preview.skipped.length) {
      notes.push(preview.skipped.length === 1 ? "1 file was skipped." : preview.skipped.length + " files were skipped.");
    }
    return notes.length ? el("div", "bc-pg-skipped bc-pg-sent-notes", notes.join(" ")) : null;
  }

  function stageText(stage) {
    return stage ? " (" + stage.replace(/^STAGE_/, "").toLowerCase().replace(/_/g, " ") + ")" : "";
  }

  // A section button acts only if its student and attempt are still the ones
  // in the URL; otherwise the section is out of date, so it is redrawn
  // instead.
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

  function reviewText(target) {
    update(stateFor(target.key), { status: "ready" });
    openDialog(target.key);
  }

  function sectionRow(parent) {
    var row = el("div", "bc-pg-section-row");
    parent.appendChild(row);
    return row;
  }

  // Step 1 prepares the text (once it is ready, "Details" opens it for
  // review); step 2 sends it, and is off until there is text to send. While
  // busy, both steps are off.
  function fillSteps(section, target, state, busy) {
    var first = sectionRow(section);
    first.appendChild(el("span", "bc-pg-step-number", "1."));
    var firstButton;
    if (state.preview) {
      first.appendChild(el("span", "", "Text prepared"));
      firstButton = button("Details", "bc-pg-link", forStudent(target.key, reviewText));
    } else {
      firstButton = button("Prepare text for Pangram", "bc-pg-primary", forStudent(target.key, prepare));
    }
    firstButton.disabled = busy;
    first.appendChild(firstButton);
    var second = sectionRow(section);
    second.appendChild(el("span", "bc-pg-step-number", "2."));
    var sendButton = button("Send to Pangram", state.preview ? "bc-pg-primary" : "", forStudent(target.key, sendNow));
    sendButton.disabled = busy || !state.preview;
    second.appendChild(sendButton);
  }

  function previewOption(disabled) {
    var label = el("label", "bc-pg-option" + (disabled ? " bc-pg-option-off" : ""));
    var box = el("input");
    box.type = "checkbox";
    box.checked = sendWithoutPreview;
    box.disabled = !!disabled;
    box.addEventListener("change", function () {
      setSendWithoutPreview(box.checked);
      renderSection();
      // The redraw replaced the checkbox; keep keyboard focus on it.
      var redrawn = document.querySelector("section[" + SECTION_MARK + "] .bc-pg-option input");
      if (redrawn) {
        redrawn.focus();
      }
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode("Send without preview"));
    return label;
  }

  function fillSection(section, target, state) {
    section.textContent = "";

    if (state.status === "done") {
      var result = state.result;
      var top = winner(result);
      section.className = "bc-pg-section bc-pg-tint-" + top.key;
      section.appendChild(el("h3", "bc-pg-section-title",
        "Pangram: " + (result.prediction_short || result.headline || "Result")));
      section.appendChild(scoreLines(result, top));
      var checked = el("div", "bc-pg-checked");
      checked.appendChild(el("div", "", checkedText(state.checkedAt)));
      checked.appendChild(el("div", "", modelText(state.model, result)));
      section.appendChild(checked);
      var notes = sentNotes(state.preview);
      if (notes) {
        section.appendChild(notes);
      }
      sectionRow(section).appendChild(button("Details", "bc-pg-link", forStudent(target.key, showDialog)));
      return;
    }

    // idle, looking, preparing, ready, checking, or error: the checkbox
    // first, so it stays put when the buttons under it change, then any
    // error, then the buttons. While looking, preparing, or checking, the
    // controls stay in place but are off, and a line under them shows the
    // progress.
    var busy = state.status === "looking" || state.status === "preparing" || state.status === "checking";
    section.className = "bc-pg-section";
    section.appendChild(el("h3", "bc-pg-section-title", "Pangram"));
    section.appendChild(previewOption(busy));
    if (state.status === "error") {
      section.appendChild(el("div", "bc-pg-section-error", state.error));
      if (state.needsKey) {
        sectionRow(section).appendChild(button("Open options", "", openOptions));
      }
    }
    if (sendWithoutPreview) {
      var sendButton = button("Send to Pangram", "bc-pg-primary", forStudent(target.key, sendNow));
      sendButton.disabled = busy;
      sectionRow(section).appendChild(sendButton);
    } else {
      fillSteps(section, target, state, busy);
    }
    if (state.status === "looking") {
      section.appendChild(el("div", "bc-pg-busy", "Looking for a saved result…"));
    } else if (state.status === "preparing") {
      section.appendChild(el("div", "bc-pg-busy", "Preparing the text…"));
    } else if (state.status === "checking") {
      section.appendChild(el("div", "bc-pg-busy", "Pangram is checking the text" + stageText(state.stage) + "…"));
    }
  }

  function renderSection() {
    var target = currentTarget();
    // Each time a student or attempt comes up, an idle section looks for a
    // saved result again, so it reads the submission as it is now (with no
    // attempt in the URL, a new latest attempt), not text from an earlier
    // visit.
    if (target && target.key !== shownKey) {
      shownKey = target.key;
      var arrived = stateFor(target.key);
      if (arrived.status === "idle") {
        arrived.lookedUp = false;
        arrived.read = null;
      }
    }
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
    if (state.status === "idle" && !state.lookedUp) {
      lookup(target);
    }
    var stamp = [target.key, state.version, sendWithoutPreview].join("#");
    if (section.getAttribute(SECTION_MARK) !== stamp) {
      section.setAttribute(SECTION_MARK, stamp);
      fillSection(section, target, state);
    }
    if (dialog && dialog.key !== target.key) {
      closeDialog(); // the grader moved to another student or attempt
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

  // The redacted text in an editor, so the grader can remove anything the
  // rules missed. Edits go straight into the preview state (not through
  // update(), which would redraw the dialog and reset the editor), and "Send
  // to Pangram" sends exactly what the editor holds.
  function previewEditor(preview) {
    var editor = el("textarea", "bc-pg-text bc-pg-editor");
    editor.value = preview.text;
    editor.spellcheck = false;
    editor.setAttribute("aria-label", "Text to send to Pangram");
    editor.addEventListener("input", function () {
      preview.text = editor.value;
      preview.words = wordCount(editor.value);
      var words = dialog && dialog.body.querySelector(".bc-pg-words");
      if (words) {
        words.textContent = wordsText(preview.words);
      }
    });
    return editor;
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
    var legend = el("div", "bc-pg-legend");
    CATEGORIES.forEach(function (category) {
      var share = fraction(result, category);
      var piece = el("span", "bc-pg-seg-" + category.key);
      piece.style.flexGrow = String(share);
      piece.title = category.label + " " + percent(share);
      bar.appendChild(piece);
      legend.appendChild(el("span", "bc-pg-key bc-pg-seg-" + category.key, category.label + " " + percent(share)));
    });
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
    list.appendChild(el("li", "bc-pg-words", wordsText(preview.words)));
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

    if (state.status === "ready") {
      var netIdText = state.preview.idsKnown ? ", NetIDs with [netid]," : "";
      body.appendChild(el("p", "", "This text goes to Pangram when you click Send. Roster names are " +
        "replaced with [name]" + netIdText + " and email addresses with [email]. The rules catch the " +
        "usual forms of a name, not every one: read the text and edit it to remove anything they missed. " +
        "Nothing has been sent yet."));
      body.appendChild(facts(state.preview));
      body.appendChild(previewEditor(state.preview));
      footer.appendChild(button("Cancel", "", function () {
        update(state, { status: "idle", preview: null });
        closeDialog();
      }));
      footer.appendChild(button("Send to Pangram", "bc-pg-primary", function () {
        send(state);
      }));
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
      var list = facts(state.preview);
      list.insertBefore(el("li", "", modelText(state.model, result)), list.firstChild);
      list.insertBefore(el("li", "", checkedText(state.checkedAt)), list.firstChild);
      body.appendChild(list);
      body.appendChild(resultText(result));
      // With "Send without preview" on, this sends at once, so it says so.
      // Either way it skips the saved result and makes a new check.
      footer.appendChild(button(sendWithoutPreview ? "Send to Pangram again" : "Check again", "", function () {
        var target = currentTarget();
        if (target && target.key === state.key) {
          closeDialog(); // the section shows this check
          prepare(target, sendWithoutPreview, true);
        }
      }));
      footer.appendChild(button("Close", "bc-pg-primary", closeDialog));
      return;
    }
    // idle, looking, preparing, checking, or error: the section shows these,
    // not the dialog.
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
  chrome.storage.sync.get(SEND_WITHOUT_PREVIEW)
    .then(function (items) {
      sendWithoutPreview = items[SEND_WITHOUT_PREVIEW] === true;
      renderSection();
    })
    .catch(function (err) {
      console.warn("[BetterCanvas] could not read the Pangram setting", err);
    });
})();
