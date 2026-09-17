// Shared transport helpers and starter ids for the conformance flows. Node built-ins only.
import assert from "node:assert/strict";

export const HTTP = process.env.FIREDRILL_HTTP_URL;
export const HTTP_TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
export const MCP = process.env.FIREDRILL_MCP_URL;
export const MCP_TOKEN = process.env.FIREDRILL_MCP_TOKEN;
assert.ok(HTTP && HTTP_TOKEN && MCP && MCP_TOKEN, "HTTP and MCP bindings are required");

const P = "68c8000000000000000";
export const id = (suffix) => `${P}${String(suffix).padStart(5, "0")}`;
export const WS = "68c8000000000000000000a1";
export const NOW = "2026-09-16T09:00:00.000Z";
export const C = { main: id("0201"), readonly: id("0202"), chat: id("0203"), mail: id("0204"), paused: id("0205"), broken: id("0206"), hris: id("0207"), sandbox: id("0208"), omni: id("0209"), none: id("0999") };
export const CO = { northwind: id("0401"), contoso: id("0402"), fabrikam: id("0403"), tailspin: id("0404"), yamada: id("0405") };
export const K = { elena: id("0501"), tomas: id("0502"), priya: id("0503"), jonas: id("0504"), ravi: id("0505"), ana: id("0506"), liwei: id("0507"), sam: id("0508"), dana: id("0509"), sandbox: id("0510") };
export const D = { q4: id("0601"), renewal: id("0602"), pilot: id("0603"), rebrand: id("0604"), logistics: id("0605"), inbound: id("0606") };
export const PL = { sales: id("0301"), renewals: id("0302"), qualification: id("0311"), proposal: id("0312"), negotiation: id("0313"), won: id("0314"), lost: id("0315"), upcoming: id("0321") };
export const CH = { general: id("0701"), sales: id("0702"), exec: id("0703"), emea: id("0704"), inbox: id("0711"), sent: id("0712"), draft: id("0713") };
export const MSG = (n) => id((0x0800 + n).toString(16).padStart(4, "0"));
export const NEW = (n) => `68c8${"0".repeat(14)}${(4096 + n).toString(16).padStart(6, "0")}`;
export const NONE = id("0999");

export const ALL_OPERATIONS = [
  "connections.list", "connections.get", "connections.create", "connections.update", "connections.remove",
  ...["contacts", "companies", "deals"].flatMap((p) => ["list", "get", "create", "update", "remove"].map((v) => `${p}.${v}`)),
  "pipelines.list", "pipelines.get", "channels.list", "channels.get",
  "messages.list", "messages.get", "messages.create", "messages.update", "messages.remove",
];
export const ALIASES = ["list_unified_connections", "get_unified_connection", "create_unified_connection", "update_unified_connection", "remove_unified_connection"];

/** Provider-shaped request; asserts the status and returns the parsed body, raw text and headers. */
export async function api(method, path, { body, status = 200, rawBody, contentType, headers = {} } = {}) {
  const hasBody = body !== undefined || rawBody !== undefined;
  const response = await fetch(`${HTTP}${path}`, {
    method,
    headers: { authorization: `Bearer ${HTTP_TOKEN}`, ...(hasBody ? { "content-type": contentType ?? "application/json" } : {}), ...headers },
    ...(hasBody ? { body: rawBody ?? JSON.stringify(body) } : {}),
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
export const patch = (path, body, options) => api("PATCH", path, { ...options, body });
export const del = (path, options) => api("DELETE", path, options);

/** Expects the Tool's error envelope `{ statusCode, message, error }` with the given status and a message fragment. */
export async function apiError(method, path, status, fragment, options = {}) {
  const result = await api(method, path, { ...options, status });
  assert.ok(result.json && typeof result.json === "object", `${method} ${path}: no JSON envelope: ${result.text.slice(0, 300)}`);
  assert.equal(result.json.statusCode, status, `${method} ${path}: envelope statusCode ${JSON.stringify(result.json).slice(0, 300)}`);
  assert.equal(typeof result.json.message, "string", `${method} ${path}: envelope message missing`);
  assert.equal(typeof result.json.error, "string", `${method} ${path}: envelope reason missing`);
  if (fragment) assert.ok(result.json.message.includes(fragment), `${method} ${path}: expected ${JSON.stringify(fragment)} in ${result.json.message.slice(0, 300)}`);
  return result;
}

/** Canonical operation endpoint; `expected` is "ok" or a Tool error code. */
export async function op(operationId, args, expected = "ok") {
  const response = await fetch(`${HTTP}/v1/operations/unified/${operationId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  });
  const json = await response.json();
  assert.ok(json.outcome, `canonical ${operationId}: ${JSON.stringify(json).slice(0, 300)}`);
  if (expected === "ok") {
    assert.equal(json.outcome.status, "ok", `${operationId} ${JSON.stringify(args).slice(0, 200)}: ${JSON.stringify(json.outcome).slice(0, 400)}`);
    return json.outcome.value;
  }
  assert.equal(json.outcome.status, "tool_error", `${operationId}: ${JSON.stringify(json.outcome).slice(0, 400)}`);
  assert.equal(json.outcome.error.code, `tool.${expected}`, `${operationId}: ${JSON.stringify(json.outcome.error)}`);
  return json.outcome.error;
}

let rpcId = 0;
export async function rpc(method, params) {
  const response = await fetch(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${MCP_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  assert.equal(response.status, 200, `MCP ${method} -> HTTP ${response.status}`);
  const text = await response.text();
  const messages = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim()))
    : [JSON.parse(text)];
  const reply = messages.find((message) => message.id === rpcId);
  assert.ok(reply, `MCP ${method}: no JSON-RPC reply`);
  if (reply.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}
export const mcpInit = () => rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "unified-conformance", version: "0.1.0" } });
/** Successful tool call; array results arrive wrapped as `{ result: [...] }`, objects verbatim. */
export async function mcp(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(!result.isError, `${name} ${JSON.stringify(args)}: ${JSON.stringify(result).slice(0, 500)}`);
  return result.structuredContent;
}
export async function mcpError(name, args, code) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(result.isError, `${name} ${JSON.stringify(args)} unexpectedly succeeded`);
  // Operations with an array output carry the failure under `result`, object-valued ones at the top level.
  const failure = result.structuredContent?.status === "tool_error" ? result.structuredContent : result.structuredContent?.result;
  if (code) assert.equal(failure?.error?.code, `tool.${code}`, JSON.stringify(result).slice(0, 400));
  return failure;
}

export const ids = (items) => items.map((item) => item.id);
export const noneHas = (items, key) => items.every((item) => !Object.hasOwn(item, key));
/** Walks an offset-paged list until a short page; returns every row. */
export async function walk(path, limit, expectedPages) {
  const rows = [];
  const sizes = [];
  for (let offset = 0; ; offset += limit) {
    const page = (await get(`${path}${path.includes("?") ? "&" : "?"}limit=${limit}&offset=${offset}`)).json;
    sizes.push(page.length);
    rows.push(...page);
    if (page.length < limit) break;
  }
  if (expectedPages) assert.deepEqual(sizes, expectedPages, `${path} pages`);
  return rows;
}
export { assert };
