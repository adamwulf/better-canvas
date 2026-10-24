// Better Canvas (Rice) — "Email this student" link in SpeedGrader
//
// Adds an "Email this student" mailto: link under the "Submitted:" row of
// the SpeedGrader grading panel. A student with more than one submission has
// "Submission to view:" in place of that row, so the link goes under it
// instead. The address is the student's primary email, from
// GET /api/v1/courses/:id/users/:user_id?include[]=email, which Canvas fills
// in only when the grader may read email addresses. It is loaded once per
// student per page; with no address, no link shows.
//
// Anonymous grading names the student only by an anonymous_id in the URL,
// so the link shows only when the URL has a student_id.
//
// SpeedGrader is a React app that switches students without a page load and
// re-renders the grading panel, so a MutationObserver and the Navigation
// API's currententrychange event keep the link in place and in step with the
// student_id in the URL.

(function () {
  "use strict";

  var courseMatch = location.pathname.match(/^\/courses\/(\d+(?:~\d+)?)\/gradebook\/speed_grader\/?$/);
  if (!courseMatch) {
    return;
  }
  var courseId = courseMatch[1];

  var LINK_MARK = "data-bc-email-student";
  var CANVAS_ID = /^\d+(?:~\d+)?$/;

  var emails = Object.create(null); // student id -> address ("" for none), or null while it loads

  function loadEmail(studentId) {
    var url = "/api/v1/courses/" + courseId + "/users/" + studentId +
      "?include[]=email&include[]=inactive_enrollments";
    return fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error("Canvas answered HTTP " + res.status + " for " + url.split("?")[0]);
        }
        return res.json();
      })
      .then(function (user) {
        return user && typeof user.email === "string" ? user.email.trim() : "";
      });
  }

  // The student's address, "" for none, or null while it loads. A failed
  // load counts as no address until the page loads again, so a Canvas error
  // does not send a new request on each redraw.
  function emailFor(studentId) {
    if (!(studentId in emails)) {
      emails[studentId] = null;
      loadEmail(studentId)
        .then(
          function (email) {
            emails[studentId] = email;
          },
          function (err) {
            emails[studentId] = "";
            console.warn("[BetterCanvas] could not load the student's email address", err);
          }
        )
        .then(render);
    }
    return emails[studentId];
  }

  // Each character an address may hold is encoded except the "@", so a "?"
  // or "#" in it cannot start the query or fragment of the mailto: URL.
  function mailtoHref(email) {
    return "mailto:" + encodeURIComponent(email).replace(/%40/g, "@");
  }

  // The row the link goes under: "Submitted:" for a student with one
  // submission, else the "Submission to view:" picker.
  function findRow() {
    var single = document.getElementById("single-submission-info");
    if (single) {
      return single;
    }
    var picker = document.querySelector('[data-testid="submission-history-select"]');
    return picker && picker.closest("section");
  }

  // The link goes last inside the row's own section, not after it: the
  // Pangram section may go right after the "Submitted:" section, and two
  // scripts that each put their element there would move each other forever.
  function render() {
    var studentId = new URLSearchParams(location.search).get("student_id") || "";
    var row = findRow();
    var holder = document.querySelector("[" + LINK_MARK + "]");
    var email = row && CANVAS_ID.test(studentId) ? emailFor(studentId) : "";
    if (!email) {
      if (holder) {
        holder.remove();
      }
      return;
    }
    if (!holder) {
      holder = document.createElement("div");
      holder.setAttribute(LINK_MARK, "");
      var link = document.createElement("a");
      link.textContent = "Email this student";
      holder.appendChild(link);
    }
    var href = mailtoHref(email);
    if (holder.firstChild.getAttribute("href") !== href) {
      holder.firstChild.setAttribute("href", href);
    }
    if (row.lastElementChild !== holder) {
      row.appendChild(holder);
    }
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
      render();
    });
  }

  // SpeedGrader may switch students by only rewriting text in place, which a
  // childList observer does not see, so a URL change also redraws.
  render();
  new MutationObserver(scheduleRender).observe(document.body, { childList: true, subtree: true });
  navigation.addEventListener("currententrychange", scheduleRender);
})();
