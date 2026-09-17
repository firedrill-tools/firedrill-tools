// Transport and assertion helpers for the Xero Tool conformance target. Node built-ins only.
import assert from "node:assert/strict";

export const HTTP = process.env.FIREDRILL_HTTP_URL;
export const TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
export const MCP = process.env.FIREDRILL_MCP_URL;
export const MCP_TOKEN = process.env.FIREDRILL_MCP_TOKEN;
assert.ok(HTTP && TOKEN && MCP && MCP_TOKEN, "HTTP and MCP bindings are required");

export const TENANT = "6d1c2f0e-4b8a-4c3e-9a51-2f7e0b9d4c11";
export const X = "/api.xro/2.0";
const pad = (n) => String(n).padStart(2, "0");
export const acc = (n) => `ac000000-0000-4000-8000-0000000000${pad(n)}`;
export const con = (n) => `c0000000-0000-4000-8000-0000000000${pad(n)}`;
export const inv = (n) => `a0000000-0000-4000-8000-0000000000${pad(n)}`;
export const pay = (n) => `b0000000-0000-4000-8000-0000000000${pad(n)}`;
export const MISSING = "0f0f0f0f-0000-4000-8000-000000000000";
export const q = (params) => `?${new URLSearchParams(params).toString()}`;

/** Xero-shaped request. Asserts the HTTP status; returns { status, json, text, headers }. */
export async function api(method, path, { body, status = 200, tenant = TENANT, headers = {}, raw } = {}) {
  const h = { authorization: `Bearer ${TOKEN}`, accept: "application/json", ...headers };
  if (tenant !== null) h["xero-tenant-id"] = tenant;
  let payload;
  if (raw !== undefined) {
    h["content-type"] = "application/json";
    payload = raw;
  } else if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${HTTP}${X}${path}`, { method, headers: h, body: payload });
  const text = await response.text();
  const type = response.headers.get("content-type") ?? "";
  const json = type.includes("json") && text.length > 0 ? JSON.parse(text) : undefined;
  assert.equal(response.status, status, `${method} ${path} ${String(payload ?? "").slice(0, 200)} -> ${response.status} ${text.slice(0, 600)}`);
  return { status: response.status, json, text, headers: response.headers };
}
export const get = (path, options) => api("GET", path, options);
export const put = (path, body, options) => api("PUT", path, { ...options, body });
export const post = (path, body, options) => api("POST", path, { ...options, body });

/** Expect a Xero error object (400 ValidationException / QueryParseException / PostDataInvalidException). */
export async function xeroError(method, path, errorNumber, { body, raw, includes, status = 400 } = {}) {
  const { json } = await api(method, path, { body, raw, status });
  assert.ok(json && json.ErrorNumber === errorNumber, `${method} ${path}: expected ErrorNumber ${errorNumber}, got ${JSON.stringify(json).slice(0, 500)}`);
  if (includes !== undefined) assert.ok(JSON.stringify(json).includes(includes), `${method} ${path}: body lacks ${JSON.stringify(includes)}: ${JSON.stringify(json).slice(0, 600)}`);
  return json;
}
export const validation = (method, path, body, includes) => xeroError(method, path, 10, { body, includes });

export async function notFound(method, path, body) {
  const { text } = await api(method, path, { body, status: 404 });
  assert.equal(text, "The resource you're looking for cannot be found");
}

/** Canonical Firedrill operation call; asserts outcome status and (for tool errors) the code. */
export async function op(name, args, { code, idempotencyKey } = {}) {
  const response = await fetch(`${HTTP}/v1/operations/xero/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }),
  });
  const result = await response.json();
  assert.ok(result.outcome, `${name}: HTTP ${response.status} ${JSON.stringify(result).slice(0, 400)}`);
  const { outcome } = result;
  if (code === undefined) assert.equal(outcome.status, "ok", `${name} ${JSON.stringify(args).slice(0, 200)}: ${JSON.stringify(outcome).slice(0, 600)}`);
  else if (code === "denied") assert.equal(outcome.status, "denied", `${name}: ${JSON.stringify(outcome).slice(0, 400)}`);
  else assert.equal(outcome.error?.code, `tool.${code}`, `${name} ${JSON.stringify(args).slice(0, 200)}: ${JSON.stringify(outcome).slice(0, 600)}`);
  return outcome;
}

