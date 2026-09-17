// Deterministic markdown dialect for the page-markdown endpoints: render a block tree to markdown and
// parse markdown back into block inputs. The dialect is documented in the README; it is a subset, not
// Notion's proprietary enhanced markdown.
import { normalizeId } from "./ids.mjs";
import { defaultAnnotations, textItem } from "./rich-text.mjs";
import { MAX_DEPTH, MAX_TREE_LEVELS, nestingError } from "./blocks.mjs";
import { utf8Length } from "./size.mjs";
import { validationError } from "./state.mjs";

const LIST_TYPES = ["bulleted_list_item", "numbered_list_item", "to_do"];
/** Notion's request limit of 1000 block elements per payload, applied to every parsed markdown document. */
export const MAX_MARKDOWN_BLOCKS = 1000;
const EMOJI = /^\p{Extended_Pictographic}/u;
const UNKNOWN_TAG = /^<unknown\s+type="([a-z_]+)"\s+id="([0-9a-f-]{36})"(?:\s+url="([^"]*)")?\s*\/>$/;
const CHILD_LINK = /^\[(📄|🗃️) (.*)\]\(notion:\/\/(page|database)\/([0-9a-f-]{36})\)$/u;

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function renderInline(items) {
  let out = "";
  for (const item of items) {
    if (item.type === "mention") {
      const mention = item.mention;
      if (mention.type === "user") out += `[${item.plain_text}](notion://user/${mention.user.id})`;
      else if (mention.type === "page") out += `[${item.plain_text}](notion://page/${mention.page.id})`;
      else out += item.plain_text;
      continue;
    }
    let text = item.text.content;
    const a = item.annotations;
    if (a.code) text = `\`${text}\``;
    if (a.bold) text = `**${text}**`;
    if (a.italic) text = `*${text}*`;
    if (a.strikethrough) text = `~~${text}~~`;
    if (item.text.link !== null) text = `[${text}](${item.text.link.url})`;
    out += text;
  }
  return out;
}

function indent(text, depth) {
  if (depth === 0) return text;
  const pad = "  ".repeat(depth);
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? line : pad + line))
    .join("\n");
}

