// HTML partitioning over the streamed token sequence: headings, paragraphs, lists, tables, code, images, header/footer,
// links. Linear by construction: an explicit element stack with per-name open counts (an unmatched close tag costs
// nothing, a matched one pops what was pushed), counters instead of stack scans for head/title/header/footer, text
// accumulated in arrays and joined once, one open anchor at a time (as HTML parsers do) and one open mark per emphasis
// tag. Every bound answers a declared error: nesting depth, table rows and cells per row.
import { classifyBlock } from "./elements.mjs";
import { tokenize } from "./html-tokens.mjs";
import { collapseSpace, escapeHtml, hasClassToken } from "./html-util.mjs";

export const MAX_DEPTH = 256;
export const MAX_TABLE_ROWS = 10000;
export const MAX_TABLE_COLUMNS = 200;

const HEADING_DEPTH = new Map([["h1", 0], ["h2", 1], ["h3", 2], ["h4", 3], ["h5", 4], ["h6", 5]]);
const TYPED = new Map([["li", "ListItem"], ["pre", "CodeSnippet"], ["address", "Address"], ["figcaption", "FigureCaption"], ["header", "Header"], ["footer", "Footer"]]);
const BLOCKS = new Set(["p", "div", "section", "article", "main", "aside", "nav", "blockquote", "ul", "ol", "dl", "dt", "dd", "form", "figure", "body", "html", "tr", "td", "th", "thead", "tbody", "caption"]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "source", "wbr", "col"]);
const EMPHASIS = new Map([["b", "b"], ["strong", "b"], ["i", "i"], ["em", "i"]]);
const CHROME = new Set(["head", "title", "header", "footer"]);
const OVERFLOW = "File has too many text blocks";

const hasPageBreak = (attrs, which) => typeof attrs.style === "string" && attrs.style.toLowerCase().includes(`page-break-${which}`);
const stripLeadingNewlines = (text) => {
  let k = 0;
  while (k < text.length && text[k] === "\n") k += 1;
  return text.slice(k);
};

