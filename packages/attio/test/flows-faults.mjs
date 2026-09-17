// Authentication, denial, fault, scan-bound and response-size flows.
import { CALLS, ID, WRITES, api, assert, fails, get, post } from "./lib.mjs";

async function everyCall(status, code, fragment, filter = () => true) {
  for (const [operation, method, path, body] of CALLS.filter(([operation]) => filter(operation))) {
    const { headers } = await fails(method, path, body, status, code, fragment);
    if (status === 429) assert.equal(headers.get("retry-after"), "1", `${operation}: Retry-After`);
  }
}

async function invalidAuthFlow() {
  await everyCall(401, "invalid_api_key", "invalid");
}

async function suspendedFlow() {
  await everyCall(403, "unauthorized", "Workspace member is suspended.");
}

async function deniedFlow() {
  const self = await api("GET", "/v2/self", { status: 403 });
  assert.equal(self.json.code, "unauthorized");
  await fails("POST", "/v2/notes", { data: { parent_object: "people", parent_record_id: ID.rafael, title: "x", format: "plaintext", content: "x" } }, 403, "unauthorized");
}

async function rateLimitedFlow() {
  await everyCall(429, "rate_limit_exceeded", "Rate limit exceeded");
}

async function writeUnavailableFlow() {
  await everyCall(503, "service_unavailable", "temporarily unavailable", (operation) => WRITES.has(operation));
  assert.equal((await post("/v2/objects/people/records/query", {})).json.data.length, 12);
  assert.equal((await get("/v2/tasks")).json.data.length, 7);
}

async function createCommittedLostFlow() {
  const lena = { data: { values: { name: "Lena Park", email_addresses: "lena.park@example.com" } } };
  await fails("POST", "/v2/objects/people/records", lena, 503, "service_unavailable");
  const found = (await post("/v2/objects/people/records/query", { filter: { email_addresses: "lena.park@example.com" } })).json.data;
  assert.equal(found.length, 1, "the lost create committed");
  await fails("POST", "/v2/objects/people/records", lena, 409, "uniqueness_conflict", "lena.park@example.com");
  const kite = { data: { values: { name: "Kite Robotics" } } };
  await fails("POST", "/v2/objects/companies/records", kite, 503, "service_unavailable");
  await fails("POST", "/v2/objects/companies/records", kite, 503, "service_unavailable");
  assert.equal((await post("/v2/objects/companies/records/query", { filter: { name: "Kite Robotics" } })).json.data.length, 2, "a blind retry duplicates");
  await fails("POST", "/v2/tasks", { data: { content: "Lost response", format: "plaintext", deadline_at: null, is_completed: false, linked_records: [], assignees: [] } }, 503, "service_unavailable");
  assert.equal((await get("/v2/tasks")).json.data.length, 8);
}

async function tightLimitsFlow() {
  const bound = "state exceeds the supported bound of 3 rows";
  const email = "bound.check@example.com";
  const probes = [
    ["POST", "/v2/objects/people/records/query", {}],
    ["POST", "/v2/objects/people/records", { data: { values: { name: "Bound", email_addresses: email } } }],
    ["PUT", "/v2/objects/people/records?matching_attribute=email_addresses", { data: { values: { email_addresses: email } } }],
    ["PATCH", `/v2/objects/people/records/${ID.marcus}`, { data: { values: { email_addresses: email } } }],
    ["DELETE", `/v2/objects/people/records/${ID.rafael}`],
    ["POST", "/v2/objects/records/search", { query: "sam", objects: ["people"], request_as: { type: "workspace" } }],
    ["GET", "/v2/lists"],
    ["POST", "/v2/lists/enterprise_accounts/entries/query", {}],
    ["GET", "/v2/notes"],
    ["GET", "/v2/tasks"],
    ["POST", "/v2/tasks", { data: { content: "Bound", format: "plaintext", deadline_at: null, is_completed: false, linked_records: [{ target_object: "people", email_addresses: "zoe.lindqvist@halcyonfreight.example.com" }], assignees: [] } }],
    ["PATCH", `/v2/tasks/${ID.task(181)}`, { data: { linked_records: [{ target_object: "companies", domains: "halcyonfreight.example.com" }] } }],
    ["GET", "/v2/workspace_members"],
  ];
  for (const [method, path, body] of probes) await fails(method, path, body, 400, "state_bound_exceeded", bound);
  assert.equal((await get(`/v2/objects/people/records/${ID.marcus}`)).json.data.id.record_id, ID.marcus, "reads by id do not scan");
  assert.equal((await get("/v2/objects")).json.data.length, 3);
}

async function largeNotesFlow() {
  const content = "x".repeat(95_000);
  for (let index = 0; index < 10; index += 1) {
    await post("/v2/notes", { data: { parent_object: "people", parent_record_id: ID.rafael, title: `Transcript ${index + 1}`, format: "plaintext", content } });
  }
  const base = `/v2/notes?parent_object=people&parent_record_id=${ID.rafael}`;
  await fails("GET", `${base}&limit=50`, undefined, 400, "state_bound_exceeded", "Response too large; lower limit");
  assert.equal((await get(`${base}&limit=4`)).json.data.length, 4);
  const tail = (await get(`${base}&limit=4&offset=8`)).json.data;
  assert.equal(tail.length, 3, "11 notes: 10 transcripts plus the seeded screen");
  assert.equal(tail[tail.length - 1].id.note_id, ID.note(176));
}

export const faultFlows = {
  "invalid-auth": invalidAuthFlow,
  "suspended-member": suspendedFlow,
  denied: deniedFlow,
  "rate-limited": rateLimitedFlow,
  "write-unavailable": writeUnavailableFlow,
  "create-committed-lost": createCommittedLostFlow,
  "tight-limits": tightLimitsFlow,
  "large-notes": largeNotesFlow,
};
