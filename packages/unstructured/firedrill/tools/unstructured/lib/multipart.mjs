// Linear multipart/form-data parser over the UTF-8 text body the framework hands to `text` routes.
// Returns { parts: [{ name, filename, contentType, transferEncoding, lastModified, body }] } or { error }.
//
// Cost model: the body is walked forward once. Delimiters are found with one `indexOf` cursor that only moves forward
// (a candidate `--boundary` counts only at the start of a line and only when the line ends right after it or it is the
// close delimiter); each part's header block is searched only inside a window of MAX_HEADER_BLOCK characters. No search
// restarts from an earlier position, so the work is O(body length + parts x MAX_HEADER_BLOCK), whatever the part count.

const MAX_PARTS = 64;
const MAX_HEADER_BLOCK = 16384;
const MAX_NAME = 200;
// RFC 2046 bchars, plus ';' (only reachable inside a quoted boundary parameter).
const BOUNDARY_RE = /^[0-9A-Za-z'()+_,\-./:=?; ]{1,70}$/;

/**
 * Splits a header value `type; key=value; key="quoted \"value\"; with ;"` in one scan.
 * Returns { type, params: Map(lower-case key -> first value) }. Quoted values are unescaped (`\x` -> `x`).
 */
export function headerParams(value) {
  const params = new Map();
  const n = value.length;
  let i = value.indexOf(";");
  if (i < 0) i = n;
  const type = value.slice(0, i).trim().toLowerCase();
  while (i < n) {
    i += 1; // past ';'
    let keyEnd = i;
    while (keyEnd < n && value[keyEnd] !== "=" && value[keyEnd] !== ";") keyEnd += 1;
    const key = value.slice(i, keyEnd).trim().toLowerCase();
    if (keyEnd >= n || value[keyEnd] === ";") {
      i = keyEnd;
      continue;
    }
    let j = keyEnd + 1;
    while (j < n && (value[j] === " " || value[j] === "\t")) j += 1;
    let parsed;
    if (value[j] === '"') {
      let out = "";
      j += 1;
      while (j < n && value[j] !== '"') {
        if (value[j] === "\\" && j + 1 < n) j += 1;
        out += value[j];
        j += 1;
      }
      parsed = out;
      j += 1; // past closing quote (or end)
      while (j < n && value[j] !== ";") j += 1;
    } else {
      const start = j;
      while (j < n && value[j] !== ";") j += 1;
      parsed = value.slice(start, j).trim();
    }
    if (key.length > 0 && !params.has(key)) params.set(key, parsed);
    i = j;
  }
  return { type, params };
}

/** RFC 5987 `charset'lang'pct-encoded` (UTF-8 or US-ASCII); null when it does not decode. */
function extValue(value) {
  const first = value.indexOf("'");
  const second = first < 0 ? -1 : value.indexOf("'", first + 1);
  if (second < 0) return null;
  const charset = value.slice(0, first).toLowerCase();
  if (charset !== "utf-8" && charset !== "us-ascii") return null;
  try {
    return decodeURIComponent(value.slice(second + 1));
  } catch {
    return null;
  }
}

/** The boundary parameter of a multipart/form-data content type, or null. */
export function boundaryOf(contentType) {
  if (typeof contentType !== "string" || contentType.length > MAX_HEADER_BLOCK) return null;
  const { type, params } = headerParams(contentType);
  if (type !== "multipart/form-data" || !params.has("boundary")) return null;
  const value = params.get("boundary");
  return BOUNDARY_RE.test(value) && !value.endsWith(" ") ? value : null;
}

export const isMultipart = (contentType) => typeof contentType === "string" && contentType.split(";")[0].trim().toLowerCase() === "multipart/form-data";

function dispositionParams(value) {
  const { type, params } = headerParams(value);
  if (type !== "form-data") return null;
  if (params.has("filename*")) {
    // RFC 6266: the extended value wins when it decodes.
    const decoded = extValue(params.get("filename*"));
    if (decoded !== null) params.set("filename", decoded);
  }
  return params;
}

export function parseMultipart(contentType, body) {
  const boundary = boundaryOf(contentType);
  if (boundary === null) return { error: "Content-Type must be multipart/form-data with a boundary" };
  if (typeof body !== "string") return { error: "Request body is empty" };
  const delimiter = `--${boundary}`;
  let searchFrom = 0;
  // Next delimiter at or after `from` whose line break before it starts at or after `floor`. Forward-only.
  const nextDelimiter = (floor) => {
    for (;;) {
      const d = body.indexOf(delimiter, searchFrom);
      if (d < 0) return -1;
      searchFrom = d + 1;
      if (d - 1 < floor || body[d - 1] !== "\n") continue;
      const after = d + delimiter.length;
      if (body.startsWith("--", after) || body.startsWith("\r\n", after) || body.startsWith("\n", after)) return d;
    }
  };
  let cursor = body.indexOf(delimiter);
  if (cursor < 0) return { error: "Multipart body has no boundary delimiter" };
  searchFrom = cursor + 1;
  const parts = [];
  for (;;) {
    cursor += delimiter.length;
    if (body.startsWith("--", cursor)) break;
    if (body.startsWith("\r\n", cursor)) cursor += 2;
    else if (body.startsWith("\n", cursor)) cursor += 1;
    else return { error: "Malformed multipart delimiter line" };
    if (parts.length >= MAX_PARTS) return { error: `Multipart body has more than ${MAX_PARTS} parts` };
    const windowEnd = Math.min(body.length, cursor + MAX_HEADER_BLOCK + 4);
    const window = body.slice(cursor, windowEnd);
    let headerEnd = window.indexOf("\r\n\r\n");
    let sepLength = 4;
    const lfEnd = window.indexOf("\n\n");
    if (headerEnd < 0 || (lfEnd >= 0 && lfEnd < headerEnd)) {
      headerEnd = lfEnd;
      sepLength = 2;
    }
    if (headerEnd < 0) return { error: windowEnd === body.length ? "Multipart part headers are not terminated" : "Multipart part headers are too long" };
    if (headerEnd > MAX_HEADER_BLOCK) return { error: "Multipart part headers are too long" };
    const headerText = window.slice(0, headerEnd);
    headerEnd += cursor;
    let disposition = null;
    let partType = null;
    let transfer = null;
    let lastModified = null;
    for (const rawLine of headerText.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === "content-disposition") disposition = dispositionParams(value);
      else if (name === "content-type") partType = value.split(";")[0].trim().toLowerCase();
      else if (name === "content-transfer-encoding") transfer = value.toLowerCase();
      else if (name === "last-modified") lastModified = value;
    }
    if (disposition === null || !disposition.has("name")) return { error: "Multipart part is missing a Content-Disposition form-data name" };
    const name = disposition.get("name");
    if (name.length === 0 || name.length > MAX_NAME) return { error: "Multipart part name is empty or too long" };
    const contentStart = headerEnd + sepLength;
    if (searchFrom < contentStart) searchFrom = contentStart;
    // The floor admits an empty part whose close delimiter shares the blank line ending its headers.
    const d = nextDelimiter(contentStart - 1);
    if (d < 0) return { error: "Multipart body is not terminated by the closing boundary" };
    const contentEnd = d - 2 >= contentStart && body[d - 2] === "\r" ? d - 2 : Math.max(contentStart, d - 1);
    parts.push({
      name,
      filename: disposition.has("filename") ? disposition.get("filename") : null,
      contentType: partType,
      transferEncoding: transfer,
      lastModified,
      body: body.slice(contentStart, contentEnd),
    });
    cursor = d;
  }
  return { parts };
}