export function partitionHtml(builder, html) {
  const stack = [];
  const openCount = new Map();
  const inside = { head: 0, title: 0, header: 0, footer: 0 };
  let buffer = null;
  let table = null;

  const push = (name) => {
    stack.push(name);
    openCount.set(name, (openCount.get(name) ?? 0) + 1);
    if (CHROME.has(name)) inside[name] += 1;
    return stack.length <= MAX_DEPTH;
  };
  const popTo = (at) => {
    while (stack.length > at) {
      const name = stack.pop();
      const count = openCount.get(name) - 1;
      if (count === 0) openCount.delete(name);
      else openCount.set(name, count);
      if (CHROME.has(name)) inside[name] -= 1;
    }
  };
  const closeTag = (name) => {
    if (openCount.has(name)) popTo(stack.lastIndexOf(name));
  };

  const openBuffer = (type, depth) => {
    buffer = { type, depth, parts: [], linkTexts: [], linkUrls: [], emphasis: [], tags: [], anchor: null, marks: [] };
  };
  const ensureBuffer = () => {
    if (buffer === null) openBuffer(null, null);
  };
  const since = (index) => collapseSpace(buffer.parts.slice(index).join(""));
  const closeAnchor = () => {
    const anchor = buffer.anchor;
    buffer.anchor = null;
    const label = since(anchor.start);
    if (label.length > 0) {
      buffer.linkTexts.push(label);
      buffer.linkUrls.push(anchor.href);
    }
  };
  const closeMark = (tag) => {
    let at = buffer.marks.length - 1;
    while (at >= 0 && buffer.marks[at].tag !== tag) at -= 1;
    if (at < 0) return;
    const [mark] = buffer.marks.splice(at, 1);
    const content = since(mark.start);
    if (content.length > 0) {
      buffer.emphasis.push(content);
      buffer.tags.push(mark.tag);
    }
  };
  const flush = () => {
    if (buffer === null) return;
    const current = buffer;
    if (current.anchor !== null) closeAnchor();
    while (current.marks.length > 0) closeMark(current.marks[current.marks.length - 1].tag);
    buffer = null;
    const raw = current.parts.join("");
    const text = current.type === "CodeSnippet" ? stripLeadingNewlines(raw).trimEnd() : collapseSpace(raw);
    if (text.length === 0) return;
    let type = current.type ?? classifyBlock(text);
    const chrome = inside.header > 0 ? "Header" : inside.footer > 0 ? "Footer" : null;
    if (chrome !== null && type !== "Title") type = chrome;
    const meta = {};
    if (type === "Title") meta.category_depth = current.depth ?? 0;
    if (current.linkTexts.length > 0) {
      meta.link_texts = current.linkTexts;
      meta.link_urls = current.linkUrls;
    }
    if (current.emphasis.length > 0) {
      meta.emphasized_text_contents = current.emphasis;
      meta.emphasized_text_tags = current.tags;
    }
    builder.add(type, text, meta);
  };

  const closeCell = () => {
    table.row.push(collapseSpace(table.cell.join("")));
    table.cell = null;
    return table.row.length <= MAX_TABLE_COLUMNS ? undefined : `File has a table row with more than ${MAX_TABLE_COLUMNS} cells`;
  };
  const closeRow = () => {
    const problem = table.cell !== null ? closeCell() : undefined;
    if (problem !== undefined) return problem;
    table.rows.push(table.row);
    table.row = null;
    return table.rows.length <= MAX_TABLE_ROWS ? undefined : `File has a table with more than ${MAX_TABLE_ROWS} rows`;
  };
  const closeTable = () => {
    const problem = table.row !== null ? closeRow() : undefined;
    if (problem !== undefined) return problem;
    if (table.rows.length > 0) {
      const text = table.rows.map((row) => row.join(" ")).join("\n");
      const markup = `<table>${table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</table>`;
      builder.add("Table", text, { text_as_html: markup });
    }
    table = null;
    return undefined;
  };

  const visit = (token) => {
    if (token.kind === "text") {
      if (inside.head > 0 || inside.title > 0) return undefined;
      if (table !== null) {
        if (table.cell !== null) table.cell.push(token.text);
      } else if (token.text.trim().length > 0 || buffer !== null) {
        ensureBuffer();
        buffer.parts.push(token.text);
      }
      return undefined;
    }
    const name = token.name;
    if (token.kind === "open") {
      if (hasPageBreak(token.attrs, "before") || (name === "hr" && typeof token.attrs.class === "string" && hasClassToken(token.attrs.class, "page-break"))) {
        flush();
        builder.pageBreak();
      }
      if (table !== null) {
        let problem;
        if (name === "tr") {
          if (table.row !== null) problem = closeRow();
          table.row = [];
        } else if (name === "td" || name === "th") {
          if (table.cell !== null) problem = closeCell();
          if (table.row === null) table.row = [];
          table.cell = [];
        } else if (name === "br" && table.cell !== null) table.cell.push(" ");
        if (problem !== undefined) return problem;
      } else if (name === "table") {
        flush();
        table = { rows: [], row: null, cell: null };
      } else if (name === "br") {
        if (buffer !== null) buffer.parts.push("\n");
      } else if (name === "img") {
        flush();
        builder.add("Image", collapseSpace(typeof token.attrs.alt === "string" ? token.attrs.alt : ""), { image_url: typeof token.attrs.src === "string" && token.attrs.src.length > 0 ? token.attrs.src : undefined });
      } else if (HEADING_DEPTH.has(name)) {
        flush();
        openBuffer("Title", HEADING_DEPTH.get(name));
      } else if (TYPED.has(name)) {
        flush();
        if (name !== "header" && name !== "footer") openBuffer(TYPED.get(name), null);
      } else if (BLOCKS.has(name) || name === "hr") flush();
      else if (name === "a") {
        ensureBuffer();
        if (buffer.anchor !== null) closeAnchor();
        buffer.anchor = { start: buffer.parts.length, href: typeof token.attrs.href === "string" ? token.attrs.href : "" };
      } else if (EMPHASIS.has(name)) {
        ensureBuffer();
        const tag = EMPHASIS.get(name);
        if (!buffer.marks.some((mark) => mark.tag === tag)) buffer.marks.push({ start: buffer.parts.length, tag });
      }
      if (!token.selfClosing && !VOID.has(name) && !push(name)) return `File is not valid html: elements nested deeper than ${MAX_DEPTH} levels`;
      return builder.overflow ? OVERFLOW : undefined;
    }
    if (table !== null) {
      let problem;
      if ((name === "td" || name === "th") && table.cell !== null) problem = closeCell();
      else if (name === "tr" && table.row !== null) problem = closeRow();
      else if (name === "table") problem = closeTable();
      closeTag(name);
      return problem ?? (builder.overflow ? OVERFLOW : undefined);
    }
    if (name === "a") {
      if (buffer !== null && buffer.anchor !== null) closeAnchor();
    } else if (EMPHASIS.has(name)) {
      if (buffer !== null) closeMark(EMPHASIS.get(name));
    } else if (HEADING_DEPTH.has(name) || TYPED.has(name) || BLOCKS.has(name)) flush();
    closeTag(name);
    return builder.overflow ? OVERFLOW : undefined;
  };

  const result = tokenize(html, visit);
  if (result.error !== undefined) return { ok: false, message: result.error };
  if (table !== null) {
    const problem = closeTable();
    if (problem !== undefined) return { ok: false, message: problem };
  }
  flush();
  return builder.overflow ? { ok: false, message: OVERFLOW } : { ok: true };
}
