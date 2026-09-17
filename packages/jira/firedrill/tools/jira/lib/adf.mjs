// Atlassian Document Format helpers: plain text → minimal document, structural validation, and
// text extraction (used by JQL `~` matching). Marks, mentions and media are stored untouched.

import { isPlainObject } from "./state.mjs";

/** One paragraph holding the given text (an empty string yields an empty document). */
export function textToAdf(text) {
  const content = text.length === 0 ? [] : [{ type: "paragraph", content: [{ type: "text", text }] }];
  return { type: "doc", version: 1, content };
}

const MAX_DEPTH = 32;

function validNode(node, depth) {
  if (!isPlainObject(node) || typeof node.type !== "string" || node.type.length === 0) return false;
  if (depth > MAX_DEPTH) return false;
  if (node.type === "text" && typeof node.text !== "string") return false;
  if (node.content !== undefined) {
    if (!Array.isArray(node.content)) return false;
    for (const child of node.content) if (!validNode(child, depth + 1)) return false;
  }
  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks)) return false;
    for (const mark of node.marks) if (!isPlainObject(mark) || typeof mark.type !== "string") return false;
  }
  return true;
}

/** Structural ADF check: a `doc` node with `version: 1` and a `content` array of valid nodes. */
export function isAdfDocument(value) {
  return isPlainObject(value) && value.type === "doc" && value.version === 1 && Array.isArray(value.content) && validNode(value, 0);
}

function collect(node, parts) {
  if (!isPlainObject(node)) return;
  if (node.type === "text" && typeof node.text === "string") parts.push(node.text);
  if (node.type === "hardBreak") parts.push("\n");
  if (Array.isArray(node.content)) {
    for (const child of node.content) collect(child, parts);
    if (node.type !== "doc" && node.type !== "text") parts.push("\n");
  }
}

/** The plain text of a document (block nodes separated by newlines); "" for null/absent. */
export function adfText(value) {
  if (!isPlainObject(value)) return "";
  const parts = [];
  collect(value, parts);
  return parts.join("").replace(/\n{2,}/g, "\n").trim();
}

/** Accepts ADF or a plain string; returns `{ doc }` or `{ error }`. Empty text is reported as empty. */
export function coerceBody(value) {
  if (typeof value === "string") {
    return value.trim().length === 0 ? { error: "empty" } : { doc: textToAdf(value) };
  }
  if (!isAdfDocument(value)) return { error: "malformed" };
  return adfText(value).length === 0 ? { error: "empty" } : { doc: value };
}
