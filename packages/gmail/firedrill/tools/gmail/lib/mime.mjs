// Text codecs and a bounded RFC 2822 / MIME parser in plain JavaScript.
// No Buffer, atob, TextEncoder or Node built-ins: the same module runs in the compiled Tool artifact.

export class MimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "MimeError";
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const table = new Map();
  for (let index = 0; index < B64.length; index += 1) table.set(B64[index], index);
  table.set("-", 62);
  table.set("_", 63);
  return table;
})();

/** UTF-8 encode a string into an array of byte values. */
export function utf8Encode(text) {
  const bytes = [];
  for (const character of String(text)) {
    let code = character.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      code = 0;
    }
  }
  return bytes;
}

/** Strict UTF-8 decode; throws MimeError on malformed sequences. */
export function utf8Decode(bytes) {
  let text = "";
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index];
    let code;
    let extra;
    if (byte < 0x80) {
      code = byte;
      extra = 0;
    } else if ((byte & 0xe0) === 0xc0) {
      code = byte & 0x1f;
      extra = 1;
    } else if ((byte & 0xf0) === 0xe0) {
      code = byte & 0x0f;
      extra = 2;
    } else if ((byte & 0xf8) === 0xf0) {
      code = byte & 0x07;
      extra = 3;
    } else throw new MimeError("Message text is not valid UTF-8");
    if (index + extra >= bytes.length + (extra === 0 ? 1 : 0)) throw new MimeError("Message text is not valid UTF-8");
    for (let step = 1; step <= extra; step += 1) {
      const next = bytes[index + step];
      if (next === undefined || (next & 0xc0) !== 0x80) throw new MimeError("Message text is not valid UTF-8");
      code = (code << 6) | (next & 0x3f);
    }
    // Reject overlong forms, UTF-16 surrogates and code points above U+10FFFF.
    if (code < [0, 0x80, 0x800, 0x10000][extra] || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
      throw new MimeError("Message text is not valid UTF-8");
    }
    text += String.fromCodePoint(code);
    index += extra + 1;
  }
  return text;
}

export function byteLength(text) {
  return utf8Encode(text).length;
}

/** Base64 encode bytes; `url` selects the URL-safe alphabet without padding (Gmail's wire format). */
export function base64Encode(bytes, url = true) {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    output += B64[(triple >> 18) & 63] + B64[(triple >> 12) & 63];
    output += b === undefined ? (url ? "" : "=") : B64[(triple >> 6) & 63];
    output += c === undefined ? (url ? "" : "=") : B64[triple & 63];
  }
  if (url) output = output.replace(/\+/g, "-").replace(/\//g, "_");
  return output;
}

/** Decode base64 or base64url (padding and whitespace optional); throws MimeError on invalid characters. */
export function base64Decode(text) {
  const clean = String(text).replace(/[\s=]+/g, "");
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const character of clean) {
    const value = B64_LOOKUP.get(character);
    if (value === undefined) throw new MimeError("Body is not valid base64");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return bytes;
}

export function encodeText(text) {
  return base64Encode(utf8Encode(text), true);
}

export function decodeText(base64) {
  return utf8Decode(base64Decode(base64));
}

export function quotedPrintableDecode(text) {
  const bytes = [];
  const unfolded = String(text).replace(/=\r?\n/g, "");
  for (let index = 0; index < unfolded.length; index += 1) {
    const character = unfolded[index];
    if (character === "=" && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(unfolded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      const code = unfolded.charCodeAt(index);
      if (code > 0xff) throw new MimeError("Quoted-printable body contains non-byte characters");
      bytes.push(code);
    }
  }
  return bytes;
}

/** RFC 2822 date header from epoch milliseconds (deterministic: derived from virtual time). */
export function rfcDate(epochMs) {
  return new Date(Number(epochMs)).toUTCString().replace("GMT", "+0000");
}

/** YYYY-MM-DD in UTC from epoch milliseconds. */
export function isoDay(epochMs) {
  return new Date(Number(epochMs)).toISOString().slice(0, 10);
}

/** Gmail-style snippet: collapsed whitespace, bounded length. */
export function snippetOf(text, limit = 160) {
  const collapsed = String(text).replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : collapsed.slice(0, limit).trimEnd();
}

/** Split "a@x, Name <b@y>" into plain lower-case addresses. */
export function parseAddressList(value) {
  if (typeof value !== "string" || value.trim() === "") return [];
  const addresses = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const angle = /<([^<>]+)>/.exec(trimmed);
    addresses.push((angle ? angle[1] : trimmed).trim().toLowerCase());
  }
  return addresses;
}

