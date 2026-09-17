// Rendering of a Docs API `Document` resource onto the page surface, plus the index arithmetic that
// turns a browser selection into the UTF-16 `startIndex`/`endIndex` range the Docs API expects.
//
// Nothing here talks to the Tool: app.js owns every call. Nothing here parses HTML — each text run is
// written with textContent and styled through element style properties.
import { el } from "./ui.js";

const STYLE_CLASS = {
  TITLE: "d-title",
  SUBTITLE: "d-subtitle",
  HEADING_1: "d-h1",
  HEADING_2: "d-h2",
  HEADING_3: "d-h3",
  HEADING_4: "d-h4",
  HEADING_5: "d-h5",
  HEADING_6: "d-h6",
  NORMAL_TEXT: "",
};

export const STYLE_LABEL = {
  NORMAL_TEXT: "Normal text",
  TITLE: "Title",
  SUBTITLE: "Subtitle",
  HEADING_1: "Heading 1",
  HEADING_2: "Heading 2",
  HEADING_3: "Heading 3",
  HEADING_4: "Heading 4",
  HEADING_5: "Heading 5",
  HEADING_6: "Heading 6",
};

const ALIGN_CLASS = { CENTER: "d-align-center", END: "d-align-right", JUSTIFIED: "d-align-justify" };

const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];
const ALPHA = "abcdefghijklmnopqrstuvwxyz";

/** The plain text of one paragraph, without its terminating newline. */
export function paragraphText(paragraph) {
  let text = "";
  for (const element of paragraph.elements ?? []) {
    if (element.textRun) text += element.textRun.content ?? "";
  }
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function applyTextStyle(node, style = {}) {
  if (style.bold) node.style.fontWeight = "700";
  if (style.italic) node.style.fontStyle = "italic";
  const decorations = [];
  if (style.underline) decorations.push("underline");
  if (style.strikethrough) decorations.push("line-through");
  if (decorations.length > 0) node.style.textDecoration = decorations.join(" ");
  if (style.fontSize?.magnitude) node.style.fontSize = `${(style.fontSize.magnitude * 4) / 3}px`;
  if (style.weightedFontFamily?.fontFamily) node.style.fontFamily = `${style.weightedFontFamily.fontFamily}, Arial, sans-serif`;
  const foreground = style.foregroundColor?.color?.rgbColor;
  if (foreground) node.style.color = rgb(foreground);
  const background = style.backgroundColor?.color?.rgbColor;
  if (background) node.style.backgroundColor = rgb(background);
  if (style.baselineOffset === "SUPERSCRIPT") node.style.verticalAlign = "super";
  if (style.baselineOffset === "SUBSCRIPT") node.style.verticalAlign = "sub";
  if (style.baselineOffset === "SUPERSCRIPT" || style.baselineOffset === "SUBSCRIPT") node.style.fontSize = "0.75em";
  if (style.link?.url) node.classList.add("d-run-link");
}

function rgb(color) {
  const value = (channel) => Math.round((channel ?? 0) * 255);
  return `rgb(${value(color.red)}, ${value(color.green)}, ${value(color.blue)})`;
}

function glyphFor(lists, bullet, ordinal) {
  const level = lists?.[bullet.listId]?.listProperties?.nestingLevels?.[bullet.nestingLevel ?? 0];
  if (!level) return "●";
  const format = level.glyphFormat ?? "%0";
  const type = level.glyphType ?? "GLYPH_TYPE_UNSPECIFIED";
  let mark = level.glyphSymbol ?? "●";
  if (type === "DECIMAL") mark = String(ordinal);
  else if (type === "ZERO_DECIMAL") mark = String(ordinal).padStart(2, "0");
  else if (type === "ALPHA") mark = ALPHA[(ordinal - 1) % 26];
  else if (type === "UPPER_ALPHA") mark = ALPHA[(ordinal - 1) % 26].toUpperCase();
  else if (type === "ROMAN") mark = ROMAN[(ordinal - 1) % ROMAN.length];
  else if (type === "UPPER_ROMAN") mark = ROMAN[(ordinal - 1) % ROMAN.length].toUpperCase();
  return format.replaceAll("%0", mark).replaceAll("%1", mark).replaceAll("%2", mark);
}

/** Highlight ranges for anchored comments: [{ startIndex, endIndex, commentId }]. */
function splitByAnchors(text, start, anchors, activeId) {
  const marks = anchors
    .map((anchor) => ({
      from: Math.max(anchor.startIndex - start, 0),
      to: Math.min(anchor.endIndex - start, text.length),
      id: anchor.commentId,
    }))
    .filter((anchor) => anchor.to > anchor.from)
    .sort((a, b) => a.from - b.from);
  const pieces = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.from < cursor) continue;
    if (mark.from > cursor) pieces.push({ text: text.slice(cursor, mark.from) });
    pieces.push({ text: text.slice(mark.from, mark.to), commentId: mark.id, active: mark.id === activeId });
    cursor = mark.to;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor) });
  return pieces.length > 0 ? pieces : [{ text }];
}

