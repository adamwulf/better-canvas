// Better Canvas (Rice) — flashcard study mode on the Esther course roster.
//
// The roster page (esther.rice.edu/selfserve/swkrost.main) lists every student
// as a row in <table class="reporttable">, with a photo, a name, and a
// NameCoach pronunciation <iframe> among the columns. This script adds a
// "Flashcard Mode" button next to "Download Roster". Pressing it dims the page
// and deals a deck of cards:
//
//   - The card front shows the student photo.
//   - Clicking the card flips it to the name and the pronunciation player.
//   - Green "Correct" / red "Incorrect" buttons grade the guess, send the card
//     to the back of the deck, and deal the next student.
//
// The deck shows every student once in random order (one "pass"), then it
// reshuffles for the next pass, so the whole class is covered each time. A live
// score (correct / incorrect / percent) shows at the top. Nothing is stored;
// the score dies with the overlay.
//
// Columns are located by their header text ("Photo", "Name", "Name
// Pronunciation"), not by fixed position, so the parser survives a column
// reorder. The photo <img> and the pronunciation <iframe> are cloned straight
// out of the page onto the card, so the real NameCoach play button keeps
// working without us reaching into a cross-origin data: iframe.

(function () {
  "use strict";

  // Do not start twice (a re-injection, an SPA-style re-run, etc.).
  if (window.__bcFlashcards) return;
  window.__bcFlashcards = true;

  /* ------------------------------------------------------------------- */
  /* 1. Read the roster from the page.                                   */
  /* ------------------------------------------------------------------- */

  // Collapse whitespace and trim a text value.
  function tidyText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  // Find the column index whose header text equals wantedLabel (case-folded).
  function findColumn(headerCells, wantedLabel) {
    for (var i = 0; i < headerCells.length; i++) {
      if (tidyText(headerCells[i].textContent).toLowerCase() === wantedLabel) {
        return i;
      }
    }
    return -1;
  }

  // Read all students: name, the photo <img> node, and the pronunciation
  // <iframe> node (or null when a student has no recording).
  function readStudents() {
    var table = document.querySelector("table.reporttable");
    if (!table) return [];

    var rows = Array.prototype.slice.call(table.querySelectorAll("tr"));
    if (!rows.length) return [];

    // The header row is the first row that has both a "Photo" and a "Name" cell.
    var headerRow = null;
    var photoIdx = -1;
    var nameIdx = -1;
    var pronIdx = -1;

    for (var r = 0; r < rows.length; r++) {
      var headerCandidate = rows[r].children;
      var pIdx = findColumn(headerCandidate, "photo");
      var nIdx = findColumn(headerCandidate, "name");
      if (pIdx !== -1 && nIdx !== -1) {
        headerRow = rows[r];
        photoIdx = pIdx;
        nameIdx = nIdx;
        pronIdx = findColumn(headerCandidate, "name pronunciation");
        rows = rows.slice(r + 1); // Keep only the rows after the header.
        break;
      }
    }

    if (!headerRow) return [];

    var students = [];
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].children;
      if (!cells || cells.length <= nameIdx) continue;

      var name = tidyText(cells[nameIdx].textContent);
      if (!name) continue; // Skip spacer or note rows.

      var photoImg = photoIdx !== -1 && cells[photoIdx]
        ? cells[photoIdx].querySelector("img")
        : null;
      var pronFrame = pronIdx !== -1 && cells[pronIdx]
        ? cells[pronIdx].querySelector("iframe")
        : null;

      students.push({ name: name, photo: photoImg, pron: pronFrame });
    }
    return students;
  }

  /* ------------------------------------------------------------------- */
  /* 2. The flashcard game.                                              */
  /* ------------------------------------------------------------------- */

  function startGame(students) {
    // A shuffled order for one pass through the class (Fisher-Yates).
    function shuffledOrder() {
      var order = students.map(function (_, i) { return i; });
      for (var i = order.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
      }
      return order;
    }

    var order = shuffledOrder();
    var position = 0; // Index inside "order".
    var pass = 1;     // How many times we went through the class.
    var correct = 0;
    var incorrect = 0;

    var overlay = document.createElement("div");
    overlay.className = "bc-fc-overlay";
    overlay.innerHTML = ""
      + '<div class="bc-fc-bar">'
      + '  <div class="bc-fc-score">'
      + '    <span class="bc-fc-chip bc-fc-good">✅ <b class="bc-fc-c">0</b></span>'
      + '    <span class="bc-fc-chip bc-fc-bad">❌ <b class="bc-fc-w">0</b></span>'
      + '    <span class="bc-fc-chip bc-fc-pct">—</span>'
      + '    <span class="bc-fc-chip bc-fc-prog"></span>'
      + '  </div>'
      + '  <button class="bc-fc-close" title="Close (Esc)" aria-label="Close">✕</button>'
      + '</div>'
      + '<div class="bc-fc-stage">'
      + '  <div class="bc-fc-deck">'
      + '    <div class="bc-fc-stack s3"></div>'
      + '    <div class="bc-fc-stack s2"></div>'
      + '    <div class="bc-fc-stack s1"></div>'
      + '    <div class="bc-fc-card">'
      + '      <div class="bc-fc-inner">'
      + '        <div class="bc-fc-face bc-fc-front">'
      + '          <div class="bc-fc-photo-wrap"></div>'
      + '          <div class="bc-fc-front-hint">Who is this? — tap the card to reveal.</div>'
      + '        </div>'
      + '        <div class="bc-fc-face bc-fc-back">'
      + '          <div class="bc-fc-name"></div>'
      + '          <div class="bc-fc-pron">'
      + '            <div class="bc-fc-pron-label">Name pronunciation</div>'
      + '            <div class="bc-fc-pron-slot"></div>'
      + '          </div>'
      + '          <div class="bc-fc-back-hint">Grade yourself below ↓</div>'
      + '        </div>'
      + '      </div>'
      + '    </div>'
      + '  </div>'
      + '  <div class="bc-fc-actions"></div>'
      + '</div>';

    document.body.appendChild(overlay);
    var previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    var card = overlay.querySelector(".bc-fc-card");
    var inner = overlay.querySelector(".bc-fc-inner");
    var photoWrap = overlay.querySelector(".bc-fc-photo-wrap");
    var nameEl = overlay.querySelector(".bc-fc-name");
    var pronSlot = overlay.querySelector(".bc-fc-pron-slot");
    var actions = overlay.querySelector(".bc-fc-actions");
    var elCorrect = overlay.querySelector(".bc-fc-c");
    var elWrong = overlay.querySelector(".bc-fc-w");
    var elPct = overlay.querySelector(".bc-fc-pct");
    var elProg = overlay.querySelector(".bc-fc-prog");

    var flipped = false;
    var busy = false; // True while a card-change animation runs.

    function updateScore() {
      elCorrect.textContent = correct;
      elWrong.textContent = incorrect;
      var total = correct + incorrect;
      elPct.textContent = total ? Math.round((correct / total) * 100) + "%" : "—";
      elProg.textContent = "Pass " + pass + " · " + (position + 1) + " of " + order.length;
    }

    // Put the current student on the card front and back.
    function renderCurrent() {
      var student = students[order[position]];

      photoWrap.textContent = "";
      if (student.photo) {
        var img = student.photo.cloneNode(true);
        img.removeAttribute("width");
        img.removeAttribute("height");
        photoWrap.appendChild(img);
      } else {
        var none = document.createElement("div");
        none.className = "bc-fc-photo-missing";
        none.textContent = "No photo on file";
        photoWrap.appendChild(none);
      }

      nameEl.textContent = student.name;
      pronSlot.textContent = "";
      if (student.pron) {
        var frame = student.pron.cloneNode(true);
        frame.className = "bc-fc-pron-frame";
        frame.removeAttribute("style");
        frame.removeAttribute("width");
        frame.removeAttribute("height");
        pronSlot.appendChild(frame);
      } else {
        var noPron = document.createElement("div");
        noPron.className = "bc-fc-pron-none";
        noPron.textContent = "No recording";
        pronSlot.appendChild(noPron);
      }

      updateScore();
      showFrontActions();
    }

    // Actions while the card front is up.
    function showFrontActions() {
      actions.innerHTML = '<div class="bc-fc-hint-text">Tap the card to see the name.</div>';
    }

    // Actions after the flip: the grade buttons.
    function showGradeActions() {
      actions.innerHTML = "";
      var good = document.createElement("button");
      good.className = "bc-fc-grade bc-fc-correct";
      good.textContent = "✅ Correct";
      good.addEventListener("click", function () { grade(true); });

      var bad = document.createElement("button");
      bad.className = "bc-fc-grade bc-fc-incorrect";
      bad.textContent = "❌ Incorrect";
      bad.addEventListener("click", function () { grade(false); });

      actions.appendChild(good);
      actions.appendChild(bad);
    }

    function flip() {
      if (busy || flipped) return;
      flipped = true;
      inner.classList.add("flipped");
      showGradeActions();
    }

    // Record the result and deal the next random student.
    function grade(wasCorrect) {
      if (busy) return;
      if (wasCorrect) correct++; else incorrect++;
      busy = true;

      // Send the current card to the back of the deck.
      card.classList.add("to-back");

      window.setTimeout(function () {
        // Step forward. Reshuffle for a new pass at the end.
        position++;
        if (position >= order.length) {
          order = shuffledOrder();
          position = 0;
          pass++;
        }
        flipped = false;
        inner.classList.remove("flipped");
        renderCurrent();

        // Bring the next card forward from the deck.
        card.classList.remove("to-back");
        card.classList.add("from-back");
        void card.offsetWidth; // Force reflow so the intro animation runs.
        card.classList.remove("from-back");
        busy = false;
      }, 340);
    }

    function close() {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = previousOverflow;
      overlay.remove();
    }

    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (busy) return;
      if (!flipped) {
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
        return;
      }
      // The card is flipped: grade with the keyboard.
      if (e.key === "ArrowRight" || e.key.toLowerCase() === "c") { e.preventDefault(); grade(true); }
      else if (e.key === "ArrowLeft" || e.key.toLowerCase() === "x") { e.preventDefault(); grade(false); }
    }

    card.addEventListener("click", flip);
    overlay.querySelector(".bc-fc-close").addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);

    renderCurrent();
  }

  /* ------------------------------------------------------------------- */
  /* 3. Add the launch button to the page.                               */
  /* ------------------------------------------------------------------- */

  function launch() {
    var students = readStudents();
    if (!students.length) {
      window.alert("Flashcards: no students were found on this page.");
      return;
    }
    startGame(students);
  }

  function addLaunchButton() {
    if (document.querySelector(".bc-fc-launch")) return;

    var button = document.createElement("button");
    button.type = "button";
    button.className = "bc-fc-launch";
    button.textContent = "🃏 Flashcard Mode";
    button.addEventListener("click", launch);

    // Place the button just to the left of "Download Roster".
    var download = document.querySelector('input[name="p_download"]');
    if (download && download.parentNode) {
      download.parentNode.insertBefore(button, download);
      return;
    }

    // Fallback: float the button at the top-right of the page.
    button.style.position = "fixed";
    button.style.top = "12px";
    button.style.right = "12px";
    button.style.zIndex = "2147483000";
    document.body.appendChild(button);
  }

  // Only run where the roster is actually present.
  function init() {
    if (document.querySelector("table.reporttable")) {
      addLaunchButton();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
