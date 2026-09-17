// HubSpot Tool conformance target. A scripted Tool test, not a model-driven agent.
// Node built-ins only: fetch against the HubSpot-shaped REST routes and raw MCP JSON-RPC (Streamable HTTP)
// for the HubSpot MCP server tool-name aliases. Every flow fails loudly on an unexpected status, header or body.
import assert from "node:assert/strict";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const invocation = JSON.parse(task);
const instruction = String(invocation.instruction ?? "");

const HTTP = process.env.FIREDRILL_HTTP_URL;
const HTTP_TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
const MCP = process.env.FIREDRILL_MCP_URL;
const MCP_TOKEN = process.env.FIREDRILL_MCP_TOKEN;
assert.ok(HTTP && HTTP_TOKEN && MCP && MCP_TOKEN, "HTTP and MCP bindings are required");

const ALL_OPERATIONS = [
  "account.get-details",
  "objects.list",
  "objects.get",
  "objects.create",
  "objects.update",
  "objects.archive",
  "objects.batch-read",
  "objects.batch-create",
  "objects.batch-update",
  "objects.search",
  "associations.list",
  "associations.create-default",
  "associations.create",
  "associations.batch-create",
  "associations.archive",
  "associations.batch-read",
  "associations.list-labels",
  "owners.list",
  "owners.get",
  "pipelines.list",
  "pipelines.get",
  "pipelines.list-stages",
  "properties.list",
  "properties.get",
];
const ALIASES = [
  "hubspot-get-user-details",
  "hubspot-list-objects",
  "hubspot-batch-read-objects",
  "hubspot-batch-create-objects",
  "hubspot-batch-update-objects",
  "hubspot-search-objects",
  "hubspot-list-associations",
  "hubspot-batch-create-associations",
  "hubspot-get-association-definitions",
  "hubspot-list-properties",
  "hubspot-get-property",
];
const HS = "HUBSPOT_DEFINED";
const C = "/crm/v3/objects/contacts";
const CO = "/crm/v3/objects/companies";
const D = "/crm/v3/objects/deals";
const A = "/crm/v4/objects";

/** One representative request per operation (used by the auth, scope and fault drills). */
const CALLS = [
  ["GET", "/account-info/v3/details"],
  ["GET", C],
  ["GET", `${C}/101`],
  ["POST", C, { properties: { firstname: "Probe" } }],
  ["PATCH", `${C}/101`, { properties: { firstname: "Probe" } }],
  ["DELETE", `${C}/101`],
  ["POST", `${C}/batch/read`, { inputs: [{ id: "101" }] }],
  ["POST", `${CO}/batch/create`, { inputs: [{ properties: { name: "Probe Co" } }] }],
  ["POST", `${D}/batch/update`, { inputs: [{ id: "301", properties: { amount: "1" } }] }],
  ["POST", `${C}/search`, {}],
  ["GET", `${A}/contacts/101/associations/companies`],
  ["PUT", `${A}/contacts/102/associations/default/companies/203`],
  ["PUT", `${A}/contacts/102/associations/companies/203`, [{ associationCategory: HS, associationTypeId: 279 }]],
  ["POST", "/crm/v4/associations/contacts/deals/batch/create", { inputs: [{ from: { id: "113" }, to: { id: "303" }, types: [{ associationCategory: HS, associationTypeId: 4 }] }] }],
  ["DELETE", `${A}/contacts/101/associations/companies/201`],
  ["POST", "/crm/v4/associations/contacts/companies/batch/read", { inputs: [{ id: "101" }] }],
  ["GET", "/crm/v4/associations/contacts/companies/labels"],
  ["GET", "/crm/v3/owners"],
  ["GET", "/crm/v3/owners/41001"],
  ["GET", "/crm/v3/pipelines/deals"],
  ["GET", "/crm/v3/pipelines/deals/default"],
  ["GET", "/crm/v3/pipelines/deals/default/stages"],
  ["GET", "/crm/v3/properties/contacts"],
  ["GET", "/crm/v3/properties/contacts/email"],
];
const WRITE_CALLS = [3, 4, 5, 7, 8, 11, 12, 13, 14].map((index) => CALLS[index]);

// ---------------------------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------------------------

