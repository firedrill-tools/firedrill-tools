// Element construction shared by every document type: ids, metadata, page tracking and the Title parent chain.
import { sha256Id } from "../sha256.mjs";
import { uuid } from "../ids.mjs";

export const MAX_TEXT = 100000;
export const MAX_ELEMENTS = 100000;

export const ELEMENT_TYPES = new Set([
  "Title", "NarrativeText", "ListItem", "UncategorizedText", "Table", "TableChunk", "CompositeElement", "Image", "Address", "EmailAddress",
  "CodeSnippet", "Header", "Footer", "PageBreak", "FigureCaption", "Formula", "PageNumber", "Text",
]);

export class Builder {
  /**
   * @param {object} doc { filename, filetype, languages, startingPage, lastModified, includePageBreaks }
   * @param {object|null} context when `unique_element_ids` is set, ids are UUIDs drawn from context.random
   */
  constructor(doc, context) {
    this.filename = doc.filename;
    this.filetype = doc.filetype;
    this.languages = doc.languages;
    this.page = doc.startingPage;
    this.lastModified = doc.lastModified;
    this.includePageBreaks = doc.includePageBreaks;
    this.context = context;
    this.elements = [];
    this.ordinal = 0;
    this.titles = [];
    this.extraMetadata = null;
    this.extraBytes = 0;
    this.overflow = false;
    // Running lower bound of the JSON (and CSV) bytes of the elements built so far, shared across the files of one request
    // when `doc.sizing` is given; passing `doc.byteBudget` stops the build (`tooLarge`) before megabytes of elements exist.
    this.sizing = doc.sizing ?? { bytes: 0 };
    this.byteBudget = typeof doc.byteBudget === "number" ? doc.byteBudget : Infinity;
    this.tooLarge = false;
    this.fixedBytes = 60 + String(doc.filename).length + String(doc.filetype).length + String(doc.lastModified).length + stringsBytes(doc.languages);
  }

  /** E-mail metadata copied onto every element; its size is measured once. */
  setExtraMetadata(extra) {
    this.extraMetadata = extra;
    this.extraBytes = valuesBytes(extra);
  }

  /** Adds `bytes` to the running size; false (and `tooLarge`, `overflow`) once the byte budget is passed. */
  account(bytes) {
    this.sizing.bytes += bytes;
    if (this.sizing.bytes <= this.byteBudget) return true;
    this.tooLarge = true;
    this.overflow = true;
    return false;
  }

  id(text) {
    if (this.context !== null) return uuid(this.context);
    return sha256Id(this.filename, String(this.page), String(this.ordinal), text);
  }

  /** Appends one element; text longer than MAX_TEXT is split into continuation elements. */
  add(type, text, meta = {}) {
    if (this.overflow) return;
    const pieces = [];
    const metaBytes = valuesBytes(meta) + this.extraBytes + this.fixedBytes + type.length + 32;
    if (text.length <= MAX_TEXT) pieces.push(text);
    else for (let i = 0; i < text.length; i += MAX_TEXT) pieces.push(text.slice(i, i + MAX_TEXT));
    for (let index = 0; index < pieces.length; index += 1) {
      if (this.elements.length >= MAX_ELEMENTS) {
        this.overflow = true;
        return;
      }
      const piece = pieces[index];
      if (!this.account(metaBytes + piece.length)) return;
      // `languages` is shared by every element of the document (never mutated; serialised identically).
      const metadata = { filename: this.filename, filetype: this.filetype, languages: this.languages, page_number: this.page, last_modified: this.lastModified };
      if (type === "Title") {
        const depth = Number.isInteger(meta.category_depth) ? meta.category_depth : 0;
        while (this.titles.length > 0 && this.titles[this.titles.length - 1].depth >= depth) this.titles.pop();
        if (this.titles.length > 0) metadata.parent_id = this.titles[this.titles.length - 1].id;
      } else if (this.titles.length > 0 && type !== "PageBreak") metadata.parent_id = this.titles[this.titles.length - 1].id;
      for (const key in meta) if (Object.hasOwn(meta, key) && meta[key] !== undefined && meta[key] !== null) metadata[key] = meta[key];
      if (index > 0) metadata.is_continuation = true;
      if (this.extraMetadata !== null) Object.assign(metadata, this.extraMetadata);
      const element = { type, element_id: this.id(piece), text: piece, metadata };
      this.ordinal += 1;
      this.elements.push(element);
      if (type === "Title") this.titles.push({ id: element.element_id, depth: metadata.category_depth ?? 0 });
    }
  }

