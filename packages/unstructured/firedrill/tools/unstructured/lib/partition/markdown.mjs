// Markdown partitioning: headings, fenced code, pipe tables, lists, images, inline emphasis and links.
import { classifyBlock, stripListMarker } from "./elements.mjs";
import { tableHtml, tableText } from "./csv.mjs";
import { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS } from "./html.mjs";
import { MAX_BLOCKS } from "./text.mjs";

const LIST_RE = /^(\s*)([-*+]|\d{1,4}[.)])\s+(.*)$/;
const CELL_RE = /^:?-+:?$/; // GFM: at least one dash per cell, optional alignment colons

/** ATX heading: `#`{1,6} + whitespace + text with optional closing hashes. Linear scan, returns { depth, text } or null. */
function parseHeading(line) {
  let depth = 0;
  while (depth < line.length && line[depth] === "#") depth += 1;
  if (depth === 0 || depth > 6 || depth >= line.length || (line[depth] !== " " && line[depth] !== "\t")) return null;
  let end = line.length;
  while (end > depth && (line[end - 1] === " " || line[end - 1] === "\t")) end -= 1;
  while (end > depth && line[end - 1] === "#") end -= 1;
  while (end > depth && (line[end - 1] === " " || line[end - 1] === "\t")) end -= 1;
  return { depth, text: line.slice(depth, end).trim() };
}

/** `![alt](url "title")` on its own line. Linear scan via indexOf, returns { alt, url } or null. */
function parseImage(line) {
  if (!line.startsWith("![")) return null;
  const closeAlt = line.indexOf("](", 2);
  if (closeAlt < 0 || line.indexOf("]", 2) !== closeAlt) return null;
  const closeUrl = line.indexOf(")", closeAlt + 2);
  if (closeUrl < 0 || line.slice(closeUrl + 1).trim().length > 0) return null;
  const inner = line.slice(closeAlt + 2, closeUrl);
  return { alt: line.slice(2, closeAlt), url: inner.split(/\s/)[0] };
}

const SEPARATOR_CHARS_RE = /^[\s|:-]*$/; // a separator row holds only pipes, dashes, colons and whitespace

/**
 * Pipe-table separator row (`| --- | :---: |`): the number of cells when every cell is `:?-+:?` after trimming, otherwise
 * 0. Linear in the line at any width: ordinary text is rejected by one character-class scan before anything is split,
 * and a real separator is never ignored for being long, so a table wider than the cell bound fails with the declared
 * error instead of silently becoming text.
 */
function separatorCells(line) {
  if (!line.includes("|") || !SEPARATOR_CHARS_RE.test(line)) return 0;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => CELL_RE.test(cell)) ? cells.length : 0;
}

/**
 * A forward `indexOf` memo: `text` is scanned once per needle no matter how often it is asked, because every query
 * position is at or after the previous one (the caller's index only moves forward), so a cached hit at or beyond
 * the query is still the first occurrence. Returns Infinity when the needle does not occur again.
 */
function finder(text, needle) {
  let at = -1;
  return (from) => {
    if (at < from) {
      const next = text.indexOf(needle, from);
      at = next < 0 ? Infinity : next;
    }
    return at;
  };
}

