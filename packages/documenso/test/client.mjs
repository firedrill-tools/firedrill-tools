// HTTP helpers for the Documenso conformance target (Node built-ins only).
import assert from "node:assert/strict";

const BASE = process.env.FIREDRILL_HTTP_URL;
const TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
assert.ok(BASE && TOKEN, "the HTTP binding is required (FIREDRILL_HTTP_URL / FIREDRILL_HTTP_TOKEN)");

/** Seeded ids (see starter.json). */
export const ENV = (id, prefix = "d") => `envelope_${`${prefix}${id}seed`.padEnd(16, "0")}`;
export const TOKEN_OF = (docId, n) => `tok_${docId}_${n}`.padEnd(21, "x");

/**
 * Calls a Documenso v2 route with the raw API key in Authorization. `expect` is a status or [status, code].
 * Error bodies are checked against the `{ message, code, issues? }` envelope.
 */
export async function api(method, path, expect = 200, { json, text, headers = {} } = {}) {
  const [status, code] = Array.isArray(expect) ? expect : [expect];
  const init = { method, headers: { authorization: TOKEN, ...headers } };
  if (json !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (text !== undefined) init.body = text;
  const response = await fetch(`${BASE}${path}`, init);
  const bodyText = await response.text();
  assert.equal(response.status, status, `${method} ${path} → ${response.status} ${bodyText.slice(0, 400)}`);
  const body = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
  if (status >= 400) {
    assert.equal(typeof body.message, "string", `${method} ${path}: error envelope message`);
    if (code !== undefined) assert.equal(body.code, code, `${method} ${path}: expected ${code}, got ${body.code} (${body.message})`);
    if (body.code === "BAD_REQUEST") assert.ok(Array.isArray(body.issues) && body.issues.length > 0, `${method} ${path}: BAD_REQUEST carries issues`);
  }
  return { status: response.status, body, headers: response.headers, bytes: Buffer.byteLength(bodyText) };
}

export const get = (path, expect, options) => api("GET", path, expect, options);
export const post = (path, json, expect = 200, options = {}) => api("POST", path, expect, { ...options, json });

/** multipart/form-data with a `payload` JSON part and a UTF-8 `file` part, as the v2 create route expects. */
export function multipart(payload, content, filename = "agreement.txt", boundary = "fdDocumensoBoundary9xQ") {
  const text = `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`;
  return { text, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

export const create = (payload, content, expect = 200, filename) => {
  const m = multipart(payload, content, filename);
  return api("POST", "/api/v2/document/create", expect, { text: m.text, headers: m.headers });
};

/** Invokes a canonical operation (used for the operations without a provider route). `expect` is "ok", "denied" or an error code. */
export async function op(operationId, args, expect = "ok") {
  const response = await fetch(`${BASE}/v1/operations/documenso/${operationId}`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ arguments: args }),
  });
  const text = await response.text();
  const outcome = JSON.parse(text).outcome ?? {};
  if (expect === "ok") {
    assert.equal(outcome.status, "ok", `${operationId}: ${text.slice(0, 400)}`);
    return outcome.value;
  }
  if (expect === "denied") {
    assert.equal(outcome.status, "denied", `${operationId}: ${text.slice(0, 400)}`);
    return outcome;
  }
  assert.equal(outcome.status, "tool_error", `${operationId}: ${text.slice(0, 400)}`);
  assert.ok(String(outcome.error?.code).endsWith(expect), `${operationId}: expected ${expect}, got ${outcome.error?.code} (${outcome.error?.message})`);
  return outcome;
}

/** One schema-valid call per API operation (routes) plus workspace.context, each expecting `expect(opId)` → [status, code]. */
export async function everyApiOperation(expect, ids = {}) {
  const doc = ids.doc ?? 1010;
  const calls = [
    ["documents.find", (e) => get("/api/v2/document", e)],
    ["documents.get", (e) => get(`/api/v2/document/${doc}`, e)],
    ["documents.create", (e) => create(ids.createPayload ?? { title: "Probe" }, "probe", e)],
    ["documents.update", (e) => post("/api/v2/document/update", { documentId: doc, data: { externalId: "probe" } }, e)],
    ["documents.delete", (e) => post("/api/v2/document/delete", { documentId: doc }, e)],
    ["documents.duplicate", (e) => post("/api/v2/document/duplicate", { documentId: doc }, e)],
    ["documents.distribute", (e) => post("/api/v2/document/distribute", { documentId: doc }, e)],
    ["documents.redistribute", (e) => post("/api/v2/document/redistribute", { documentId: doc, recipients: [ids.recipient ?? 3016] }, e)],
    ["envelopes.cancel", (e) => post("/api/v2/envelope/cancel", { envelopeId: ENV(doc) }, e)],
    ["envelopes.audit_log", (e) => get(`/api/v2/envelope/${ENV(doc)}/audit-log`, e)],
    ["recipients.get", (e) => get(`/api/v2/document/recipient/${ids.recipient ?? 3016}`, e)],
    ["recipients.create_many", (e) => post("/api/v2/document/recipient/create-many", { documentId: doc, recipients: [{ email: "probe@example.com", name: "Probe", role: "SIGNER" }] }, e)],
    ["recipients.update", (e) => post("/api/v2/document/recipient/update", { documentId: doc, recipient: { id: ids.recipient ?? 3016, name: "Probe" } }, e)],
    ["recipients.delete", (e) => post("/api/v2/document/recipient/delete", { recipientId: ids.recipient ?? 3016 }, e)],
    ["recipients.reject", (e) => post(`/api/v2/envelope/recipient/${ids.recipient ?? 3016}/reject`, { envelopeId: ENV(doc), reason: "Probe" }, e)],
    ["fields.get", (e) => get(`/api/v2/document/field/${ids.field ?? 4020}`, e)],
    ["fields.create_many", (e) => post("/api/v2/document/field/create-many", { documentId: doc, fields: [{ recipientId: ids.recipient ?? 3016, type: "TEXT", pageNumber: 1, pageX: 10, pageY: 10, width: 20, height: 5 }] }, e)],
    ["fields.delete", (e) => post("/api/v2/document/field/delete", { fieldId: ids.field ?? 4020 }, e)],
    ["templates.find", (e) => get("/api/v2/template", e)],
    ["templates.get", (e) => get("/api/v2/template/2001", e)],
    ["templates.use", (e) => post("/api/v2/template/use", { templateId: 2001, recipients: [] }, e)],
  ];
  for (const [operationId, call] of calls) await call(expect(operationId));
  return calls.length;
}