  /** A page change; emits a PageBreak element when the caller asked for them. */
  pageBreak() {
    if (this.includePageBreaks) this.add("PageBreak", "");
    this.page += 1;
  }
}

/** Lower bound of the encoded bytes of an array of strings: every character is at least one byte, plus quotes or separators. */
export function stringsBytes(values) {
  let bytes = 2;
  if (Array.isArray(values)) for (const value of values) bytes += (typeof value === "string" ? value.length : 1) + 1;
  return bytes;
}

/** Lower bound of the encoded bytes of the values of a flat metadata object (strings, scalars and arrays of them). */
export function valuesBytes(object) {
  let bytes = 0;
  if (object === null || typeof object !== "object") return bytes;
  for (const key of Object.keys(object)) {
    const value = object[key];
    if (value === undefined || value === null) continue;
    bytes += key.length;
    if (typeof value === "string") bytes += value.length;
    else if (Array.isArray(value)) bytes += stringsBytes(value);
    else bytes += 1;
  }
  return bytes;
}

const ADDRESS_RE = /^\d{1,6}[A-Za-z]?\s+[A-Za-z0-9.' -]+\s(Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Lane|Ln\.?|Way|Blvd\.?|Boulevard|Drive|Dr\.?)\s*$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const LIST_LINE_RE = /^\s{0,8}(?:[-*•–]|\d{1,4}[.)])\s+\S/;

export const isEmailBlock = (block) => block.length <= 260 && EMAIL_RE.test(block);
export const isListLine = (line) => LIST_LINE_RE.test(line);
export const stripListMarker = (line) => line.replace(/^\s{0,8}(?:[-*•–]|\d{1,4}[.)])\s+/, "");

export function isAddressBlock(lines) {
  if (lines.length < 2 || lines.length > 5) return false;
  if (!lines.every((line) => line.length > 0 && line.length <= 120)) return false;
  const street = lines.findIndex((line) => ADDRESS_RE.test(line));
  return street >= 0 && street <= 1 && street < lines.length - 1;
}

const WORD_RE = /[A-Za-zÀ-ɏЀ-ӿ]+/g;
const SMALL_WORDS = new Set(["a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by", "from", "de", "von", "und"]);

/** A short single line without terminal punctuation in ALL CAPS or Title Case. */
export function isTitleLine(line) {
  if (line.length === 0 || line.length > 100 || /[.!?;:,]$/.test(line)) return false;
  const words = line.match(WORD_RE);
  if (words === null || words.length === 0) return false;
  if (line === line.toUpperCase() && line !== line.toLowerCase()) return true;
  let capitalised = 0;
  for (const word of words) {
    const lower = word.toLowerCase();
    if (word[0] !== lower[0]) capitalised += 1;
    else if (!SMALL_WORDS.has(lower)) return false;
  }
  return capitalised >= 1 && words[0][0] !== words[0][0].toLowerCase();
}

export const wordCount = (text) => {
  let count = 0;
  for (const part of text.split(/\s+/)) if (part.length > 0) count += 1;
  return count;
};

/** Plain-text classification of one block (already split from its neighbours by blank lines). */
export function classifyBlock(block) {
  const lines = block.split("\n").map((line) => line.trimEnd());
  if (lines.length === 1) {
    const line = lines[0].trim();
    if (isEmailBlock(line)) return "EmailAddress";
    if (isTitleLine(line)) return "Title";
  }
  if (lines.length >= 2 && lines.length <= 5 && isAddressBlock(lines.map((l) => l.trim()))) return "Address";
  if (lines.every(isListLine)) return "ListItem";
  if (/[.!?:;]["')\]]?$/.test(block.trimEnd()) && wordCount(block) >= 5) return "NarrativeText";
  return "UncategorizedText";
}
