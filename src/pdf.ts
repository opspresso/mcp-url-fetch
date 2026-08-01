/**
 * PDF to text, via `unpdf`.
 *
 * `unpdf` rather than the alternatives because it matches this repository: ESM,
 * Node >=22, and no dependencies of its own — it ships a serverless build of
 * PDF.js, so there is nothing to compile in an alpine image.
 *
 * Pages are extracted separately and joined here rather than merged by the
 * library, so a document too large for the budget can say *how much* of it came
 * back. "The first 18 of 42 pages" is a fact a model can act on; a truncated
 * blob is not.
 */

import { extractText, getDocumentProxy } from "unpdf";

/**
 * `Math.sumPrecise` is a TC39 proposal, and no Node this runs on has it — not
 * the 24 the image pins, not 26. The PDF.js build inside `unpdf` calls it while
 * rebuilding an embedded font's glyph tables, so every font throws a TypeError
 * that PDF.js catches and reports as a warning: one line per font, thirty-three
 * of them for a fifteen-page paper. Two costs, and the second is the reason this
 * is here — the font rebuild is abandoned rather than done, and the noise buries
 * the failure lines `server.ts` writes on purpose in the same stream.
 *
 * Neumaier summation, not the proposal's exactly-rounded algorithm: the sums
 * asked for are glyph byte counts and column widths, and carrying Shewchuk's
 * expansion for three call sites that add integers would be the wrong trade. It
 * is installed only if absent, so a future runtime's own implementation wins.
 */
const math = Math as unknown as { sumPrecise?: (values: Iterable<number>) => number };
if (typeof math.sumPrecise !== "function") {
  math.sumPrecise = (values) => {
    let sum = 0;
    let compensation = 0;
    for (const value of values) {
      const next = sum + value;
      // The larger magnitude keeps its bits; the smaller one is what rounding
      // drops, so that is the side the lost low bits are recovered from.
      compensation +=
        Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
      sum = next;
    }
    return sum + compensation;
  };
}

export interface PdfText {
  text: string;
  /** What was returned, in the document's own units. */
  note: string;
}

export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfError";
  }
}

/** A page break the model can see, since the page numbers in `note` refer to it. */
const PAGE_SEPARATOR = "\n\n";

/**
 * PDF.js refuses a Node `Buffer` outright — "provide binary data as
 * `Uint8Array`" — even though a Buffer is one. Owning the conversion here means
 * a caller cannot get it wrong, and there is only one caller to get it right.
 *
 * This copies rather than taking a view. `Buffer.concat` allocates out of the
 * shared 8KB pool for small results, so a view would hand PDF.js a window onto
 * memory other Buffers are using — and PDF.js detaches the array it is given.
 */
function asPlainBytes(bytes: Uint8Array): Uint8Array {
  return bytes.constructor === Uint8Array ? bytes : new Uint8Array(bytes);
}

export async function pdfToText(bytes: Uint8Array, maxChars: number): Promise<PdfText> {
  let pages: string[];
  let totalPages: number;
  try {
    const pdf = await getDocumentProxy(asPlainBytes(bytes));
    const extracted = await extractText(pdf, { mergePages: false });
    pages = extracted.text;
    totalPages = extracted.totalPages;
  } catch (error) {
    throw new PdfError(describe(error));
  }
  // Outside the catch on purpose: a PdfError raised by the accounting below is
  // already the answer, and re-wrapping it would file "this is a scan" under
  // "the PDF could not be parsed".
  return selectPages(pages, totalPages, maxChars);
}

/**
 * Which pages fit the budget, and what to say about what did not.
 *
 * Separate from the extraction above so it can be tested without a PDF, which
 * is the same split the rest of this server uses for its decisions. It is worth
 * the seam: this is where the edges are, and every one of them ends in the
 * answer being *no text at all* if it is got wrong.
 */
export function selectPages(pages: string[], totalPages: number, maxChars: number): PdfText {
  const cleaned = pages.map((page) => page.replace(/[^\S\n]+/g, " ").trim());
  if (cleaned.length === 0) {
    // Ahead of the scan check below, which `[].every` would answer `true` — a
    // document with no pages has no text layer to be missing, and sending the
    // model to find an OCR path for it is a dead end it cannot detect.
    throw new PdfError("the PDF has no pages, so there is nothing to extract");
  }
  if (cleaned.every((page) => page === "")) {
    // Silence here would be read as "the document is empty", which is a
    // different and much more damaging answer than "I could not read it".
    throw new PdfError(
      `the PDF has ${totalPages} page(s) but no extractable text layer — it is most likely a scan, ` +
        `which needs OCR rather than text extraction`,
    );
  }

  const kept: string[] = [];
  let length = 0;
  for (const page of cleaned) {
    const addition = (kept.length > 0 ? PAGE_SEPARATOR.length : 0) + page.length;
    if (length + addition > maxChars) {
      break;
    }
    kept.push(page);
    length += addition;
  }

  // A page too large for the budget on its own would otherwise return nothing at
  // all — and blank pages ahead of it are kept for free, so a full `kept` is not
  // the same as a `kept` with text in it. That case looked like a success and
  // read as "the document is empty". A hard cut is worse than a page boundary
  // and far better than the silence.
  if (kept.every((page) => page === "")) {
    // Safe: the all-blank document threw above, so there is a page with text.
    const first = cleaned.findIndex((page) => page !== "");
    const whole = cleaned[first]!;
    const text = whole.slice(0, maxChars);
    return {
      text,
      // Only claim a cut when there was one. A blank page ahead of this one is
      // charged for a separator, so a page that fits the budget whole can still
      // be rejected by those two characters and land here — and being told to
      // expect missing text there sends the model looking for a tail that is not
      // missing.
      note:
        text.length < whole.length
          ? `page ${first + 1} of ${totalPages}, itself cut at ${maxChars.toLocaleString("en-US")} characters`
          : `page ${first + 1} of ${totalPages}`,
    };
  }

  const truncated = kept.length < cleaned.length;
  return {
    text: kept.join(PAGE_SEPARATOR),
    note: truncated
      ? `the first ${kept.length} of ${totalPages} pages`
      : `all ${totalPages} page(s)`,
  };
}

/** Turn PDF.js's exception vocabulary into something a model can act on. */
function describe(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "PasswordException" || /password/i.test(message)) {
    return "the PDF is password-protected, so its text cannot be read";
  }
  if (name === "InvalidPDFException" || /invalid pdf/i.test(message)) {
    return "the file is not a valid PDF";
  }
  return `the PDF could not be parsed — ${message}`;
}
