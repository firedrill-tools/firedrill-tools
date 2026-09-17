// Shared transport helpers, starter ids and fixture access for the conformance flows. Node built-ins only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export const HTTP = process.env.FIREDRILL_HTTP_URL;
export const TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
assert.ok(HTTP && TOKEN, "the http binding is required");

export const ID = {
  S1: "7c1a9e2f-3b4d-4c5e-8f60-a1b2c3d4e501", S2: "7c1a9e2f-3b4d-4c5e-8f60-a1b2c3d4e502", S3: "7c1a9e2f-3b4d-4c5e-8f60-a1b2c3d4e503", S4: "7c1a9e2f-3b4d-4c5e-8f60-a1b2c3d4e504",
  D1: "9d2b0f3a-4c5e-4d6f-9a71-b2c3d4e5f601", D2: "9d2b0f3a-4c5e-4d6f-9a71-b2c3d4e5f602", D3: "9d2b0f3a-4c5e-4d6f-9a71-b2c3d4e5f603",
  W1: "b3c4d5e6-5f60-4718-8a92-c3d4e5f60701", W2: "b3c4d5e6-5f60-4718-8a92-c3d4e5f60702", W3: "b3c4d5e6-5f60-4718-8a92-c3d4e5f60703", W4: "b3c4d5e6-5f60-4718-8a92-c3d4e5f60704",
  J1: "e5f60718-7a92-4b3c-9d4e-f60718293a01", J2: "e5f60718-7a92-4b3c-9d4e-f60718293a02", J3: "e5f60718-7a92-4b3c-9d4e-f60718293a03",
  J4: "e5f60718-7a92-4b3c-9d4e-f60718293a04", J5: "e5f60718-7a92-4b3c-9d4e-f60718293a05", J6: "e5f60718-7a92-4b3c-9d4e-f60718293a06",
  W1_EMBED_NODE: "f1a2b3c4-0001-4a01-8000-000000000003", NONE: "00000000-0000-4000-8000-000000000000",
};
export const NOW = "2026-09-16T09:00:00.000Z";
export const ALL_OPERATIONS = [
  "general.partition", "sources.list", "sources.create", "sources.get", "sources.update", "sources.delete", "sources.check_connection", "sources.get_connection_check",
  "destinations.list", "destinations.create", "destinations.get", "destinations.update", "destinations.delete",
  "workflows.list", "workflows.create", "workflows.get", "workflows.update", "workflows.delete", "workflows.run",
  "jobs.list", "jobs.get", "jobs.cancel", "jobs.get_details", "jobs.get_failed_files", "jobs.download_output",
];

/** Seeded source files by filename (content computed from the package's own starter.json, never pasted). */
export function fixtures() {
  const starter = JSON.parse(readFileSync("starter.json", "utf8"));
  const out = new Map();
  for (const entry of starter.state) if (entry.namespace === "source-files") out.set(entry.value.filename, entry.value);
  return out;
}

/** Provider-shaped request with the unstructured-api-key header; asserts the status and returns the parsed body. */
export async function api(method, path, { body, raw, contentType, status = 200, headers = {}, token = TOKEN } = {}) {
  const hasBody = body !== undefined || raw !== undefined;
  const response = await fetch(`${HTTP}${path}`, {
    method,
    headers: { "unstructured-api-key": token, ...(hasBody ? { "content-type": contentType ?? "application/json" } : {}), ...headers },
    ...(hasBody ? { body: raw ?? JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  assert.equal(response.status, status, `${method} ${path} ${body === undefined ? "" : JSON.stringify(body).slice(0, 160)} -> ${response.status} ${text.slice(0, 400)}`);
  return { json, text, headers: response.headers, status: response.status };
}
export const get = (path, options) => api("GET", path, options);
export const post = (path, body, options) => api("POST", path, { ...options, body });
export const put = (path, body, options) => api("PUT", path, { ...options, body });
export const del = (path, options) => api("DELETE", path, options);

/** Expects the FastAPI `{ detail }` envelope; `fragment` must appear in the message (string) or first msg (array). */
export async function detail(method, path, status, fragment, options = {}) {
  const result = await api(method, path, { ...options, status });
  assert.ok(result.json && typeof result.json === "object" && Object.hasOwn(result.json, "detail"), `${method} ${path}: no detail envelope: ${result.text.slice(0, 300)}`);
  const d = result.json.detail;
  if (typeof d === "string") {
    if (fragment) assert.ok(d.includes(fragment), `${method} ${path}: expected ${JSON.stringify(fragment)} in ${d.slice(0, 300)}`);
  } else {
    assert.ok(Array.isArray(d) && d.length > 0 && Array.isArray(d[0].loc) && typeof d[0].msg === "string" && typeof d[0].type === "string", `${method} ${path}: malformed detail array ${result.text.slice(0, 300)}`);
    if (fragment) assert.ok(d.some((item) => item.msg.includes(fragment) || item.loc.join(".").includes(fragment)), `${method} ${path}: expected ${JSON.stringify(fragment)} in ${JSON.stringify(d).slice(0, 400)}`);
  }
  return result;
}

/** Canonical operation endpoint; `expected` is "ok", "denied", "invalid" or a Tool error code. */
export async function op(operationId, args, expected = "ok", token = TOKEN) {
  const response = await fetch(`${HTTP}/v1/operations/unstructured/${operationId}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ arguments: args }) });
  const json = await response.json();
  assert.ok(json.outcome, `canonical ${operationId}: ${JSON.stringify(json).slice(0, 300)}`);
  if (expected === "ok") {
    assert.equal(json.outcome.status, "ok", `${operationId} ${JSON.stringify(args).slice(0, 200)}: ${JSON.stringify(json.outcome).slice(0, 400)}`);
    return json.outcome.value;
  }
  if (expected === "denied" || expected === "invalid") {
    assert.equal(json.outcome.status, expected, `${operationId}: ${JSON.stringify(json.outcome).slice(0, 400)}`);
    return json.outcome;
  }
  assert.equal(json.outcome.status, "tool_error", `${operationId}: ${JSON.stringify(json.outcome).slice(0, 400)}`);
  assert.equal(json.outcome.error.code, `tool.${expected}`, `${operationId}: ${JSON.stringify(json.outcome.error)}`);
  return json.outcome.error;
}

/** Hand-built multipart/form-data body. parts: [{ name, value, filename?, contentType?, headers? }]. */
export function multipart(parts, boundary = "FiredrillBoundary7d2c") {
  let body = "";
  for (const part of parts) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename !== undefined ? `; filename="${part.filename}"` : ""}\r\n`;
    if (part.contentType) body += `Content-Type: ${part.contentType}\r\n`;
    for (const [name, value] of Object.entries(part.headers ?? {})) body += `${name}: ${value}\r\n`;
    body += `\r\n${part.value}\r\n`;
  }
  return { raw: `${body}--${boundary}--\r\n`, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** POST /general/v0/general with files [{ filename, content, contentType? }] and scalar/array fields. */
export async function partition(files, fields = {}, options = {}) {
  const parts = files.map((file) => ({ name: "files", filename: file.filename, value: file.content, contentType: file.contentType, headers: file.headers }));
  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const item of value) parts.push({ name: `${name}[]`, value: item });
    else parts.push({ name, value: String(value) });
  }
  const { raw, contentType } = multipart(parts);
  return api("POST", "/general/v0/general", { raw, contentType, ...options });
}

export const HEX32 = /^[0-9a-f]{32}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const types = (elements) => elements.map((element) => element.type);
