// Better Canvas (Rice) — flashcard study mode on the Esther course roster.
//
// The roster page (esther.rice.edu/selfserve/swkrost.main) lists every student
// as a row in <table class="reporttable">, with a photo, a name, and a
// NameCoach pronunciation <iframe> among the columns. This script adds a
// "Flashcard Mode" button next to "Download Roster". Pressing it dims the page
// and deals a deck of cards:
//
//   - The card front shows the student photo.
//   - Clicking the card turns it over: the photo flips to the name, and the
//     name flips back to the photo. The pronunciation player is the one spot
//     that does not flip, so its play button still works.
//   - Green "Correct" / red "Incorrect" buttons grade the guess, send the card
//     to the back of the deck, and deal the next student.
//
// Each student is dealt onto its own card node, and the next card is built and
// laid behind the active one before you grade. Grading tosses the graded card
// away to reveal the waiting card, which already shows a photo — so we never
// rewrite a node in place and you never glimpse the next name during the swap.
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

  // The roster lists a name as "Last, First" (sometimes "Last, First Middle").
  // Reorder it to natural "First Last" for the card. The split is on the first
  // comma only, so a multi-word given name stays with the first name. A name
  // with no comma, or with an empty half, is returned unchanged.
  function toFirstLast(name) {
    var comma = name.indexOf(",");
    if (comma === -1) return name;
    var last = tidyText(name.slice(0, comma));
    var first = tidyText(name.slice(comma + 1));
    if (!last || !first) return name;
    return first + " " + last;
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

    // A dealer that yields each student once per pass, then reshuffles for the
    // next pass. Every dealt card carries its own pass/position so the score
    // line can describe whichever card is on top.
    var dealOrder = shuffledOrder();
    var dealPos = 0; // Next index to deal within dealOrder.
    var dealPass = 1;
    function dealNext() {
      if (dealPos >= dealOrder.length) {
        dealOrder = shuffledOrder();
        dealPos = 0;
        dealPass++;
      }
      var meta = {
        student: students[dealOrder[dealPos]],
        pass: dealPass,
        pos: dealPos + 1,
        len: dealOrder.length
      };
      dealPos++;
      return meta;
    }

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
      + '  </div>'
      + '  <div class="bc-fc-actions"></div>'
      + '</div>';

    document.body.appendChild(overlay);
    var previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    var deck = overlay.querySelector(".bc-fc-deck");
    var actions = overlay.querySelector(".bc-fc-actions");
    var elCorrect = overlay.querySelector(".bc-fc-c");
    var elWrong = overlay.querySelector(".bc-fc-w");
    var elPct = overlay.querySelector(".bc-fc-pct");
    var elProg = overlay.querySelector(".bc-fc-prog");

    // The two live cards: the one being studied and the one dealt behind it.
    // Because they are separate DOM nodes, grading the top card never rewrites
    // the node the next student shows on — its face is already a photo, so no
    // name is ever glimpsed during the hand-off.
    var activeCard = null;
    var activeMeta = null;
    var nextCard = null;
    var nextMeta = null;

    var flipped = false;
    // True once the active card has been turned to its name at least once. The
    // grade buttons then stay on show, so you can flip back to the photo and
    // forth to the name to memorise, and still grade from either face.
    var revealed = false;
    var busy = false; // True while a card hand-off animation runs.

    // Build one card (front photo, back name + pronunciation) for a dealt meta.
    // The card starts on its front; it keeps its meta for the score line.
    function buildCard(meta) {
      var student = meta.student;
      var card = document.createElement("div");
      card.className = "bc-fc-card";
      card.innerHTML = ""
        + '<div class="bc-fc-inner">'
        + '  <div class="bc-fc-face bc-fc-front">'
        + '    <div class="bc-fc-photo-wrap"></div>'
        + '    <div class="bc-fc-front-hint">Who is this? — tap the card to reveal.</div>'
        + '  </div>'
        + '  <div class="bc-fc-face bc-fc-back">'
        + '    <div class="bc-fc-name"></div>'
        + '    <div class="bc-fc-pron">'
        + '      <div class="bc-fc-pron-label">Name pronunciation</div>'
        + '      <div class="bc-fc-pron-slot"></div>'
        + '    </div>'
        + '    <div class="bc-fc-back-hint">Tap the card for the photo · grade yourself below ↓</div>'
        + '  </div>'
        + '</div>';
      card._meta = meta;

      var photoWrap = card.querySelector(".bc-fc-photo-wrap");
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

      card.querySelector(".bc-fc-name").textContent = toFirstLast(student.name);

      var pronSlot = card.querySelector(".bc-fc-pron-slot");
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

      return card;
    }

    function updateScore() {
      elCorrect.textContent = correct;
      elWrong.textContent = incorrect;
      var total = correct + incorrect;
      elPct.textContent = total ? Math.round((correct / total) * 100) + "%" : "—";
      elProg.textContent = "Pass " + activeMeta.pass + " · " + activeMeta.pos + " of " + activeMeta.len;
    }

    // Actions while the card front is up. The card face already says "tap the
    // card to reveal", so the area below it stays empty until the grade buttons
    // appear; its min-height holds the space so nothing jumps.
    function showFrontActions() {
      actions.innerHTML = "";
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
      if (busy || flipped || !activeCard) return;
      flipped = true;
      activeCard.querySelector(".bc-fc-inner").classList.add("flipped");
      // Build the grade buttons the first time this card shows its name. They
      // then stay through later flips, so flipping back to the photo does not
      // take them away.
      if (!revealed) {
        revealed = true;
        showGradeActions();
      }
    }

    // Turn the card back to the photo. The grade buttons stay, so you can flip
    // between the photo and the name as often as you like; only grading clears
    // the card.
    function flipBack() {
      if (busy || !flipped || !activeCard) return;
      flipped = false;
      activeCard.querySelector(".bc-fc-inner").classList.remove("flipped");
    }

    // A click anywhere on the card turns it over, exactly as the front does:
    // the photo flips to the name, and the name flips back to the photo. The
    // pronunciation area is the one exception — a click there is meant for the
    // play button, so it must not flip the card away from the name.
    function onCardClick(e) {
      if (busy || !activeCard) return;
      if (e.target.closest(".bc-fc-pron")) return;
      if (flipped) flipBack(); else flip();
    }

    // Record the result, toss the graded card off the deck, and promote the
    // card already waiting behind it. A fresh card is then dealt to the back.
    function grade(wasCorrect) {
      // Grading is allowed from either face once the name has been seen, so you
      // can flip back to the photo and still grade yourself.
      if (busy || !revealed) return;
      if (wasCorrect) correct++; else incorrect++;
      busy = true;

      // Toss the graded card away; it is removed once its animation ends.
      var outgoing = activeCard;
      outgoing.removeEventListener("click", onCardClick);
      outgoing.classList.add("to-back");

      // Promote the waiting card. It already shows a photo front, unflipped.
      activeCard = nextCard;
      activeMeta = nextMeta;
      flipped = false;
      revealed = false; // The fresh card starts on its photo, not yet revealed.
      activeCard.addEventListener("click", onCardClick);
      updateScore();
      showFrontActions();

      // Rise it gently into place as the graded card is tossed away.
      activeCard.classList.add("rise");
      void activeCard.offsetWidth; // Force reflow so the rise animates.
      activeCard.classList.remove("rise");

      // Deal the following student onto a new card laid behind the active one.
      nextMeta = dealNext();
      nextCard = buildCard(nextMeta);
      deck.insertBefore(nextCard, activeCard);

      window.setTimeout(function () {
        outgoing.remove();
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
      // Space/Enter flips the card either way, so you can turn between the photo
      // and the name as often as you like.
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (flipped) flipBack(); else flip();
        return;
      }
      if (!revealed) return;
      // The name has been seen: grade with the keyboard from either face.
      if (e.key === "ArrowRight" || e.key.toLowerCase() === "c") { e.preventDefault(); grade(true); }
      else if (e.key === "ArrowLeft" || e.key.toLowerCase() === "x") { e.preventDefault(); grade(false); }
    }

    overlay.querySelector(".bc-fc-close").addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);

    // Deal the opening hand: the active card on top, the next card behind it.
    activeMeta = dealNext();
    activeCard = buildCard(activeMeta);
    nextMeta = dealNext();
    nextCard = buildCard(nextMeta);
    deck.appendChild(nextCard);   // Laid behind.
    deck.appendChild(activeCard); // On top.
    activeCard.addEventListener("click", onCardClick);
    updateScore();
    showFrontActions();
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
