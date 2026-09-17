// Shared helpers for the Attio conformance target. Node built-ins only.
import assert from "node:assert/strict";

export { assert };

const HTTP = process.env.FIREDRILL_HTTP_URL;
const TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
assert.ok(HTTP && TOKEN, "the Firedrill HTTP binding (FIREDRILL_HTTP_URL, FIREDRILL_HTTP_TOKEN) is required");

const record = (seq) => `00000004-0000-4000-8000-${String(seq).padStart(12, "0")}`;
export const ID = Object.freeze({
  priya: "00000009-0000-4000-8000-000000000001",
  tomas: "00000009-0000-4000-8000-000000000002",
  hana: "00000009-0000-4000-8000-000000000003",
  owen: "00000009-0000-4000-8000-000000000004",
  people: "00000002-0000-4000-8000-000000000001",
  companies: "00000002-0000-4000-8000-000000000002",
  deals: "00000002-0000-4000-8000-000000000003",
  halcyon: record(101), brightwater: record(102), norrland: record(103), cobalt: record(104), cobaltLegacy: record(105),
  meridian: record(106), juniper: record(107), atlas: record(108), ondine: record(109),
  zoe: record(111), marcus: record(112), samChen: record(113), samOkoro: record(114), ines: record(115), rafael: record(116),
  aiko: record(117), grace: record(118), leo: record(119), nadia: record(120), ben: record(121), chloe: record(122),
  halcyonRollout: record(131), brightwaterPilot: record(132), meridianExpansion: record(133), norrlandRenewal: record(134), atlasPoc: record(135),
  enterpriseList: "00000005-0000-4000-8000-000000000141",
  entry: (seq) => `00000006-0000-4000-8000-${String(seq).padStart(12, "0")}`,
  note: (seq) => `00000007-0000-4000-8000-${String(seq).padStart(12, "0")}`,
  task: (seq) => `00000008-0000-4000-8000-${String(seq).padStart(12, "0")}`,
  record,
});