/** Extracts links and emphasis from inline markup and returns the plain text plus metadata. Linear in the text. */
export function inline(text) {
  const meta = {};
  const linkTexts = [];
  const linkUrls = [];
  const emphasis = [];
  const tags = [];
  const out = [];
  const linkClose = finder(text, "](");
  const linkEnd = finder(text, ")");
  const tick = finder(text, "`");
  const markers = new Map([["*", finder(text, "*")], ["**", finder(text, "**")], ["_", finder(text, "_")], ["__", finder(text, "__")]]);
  let i = 0;
  while (i < text.length) {
    if (text[i] === "[") {
      const close = linkClose(i);
      const end = close !== Infinity ? linkEnd(close + 2) : Infinity;
      if (end !== Infinity && end - i <= 2000) {
        const label = text.slice(i + 1, close);
        linkTexts.push(label);
        linkUrls.push(text.slice(close + 2, end).split(/\s/)[0]);
        out.push(label);
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "*" || text[i] === "_") {
      const marker = text[i];
      const double = text[i + 1] === marker;
      const open = double ? marker + marker : marker;
      const close = markers.get(open)(i + open.length);
      if (close !== Infinity && close > i + open.length && close - i <= 2000) {
        const content = text.slice(i + open.length, close);
        if (!content.includes("\n") && content.trim().length > 0 && content[0] !== " ") {
          emphasis.push(content);
          tags.push(double ? "b" : "i");
          out.push(content);
          i = close + open.length;
          continue;
        }
      }
    }
    if (text[i] === "`") {
      const close = tick(i + 1);
      if (close !== Infinity && close - i <= 2000) {
        out.push(text.slice(i + 1, close));
        i = close + 1;
        continue;
      }
    }
    out.push(text[i]);
    i += 1;
  }
  if (linkTexts.length > 0) {
    meta.link_texts = linkTexts;
    meta.link_urls = linkUrls;
  }
  if (emphasis.length > 0) {
    meta.emphasized_text_contents = emphasis;
    meta.emphasized_text_tags = tags;
  }
  return { text: out.join(""), meta };
}

function flushParagraph(builder, lines) {
  if (lines.length === 0) return;
  const block = lines.join("\n");
  const { text, meta } = inline(block);
  const type = classifyBlock(text);
  builder.add(type === "ListItem" ? "UncategorizedText" : type, text.split("\n").map((l) => l.trim()).join("\n"), type === "Title" ? { category_depth: 0, ...meta } : meta);
  lines.length = 0;
}

const splitRow = (line) => {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => cell.trim());
};

export function partitionMarkdown(builder, text) {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const paragraph = [];
  let blocks = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Blank lines and lines read while a paragraph is open never count against the bound (a line that closes the paragraph
    // emits at most one more element, and elements have their own bound), so only real content can reach it.
    if (paragraph.length === 0 && line.trim().length > 0 && (blocks += 1) > MAX_BLOCKS) return { ok: false, message: "File has too many text blocks" };
    if (line.includes("\f")) {
      flushParagraph(builder, paragraph);
      builder.pageBreak();
      i += 1;
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph(builder, paragraph);
      i += 1;
      continue;
    }
    if (line.startsWith("```") || line.startsWith("~~~")) {
      flushParagraph(builder, paragraph);
      const fence = line.slice(0, 3);
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith(fence)) code.push(lines[i++]);
      builder.add("CodeSnippet", code.join("\n"));
      i += 1;
      continue;
    }
    const heading = parseHeading(line);
    if (heading !== null) {
      flushParagraph(builder, paragraph);
      const { text: title, meta } = inline(heading.text);
      builder.add("Title", title, { category_depth: heading.depth - 1, ...meta });
      i += 1;
      continue;
    }
    const width = line.includes("|") && i + 1 < lines.length ? separatorCells(lines[i + 1]) : 0;
    if (width > 0) {
      flushParagraph(builder, paragraph);
      // Same bounds as HTML tables: more rows or cells than the bound fail the file, nothing is dropped. The separator
      // row counts too, so a header narrower than its separator cannot slip a wider table past the bound.
      if (width > MAX_TABLE_COLUMNS) return { ok: false, message: `File has a table row with more than ${MAX_TABLE_COLUMNS} cells` };
      const rows = [splitRow(line)];
      if (rows[0].length > MAX_TABLE_COLUMNS) return { ok: false, message: `File has a table row with more than ${MAX_TABLE_COLUMNS} cells` };
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim().length > 0) {
        const row = splitRow(lines[i++]);
        if (row.length > MAX_TABLE_COLUMNS) return { ok: false, message: `File has a table row with more than ${MAX_TABLE_COLUMNS} cells` };
        rows.push(row);
        if (rows.length > MAX_TABLE_ROWS) return { ok: false, message: `File has a table with more than ${MAX_TABLE_ROWS} rows` };
      }
      builder.add("Table", tableText(rows), { text_as_html: tableHtml(rows) });
      continue;
    }
    const image = parseImage(line);
    if (image !== null) {
      flushParagraph(builder, paragraph);
      builder.add("Image", image.alt, { image_url: image.url.length > 0 ? image.url : undefined });
      i += 1;
      continue;
    }
    const item = LIST_RE.exec(line);
    if (item !== null && paragraph.length === 0) {
      const depth = Math.min(Math.floor(item[1].replace(/\t/g, "  ").length / 2), 10);
      const { text: itemText, meta } = inline(stripListMarker(line).trim());
      builder.add("ListItem", itemText, { category_depth: depth, ...meta });
      i += 1;
      continue;
    }
    paragraph.push(line);
    i += 1;
  }
  flushParagraph(builder, paragraph);
  return { ok: true };
}
