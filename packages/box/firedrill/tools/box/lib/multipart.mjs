// Minimal multipart/form-data parser for Box uploads (text bodies only): linear scans, at most 8 parts.

const MAX_PARTS = 8;
const BOUNDARY_RE = /^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/;

function boundaryOf(contentType) {
  if (typeof contentType !== "string") return null;
  const parts = contentType.split(";");
  if (parts[0].trim().toLowerCase() !== "multipart/form-data") return null;
  for (const raw of parts.slice(1)) {
    const eq = raw.indexOf("=");
    if (eq < 0 || raw.slice(0, eq).trim().toLowerCase() !== "boundary") continue;
    let value = raw.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return BOUNDARY_RE.test(value) && !value.endsWith(" ") ? value : null;
  }
  return null;
}

function dispositionParams(value) {
  const params = new Map();
  const pieces = value.split(";");
  if (pieces[0].trim().toLowerCase() !== "form-data") return null;
  for (const piece of pieces.slice(1)) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    const key = piece.slice(0, eq).trim().toLowerCase();
    let v = piece.slice(eq + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!params.has(key)) params.set(key, v);
  }
  return params;
}

/** Returns { parts: [{ name, filename, body }] } or { error }. */
export function parseMultipart(contentType, body) {
  const boundary = boundaryOf(contentType);
  if (boundary === null) return { error: "Content-Type must be multipart/form-data with a boundary" };
  const delimiter = `--${boundary}`;
  let cursor = body.indexOf(delimiter);
  if (cursor < 0) return { error: "multipart body has no boundary delimiter" };
  const parts = [];
  for (;;) {
    cursor += delimiter.length;
    if (body.startsWith("--", cursor)) break;
    if (body.startsWith("\r\n", cursor)) cursor += 2;
    else return { error: "malformed multipart delimiter line" };
    if (parts.length >= MAX_PARTS) return { error: `multipart body has more than ${MAX_PARTS} parts` };
    const headerEnd = body.indexOf("\r\n\r\n", cursor);
    if (headerEnd < 0) return { error: "multipart part headers are not terminated" };
    const headerText = body.slice(cursor, headerEnd);
    if (headerText.length > 8192) return { error: "multipart part headers are too long" };
    let disposition = null;
    for (const line of headerText.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === "content-disposition") disposition = dispositionParams(line.slice(colon + 1));
    }
    if (disposition === null || !disposition.has("name")) return { error: "multipart part is missing Content-Disposition form-data name" };
    const contentStart = headerEnd + 4;
    const next = body.indexOf(`\r\n${delimiter}`, contentStart);
    if (next < 0) return { error: "multipart body is not terminated by the closing boundary" };
    parts.push({ name: disposition.get("name"), filename: disposition.get("filename") ?? null, body: body.slice(contentStart, next) });
    cursor = next + 2;
  }
  return { parts };
}
