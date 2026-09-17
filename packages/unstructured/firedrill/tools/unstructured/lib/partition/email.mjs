// RFC 822 / RFC 5322 e-mail with RFC 2046 multipart bodies. Every scan is a single forward pass over lines with an index
// that strictly advances; malformed structure fails INVALID_FILE (422) instead of being guessed at.
import { partitionHtml } from "./html.mjs";
import { partitionText } from "./text.mjs";
import { base64Decode, utf8Decode } from "../util.mjs";

/** At most this many header lines (folded continuation lines included) in one header block. */
export const MAX_HEADER_LINES = 10000;
/** At most this many MIME parts in one message, all nesting levels together. */
export const MAX_PARTS = 1000;
/** A multipart body may nest multipart parts this deep (the message body itself is level 1). */
export const MAX_MULTIPART_DEPTH = 4;
/** RFC 2046 §5.1.1: a boundary is 1-70 characters from `bchars`, not ending in a space. */
const BOUNDARY_RE = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/;
/** RFC 5322 §2.2: a field name is printable US-ASCII except the colon. */
const FIELD_NAME_RE = /^[!-9;-~]{1,200}$/;

const invalid = (detail) => ({ ok: false, message: `File is not a valid eml: ${detail}` });

/**
 * Header block of `text` starting at `start`: runs until the first empty line (consumed) or the end of the text; folded
 * continuation lines are joined with one space. A line that is neither a field, a continuation nor empty fails.
 * @returns { ok: true, headers: Map(lowercased name -> first value), bodyStart } or { ok: false, message }
 */
