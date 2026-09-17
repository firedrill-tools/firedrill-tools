// Blocks: request validation (types, nesting), the ordered tree under a page or block, appends with
// `after`, trash/restore of subtrees and the bookkeeping Notion does (positions, has_children, page
// last_edited_*). Stored content lives under the fixed `content` key; rendering puts it under `[type]`.
import { nextId } from "./ids.mjs";
import { COLORS, normalizeRichText } from "./rich-text.mjs";
import { jsonBytes, REQUEST_CONTENT_BYTES } from "./size.mjs";
import { allRows, shown, validationError, withinBudget } from "./state.mjs";

export const TEXT_BLOCK_TYPES = Object.freeze([
  "paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "toggle", "quote", "callout", "code",
]);
export const APPENDABLE_BLOCK_TYPES = Object.freeze([...TEXT_BLOCK_TYPES, "divider", "bookmark", "image"]);
export const BLOCK_TYPES = Object.freeze([...APPENDABLE_BLOCK_TYPES, "child_page", "child_database"]);
export const CONTAINER_TYPES = Object.freeze(["paragraph", "bulleted_list_item", "numbered_list_item", "to_do", "toggle", "quote", "callout"]);
/** Nesting levels one request may add below its top-level blocks (Notion's documented limit). */
export const MAX_DEPTH = 2;
/**
 * Deepest stored block below a page: a top-level block is level 1. Appends that would go deeper fail with a
 * validation error, so every walk over a stored tree (render, parse of the rendered markdown, trash, parent
 * lookup) is bounded and never recurses on caller-built depth.
 */
export const MAX_TREE_LEVELS = 64;
const HEADINGS = ["heading_1", "heading_2", "heading_3"];
const CODE_LANGUAGES = Object.freeze([
  "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "c++", "c#", "css", "dart", "diff", "docker", "elixir", "elm", "erlang",
  "flow", "fortran", "f#", "gherkin", "glsl", "go", "graphql", "groovy", "haskell", "html", "java", "javascript", "json", "julia", "kotlin",
  "latex", "less", "lisp", "livescript", "lua", "makefile", "markdown", "markup", "matlab", "mermaid", "nix", "objective-c", "ocaml", "pascal",
  "perl", "php", "plain text", "powershell", "prolog", "protobuf", "python", "r", "reason", "ruby", "rust", "sass", "scala", "scheme", "scss",
  "shell", "sql", "swift", "typescript", "vb.net", "verilog", "vhdl", "visual basic", "webassembly", "xml", "yaml", "java/c/c++/c#",
]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function color(context, value, path) {
  if (value === undefined) return "default";
  if (!COLORS.includes(value)) return validationError(context, `body failed validation: body.${path}.color should be a valid color, instead was \`${shown(value)}\`.`);
  return value;
}

function emojiIcon(context, value, path) {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || value.type !== "emoji" || typeof value.emoji !== "string" || value.emoji.length === 0) {
    return validationError(context, `body failed validation: body.${path}.icon should be an emoji icon ({ type: "emoji", emoji }).`);
  }
  return { type: "emoji", emoji: value.emoji };
}

/** Validate the content object of one block type; returns the stored `content`. */
/** Validated block content, bounded by the bytes it renders to so one block always fits one response. */
export function normalizeContent(context, type, raw, path) {
  const content = contentOf(context, type, raw, path);
  return withinBudget(context, content, `body.${path.length > 0 ? `${path}.` : ""}${type}`);
}

function contentOf(context, type, raw, path) {
  const body = raw === undefined ? {} : raw;
  if (!isObject(body)) return validationError(context, `body failed validation: body.${path}.${type} should be an object.`);
  if (TEXT_BLOCK_TYPES.includes(type)) {
    const richText = normalizeRichText(context, body.rich_text ?? [], `${path}.${type}.rich_text`);
    if (type === "code") {
      const language = body.language ?? "plain text";
      if (!CODE_LANGUAGES.includes(language)) return validationError(context, `body failed validation: body.${path}.code.language should be a supported language, instead was \`${shown(language)}\`.`);
      return { rich_text: richText, caption: normalizeRichText(context, body.caption ?? [], `${path}.code.caption`), language };
    }
    const content = { rich_text: richText, color: color(context, body.color, `${path}.${type}`) };
    if (type === "to_do") {
      if (body.checked !== undefined && typeof body.checked !== "boolean") return validationError(context, `body failed validation: body.${path}.to_do.checked should be a boolean.`);
      content.checked = body.checked === true;
    }
    if (HEADINGS.includes(type)) {
      if (body.is_toggleable !== undefined && typeof body.is_toggleable !== "boolean") return validationError(context, `body failed validation: body.${path}.${type}.is_toggleable should be a boolean.`);
      content.is_toggleable = body.is_toggleable === true;
    }
    if (type === "callout") content.icon = emojiIcon(context, body.icon, `${path}.callout`);
    return content;
  }
  if (type === "divider") return {};
  if (type === "bookmark") {
    if (typeof body.url !== "string" || body.url.length === 0) return validationError(context, `body failed validation: body.${path}.bookmark.url should be a non-empty string.`);
    return { url: body.url, caption: normalizeRichText(context, body.caption ?? [], `${path}.bookmark.caption`) };
  }
  if (type === "image") {
    if (body.type !== undefined && body.type !== "external") return validationError(context, `body failed validation: body.${path}.image.type should be "external" (file uploads are not supported).`);
    if (!isObject(body.external) || typeof body.external.url !== "string" || body.external.url.length === 0) {
      return validationError(context, `body failed validation: body.${path}.image.external.url should be a non-empty string.`);
    }
    return { type: "external", external: { url: body.external.url }, caption: normalizeRichText(context, body.caption ?? [], `${path}.image.caption`) };
  }
  return validationError(context, `body failed validation: body.${path}.type should be one of ${APPENDABLE_BLOCK_TYPES.join(", ")}, instead was \`${type}\`.`);
}