function renderNode(context, node, depth, counters, unknown) {
  const { block, children } = node;
  const content = block.content;
  const withChildren = (own) => {
    if (children.length === 0) return own;
    const rendered = renderChildren(context, children, depth + 1, unknown);
    return `${own}\n${rendered}`;
  };
  switch (block.type) {
    case "paragraph":
      return withChildren(indent(renderInline(content.rich_text), depth));
    case "heading_1":
      return indent(`# ${renderInline(content.rich_text)}`, depth);
    case "heading_2":
      return indent(`## ${renderInline(content.rich_text)}`, depth);
    case "heading_3":
      return indent(`### ${renderInline(content.rich_text)}`, depth);
    case "bulleted_list_item":
      return withChildren(indent(`- ${renderInline(content.rich_text)}`, depth));
    case "numbered_list_item": {
      const number = (counters.numbered ?? 0) + 1;
      counters.numbered = number;
      return withChildren(indent(`${number}. ${renderInline(content.rich_text)}`, depth));
    }
    case "to_do":
      return withChildren(indent(`- [${content.checked ? "x" : " "}] ${renderInline(content.rich_text)}`, depth));
    case "toggle": {
      const inner = children.length === 0 ? "" : `\n\n${renderChildren(context, children, 0, unknown)}\n`;
      return indent(`<details>\n<summary>${renderInline(content.rich_text)}</summary>${inner}\n</details>`, depth);
    }
    case "quote":
      return withChildren(indent(renderInline(content.rich_text).split("\n").map((line) => `> ${line}`).join("\n"), depth));
    case "callout": {
      const icon = content.icon === null ? "" : `${content.icon.emoji} `;
      return withChildren(indent(`> ${icon}${renderInline(content.rich_text)}`, depth));
    }
    case "code": {
      const code = content.rich_text.map((item) => item.plain_text).join("");
      return indent(`\`\`\`${content.language}\n${code}\n\`\`\``, depth);
    }
    case "divider":
      return indent("---", depth);
    case "child_page": {
      const page = context.state.get("pages", block.id);
      return indent(`[📄 ${page === null ? "" : page.title_plain}](notion://page/${block.id})`, depth);
    }
    case "child_database": {
      const database = context.state.get("databases", block.id);
      return indent(`[🗃️ ${database === null ? "" : database.title_plain}](notion://database/${block.id})`, depth);
    }
    default: {
      unknown.push(block.id);
      const url = block.type === "bookmark" ? content.url : block.type === "image" ? content.external.url : undefined;
      return indent(`<unknown type="${block.type}" id="${block.id}"${url === undefined ? "" : ` url="${url.replaceAll('"', "%22")}"`}/>`, depth);
    }
  }
}

/** Blocks separated by blank lines, except consecutive list items which stay adjacent. */
function renderChildren(context, nodes, depth, unknown) {
  const counters = { numbered: 0 };
  const parts = [];
  let previousType;
  for (const node of nodes) {
    const type = node.block.type;
    if (type !== "numbered_list_item") counters.numbered = 0;
    const separator = parts.length === 0 ? "" : LIST_TYPES.includes(type) && type === previousType ? "\n" : "\n\n";
    parts.push(separator + renderNode(context, node, depth, counters, unknown));
    previousType = type;
  }
  return parts.join("");
}

export function renderMarkdown(context, tree) {
  const unknown = [];
  const markdown = renderChildren(context, tree, 0, unknown);
  return { markdown, unknown_block_ids: unknown };
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

/** End of the `[^)\s]*` run starting at `from` (the next `)` or whitespace, or the text length). */
const URL_RUN = /[^)\s]*/y;

/**
 * Inline markup in one left-to-right pass. Every forward search result (the next `` ` ``, `]`, and `)`/whitespace)
 * is cached and only recomputed once the cursor passes it, so each character is scanned a bounded number of times:
 * `[` or `[a](` repeated 100 000 times is linear, never a per-position rescan of the tail.
 */
function parseInline(text) {
  const items = [];
  const state = { bold: false, italic: false, strikethrough: false };
  let start = 0;
  const flush = (end) => {
    if (end > start) items.push(textItem(text.slice(start, end), { annotations: { ...defaultAnnotations(), ...state } }));
  };
  let nextBacktick = -2; // -2: not searched yet; -1: none left
  let nextClose = -2;
  let stopFrom = -1;
  let stopAt = -1;
  const urlEnd = (from) => {
    if (from > stopAt || stopFrom < 0 || from < stopFrom) {
      URL_RUN.lastIndex = from;
      URL_RUN.exec(text);
      stopFrom = from;
      stopAt = URL_RUN.lastIndex;
    }
    return stopAt;
  };
  let index = 0;
  while (index < text.length) {
    const char = text.charCodeAt(index);
    if (char === 0x60 /* ` */) {
      if (nextBacktick !== -1 && nextBacktick <= index) nextBacktick = text.indexOf("`", index + 1);
      if (nextBacktick > index) {
        flush(index);
        items.push(textItem(text.slice(index + 1, nextBacktick), { annotations: { ...defaultAnnotations(), ...state, code: true } }));
        index = nextBacktick + 1;
        start = index;
        continue;
      }
    } else if (char === 0x5b /* [ */) {
      if (nextClose !== -1 && nextClose <= index) nextClose = text.indexOf("]", index + 1);
      if (nextClose > index && text.charCodeAt(nextClose + 1) === 0x28 /* ( */) {
        const urlStart = nextClose + 2;
        const end = urlEnd(urlStart);
        if (end > urlStart && text.charCodeAt(end) === 0x29 /* ) */) {
          flush(index);
          const label = text.slice(index + 1, nextClose);
          const url = text.slice(urlStart, end);
          const userId = url.startsWith("notion://user/") ? normalizeId(url.slice("notion://user/".length)) : undefined;
          const pageId = url.startsWith("notion://page/") ? normalizeId(url.slice("notion://page/".length)) : undefined;
          if (userId !== undefined) items.push({ kind: "mention", mention: { type: "user", user: { object: "user", id: userId } } });
          else if (pageId !== undefined) items.push({ kind: "mention", mention: { type: "page", page: { id: pageId } } });
          else items.push(textItem(label, { link: { url }, annotations: { ...defaultAnnotations(), ...state } }));
          index = end + 1;
          start = index;
          continue;
        }
      }
    } else if (char === 0x2a /* * */) {
      flush(index);
      if (text.charCodeAt(index + 1) === 0x2a) { state.bold = !state.bold; index += 2; } else { state.italic = !state.italic; index += 1; }
      start = index;
      continue;
    } else if (char === 0x7e /* ~ */ && text.charCodeAt(index + 1) === 0x7e) {
      flush(index);
      state.strikethrough = !state.strikethrough;
      index += 2;
      start = index;
      continue;
    }
    index += 1;
  }
  flush(text.length);
  return items;
}

function lineIndent(line) {
  const spaces = line.length - line.trimStart().length;
  return Math.floor(spaces / 2);
}

/**
 * Parse markdown lines into a list of block inputs `{ type, content, children }` (rich text left as the
 * request form `{ text: {content} }` / `{ mention }` so the normal validators run) or `{ keep: id }`
 * references to existing child pages, databases and unknown blocks.
 *
 * At most MAX_MARKDOWN_BLOCKS block elements are produced (counted as they are found, `limits.blocks`), so the
 * writes and the update_content alignment that follow are bounded too.
 *
 * `limits.depth` is the depth of the blocks produced here (0 = top level) and `limits.path` the request path of
 * the list they belong to. A container whose children would exceed `limits.maxDepth` fails with the declared
 * validation error as soon as its first child line is seen — before inner lines are copied or the parser recurses —
 * so `<details>` or indented lists repeated thousands of times cost one bounded pass, never a stack overflow.
 */
function parseLines(context, lines, limits) {
  const { depth, maxDepth, path } = limits;
  const blocks = [];
  let index = 0;
  const itemPath = () => (depth === 0 ? path : `${path}[${blocks.length}]`);
  const tooDeep = (currentPath) => {
    if (maxDepth === MAX_DEPTH) return nestingError(context, currentPath);
    return validationError(context, `body failed validation: the markdown nests blocks deeper than ${MAX_TREE_LEVELS} levels.`);
  };
  const childLimits = (currentPath) => ({ depth: depth + 1, maxDepth, path: `${currentPath}.children`, blocks: limits.blocks });
  const count = () => {
    limits.blocks.count += 1;
    if (limits.blocks.count > MAX_MARKDOWN_BLOCKS) {
      return validationError(context, `body failed validation: the markdown content should contain ≤ ${MAX_MARKDOWN_BLOCKS} block elements, instead had more.`);
    }
  };
  const push = (type, richTextSource, extra = {}) => {
    count();
    const block = { type, [type]: { ...extra, ...(richTextSource === undefined ? {} : { rich_text: richTextSource }) }, children: [] };
    blocks.push(block);
    return block;
  };
  while (index < lines.length) {
    const raw = lines[index];
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed.length === 0) { index += 1; continue; }
    if (trimmed.startsWith("```")) {
      const language = trimmed.slice(3).trim() || "plain text";
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) { code.push(lines[index]); index += 1; }
      index += 1;
      push("code", [{ text: { content: code.join("\n") } }], { language });
      continue;
    }
    if (trimmed === "<details>") {
      const currentPath = itemPath();
      let open = 1;
      const inner = [];
      index += 1;
      let summary = "";
      if (index < lines.length && lines[index].trim().startsWith("<summary>")) {
        summary = lines[index].trim().replace(/^<summary>/, "").replace(/<\/summary>$/, "");
        index += 1;
      }
      const atLimit = depth + 1 > maxDepth;
      while (index < lines.length && open > 0) {
        const current = lines[index].trim();
        if (current === "<details>") open += 1;
        if (current === "</details>") { open -= 1; if (open === 0) { index += 1; break; } }
        // Every non-blank inner line produces at least one child block.
        if (atLimit && current.length > 0) return tooDeep(currentPath);
        inner.push(lines[index]);
        index += 1;
      }
      const toggle = push("toggle", parseInline(summary));
      toggle.children = parseLines(context, inner, childLimits(currentPath));
      continue;
    }
    const unknownMatch = UNKNOWN_TAG.exec(trimmed);
    if (unknownMatch !== null) { count(); blocks.push({ keep: unknownMatch[2] }); index += 1; continue; }
    const childMatch = CHILD_LINK.exec(trimmed);
    if (childMatch !== null) { count(); blocks.push({ keep: childMatch[4] }); index += 1; continue; }
    if (trimmed === "---" || trimmed === "***") { push("divider"); index += 1; continue; }
    const heading = /^(#{1,3}) (.*)$/.exec(trimmed);
    if (heading !== null) { push(`heading_${heading[1].length}`, parseInline(heading[2])); index += 1; continue; }
    if (trimmed.startsWith(">")) {
      const quoteLines = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      const text = quoteLines.join("\n");
      const emoji = EMOJI.exec(text);
      if (emoji !== null && text.slice(emoji[0].length).startsWith(" ")) {
        push("callout", parseInline(text.slice(emoji[0].length + 1)), { icon: { type: "emoji", emoji: emoji[0] } });
      } else {
        push("quote", parseInline(text));
      }
      continue;
    }
    const listMatch = /^(\s*)(?:- \[( |x|X)\] |- |\d+\. )(.*)$/.exec(line);
    if (listMatch !== null) {
      // Collect this list item and any deeper-indented lines that belong to it.
      const currentPath = itemPath();
      const level = lineIndent(line);
      const marker = /^\s*- \[/.test(line) ? "to_do" : /^\s*- /.test(line) ? "bulleted_list_item" : "numbered_list_item";
      const extra = marker === "to_do" ? { checked: listMatch[2].toLowerCase() === "x" } : {};
      const item = push(marker, parseInline(listMatch[3]), extra);
      index += 1;
      const atLimit = depth + 1 > maxDepth;
      const nested = [];
      while (index < lines.length) {
        const next = lines[index];
        if (next.trim().length === 0) {
          // A blank line ends the item unless deeper-indented content follows.
          const lookahead = lines[index + 1];
          if (lookahead !== undefined && lookahead.trim().length > 0 && lineIndent(lookahead) > level) { nested.push(""); index += 1; continue; }
          break;
        }
        if (lineIndent(next) <= level) break;
        if (atLimit) return tooDeep(currentPath);
        nested.push(next.slice((level + 1) * 2));
        index += 1;
      }
      if (nested.length > 0) item.children = parseLines(context, nested, childLimits(currentPath));
      continue;
    }
    // Paragraph: contiguous plain lines.
    const paragraph = [trimmed];
    index += 1;
    while (index < lines.length) {
      const next = lines[index].trim();
      if (next.length === 0 || /^(#{1,3} |> |- |\d+\. |```|---$|<details>|<unknown |\[(📄|🗃️) )/u.test(next)) break;
      paragraph.push(next);
      index += 1;
    }
    push("paragraph", parseInline(paragraph.join("\n")));
  }
  return blocks;
}

/** Request-shaped rich text (so the normal validators run) from the parser's inline items. */
function toRequestRichText(items) {
  return items.map((item) => (item.kind === "mention" ? { type: "mention", mention: item.mention } : { type: "text", text: item.text, annotations: item.annotations }));
}

function toRequestBlocks(blocks) {
  return blocks.map((block) => {
    if (block.keep !== undefined) return block;
    const body = { ...block[block.type] };
    if (body.rich_text !== undefined) body.rich_text = toRequestRichText(body.rich_text);
    const result = { type: block.type, [block.type]: body };
    if (block.children.length > 0) result.children = toRequestBlocks(block.children);
    return result;
  });
}

/**
 * Parse request markdown. By default nesting is held to the per-request limit (the error names the same
 * `content[0]…children` path as a JSON append would); `{ stored: true }` parses the rendering of a page's existing
 * tree, which may be as deep as the stored-tree limit.
 */
export function parseMarkdown(context, text, maxBytes, { stored = false } = {}) {
  if (typeof text !== "string") return validationError(context, "body failed validation: the markdown content should be a string.");
  // UTF-8 bytes are never fewer than UTF-16 code units, so the cheap length check only short-circuits huge input.
  const bytes = text.length > maxBytes ? text.length : utf8Length(text);
  if (bytes > maxBytes) return validationError(context, `body failed validation: the markdown content should be ≤ ${maxBytes} bytes, instead was ${text.length > maxBytes ? `more than ${maxBytes}` : bytes}.`);
  const limits = { depth: 0, maxDepth: stored ? MAX_TREE_LEVELS - 1 : MAX_DEPTH, path: "content[0]", blocks: { count: 0 } };
  return toRequestBlocks(parseLines(context, text.replace(/\r\n/g, "\n").split("\n"), limits));
}
