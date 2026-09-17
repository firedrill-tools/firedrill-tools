// Stored content helpers: UTF-8 <-> bytes <-> base64 in plain JavaScript (no Buffer, atob, btoa or TextEncoder), MIME
// classification, byte accounting and the text-based export renderings of Google Workspace types. Pure functions only.
import { md5Hex } from "./md5.mjs";
import { DOCUMENT_MIME, FOLDER_MIME, PRESENTATION_MIME, SHORTCUT_MIME, SPREADSHEET_MIME } from "./ids.mjs";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Map([...ALPHABET].map((character, index) => [character, index]));
LOOKUP.set("-", 62);
LOOKUP.set("_", 63);

/** Largest stored body per file (256 KiB of UTF-8 or decoded bytes). */
export const MAX_CONTENT_BYTES = 262_144;

export function utf8Bytes(text) {
  const bytes = [];
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

/** UTF-8 byte length of a string without materialising the bytes. */
export function utf8Length(text) {
  let length = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return length;
}

export function encodeBase64(bytes) {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET[(triple >> 18) & 63] + ALPHABET[(triple >> 12) & 63];
    out += b === undefined ? "=" : ALPHABET[(triple >> 6) & 63];
    out += c === undefined ? "=" : ALPHABET[triple & 63];
  }
  return out;
}

/** Decodes standard or URL-safe base64; returns undefined when malformed. */
export function decodeBase64(text) {
  if (typeof text !== "string") return undefined;
  const clean = text.replace(/[\s=]/g, "");
  if (!/^[A-Za-z0-9+/_-]*$/.test(clean) || clean.length % 4 === 1) return undefined;
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const character of clean) {
    value = (value << 6) | LOOKUP.get(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  return bytes;
}

export function textToBase64(text) {
  return encodeBase64(utf8Bytes(text));
}

/** Canonical (padded, standard alphabet) form of a base64 payload. */
export function normalizeBase64(text) {
  const bytes = decodeBase64(text);
  return bytes === undefined ? undefined : encodeBase64(bytes);
}

const TEXT_MIME_EXACT = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/ecmascript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/x-sh",
  "application/sql",
  "application/rtf",
  "application/x-httpd-php",
  "application/x-www-form-urlencoded",
  "image/svg+xml",
]);

/** Blob types whose bodies are stored as UTF-8 text rather than base64. */
export function isTextMime(mimeType) {
  const type = String(mimeType).toLowerCase();
  return type.startsWith("text/") || TEXT_MIME_EXACT.has(type) || type.endsWith("+json") || type.endsWith("+xml");
}

export function isGoogleType(mimeType) {
  return typeof mimeType === "string" && mimeType.startsWith("application/vnd.google-apps.");
}

export function isGoogleTextType(mimeType) {
  return mimeType === DOCUMENT_MIME || mimeType === SPREADSHEET_MIME || mimeType === PRESENTATION_MIME;
}

export function isFolder(mimeType) {
  return mimeType === FOLDER_MIME;
}

export function isShortcut(mimeType) {
  return mimeType === SHORTCUT_MIME;
}

export function isValidMime(mimeType) {
  return typeof mimeType === "string" && /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i.test(mimeType);
}

/** Import conversions this synthetic service performs (text bodies only). */
export const IMPORT_FORMATS = {
  "text/plain": [DOCUMENT_MIME],
  "text/markdown": [DOCUMENT_MIME],
  "text/html": [DOCUMENT_MIME],
  "text/csv": [SPREADSHEET_MIME],
  "text/tab-separated-values": [SPREADSHEET_MIME],
};

/** Export formats per Google Workspace type (text-based subset). */
export const EXPORT_FORMATS = {
  [DOCUMENT_MIME]: ["text/plain", "text/markdown", "text/html"],
  [SPREADSHEET_MIME]: ["text/csv", "text/tab-separated-values"],
  [PRESENTATION_MIME]: ["text/plain"],
};

export function defaultExportMime(mimeType) {
  return mimeType === SPREADSHEET_MIME ? "text/csv" : "text/plain";
}

export function canImportTo(contentMimeType, targetMimeType) {
  const targets = IMPORT_FORMATS[String(contentMimeType).toLowerCase()];
  return Array.isArray(targets) && targets.includes(targetMimeType);
}

function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Minimal CSV row parser (quoted fields, doubled quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Renders the stored text representation of a Google Workspace type into one of its export formats. */
export function renderExport(mimeType, text, exportMimeType) {
  if (mimeType === SPREADSHEET_MIME) {
    if (exportMimeType === "text/csv") return text;
    return parseCsv(text)
      .map((row) => row.map((cell) => cell.replaceAll("\t", " ")).join("\t"))
      .join("\n");
  }
  if (exportMimeType === "text/html") {
    return `<html><head><meta charset="utf-8"></head><body><pre>${escapeHtml(text)}</pre></body></html>`;
  }
  return text;
}

/** Bytes of a content row (text rows as UTF-8, base64 rows decoded). */
export function contentBytes(content) {
  return content.kind === "text" ? utf8Bytes(content.data) : (decodeBase64(content.data) ?? []);
}

export function contentBase64(content) {
  return content.kind === "text" ? textToBase64(content.data) : content.data;
}

export function md5OfContent(content) {
  return md5Hex(contentBytes(content));
}

export function snippetOf(text) {
  return text.length > 200 ? text.slice(0, 200) : text;
}