/** The declared validation error for `children` below `itemPath` that exceed the per-request nesting limit. */
export function nestingError(context, itemPath) {
  return validationError(context, `body failed validation: body.${itemPath}.children nests blocks deeper than ${MAX_DEPTH} levels in one request.`);
}

/** Validate an array of block request objects (nested `children` up to two levels below the top). */
export function normalizeBlockInputs(context, raw, path, depth = 0, budget = { bytes: 0 }) {
  if (!Array.isArray(raw)) return validationError(context, `body failed validation: body.${path} should be an array.`);
  const inputs = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    const itemPath = `${path}[${index}]`;
    if (!isObject(item)) return validationError(context, `body failed validation: body.${itemPath} should be an object.`);
    const type = typeof item.type === "string" ? item.type : BLOCK_TYPES.find((candidate) => item[candidate] !== undefined);
    if (type === undefined) return validationError(context, `body failed validation: body.${itemPath}.type should be defined, instead was \`undefined\`.`);
    if (!APPENDABLE_BLOCK_TYPES.includes(type)) {
      return validationError(context, `body failed validation: body.${itemPath}.type should be one of ${APPENDABLE_BLOCK_TYPES.join(", ")}, instead was \`${type}\`.`);
    }
    const content = normalizeContent(context, type, item[type], itemPath);
    budget.bytes += jsonBytes(content);
    if (budget.bytes > REQUEST_CONTENT_BYTES) {
      return validationError(context, `body failed validation: body.${path} adds more than ${REQUEST_CONTENT_BYTES} bytes of rendered block content in one request (at body.${itemPath}).`);
    }
    let children = [];
    const nested = item.children ?? (isObject(item[type]) ? item[type].children : undefined);
    if (nested !== undefined) {
      if (!CONTAINER_TYPES.includes(type)) return validationError(context, `body failed validation: body.${itemPath}.children is not supported for ${type} blocks.`);
      if (depth + 1 > MAX_DEPTH) return nestingError(context, itemPath);
      children = normalizeBlockInputs(context, nested, `${itemPath}.children`, depth + 1, budget);
    }
    inputs.push({ type, content, children });
  }
  return inputs;
}

export function parentKey(parent) {
  return parent.page_id ?? parent.block_id ?? parent.data_source_id ?? parent.database_id;
}

/**
 * Every block row of one operation, indexed once: `byId` (row id → mutable row copy) and `byParent` (parent id → rows
 * under it). Lookups and child listings cost the size of one sibling list, never a scan of every block row, so an
 * operation touching n blocks stays O(n log n) however many (trashed) rows the workspace holds.
 */
export function indexBlocks(list) {
  const index = { byId: new Map(), byParent: new Map() };
  for (const row of list) addBlockRow(index, row);
  return index;
}

export function addBlockRow(index, row) {
  index.byId.set(row.id, row);
  const key = parentKey(row.parent);
  const siblings = index.byParent.get(key);
  if (siblings === undefined) index.byParent.set(key, [row]);
  else siblings.push(row);
}

export function removeBlockRow(index, id) {
  const row = index.byId.get(id);
  if (row === undefined) return;
  index.byId.delete(id);
  const siblings = index.byParent.get(parentKey(row.parent));
  const at = siblings === undefined ? -1 : siblings.indexOf(row);
  if (at >= 0) siblings.splice(at, 1);
}

const byPosition = (left, right) => left.position - right.position || (left.id < right.id ? -1 : 1);

