// Better Canvas (Rice) — plain text from a SpeedGrader submission
//
// SpeedGrader shows file submissions in Canvas DocViewer, a cross-origin
// iframe that draws each page, so the text cannot be read from the page. This
// library turns the submission itself into plain text instead:
//
//   - a text entry: the HTML body from the Canvas API
//   - a .docx file: word/document.xml, read from the ZIP with the browser's
//     own DecompressionStream (no library)
//   - a .pdf file: the text layer, read with the bundled pdf.js legacy build
//     (vendor/pdfjs, loaded only when a PDF is checked; its polyfills cover
//     the newest JavaScript features that pdf.js 6 uses)
//   - a .txt file: the bytes as UTF-8
//
// All of this runs in the browser; nothing here sends data anywhere.
//
// pdf.js normally parses in a Web Worker. A worker made from a
// chrome-extension:// URL is cross-origin to the Canvas page, so the worker
// module is loaded first and set as globalThis.pdfjsWorker, which makes pdf.js
// parse on this thread instead. Student PDFs are untrusted input: pdf.js 6 has
// no eval path (and the extension's content-script CSP blocks eval anyway),
// XFA forms are not parsed, and a DOCX entry may not expand past 50 MB.
//
// Exposed as window.BetterCanvasSubmissionText so sibling content scripts can
// use it.

