// HTTP helpers for the Box conformance target (Node built-ins only).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const BASE = process.env.FIREDRILL_HTTP_URL;
const TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
assert.ok(BASE && TOKEN, "the HTTP binding is required (FIREDRILL_HTTP_URL / FIREDRILL_HTTP_TOKEN)");

export const sha1 = (bytes) => createHash("sha1").update(bytes).digest("hex");

/** Seeded ids (see starter.json). */
export const F = (n) => `3100000000${String(n).padStart(2, "0")}`;
export const FI = (n) => `9100000000${String(n).padStart(2, "0")}`;
export const MAYA = "20001";
export const DANIEL = "20002";
export const PRIYA = "20003";
export const JONAH = "20004";

/**
 * Calls a Box route. `expect` is a status or [status, boxCode]. Error bodies are checked against Box's envelope.
 * Options: json (body), text (raw body), headers, raw (return bytes).
 */
export async function box(method, path, expect = 200, { json, text, headers = {}, raw = false } = {}) {
  const [status, code] = Array.isArray(expect) ? expect : [expect];
  const init = { method, headers: { authorization: `Bearer ${TOKEN}`, ...headers } };
  if (json !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (text !== undefined) init.body = text;
  const response = await fetch(`${BASE}${path}`, init);
  const bytes = Buffer.from(await response.arrayBuffer());
  const bodyText = bytes.toString("utf8");
  assert.equal(response.status, status, `${method} ${path} → ${response.status} ${bodyText.slice(0, 500)}`);
  let body;
  if (status === 204) assert.equal(bytes.length, 0, `${method} ${path}: 204 has no body`);
  else if (!raw || status >= 400) body = JSON.parse(bodyText);
  if (status >= 400) {
    assert.equal(body.type, "error", `${method} ${path}: Box error envelope`);
    assert.equal(body.status, status);
    assert.equal(typeof body.message, "string");
    assert.match(body.request_id, /^[0-9a-f]{16}$/);
    if (code !== undefined) assert.equal(body.code, code, `${method} ${path}: expected ${code}, got ${body.code} (${body.message})`);
  }
  return { status: response.status, body, bytes, headers: response.headers };
}

export const get = (path, expect, options) => box("GET", path, expect, options);
export const post = (path, json, expect = 201, options = {}) => box("POST", path, expect, { ...options, json });
export const put = (path, json, expect = 200, options = {}) => box("PUT", path, expect, { ...options, json });
export const del = (path, expect = 204, options = {}) => box("DELETE", path, expect, options);

/** Multipart upload body with an attributes part (optional) followed by a file part. */
export function multipart(attributes, content, boundary = "fdBoxBoundary7MA4YWxk") {
  let body = "";
  if (attributes !== undefined) body += `--${boundary}\r\nContent-Disposition: form-data; name="attributes"\r\n\r\n${JSON.stringify(attributes)}\r\n`;
  body += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.bin"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`;
  return { text: body, headers: { "content-type": `multipart/form-data; boundary="${boundary}"` } };
}

export const upload = (attributes, content, expect = 201, headers = {}) => {
  const m = multipart(attributes, content);
  return box("POST", "/api/2.0/files/content", expect, { text: m.text, headers: { ...m.headers, ...headers } });
};

export const uploadVersion = (fileId, attributes, content, expect = 201, headers = {}) => {
  const m = multipart(attributes, content);
  return box("POST", `/api/2.0/files/${fileId}/content`, expect, { text: m.text, headers: { ...m.headers, ...headers } });
};

export const names = (entries) => entries.map((entry) => entry.name);

/** Calls each operation once with a schema-valid request and expects `expect(opId)` → [status, code]. */
export async function everyOperation(expect, h = {}) {
  const calls = [
    ["users.get-me", (e) => get("/2.0/users/me", e, { headers: h })],
    ["folders.get", (e) => get(`/2.0/folders/${F(1)}`, e, { headers: h })],
    ["folders.list-items", (e) => get(`/2.0/folders/${F(1)}/items`, e, { headers: h })],
    ["folders.create", (e) => post("/2.0/folders", { name: "Capacity probe", parent: { id: "0" } }, e, { headers: h })],
    ["folders.update", (e) => put(`/2.0/folders/${F(7)}`, { description: "probe" }, e, { headers: h })],
    ["folders.delete", (e) => del(`/2.0/folders/${F(7)}`, e, { headers: h })],
    ["folders.copy", (e) => post(`/2.0/folders/${F(4)}/copy`, { parent: { id: F(7) } }, e, { headers: h })],
    ["files.get", (e) => get(`/2.0/files/${FI(3)}`, e, { headers: h })],
    ["files.update", (e) => put(`/2.0/files/${FI(3)}`, { description: "probe" }, e, { headers: h })],
    ["files.delete", (e) => del(`/2.0/files/${FI(4)}`, e, { headers: h })],
    ["files.copy", (e) => post(`/2.0/files/${FI(3)}/copy`, { parent: { id: F(7) } }, e, { headers: h })],
    ["files.upload", (e) => upload({ name: "probe.txt", parent: { id: F(7) } }, "probe", e, h)],
    ["files.upload-version", (e) => uploadVersion(FI(3), {}, "probe", e, h)],
    ["files.download", (e) => get(`/2.0/files/${FI(3)}/content`, e, { raw: true, headers: h })],
    ["files.list-versions", (e) => get(`/2.0/files/${FI(1)}/versions`, e, { headers: h })],
    ["files.restore", (e) => post(`/2.0/files/${FI(19)}`, {}, e, { headers: h })],
    ["search.query", (e) => get("/2.0/search?query=launch", e, { headers: h })],
    ["collaborations.create", (e) => post("/2.0/collaborations", { item: { type: "folder", id: F(7) }, accessible_by: { type: "user", id: DANIEL }, role: "viewer" }, e, { headers: h })],
    ["collaborations.list-for-folder", (e) => get(`/2.0/folders/${F(1)}/collaborations`, e, { headers: h })],
    ["collaborations.delete", (e) => del("/2.0/collaborations/8800003", e, { headers: h })],
    ["comments.create", (e) => post("/2.0/comments", { item: { type: "file", id: FI(3) }, message: "probe" }, e, { headers: h })],
    ["comments.list-for-file", (e) => get(`/2.0/files/${FI(1)}/comments`, e, { headers: h })],
    ["events.list", (e) => get("/2.0/events", e, { headers: h })],
  ];
  for (const [operationId, call] of calls) await call(expect(operationId));
  return calls.length;
}
