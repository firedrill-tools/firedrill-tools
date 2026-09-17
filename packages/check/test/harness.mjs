// Conformance harness: Check-shaped HTTP calls against `firedrill serve`, Node built-ins only.
import assert from "node:assert/strict";
export { IDS } from "./ids.mjs";
export { assert };

export const HTTP = process.env.FIREDRILL_HTTP_URL;
export const TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
assert.ok(HTTP && TOKEN, "the http binding (FIREDRILL_HTTP_URL, FIREDRILL_HTTP_TOKEN) is required");

/** Check-shaped request; asserts the status and returns the parsed JSON body (undefined for 204). */
export async function api(method, path, { body, status = 200, headers = {}, raw } = {}) {
  const init = { method, headers: { authorization: `Bearer ${TOKEN}`, ...headers } };
  if (raw !== undefined) {
    init.body = raw;
    init.headers["content-type"] ??= "application/json";
  } else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${HTTP}${path}`, init);
  const text = await response.text();
  if (response.status !== status) throw new Error(`${method} ${path}: expected HTTP ${status}, got ${response.status}: ${text.slice(0, 800)}`);
  if (status === 204) {
    assert.equal(text, "", `${method} ${path}: 204 must have an empty body`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path}: body is not JSON: ${text.slice(0, 200)}`);
  }
}

/** Asserts Check's error envelope with `type`, and the first input error's dotted `field_path` when given. */
export async function fails(method, path, status, type, { body, fieldPath, message, raw, headers } = {}) {
  const json = await api(method, path, { body, status, raw, headers });
  assert.ok(json && json.error && typeof json.error === "object", `${method} ${path}: error envelope expected, got ${JSON.stringify(json)}`);
  assert.equal(json.error.type, type, `${method} ${path}: error type in ${JSON.stringify(json.error)}`);
  assert.equal(typeof json.error.message, "string");
  if (fieldPath !== undefined) {
    assert.ok(Array.isArray(json.error.input_errors) && json.error.input_errors.length >= 1, `${method} ${path}: input_errors expected in ${JSON.stringify(json.error)}`);
    const first = json.error.input_errors[0];
    assert.equal(first.field_path.join("."), fieldPath, `${method} ${path}: field_path in ${JSON.stringify(json.error)}`);
    assert.equal(first.field, first.field_path.filter((part) => !/^[0-9]+$/.test(part)).pop());
  }
  if (message !== undefined) {
    const texts = [json.error.message, ...(json.error.input_errors ?? []).map((entry) => entry.message)];
    assert.ok(texts.some((t) => t.includes(message)), `${method} ${path}: message "${message}" not in ${JSON.stringify(json.error)}`);
  }
  return json.error;
}

/** Canonical operation call through the generic Firedrill HTTP binding; returns the outcome. */
export async function operation(operationId, args = {}) {
  const response = await fetch(`${HTTP}/v1/operations/check/${operationId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  });
  const json = await response.json();
  assert.ok(json && json.outcome, `canonical ${operationId}: outcome expected`);
  return json.outcome;
}

/** Path and query of a `next`/`previous` URL (root-relative). */
export const follow = (link) => {
  assert.equal(typeof link, "string", "page link expected");
  assert.ok(link.startsWith("/"), `root-relative link expected: ${link}`);
  return link;
};

export const cents = (amount) => {
  const [whole, fraction = "00"] = amount.replace("-", "").split(".");
  return (amount.startsWith("-") ? -1 : 1) * (Number(whole) * 100 + Number(fraction.padEnd(2, "0")));
};
export const money = (c) => `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;

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
  process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
}