/** HubSpot-shaped request. `status` is asserted; the JSON body (if any) and headers are returned. */
async function api(method, path, { body, status = 200, headers = {}, contentType, rawBody } = {}) {
  const hasBody = body !== undefined || rawBody !== undefined;
  const response = await fetch(`${HTTP}${path}`, {
    method,
    headers: { authorization: `Bearer ${HTTP_TOKEN}`, accept: "application/json", ...(hasBody ? { "content-type": contentType ?? "application/json" } : {}), ...headers },
    ...(hasBody ? { body: rawBody ?? JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const json = text.length > 0 ? JSON.parse(text) : undefined;
  assert.equal(response.status, status, `${method} ${path} ${body === undefined ? "" : JSON.stringify(body).slice(0, 200)} -> ${response.status} ${text.slice(0, 400)}`);
  if (response.status !== 204) {
    assert.ok(response.headers.get("x-hubspot-correlation-id"), `${method} ${path}: missing X-HubSpot-Correlation-Id`);
    assert.equal(response.headers.get("x-hubspot-ratelimit-daily"), "250000", `${method} ${path}: missing rate-limit headers`);
  }
  return { json, headers: response.headers, status: response.status };
}
const get = (path, options) => api("GET", path, options);
const post = (path, body, options) => api("POST", path, { ...options, body });
const patch = (path, body, options) => api("PATCH", path, { ...options, body });
const put = (path, body, options) => api("PUT", path, { ...options, body });
const del = (path, options) => api("DELETE", path, { ...options, status: 204 });

/** Expect a HubSpot error envelope: status, `category`, and a message (or errors[].message) containing `text`. */
async function apiError(method, path, status, category, text, options = {}) {
  const result = await api(method, path, { ...options, status });
  const body = result.json;
  assert.ok(body && body.status === "error" && typeof body.message === "string", `${method} ${path}: no HubSpot error envelope: ${JSON.stringify(body)}`);
  assert.equal(body.category, category, `${method} ${path}: ${JSON.stringify(body)}`);
  assert.ok(typeof body.correlationId === "string" && body.correlationId.length > 0, `${method} ${path}: no correlationId`);
  if (text !== undefined) {
    const texts = [body.message, ...(Array.isArray(body.errors) ? body.errors.map((error) => error.message ?? "") : [])];
    assert.ok(texts.some((candidate) => candidate.includes(text)), `${method} ${path}: expected text ${JSON.stringify(text)}, got ${JSON.stringify(body)}`);
  }
  return result;
}
const call = ([method, path, body], options) => api(method, path, { ...options, ...(body === undefined ? {} : { body }) });
const callError = ([method, path, body], status, category, text) => apiError(method, path, status, category, text, body === undefined ? {} : { body });

let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${MCP_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  assert.equal(response.status, 200, `MCP ${method} -> HTTP ${response.status}`);
  const text = await response.text();
  const type = response.headers.get("content-type") ?? "";
  const messages = type.includes("text/event-stream")
    ? text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5).trim()))
    : [JSON.parse(text)];
  const reply = messages.find((message) => message.id === rpcId);
  assert.ok(reply, `MCP ${method}: no JSON-RPC reply`);
  if (reply.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}
async function mcpInit() {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hubspot-conformance", version: "0.1.0" } });
}
async function mcp(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(!result.isError, `${name} ${JSON.stringify(args)}: ${JSON.stringify(result).slice(0, 500)}`);
  return result.structuredContent;
}
async function mcpError(name, args, code) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(result.isError, `${name} ${JSON.stringify(args)} unexpectedly succeeded`);
  if (code) {
    const error = result.structuredContent?.error;
    assert.ok(error, `${name}: ${JSON.stringify(result).slice(0, 400)}`);
    assert.equal(error.code, code, JSON.stringify(error));
  }
  return result.structuredContent;
}

const ids = (items) => items.map((item) => item.id);
const targets = (items) => items.map((item) => item.toObjectId);
const NEW_CONTACT = { email: "nils.holm@harborlane.example.com", firstname: "Nils", lastname: "Holm", lifecyclestage: "lead", hubspot_owner_id: "41002" };

// ---------------------------------------------------------------------------------------------
// Drill: rest-flow (rep = Maya, baseline)
// ---------------------------------------------------------------------------------------------

async function restFlow() {
  // Account ----------------------------------------------------------------------------------
  const account = (await get("/account-info/v3/details")).json;
  assert.equal(account.portalId, 24871365);
  assert.equal(account.dataHostingLocation, "eu1");
  assert.equal(account.user, undefined, "the REST route does not expose the user block");

  // Listing ----------------------------------------------------------------------------------
  const first = (await get(C)).json;
  assert.equal(first.results.length, 10);
  assert.deepEqual(Object.keys(first.results[0].properties), ["createdate", "email", "firstname", "hs_object_id", "lastmodifieddate", "lastname"]);
  assert.ok(first.results.every((record) => record.archived === false && record.id !== "110"));
  assert.equal(first.paging.next.after, "111", "the archived contact 110 is skipped");
  const pages = [];
  let next = `${C}?limit=5`;
  while (next !== undefined) {
    const page = (await get(next)).json;
    pages.push(page.results.length);
    next = page.paging === undefined ? undefined : page.paging.next.link;
  }
  assert.deepEqual(pages, [5, 5, 3], "limit=5 walks three pages through paging.next.link");
  await apiError("GET", `${C}?limit=0`, 400, "VALIDATION_ERROR", "limit");
  await apiError("GET", `${C}?limit=101`, 400, "VALIDATION_ERROR", "limit");
  await apiError("GET", `${C}?after=zzz`, 400, "VALIDATION_ERROR", "Invalid after cursor");
  await apiError("GET", `${C}?limit=abc`, 400, "VALIDATION_ERROR", "limit");
  await apiError("GET", `${C}?archived=maybe`, 400, "VALIDATION_ERROR", "archived");
  await apiError("GET", `${C}?propertiesWithHistory=email`, 400, "VALIDATION_ERROR", "propertiesWithHistory");
  const archivedList = (await get(`${C}?archived=true`)).json;
  assert.deepEqual(ids(archivedList.results), ["110"]);
  assert.ok(archivedList.results[0].archivedAt);
  const selected = (await get(`${C}?properties=email,plan_tier,doesnotexist&limit=1`)).json.results[0];
  assert.deepEqual(Object.keys(selected.properties), ["createdate", "email", "hs_object_id", "lastmodifieddate", "plan_tier"], "unknown properties are dropped, system ones are always present");
  assert.equal(selected.properties.plan_tier, "enterprise");
  const withAssociations = (await get(`${C}?associations=companies,deals&limit=1`)).json.results[0];
  assert.deepEqual(withAssociations.associations.companies.results, [
    { id: "201", type: "contact_to_company_primary" },
    { id: "201", type: "contact_to_company" },
  ]);
  assert.deepEqual(ids(withAssociations.associations.deals.results), ["301", "307"]);
  assert.equal((await get("/crm/v3/objects/0-1?limit=2")).json.results.length, 2, "numeric object type ids resolve");
  assert.equal((await get("/crm/v3/objects/Contact?limit=1")).json.results.length, 1, "singular spelling resolves");
  await apiError("GET", "/crm/v3/objects/tickets", 404, "OBJECT_NOT_FOUND", "Unable to infer object type from: tickets");

  // Reading ----------------------------------------------------------------------------------
  const alice = (await get(`${C}/101`)).json;
  assert.equal(alice.properties.email, "alice.nordin@fjordbyte.example.com");
  assert.equal(alice.properties.hs_object_id, "101");
  const zoe = (await get(`${C}/zoe.mueller@kestrelpay.example.org?idProperty=email`)).json;
  assert.equal(zoe.id, "103", "idProperty=email matches case-insensitively");
  await apiError("GET", `${C}/101?idProperty=firstname`, 400, "VALIDATION_ERROR", "Invalid idProperty");
  await apiError("GET", `${C}/110`, 404, "OBJECT_NOT_FOUND");
  assert.equal((await get(`${C}/110?archived=true`)).json.archived, true);
  await apiError("GET", `${C}/201`, 404, "OBJECT_NOT_FOUND", "resource not found");
  await apiError("GET", `${C}/not-an-id`, 404, "OBJECT_NOT_FOUND");
  const owned = (await get(`${C}/101?properties=hubspot_owner_id,hubspot_owner_assigneddate`)).json.properties;
  assert.equal(owned.hubspot_owner_id, "41001");
  assert.ok(owned.hubspot_owner_assigneddate);

  // Creating ---------------------------------------------------------------------------------
  const created = (
    await post(C, { properties: NEW_CONTACT, associations: [{ to: { id: "201" }, types: [{ associationCategory: HS, associationTypeId: 279 }] }] }, { status: 201 })
  ).json;
  assert.equal(created.id, "1001");
  assert.equal(created.properties.hs_object_id, "1001");
  assert.equal(created.properties.createdate, created.createdAt);
  assert.equal(created.properties.hubspot_owner_assigneddate, created.createdAt);
  assert.equal(created.properties.lifecyclestage, "lead");
  assert.equal(created.archived, false);
  assert.deepEqual(targets((await get(`${A}/contacts/1001/associations/companies`)).json.results), ["201"]);
  await apiError("POST", C, 409, "CONFLICT", "Contact already exists. Existing ID: 1001", { body: { properties: { email: "NILS.HOLM@harborlane.example.com" } } });
  const invalidEnum = await apiError("POST", C, 400, "VALIDATION_ERROR", "lifecyclestage", { body: { properties: { email: "x@example.org", lifecyclestage: "vip" } } });
  assert.deepEqual(invalidEnum.json.errors[0].context.propertyName, ["lifecyclestage"]);
  await apiError("POST", C, 400, "VALIDATION_ERROR", 'Property "hs_object_id" is read only', { body: { properties: { hs_object_id: "1" } } });
  await apiError("POST", C, 400, "VALIDATION_ERROR", 'Property "bogus" does not exist', { body: { properties: { bogus: "x" } } });
  await apiError("POST", C, 400, "VALIDATION_ERROR", "Owner 41004 is not valid", { body: { properties: { firstname: "x", hubspot_owner_id: "41004" } } });
  await apiError("POST", C, 400, "VALIDATION_ERROR", "Owner 99999 is not valid", { body: { properties: { firstname: "x", hubspot_owner_id: "99999" } } });
  await apiError("POST", C, 400, "VALIDATION_ERROR", "properties", { body: { properties: {} } });
  await apiError("POST", C, 400, "VALIDATION_ERROR", "Invalid input JSON", { body: { properties: { firstname: ["array"] } } });
  await apiError("POST", C, 404, "OBJECT_NOT_FOUND", "No company with ID 999999 exists", {
    body: { properties: { email: "orphan@example.org" }, associations: [{ to: { id: "999999" }, types: [{ associationCategory: HS, associationTypeId: 279 }] }] },
  });
  await apiError("POST", C, 400, "VALIDATION_ERROR", "Association type 999", { body: { properties: { email: "orphan@example.org" }, associations: [{ to: { id: "201" }, types: [{ associationCategory: HS, associationTypeId: 999 }] }] } });
  assert.equal((await post(`${C}/search`, { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: "orphan@example.org" }] }] })).json.total, 0, "a failed create writes nothing");
  await apiError("POST", "/crm/v3/objects/tickets", 404, "OBJECT_NOT_FOUND", "tickets", { body: { properties: { subject: "x" } } });

  // Updating ---------------------------------------------------------------------------------
  const updated = (await patch(`${C}/1001`, { properties: { phone: "+46 8 123 456", lifecyclestage: null } })).json;
  assert.equal(updated.properties.phone, "+46 8 123 456");
  assert.equal(updated.properties.lifecyclestage, undefined, "a cleared property is omitted from the write response");
  assert.equal((await get(`${C}/1001?properties=lifecyclestage`)).json.properties.lifecyclestage, null, "...and reads back as null");
  assert.ok(updated.properties.lastmodifieddate >= updated.properties.createdate);
  await apiError("PATCH", `${C}/1001`, 409, "CONFLICT", "Contact already exists. Existing ID: 101", { body: { properties: { email: "Alice.Nordin@fjordbyte.example.com" } } });
  await apiError("PATCH", `${C}/1001`, 400, "VALIDATION_ERROR", "lifecyclestage", { body: { properties: { lifecyclestage: "vip" } } });
  await apiError("PATCH", `${C}/110`, 404, "OBJECT_NOT_FOUND", undefined, { body: { properties: { firstname: "x" } } });
  await apiError("PATCH", `${C}/999999`, 404, "OBJECT_NOT_FOUND", undefined, { body: { properties: { firstname: "x" } } });
  await apiError("PATCH", "/crm/v3/objects/tickets/1", 404, "OBJECT_NOT_FOUND", "tickets", { body: { properties: { firstname: "x" } } });
  assert.equal((await patch(`${C}/nils.holm@harborlane.example.com?idProperty=email`, { properties: { jobtitle: "Fleet Manager" } })).json.id, "1001");

  // Archiving --------------------------------------------------------------------------------
  await del(`${C}/1001`);
  await apiError("DELETE", `${C}/1001`, 404, "OBJECT_NOT_FOUND");
  const archived = (await get(`${C}/1001?archived=true`)).json;
  assert.equal(archived.archived, true);
  assert.ok(archived.archivedAt);
  await apiError("GET", `${C}/1001`, 404, "OBJECT_NOT_FOUND");
  await apiError("DELETE", "/crm/v3/objects/tickets/1", 404, "OBJECT_NOT_FOUND", "tickets");

  // Batch objects ----------------------------------------------------------------------------
  const batchRead = (await post(`${C}/batch/read`, { inputs: [{ id: "101" }, { id: "999" }, { id: 102 }], properties: ["email"] })).json;
  assert.equal(batchRead.status, "COMPLETE");
  assert.deepEqual(ids(batchRead.results), ["101", "102"]);
  assert.equal(batchRead.numErrors, 1);
  assert.equal(batchRead.errors[0].category, "OBJECT_NOT_FOUND");
  assert.deepEqual(batchRead.errors[0].context.ids, ["999"]);
  assert.ok(batchRead.startedAt && batchRead.completedAt);
  await apiError("POST", `${C}/batch/read`, 400, "VALIDATION_ERROR", "inputs", { body: { inputs: [] } });
  await apiError("POST", `${C}/batch/read`, 400, "VALIDATION_ERROR", "At most 100", { body: { inputs: Array.from({ length: 101 }, (_, index) => ({ id: String(index + 1) })) } });
  // Route fuzz retrofit: JSON bodies nested past 512 levels answer 400 before argument validation; normal nesting still works.
  const deepObject = (depth) => `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
  const deepArray = (depth) => `${"[".repeat(depth)}1${"]".repeat(depth)}`;
  const deep = async (method, path, rawBody) => {
    const response = await fetch(`${HTTP}${path}`, { method, headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" }, body: rawBody });
    const text = await response.text();
    assert.equal(response.status, 400, `${method} ${path} deep body -> ${response.status} ${text.slice(0, 300)}`);
  };
  await deep("POST", "/crm/v4/associations/contacts/companies/batch/read", `{"inputs":${deepObject(2750)}}`);
  await deep("POST", "/crm/v4/associations/contacts/companies/batch/read", `{"inputs":[{"id":"101","x":${deepArray(513)}}]}`);
  await deep("POST", `${C}/batch/update`, `{"inputs":${deepObject(3105)}}`);
  await deep("POST", `${C}/search`, `{"filterGroups":${deepArray(2995)}}`);
  await deep("PUT", "/crm/v4/objects/contacts/101/associations/companies/201", deepArray(3000));
  await deep("POST", C, `{"properties":${deepObject(3150)}}`);
  await apiError("POST", "/crm/v4/associations/contacts/companies/batch/read", 400, "VALIDATION_ERROR", undefined, { body: { inputs: { a: { b: { c: [1, 2, { d: 3 }] } } } } });
  const shallow = (await post("/crm/v4/associations/contacts/companies/batch/read", { inputs: [{ id: "101" }] })).json;
  assert.equal(shallow.status, "COMPLETE", "a normal batch read still succeeds after the depth guard");
  await apiError("POST", "/crm/v3/objects/tickets/batch/read", 404, "OBJECT_NOT_FOUND", undefined, { body: { inputs: [{ id: "1" }] } });
  assert.deepEqual(ids((await post(`${C}/batch/read`, { inputs: [{ id: "ZOE.MUELLER@kestrelpay.example.org" }], idProperty: "email" })).json.results), ["103"]);

  const batchCreate = (
    await post(`${CO}/batch/create`, { inputs: [{ properties: { name: "Aurora Freight", domain: "aurorafreight.example.com", type: "PROSPECT" } }, { properties: { name: "Bergstrom Analytics", domain: "bergstrom.example.org" } }] }, { status: 201 })
  ).json;
  assert.deepEqual(ids(batchCreate.results), ["1002", "1003"]);
  assert.equal(batchCreate.results[0].properties.name, "Aurora Freight");
  await apiError("POST", `${CO}/batch/create`, 400, "VALIDATION_ERROR", "type", { body: { inputs: [{ properties: { name: "Good Co" } }, { properties: { name: "Bad Co", type: "FRIEND" } }] } });
  await apiError("POST", `${C}/batch/create`, 409, "CONFLICT", "Contact already exists", { body: { inputs: [{ properties: { email: "dup@example.org" } }, { properties: { email: "DUP@example.org" } }] } });
  await apiError("POST", `${C}/batch/create`, 400, "VALIDATION_ERROR", "inputs", { body: { inputs: [] } });
  await apiError("POST", "/crm/v3/objects/tickets/batch/create", 404, "OBJECT_NOT_FOUND", undefined, { body: { inputs: [{ properties: { subject: "x" } }] } });
  assert.equal((await get(`${CO}?limit=100`)).json.results.length, 7, "the failed batch added no company");

  const batchUpdate = (await post(`${D}/batch/update`, { inputs: [{ id: "301", properties: { amount: "12000" } }, { id: "999", properties: { amount: "1" } }] })).json;
  assert.deepEqual(ids(batchUpdate.results), ["301"]);
  assert.equal(batchUpdate.results[0].properties.amount, "12000");
  assert.equal(batchUpdate.numErrors, 1);
  assert.equal(batchUpdate.errors[0].context.id[0], "999");
  await apiError("POST", `${D}/batch/update`, 400, "VALIDATION_ERROR", "amount", { body: { inputs: [{ id: "302", properties: { amount: "lots" } }] } });
  await apiError("POST", `${C}/batch/update`, 409, "CONFLICT", "Existing ID: 101", { body: { inputs: [{ id: "102", properties: { email: "alice.nordin@fjordbyte.example.com" } }] } });
  await apiError("POST", `${D}/batch/update`, 400, "VALIDATION_ERROR", "inputs", { body: { inputs: [] } });
  await apiError("POST", "/crm/v3/objects/tickets/batch/update", 404, "OBJECT_NOT_FOUND", undefined, { body: { inputs: [{ id: "1", properties: { subject: "x" } }] } });
  assert.equal((await get(`${D}/302`)).json.properties.amount, "42000", "the rejected batch changed nothing");

  // Deals, notes, tasks ----------------------------------------------------------------------
  await apiError("POST", D, 400, "VALIDATION_ERROR", "renewal-outreach", { body: { properties: { dealname: "Wrong pipeline", dealstage: "renewal-outreach" } } });
  await apiError("POST", D, 400, "VALIDATION_ERROR", "dealstage", { body: { properties: { dealname: "No stage" } } });
  await apiError("POST", D, 400, "VALIDATION_ERROR", "Pipeline ID nope is not valid", { body: { properties: { dealname: "x", pipeline: "nope", dealstage: "renewed" } } });
  const deal = (await post(D, { properties: { dealname: "Lumenworks — 2027 renewal", pipeline: "5f2a9c1e", dealstage: "renewal-outreach", amount: 15000, closedate: "1798675200000" } }, { status: 201 })).json;
  assert.equal(deal.id, "1004");
  assert.equal(deal.properties.hs_is_closed, "false");
  assert.equal(deal.properties.hs_deal_stage_probability, "0.3");
  assert.equal(deal.properties.amount, "15000");
  assert.equal(deal.properties.closedate, "2026-12-31T00:00:00.000Z", "epoch milliseconds are stored as ISO-8601");
  const renewed = (await patch(`${D}/1004`, { properties: { dealstage: "renewed" } })).json;
  assert.equal(renewed.properties.hs_is_closed, "true");
  assert.equal(renewed.properties.hs_is_closed_won, "true");
  assert.equal(renewed.properties.hs_deal_stage_probability, "1.0");
  await apiError("POST", "/crm/v3/objects/notes", 400, "VALIDATION_ERROR", "hs_timestamp", { body: { properties: { hs_note_body: "no timestamp" } } });
  const note = (await post("/crm/v3/objects/notes", { properties: { hs_note_body: "Follow-up sent.", hs_timestamp: "1789380000000", hubspot_owner_id: "41001" } }, { status: 201 })).json;
  assert.equal(note.id, "1005");
  assert.equal(note.properties.hs_timestamp, "2026-09-14T10:00:00.000Z");
  await apiError("POST", "/crm/v3/objects/tasks", 400, "VALIDATION_ERROR", "hs_task_status", { body: { properties: { hs_task_subject: "x", hs_timestamp: "2026-09-20T09:00:00Z", hs_task_status: "DONE" } } });
  const taskRecord = (await post("/crm/v3/objects/tasks", { properties: { hs_task_subject: "Send the renewal quote", hs_timestamp: "2026-09-20T09:00:00Z", hs_task_status: "COMPLETED", hs_task_priority: "HIGH" } }, { status: 201 })).json;
  assert.equal(taskRecord.id, "1006");
  assert.equal(taskRecord.properties.hs_task_status, "COMPLETED");
  // Datetime coercion is host-independent: zone-less ISO is UTC, date-only is midnight UTC, offsets are applied,
  // and anything that is not epoch milliseconds or a real ISO-8601 calendar value is rejected (INVALID_DATE).
  const T = "/crm/v3/objects/tasks/1006";
  assert.equal((await patch(T, { properties: { hs_timestamp: "2026-09-20T09:00:00" } })).json.properties.hs_timestamp, "2026-09-20T09:00:00.000Z", "zone-less datetime is UTC");
  assert.equal((await patch(T, { properties: { hs_timestamp: "2026-09-20" } })).json.properties.hs_timestamp, "2026-09-20T00:00:00.000Z", "date-only is midnight UTC");
  assert.equal((await patch(T, { properties: { hs_timestamp: "2026-09-20T11:30:00.25+02:30" } })).json.properties.hs_timestamp, "2026-09-20T09:00:00.250Z", "offsets are applied");
  for (const bad of ["September 20, 2026", "2026-02-30T09:00:00Z", "2026-09-20T24:00:00", "20/09/2026", "2026-09-20T09:00:00+25:00"]) {
    await apiError("PATCH", T, 400, "VALIDATION_ERROR", "not a valid date or datetime", { body: { properties: { hs_timestamp: bad } } });
  }
  assert.equal((await patch(T, { properties: { hs_timestamp: "2026-09-20T09:00:00" } })).json.properties.hs_timestamp, "2026-09-20T09:00:00.000Z");
  assert.equal((await get(`${T}?properties=hs_timestamp`)).json.properties.hs_timestamp, "2026-09-20T09:00:00.000Z", "rejected values changed nothing");

  // Search -----------------------------------------------------------------------------------
  const search = (path, body) => post(`${path}/search`, body).then((result) => result.json);
  const filters = (...list) => ({ filterGroups: [{ filters: list }] });
  assert.equal((await search(C, filters({ propertyName: "lifecyclestage", operator: "EQ", value: "customer" }))).total, 2);
  assert.deepEqual(ids((await search(D, filters({ propertyName: "amount", operator: "GT", value: "50000" }))).results), ["304", "305"], "deal 301 was batch-updated to 12000 above");
  assert.equal((await search(D, filters({ propertyName: "amount", operator: "BETWEEN", value: 30000, highValue: "80000" }))).total, 4);
  assert.equal((await search(D, filters({ propertyName: "dealstage", operator: "IN", values: ["closedwon", "closedlost"] }))).total, 2);
  assert.equal((await search(D, filters({ propertyName: "dealstage", operator: "NOT_IN", values: ["closedwon", "closedlost"] }))).total, 7, "eight starter deals plus the renewal created above, minus the two closed ones");
  assert.equal((await search(D, filters({ propertyName: "amount", operator: "HAS_PROPERTY" }))).total, 8, "deal 307 has no amount");
  assert.deepEqual(ids((await search(C, filters({ propertyName: "email", operator: "NOT_HAS_PROPERTY" }))).results), ["106"]);
  assert.deepEqual(ids((await search(C, filters({ propertyName: "firstname", operator: "CONTAINS_TOKEN", value: "zo*" }))).results), ["103"]);
  assert.equal((await search(C, filters({ propertyName: "firstname", operator: "NOT_CONTAINS_TOKEN", value: "zo*" }))).total, 12);
  assert.equal((await search(C, filters({ propertyName: "createdate", operator: "GTE", value: "2026-08-01T00:00:00Z" }))).total, 4);
  assert.equal((await search(C, filters({ propertyName: "createdate", operator: "GTE", value: "2026-08-01T00:00:00" }))).total, 4, "a zone-less filter value is UTC");
  assert.equal((await search(C, filters({ propertyName: "createdate", operator: "GTE", value: "2026-08-01" }))).total, 4);
  assert.deepEqual(ids((await search("/crm/v3/objects/tasks", filters({ propertyName: "hs_timestamp", operator: "EQ", value: "2026-09-20T09:00:00" }))).results), ["1006"]);
  await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", "is not a valid date", { body: filters({ propertyName: "createdate", operator: "GTE", value: "August 1, 2026" }) });
  await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", "is not a valid date", { body: filters({ propertyName: "createdate", operator: "BETWEEN", value: "2026-08-01", highValue: "2026-02-30" }) });
  await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", "is not a valid date", { body: filters({ propertyName: "createdate", operator: "IN", values: ["2026-08-01", "soon"] }) });
  assert.equal((await search(C, filters({ propertyName: "lifecyclestage", operator: "NEQ", value: "lead" }))).total, 9);
  assert.equal((await search(C, { filterGroups: [{ filters: [{ propertyName: "lifecyclestage", operator: "EQ", value: "customer" }] }, { filters: [{ propertyName: "hs_lead_status", operator: "EQ", value: "NEW" }] }] })).total, 4, "filterGroups are OR-ed");
  assert.equal((await search(C, filters({ propertyName: "lifecyclestage", operator: "EQ", value: "customer" }, { propertyName: "plan_tier", operator: "EQ", value: "team" }))).total, 1, "filters in a group are AND-ed");
  assert.deepEqual(ids((await search(C, { query: "kjær" })).results), ["104"]);
  assert.deepEqual(ids((await search(C, { query: "søren kj" })).results), ["104"]);
  assert.equal((await search(C, { query: "fjordbyte" })).total, 3);
  assert.equal((await search(C, { query: "nobody-matches" })).total, 0);
  assert.equal((await search(C, { sorts: [{ propertyName: "createdate", direction: "DESCENDING" }], limit: 1 })).results[0].id, "114");
  assert.equal((await search(C, { sorts: ["-createdate"], limit: 1 })).results[0].id, "114");
  assert.equal((await search(D, { sorts: ["amount"], limit: 1 })).results[0].id, "306");
  const walked = [];
  let after = "0";
  let total;
  while (after !== undefined) {
    const page = await search(C, { limit: 3, after, properties: ["firstname"] });
    total = page.total;
    walked.push(...ids(page.results));
    after = page.paging?.next.after;
  }
  assert.equal(total, 13);
  assert.equal(walked.length, 13);
  assert.ok(!walked.includes("110") && !walked.includes("1001"), "search never returns archived records");
  assert.equal((await search(C, { limit: 3, after: 3 })).results[0].id, "104", "a numeric after is accepted");
  await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", "after", { body: { after: "10000" } });
  await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", "At most 6 filters", { body: { filterGroups: [{ filters: Array.from({ length: 7 }, () => ({ propertyName: "email", operator: "HAS_PROPERTY" })) }] } });
  await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", "Invalid operator", { body: filters({ propertyName: "email", operator: "LIKE", value: "x" }) });
  await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", "requires a value", { body: filters({ propertyName: "email", operator: "EQ" }) });
  await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", 'Property "nope" does not exist', { body: filters({ propertyName: "nope", operator: "EQ", value: "x" }) });
  await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", "Only one sort", { body: { sorts: ["createdate", "-email"] } });
  // CONTAINS_TOKEN wildcards match in linear time: patterns that make a backtracking regex explode answer at once.
  assert.deepEqual(ids((await search(C, filters({ propertyName: "email", operator: "CONTAINS_TOKEN", value: "z*mue*@*.org" }))).results), ["103"], "wildcards in the middle of a token");
  for (const value of ["*a*a*a*a*a*a*a*a*q", `*${"a*".repeat(1400)}q`, `${"*".repeat(3000)}`]) {
    const started = performance.now();
    const hit = await search(C, filters({ propertyName: "email", operator: "CONTAINS_TOKEN", value }));
    const missed = await search(C, filters({ propertyName: "email", operator: "NOT_CONTAINS_TOKEN", value }));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2000, `wildcard pattern of ${value.length} characters took ${Math.round(elapsed)} ms`);
    assert.equal(hit.total + missed.total, (await search(C, {})).total, "CONTAINS_TOKEN and NOT_CONTAINS_TOKEN partition the records");
    if (value.endsWith("q")) assert.equal(hit.total, 0);
  }
  assert.ok((await get("/account-info/v3/details")).json.portalId, "the server still answers after pathological patterns");
  // Search text is bounded like HubSpot's 3,000-character query limit.
  const long = "a".repeat(3001);
  await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", "maximum length of 3000", { body: filters({ propertyName: "email", operator: "CONTAINS_TOKEN", value: `*${long}*` }) });
  await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", "maximum length of 3000", { body: filters({ propertyName: "email", operator: "EQ", value: long }) });
  await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", "maximum length of 3000", { body: filters({ propertyName: "email", operator: "IN", values: ["x", long] }) });
  await apiError("POST", `${D}/search`, 400, "VALIDATION_ERROR", "maximum length of 3000", { body: filters({ propertyName: "amount", operator: "BETWEEN", value: "1", highValue: long }) });
  await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", "maximum length of 3000", { body: { query: long } });
  assert.equal((await search(C, filters({ propertyName: "email", operator: "CONTAINS_TOKEN", value: `*${"a".repeat(2998)}` }))).total, 0, "3000 characters is accepted");
  await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", "limit", { body: { limit: 201 } });
  await apiError("POST", "/crm/v3/objects/tickets/search", 404, "OBJECT_NOT_FOUND", undefined, { body: {} });

  // Associations -----------------------------------------------------------------------------
  const aliceCompanies = (await get(`${A}/contacts/101/associations/companies`)).json.results;
  assert.deepEqual(aliceCompanies, [{ toObjectId: "201", associationTypes: [{ category: HS, typeId: 1, label: "Primary" }, { category: HS, typeId: 279, label: null }] }]);
  assert.deepEqual(targets((await get(`${A}/companies/201/associations/contacts`)).json.results), ["101", "102"], "the archived contact 1001 is omitted although its link rows remain");
  const zoeCompanies = (await get(`${A}/contacts/103/associations/companies`)).json.results[0];
  assert.deepEqual(zoeCompanies.associationTypes.map((type) => type.label), ["Champion", null]);
  await apiError("GET", `${A}/companies/206/associations/contacts`, 404, "OBJECT_NOT_FOUND");
  await apiError("GET", `${A}/contacts/101/associations/tickets`, 404, "OBJECT_NOT_FOUND", "tickets");
  await apiError("GET", `${A}/contacts/101/associations/companies?limit=0`, 400, "VALIDATION_ERROR", "limit");
  const limited = (await get(`${A}/companies/201/associations/contacts?limit=1`)).json;
  assert.equal(limited.results[0].toObjectId, "101");
  assert.equal(limited.paging.next.after, "101");
  assert.deepEqual(targets((await get(limited.paging.next.link)).json.results), ["102"]);
  assert.deepEqual((await get(`${A}/contacts/112/associations/companies`)).json.results, [], "links to an archived company are omitted");

  const defaults = (await put(`${A}/contacts/101/associations/default/companies/203`, undefined)).json;
  assert.deepEqual(defaults.map((entry) => entry.associationSpec.associationTypeId), [279, 280]);
  assert.equal(defaults[1].fromObjectTypeId, "0-2");
  assert.deepEqual((await put(`${A}/contacts/101/associations/default/companies/203`, undefined)).json, defaults, "creating the default association twice is idempotent");
  await apiError("PUT", `${A}/notes/401/associations/default/tasks/501`, 400, "VALIDATION_ERROR", "No default association type");
  await apiError("PUT", `${A}/contacts/999999/associations/default/companies/201`, 404, "OBJECT_NOT_FOUND", "No contact with ID 999999 exists");
  await apiError("PUT", `${A}/contacts/101/associations/default/companies/206`, 404, "OBJECT_NOT_FOUND", "No company with ID 206 exists");
  const labelled = (await put(`${A}/contacts/101/associations/companies/203`, [{ associationCategory: HS, associationTypeId: 1 }], { status: 201 })).json;
  assert.deepEqual(labelled.labels, ["Primary"]);
  assert.deepEqual((await get(`${A}/contacts/101/associations/companies`)).json.results.map((link) => [link.toObjectId, link.associationTypes.map((type) => type.typeId)]), [
    ["201", [279]],
    ["203", [1, 279]],
  ], "the Primary label moved from company 201 to company 203");
  assert.deepEqual((await get(`${A}/companies/201/associations/contacts`)).json.results[0].associationTypes.map((type) => type.typeId), [280], "...in both directions");
  await apiError("PUT", `${A}/contacts/101/associations/companies/203`, 400, "VALIDATION_ERROR", "Association type 999", { body: [{ associationCategory: HS, associationTypeId: 999 }] });
  await apiError("PUT", `${A}/contacts/101/associations/companies/203`, 400, "VALIDATION_ERROR", "USER_DEFINED", { body: [{ associationCategory: "USER_DEFINED", associationTypeId: 279 }] });
  await apiError("PUT", `${A}/contacts/101/associations/companies/999999`, 404, "OBJECT_NOT_FOUND", undefined, { body: [{ associationCategory: HS, associationTypeId: 279 }] });
  await del(`${A}/contacts/101/associations/companies/203`);
  assert.deepEqual(targets((await get(`${A}/contacts/101/associations/companies`)).json.results), ["201"]);
  assert.deepEqual(targets((await get(`${A}/companies/203/associations/contacts`)).json.results), ["104"]);
  await del(`${A}/contacts/101/associations/companies/203`);
  await apiError("DELETE", `${A}/contacts/999999/associations/companies/203`, 404, "OBJECT_NOT_FOUND");

  const batchAssociations = (
    await post(
      "/crm/v4/associations/contacts/deals/batch/create",
      {
        inputs: [
          { from: { id: "113" }, to: { id: "303" }, types: [{ associationCategory: HS, associationTypeId: 4 }] },
          { from: { id: "114" }, to: { id: "302" }, types: [{ associationCategory: HS, associationTypeId: 4 }] },
          { from: { id: "999" }, to: { id: "301" }, types: [{ associationCategory: HS, associationTypeId: 4 }] },
        ],
      },
      { status: 201 },
    )
  ).json;
  assert.equal(batchAssociations.results.length, 2);
  assert.equal(batchAssociations.numErrors, 1);
  assert.equal(batchAssociations.errors[0].message, "No contact with ID 999 exists");
  await apiError("POST", "/crm/v4/associations/contacts/deals/batch/create", 400, "VALIDATION_ERROR", "Association type 279", { body: { inputs: [{ from: { id: "113" }, to: { id: "303" }, types: [{ associationCategory: HS, associationTypeId: 279 }] }] } });
  await apiError("POST", "/crm/v4/associations/contacts/deals/batch/create", 400, "VALIDATION_ERROR", "inputs", { body: { inputs: [] } });
  await apiError("POST", "/crm/v4/associations/contacts/tickets/batch/create", 404, "OBJECT_NOT_FOUND", "tickets", { body: { inputs: [{ from: { id: "113" }, to: { id: "1" }, types: [] }] } });
  const batchLinks = (await post("/crm/v4/associations/contacts/companies/batch/read", { inputs: [{ id: "101" }, { id: "113" }, { id: "999" }] })).json;
  assert.deepEqual(batchLinks.results.map((entry) => entry.from.id), ["101"], "records without associations are absent");
  assert.equal(batchLinks.results[0].to[0].toObjectId, "201");
  assert.equal(batchLinks.numErrors, 1);
  await apiError("POST", "/crm/v4/associations/contacts/companies/batch/read", 400, "VALIDATION_ERROR", "inputs", { body: { inputs: [] } });
  await apiError("POST", "/crm/v4/associations/contacts/tickets/batch/read", 404, "OBJECT_NOT_FOUND", undefined, { body: { inputs: [{ id: "101" }] } });
  const labels = (await get("/crm/v4/associations/contacts/companies/labels")).json.results;
  assert.deepEqual(labels, [
    { category: HS, typeId: 1, label: "Primary" },
    { category: "USER_DEFINED", typeId: 57, label: "Champion" },
    { category: HS, typeId: 279, label: null },
  ]);
  assert.deepEqual((await get("/crm/v4/associations/notes/tasks/labels")).json.results, []);
  await apiError("GET", "/crm/v4/associations/contacts/tickets/labels", 404, "OBJECT_NOT_FOUND", "tickets");

  // Owners -----------------------------------------------------------------------------------
  const owners = (await get("/crm/v3/owners")).json;
  assert.deepEqual(ids(owners.results), ["41001", "41002", "41003"]);
  assert.equal(owners.results[0].teams[0].name, "Sales");
  assert.deepEqual(ids((await get("/crm/v3/owners?archived=true")).json.results), ["41004"]);
  assert.deepEqual(ids((await get("/crm/v3/owners?email=Tom.Achebe@brightline.example.com")).json.results), ["41002"]);
  const ownerPage = (await get("/crm/v3/owners?limit=2")).json;
  assert.equal(ownerPage.paging.next.after, "41002");
  assert.deepEqual(ids((await get(ownerPage.paging.next.link)).json.results), ["41003"]);
  await apiError("GET", "/crm/v3/owners?limit=0", 400, "VALIDATION_ERROR", "limit");
  assert.equal((await get("/crm/v3/owners/41001")).json.email, "maya.lindqvist@brightline.example.com");
  assert.equal((await get("/crm/v3/owners/10002?idProperty=userId")).json.id, "41002");
  await apiError("GET", "/crm/v3/owners/41004", 404, "OBJECT_NOT_FOUND");
  assert.equal((await get("/crm/v3/owners/41004?archived=true")).json.archived, true);
  await apiError("GET", "/crm/v3/owners/41001?idProperty=email", 400, "VALIDATION_ERROR", "Invalid idProperty");

  // Pipelines --------------------------------------------------------------------------------
  const pipelines = (await get("/crm/v3/pipelines/deals")).json.results;
  assert.deepEqual(ids(pipelines), ["default", "5f2a9c1e"]);
  assert.equal(pipelines[0].label, "Sales Pipeline");
  assert.equal((await get("/crm/v3/pipelines/deal")).json.results.length, 2);
  await apiError("GET", "/crm/v3/pipelines/contacts", 404, "OBJECT_NOT_FOUND", "Unable to infer object type from: contacts");
  assert.equal((await get("/crm/v3/pipelines/deals/5f2a9c1e")).json.stages.length, 4);
  await apiError("GET", "/crm/v3/pipelines/deals/nope", 404, "OBJECT_NOT_FOUND", "Pipeline nope not found");
  const stages = (await get("/crm/v3/pipelines/deals/default/stages")).json.results;
  assert.equal(stages.length, 7);
  assert.deepEqual(stages.map((stage) => stage.metadata.probability), ["0.2", "0.4", "0.6", "0.8", "0.9", "1.0", "0.0"]);
  await apiError("GET", "/crm/v3/pipelines/deals/nope/stages", 404, "OBJECT_NOT_FOUND");

  // Properties -------------------------------------------------------------------------------
  const contactProperties = (await get("/crm/v3/properties/contacts")).json.results;
  const email = contactProperties.find((property) => property.name === "email");
  assert.equal(email.hasUniqueValue, true);
  assert.equal(email.hubspotDefined, true);
  assert.equal(contactProperties.find((property) => property.name === "plan_tier").hubspotDefined, false);
  assert.ok((await get("/crm/v3/properties/companies")).json.results.some((property) => property.name === "csm_health" && property.hidden === true), "the REST route lists hidden properties");
  assert.equal((await get("/crm/v3/properties/companies?archived=true")).json.results.length, 0);
  assert.equal((await get("/crm/v3/properties/deals/arr")).json.type, "number");
  await apiError("GET", "/crm/v3/properties/contacts/nope", 404, "OBJECT_NOT_FOUND", "Property nope does not exist");
  await apiError("GET", "/crm/v3/properties/tickets", 404, "OBJECT_NOT_FOUND", "tickets");

  // Framework-owned negative paths -----------------------------------------------------------
  const formEncoded = await fetch(`${HTTP}${C}`, { method: "POST", headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/x-www-form-urlencoded" }, body: "email=x" });
  assert.equal(formEncoded.status, 415);
  await formEncoded.text();
  for (const [method, path] of [
    ["GET", `${C}/101/merge`],
    ["POST", `${C}/gdpr-delete`],
    ["POST", `${C}/batch/upsert`],
    ["GET", "/crm/v3/schemas"],
    ["GET", "/crm/v3/objects/tickets/1/associations"],
  ]) {
    const response = await fetch(`${HTTP}${path}`, { method, headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.ok(response.status === 404 || response.status === 405, `${method} ${path} must not exist (got ${response.status})`);
    await response.text();
  }
  const unauthenticated = await fetch(`${HTTP}${C}`);
  assert.equal(unauthenticated.status, 401, "a missing bearer token is rejected by the framework");
  await unauthenticated.text();

  await malformedQueryAndLongIds();
}

/**
 * Route-fuzz regressions: malformed query flags answer HubSpot's VALIDATION_ERROR envelope, ids of any length
 * (around the framework's 512-character row-id bound) answer HubSpot's 404/400 envelope, mangled percent-encoding
 * (U+FFFD) in a search or filter answers VALIDATION_ERROR instead of an empty result, and invalid datetimes report
 * exactly one error. Apart from one contact created and archived to prove a long idProperty lookup, nothing changes.
 */
async function malformedQueryAndLongIds() {
  for (const [path, name] of [
    [`${C}?limit=1e2`, "limit"],
    [`${C}/101?archived=maybe`, "archived"],
    [`${A}/contacts/101/associations/companies?limit=abc`, "limit"],
    ["/crm/v3/owners?limit=abc", "limit"],
    ["/crm/v3/owners?archived=yes", "archived"],
    ["/crm/v3/owners/41001?archived=1", "archived"],
    ["/crm/v3/properties/contacts?archived=maybe", "archived"],
    ["/crm/v3/properties/contacts/plan_tier?archived=maybe", "archived"],
  ]) {
    await apiError("GET", path, 400, "VALIDATION_ERROR", name);
  }
  // Object, owner and association ids are bounded to 512 characters by the operation input schemas (the state
  // store's own row-id bound). An id within the bound reaches the handler, which answers HubSpot's 404; only a
  // longer id is rejected before the handler with the VALIDATION_ERROR envelope. Pipeline ids and property names
  // have no schema bound and reach the handler too.
  const invalid = (method, path, body) => apiError(method, path, 400, "VALIDATION_ERROR", "Invalid input JSON", body === undefined ? {} : { body });
  for (const length of [500, 511, 512, 513, 1000, 4096]) {
    const id = "a".repeat(length);
    const digits = "9".repeat(length);
    await apiError("GET", `/crm/v3/pipelines/deals/${id}`, 404, "OBJECT_NOT_FOUND", "not found");
    await apiError("GET", `/crm/v3/pipelines/deals/${id}/stages`, 404, "OBJECT_NOT_FOUND", "not found");
    await apiError("GET", `/crm/v3/properties/contacts/${id}`, 404, "OBJECT_NOT_FOUND", "does not exist");
    // Caller values that become row ids inside a handler: a deal pipeline and an owner id property value.
    await apiError("POST", D, 400, "VALIDATION_ERROR", "is not valid", { body: { properties: { dealname: "x", pipeline: id, dealstage: "renewed" } } });
    await apiError("PATCH", `${C}/101`, 400, "VALIDATION_ERROR", "is not valid", { body: { properties: { hubspot_owner_id: digits } } });
  }
  for (const length of [513, 1000, 4096]) {
    const id = "a".repeat(length);
    const digits = "9".repeat(length);
    await invalid("GET", `${C}/${digits}`);
    await invalid("GET", `${C}/${id}@example.com?idProperty=email`);
    await invalid("PATCH", `${C}/${digits}`, { properties: { firstname: "x" } });
    await invalid("DELETE", `${C}/${id}`);
    await invalid("GET", `/crm/v3/owners/${digits}`);
    await invalid("GET", `${A}/contacts/${digits}/associations/companies`);
    await invalid("PUT", `${A}/contacts/101/associations/default/companies/${digits}`);
    await invalid("DELETE", `${A}/contacts/${id}/associations/companies/201`);
    await invalid("POST", `${C}/batch/read`, { inputs: [{ id: digits }] });
    await invalid("POST", "/crm/v4/associations/contacts/companies/batch/read", { inputs: [{ id: digits }] });
  }
  // Within the bound every id route answers HubSpot's 404 (an unknown id is missing, not malformed).
  for (const length of [64, 65, 200, 500, 512]) {
    const id = "a".repeat(length);
    const digits = "9".repeat(length);
    await apiError("GET", `${C}/${digits}`, 404, "OBJECT_NOT_FOUND");
    await apiError("PATCH", `${C}/${digits}`, 404, "OBJECT_NOT_FOUND", undefined, { body: { properties: { firstname: "x" } } });
    await apiError("DELETE", `${C}/${id}`, 404, "OBJECT_NOT_FOUND");
    await apiError("GET", `/crm/v3/owners/${digits}`, 404, "OBJECT_NOT_FOUND");
    await apiError("GET", `${A}/contacts/${digits}/associations/companies`, 404, "OBJECT_NOT_FOUND");
    await apiError("PUT", `${A}/contacts/101/associations/default/companies/${digits}`, 404, "OBJECT_NOT_FOUND");
    await apiError("DELETE", `${A}/contacts/${id}/associations/companies/201`, 404, "OBJECT_NOT_FOUND");
    const batch = (await post(`${C}/batch/read`, { inputs: [{ id: digits }] })).json;
    assert.deepEqual(batch.errors[0].context.ids, [digits], `batch/read with a ${length}-character id`);
  }
  // A legitimate idProperty=email lookup of an address longer than 64 characters resolves instead of being rejected.
  const longEmail = `${"a".repeat(60)}.long@fjordbyte.example.com`;
  const longContact = (await post(C, { properties: { email: longEmail, firstname: "Long" } }, { status: 201 })).json;
  assert.equal((await get(`${C}/${longEmail}?idProperty=email&properties=email`)).json.id, longContact.id, "a >64-character e-mail resolves");
  await apiError("GET", `${C}/${"b".repeat(60)}.missing@example.com?idProperty=email`, 404, "OBJECT_NOT_FOUND");
  await del(`${C}/${longContact.id}`);
  // Mangled percent-encoding: serve decodes `%E0%A4%A` to U+FFFD. A search expression or free-text filter carrying
  // U+FFFD is a corrupted request and answers HubSpot's VALIDATION_ERROR, never a silently empty result. A
  // correctly encoded U+FFFD (%EF%BF%BD) is rejected the same way; `%ZZ` stays literal and searches normally.
  for (const query of ["email=alice%E0%A4%A", "email=alice%EF%BF%BD"]) {
    await apiError("GET", `/crm/v3/owners?${query}`, 400, "VALIDATION_ERROR", "U+FFFD");
  }
  assert.deepEqual((await get("/crm/v3/owners?email=alice%ZZ")).json.results, [], "%ZZ stays literal and filters normally");
  await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", "U+FFFD", { body: { query: "alice\uFFFD" } });
  for (const filter of [
    { propertyName: "email", operator: "CONTAINS_TOKEN", value: "a\uFFFD" },
    { propertyName: "email", operator: "IN", values: ["ok@example.com", "a\uFFFD"] },
    { propertyName: "createdate", operator: "BETWEEN", value: "0", highValue: "1\uFFFD" },
  ]) {
    await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", "U+FFFD", { body: { filterGroups: [{ filters: [filter] }] } });
  }
  // A legitimate non-ASCII search still works (the guard is about U+FFFD, not about non-ASCII text).
  const accented = (await post(`${C}/search`, { filterGroups: [{ filters: [{ propertyName: "firstname", operator: "EQ", value: "Zoë" }] }] })).json;
  assert.ok(accented.total >= 1, `an accented search must match: ${JSON.stringify(accented)}`);
  assert.ok((await post(`${C}/search`, { query: "Müller" })).json.total >= 1, "a non-ASCII free-text query must match");

  // includeHidden is decoded from the query string: a malformed flag is rejected, not silently treated as true.
  await apiError("GET", "/crm/v3/properties/contacts?includeHidden=maybe", 400, "VALIDATION_ERROR", "includeHidden");
  const shown = (await get("/crm/v3/properties/companies?includeHidden=false")).json.results;
  assert.ok(!shown.some((property) => property.name === "csm_health"), "includeHidden=false hides hidden definitions");
  const all = (await get("/crm/v3/properties/companies?includeHidden=true")).json.results;
  assert.ok(all.some((property) => property.name === "csm_health"), "includeHidden=true keeps hidden definitions");

  // Error messages clip caller text on code points, so a long value keeps its closing quote and no surrogate splits.
  const emoji = "\u{1F600}".repeat(120);
  const cursor = (await apiError("GET", `${C}?after=${encodeURIComponent(emoji)}`, 400, "VALIDATION_ERROR", "not a valid cursor")).json;
  const message = cursor.errors[0].message;
  assert.match(message, /^after "\u{1F600}+…" is not a valid cursor$/u, message);
  assert.ok(![...message].some((character) => character.codePointAt(0) >= 0xd800 && character.codePointAt(0) <= 0xdfff), "no lone surrogate in the message");

  // The framework caps a Tool error message at 1000 UTF-16 units. A message that outgrows the cap (here the
  // aggregated "Property values were not valid" summary over several 100-code-point emoji property names) is cut
  // on a code point boundary too: it ends in an ellipsis, fits the cap, and never leaves a lone surrogate, while
  // errors[] still lists every offending property in full.
  const emojiNames = Object.fromEntries(["a", "b", "c", "d"].map((suffix) => [`${emoji}${suffix}`, "x"]));
  const summary = (await apiError("POST", C, 400, "VALIDATION_ERROR", "Property values were not valid", { body: { properties: emojiNames } })).json;
  assert.ok(summary.message.length <= 1000 && summary.message.length >= 998, `message must fit the 1000-unit cap: ${summary.message.length}`);
  assert.ok(summary.message.endsWith("\u2026"), "an over-long message ends in an ellipsis");
  assert.ok(![...summary.message].some((character) => character.codePointAt(0) >= 0xd800 && character.codePointAt(0) <= 0xdfff), "no lone surrogate in the clipped message");
  assert.equal(summary.errors.length, 4, JSON.stringify(summary.errors.map((error) => error.code)));
  assert.ok(summary.errors.every((error) => error.code === "PROPERTY_DOESNT_EXIST"), "every unknown property is reported in errors[]");

  // An unknown association type is echoed through clipJson (the input schema already bounds it to an integer).
  const typeError = (await apiError("PUT", `${A}/contacts/101/associations/companies/201`, 400, "VALIDATION_ERROR", "is not defined between", {
    body: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 987654321 }],
  })).json;
  assert.match(typeError.message, /^Association type 987654321 \(HUBSPOT_DEFINED\) is not defined between contact and company$/u, typeError.message);
  assert.deepEqual(typeError.errors[0].context.associationTypeId, ["987654321"], JSON.stringify(typeError.errors));

  // Datetimes beyond year 9999 are invalid, and an invalid-only required datetime reports one error, not two.
  for (const value of ["253402300800000", "999999999999999", "9999-12-31T23:00:00-05:00"]) {
    const body = (await apiError("POST", "/crm/v3/objects/notes", 400, "VALIDATION_ERROR", "hs_timestamp", { body: { properties: { hs_timestamp: value } } })).json;
    assert.deepEqual(body.errors.map((error) => error.code), ["INVALID_DATE"], JSON.stringify(body));
  }
}

// ---------------------------------------------------------------------------------------------
// Drill: mcp-aliases (rep, baseline)
// ---------------------------------------------------------------------------------------------

async function mcpAliases() {
  await mcpInit();
  const tools = (await rpc("tools/list", {})).tools.map((tool) => tool.name);
  for (const alias of ALIASES) assert.ok(tools.includes(alias), `alias ${alias} missing`);
  for (const operationId of ALL_OPERATIONS) assert.ok(tools.includes(`hubspot.${operationId}`), `canonical hubspot.${operationId} missing`);

  const me = await mcp("hubspot-get-user-details", {});
  assert.equal(me.user.email, "maya.lindqvist@brightline.example.com");
  assert.equal(me.user.ownerId, "41001");
  assert.equal(me.portalId, 24871365);
  assert.ok(me.scopes.includes("crm.objects.contacts.write"));

  const page = await mcp("hubspot-list-objects", { objectType: "contacts", limit: 3 });
  assert.deepEqual(ids(page.results), ["101", "102", "103"]);
  assert.deepEqual(ids((await mcp("hubspot-list-objects", { objectType: "contacts", limit: 3, after: page.paging.next.after })).results), ["104", "105", "106"]);
  const companies = await mcp("hubspot-list-objects", { objectType: "0-2", properties: ["name", "domain"] });
  assert.equal(companies.results.length, 5);
  assert.equal(companies.results[0].properties.domain, "fjordbyte.example.com");

  const search = await mcp("hubspot-search-objects", {
    objectType: "deals",
    filterGroups: [{ filters: [{ propertyName: "amount", operator: "GTE", value: "50000" }] }],
    sorts: [{ propertyName: "amount", direction: "DESCENDING" }],
    limit: 2,
  });
  assert.equal(search.total, 3);
  assert.deepEqual(ids(search.results), ["301", "304"]);
  assert.equal(search.paging.next.after, "2");

  const created = await mcp("hubspot-batch-create-objects", { objectType: "companies", inputs: [{ properties: { name: "Alias Co", domain: "alias.example.org" } }] });
  const id = created.results[0].id;
  assert.equal(id, "1001");
  const updated = await mcp("hubspot-batch-update-objects", { objectType: "companies", inputs: [{ id, properties: { industry: "COMPUTER_SOFTWARE" } }] });
  assert.equal(updated.results[0].properties.industry, "COMPUTER_SOFTWARE");
  const read = await mcp("hubspot-batch-read-objects", { objectType: "companies", inputs: [{ id }, { id: "999" }], properties: ["name", "industry"] });
  assert.equal(read.results[0].properties.industry, "COMPUTER_SOFTWARE");
  assert.equal(read.numErrors, 1);

  const definitions = await mcp("hubspot-get-association-definitions", { fromObjectType: "contacts", toObjectType: "companies" });
  assert.deepEqual(definitions.results.map((entry) => entry.typeId), [1, 57, 279]);
  const linked = await mcp("hubspot-batch-create-associations", { fromObjectType: "contacts", toObjectType: "companies", inputs: [{ from: { id: "113" }, to: { id }, types: [{ associationCategory: HS, associationTypeId: 279 }] }] });
  assert.equal(linked.results.length, 1);
  assert.equal(linked.numErrors, undefined);
  const links = await mcp("hubspot-list-associations", { objectType: "contacts", objectId: "113", toObjectType: "companies" });
  assert.deepEqual(links.results.map((link) => link.toObjectId), [id]);

  const visible = await mcp("hubspot-list-properties", { objectType: "companies" });
  assert.ok(!visible.results.some((property) => property.name === "csm_health"), "hidden properties are filtered unless includeHidden");
  const hidden = await mcp("hubspot-list-properties", { objectType: "companies", includeHidden: true });
  assert.ok(hidden.results.some((property) => property.name === "csm_health"));
  const planTier = await mcp("hubspot-get-property", { objectType: "contacts", propertyName: "plan_tier" });
  assert.deepEqual(planTier.options.map((option) => option.value), ["free", "team", "enterprise"]);

  await mcpError("hubspot-list-objects", { objectType: "tickets" }, "tool.NOT_FOUND");
  await mcpError("hubspot-search-objects", { objectType: "contacts", filterGroups: [{ filters: [{ propertyName: "email", operator: "LIKE", value: "x" }] }] }, "tool.VALIDATION_ERROR");
  await mcpError("hubspot-list-objects", {});

  assert.equal((await get(`${CO}/${id}`)).json.properties.name, "Alias Co", "the MCP-created company is visible over REST");
}

// ---------------------------------------------------------------------------------------------
// Drill: owned-visibility (sdr = Tom, 'owned records only')
// ---------------------------------------------------------------------------------------------

async function ownedVisibility() {
  assert.deepEqual(ids((await get(C)).json.results), ["103", "105", "106", "108", "113"], "Tom sees his own and unassigned contacts only");
  await apiError("GET", `${C}/101`, 404, "OBJECT_NOT_FOUND");
  await apiError("PATCH", `${C}/101`, 404, "OBJECT_NOT_FOUND", undefined, { body: { properties: { firstname: "Hacked" } } });
  await apiError("DELETE", `${C}/101`, 404, "OBJECT_NOT_FOUND");
  assert.equal((await post(`${C}/search`, {})).json.total, 5);
  assert.deepEqual((await get(`${A}/companies/204/associations/contacts`)).json.results.map((link) => link.toObjectId), ["105"], "hidden contacts are omitted from association listings");
  await apiError("PUT", `${A}/contacts/101/associations/default/companies/202`, 404, "OBJECT_NOT_FOUND");
  const mayas = (await post(C, { properties: { email: "created.by.tom@example.org", firstname: "Created", hubspot_owner_id: "41001" } }, { status: 201 })).json;
  assert.equal(mayas.id, "1001");
  await apiError("GET", `${C}/1001`, 404, "OBJECT_NOT_FOUND");
  const mine = (await post(C, { properties: { email: "unassigned.by.tom@example.org", firstname: "Unassigned" } }, { status: 201 })).json;
  assert.equal(mine.id, "1002");
  assert.equal((await get(`${C}/1002`)).json.properties.firstname, "Unassigned");
  assert.deepEqual(ids((await get("/crm/v3/objects/tasks")).json.results), ["502", "504"]);
  assert.deepEqual(ids((await get(D)).json.results), ["303", "304"]);
}

// ---------------------------------------------------------------------------------------------
// Drill: scopes (readonly = Priya with read scopes only)
// ---------------------------------------------------------------------------------------------

async function scopes() {
  const missing = async (method, path, scope, body) => {
    const result = await apiError(method, path, 403, "MISSING_SCOPES", "hasn't been granted all required scopes", body === undefined ? {} : { body });
    assert.deepEqual(result.json.errors[0].context.requiredGranularScopes, [scope]);
  };
  assert.equal((await get(C)).json.results.length, 10);
  await missing("POST", C, "crm.objects.contacts.write", { properties: { firstname: "x" } });
  await missing("PATCH", `${D}/301`, "crm.objects.deals.write", { properties: { amount: "1" } });
  await missing("DELETE", `${CO}/201`, "crm.objects.companies.write");
  await missing("PUT", `${A}/contacts/101/associations/default/companies/201`, "crm.objects.contacts.write");
  await missing("POST", "/crm/v3/objects/notes", "crm.objects.contacts.write", { properties: { hs_note_body: "x", hs_timestamp: "2026-09-14T09:00:00Z" } });
  assert.equal((await get("/crm/v3/owners")).json.results.length, 3);
  assert.ok((await get("/crm/v3/properties/contacts")).json.results.length > 10);
  await mcpInit();
  const error = (await mcpError("hubspot-batch-create-objects", { objectType: "contacts", inputs: [{ properties: { firstname: "x" } }] }, "tool.MISSING_SCOPES")).error;
  assert.ok(error.message.includes("scopes"));
  assert.equal((await get(`${D}/301`)).json.properties.amount, "184000", "nothing was written");
}

// ---------------------------------------------------------------------------------------------
// Drills that run one representative request per operation
// ---------------------------------------------------------------------------------------------

async function noScopes() {
  for (const entry of CALLS) {
    const result = await callError(entry, 403, "MISSING_SCOPES", "hasn't been granted all required scopes");
    assert.ok(Array.isArray(result.json.errors[0].context.requiredGranularScopes), `${entry[0]} ${entry[1]}: requiredGranularScopes`);
  }
}

async function denied() {
  const message = "not granted to the calling actor";
  await apiError("GET", "/account-info/v3/details", 403, "MISSING_SCOPES", message);
  await apiError("GET", C, 403, "MISSING_SCOPES", message);
  await apiError("POST", C, 403, "MISSING_SCOPES", message, { body: { properties: { firstname: "x" } } });
  await mcpInit();
  const result = await rpc("tools/call", { name: "hubspot-list-objects", arguments: { objectType: "contacts" } });
  assert.ok(result.isError);
  assert.equal(result.structuredContent.status, "denied");
}

async function invalidAuth() {
  for (const entry of CALLS) {
    const result = await callError(entry, 401, "INVALID_AUTHENTICATION", "Authentication credentials not found");
    assert.ok(result.json.links["oauth-overview"]);
  }
  await mcpInit();
  await mcpError("hubspot-get-user-details", {}, "tool.UNAUTHORIZED");
}

async function deactivatedUser() {
  await apiError("GET", "/account-info/v3/details", 401, "INVALID_AUTHENTICATION", "Authentication credentials not found");
  await apiError("GET", C, 401, "INVALID_AUTHENTICATION");
}

async function rateLimited() {
  for (const entry of CALLS) {
    const result = await callError(entry, 429, "RATE_LIMITS", "You have reached your secondly limit.");
    assert.equal(result.headers.get("x-hubspot-ratelimit-secondly-remaining"), "0");
    assert.equal(result.headers.get("retry-after"), "1");
  }
  await mcpInit();
  const error = (await mcpError("hubspot-list-objects", { objectType: "contacts" }, "tool.RATE_LIMITED")).error;
  assert.equal(error.message, "You have reached your secondly limit.");
}

async function writeUnavailable() {
  for (const entry of WRITE_CALLS) await callError(entry, 503, "INTERNAL_ERROR", "temporarily unavailable");
  const list = await get(C);
  assert.equal(list.json.results.length, 10, "reads keep working");
  assert.equal(list.headers.get("x-hubspot-ratelimit-secondly-remaining"), "99");
  assert.equal((await post(`${C}/search`, {})).json.total, 13);
  assert.equal((await get(`${C}/101?properties=firstname`)).json.properties.firstname, "Alice", "nothing was written");
  assert.deepEqual(targets((await get(`${A}/contacts/101/associations/companies`)).json.results), ["201"], "the archive did not happen");
}

async function writeCommittedLost() {
  const lost = { properties: { email: "lost@example.org", firstname: "Lena" } };
  await apiError("POST", C, 503, "INTERNAL_ERROR", "temporarily unavailable", { body: lost });
  const found = (await post(`${C}/search`, { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: "lost@example.org" }] }] })).json;
  assert.equal(found.total, 1, "the create committed although the caller saw 503");
  assert.equal(found.results[0].id, "1001");
  assert.equal((await get(`${C}/1001`)).json.properties.firstname, "Lena");
  await apiError("POST", C, 409, "CONFLICT", "Contact already exists. Existing ID: 1001", { body: lost });
  await apiError("POST", CO, 503, "INTERNAL_ERROR", "temporarily unavailable", { body: { properties: { name: "Ghost Co" } } });
  const companies = (await get(`${CO}?properties=name&limit=100`)).json.results;
  assert.ok(companies.some((company) => company.id === "1002" && company.properties.name === "Ghost Co"), "the company create committed too (a retry would duplicate it)");
  await apiError("POST", `${C}/batch/create`, 503, "INTERNAL_ERROR", "temporarily unavailable", { body: { inputs: [{ properties: { email: "lost.batch@example.org" } }] } });
  assert.equal((await get(`${C}/1003`)).json.properties.email, "lost.batch@example.org");
  assert.equal((await patch(`${C}/1001`, { properties: { lastname: "Berg" } })).json.properties.lastname, "Berg", "updates are not covered by the fault");
}

/** An actor without identity attributes (as `firedrill tool add` creates) acts as the portal's default user. */
async function freshActor() {
  await get("/account-info/v3/details");
  const contacts = (await get(C)).json;
  assert.equal(contacts.results.length, 10, "a fresh actor sees the seeded portal");
  const note = (await post("/crm/v3/objects/notes", { properties: { hs_note_body: "Fresh actor note.", hs_timestamp: "2026-09-14T10:00:00" } }, { status: 201 })).json;
  assert.equal(note.id, "1001");
  assert.equal(note.properties.hs_timestamp, "2026-09-14T10:00:00.000Z", "zone-less datetime is stored as UTC");
  assert.equal((await get(`/crm/v3/objects/notes/1001?properties=hs_timestamp`)).json.properties.hs_timestamp, "2026-09-14T10:00:00.000Z");
  const latest = (await post("/crm/v3/objects/notes", { properties: { hs_note_body: null, hs_timestamp: "253402300799999" } }, { status: 201 })).json;
  assert.equal(latest.properties.hs_timestamp, "9999-12-31T23:59:59.999Z", "the last representable instant is accepted");
  assert.equal(latest.properties.hs_note_body, undefined, "a null value on create stores nothing");
}

/** Size bounds: HubSpot's 65,536-character property limit, linear wildcard matching, byte-bounded pages and batches. */
async function sizeBounds() {
  const CAP = 65_536;
  const MIB = 1_048_576;
  const search = (body) => post(`${C}/search`, body).then((result) => result.json);
  /** A 200 request whose raw response size is measured in bytes. */
  async function sized(method, path, body) {
    const response = await fetch(`${HTTP}${path}`, {
      method,
      headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    assert.equal(response.status, 200, `${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
    assert.ok(bytes.length < MIB, `${method} ${path}: ${bytes.length} bytes is over 1 MiB`);
    return { json: JSON.parse(text), bytes: bytes.length };
  }
  const started = Date.now();
  await apiError("POST", C, 400, "VALIDATION_ERROR", "above the maximum of 65536", { body: { properties: { firstname: "a".repeat(CAP + 1) } } });
  await apiError("POST", `${C}/batch/create`, 400, "VALIDATION_ERROR", "above the maximum of 65536", { body: { inputs: [{ properties: { firstname: "a".repeat(200_000) } }] } });
  await apiError("POST", D, 400, "VALIDATION_ERROR", "not a valid number", { body: { properties: { dealname: "x", dealstage: "renewed", amount: `${"1".repeat(60_000)}x` } } });
  const before = (await search({})).total;
  for (let batch = 0; batch < 4; batch += 1) {
    const inputs = Array.from({ length: 10 }, (_, index) => ({ properties: { firstname: "a".repeat(CAP), lastname: `long${batch}${index}` } }));
    assert.equal((await post(`${C}/batch/create`, { inputs }, { status: 201 })).json.results.length, 10, "65,536 characters is accepted");
  }
  // Pathological wildcard patterns over 65,536-character tokens answer quickly (KMP, no backtracking).
  const pattern = `*${"a".repeat(1490)}b${"a".repeat(1490)}*`;
  const hit = { propertyName: "firstname", operator: "CONTAINS_TOKEN", value: pattern };
  const miss = { ...hit, operator: "NOT_CONTAINS_TOKEN" };
  const timed = Date.now();
  assert.equal((await search({ filterGroups: [{ filters: [hit] }], limit: 1 })).total, 0);
  assert.equal((await search({ filterGroups: [{ filters: [miss] }], limit: 1 })).total, before + 40);
  assert.equal((await search({ filterGroups: Array.from({ length: 3 }, () => ({ filters: Array(6).fill(hit) })), limit: 1 })).total, 0);
  await apiError("POST", `${C}/search`, 400, "VALIDATION_ERROR", "characters of matching work", {
    body: { filterGroups: Array.from({ length: 3 }, () => ({ filters: [miss, miss, miss, miss, miss, hit] })), limit: 1 },
  });
  assert.ok(Date.now() - timed < 3_000, `wildcard searches took ${Date.now() - timed} ms`);
  await get("/crm/v3/owners");
  assert.equal((await search({ filterGroups: [{ filters: [{ propertyName: "firstname", operator: "CONTAINS_TOKEN", value: "a*a" }] }], limit: 1 })).total, 40);
  assert.equal((await search({ query: "aaaa", limit: 1 })).total, 40, "free-text prefix match over long tokens");
  // 60 contacts with 11,000-character CJK names (about 33 KB each on the wire).
  const created = [];
  for (let batch = 0; batch < 3; batch += 1) {
    const inputs = Array.from({ length: 20 }, (_, index) => ({ properties: { firstname: `${String.fromCodePoint(0x4e00 + batch * 20 + index)}${"漢".repeat(10_999)}`, lastname: `cjk${batch * 20 + index}` } }));
    created.push(...ids((await post(`${C}/batch/create`, { inputs }, { status: 201 })).json.results));
  }
  const expected = before + 100;
  const seen = new Map();
  let path = `${C}?limit=100&properties=firstname`;
  let pages = 0;
  while (path !== undefined) {
    const page = await sized("GET", path);
    pages += 1;
    for (const record of page.json.results) seen.set(record.id, (seen.get(record.id) ?? 0) + 1);
    path = page.json.paging?.next?.link;
  }
  assert.ok(pages > 1, "large rows split the list into byte-bounded pages");
  assert.equal(seen.size, expected);
  assert.ok([...seen.values()].every((count) => count === 1), "every contact is listed exactly once");
  const found = new Map();
  let after;
  pages = 0;
  do {
    const page = await sized("POST", `${C}/search`, { limit: 200, properties: ["firstname"], ...(after === undefined ? {} : { after }) });
    pages += 1;
    assert.equal(page.json.total, expected);
    for (const record of page.json.results) found.set(record.id, (found.get(record.id) ?? 0) + 1);
    after = page.json.paging?.next?.after;
  } while (after !== undefined);
  assert.ok(pages > 1, "large rows split the search into byte-bounded pages");
  assert.equal(found.size, expected);
  assert.ok([...found.values()].every((count) => count === 1), "every contact is found exactly once");
  await apiError("POST", `${C}/batch/read`, 400, "VALIDATION_ERROR", "response limit", { body: { inputs: created.map((id) => ({ id })), properties: ["firstname"] } });
  assert.equal((await sized("POST", `${C}/batch/read`, { inputs: created.slice(0, 20).map((id) => ({ id })), properties: ["firstname"] })).json.results.length, 20);
  const wide = "漢".repeat(CAP);
  await apiError("POST", C, 400, "VALIDATION_ERROR", "response limit", { body: { properties: { firstname: wide, lastname: wide, company: wide, jobtitle: wide, city: "漢".repeat(40_000) } } });
  assert.equal((await search({ limit: 1 })).total, expected, "a create whose response would be too large writes nothing");
  assert.ok(Date.now() - started < 60_000);
}

// ---------------------------------------------------------------------------------------------

const flows = {
  "fresh-actor": freshActor,
  "rest-flow": restFlow,
  "mcp-aliases": mcpAliases,
  "owned-visibility": ownedVisibility,
  "no-scopes": noScopes,
  scopes,
  denied,
  "invalid-auth": invalidAuth,
  "deactivated-user": deactivatedUser,
  "rate-limited": rateLimited,
  "write-unavailable": writeUnavailable,
  "write-committed-lost": writeCommittedLost,
  "size-bounds": sizeBounds,
};
const selected = Object.keys(flows).find((name) => instruction.includes(`the ${name} conformance flow`));
if (selected === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
