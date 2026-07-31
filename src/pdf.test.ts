/**
 * The page accounting, which decides how much of a PDF comes back and what the
 * result says about the rest.
 *
 * Every edge here fails the same way — by returning no text while looking like a
 * success — and that is the one answer this module exists to never give: an
 * empty string reads as "the document is empty", which is a different and much
 * more damaging claim than "I could not read it". One of these cases was live:
 * a blank leading page filled the kept list without contributing a character,
 * so the guard against returning nothing never fired.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PdfError, selectPages } from "./pdf.js";

const page = (chars: number) => "x".repeat(chars);

test("the Math.sumPrecise the bundled PDF.js calls is there for it", () => {
  // Importing this module installs it. PDF.js calls it while rebuilding an
  // embedded font's glyph tables; without it every font throws, and the glyphs
  // that rebuild would have mapped come back missing — the footnote markers
  // vanished from a paper whose text otherwise looked complete.
  const sum = (Math as unknown as { sumPrecise: (values: Iterable<number>) => number }).sumPrecise;
  assert.equal(typeof sum, "function");
  assert.equal(sum([]), 0);
  assert.equal(sum([1, 2, 3]), 6);
  // The compensation is the whole point: adding these left to right loses one
  // of the ones to rounding at 1e16, where the gap between floats is 2.
  assert.equal(sum([1e16, 1, -1e16, 1]), 2);
});

test("a document inside the budget comes back whole", () => {
  const result = selectPages(["one", "two", "three"], 3, 1000);
  assert.equal(result.text, "one\n\ntwo\n\nthree");
  assert.equal(result.note, "all 3 page(s)");
});

test("pages are dropped at a page boundary, and the note counts them", () => {
  const result = selectPages([page(40), page(40), page(40)], 3, 100);
  // Two pages plus one separator is 82; a third would be 124.
  assert.equal(result.text.length, 82);
  assert.equal(result.note, "the first 2 of 3 pages");
});

test("the accounting charges for the separators it will emit", () => {
  // Three 32-character pages are 96 characters of text but 100 with separators,
  // so all three fit exactly and none is dropped for being one over.
  const result = selectPages([page(32), page(32), page(32)], 3, 100);
  assert.equal(result.text.length, 100);
  assert.equal(result.note, "all 3 page(s)");
});

test("a first page over the budget on its own is cut rather than dropped", () => {
  const result = selectPages([page(500), page(10)], 2, 100);
  assert.equal(result.text, page(100));
  assert.equal(result.note, "page 1 of 2, itself cut at 100 characters");
});

test("a blank leading page does not turn an oversized page into an empty answer", () => {
  // The regression. A blank cover page is kept for free, so `kept` was not
  // empty, so the cut-a-single-page path never ran — and the tool returned ""
  // with the note "the first 1 of 2 pages".
  const result = selectPages(["", page(500)], 2, 100);
  assert.notEqual(result.text, "");
  assert.equal(result.text, page(100));
  assert.equal(result.note, "page 2 of 2, itself cut at 100 characters");
});

test("the note names the page the text actually came from", () => {
  const result = selectPages(["", "", "", page(500)], 4, 100);
  assert.equal(result.text, page(100));
  assert.equal(result.note, "page 4 of 4, itself cut at 100 characters");
});

test("blank pages between text are kept without being charged for", () => {
  const result = selectPages(["a", "", "b"], 3, 1000);
  assert.equal(result.text, "a\n\n\n\nb");
  assert.equal(result.note, "all 3 page(s)");
});

test("a scan is an error, never an empty success", () => {
  assert.throws(
    () => selectPages(["", "   ", "\n"], 3, 1000),
    (error: unknown) =>
      error instanceof PdfError && /no extractable text layer/.test(error.message),
  );
});

test("a document with no pages is an error too", () => {
  assert.throws(
    () => selectPages([], 0, 1000),
    (error: unknown) =>
      error instanceof PdfError &&
      /no pages/.test(error.message) &&
      // Not the scan diagnosis above: there are no pages here whose text layer
      // could be missing, so OCR is not the thing to go and try.
      !/OCR/.test(error.message),
  );
});

test("a page that fits whole is not reported as cut", () => {
  // The blank page ahead of it is charged for a separator, so this page is
  // rejected by one character and reaches the single-page path — where nothing
  // was in fact cut off it.
  const result = selectPages(["", page(99)], 2, 100);
  assert.equal(result.text, page(99));
  assert.equal(result.note, "page 2 of 2");
});

test("whatever comes back, it is never empty", () => {
  // The invariant behind all of the above, stated once against every shape that
  // reaches this function with something readable in it.
  const shapes: string[][] = [
    ["a"],
    ["", "a"],
    ["", "", page(10_000)],
    [page(10_000), "a"],
    ["a", page(10_000)],
    ["", page(99), ""],
  ];
  for (const pages of shapes) {
    const result = selectPages(pages, pages.length, 100);
    assert.notEqual(result.text.trim(), "", JSON.stringify(pages.map((p) => p.length)));
    assert.ok(result.text.length <= 100);
  }
});