(function () {
  "use strict";

  var DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  var W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  var MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";
  var MAX_ENTRY_BYTES = 50 * 1024 * 1024;

  // ---- Shared ---------------------------------------------------------------

  // Collapses runs of spaces, trims each line, and keeps at most one blank
  // line between paragraphs.
  function tidyText(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // "pdf", "docx", "text", or null for a file this library cannot read.
  function kindOf(attachment) {
    var type = String(attachment["content-type"] || "").toLowerCase();
    var name = String(attachment.filename || attachment.display_name || "").toLowerCase();
    if (type === "application/pdf" || /\.pdf$/.test(name)) {
      return "pdf";
    }
    if (type === DOCX_TYPE || /\.docx$/.test(name)) {
      return "docx";
    }
    if (type === "text/plain" || /\.txt$/.test(name)) {
      return "text";
    }
    return null;
  }

  // ---- Text entry (HTML) ----------------------------------------------------

  var SKIP_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|IFRAME|OBJECT)$/;
  var BLOCK_TAGS = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TR|UL)$/;

  // DOMParser builds an inert document: no script runs and nothing loads.
  function htmlToText(html) {
    var doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    var out = [];

    function walk(node) {
      for (var child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          out.push(child.nodeValue.replace(/\s+/g, " "));
        } else if (child.nodeType === 1) {
          var tag = child.tagName;
          if (SKIP_TAGS.test(tag)) {
            continue;
          }
          if (tag === "BR") {
            out.push("\n");
          } else if (BLOCK_TAGS.test(tag)) {
            out.push("\n\n");
            walk(child);
            out.push("\n\n");
          } else {
            walk(child);
            if (tag === "TD" || tag === "TH") {
              out.push(" ");
            }
          }
        }
      }
    }

    if (doc.body) {
      walk(doc.body);
    }
    return tidyText(out.join(""));
  }

  // ---- DOCX -----------------------------------------------------------------

  function tooLarge() {
    return new Error("the document text is too large to read");
  }

  // Inflates raw DEFLATE data, but stops at maxBytes of output: a crafted
  // file can say it is small in its header and still expand without limit.
  function inflateRaw(data, maxBytes) {
    var reader = new Blob([data]).stream()
      .pipeThrough(new DecompressionStream("deflate-raw"))
      .getReader();
    var chunks = [];
    var total = 0;

    function pump() {
      return reader.read().then(function (step) {
        if (step.done) {
          var out = new Uint8Array(total);
          var offset = 0;
          chunks.forEach(function (chunk) {
            out.set(chunk, offset);
            offset += chunk.length;
          });
          return out;
        }
        total += step.value.length;
        if (total > maxBytes) {
          reader.cancel();
          throw tooLarge();
        }
        chunks.push(step.value);
        return pump();
      });
    }

    return pump();
  }

  // Returns the bytes of one file inside a ZIP, or null if the ZIP does not
  // have it. Reads the central directory (its sizes are right even when a
  // local header defers them to a data descriptor). ZIP64 is not supported;
  // a Word document is far below its 4 GB limit. An entry larger than
  // maxBytes (default 50 MB) once uncompressed is refused.
  function readZipEntry(bytes, wanted, maxBytes) {
    maxBytes = maxBytes || MAX_ENTRY_BYTES;
    return Promise.resolve().then(function () {
      var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      var end = -1;
      var stop = Math.max(0, bytes.length - 65557); // 22-byte record + longest comment
      for (var i = bytes.length - 22; i >= stop; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
          end = i;
          break;
        }
      }
      if (end === -1) {
        throw new Error("the file is not a ZIP archive");
      }
      var count = view.getUint16(end + 10, true);
      var offset = view.getUint32(end + 16, true);
      var decoder = new TextDecoder("utf-8");
      for (var n = 0; n < count; n++) {
        if (view.getUint32(offset, true) !== 0x02014b50) {
          throw new Error("the ZIP directory is damaged");
        }
        var method = view.getUint16(offset + 10, true);
        var size = view.getUint32(offset + 20, true);
        var fullSize = view.getUint32(offset + 24, true);
        var nameLength = view.getUint16(offset + 28, true);
        var extraLength = view.getUint16(offset + 30, true);
        var commentLength = view.getUint16(offset + 32, true);
        var local = view.getUint32(offset + 42, true);
        var name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
        if (name === wanted) {
          if (size === 0xffffffff || fullSize === 0xffffffff || local === 0xffffffff) {
            throw new Error("ZIP64 archives are not supported");
          }
          if (size > maxBytes || fullSize > maxBytes) {
            throw tooLarge();
          }
          if (view.getUint32(local, true) !== 0x04034b50) {
            throw new Error("the ZIP entry is damaged");
          }
          var start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
          var data = bytes.subarray(start, start + size);
          if (method === 0) {
            return data;
          }
          if (method === 8) {
            return inflateRaw(data, maxBytes);
          }
          throw new Error("unsupported ZIP compression method " + method);
        }
        offset += 46 + nameLength + extraLength + commentLength;
      }
      return null;
    });
  }

  // Walks the body in document order. Property elements (w:pPr, w:rPr, …)
  // hold tab-stop definitions, not text, and mc:Fallback repeats the content
  // of its mc:Choice (text boxes), so both are skipped. Deleted text
  // (w:delText) and field codes (w:instrText) are not w:t, so they never show.
  function wordXmlToText(xmlText) {
    var doc = new DOMParser().parseFromString(xmlText, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) {
      throw new Error("the Word document XML could not be read");
    }
    var body = doc.getElementsByTagNameNS(W_NS, "body")[0];
    if (!body) {
      throw new Error("the Word document has no body");
    }
    var out = [];

    function walk(node) {
      for (var child = node.firstElementChild; child; child = child.nextElementSibling) {
        if (child.namespaceURI === MC_NS && child.localName === "Fallback") {
          continue;
        }
        if (child.namespaceURI === W_NS) {
          var name = child.localName;
          if (/Pr$/.test(name)) {
            continue;
          }
          if (name === "t") {
            out.push(child.textContent);
            continue;
          }
          if (name === "tab") {
            out.push("\t");
            continue;
          }
          if (name === "br" || name === "cr") {
            out.push("\n");
            continue;
          }
          if (name === "noBreakHyphen") {
            out.push("-");
            continue;
          }
          if (name === "p") {
            walk(child);
            out.push("\n\n");
            continue;
          }
        }
        walk(child);
      }
    }

    walk(body);
    return tidyText(out.join(""));
  }

  function docxToText(buffer) {
    return readZipEntry(new Uint8Array(buffer), "word/document.xml").then(function (xml) {
      if (!xml) {
        throw new Error("the file is not a Word (.docx) document");
      }
      return wordXmlToText(new TextDecoder("utf-8").decode(xml));
    });
  }

  // ---- PDF ------------------------------------------------------------------

  var pdfjsReady = null;

  function loadPdfjs() {
    if (!pdfjsReady) {
      var libUrl = chrome.runtime.getURL("vendor/pdfjs/pdf.min.mjs");
      var workerUrl = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");
      pdfjsReady = Promise.all([import(libUrl), import(workerUrl)])
        .then(function (modules) {
          globalThis.pdfjsWorker = modules[1];
          modules[0].GlobalWorkerOptions.workerSrc = workerUrl;
          return modules[0];
        })
        .catch(function (err) {
          pdfjsReady = null; // let a later check try again
          throw err;
        });
    }
    return pdfjsReady;
  }

  function pdfToText(buffer) {
    return loadPdfjs().then(function (pdfjs) {
      var task = pdfjs.getDocument({
        data: new Uint8Array(buffer),
        enableXfa: false,
        disableFontFace: true
      });
      var pages = [];

      function readPage(pdf, number) {
        if (number > pdf.numPages) {
          return pages.join("\n\n");
        }
        return pdf.getPage(number).then(function (page) {
          return page.getTextContent().then(function (content) {
            var parts = [];
            content.items.forEach(function (item) {
              if (typeof item.str === "string") {
                parts.push(item.str);
                if (item.hasEOL) {
                  parts.push("\n");
                }
              }
            });
            pages.push(parts.join(""));
            page.cleanup();
            return readPage(pdf, number + 1);
          });
        });
      }

      return task.promise
        .then(function (pdf) {
          return readPage(pdf, 1);
        })
        .then(
          function (text) {
            return task.destroy().then(function () {
              return tidyText(text);
            });
          },
          function (err) {
            return task.destroy().then(function () {
              throw err;
            });
          }
        );
    });
  }

  // ---- Plain text -----------------------------------------------------------

  function plainToText(buffer) {
    return tidyText(new TextDecoder("utf-8").decode(buffer));
  }

  // Text from one downloaded attachment, by kind.
  function fileToText(kind, buffer) {
    if (kind === "pdf") {
      return pdfToText(buffer);
    }
    if (kind === "docx") {
      return docxToText(buffer);
    }
    if (kind === "text") {
      return Promise.resolve(plainToText(buffer));
    }
    return Promise.reject(new Error("unsupported file type"));
  }

  window.BetterCanvasSubmissionText = {
    kindOf: kindOf,
    htmlToText: htmlToText,
    fileToText: fileToText,
    readZipEntry: readZipEntry,
    tidyText: tidyText
  };
})();
