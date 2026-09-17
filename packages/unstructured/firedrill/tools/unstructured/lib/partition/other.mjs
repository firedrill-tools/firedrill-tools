// XML and pre-partitioned JSON documents (e-mail lives in email.mjs).
import { ELEMENT_TYPES, MAX_TEXT, stringsBytes, valuesBytes } from "./elements.mjs";
import { MAX_DEPTH } from "./html.mjs";
import { tokenize } from "./html-tokens.mjs";
import { emitPlainBlocks } from "./text.mjs";
import { shapeProblem } from "../wire.mjs";

export function partitionXml(builder, text, keepTags) {
  const stack = [];
  let leafText = [];
  let leafOpen = null;
  const emitLeaf = () => {
    const leaf = leafText.join("").trim();
    leafText = [];
    if (leaf.length === 0) return undefined;
    if (keepTags) builder.add("UncategorizedText", `<${leafOpen}>${leaf}</${leafOpen}>`);
    else if (!emitPlainBlocks(builder, leaf)) return "File has too many text blocks";
    return builder.overflow ? "File has too many text blocks" : undefined;
  };
  const visit = (token) => {
    if (token.kind === "open") {
      if (leafOpen !== null && !keepTags) {
        const problem = emitLeaf();
        if (problem !== undefined) return problem;
      }
      leafText = [];
      if (!token.selfClosing) {
        stack.push(token.name);
        if (stack.length > MAX_DEPTH) return `File is not a valid xml: elements nested deeper than ${MAX_DEPTH} levels`;
        leafOpen = token.name;
      }
      return undefined;
    }
    if (token.kind === "close") {
      if (stack.length === 0 || stack[stack.length - 1] !== token.name) return "File is not a valid xml";
      stack.pop();
      const problem = leafOpen === token.name ? emitLeaf() : undefined;
      leafText = [];
      leafOpen = null;
      return problem;
    }
    leafText.push(token.text);
    return undefined;
  };
  const result = tokenize(text, visit);
  if (result.error !== undefined) return { ok: false, message: result.error === "File is not valid html" ? "File is not a valid xml" : result.error };
  if (stack.length > 0) return { ok: false, message: "File is not a valid xml" };
  return { ok: true };
}

const SCHEMA_MESSAGE = "Json schema does not match the Unstructured schema";

/** Pre-partitioned Unstructured JSON: elements are returned as given (ids regenerated when absent). */
export function partitionJson(builder, text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: "INVALID_REQUEST", message: SCHEMA_MESSAGE };
  }
  if (!Array.isArray(value) || value.length > 100000 || shapeProblem(value) !== null) return { ok: false, code: "INVALID_REQUEST", message: SCHEMA_MESSAGE };
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return { ok: false, code: "INVALID_REQUEST", message: SCHEMA_MESSAGE };
    if (typeof item.type !== "string" || !ELEMENT_TYPES.has(item.type) || typeof item.text !== "string" || item.text.length > MAX_TEXT) return { ok: false, code: "INVALID_REQUEST", message: SCHEMA_MESSAGE };
    if (item.element_id !== undefined && (typeof item.element_id !== "string" || item.element_id.length === 0 || item.element_id.length > 128)) return { ok: false, code: "INVALID_REQUEST", message: SCHEMA_MESSAGE };
    if (item.metadata !== undefined && (item.metadata === null || typeof item.metadata !== "object" || Array.isArray(item.metadata) || !metadataFits(item.metadata))) return { ok: false, code: "INVALID_REQUEST", message: SCHEMA_MESSAGE };
  }
  const fixed = 60 + String(builder.filename).length + String(builder.filetype).length + String(builder.lastModified).length + stringsBytes(builder.languages);
  for (const item of value) {
    if (!builder.account(fixed + item.type.length + item.text.length + 32 + (item.metadata === undefined ? 0 : valuesBytes(item.metadata)))) return { ok: true };
    const metadata = { filename: builder.filename, filetype: builder.filetype, languages: builder.languages.slice(), page_number: builder.page, last_modified: builder.lastModified };
    if (item.metadata !== undefined) copyMetadata(item.metadata, metadata);
    builder.elements.push({ type: item.type, element_id: typeof item.element_id === "string" ? item.element_id : builder.id(item.text), text: item.text, metadata });
    builder.ordinal += 1;
  }
  return { ok: true };
}

const TYPED = new Map([["filename", "string"], ["filetype", "string"], ["page_number", "integer"], ["languages", "strings"], ["category_depth", "integer"], ["parent_id", "string"], ["last_modified", "string"], ["is_continuation", "boolean"], ["text_as_html", "string"]]);
const MAX_METADATA_KEYS = 100;
const MAX_KEY = 100;
const MAX_STRING = 10000;
const MAX_ARRAY = 200;
const scalar = (v) => v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= MAX_STRING);

/** True when one caller metadata value fits the output schema for its key (typed known keys, else a scalar or a scalar array). */
function valueFits(key, value) {
  const typed = TYPED.get(key);
  if (typed === "string") return typeof value === "string" && value.length <= MAX_STRING;
  if (typed === "integer") return Number.isInteger(value) && value >= 0;
  if (typed === "boolean") return typeof value === "boolean";
  if (typed === "strings") return Array.isArray(value) && value.length <= 50 && value.every((v) => typeof v === "string" && v.length <= 100);
  return scalar(value) || (Array.isArray(value) && value.length <= MAX_ARRAY && value.every(scalar));
}

/**
 * True when every caller metadata entry can be returned as given: at most 100 keys of at most 100 characters, none named
 * `__proto__`/`constructor`/`prototype`, typed known keys with their type, other values scalars (strings ≤ 10,000 characters)
 * or arrays of at most 200 scalars. A metadata object that does not fit fails the whole upload (400 schema mismatch);
 * nothing is dropped from one that does.
 */
function metadataFits(source) {
  const keys = Object.keys(source);
  if (keys.length > MAX_METADATA_KEYS) return false;
  for (const key of keys) {
    if (key === "__proto__" || key === "constructor" || key === "prototype" || key.length > MAX_KEY) return false;
    if (!valueFits(key, source[key])) return false;
  }
  return true;
}

/** Copies caller metadata (already checked by `metadataFits`) onto the element metadata; arrays are copied, nothing is cut. */
function copyMetadata(source, target) {
  for (const key of Object.keys(source)) {
    const value = source[key];
    target[key] = Array.isArray(value) ? value.slice() : value;
  }
}
