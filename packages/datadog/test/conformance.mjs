// Datadog Tool conformance target: a scripted Tool test, not a model-driven agent. Node built-ins only.
// Calls the Datadog-shaped routes (DD-API-KEY header, JSON bodies) at FIREDRILL_HTTP_URL, plus the canonical operation
// endpoint for canonical-only operations. Each drill instruction names one flow implemented in ./flows-*.mjs.
import assert from "node:assert/strict";
import { adminFlows } from "./flows-admin.mjs";
import { dataFlows } from "./flows-data.mjs";
import { faultFlows } from "./flows-faults.mjs";
import { identityFlows } from "./flows-identity.mjs";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const instruction = String(JSON.parse(task).instruction ?? "");
const flow = /Run the ([a-z-]+) flow/.exec(instruction)?.[1];
const BASE = process.env.FIREDRILL_HTTP_URL;
const TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
assert.ok(BASE && TOKEN, "the HTTP binding is required");

/** One Datadog route call. Asserts the status; errors must use `{ "errors": [string] }`. */
async function api(method, path, { body, status = 200, raw, headers = {}, contains } = {}) {
  const init = { method, headers: { "dd-api-key": TOKEN, "dd-application-key": "not-checked", ...headers } };
  if (body !== undefined || raw !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = raw ?? JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  assert.equal(response.status, status, `${method} ${path} → ${response.status} ${text.slice(0, 400)}`);
  if (status >= 400) {
    assert.ok(Array.isArray(json?.errors) && json.errors.length > 0 && json.errors.every((e) => typeof e === "string"), `${method} ${path} envelope: ${text.slice(0, 300)}`);
    if (contains !== undefined) assert.ok(json.errors[0].includes(contains), `${method} ${path} expected "${contains}" in ${json.errors[0]}`);
  }
  return { body: json, headers: response.headers };
}

/** Canonical operation call; returns the outcome. */
async function canonical(operation, args = {}) {
  const response = await fetch(`${BASE}/v1/operations/datadog/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  });
  const json = await response.json();
  assert.ok(json.outcome, `canonical ${operation}: ${JSON.stringify(json).slice(0, 300)}`);
  return json.outcome;
}

async function ok(operation, args = {}) {
  const outcome = await canonical(operation, args);
  assert.equal(outcome.status, "ok", `${operation}: ${JSON.stringify(outcome).slice(0, 400)}`);
  return outcome.value;
}

async function fails(operation, args, code, contains) {
  const outcome = await canonical(operation, args);
  assert.equal(outcome.status, "tool_error", `${operation} expected ${code}: ${JSON.stringify(outcome).slice(0, 400)}`);
  assert.equal(outcome.error.code, `tool.${code}`, `${operation}: ${JSON.stringify(outcome.error)}`);
  if (contains !== undefined) assert.ok(outcome.error.message.includes(contains), `${operation}: ${outcome.error.message}`);
  return outcome;
}

const qs = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return text.length > 0 ? `?${text}` : "";
};

const t = { api, canonical, ok, fails, qs, assert };
const flows = { ...adminFlows, ...dataFlows, ...identityFlows, ...faultFlows };
assert.ok(flow !== undefined && Object.hasOwn(flows, flow), `unknown flow in instruction: ${instruction}`);
await flows[flow](t);
process.stdout.write(JSON.stringify({ completed: true, flow }));