export function parseHeaderBlock(text, start) {
  const headers = new Map();
  let pos = start;
  let last = null;
  let lines = 0;
  while (pos < text.length) {
    const eol = text.indexOf("\n", pos);
    const lineEnd = eol < 0 ? text.length : eol;
    const next = eol < 0 ? text.length : eol + 1;
    if (next <= pos) return invalid("header scan did not advance");
    const line = text.slice(pos, lineEnd);
    pos = next;
    if (line.length === 0) return { ok: true, headers, bodyStart: pos };
    lines += 1;
    if (lines > MAX_HEADER_LINES) return invalid(`header block longer than ${MAX_HEADER_LINES} lines`);
    if (line[0] === " " || line[0] === "\t") {
      if (last === null) return invalid("continuation line before any header field");
      if (last.first) headers.set(last.name, `${headers.get(last.name)} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon).trimEnd() : "";
    if (!FIELD_NAME_RE.test(name)) return invalid("header block must end with a blank line before the body");
    const key = name.toLowerCase();
    const first = !headers.has(key);
    if (first) headers.set(key, line.slice(colon + 1).trim());
    last = { name: key, first };
  }
  return { ok: true, headers, bodyStart: text.length };
}

/**
 * `type/subtype; name=value; name="quoted value"`: the media type and parameter names are lowercased, parameter values keep
 * their case (RFC 2045 §5.1; boundaries are case-sensitive). One pass over the value; quoted-pair escapes are honoured.
 * @returns { type, params: Map } or null when the value is not a media type
 */
export function parseContentType(value) {
  const params = new Map();
  let i = value.indexOf(";");
  const type = (i < 0 ? value : value.slice(0, i)).trim().toLowerCase();
  if (!/^[!#-'*+\-.0-9A-Z^-~]+\/[!#-'*+\-.0-9A-Z^-~]+$/i.test(type)) return null;
  while (i >= 0 && i < value.length) {
    i += 1; // past ';'
    const eq = value.indexOf("=", i);
    if (eq < 0) break;
    const name = value.slice(i, eq).trim().toLowerCase();
    let j = eq + 1;
    while (j < value.length && (value[j] === " " || value[j] === "\t")) j += 1;
    let paramValue = "";
    if (value[j] === '"') {
      j += 1;
      const parts = [];
      while (j < value.length && value[j] !== '"') {
        if (value[j] === "\\" && j + 1 < value.length) j += 1;
        parts.push(value[j]);
        j += 1;
      }
      if (j >= value.length) return null; // unterminated quoted string
      paramValue = parts.join("");
      j += 1;
      const semi = value.indexOf(";", j);
      if (value.slice(j, semi < 0 ? value.length : semi).trim().length > 0) return null;
      i = semi;
    } else {
      const semi = value.indexOf(";", j);
      paramValue = value.slice(j, semi < 0 ? value.length : semi).trim();
      i = semi;
    }
    if (name.length > 0 && !params.has(name)) params.set(name, paramValue);
  }
  return { type, params };
}

/**
 * Splits a multipart body into its part strings. Delimiter lines start at a line start with `--boundary`, optionally `--`
 * (the close delimiter), then only transport padding. The preamble before the first delimiter and the epilogue after the
 * close delimiter are ignored (RFC 2046 §5.1.1).
 * @returns { ok: true, parts: string[] } or { ok: false, message }
 */
export function splitMultipart(body, boundary, budget) {
  const dash = `--${boundary}`;
  const parts = [];
  let pos = 0;
  let partStart = -1;
  while (pos < body.length) {
    const eol = body.indexOf("\n", pos);
    const lineEnd = eol < 0 ? body.length : eol;
    const next = eol < 0 ? body.length : eol + 1;
    if (next <= pos) return invalid("multipart scan did not advance");
    if (lineEnd - pos >= dash.length && body.startsWith(dash, pos)) {
      let k = pos + dash.length;
      const close = body.startsWith("--", k);
      if (close) k += 2;
      while (k < lineEnd && (body[k] === " " || body[k] === "\t" || body[k] === "\r")) k += 1;
      if (k === lineEnd) {
        if (partStart >= 0) {
          // The line break before a delimiter belongs to the delimiter.
          parts.push(body.slice(partStart, Math.max(partStart, pos - 1)));
          budget.parts += 1;
          if (budget.parts > MAX_PARTS) return invalid(`more than ${MAX_PARTS} MIME parts`);
        }
        if (close) {
          if (partStart < 0) return invalid("multipart body has a close delimiter before any part");
          return { ok: true, parts };
        }
        if (eol < 0) return invalid(`boundary delimiter "${dash}" is not followed by a line break`);
        partStart = next;
      }
    }
    pos = next;
  }
  return invalid(partStart < 0 ? `multipart body has no "${dash}" delimiter` : `multipart body has no closing "${dash}--" delimiter`);
}

/**
 * Walks one entity (headers already parsed) and returns the first text part in document order, depth first. Every multipart
 * level is validated completely before a part is chosen, so a malformed later part fails even when an earlier text part exists.
 * @returns { ok: true, part: { body, html } | null } or { ok: false, message }
 */
function firstTextPart(headers, body, depth, budget) {
  const raw = headers.get("content-type");
  const contentType = raw === undefined || raw.length === 0 ? { type: "text/plain", params: new Map() } : parseContentType(raw);
  if (contentType === null) return invalid("malformed Content-Type header");
  if (!contentType.type.startsWith("multipart/")) {
    return { ok: true, part: contentType.type.startsWith("text/") ? { body, html: contentType.type === "text/html" } : null };
  }
  if (depth > MAX_MULTIPART_DEPTH) return invalid(`multipart parts nested deeper than ${MAX_MULTIPART_DEPTH} levels`);
  const boundary = contentType.params.get("boundary");
  if (boundary === undefined || boundary.length === 0) return invalid("multipart Content-Type has no boundary");
  if (boundary.length > 70 || !BOUNDARY_RE.test(boundary)) return invalid("multipart boundary is not 1-70 RFC 2046 boundary characters");
  const split = splitMultipart(body, boundary, budget);
  if (!split.ok) return split;
  let chosen = null;
  for (const partText of split.parts) {
    const parsed = parseHeaderBlock(partText, 0);
    if (!parsed.ok) return parsed;
    const inner = firstTextPart(parsed.headers, partText.slice(parsed.bodyStart), depth + 1, budget);
    if (!inner.ok) return inner;
    if (chosen === null && inner.part !== null) chosen = inner.part;
  }
  return { ok: true, part: chosen };
}

/**
 * RFC 5322 address list: commas split addresses only outside quoted strings, angle-addr brackets and comments. One pass.
 */
export function addresses(value) {
  if (typeof value !== "string" || value.length === 0) return [];
  const out = [];
  let start = 0;
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (quoted) {
      if (c === "\\") i += 1;
      else if (c === '"') quoted = false;
    } else if (c === "\\") i += 1;
    else if (c === '"') quoted = true;
    else if (c === "(") comment += 1;
    else if (c === ")" && comment > 0) comment -= 1;
    else if (c === "<" && comment === 0) angle += 1;
    else if (c === ">" && angle > 0 && comment === 0) angle -= 1;
    else if (c === "," && angle === 0 && comment === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out.map((a) => a.trim()).filter((a) => a.length > 0);
}

const WORD_CHARSETS = new Map([["utf-8", "utf-8"], ["utf8", "utf-8"], ["us-ascii", "utf-8"], ["iso-8859-1", "latin1"], ["latin1", "latin1"]]);
const ENCODED_WORD = /=\?([A-Za-z0-9_\-]{1,40})(?:\*[A-Za-z0-9\-]{1,20})?\?([BbQq])\?([^?\s]*)\?=/g;

function decodeWord(charset, encoding, text) {
  const target = WORD_CHARSETS.get(charset.toLowerCase());
  if (target === undefined) return null;
  let bytes;
  if (encoding === "B" || encoding === "b") {
    bytes = base64Decode(text);
    if (bytes === null) return null;
  } else {
    bytes = [];
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (text[i] === "_") bytes.push(32);
      else if (text[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
        bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
        i += 2;
      } else if (code < 128) bytes.push(code);
      else return null;
    }
  }
  if (target === "latin1") {
    let out = "";
    for (const b of bytes) out += String.fromCharCode(b);
    return out;
  }
  return utf8Decode(bytes);
}

/** RFC 2047 encoded words (UTF-8, US-ASCII, ISO-8859-1; B and Q) in an unstructured header; whitespace between two encoded words is dropped. Undecodable words stay literal. */
export function decodeEncodedWords(value) {
  if (typeof value !== "string" || !value.includes("=?")) return value;
  let out = "";
  let last = 0;
  let previousWordEnd = -1;
  for (const match of value.matchAll(ENCODED_WORD)) {
    const decoded = decodeWord(match[1], match[2], match[3]);
    if (decoded === null) continue;
    const gap = value.slice(last, match.index);
    out += previousWordEnd === last && /^[ \t]*$/.test(gap) ? "" : gap;
    out += decoded;
    last = match.index + match[0].length;
    previousWordEnd = last;
  }
  return out + value.slice(last);
}

export function partitionEmail(builder, input) {
  // CRLF, LF and bare CR line endings may be mixed; each ends a line (as in Python's e-mail parser).
  const text = input.indexOf("\r") >= 0 ? input.replace(/\r\n?/g, "\n") : input;
  // An mbox "From " envelope line before the headers is skipped (Python's parser records it as the unix-from).
  const headerStart = text.startsWith("From ") ? (text.indexOf("\n") < 0 ? text.length : text.indexOf("\n") + 1) : 0;
  const top = parseHeaderBlock(text, headerStart);
  if (!top.ok) return top;
  const { headers } = top;
  if (!headers.has("from") && !headers.has("subject") && !headers.has("to")) return { ok: false, message: "File is not a valid eml" };
  const found = firstTextPart(headers, text.slice(top.bodyStart), 1, { parts: 0 });
  if (!found.ok) return found;
  // Address lists are split before encoded words are decoded, so an encoded comma never splits an address.
  const list = (key) => addresses(headers.get(key)).map(decodeEncodedWords);
  if (headers.has("subject")) headers.set("subject", decodeEncodedWords(headers.get("subject")));
  const extra = { sent_from: list("from"), sent_to: list("to") };
  if (headers.has("cc")) extra.cc_recipient = list("cc");
  if (headers.has("bcc")) extra.bcc_recipient = list("bcc");
  if (headers.has("subject")) extra.subject = headers.get("subject");
  if (headers.has("message-id")) extra.email_message_id = headers.get("message-id");
  builder.setExtraMetadata(extra);
  if (headers.has("subject") && headers.get("subject").length > 0) builder.add("Title", headers.get("subject"), { category_depth: 0 });
  if (found.part === null) return { ok: true };
  return found.part.html ? partitionHtml(builder, found.part.body) : partitionText(builder, found.part.body);
}