/** Provider-shaped request; asserts the status and, for errors, Attio's envelope. Returns `{ json, headers }`. */
export async function api(method, path, { body, status = 200 } = {}) {
  const hasBody = body !== undefined;
  const response = await fetch(`${HTTP}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json", ...(hasBody ? { "content-type": "application/json" } : {}) },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    assert.fail(`${method} ${path}: response is not JSON: ${text.slice(0, 200)}`);
  }
  assert.equal(response.status, status, `${method} ${path} ${hasBody ? JSON.stringify(body).slice(0, 200) : ""} -> ${response.status} ${text.slice(0, 500)}`);
  if (status >= 400) {
    assert.equal(json.status_code, status, `${method} ${path}: status_code mirrors the HTTP status`);
    for (const key of ["type", "code", "message"]) assert.equal(typeof json[key], "string", `${method} ${path}: error envelope has ${key}`);
    assert.deepEqual(Object.keys(json).sort(), ["code", "message", "status_code", "type"], `${method} ${path}: error envelope keys`);
  }
  return { json, headers: response.headers };
}

export const get = (path, options) => api("GET", path, options);
export const post = (path, body, options) => api("POST", path, { ...options, body });
export const patch = (path, body, options) => api("PATCH", path, { ...options, body });
export const put = (path, body, options) => api("PUT", path, { ...options, body });
export const del = (path, options) => api("DELETE", path, options);

/** Expect an Attio error with `code` (and optionally a message fragment). */
export async function fails(method, path, body, status, code, fragment) {
  const { json, headers } = await api(method, path, { body, status });
  assert.equal(json.code, code, `${method} ${path}: expected code ${code}, got ${json.code} (${json.message})`);
  if (fragment !== undefined) assert.ok(json.message.includes(fragment), `${method} ${path}: message "${json.message}" should include "${fragment}"`);
  return { json, headers };
}

export const slugs = (items) => items.map((item) => item.api_slug);
export const first = (values, field) => (values.length === 0 ? undefined : values[0][field]);

/** One representative request per operation, in manifest order (used by auth, scope and fault drills). */
export const CALLS = [
  ["self.identify", "GET", "/v2/self"],
  ["objects.list", "GET", "/v2/objects"],
  ["attributes.list", "GET", "/v2/objects/people/attributes"],
  ["select-options.list", "GET", "/v2/objects/companies/attributes/categories/options"],
  ["statuses.list", "GET", "/v2/objects/deals/attributes/stage/statuses"],
  ["records.query", "POST", "/v2/objects/people/records/query", {}],
  ["records.get", "GET", `/v2/objects/people/records/${ID.marcus}`],
  ["records.create", "POST", "/v2/objects/companies/records", { data: { values: { name: "Probe Co" } } }],
  ["records.assert", "PUT", "/v2/objects/companies/records?matching_attribute=domains", { data: { values: { domains: "probe.example.com" } } }],
  ["records.update", "PATCH", `/v2/objects/people/records/${ID.marcus}`, { data: { values: { job_title: "CFO" } } }],
  ["records.delete", "DELETE", `/v2/objects/people/records/${ID.rafael}`],
  ["records.search", "POST", "/v2/objects/records/search", { query: "sam", objects: ["people"], request_as: { type: "workspace" } }],
  ["lists.list", "GET", "/v2/lists"],
  ["entries.query", "POST", "/v2/lists/recruiting/entries/query", {}],
  ["entries.create", "POST", "/v2/lists/recruiting/entries", { data: { parent_record_id: ID.aiko, parent_object: "people", entry_values: {} } }],
  ["entries.get", "GET", `/v2/lists/recruiting/entries/${ID.entry(156)}`],
  ["entries.update", "PATCH", `/v2/lists/recruiting/entries/${ID.entry(156)}`, { data: { entry_values: { role: "Probe" } } }],
  ["entries.delete", "DELETE", `/v2/lists/recruiting/entries/${ID.entry(156)}`],
  ["notes.list", "GET", "/v2/notes"],
  ["notes.get", "GET", `/v2/notes/${ID.note(171)}`],
  ["notes.create", "POST", "/v2/notes", { data: { parent_object: "people", parent_record_id: ID.rafael, title: "Probe", format: "plaintext", content: "Probe" } }],
  ["notes.delete", "DELETE", `/v2/notes/${ID.note(172)}`],
  ["tasks.list", "GET", "/v2/tasks"],
  ["tasks.create", "POST", "/v2/tasks", { data: { content: "Probe", format: "plaintext", deadline_at: null, is_completed: false, linked_records: [], assignees: [] } }],
  ["tasks.update", "PATCH", `/v2/tasks/${ID.task(181)}`, { data: { is_completed: true } }],
  ["tasks.delete", "DELETE", `/v2/tasks/${ID.task(186)}`],
  ["workspace-members.list", "GET", "/v2/workspace_members"],
];
export const WRITES = new Set(["records.create", "records.assert", "records.update", "records.delete", "entries.create", "entries.update", "entries.delete", "notes.create", "notes.delete", "tasks.create", "tasks.update", "tasks.delete"]);

/** A JSON body nested `depth` levels under `key` (arrays or objects), as raw text: JSON.stringify would recurse. */
export function deepBody(key, depth, shape = "array") {
  const [open, close] = shape === "array" ? ["[", "]"] : ['{"a":', "}"];
  return `{"${key}":${open.repeat(depth)}1${close.repeat(depth)}}`;
}

/** Send a raw body and return `{ status, json }` without asserting the Attio envelope (framework-owned 400s). */
export async function rawRequest(method, path, text) {
  const response = await fetch(`${HTTP}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json", "content-type": "application/json" },
    body: text,
  });
  const body = await response.text();
  let json;
  try { json = JSON.parse(body); } catch { json = body; }
  return { status: response.status, json };
}
