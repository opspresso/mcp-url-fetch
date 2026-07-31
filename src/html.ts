/**
 * HTML to the text a model should read.
 *
 * This is a readability heuristic, not a DOM parser. A real parser would be a
 * dependency with its own attack surface, and the job here is narrow: strip the
 * markup a model cannot use and keep the structure it can — paragraph breaks,
 * list items, table cells. Where the two disagree, readability wins over
 * fidelity.
 *
 * The output shape is deliberate and stable: blocks separated by one blank
 * line, `<br>` and list items by a single newline, table cells by ` | `.
 *
 * What it does not do: run scripts, resolve `<iframe>`s, or apply CSS. Content
 * that only exists after JavaScript runs is invisible here, and that is the
 * honest outcome — a server that rendered pages would be a browser. `<pre>`
 * loses its internal spacing for the same reason the rest of the document does
 * (see `collapseSource` below); code fidelity is not what this is for.
 */

/**
 * Elements whose *contents* are markup, code, or metadata — never body prose.
 *
 * `title` is here even though it is kept: `titleOf` reads it off the raw input
 * before this runs, and dropping it afterwards is what stops it appearing twice
 * in a document that has no `<head>` for the removal below to catch.
 */
const DROPPED_ELEMENTS = ["script", "style", "noscript", "svg", "template", "iframe", "title"];

/** Blocks that read as paragraphs: one blank line between them. */
const PARAGRAPH_ELEMENTS =
  "p|div|section|article|header|footer|main|aside|blockquote|pre|h[1-6]|ul|ol|dl|table|form|figure|figcaption";

/**
 * Named entities worth handling without a table of all 2,231 of them. `&amp;`
 * is absent on purpose — it is decoded last, below, or `&amp;lt;` would come
 * out as `<` instead of `&lt;`.
 */
const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the entity forms that actually appear in prose. */
export function decodeEntities(value: string): string {
  return (
    value
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number(dec)))
      .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
      // Last: an escaped ampersand may itself introduce an entity that was never
      // meant to be decoded.
      .replace(/&amp;/gi, "&")
  );
}

/** A numeric reference that is out of range or a surrogate is dropped rather
 * than becoming U+FFFD — a replacement character reads as corruption. */
function codePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) {
    return "";
  }
  if (value >= 0xd800 && value <= 0xdfff) {
    return "";
  }
  return String.fromCodePoint(value);
}

/**
 * Whitespace in the *source* carries no meaning in HTML — a paragraph broken
 * across source lines is one paragraph. Flattening it before any structural
 * newline is inserted is what keeps those two kinds of newline apart; doing it
 * afterwards would make every hard-wrapped source line its own line of output.
 */
function collapseSource(value: string): string {
  return value.replace(/\s+/g, " ");
}

/** Also drops a trailing unterminated tag, which has no `>` to match. */
function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/<[^>]*$/, "");
}

/**
 * The page title, which is the one piece of `<head>` worth keeping: it is often
 * the only statement of what the document *is*.
 */
function titleOf(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1] ? decodeEntities(stripTags(collapseSource(match[1]))).trim() : "";
  return title || undefined;
}

export function htmlToText(html: string): string {
  const title = titleOf(html);

  let text = html
    // Comments first: one can contain anything, including a `<script>` that the
    // element pass below would otherwise try to match across.
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ");

  // `|$` rather than requiring the close tag. The source reaching this function
  // may have been cut mid-element — `MAX_HTML_CHARS` does exactly that — and an
  // opening tag whose closer was cut off would otherwise match nothing, leaving
  // `stripTags` to remove the tag and hand the model the script source it
  // wrapped, labelled as the document's prose. Consuming to the end of the input
  // is also what a parser does with an unterminated raw-text element.
  //
  // `(?<!/)` is what keeps that from eating a document whole: `<script src="a"/>`
  // is a self-closing tag, ordinary in the XHTML this server also accepts, and it
  // has no contents and no closer to look for. Without the lookbehind it opened
  // an element that ran to the end of the page.
  for (const element of DROPPED_ELEMENTS) {
    text = text.replace(
      new RegExp(`<${element}\\b[^>]*(?<!/)>[\\s\\S]*?(?:<\\/${element}\\s*>|$)`, "gi"),
      " ",
    );
  }

  text = collapseSource(text.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, " "));

  text = text
    // Single-newline boundaries: these group rather than separate.
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(tr|dt|dd)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    // Cell boundaries carry meaning in a table — a row of values run together
    // is not readable as a row.
    .replace(/<\/t[dh]\s*>/gi, " | ")
    // Paragraph boundaries, both ends: a block is separated from its neighbour
    // whether the markup closed the previous one or not.
    .replace(new RegExp(`<\\/(${PARAGRAPH_ELEMENTS})\\s*>`, "gi"), "\n\n")
    .replace(new RegExp(`<(${PARAGRAPH_ELEMENTS})\\b[^>]*>`, "gi"), "\n\n");

  const body = normalize(decodeEntities(stripTags(text)));

  // The title is prepended rather than merged: it came from `<head>`, so it is
  // not part of the body's own flow and should not read as its first sentence.
  return title && !body.startsWith(title) ? `${title}\n\n${body}`.trim() : body;
}

/** Trim each line, drop leading/trailing blanks, and never allow two in a row. */
function normalize(text: string): string {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    // A trailing cell separator is an artifact of the last `</td>`, not content.
    const line = raw.replace(/[^\S\n]+/g, " ").trim().replace(/\s*\|$/, "").trim();
    if (line === "") {
      if (out.length > 0 && out[out.length - 1] !== "") {
        out.push("");
      }
      continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }
  return out.join("\n");
}
