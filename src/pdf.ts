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

export interface PdfText {
  text: string;
  truncated: boolean;
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

  const cleaned = pages.map((page) => page.replace(/[^\S\n]+/g, " ").trim());
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

  // A first page that alone exceeds the budget would otherwise return nothing at
  // all; a hard cut is worse than a page boundary but far better than silence.
  if (kept.length === 0) {
    return {
      text: cleaned[0]!.slice(0, maxChars),
      truncated: true,
      note: `page 1 of ${totalPages}, itself cut at ${maxChars.toLocaleString("en-US")} characters`,
    };
  }

  const truncated = kept.length < cleaned.length;
  return {
    text: kept.join(PAGE_SEPARATOR),
    truncated,
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