/** Live (non-trashed) children of a page or block in position order. `rows` = the operation's block index. */
export function childrenOf(rows, parentId, includeTrashed = false) {
  const siblings = rows.byParent.get(parentId);
  if (siblings === undefined) return [];
  return (includeTrashed ? siblings.slice() : siblings.filter((block) => !block.in_trash)).sort(byPosition);
}

/** Position for a block appended after every live child of `parentId`. */
export function nextPosition(rows, parentId) {
  let last = -1;
  for (const block of rows.byParent.get(parentId) ?? []) if (!block.in_trash && block.position > last) last = block.position;
  return last + 1;
}

function hasLiveChildren(rows, parentId) {
  for (const block of rows.byParent.get(parentId) ?? []) if (!block.in_trash) return true;
  return false;
}

/**
 * Give `ordered` (live siblings in their new order) the gapless positions 0..n-1, writing only rows whose position
 * changes. Trashed siblings keep their last position and are never rewritten, so repeated replaces do not grow the work.
 */
export function placeInOrder(context, ordered) {
  ordered.forEach((block, position) => {
    if (block.position === position) return;
    block.position = position;
    const stored = context.state.get("blocks", block.id);
    if (stored !== null) context.state.put("blocks", block.id, { ...stored, position });
  });
}

/** The page containing a block (walking block parents). */
export function pageOfBlock(context, block) {
  let current = block;
  for (let depth = 0; depth < MAX_TREE_LEVELS; depth += 1) {
    if (current.parent.type === "page_id") return current.parent.page_id;
    const next = context.state.get("blocks", current.parent.block_id);
    if (next === null) return undefined;
    current = next;
  }
  return undefined;
}

/** Level of a stored block below its page (a top-level block is 1); at most MAX_TREE_LEVELS + 1 lookups. */
export function blockLevel(context, block) {
  let current = block;
  let level = 1;
  while (current.parent.type === "block_id" && level <= MAX_TREE_LEVELS) {
    const next = context.state.get("blocks", current.parent.block_id);
    if (next === null) break;
    current = next;
    level += 1;
  }
  return level;
}

/** Levels a validated request adds below its top-level blocks (0 when none has children; at most MAX_DEPTH). */
export function requestDepth(inputs) {
  let deepest = 0;
  for (const input of inputs) if (input.children.length > 0) deepest = Math.max(deepest, 1 + requestDepth(input.children));
  return deepest;
}

export function touchPage(context, pageId, now, authorId) {
  const page = context.state.get("pages", pageId);
  if (page === null) return;
  context.state.put("pages", pageId, { ...page, last_edited_time: now, last_edited_by: { object: "user", id: authorId } });
}

function setHasChildren(context, rows, parentBlockId) {
  const parent = context.state.get("blocks", parentBlockId);
  if (parent === null) return;
  const hasChildren = hasLiveChildren(rows, parentBlockId);
  if (parent.has_children !== hasChildren) context.state.put("blocks", parentBlockId, { ...parent, has_children: hasChildren });
  const indexed = rows.byId.get(parentBlockId);
  if (indexed !== undefined) indexed.has_children = hasChildren;
}

/**
 * Create block rows from validated inputs under `parent` (a `{type:"page_id"}` or `{type:"block_id"}`
 * reference). `afterId` places them after that live sibling; otherwise they go last. Returns the new
 * top-level rows in order. `rows` is the operation's block index (kept in sync). One call does one sort of the live
 * siblings and writes each new row once plus the live siblings whose position actually moves.
 */
export function createBlocks(context, parent, inputs, { afterId, now, authorId, rows }) {
  const parentId = parentKey(parent);
  const siblings = childrenOf(rows, parentId);
  let insertAt = siblings.length;
  if (afterId !== undefined) {
    const index = siblings.findIndex((block) => block.id === afterId);
    if (index < 0) return validationError(context, `body failed validation: body.after should be the id of a child block of ${parentId}, instead was \`${afterId}\`.`);
    insertAt = index + 1;
  }
  const stamp = { created_time: now, last_edited_time: now, created_by: { object: "user", id: authorId }, last_edited_by: { object: "user", id: authorId } };
  const build = (blockParent, list, depth) => {
    const out = [];
    list.forEach((input, index) => {
      const id = nextId(context, "blocks");
      const row = {
        id,
        parent: blockParent,
        type: input.type,
        content: input.content,
        position: depth === 0 ? insertAt + index : index,
        has_children: input.children.length > 0,
        in_trash: false,
        ...stamp,
      };
      context.state.put("blocks", id, row);
      addBlockRow(rows, row);
      out.push(row);
      if (input.children.length > 0) build({ type: "block_id", block_id: id }, input.children, depth + 1);
    });
    return out;
  };
  const created = build(parent, inputs, 0);
  placeInOrder(context, [...siblings.slice(0, insertAt), ...created, ...siblings.slice(insertAt)]);
  if (parent.type === "block_id") setHasChildren(context, rows, parent.block_id);
  return created;
}