function renderRuns(target, paragraph, options) {
  const runs = (paragraph.elements ?? []).filter((element) => element.textRun);
  let wrote = false;
  runs.forEach((element, index) => {
    let content = element.textRun.content ?? "";
    if (index === runs.length - 1 && content.endsWith("\n")) content = content.slice(0, -1);
    if (content.length === 0) return;
    const anchors = options.anchors ?? [];
    const relevant = anchors.filter((anchor) => anchor.endIndex > element.startIndex && anchor.startIndex < element.endIndex);
    const pieces = relevant.length > 0 ? splitByAnchors(content, element.startIndex, relevant, options.activeComment) : [{ text: content }];
    for (const piece of pieces) {
      const span = el("span", { text: piece.text });
      applyTextStyle(span, element.textRun.textStyle);
      if (piece.commentId) {
        span.classList.add("d-anchored");
        if (piece.active) span.classList.add("active");
        span.dataset.commentId = piece.commentId;
      }
      target.append(span);
      wrote = true;
    }
  });
  if (!wrote) target.append(document.createElement("br"));
}

function renderParagraph(element, options, counters) {
  const paragraph = element.paragraph;
  const style = paragraph.paragraphStyle ?? {};
  const named = style.namedStyleType ?? "NORMAL_TEXT";
  const block = el("p", {
    class: `d-p ${STYLE_CLASS[named] ?? ""} ${ALIGN_CLASS[style.alignment] ?? ""}`.trim(),
    attrs: {
      "data-start": element.startIndex,
      "data-end": element.endIndex,
      "data-style": named,
      role: "textbox",
    },
  });
  if (style.indentStart?.magnitude) block.style.marginLeft = `${(style.indentStart.magnitude * 4) / 3}px`;
  if (style.lineSpacing) block.style.lineHeight = String((style.lineSpacing / 100) * 1.5);
  if (options.editable) {
    block.setAttribute("contenteditable", "true");
    block.setAttribute("spellcheck", "false");
  }
  renderRuns(block, paragraph, options);

  if (!paragraph.bullet) {
    counters.lastList = null;
    return block;
  }
  const bullet = paragraph.bullet;
  const key = `${bullet.listId}:${bullet.nestingLevel ?? 0}`;
  counters.ordinals[key] = counters.lastList === bullet.listId ? (counters.ordinals[key] ?? 0) + 1 : 1;
  counters.lastList = bullet.listId;
  const row = el("div", { class: `d-bullet lvl${bullet.nestingLevel ?? 0}` });
  row.append(el("span", { class: "d-glyph", text: glyphFor(options.lists, bullet, counters.ordinals[key]) }), block);
  return row;
}

function renderTable(element, options, counters) {
  const table = el("table", { class: "d-table", attrs: { "data-start": element.startIndex, "data-end": element.endIndex } });
  const body = el("tbody");
  (element.table.tableRows ?? []).forEach((row, rowIndex) => {
    const tr = el("tr");
    (row.tableCells ?? []).forEach((cell, columnIndex) => {
      const td = el("td", {
        attrs: {
          "data-row": rowIndex,
          "data-column": columnIndex,
          "data-table-start": element.startIndex,
        },
      });
      for (const child of cell.content ?? []) {
        if (child.paragraph) td.append(renderParagraph(child, options, counters));
      }
      tr.append(td);
    });
    body.append(tr);
  });
  table.append(body);
  return table;
}

/**
 * Render `document.body.content` into `target`.
 * options: { editable, anchors: [{startIndex,endIndex,commentId}], activeComment, lists }
 */
export function renderBody(target, docResource, options = {}) {
  const settings = { ...options, lists: docResource.lists ?? {} };
  const counters = { ordinals: {}, lastList: null };
  target.replaceChildren();
  let visible = 0;
  for (const element of docResource.body?.content ?? []) {
    if (element.sectionBreak) continue;
    if (element.paragraph) {
      const hasPageBreak = (element.paragraph.elements ?? []).some((child) => child.pageBreak);
      target.append(renderParagraph(element, settings, counters));
      if (hasPageBreak) target.append(el("hr", { class: "d-pagebreak" }));
      visible += 1;
      continue;
    }
    if (element.table) {
      target.append(renderTable(element, settings, counters));
      counters.lastList = null;
      visible += 1;
    }
  }
  if (visible === 0) target.append(el("p", { class: "d-empty-note", text: "This document is empty." }));
}

