// File-type detection and dispatch: one document in, { ok, elements } or { ok: false, code, message } out.
import { chunkElements } from "./chunk.mjs";
import { Builder } from "./elements.mjs";
import { partitionDelimited } from "./csv.mjs";
import { partitionHtml } from "./html.mjs";
import { partitionMarkdown } from "./markdown.mjs";
import { partitionEmail } from "./email.mjs";
import { partitionJson, partitionXml } from "./other.mjs";
import { partitionText } from "./text.mjs";
import { sha256Id } from "../sha256.mjs";
import { uuid } from "../ids.mjs";
import { utf8Length } from "../util.mjs";

const BY_EXTENSION = new Map([
  ["txt", "text/plain"], ["text", "text/plain"], ["log", "text/plain"], ["md", "text/markdown"], ["markdown", "text/markdown"], ["html", "text/html"],
  ["htm", "text/html"], ["csv", "text/csv"], ["tsv", "text/tsv"], ["json", "application/json"], ["eml", "message/rfc822"], ["xml", "application/xml"],
  ["rst", "text/x-rst"],
]);
const ALIASES = new Map([
  ["text/x-markdown", "text/markdown"], ["application/xhtml+xml", "text/html"], ["text/xml", "application/xml"], ["text/tab-separated-values", "text/tsv"],
  ["application/csv", "text/csv"], ["text/rst", "text/x-rst"], ["text/x-log", "text/plain"], ["text/json", "application/json"],
]);
export const SUPPORTED = new Set(["text/plain", "text/markdown", "text/html", "text/csv", "text/tsv", "application/json", "message/rfc822", "application/xml", "text/x-rst"]);
const BINARY_EXTENSIONS = new Map([
  ["pdf", "application/pdf"], ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], ["doc", "application/msword"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"], ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["epub", "application/epub+zip"], ["zip", "application/zip"], ["odt", "application/vnd.oasis.opendocument.text"],
]);

/** Detected media type: explicit content_type first, then the part's type, then the filename extension. Null when unknown. */
export function detectType(file, explicitType) {
  const normalise = (raw) => {
    if (typeof raw !== "string" || raw.length === 0) return null;
    const base = raw.split(";")[0].trim().toLowerCase();
    return ALIASES.get(base) ?? base;
  };
  const explicit = normalise(explicitType);
  if (explicit !== null) return explicit;
  const partType = normalise(file.content_type);
  if (partType !== null && partType !== "application/octet-stream") return partType;
  const name = typeof file.filename === "string" ? file.filename : "";
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (BY_EXTENSION.has(extension)) return BY_EXTENSION.get(extension);
  if (BINARY_EXTENSIONS.has(extension)) return BINARY_EXTENSIONS.get(extension);
  return null;
}

/** Response budget assumed when the caller passes none (`meta/limits.response_bytes` default). */
const DEFAULT_BUDGET = 921600;
const budgetOf = (options) => (typeof options.responseBudget === "number" ? options.responseBudget : DEFAULT_BUDGET);

/**
 * Byte bound for the running element-size estimate: the response budget when the elements themselves are the response
 * (unchunked JSON or CSV with a known budget), three quarters of it when every element is serialised again into
 * `orig_elements` (stored gzip never shrinks, base64 adds a third), and no bound when the chunks alone are returned.
 */
function elementBudget(options) {
  if (options.chunk === null) return typeof options.responseBudget === "number" ? options.responseBudget : Infinity;
  return options.chunk.includeOrigElements ? Math.floor((budgetOf(options) * 3) / 4) : Infinity;
}

/**
 * Partitions one text document.
 * @param file { filename, content, content_type?, last_modified? }
 * @param options { elementSizing?: { bytes } shared across the files of one request, contentType, languages, includePageBreaks, startingPage, xmlKeepTags, uniqueIds, nowIso, chunk: null | chunk options }
 * @param context Tool context (used only for UUID ids when uniqueIds)
 */
export function partitionFile(file, options, context) {
  const filetype = detectType(file, options.contentType);
  if (filetype === null || !SUPPORTED.has(filetype)) return { ok: false, code: "UNSUPPORTED_FILE_TYPE", message: `${filetype === null ? "None" : filetype} not currently supported` };
  if (file.bad_transfer === true) return { ok: false, code: "INVALID_FILE", message: "File content is not valid base64 UTF-8 text" };
  const builder = new Builder(
    {
      filename: file.filename,
      filetype,
      languages: options.languages,
      startingPage: options.startingPage,
      lastModified: typeof file.last_modified === "string" && file.last_modified.length > 0 ? file.last_modified : options.nowIso,
      includePageBreaks: options.includePageBreaks,
      sizing: options.elementSizing,
      byteBudget: elementBudget(options),
    },
    options.uniqueIds ? context : null,
  );
  const text = file.content.startsWith("﻿") ? file.content.slice(1) : file.content;
  let result;
  if (filetype === "text/plain" || filetype === "text/x-rst") result = partitionText(builder, text);
  else if (filetype === "text/markdown") result = partitionMarkdown(builder, text);
  else if (filetype === "text/html") result = partitionHtml(builder, text);
  else if (filetype === "text/csv") result = partitionDelimited(builder, text, ",");
  else if (filetype === "text/tsv") result = partitionDelimited(builder, text, "\t");
  else if (filetype === "message/rfc822") result = partitionEmail(builder, text);
  else if (filetype === "application/xml") result = partitionXml(builder, text, options.xmlKeepTags);
  else result = partitionJson(builder, text);
  if (builder.tooLarge) {
    const orig = options.chunk !== null;
    const floor = orig ? Math.ceil((builder.sizing.bytes * 4) / 3) : builder.sizing.bytes;
    return { ok: false, code: "RESPONSE_TOO_LARGE", message: `Partition output${orig ? " with orig_elements" : ""} of at least ${floor} bytes exceeds the ${budgetOf(options)} byte response limit; upload fewer or smaller files${orig ? " or set include_orig_elements=false" : ""}` };
  }
  if (!result.ok) return { ok: false, code: result.code ?? "INVALID_FILE", message: result.message };
  if (builder.overflow) return { ok: false, code: "INVALID_FILE", message: "File produces too many elements" };
  let elements = builder.elements;
  if (options.chunk !== null && options.chunk.includeOrigElements && typeof options.responseBudget === "number") {
    // Every original element lands in some chunk's `orig_elements` (stored-block gzip never shrinks, base64 adds a third),
    // so an element array whose JSON already passes three quarters of the budget cannot produce a response within it.
    // Failing here skips compressing tens of megabytes that would be discarded by the response budget anyway.
    const bytes = utf8Length(JSON.stringify(elements));
    if (bytes * 4 > options.responseBudget * 3) return { ok: false, code: "RESPONSE_TOO_LARGE", message: `Partition output with orig_elements of at least ${Math.ceil((bytes * 4) / 3)} bytes exceeds the ${options.responseBudget} byte response limit; upload fewer or smaller files or set include_orig_elements=false` };
  }
  if (options.chunk !== null) {
    let ordinal = 0;
    const idOf = (chunkText) => {
      ordinal += 1;
      return options.uniqueIds ? uuid(context) : sha256Id(file.filename, "chunk", String(ordinal), chunkText);
    };
    const chunked = chunkElements(elements, { ...options.chunk, responseBudget: options.responseBudget, chunkSizing: options.chunkSizing }, idOf);
    if (!chunked.ok) return chunked;
    elements = chunked.elements;
  }
  return { ok: true, elements, filetype };
}
