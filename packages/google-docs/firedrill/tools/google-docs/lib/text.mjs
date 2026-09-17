// Verbalized text and the three text exports (`text/plain`, `text/markdown`, `text/html`). Pure functions over the
// stored block model. There is no renderer here: page breaks are document elements, not layout, and nothing is styled
// beyond what Markdown and simple HTML can carry.

import { paragraphText } from "./doc-model.mjs";

export function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** UTF-16 code units, exactly what Docs counts for indices. */
export function utf16Length(text) {
  return text.length;
}

function cellText(cell) {
  return cell.blocks.map((paragraph) => paragraphText(paragraph)).join(" ").trim();
}

/** The document as plain text: what Google's `read_doc` calls the verbalized content. */
export function verbalize(blocks) {
  const lines = [];
  for (const block of blocks) {
    if (block.kind === "paragraph") lines.push(paragraphText(block));
    else if (block.kind === "table") {
      for (const row of block.cells) lines.push(row.map(cellText).join("\t"));
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

const HEADING_PREFIX = {
  TITLE: "# ",
  SUBTITLE: "## ",
  HEADING_1: "# ",
  HEADING_2: "## ",
  HEADING_3: "### ",
  HEADING_4: "#### ",
  HEADING_5: "##### ",
  HEADING_6: "###### ",
};

function markdownRun(element) {
  if (element.type === "pageBreak") return "";
  let text = element.text;
  if (text.length === 0) return "";
  const style = element.style ?? {};
  if (style.bold === true) text = `**${text}**`;
  if (style.italic === true) text = `*${text}*`;
  if (style.strikethrough === true) text = `~~${text}~~`;
  if (typeof style.linkUrl === "string") text = `[${text}](${style.linkUrl})`;
  return text;
}

function markdownParagraph(paragraph, lists) {
  const inline = paragraph.elements.map(markdownRun).join("");
  if (paragraph.bullet !== undefined) {
    const list = lists.find((entry) => entry.listId === paragraph.bullet.listId);
    const marker = list !== undefined && list.bulletPreset.startsWith("NUMBERED") ? "1." : "-";
    return `${"  ".repeat(paragraph.bullet.nestingLevel)}${marker} ${inline}`;
  }
  const prefix = HEADING_PREFIX[paragraph.style?.namedStyleType ?? "NORMAL_TEXT"] ?? "";
  return `${prefix}${inline}`;
}

export function toMarkdown(blocks, lists) {
  const chunks = [];
  for (const block of blocks) {
    if (block.kind === "paragraph") chunks.push(markdownParagraph(block, lists));
    else if (block.kind === "table") {
      const rows = block.cells.map((row) => `| ${row.map((cell) => cellText(cell).replaceAll("|", "\\|")).join(" | ")} |`);
      const separator = `| ${block.cells[0].map(() => "---").join(" | ")} |`;
      chunks.push([rows[0], separator, ...rows.slice(1)].join("\n"));
    }
  }
  return chunks.length === 0 ? "" : `${chunks.join("\n\n")}\n`;
}

function htmlRun(element) {
  if (element.type === "pageBreak") return '<hr style="page-break-after:always">';
  let text = escapeHtml(element.text);
  if (text.length === 0) return "";
  const style = element.style ?? {};
  if (style.bold === true) text = `<b>${text}</b>`;
  if (style.italic === true) text = `<i>${text}</i>`;
  if (style.underline === true) text = `<u>${text}</u>`;
  if (style.strikethrough === true) text = `<s>${text}</s>`;
  if (style.baselineOffset === "SUPERSCRIPT") text = `<sup>${text}</sup>`;
  if (style.baselineOffset === "SUBSCRIPT") text = `<sub>${text}</sub>`;
  if (typeof style.linkUrl === "string") text = `<a href="${escapeHtml(style.linkUrl)}">${text}</a>`;
  return text;
}

const HTML_TAG = {
  TITLE: "h1",
  SUBTITLE: "h2",
  HEADING_1: "h1",
  HEADING_2: "h2",
  HEADING_3: "h3",
  HEADING_4: "h4",
  HEADING_5: "h5",
  HEADING_6: "h6",
  NORMAL_TEXT: "p",
};

export function toHtml(title, blocks, lists) {
  const parts = [];
  let openList = null;
  const closeList = () => {
    if (openList !== null) {
      parts.push(`</${openList}>`);
      openList = null;
    }
  };
  for (const block of blocks) {
    if (block.kind === "paragraph") {
      const inline = block.elements.map(htmlRun).join("");
      if (block.bullet !== undefined) {
        const list = lists.find((entry) => entry.listId === block.bullet.listId);
        const tag = list !== undefined && list.bulletPreset.startsWith("NUMBERED") ? "ol" : "ul";
        if (openList !== tag) {
          closeList();
          parts.push(`<${tag}>`);
          openList = tag;
        }
        parts.push(`<li>${inline}</li>`);
        continue;
      }
      closeList();
      const tag = HTML_TAG[block.style?.namedStyleType ?? "NORMAL_TEXT"] ?? "p";
      parts.push(`<${tag}>${inline}</${tag}>`);
      continue;
    }
    if (block.kind === "table") {
      closeList();
      const rows = block.cells
        .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cellText(cell))}</td>`).join("")}</tr>`)
        .join("");
      parts.push(`<table>${rows}</table>`);
    }
  }
  closeList();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${parts.join("")}</body></html>`;
}

export function renderExport(mimeType, title, blocks, lists) {
  if (mimeType === "text/plain") return verbalize(blocks);
  if (mimeType === "text/markdown") return toMarkdown(blocks, lists);
  return toHtml(title, blocks, lists);
}

/** UTF-8 byte length without Node built-ins; used for the export byte count. */
export function utf8ByteLength(text) {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * UTF-8 byte length of `JSON.stringify(value)` — the encoded size of a JSON response body. Counted on UTF-16 code units:
 * a surrogate pair is one 4-byte code point, and `JSON.stringify` escapes lone surrogates as ASCII `\uXXXX`, so every
 * remaining unit below U+D800 or above U+DFFF is 1, 2 or 3 bytes.
 */
export function jsonByteLength(value) {
  const text = JSON.stringify(value);
  if (typeof text !== "string") return 0;
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
