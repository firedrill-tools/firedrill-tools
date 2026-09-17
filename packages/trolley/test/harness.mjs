// Conformance harness: Trolley-shaped HTTP calls against `firedrill serve`, Node built-ins only.
import assert from "node:assert/strict";

export const HTTP = process.env.FIREDRILL_HTTP_URL;
export const TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
assert.ok(HTTP && TOKEN, "the http binding (FIREDRILL_HTTP_URL, FIREDRILL_HTTP_TOKEN) is required");

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function renderId(prefix, sequence) {
  let n = sequence;
  let out = "";
  while (n > 0) {
    out = ALPHABET[n % 62] + out;
    n = Math.floor(n / 62);
  }
  return `${prefix}-${out.padStart(22, "0")}`;
}
// Starter ids (see starter.json): recipients 1–14, accounts 101–113, batches 201–211, payments 301–322.
export const R = (n) => renderId("R", n);
export const A = (n) => renderId("A", 100 + n);
export const B = (n) => renderId("B", 200 + n);
export const P = (n) => renderId("P", 300 + n);
export const MERCHANT = "M-4Lk9Qx2Rb7Tn3Vw8Yz1Ca6";
export { assert };

/** Trolley-shaped request; asserts the status and returns the parsed JSON body. */
export async function api(method, path, { body, status = 200, scheme = "prsign", headers = {}, raw } = {}) {
  const init = { method, headers: { authorization: `${scheme} ${TOKEN}`, ...headers } };
  if (raw !== undefined) {
    init.body = raw;
  } else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${HTTP}${path}`, init);
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (response.status !== status) {
    throw new Error(`${method} ${path}: expected HTTP ${status}, got ${response.status}: ${text.slice(0, 800)}`);
  }
  if (status === 200) assert.equal(json?.ok, true, `${method} ${path}: success body must carry ok:true`);
  return json;
}

/** Asserts a Trolley error envelope with `code` (and `field` when given). */
export async function fails(method, path, status, code, { body, field, raw, headers } = {}) {
  const json = await api(method, path, { body, status, raw, headers });
  assert.equal(json?.ok, false, `${method} ${path}: error body must carry ok:false`);
  assert.ok(Array.isArray(json.errors) && json.errors.length >= 1, `${method} ${path}: errors array expected`);
  assert.equal(json.errors[0].code, code, `${method} ${path}: error code ${JSON.stringify(json.errors)}`);
  assert.equal(typeof json.errors[0].message, "string");
  if (field !== undefined) assert.equal(json.errors[0].field, field, `${method} ${path}: error field ${JSON.stringify(json.errors)}`);
  return json.errors[0];
}

/** Canonical operation call through the generic Firedrill HTTP binding. */
export async function operation(operationId, args = {}) {
  const response = await fetch(`${HTTP}/v1/operations/trolley/${operationId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  });
  const json = await response.json();
  assert.ok(json && json.outcome, `canonical ${operationId}: outcome expected`);
  return json.outcome;
}

const flows = new Map();
export function flow(name, run) {
  flows.set(name, run);
}

export async function main() {
  let task = "";
  for await (const chunk of process.stdin) task += chunk;
  const instruction = String(JSON.parse(task).instruction ?? "");
  const selected = [...flows.keys()].find((name) => instruction.includes(`the ${name} conformance flow`));
  if (selected === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
  await flows.get(selected)();
  // The target protocol reads exactly one JSON value from stdout; diagnostics go to stderr.
  process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
}