/** Approximate RFC 2822 size: header lines plus body bytes plus attachment bytes. */
export function estimateSize(headers, body, attachments) {
  let size = 0;
  const lines = [
    `From: ${headers.from}`,
    `To: ${headers.to.join(", ")}`,
    `Subject: ${headers.subject}`,
    `Date: ${headers.date}`,
    `Message-ID: ${headers.messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ];
  if (headers.cc.length > 0) lines.push(`Cc: ${headers.cc.join(", ")}`);
  if (headers.bcc.length > 0) lines.push(`Bcc: ${headers.bcc.join(", ")}`);
  if (headers.inReplyTo) lines.push(`In-Reply-To: ${headers.inReplyTo}`);
  if (headers.references.length > 0) lines.push(`References: ${headers.references.join(" ")}`);
  for (const line of lines) size += byteLength(line) + 2;
  size += 2 + byteLength(body.text);
  if (body.html !== undefined) size += byteLength(body.html) + 64;
  for (const attachment of attachments) size += attachment.size + 128;
  return size;
}

function parseHeaderBlock(block) {
  const headers = new Map();
  const lines = block.split(/\r?\n/);
  let current;
  for (const line of lines) {
    if (line === "") continue;
    if (/^[ \t]/.test(line) && current !== undefined) {
      headers.set(current, `${headers.get(current)} ${line.trim()}`);
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) throw new MimeError(`Malformed header line "${line.slice(0, 40)}"`);
    current = line.slice(0, separator).trim().toLowerCase();
    headers.set(current, line.slice(separator + 1).trim());
  }
  return headers;
}

function parseContentType(value) {
  const [type, ...rest] = String(value ?? "text/plain").split(";");
  // Null-prototype map: parameter names come from the caller's raw message (`__proto__=`, `constructor=`).
  const parameters = Object.create(null);
  for (const parameter of rest) {
    const equals = parameter.indexOf("=");
    if (equals < 0) continue;
    const name = parameter.slice(0, equals).trim().toLowerCase();
    let parameterValue = parameter.slice(equals + 1).trim();
    if (parameterValue.startsWith('"') && parameterValue.endsWith('"')) parameterValue = parameterValue.slice(1, -1);
    parameters[name] = parameterValue;
  }
  return { type: type.trim().toLowerCase(), parameters };
}

function decodeBody(text, encoding, charset) {
  const normalizedCharset = (charset ?? "utf-8").toLowerCase().replace(/^"|"$/g, "");
  if (!["utf-8", "utf8", "us-ascii", "ascii"].includes(normalizedCharset)) {
    throw new MimeError(`Unsupported charset ${normalizedCharset}`);
  }
  const transfer = (encoding ?? "7bit").toLowerCase();
  if (transfer === "7bit" || transfer === "8bit" || transfer === "binary") return text.replace(/\r\n/g, "\n");
  if (transfer === "quoted-printable") return utf8Decode(quotedPrintableDecode(text)).replace(/\r\n/g, "\n");
  if (transfer === "base64") return utf8Decode(base64Decode(text));
  throw new MimeError(`Unsupported Content-Transfer-Encoding ${transfer}`);
}

function splitEntity(text) {
  const match = /\r?\n\r?\n/.exec(text);
  if (match === null) return { headerBlock: text, bodyText: "" };
  return { headerBlock: text.slice(0, match.index), bodyText: text.slice(match.index + match[0].length) };
}

function parsePart(text) {
  const { headerBlock, bodyText } = splitEntity(text);
  const headers = parseHeaderBlock(headerBlock);
  const contentType = parseContentType(headers.get("content-type"));
  const disposition = (headers.get("content-disposition") ?? "").toLowerCase();
  if (disposition.startsWith("attachment") || contentType.parameters.name !== undefined) {
    throw new MimeError("Unsupported MIME structure: attachments cannot be created");
  }
  if (contentType.type === "text/plain" || contentType.type === "text/html") {
    return {
      type: contentType.type,
      text: decodeBody(bodyText, headers.get("content-transfer-encoding"), contentType.parameters.charset),
    };
  }
  throw new MimeError(`Unsupported MIME structure: part ${contentType.type}`);
}

/**
 * Parse a base64url RFC 2822 message the way Gmail's `raw` field expects.
 * Supports text/plain, text/html, and multipart/alternative with exactly those two parts.
 */
export function parseRaw(raw) {
  if (typeof raw !== "string" || raw.length === 0) throw new MimeError("raw must be a base64url RFC 2822 message");
  if (raw.length > 1_048_576) throw new MimeError("raw exceeds 1 MiB");
  const text = utf8Decode(base64Decode(raw));
  const { headerBlock, bodyText } = splitEntity(text);
  const headers = parseHeaderBlock(headerBlock);
  const contentType = parseContentType(headers.get("content-type"));
  let body;
  if (contentType.type === "multipart/alternative") {
    const boundary = contentType.parameters.boundary;
    if (!boundary) throw new MimeError("multipart/alternative requires a boundary");
    const pieces = bodyText.split(`--${boundary}`);
    const parts = [];
    for (const piece of pieces.slice(1)) {
      if (piece.startsWith("--")) break;
      const trimmed = piece.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      if (trimmed.trim() === "") continue;
      parts.push(parsePart(trimmed));
    }
    const plain = parts.filter((part) => part.type === "text/plain");
    const html = parts.filter((part) => part.type === "text/html");
    if (parts.length === 0 || plain.length > 1 || html.length > 1 || plain.length + html.length !== parts.length) {
      throw new MimeError("Unsupported MIME structure: multipart/alternative must hold one text/plain and/or one text/html part");
    }
    body = { text: plain[0]?.text ?? "", ...(html[0] ? { html: html[0].text } : {}) };
  } else if (contentType.type.startsWith("multipart/")) {
    throw new MimeError(`Unsupported MIME structure: ${contentType.type}`);
  } else {
    const part = parsePart(text);
    body = part.type === "text/html" ? { text: "", html: part.text } : { text: part.text };
  }
  const references = (headers.get("references") ?? "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return {
    to: parseAddressList(headers.get("to")),
    cc: parseAddressList(headers.get("cc")),
    bcc: parseAddressList(headers.get("bcc")),
    subject: headers.get("subject") ?? "",
    inReplyTo: headers.get("in-reply-to")?.trim() || undefined,
    references,
    body,
  };
}