let rpcId = 0;
export async function rpc(method, params) {
  const response = await fetch(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${MCP_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  assert.equal(response.status, 200, `MCP ${method} -> HTTP ${response.status}`);
  const raw = await response.text();
  const type = response.headers.get("content-type") ?? "";
  const messages = type.includes("text/event-stream")
    ? raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim()))
    : [JSON.parse(raw)];
  const reply = messages.find((message) => message.id === rpcId);
  assert.ok(reply, `MCP ${method}: no JSON-RPC reply`);
  if (reply.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}
export async function mcp(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(!result.isError, `${name} ${JSON.stringify(args).slice(0, 300)}: ${JSON.stringify(result).slice(0, 600)}`);
  return result.structuredContent;
}
export async function mcpError(name, args, code) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(result.isError, `${name} ${JSON.stringify(args).slice(0, 300)} unexpectedly succeeded`);
  assert.equal(result.structuredContent?.error?.code, `tool.${code}`, `${name}: ${JSON.stringify(result).slice(0, 400)}`);
}

const probeLine = [{ Description: "Probe", Quantity: 1, UnitAmount: 10, AccountCode: "200" }];
/** One schema-valid call per operation: ["rest", method, path, body] or ["op", name, args]. */
export const CALLS = new Map([
  ["organisation.get", ["rest", "GET", "/Organisation"]],
  ["accounts.list", ["rest", "GET", "/Accounts"]],
  ["accounts.get", ["rest", "GET", `/Accounts/${acc(1)}`]],
  ["tax-rates.list", ["rest", "GET", "/TaxRates"]],
  ["contacts.list", ["rest", "GET", "/Contacts"]],
  ["contacts.get", ["rest", "GET", "/Contacts/CUST-003"]],
  ["contacts.save", ["rest", "PUT", "/Contacts", { Name: "Probe Contact" }]],
  ["contacts.create", ["op", "contacts.create", { name: "Probe MCP Contact" }]],
  ["contacts.update", ["op", "contacts.update", { contactId: con(1), name: "Harbourside Café" }]],
  ["invoices.list", ["rest", "GET", "/Invoices"]],
  ["invoices.get", ["rest", "GET", "/Invoices/INV-1006"]],
  ["invoices.save", ["rest", "PUT", "/Invoices", { Type: "ACCREC", Contact: { ContactID: con(1) }, LineItems: probeLine }]],
  ["invoices.create", ["op", "invoices.create", { contactId: con(1), type: "ACCREC", lineItems: [{ description: "Probe", quantity: 1, unitAmount: 10, accountCode: "200", taxType: "OUTPUT2" }] }]],
  ["invoices.update", ["op", "invoices.update", { invoiceId: inv(13), reference: "Probe" }]],
  ["invoices.email", ["rest", "POST", `/Invoices/${inv(9)}/Email`, {}]],
  ["payments.list", ["rest", "GET", "/Payments"]],
  ["payments.get", ["rest", "GET", `/Payments/${pay(4)}`]],
  ["payments.create", ["rest", "PUT", "/Payments", { Invoice: { InvoiceID: inv(8) }, Account: { Code: "090" }, Amount: 1 }]],
  ["payments.record", ["op", "payments.record", { invoiceId: inv(8), accountId: acc(1), amount: 1 }]],
  ["payments.delete", ["rest", "POST", `/Payments/${pay(4)}`, { Status: "DELETED" }]],
]);

/** Run the representative call of each operation, expecting an HTTP status (REST) or outcome code (canonical). */
export async function probe(operations, { http, code }) {
  for (const id of operations) {
    const call = CALLS.get(id);
    if (call[0] === "rest") await api(call[1], call[2], { body: call[3], status: http });
    else await op(call[1], call[2], { code });
  }
}

/** Key names in document order, depth-first, so two bodies can be compared for field order as well as content. */
export function keyOrder(value, path = "$", out = []) {
  if (Array.isArray(value)) value.forEach((item, i) => keyOrder(item, `${path}[${i}]`, out));
  else if (value !== null && typeof value === "object") for (const key of Object.keys(value)) { out.push(`${path}.${key}`); keyOrder(value[key], `${path}.${key}`, out); }
  return out;
}

/** Sends a write twice with the same Idempotency-Key and asserts the replay is the first body in the same field order (Id aside). */
export async function replayed(method, path, body, key) {
  const first = await api(method, path, { body, headers: { "idempotency-key": key } });
  const replay = await api(method, path, { body, headers: { "idempotency-key": key } });
  assert.notEqual(replay.json.Id, first.json.Id, "each response carries its own Id, as on Xero");
  const strip = (json) => ({ ...json, Id: "same" });
  assert.deepEqual(strip(replay.json), strip(first.json), `${method} ${path}: replay content differs`);
  assert.deepEqual(keyOrder(strip(replay.json)), keyOrder(strip(first.json)), `${method} ${path}: replay field order differs`);
  assert.equal(JSON.stringify(strip(replay.json)), JSON.stringify(strip(first.json)), `${method} ${path}: replay text differs`);
  return first.json;
}