/** Headings, in order, for the outline pane. */
export function outlineEntries(docResource) {
  const entries = [];
  for (const element of docResource.body?.content ?? []) {
    const named = element.paragraph?.paragraphStyle?.namedStyleType;
    if (!named || !/^(TITLE|HEADING_[1-6])$/.test(named)) continue;
    const text = paragraphText(element.paragraph).trim();
    if (text.length === 0) continue;
    entries.push({ text, level: named === "TITLE" ? 1 : Number(named.slice(-1)), startIndex: element.startIndex });
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Selection ⇄ document index
// ---------------------------------------------------------------------------------------------

/** Length in UTF-16 code units of the text before `node`/`offset` inside `block`. */
function offsetWithin(block, node, offset) {
  if (node === block) {
    // Offset counts child nodes, not characters.
    let total = 0;
    for (let index = 0; index < offset && index < block.childNodes.length; index += 1) {
      total += block.childNodes[index].textContent?.length ?? 0;
    }
    return total;
  }
  let total = 0;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (current === node) return total + offset;
    total += current.data.length;
    current = walker.nextNode();
  }
  return total;
}

const blockOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.("[data-start][contenteditable], p[data-start]");

/** The document index of one (node, offset) pair, or null when it is outside the page. */
export function indexAt(node, offset) {
  const block = blockOf(node);
  if (!block) return null;
  return Number(block.dataset.start) + offsetWithin(block, node, offset);
}

/** The current selection as a document range, or null. `collapsed` marks a caret. */
export function selectionRange(container) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;
  const start = indexAt(range.startContainer, range.startOffset);
  const end = indexAt(range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  return { startIndex: low, endIndex: high, collapsed: low === high, block: blockOf(range.startContainer) };
}

/** The editable block that holds `index`, if any. */
export function blockAt(container, index) {
  for (const block of container.querySelectorAll("p[data-start]")) {
    const start = Number(block.dataset.start);
    const end = Number(block.dataset.end);
    if (index >= start && index < end) return block;
  }
  return null;
}

/** The (text node, offset) pair for a document index, or null when it is outside the rendered body. */
function locate(container, index) {
  const block = blockAt(container, index) ?? container.querySelector("p[data-start]");
  if (!block) return null;
  const wanted = Math.max(0, Math.min(index - Number(block.dataset.start), block.textContent.length));
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let node = walker.nextNode();
  while (node) {
    if (seen + node.data.length >= wanted) return { node, offset: wanted - seen, block };
    seen += node.data.length;
    node = walker.nextNode();
  }
  return { node: block, offset: block.childNodes.length, block };
}

/** Select a document range again after a re-render, so a formatting action keeps its highlight. */
export function selectIndexRange(container, startIndex, endIndex) {
  const from = locate(container, startIndex);
  const to = locate(container, endIndex);
  if (!from || !to) return false;
  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    return false;
  }
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** Put the caret at a document index, scrolling it into view. */
export function placeCaret(container, index) {
  const block = blockAt(container, index) ?? container.querySelector("p[data-start]");
  if (!block) return false;
  const wanted = Math.max(0, Math.min(index - Number(block.dataset.start), block.textContent.length));
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let node = walker.nextNode();
  const selection = window.getSelection();
  const range = document.createRange();
  while (node) {
    if (seen + node.data.length >= wanted) {
      range.setStart(node, wanted - seen);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      block.focus?.({ preventScroll: true });
      return true;
    }
    seen += node.data.length;
    node = walker.nextNode();
  }
  range.selectNodeContents(block);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  block.focus?.({ preventScroll: true });
  return true;
}

/** Do not split a surrogate pair when diffing text. */
function safePrefix(a, b) {
  let index = 0;
  const limit = Math.min(a.length, b.length);
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  if (index > 0 && index < a.length && a.charCodeAt(index - 1) >= 0xd800 && a.charCodeAt(index - 1) <= 0xdbff) index -= 1;
  return index;
}

/**
 * The smallest replacement that turns `before` into `after`, as UTF-16 offsets inside the paragraph:
 * { at, removed, inserted } — or null when the two are equal.
 */
export function diffText(before, after) {
  if (before === after) return null;
  const prefix = safePrefix(before, after);
  let suffix = 0;
  const maxSuffix = Math.min(before.length - prefix, after.length - prefix);
  while (
    suffix < maxSuffix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) suffix += 1;
  if (suffix > 0) {
    const code = before.charCodeAt(before.length - suffix);
    if (code >= 0xdc00 && code <= 0xdfff) suffix -= 1;
  }
  return {
    at: prefix,
    removed: before.length - prefix - suffix,
    inserted: after.slice(prefix, after.length - suffix),
  };
}
