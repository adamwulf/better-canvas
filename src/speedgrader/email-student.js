// Better Canvas (Rice) — "Email this student" link in SpeedGrader
//
// Adds an "Email this student" mailto: link at the top of the SpeedGrader
// grading panel, for every student, with or without a submission. The
// address is the student's primary email, from
// GET /api/v1/courses/:id/users/:user_id?include[]=email&include[]=
// inactive_enrollments. Canvas fills in the email only when the grader may
// read email addresses. Without inactive_enrollments, Canvas does not find a
// student whose enrollment is inactive (SpeedGrader shows them when the
// Gradebook shows inactive enrollments), so that student would get no link.
// The address is loaded once per student per page; with no address, no link
// shows.
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

  var HOLDER_CLASS = "bc-email-student";
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

  // The grading panel's column of items, which every student has. The link
  // goes first in it, as one more item, so the column keeps its height.
  function findColumn() {
    var panel = document.querySelector('[data-testid="speedgrader-grading-panel"]');
    return panel && panel.firstElementChild;
  }

  function render() {
    var studentId = new URLSearchParams(location.search).get("student_id") || "";
    var column = findColumn();
    var holder = document.querySelector("." + HOLDER_CLASS);
    var email = column && CANVAS_ID.test(studentId) ? emailFor(studentId) : "";
    if (!email) {
      if (holder) {
        holder.remove();
      }
      return;
    }
    if (!holder) {
      holder = document.createElement("div");
      holder.className = HOLDER_CLASS;
      // A new tab, so a web mail handler (Gmail, Outlook) does not replace
      // SpeedGrader and any unsaved comment in it.
      var link = document.createElement("a");
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Email this student";
      holder.appendChild(link);
    }
    var href = mailtoHref(email);
    if (holder.firstChild.getAttribute("href") !== href) {
      holder.firstChild.setAttribute("href", href);
    }
    if (column.firstElementChild !== holder) {
      column.prepend(holder);
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
