/**
 * The HTML stripper is hand-written, which is the right trade for a dependency
 * with its own attack surface — but it is also the kind of code that degrades
 * without anyone noticing, because its output is prose nobody diffs. These pin
 * the behaviours that would silently get worse.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { decodeEntities, htmlToText } from "./html.js";

test("drops script and style contents, not just their tags", () => {
  const text = htmlToText(
    `<p>before</p><script>var evil = "steal";</script><style>.a{color:red}</style><p>after</p>`,
  );
  assert.equal(text, "before\n\nafter");
});

test("keeps the title, once", () => {
  assert.equal(htmlToText("<title>Report</title><body><p>body</p></body>"), "Report\n\nbody");
  // A page whose body already opens with the title should not say it twice.
  assert.equal(
    htmlToText("<title>Report</title><body><h1>Report</h1><p>x</p></body>"),
    "Report\n\nx",
  );
});

test("separates blocks by a blank line and <br> by one newline", () => {
  assert.equal(htmlToText("<p>one</p><p>two</p>"), "one\n\ntwo");
  assert.equal(htmlToText("a<br>b<br/>c"), "a\nb\nc");
  assert.equal(htmlToText("<h1>Title</h1><div>body</div>"), "Title\n\nbody");
});

test("source newlines inside a block are not output newlines", () => {
  // HTML says whitespace in the source is insignificant. A hard-wrapped
  // paragraph is one paragraph.
  assert.equal(htmlToText("<p>one\ntwo\nthree</p>"), "one two three");
});

test("marks list items so a list reads as one", () => {
  assert.equal(htmlToText("<ul><li>a</li><li>b</li></ul>"), "- a\n- b");
});

test("keeps table cells apart", () => {
  const text = htmlToText("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>");
  assert.equal(text, "a | b\nc | d");
});

test("collapses whitespace without merging paragraphs", () => {
  assert.equal(htmlToText("<p>a   \n  b</p><p>c</p>"), "a b\n\nc");
});

test("never emits two blank lines in a row", () => {
  assert.equal(htmlToText("<div><p>a</p></div><div><p>b</p></div>"), "a\n\nb");
});

test("a comment cannot swallow the markup after it", () => {
  assert.equal(htmlToText("<p>a</p><!-- <script>x</script> --><p>b</p>"), "a\n\nb");
});

test("an unterminated dropped element does not leak its contents as prose", () => {
  // The source is cut at MAX_HTML_CHARS before it gets here, so this function
  // does receive markup that stops mid-element. A `<script>` whose `</script>`
  // was cut off used to have only its opening tag removed, and its JavaScript
  // came back as the page's text.
  assert.equal(htmlToText(`<p>prose</p><script>var secret = "token"; // cut here`), "prose");
  assert.equal(htmlToText(`<p>prose</p><style>.a{color:red}`), "prose");
  assert.equal(htmlToText(`<p>prose</p><!-- a comment that never closes`), "prose");
});

test("ignores an unterminated tag rather than eating the document", () => {
  assert.equal(htmlToText("<p>visible</p><div class="), "visible");
});

test("decodes the entity forms that appear in prose", () => {
  assert.equal(decodeEntities("a &lt; b &gt; c"), "a < b > c");
  assert.equal(decodeEntities("&quot;q&quot; &apos;a&apos;"), `"q" 'a'`);
  assert.equal(decodeEntities("&#65;&#66;&#x43;"), "ABC");
  assert.equal(decodeEntities("&#xD55C;"), "한");
});

test("decodes an escaped ampersand last", () => {
  // `&amp;lt;` is a literal `&lt;`, not a `<`. Decoding `&amp;` first loses that.
  assert.equal(decodeEntities("&amp;lt;"), "&lt;");
  assert.equal(decodeEntities("a &amp; b"), "a & b");
});

test("leaves an unknown entity alone", () => {
  assert.equal(decodeEntities("&notanentity; &copy;"), "&notanentity; &copy;");
});

test("drops an out-of-range numeric reference instead of emitting U+FFFD", () => {
  assert.equal(decodeEntities("a&#xD800;b"), "ab");
  assert.equal(decodeEntities("a&#1114112;b"), "ab");
});

test("returns empty for markup with no prose", () => {
  assert.equal(htmlToText("<html><head><style>.a{}</style></head><body></body></html>"), "");
});