/** Mark every block below `parentId` (and the pages/databases they embed) as trashed or restored. */
export function setSubtreeTrashed(context, rows, parentId, trashed, now, authorId, visited = new Set()) {
  for (const block of childrenOf(rows, parentId, true)) {
    if (visited.has(block.id)) continue;
    visited.add(block.id);
    if (block.in_trash !== trashed) {
      const updated = { ...block, in_trash: trashed, last_edited_time: now, last_edited_by: { object: "user", id: authorId } };
      context.state.put("blocks", block.id, updated);
      Object.assign(block, updated);
    }
    if (block.type === "child_page") setPageTrashed(context, rows, block.id, trashed, now, authorId, visited);
    else if (block.type === "child_database") setDatabaseTrashed(context, rows, block.id, trashed, now, authorId, visited);
    else setSubtreeTrashed(context, rows, block.id, trashed, now, authorId, visited);
  }
}

/** The child_page / child_database block that represents an object in its parent page shares its id. */
function setRepresentingBlockTrashed(context, rows, id, trashed, now, authorId) {
  const block = context.state.get("blocks", id);
  if (block === null || block.in_trash === trashed) return;
  const updated = { ...block, in_trash: trashed, last_edited_time: now, last_edited_by: { object: "user", id: authorId } };
  context.state.put("blocks", id, updated);
  const stored = rows.byId.get(id);
  if (stored !== undefined) Object.assign(stored, updated);
}

export function setPageTrashed(context, rows, pageId, trashed, now, authorId, visited = new Set()) {
  const page = context.state.get("pages", pageId);
  if (page === null) return;
  if (page.in_trash !== trashed) {
    context.state.put("pages", pageId, { ...page, in_trash: trashed, last_edited_time: now, last_edited_by: { object: "user", id: authorId } });
  }
  setRepresentingBlockTrashed(context, rows, pageId, trashed, now, authorId);
  setSubtreeTrashed(context, rows, pageId, trashed, now, authorId, visited);
}

export function setDataSourceTrashed(context, rows, sourceId, trashed, now, authorId, visited = new Set()) {
  const source = context.state.get("data-sources", sourceId);
  if (source === null) return;
  if (source.in_trash !== trashed) {
    context.state.put("data-sources", sourceId, { ...source, in_trash: trashed, last_edited_time: now, last_edited_by: { object: "user", id: authorId } });
  }
  for (const page of allRows(context, "pages")) {
    if (page.parent.type === "data_source_id" && page.parent.data_source_id === sourceId) setPageTrashed(context, rows, page.id, trashed, now, authorId, visited);
  }
}

export function setDatabaseTrashed(context, rows, databaseId, trashed, now, authorId, visited = new Set()) {
  const database = context.state.get("databases", databaseId);
  if (database === null) return;
  if (database.in_trash !== trashed) {
    context.state.put("databases", databaseId, { ...database, in_trash: trashed, last_edited_time: now, last_edited_by: { object: "user", id: authorId } });
  }
  setRepresentingBlockTrashed(context, rows, databaseId, trashed, now, authorId);
  for (const sourceId of database.data_source_ids) setDataSourceTrashed(context, rows, sourceId, trashed, now, authorId, visited);
}

/**
 * Trash or restore one block with its descendants and fix the parent's `has_children` (skipped with
 * `{ updateParent: false }` when the caller trashes a whole sibling list and settles the parent once).
 */
export function setBlockTrashed(context, rows, block, trashed, now, authorId, { updateParent = true } = {}) {
  const updated = { ...block, in_trash: trashed, last_edited_time: now, last_edited_by: { object: "user", id: authorId } };
  context.state.put("blocks", block.id, updated);
  const stored = rows.byId.get(block.id);
  if (stored !== undefined) Object.assign(stored, updated);
  setSubtreeTrashed(context, rows, block.id, trashed, now, authorId);
  if (updateParent && block.parent.type === "block_id") setHasChildren(context, rows, block.parent.block_id);
  return updated;
}

/** Every descendant block id of a page or block (trashed ones included), depth-first in order. */
export function descendantIds(rows, parentId, out = []) {
  for (const block of childrenOf(rows, parentId, true)) {
    out.push(block.id);
    if (block.type !== "child_page" && block.type !== "child_database") descendantIds(rows, block.id, out);
  }
  return out;
}

/** Nested tree `{ block, children }` of live blocks under a page or block. */
export function blockTree(rows, parentId) {
  return childrenOf(rows, parentId).map((block) => ({
    block,
    children: block.type === "child_page" || block.type === "child_database" ? [] : blockTree(rows, block.id),
  }));
}
