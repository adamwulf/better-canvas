// Better Canvas (Rice) — flashcard study mode on the Esther course roster.
//
// The roster page (esther.rice.edu/selfserve/swkrost.main) lists every student
// as a row in <table class="reporttable">, with a photo, a name, and a
// NameCoach pronunciation <iframe> among the columns. This script adds a
// "Flashcard Mode" and "Download Face Photos" buttons next to "Download
// Roster". Flashcard Mode dims the page and deals a deck of cards:
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
// Download Face Photos converts every available roster image to PNG in the
// browser and puts the results in one ZIP, named in natural "First Last"
// order. The ZIP implementation lives in this file: photos never go through a
// third-party service.
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
  /* 2. Local PNG and ZIP generation.                                    */
  /* ------------------------------------------------------------------- */

  // ZIP files use CRC-32 to verify each entry. Build the lookup table once,
  // then reuse it for every photo in the archive.
  var crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = [];
      for (var n = 0; n < 256; n++) {
        var value = n;
        for (var k = 0; k < 8; k++) {
          value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        }
        crcTable[n] = value >>> 0;
      }
    }

    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function writeUint16(target, offset, value) {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
  }

  function writeUint32(target, offset, value) {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
    target[offset + 2] = (value >>> 16) & 0xff;
    target[offset + 3] = (value >>> 24) & 0xff;
  }

  function copyBytes(target, offset, bytes) {
    target.set(bytes, offset);
    return offset + bytes.length;
  }

  function zipDateTime(now) {
    var year = Math.max(1980, now.getFullYear());
    return {
      time: (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
    };
  }

  // Create a standards-compliant ZIP using uncompressed ("stored") entries.
  // Photos are already compressed PNG data, so another compression pass would
  // save little while making the content script substantially larger.
  function makeZip(files) {
    var encoder = new TextEncoder();
    var stamp = zipDateTime(new Date());
    var entries = files.map(function (file) {
      var nameBytes = encoder.encode(file.name);
      return {
        data: file.data,
        nameBytes: nameBytes,
        crc: crc32(file.data),
        offset: 0
      };
    });

    var localSize = entries.reduce(function (total, entry) {
      return total + 30 + entry.nameBytes.length + entry.data.length;
    }, 0);
    var centralSize = entries.reduce(function (total, entry) {
      return total + 46 + entry.nameBytes.length;
    }, 0);
    var output = new Uint8Array(localSize + centralSize + 22);
    var offset = 0;

    entries.forEach(function (entry) {
      entry.offset = offset;
      writeUint32(output, offset, 0x04034b50); // Local file header.
      writeUint16(output, offset + 4, 20);      // ZIP 2.0.
      writeUint16(output, offset + 6, 0x0800);  // UTF-8 filename.
      writeUint16(output, offset + 8, 0);       // Stored, not compressed.
      writeUint16(output, offset + 10, stamp.time);
      writeUint16(output, offset + 12, stamp.date);
      writeUint32(output, offset + 14, entry.crc);
      writeUint32(output, offset + 18, entry.data.length);
      writeUint32(output, offset + 22, entry.data.length);
      writeUint16(output, offset + 26, entry.nameBytes.length);
      writeUint16(output, offset + 28, 0);
      offset = copyBytes(output, offset + 30, entry.nameBytes);
      offset = copyBytes(output, offset, entry.data);
    });

    var centralOffset = offset;
    entries.forEach(function (entry) {
      writeUint32(output, offset, 0x02014b50); // Central directory header.
      writeUint16(output, offset + 4, 20);
      writeUint16(output, offset + 6, 20);
      writeUint16(output, offset + 8, 0x0800);
      writeUint16(output, offset + 10, 0);
      writeUint16(output, offset + 12, stamp.time);
      writeUint16(output, offset + 14, stamp.date);
      writeUint32(output, offset + 16, entry.crc);
      writeUint32(output, offset + 20, entry.data.length);
      writeUint32(output, offset + 24, entry.data.length);
      writeUint16(output, offset + 28, entry.nameBytes.length);
      writeUint16(output, offset + 30, 0);
      writeUint16(output, offset + 32, 0);
      writeUint16(output, offset + 34, 0);
      writeUint16(output, offset + 36, 0);
      writeUint32(output, offset + 38, 0);
      writeUint32(output, offset + 42, entry.offset);
      offset = copyBytes(output, offset + 46, entry.nameBytes);
    });

    writeUint32(output, offset, 0x06054b50); // End of central directory.
    writeUint16(output, offset + 4, 0);
    writeUint16(output, offset + 6, 0);
    writeUint16(output, offset + 8, entries.length);
    writeUint16(output, offset + 10, entries.length);
    writeUint32(output, offset + 12, centralSize);
    writeUint32(output, offset + 16, centralOffset);
    writeUint16(output, offset + 20, 0);
    return output;
  }

  function safeFilename(name) {
    var filename = toFirstLast(name)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim();
    if (!filename) filename = "Student";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(filename)) {
      filename = "_" + filename;
    }
    return filename.slice(0, 180);
  }

  function uniquePhotoName(studentName, usedNames) {
    var base = safeFilename(studentName);
    var candidate = base + ".png";
    var suffix = 2;
    while (usedNames[candidate.toLowerCase()]) {
      candidate = base + " (" + suffix + ").png";
      suffix++;
    }
    usedNames[candidate.toLowerCase()] = true;
    return candidate;
  }

  function canvasPngBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error("The browser could not encode the photo as PNG."));
      }, "image/png");
    });
  }

  async function photoAsPng(photo) {
    var url = photo.currentSrc || photo.src || photo.getAttribute("src");
    if (!url) throw new Error("The photo has no source URL.");

    var response = await fetch(url, { credentials: "include", cache: "force-cache" });
    if (!response.ok) throw new Error("Photo request returned HTTP " + response.status + ".");
    var sourceBlob = await response.blob();
    var bitmap = await createImageBitmap(sourceBlob);
    try {
      if (!bitmap.width || !bitmap.height) throw new Error("The photo has no image data.");
      var canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      var context = canvas.getContext("2d");
      if (!context) throw new Error("The browser could not create an image canvas.");
      context.drawImage(bitmap, 0, 0);
      var pngBlob = await canvasPngBlob(canvas);
      return new Uint8Array(await pngBlob.arrayBuffer());
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  async function downloadFacePhotos(button) {
    var students = readStudents();
    var withPhotos = students.filter(function (student) { return student.photo; });
    if (!withPhotos.length) {
      window.alert("Face photos: no student photos were found on this page.");
      return;
    }

    var originalLabel = button.textContent;
    var files = [];
    var failures = [];
    var usedNames = Object.create(null);
    button.disabled = true;

    try {
      for (var i = 0; i < withPhotos.length; i++) {
        var student = withPhotos[i];
        button.textContent = "Preparing " + (i + 1) + "/" + withPhotos.length + "…";
        try {
          files.push({
            name: uniquePhotoName(student.name, usedNames),
            data: await photoAsPng(student.photo)
          });
        } catch (error) {
          failures.push(toFirstLast(student.name));
          console.warn("Better Canvas could not download the photo for " + student.name, error);
        }
      }

      if (!files.length) {
        window.alert("Face photos: none of the photos could be downloaded. See the browser console for details.");
        return;
      }

      button.textContent = "Building ZIP…";
      var zip = makeZip(files);
      saveBlob(new Blob([zip], { type: "application/zip" }), "face-photos.zip");

      var studentsWithoutPhotos = students.length - withPhotos.length;
      if (failures.length || studentsWithoutPhotos) {
        var details = [];
        if (failures.length) details.push(failures.length + " photo download(s) failed");
        if (studentsWithoutPhotos) details.push(studentsWithoutPhotos + " student(s) had no photo");
        window.alert("Downloaded " + files.length + " photo(s). " + details.join("; ") + ".");
      }
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  // Opt-in hooks for the dependency-free Node tests. No test surface is
  // created in normal browser use.
  if (window.__bcTestHooks) {
    window.__bcTestHooks.toFirstLast = toFirstLast;
    window.__bcTestHooks.safeFilename = safeFilename;
    window.__bcTestHooks.uniquePhotoName = uniquePhotoName;
    window.__bcTestHooks.makeZip = makeZip;
  }

  /* ------------------------------------------------------------------- */
  /* 3. The flashcard game.                                              */
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
  /* 4. Add the roster buttons to the page.                              */
  /* ------------------------------------------------------------------- */

  function launch() {
    var students = readStudents();
    if (!students.length) {
      window.alert("Flashcards: no students were found on this page.");
      return;
    }
    startGame(students);
  }

  function addRosterButtons() {
    var download = document.querySelector('input[name="p_download"]');
    var parent = download && download.parentNode;

    if (!document.querySelector(".bc-fc-launch")) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "bc-roster-action bc-fc-launch";
      button.textContent = "🃏 Flashcard Mode";
      button.addEventListener("click", launch);

      if (parent) {
        parent.insertBefore(button, download);
      } else {
        // Fallback: float the button at the top-right of the page.
        button.style.position = "fixed";
        button.style.top = "12px";
        button.style.right = "12px";
        button.style.zIndex = "2147483000";
        document.body.appendChild(button);
      }
    }

    if (!document.querySelector(".bc-photo-download")) {
      var photoButton = document.createElement("button");
      photoButton.type = "button";
      photoButton.className = "bc-roster-action bc-photo-download";
      photoButton.textContent = "⬇ Download Face Photos";
      photoButton.addEventListener("click", function () {
        downloadFacePhotos(photoButton).catch(function (error) {
          console.error("Better Canvas could not build the face photo ZIP.", error);
          window.alert("Face photos: the ZIP could not be created. See the browser console for details.");
        });
      });

      if (parent) {
        parent.insertBefore(photoButton, download);
      } else {
        photoButton.style.position = "fixed";
        photoButton.style.top = "52px";
        photoButton.style.right = "12px";
        photoButton.style.zIndex = "2147483000";
        document.body.appendChild(photoButton);
      }
    }
  }

  // Only run where the roster is actually present.
  function init() {
    if (document.querySelector("table.reporttable")) {
      addRosterButtons();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
