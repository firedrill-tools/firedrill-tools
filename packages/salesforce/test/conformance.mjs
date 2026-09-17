// Salesforce Tool conformance target. A scripted Tool test, not a model-driven agent.
// Node built-ins only: fetch against the Salesforce-shaped REST routes (plus the canonical Firedrill
// operation endpoint for the route-less sobjects.describe) and raw MCP JSON-RPC (Streamable HTTP)
// for the @salesforce/mcp tool-name aliases. Every flow fails loudly on an unexpected status, header
// or body.
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

const V = "v62.0";
const D = `/services/data/${V}`;
const MAREN = "005Fd0000000001IAA";
const DIEGO = "005Fd0000000002IAA";
const AIKO = "005Fd0000000003IAA";
const BEN = "005Fd0000000004IAA";
const JONAS = "005Fd0000000006IAA";
const ORG = "00DFd0000000001MAA";
const ACC = (n) => `001Fd0000000${n}IAA`;
const CON = (n) => `003Fd0000000${n}IAA`;
const LEAD = (n) => `00QFd0000000${n}MAA`;
const OPP = (n) => `006Fd0000000${n}IAA`;
const TASK = (n) => `00TFd0000000${n}MAA`;
const NEW_ACC = (n) => `001Fd000000${n}IAA`;
const SESSION_MESSAGE = "Session expired or invalid";
const NOT_FOUND_MESSAGE = "The requested resource does not exist";
const INSUFFICIENT = "insufficient access rights on object id";
const FAULT_CODES = new Set(["REQUEST_LIMIT_EXCEEDED", "UNABLE_TO_LOCK_ROW", "SERVER_UNAVAILABLE", "API_DISABLED_FOR_ORG"]);

const ALL_OPERATIONS = [
  "versions.list", "userinfo.get", "limits.get", "sobjects.list", "sobjects.basic-info", "sobjects.describe", "records.create", "records.retrieve",
  "records.update", "records.delete", "records.upsert", "query.execute", "query.more", "search.parameterized", "collections.create",
  "collections.retrieve", "collections.update", "collections.delete", "collections.upsert", "composite.execute",
];

/** Self-contained query locator exactly as the Tool mints it (base64url of the JSON payload, no padding). */
function locator(payload) {
  return `01g${Buffer.from(JSON.stringify(payload)).toString("base64url")}-${payload.offset}`;
}
const MAREN_LOCATOR = locator({ q: "SELECT Id FROM Contact", includeDeleted: false, offset: 5, batchSize: 5, userId: MAREN });

/** One representative request per operation, in ALL_OPERATIONS order (`sobjects.describe` goes through the canonical endpoint). */
const CALLS = [
  ["GET", "/services/data"],
  ["GET", "/services/oauth2/userinfo"],
  ["GET", `${D}/limits`],
  ["GET", `${D}/sobjects`],
  ["GET", `${D}/sobjects/Account`],
  ["OP", "sobjects.describe", { sobjectType: "Account" }],
  ["POST", `${D}/sobjects/Account`, { Name: "Probe Co" }],
  ["GET", `${D}/sobjects/Account/${ACC(101)}`],
  ["PATCH", `${D}/sobjects/Account/${ACC(101)}`, { Phone: "+1 555 0100" }],
  ["DELETE", `${D}/sobjects/Account/${ACC(103)}`],
  ["PATCH", `${D}/sobjects/Account/External_Id__c/BW-ACC-0001`, { Phone: "+1 555 0100" }],
  ["GET", `${D}/query?q=${encodeURIComponent("SELECT Id FROM Account")}`],
  ["GET", `${D}/query/${MAREN_LOCATOR}`],
  ["POST", `${D}/parameterizedSearch`, { q: "nordlicht" }],
  ["POST", `${D}/composite/sobjects`, { records: [{ attributes: { type: "Lead" }, LastName: "Probe", Company: "Probe Co" }] }],
  ["POST", `${D}/composite/sobjects/Account`, { ids: [ACC(101)], fields: ["Id"] }],
  ["PATCH", `${D}/composite/sobjects`, { records: [{ attributes: { type: "Account" }, Id: ACC(101), Phone: "+1 555 0100" }] }],
  ["DELETE", `${D}/composite/sobjects?ids=${ACC(103)}`],
  ["PATCH", `${D}/composite/sobjects/Account/External_Id__c`, { records: [{ attributes: { type: "Account" }, External_Id__c: "BW-ACC-0001", Phone: "+1 555 0100" }] }],
  ["POST", `${D}/composite`, { compositeRequest: [{ method: "GET", url: `${D}/limits`, referenceId: "limits" }] }],
];
const WRITE_INDEXES = [6, 8, 9, 10, 14, 16, 17, 18, 19];
const CREATE_INDEXES = [6, 10, 14, 18];
const VERSIONED_INDEXES = CALLS.map((_, index) => index).filter((index) => index > 1);

// ---------------------------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------------------------

function checkLimitHeader(method, path, status, headers, json) {
  const header = headers.get("sforce-limit-info");
  const objectBody = typeof json === "object" && json !== null && !Array.isArray(json);
  if (status < 300 && objectBody) assert.match(header ?? "", /^api-usage=\d+\/\d+$/, `${method} ${path}: missing Sforce-Limit-Info on a success body`);
  if (status >= 400 && Array.isArray(json) && json[0] && !FAULT_CODES.has(json[0].errorCode) && json[0].errorCode !== "JSON_PARSER_ERROR") {
    assert.match(header ?? "", /^api-usage=\d+\/\d+$/, `${method} ${path}: missing Sforce-Limit-Info on ${json[0].errorCode}`);
  }
}

/** Salesforce-shaped request; `status` is asserted, headers checked, the JSON body (if any) returned. */
async function api(method, path, { body, status = 200, headers = {}, contentType, rawBody, scheme = "Bearer" } = {}) {
  const hasBody = body !== undefined || rawBody !== undefined;
  const response = await fetch(`${HTTP}${path}`, {
    method,
    headers: { authorization: `${scheme} ${HTTP_TOKEN}`, accept: "application/json", ...(hasBody ? { "content-type": contentType ?? "application/json" } : {}), ...headers },
    ...(hasBody ? { body: rawBody ?? JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const json = text.length > 0 ? JSON.parse(text) : undefined;
  assert.equal(response.status, status, `${method} ${path} ${body === undefined ? "" : JSON.stringify(body).slice(0, 200)} -> ${response.status} ${text.slice(0, 400)}`);
  if (status === 204) assert.equal(text, "", `${method} ${path}: 204 must have no body`);
  else if (json !== undefined) assert.match(response.headers.get("content-type") ?? "", /^application\/json/, `${method} ${path}: content type`);
  checkLimitHeader(method, path, response.status, response.headers, json);
  return { json, headers: response.headers, status: response.status };
}
const get = (path, options) => api("GET", path, options);
const post = (path, body, options) => api("POST", path, { ...options, body });
const patch = (path, body, options) => api("PATCH", path, { ...options, status: 204, body });
const del = (path, options) => api("DELETE", path, { ...options, status: 204 });
const q = (soql, all = false) => `${D}/${all ? "queryAll" : "query"}?q=${encodeURIComponent(soql)}`;
const query = async (soql, options) => (await get(q(soql), options)).json;
const ids = (result) => result.records.map((record) => record.Id);

/** Expect Salesforce's error array with the given code (and message fragment / fields). */
async function apiError(method, path, status, code, { body, text, fields, headers, contentType, rawBody, scheme } = {}) {
  const result = await api(method, path, { status, body, headers, contentType, rawBody, scheme });
  const errors = result.json;
  assert.ok(Array.isArray(errors) && errors.length === 1 && typeof errors[0].errorCode === "string", `${method} ${path}: not a Salesforce error array: ${JSON.stringify(errors)}`);
  assert.equal(errors[0].errorCode, code, `${method} ${path}: ${JSON.stringify(errors)}`);
  if (text !== undefined) assert.ok(String(errors[0].message).includes(text), `${method} ${path}: expected ${JSON.stringify(text)} in ${JSON.stringify(errors[0])}`);
  if (fields !== undefined) assert.deepEqual(errors[0].fields, fields, `${method} ${path}: fields ${JSON.stringify(errors[0])}`);
  return result;
}

/** Canonical Firedrill operation endpoint (used for the route-less sobjects.describe). */
async function operation(id, args, expected) {
  const response = await fetch(`${HTTP}/v1/operations/salesforce/${id}`, {
    method: "POST",
    headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  });
  const result = await response.json();
  assert.ok(result.outcome, `operation ${id}: ${response.status} ${JSON.stringify(result).slice(0, 300)}`);
  if (expected === undefined) assert.equal(result.outcome.status, "ok", `operation ${id}: ${JSON.stringify(result.outcome).slice(0, 400)}`);
  else assert.equal(result.outcome.error?.code ?? result.outcome.status, expected, `operation ${id}: ${JSON.stringify(result.outcome).slice(0, 400)}`);
  return result.outcome;
}

async function call([method, path, body], options = {}) {
  if (method === "OP") return operation(path, body);
  return api(method, path, { ...options, ...(body === undefined ? {} : { body }) });
}
async function callError([method, path, body], status, code, text) {
  if (method === "OP") {
    const outcome = await operation(path, body, `tool.${code}`);
    if (text) assert.ok(outcome.error.message.includes(text), JSON.stringify(outcome));
    return outcome;
  }
  return apiError(method, path, status, code, { text, body });
}
function withVersion([method, path, body], version) {
  if (method === "OP") return [method, path, { ...body, version }];
  return [method, path.replace(`/${V}/`, `/${version}/`), body];
}

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
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim()))
    : [JSON.parse(text)];
  const reply = messages.find((message) => message.id === rpcId);
  assert.ok(reply, `MCP ${method}: no JSON-RPC reply`);
  if (reply.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}
async function mcpInit() {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "salesforce-conformance", version: "0.1.0" } });
}
/** The tool result value; array-shaped results (and their error outcomes) arrive wrapped as `{ result }` in structuredContent. */
function mcpValue(result) {
  assert.ok(Array.isArray(result.content) && result.content[0]?.type === "text", `MCP result without a text block: ${JSON.stringify(result).slice(0, 300)}`);
  if (result.isError && result.structuredContent === undefined) return { status: "invalid", error: { code: "invalid", message: result.content[0].text } };
  const value = JSON.parse(result.content[0].text);
  const structured = result.structuredContent;
  assert.ok(structured !== undefined, "MCP result without structuredContent");
  const wrapped = Object.keys(structured).length === 1 && "result" in structured && !(typeof value === "object" && value !== null && !Array.isArray(value) && "result" in value);
  assert.deepEqual(wrapped ? structured.result : structured, value, "structuredContent must mirror the text block");
  return value;
}
async function mcp(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(!result.isError, `${name} ${JSON.stringify(args)}: ${JSON.stringify(result).slice(0, 500)}`);
  return mcpValue(result);
}
async function mcpError(name, args, code, text) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(result.isError, `${name} ${JSON.stringify(args)} unexpectedly succeeded`);
  const outcome = mcpValue(result);
  if (code) {
    assert.ok(outcome.error, `${name}: ${JSON.stringify(result).slice(0, 400)}`);
    assert.equal(outcome.error.code, code, JSON.stringify(outcome.error));
    if (text) assert.ok(String(outcome.error.message).includes(text), JSON.stringify(outcome.error));
  }
  return outcome;
}

const isId = (value, prefix) => typeof value === "string" && value.length === 18 && value.startsWith(prefix);

// ---------------------------------------------------------------------------------------------
// Drill: rest-flow (admin = Maren, baseline)
// ---------------------------------------------------------------------------------------------

async function restFlow() {
  // Handshake and identity
  const versions = (await get("/services/data")).json;
  assert.ok(versions.some((entry) => entry.version === "62.0" && entry.url === "/services/data/v62.0"));
  assert.equal(versions[versions.length - 1].version, "66.0");
  assert.equal(versions[0].version, "46.0");
  const me = (await get("/services/oauth2/userinfo")).json;
  assert.equal(me.preferred_username, "maren.solberg@brightwater.example.com");
  assert.equal(me.user_id, MAREN);
  assert.equal(me.organization_id, ORG);
  assert.ok(me.urls.rest.endsWith("/services/data/v{version}/"));
  assert.equal((await get("/services/oauth2/userinfo", { scheme: "OAuth" })).json.user_id, MAREN, "the legacy OAuth scheme is accepted");
  const limits = (await get(`${D}/limits`)).json;
  assert.deepEqual(limits.DailyApiRequests, { Max: 15000, Remaining: 14862 });
  assert.deepEqual(limits.DataStorageMB, { Max: 200, Remaining: 197 });
  await apiError("GET", "/services/data/v99.0/limits", 404, "NOT_FOUND", { text: NOT_FOUND_MESSAGE });
  await apiError("GET", "/services/data/v45.0/limits", 404, "NOT_FOUND");
  for (const index of VERSIONED_INDEXES) await callError(withVersion(CALLS[index], "v99.0"), 404, "NOT_FOUND", NOT_FOUND_MESSAGE);
  await operation("userinfo.get", { defaultDevHub: true }, "tool.NOT_FOUND");

  // Describe
  const global = (await get(`${D}/sobjects`)).json;
  assert.equal(global.encoding, "UTF-8");
  assert.deepEqual(global.sobjects.map((entry) => entry.name), ["Account", "Contact", "Lead", "Opportunity", "Profile", "Task", "User"]);
  assert.equal(global.sobjects[0].keyPrefix, "001");
  assert.equal(global.sobjects[6].createable, false);
  assert.equal(global.sobjects[0].urls.describe, `${D}/sobjects/Account/describe`);
  const basic = (await get(`${D}/sobjects/Account`)).json;
  assert.equal(basic.objectDescribe.name, "Account");
  assert.equal(basic.recentItems.length, 5);
  assert.equal(basic.recentItems[0].Id, ACC(109), "most recently modified account first");
  assert.equal(basic.recentItems[0].attributes.type, "Account");
  await apiError("GET", `${D}/sobjects/Case`, 404, "NOT_FOUND");
  const describe = (await operation("sobjects.describe", { sobjectType: "Opportunity" })).value;
  assert.equal(describe.name, "Opportunity");
  assert.equal(describe.fields.find((field) => field.name === "StageName").picklistValues.length, 10);
  assert.equal(describe.fields.find((field) => field.name === "ARR__c").custom, true);
  assert.equal(describe.fields.find((field) => field.name === "AccountId").referenceTo[0], "Account");
  assert.ok(describe.childRelationships.some((entry) => entry.relationshipName === "Tasks"));
  assert.match(describe._limitInfo, /^api-usage=138\/15000$/, "canonical outputs carry the limit carrier");
  await operation("sobjects.describe", { sobjectType: "Foo__c" }, "tool.NOT_FOUND");
  await apiError("GET", `${D}/sobjects/Account/describe`, 400, "MALFORMED_ID", { text: "malformed id describe" });

  // Create
  const created = (await post(`${D}/sobjects/Account`, { Name: "Nordlicht Labs GmbH", Industry: "Biotechnology", NumberOfEmployees: 40, External_Id__c: "BW-ACC-0099", Website: "https://nordlicht-labs.example.com/munich" }, { status: 201 }));
  const newId = created.json.id;
  assert.ok(isId(newId, "001"), newId);
  assert.equal(newId, NEW_ACC("1001"), "ids come from the counter row");
  assert.deepEqual({ success: created.json.success, errors: created.json.errors }, { success: true, errors: [] });
  assert.equal(created.headers.get("location"), `${D}/sobjects/Account/${newId}`);
  assert.equal(created.headers.get("sforce-limit-info"), "api-usage=138/15000");
  await apiError("POST", `${D}/sobjects/Account`, 400, "DUPLICATE_VALUE", { body: { Name: "Dup", External_Id__c: "BW-ACC-0099" }, text: "External_Id__c", fields: ["External_Id__c"] });
  await apiError("POST", `${D}/sobjects/Account`, 400, "REQUIRED_FIELD_MISSING", { body: { Industry: "Biotechnology" }, text: "[Name]", fields: ["Name"] });
  await apiError("POST", `${D}/sobjects/Account`, 400, "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", { body: { Name: "x", Industry: "Space" }, text: "bad value for restricted picklist field: Space", fields: ["Industry"] });
  await apiError("POST", `${D}/sobjects/Account`, 400, "INVALID_FIELD", { body: { Name: "x", Foo: 1 }, text: "No such column 'Foo' on sobject of type Account" });
  await apiError("POST", `${D}/sobjects/Account`, 400, "INVALID_FIELD_FOR_INSERT_UPDATE", { body: { Name: "x", CreatedDate: "2026-01-01T00:00:00.000+0000" }, text: "Unable to create/update fields: CreatedDate", fields: ["CreatedDate"] });
  await apiError("POST", `${D}/sobjects/Account`, 400, "JSON_PARSER_ERROR", { body: { Name: "x", NumberOfEmployees: "forty" }, text: "Cannot deserialize instance of int from VALUE_STRING value forty" });
  await apiError("POST", `${D}/sobjects/Account`, 400, "INVALID_CROSS_REFERENCE_KEY", { body: { Name: "x", OwnerId: JONAS }, text: "invalid cross reference id", fields: ["OwnerId"] });
  await apiError("POST", `${D}/sobjects/Account`, 400, "FIELD_INTEGRITY_EXCEPTION", { body: { Name: "x", ParentId: CON(201) }, text: "id value of incorrect type", fields: ["ParentId"] });
  await apiError("POST", `${D}/sobjects/Account`, 400, "INVALID_CROSS_REFERENCE_KEY", { body: { Name: "x", ParentId: ACC(999) } });
  await apiError("POST", `${D}/sobjects/Account`, 400, "MALFORMED_ID", { body: { Name: "x", ParentId: "abc" }, text: "malformed id abc" });
  await apiError("POST", `${D}/sobjects/Account`, 400, "INVALID_FIELD", { body: { Name: "x", Website: "y".repeat(300) }, text: "data value too large" });
  await apiError("POST", `${D}/sobjects/Contact`, 400, "INVALID_FIELD", { body: { LastName: "x", Email: "not-an-email" }, text: "invalid email address" });
  await apiError("POST", `${D}/sobjects/Opportunity`, 400, "FIELD_CUSTOM_VALIDATION_EXCEPTION", { body: { Name: "Won without amount", StageName: "Closed Won", CloseDate: "2026-09-30" }, text: "Closed Won opportunities must have an Amount.", fields: ["Amount"] });
  await apiError("POST", `${D}/sobjects/User`, 400, "INVALID_TYPE_FOR_OPERATION", { body: { Username: "a@b.test" } });
  await apiError("POST", `${D}/sobjects/Case`, 404, "INVALID_TYPE", { body: {}, text: "sObject type 'Case' is not supported" });
  const form = await fetch(`${HTTP}${D}/sobjects/Account`, { method: "POST", headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/x-www-form-urlencoded" }, body: "Name=x" });
  assert.equal(form.status, 415, "form bodies are the framework's 415");

  // Retrieve
  const full = (await get(`${D}/sobjects/Account/${newId}`)).json;
  assert.equal(full.attributes.url, `${D}/sobjects/Account/${newId}`);
  assert.equal(full.Name, "Nordlicht Labs GmbH");
  assert.equal(full.OwnerId, MAREN);
  assert.equal(full.CreatedById, MAREN);
  assert.equal(full.CreatedDate, "2026-09-14T09:00:00.000+0000", "timestamps come from virtual time");
  assert.equal(full.IsDeleted, false);
  assert.equal(full.Customer_Tier__c, null);
  const projected = (await get(`${D}/sobjects/Account/${newId}?fields=Name,Owner.Name,NumberOfEmployees`)).json;
  assert.deepEqual(Object.keys(projected).sort(), ["Id", "Name", "NumberOfEmployees", "Owner", "attributes"]);
  assert.equal(projected.Owner.Name, "Maren Solberg");
  assert.equal(projected.Owner.attributes.type, "User");
  await apiError("GET", `${D}/sobjects/Account/${newId}?fields=Nope`, 400, "INVALID_FIELD");
  await apiError("GET", `${D}/sobjects/Account/${newId}?fields=Account.Owner.Name`, 400, "INVALID_FIELD");
  assert.equal((await get(`${D}/sobjects/Account/${newId.slice(0, 15)}`)).json.Id, newId, "15-character ids resolve to 18");
  const body15 = newId.slice(0, 15);
  assert.equal(body15.slice(3, 5), "Fd", "minted ids carry the Fd0 marker");
  assert.equal(newId.slice(15), "IAA", "the case-safe suffix of an Fd0 id with a digit body is IAA");
  assert.equal((await get(`${D}/sobjects/Account/${body15.toLowerCase()}IAA`)).json.Id, newId, "18-character ids are case-insensitive: the suffix re-cases the body");
  assert.equal((await get(`${D}/sobjects/Account/${body15}iaa`)).json.Id, newId, "a lower-case suffix is accepted");
  await apiError("GET", `${D}/sobjects/Account/${body15}IAB`, 400, "MALFORMED_ID", { text: `malformed id ${body15}IAB` });
  await apiError("GET", `${D}/sobjects/Account/${body15}IA9`, 400, "MALFORMED_ID");
  await apiError("GET", `${D}/sobjects/Account/${body15}AAA`, 404, "NOT_FOUND");
  await operation("records.retrieve", { sobjectType: "Account", id: `${body15}IAB` }, "tool.MALFORMED_ID");
  assert.equal((await operation("records.retrieve", { sobjectType: "Account", id: `${body15.toLowerCase()}iaa` })).value.Id, newId);
  await apiError("POST", `${D}/sobjects/Contact`, 400, "MALFORMED_ID", { body: { LastName: "x", AccountId: `${body15}IAB` }, fields: ["AccountId"] });
  await apiError("GET", `${D}/sobjects/Account/${CON(201)}`, 404, "NOT_FOUND");
  await apiError("GET", `${D}/sobjects/Account/${ACC(110)}`, 404, "ENTITY_IS_DELETED", { text: "entity is deleted" });
  await apiError("GET", `${D}/sobjects/Account/${ACC(999)}`, 404, "NOT_FOUND");
  await apiError("GET", `${D}/sobjects/Account/zzz`, 400, "MALFORMED_ID");
  await apiError("GET", `${D}/sobjects/Case/${ACC(101)}`, 404, "INVALID_TYPE");
  assert.equal((await get(`${D}/sobjects/Account/External_Id__c/BW-ACC-0001`)).json.Id, ACC(101));
  assert.equal((await get(`${D}/sobjects/account/external_id__c/bw-acc-0001?fields=Id`)).json.Id, ACC(101), "type, field and value are case-insensitive");
  await apiError("GET", `${D}/sobjects/Account/External_Id__c/nope`, 404, "NOT_FOUND");
  await apiError("GET", `${D}/sobjects/Account/Customer_Tier__c/Team`, 404, "NOT_FOUND", { text: "Provided external ID field does not exist or is not accessible: Customer_Tier__c" });

  // Update
  await patch(`${D}/sobjects/Account/${newId}`, { Phone: "+31 20 123 4567", Industry: null });
  const updated = (await get(`${D}/sobjects/Account/${newId}`)).json;
  assert.equal(updated.Phone, "+31 20 123 4567");
  assert.equal(updated.Industry, null);
  assert.ok(updated.LastModifiedDate >= updated.CreatedDate);
  await patch(`${D}/sobjects/Account/${newId}`, { Phone: "+31 20 123 4567" });
  await apiError("PATCH", `${D}/sobjects/Account/${newId}`, 400, "REQUIRED_FIELD_MISSING", { body: { Name: null }, fields: ["Name"] });
  await apiError("PATCH", `${D}/sobjects/Account/${newId}`, 400, "INVALID_FIELD_FOR_INSERT_UPDATE", { body: { Id: ACC(101) } });
  // A 32,000-character stored Description (the long text area maximum) proves search stays linear on long values;
  // the Website carries LIKE wildcard characters for the escape checks below.
  await patch(`${D}/sobjects/Account/${newId}`, { Id: newId, Description: `${"a".repeat(31900)} Id in the body is accepted when it matches; rate 100% a_b`, Website: "https://nordlicht-labs.example.com/rate-100%-a_b" });
  // Long text areas cannot be filtered or sorted in SOQL, as in Salesforce.
  await apiError("GET", q(`SELECT Id FROM Account WHERE Description LIKE '%${"a".repeat(3990)}b%'`), 400, "INVALID_FIELD", { text: "field 'Description' can not be filtered in query call", fields: ["Description"] });
  await apiError("GET", q("SELECT Id FROM Account WHERE Description = 'x'"), 400, "INVALID_FIELD", { text: "can not be filtered in query call" });
  await apiError("GET", q("SELECT Id FROM Contact WHERE Account.Description IN ('x')"), 400, "INVALID_FIELD", { text: "can not be filtered in query call" });
  await apiError("GET", q("SELECT Id FROM Account ORDER BY Description"), 400, "INVALID_FIELD", { text: "field 'Description' can not be sorted in a query call" });
  await apiError("POST", `${D}/parameterizedSearch`, 400, "INVALID_FIELD", { body: { q: "aaaa*", sobjects: [{ name: "Account", where: `Description LIKE '${"%a_".repeat(16)}%q'` }] }, text: "can not be filtered in query call" });
  // Escaped LIKE wildcards against the Website just written: \% and \_ are literal, bare % and _ stay wildcards.
  assert.deepEqual(ids(await query("SELECT Id FROM Account WHERE Website LIKE '%100\\%%'")), [newId]);
  assert.deepEqual(ids(await query("SELECT Id FROM Account WHERE Website LIKE '%A\\_B'")), [newId]);
  assert.equal((await query(`SELECT Id FROM Account WHERE Id = '${newId}' AND Website LIKE '%a\\_x%'`)).totalSize, 0);
  assert.deepEqual(ids(await query(`SELECT Id FROM Account WHERE Id = '${newId}' AND Website LIKE '%rate-100_-a_b'`)), [newId]);
  assert.equal((await query(`SELECT Id FROM Account WHERE Id = '${newId}' AND Website LIKE '%rate-100\\_-a_b'`)).totalSize, 0);
  // Wildcard-heavy and long near-miss patterns (string literals up to Salesforce's 4,000 characters), several
  // clauses over the same column, through composite: answered well under a second.
  const longStarted = performance.now();
  const longLike = await post(`${D}/composite`, {
    compositeRequest: [
      `SELECT Id FROM Account WHERE Name LIKE '%${"a".repeat(3990)}b%'`,
      `SELECT Id FROM Account WHERE Website LIKE '%${"a_".repeat(127)}ab%' OR Website LIKE 'https://%' AND Website LIKE '%100\\%-a\\_b'`,
      `SELECT Id FROM Account WHERE Name LIKE '${"%a".repeat(16)}%q' OR Name LIKE '${"%a_".repeat(16)}%q'`,
      `SELECT Id FROM Account WHERE ${Array(300).fill("Website LIKE '%h%t%t%p%100\\%%'").join(" AND ")}`,
      `SELECT Id FROM Account WHERE Name LIKE '${"x".repeat(4001)}'`,
    ].map((statement, index) => ({ method: "GET", url: `${D}/query?q=${encodeURIComponent(statement)}`, referenceId: `long${index}` })),
  });
  assert.deepEqual(longLike.json.compositeResponse.map((item) => item.httpStatusCode), [200, 200, 200, 200, 400]);
  assert.deepEqual(longLike.json.compositeResponse.slice(0, 4).map((item) => item.body.records.map((record) => record.Id)), [[], [newId], [], [newId]]);
  assert.equal(longLike.json.compositeResponse[4].body[0].errorCode, "MALFORMED_QUERY");
  assert.match(longLike.json.compositeResponse[4].body[0].message, /String literal exceeds the maximum length of 4000 characters/);
  assert.ok(performance.now() - longStarted < 1000, `long LIKE segments answered in ${performance.now() - longStarted} ms`);
  await apiError("GET", q(`SELECT Id FROM Account WHERE Website LIKE '%${"a_".repeat(129)}b%'`), 400, "MALFORMED_QUERY", { text: "exceeds the supported length of 256" });
  const longSearchStarted = performance.now();
  assert.deepEqual((await post(`${D}/parameterizedSearch`, { q: `${"a*".repeat(16)}q` })).json.searchRecords, []);
  assert.deepEqual((await post(`${D}/parameterizedSearch`, { q: `${"a?".repeat(99)}b` })).json.searchRecords, []);
  assert.deepEqual((await post(`${D}/parameterizedSearch`, { q: "aaaa* rate", sobjects: [{ name: "Account" }] })).json.searchRecords.map((record) => record.Id), [newId]);
  assert.ok(performance.now() - longSearchStarted < 1000, `wildcard-heavy search answered in ${performance.now() - longSearchStarted} ms`);
  await apiError("PATCH", `${D}/sobjects/Account/${newId}`, 400, "INVALID_FIELD", { body: { Foo: 1 } });
  await apiError("PATCH", `${D}/sobjects/Account/${newId}`, 400, "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", { body: { Customer_Tier__c: "Platinum" }, fields: ["Customer_Tier__c"] });
  await apiError("PATCH", `${D}/sobjects/Account/${newId}`, 400, "INVALID_CROSS_REFERENCE_KEY", { body: { OwnerId: JONAS } });
  await apiError("PATCH", `${D}/sobjects/Account/${newId}`, 400, "FIELD_INTEGRITY_EXCEPTION", { body: { ParentId: newId }, text: "cannot be its own parent" });
  await apiError("PATCH", `${D}/sobjects/Account/${newId}`, 400, "DUPLICATE_VALUE", { body: { External_Id__c: "BW-ACC-0001" } });
  await apiError("PATCH", `${D}/sobjects/Account/${newId}`, 400, "JSON_PARSER_ERROR", { body: { AnnualRevenue: "lots" } });
  await apiError("PATCH", `${D}/sobjects/Account/${newId}`, 400, "MALFORMED_ID", { body: { ParentId: "12" } });
  await apiError("PATCH", `${D}/sobjects/Account/${ACC(110)}`, 404, "ENTITY_IS_DELETED", { body: { Phone: "1" } });
  await apiError("PATCH", `${D}/sobjects/Account/${ACC(999)}`, 404, "NOT_FOUND", { body: { Phone: "1" } });
  await apiError("PATCH", `${D}/sobjects/Account/zzz`, 400, "MALFORMED_ID", { body: { Phone: "1" } });
  await apiError("PATCH", `${D}/sobjects/User/${MAREN}`, 400, "INVALID_TYPE_FOR_OPERATION", { body: { Title: "x" } });
  await apiError("PATCH", `${D}/sobjects/Case/${ACC(101)}`, 404, "INVALID_TYPE", { body: { Phone: "1" } });
  await apiError("PATCH", `${D}/sobjects/Lead/${LEAD(308)}`, 400, "CANNOT_UPDATE_CONVERTED_LEAD", { body: { Rating: "Hot" } });
  await apiError("PATCH", `${D}/sobjects/Lead/${LEAD(301)}`, 400, "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", { body: { Status: "Closed - Converted" }, fields: ["Status"] });
  await apiError("PATCH", `${D}/sobjects/Opportunity/${OPP(404)}`, 400, "FIELD_CUSTOM_VALIDATION_EXCEPTION", { body: { StageName: "Closed Won" }, fields: ["Amount"] });
  await patch(`${D}/sobjects/Opportunity/${OPP(404)}`, { StageName: "Closed Won", Amount: 42000 });
  const won = (await get(`${D}/sobjects/Opportunity/${OPP(404)}`)).json;
  assert.deepEqual({ IsClosed: won.IsClosed, IsWon: won.IsWon, Probability: won.Probability, ForecastCategoryName: won.ForecastCategoryName }, { IsClosed: true, IsWon: true, Probability: 100, ForecastCategoryName: "Closed" });
  await patch(`${D}/sobjects/Opportunity/${OPP(405)}`, { StageName: "Negotiation/Review" });
  assert.equal((await get(`${D}/sobjects/Opportunity/${OPP(405)}?fields=Probability,ForecastCategory`)).json.Probability, 90);
  await patch(`${D}/sobjects/Opportunity/${OPP(407)}`, { StageName: "Value Proposition", Probability: 55 });
  assert.equal((await get(`${D}/sobjects/Opportunity/${OPP(407)}?fields=Probability`)).json.Probability, 55, "an explicit Probability is kept");

  // Tasks
  await apiError("POST", `${D}/sobjects/Task`, 400, "FIELD_INTEGRITY_EXCEPTION", { body: { Subject: "Call", WhoId: ACC(101) }, fields: ["WhoId"] });
  const taskId = (await post(`${D}/sobjects/Task`, { Subject: "Call", WhoId: CON(201), WhatId: OPP(401) }, { status: 201 })).json.id;
  assert.ok(isId(taskId, "00T"));
  const createdTask = (await get(`${D}/sobjects/Task/${taskId}`)).json;
  assert.deepEqual({ Status: createdTask.Status, Priority: createdTask.Priority, IsClosed: createdTask.IsClosed }, { Status: "Not Started", Priority: "Normal", IsClosed: false });
  await patch(`${D}/sobjects/Task/${taskId}`, { Status: "Completed" });
  assert.equal((await get(`${D}/sobjects/Task/${taskId}?fields=IsClosed,Who.Name,What.Type`)).json.IsClosed, true);

  // Upsert
  const upsertExisting = (await api("PATCH", `${D}/sobjects/Account/External_Id__c/BW-ACC-0001`, { body: { Phone: "+1 555 0100" } })).json;
  assert.deepEqual({ id: upsertExisting.id, created: upsertExisting.created, success: upsertExisting.success }, { id: ACC(101), created: false, success: true });
  const upsertNew = (await api("PATCH", `${D}/sobjects/Account/External_Id__c/BW-ACC-0777`, { body: { Name: "Upserted Co" } })).json;
  assert.equal(upsertNew.created, true);
  assert.ok(isId(upsertNew.id, "001"));
  assert.equal((await get(`${D}/sobjects/Account/${upsertNew.id}?fields=External_Id__c,Name`)).json.External_Id__c, "BW-ACC-0777");
  assert.equal((await api("PATCH", `${D}/sobjects/Account/Id/${ACC(101)}`, { body: { Website: "https://x.example.org" } })).json.created, false);
  await apiError("PATCH", `${D}/sobjects/Account/Id/${ACC(999)}`, 404, "NOT_FOUND", { body: { Website: "https://x.example.org" } });
  await apiError("PATCH", `${D}/sobjects/Account/Id/${ACC(110)}`, 404, "ENTITY_IS_DELETED", { body: { Website: "https://x.example.org" } });
  await apiError("PATCH", `${D}/sobjects/Account/Id/zzz`, 400, "MALFORMED_ID", { body: { Website: "https://x.example.org" } });
  await apiError("PATCH", `${D}/sobjects/Account/External_Id__c/BW-ACC-0001`, 400, "INVALID_FIELD", { body: { External_Id__c: "OTHER" } });
  await apiError("PATCH", `${D}/sobjects/Account/Customer_Tier__c/Team`, 404, "NOT_FOUND", { body: { Name: "x" } });
  await apiError("PATCH", `${D}/sobjects/Account/External_Id__c/BW-ACC-0778`, 400, "REQUIRED_FIELD_MISSING", { body: { Industry: "Energy" }, fields: ["Name"] });
  await apiError("PATCH", `${D}/sobjects/Account/External_Id__c/BW-ACC-0778`, 400, "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", { body: { Name: "x", Industry: "Space" } });
  await apiError("PATCH", `${D}/sobjects/Account/External_Id__c/BW-ACC-0778`, 400, "INVALID_FIELD_FOR_INSERT_UPDATE", { body: { Name: "x", CreatedDate: "2026-01-01T00:00:00.000+0000" } });
  await apiError("PATCH", `${D}/sobjects/Account/External_Id__c/BW-ACC-0778`, 400, "INVALID_CROSS_REFERENCE_KEY", { body: { Name: "x", OwnerId: JONAS } });
  await apiError("PATCH", `${D}/sobjects/Account/External_Id__c/BW-ACC-0778`, 400, "FIELD_INTEGRITY_EXCEPTION", { body: { Name: "x", ParentId: CON(201) } });
  await apiError("PATCH", `${D}/sobjects/Account/External_Id__c/BW-ACC-0778`, 400, "JSON_PARSER_ERROR", { body: { Name: "x", NumberOfEmployees: "ten" } });
  await apiError("PATCH", `${D}/sobjects/Account/Id/${newId}`, 400, "DUPLICATE_VALUE", { body: { External_Id__c: "BW-ACC-0001" } });
  await apiError("PATCH", `${D}/sobjects/Opportunity/Id/${OPP(402)}`, 400, "FIELD_CUSTOM_VALIDATION_EXCEPTION", { body: { StageName: "Closed Won", Amount: 0 } });
  await apiError("PATCH", `${D}/sobjects/Lead/Id/${LEAD(308)}`, 400, "CANNOT_UPDATE_CONVERTED_LEAD", { body: { Rating: "Cold" } });
  await apiError("PATCH", `${D}/sobjects/User/Id/${MAREN}`, 400, "INVALID_TYPE_FOR_OPERATION", { body: { Title: "x" } });
  await apiError("PATCH", `${D}/sobjects/Case/External_Id__c/x`, 404, "INVALID_TYPE", { body: { Name: "x" } });

  // Delete (with cascade) and queryAll
  await del(`${D}/sobjects/Account/${newId}`);
  await apiError("DELETE", `${D}/sobjects/Account/${newId}`, 404, "ENTITY_IS_DELETED");
  await apiError("GET", `${D}/sobjects/Account/${newId}`, 404, "ENTITY_IS_DELETED");
  const deletedRow = await query(`SELECT Id, IsDeleted FROM Account WHERE Id = '${newId}'`);
  assert.equal(deletedRow.totalSize, 0, "query hides deleted rows");
  const allRows = (await get(q(`SELECT Id, IsDeleted FROM Account WHERE Id = '${newId}'`, true))).json;
  assert.equal(allRows.records[0].IsDeleted, true);
  await del(`${D}/sobjects/Account/${ACC(102)}`);
  const cascaded = (await get(q(`SELECT Id, IsDeleted FROM Contact WHERE AccountId = '${ACC(102)}'`, true))).json;
  assert.equal(cascaded.totalSize, 3);
  assert.ok(cascaded.records.every((record) => record.IsDeleted === true));
  assert.equal((await get(q(`SELECT COUNT() FROM Opportunity WHERE AccountId = '${ACC(102)}' AND IsDeleted = true`, true))).json.totalSize, 2);
  assert.equal((await get(q(`SELECT COUNT() FROM Task WHERE IsDeleted = true`, true))).json.totalSize, 2, "tasks on the account, its contacts and its opportunities cascade");
  assert.equal((await query(`SELECT COUNT() FROM Contact WHERE AccountId = '${ACC(102)}'`)).totalSize, 0);
  await apiError("DELETE", `${D}/sobjects/User/${DIEGO}`, 400, "INVALID_TYPE_FOR_OPERATION");
  await apiError("DELETE", `${D}/sobjects/Case/${ACC(101)}`, 404, "INVALID_TYPE");
  await apiError("DELETE", `${D}/sobjects/Account/${ACC(999)}`, 404, "NOT_FOUND");
  await apiError("DELETE", `${D}/sobjects/Account/zzz`, 400, "MALFORMED_ID");

  // Routes that do not exist are framework 404/405, never stubs
  const traversal = await fetch(`${HTTP}${D}/sobjects/Account/${ACC(101)}/Contacts`, { headers: { authorization: `Bearer ${HTTP_TOKEN}` } });
  assert.equal(traversal.status, 404);
  const tree = await fetch(`${HTTP}${D}/composite/tree/Account`, { method: "POST", headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" }, body: "{}" });
  assert.ok(tree.status === 404 || tree.status === 405, `composite/tree: ${tree.status}`);
  const noAuth = await fetch(`${HTTP}${D}/limits`);
  assert.equal(noAuth.status, 401, "every route requires the world token");
}

// ---------------------------------------------------------------------------------------------
// Drill: soql (admin, baseline)
// ---------------------------------------------------------------------------------------------

async function soqlFlow() {
  const accounts = await query("SELECT Id, Name, Industry FROM Account");
  assert.deepEqual({ totalSize: accounts.totalSize, done: accounts.done, length: accounts.records.length, next: accounts.nextRecordsUrl }, { totalSize: 9, done: true, length: 9, next: undefined });
  assert.equal(accounts.records[0].attributes.type, "Account");
  assert.equal(accounts.records[0].attributes.url, `${D}/sobjects/Account/${ACC(101)}`);
  assert.deepEqual(await query("SELECT COUNT() FROM Contact"), { totalSize: 13, done: true, records: [] });
  assert.deepEqual(ids(await query("SELECT Id FROM Account ORDER BY Name DESC NULLS LAST LIMIT 3 OFFSET 2")), [ACC(105), ACC(101), ACC(107)]);
  assert.deepEqual(ids(await query("SELECT Id FROM Opportunity ORDER BY Amount NULLS FIRST, Id LIMIT 2")), [OPP(404), OPP(406)]);
  const related = await query("SELECT Name, Account.Name, Owner.Username FROM Contact WHERE Account.Industry = 'Biotechnology' ORDER BY Id");
  assert.equal(related.totalSize, 4);
  assert.equal(related.records[0].Account.Name, "Nordlicht Labs GmbH");
  assert.equal(related.records[0].Account.attributes.type, "Account");
  assert.equal(related.records[0].Owner.Username, "diego.alvarez@brightwater.example.com");
  const nested = await query(`SELECT Id, (SELECT Id, LastName FROM Contacts), (SELECT Id FROM Opportunities WHERE IsClosed = false) FROM Account WHERE Id IN ('${ACC(101)}', '${ACC(109)}') ORDER BY Id`);
  assert.equal(nested.records[0].Contacts.totalSize, 3);
  assert.equal(nested.records[0].Contacts.done, true);
  assert.equal(nested.records[0].Contacts.records[0].LastName, "Müller");
  assert.equal(nested.records[0].Opportunities.totalSize, 2);
  assert.equal(nested.records[1].Opportunities, null, "an empty child relationship is null");
  const tasks = await query("SELECT Subject, Who.Name, Who.Type, What.Name, What.Type FROM Task ORDER BY Id");
  assert.equal(tasks.totalSize, 8);
  assert.deepEqual({ who: tasks.records[0].Who.Name, whoType: tasks.records[0].Who.Type, what: tasks.records[0].What.Name, whatType: tasks.records[0].What.Type }, { who: "Zoë Müller", whoType: "Contact", what: "Nordlicht Labs - Spectrometer Fleet Renewal", whatType: "Opportunity" });
  assert.equal(tasks.records[2].Who.Type, "Lead");
  assert.equal(tasks.records[7].Who, null);
  const allLeadFields = await query("SELECT FIELDS(ALL) FROM Lead LIMIT 200");
  assert.equal(allLeadFields.totalSize, 8);
  assert.ok("Company" in allLeadFields.records[0] && "IsConverted" in allLeadFields.records[0] && "SystemModstamp" in allLeadFields.records[0]);
  await apiError("GET", q("SELECT FIELDS(ALL) FROM Lead"), 400, "MALFORMED_QUERY");
  await apiError("GET", q("SELECT Id FROM Account LIMIT 99999999999999999999"), 400, "MALFORMED_QUERY", { text: "numeric value out of range: '99999999999999999999'" });
  await apiError("GET", q("SELECT Id FROM Account LIMIT 2147483648"), 400, "MALFORMED_QUERY", { text: "numeric value out of range" });
  await apiError("GET", q("SELECT Id FROM Account OFFSET 99999999999999999999"), 400, "MALFORMED_QUERY", { text: "numeric value out of range" });
  await apiError("GET", q("SELECT Id FROM Account WHERE CreatedDate = LAST_N_DAYS:99999999999999999999"), 400, "MALFORMED_QUERY", { text: "numeric value out of range" });
  await operation("query.execute", { q: "SELECT Id FROM Account LIMIT 99999999999999999999" }, "tool.MALFORMED_QUERY");
  assert.equal((await get(q("SELECT Id FROM Account LIMIT 2147483647"))).json.totalSize, (await get(q("SELECT Id FROM Account"))).json.totalSize, "LIMIT 2147483647 is accepted");
  const custom = await query("SELECT FIELDS(CUSTOM) FROM Opportunity LIMIT 5");
  assert.deepEqual(Object.keys(custom.records[0]).sort(), ["ARR__c", "attributes"]);
  assert.equal((await query("SELECT FIELDS(STANDARD) FROM Task")).records[0].ARR__c, undefined);
  assert.deepEqual(ids(await query("SELECT Id FROM Account WHERE Name LIKE 'nord%'")), [ACC(101), ACC(107)]);
  assert.equal((await query("SELECT Id FROM Account WHERE Name LIKE '%_labs gmbh'")).totalSize, 2);
  // LIKE semantics (linear matcher): prefix, suffix, `_`, bare `%`, empty pattern, escapes, case-insensitivity.
  assert.deepEqual(ids(await query("SELECT Id FROM Account WHERE Name LIKE 'Nordlicht%'")), [ACC(101), ACC(107)]);
  assert.deepEqual(ids(await query("SELECT Id FROM Account WHERE Name LIKE 'NORDLICHT%'")), [ACC(101), ACC(107)]);
  assert.equal((await query("SELECT Id FROM Account WHERE Name LIKE '%Diagnostics'")).totalSize, 1);
  assert.equal((await query("SELECT Id FROM Account WHERE Name LIKE '%diagnostics%'")).totalSize, 2);
  assert.deepEqual(ids(await query("SELECT Id FROM Account WHERE Name LIKE 'N_rdlicht%'")), [ACC(101), ACC(107)]);
  assert.equal((await query("SELECT Id FROM Account WHERE Name LIKE '%'")).totalSize, 9);
  assert.equal((await query("SELECT Id FROM Account WHERE Name LIKE ''")).totalSize, 0);
  assert.equal((await query("SELECT Id FROM Account WHERE Name LIKE 'O\\'Neill%'")).totalSize, 1);
  assert.equal((await query("SELECT Id FROM Account WHERE Name LIKE 'Nordlicht\\_%'")).totalSize, 0, "\\_ is a literal underscore");
  assert.equal((await query("SELECT Id FROM Account WHERE Name LIKE '%\\%'")).totalSize, 0, "\\% is a literal percent sign");
  assert.equal((await query("SELECT Id FROM Account WHERE Name LIKE '100\\%'")).totalSize, 0);
  assert.equal((await query("SELECT Id FROM Account WHERE Name LIKE 'a\\_b'")).totalSize, 0);
  await apiError("GET", q("SELECT Id FROM Account WHERE Name LIKE 'a\\qb'"), 400, "MALFORMED_QUERY");
  // Wildcard-heavy patterns, deep nesting, long ORDER BY: bounded work and Salesforce errors, never a stall.
  const heavy = `${"%a".repeat(16)}%q`;
  for (const statement of [`SELECT Id FROM Account WHERE Name LIKE '${heavy}'`, `SELECT Id FROM Account WHERE Name LIKE '${"%a_".repeat(16)}%q'`, `SELECT Id FROM Account WHERE Name LIKE '${heavy}' OR Name LIKE '${"%_a".repeat(16)}%q'`]) {
    const started = performance.now();
    assert.equal((await query(statement)).totalSize, 0);
    assert.ok(performance.now() - started < 1000, `wildcard-heavy LIKE answered in ${performance.now() - started} ms`);
  }
  assert.equal((await query(`SELECT Id FROM Account WHERE ${"(".repeat(100)}Name LIKE 'nord%'${")".repeat(100)}`)).totalSize, 2);
  const deep = await post(`${D}/composite`, { compositeRequest: [{ method: "GET", url: `${D}/query?q=${encodeURIComponent(`SELECT Id FROM Account WHERE ${"(".repeat(1000)}Name = 'x'${")".repeat(1000)}`)}`, referenceId: "deep" }] });
  assert.equal(deep.json.compositeResponse[0].httpStatusCode, 400);
  assert.equal(deep.json.compositeResponse[0].body[0].errorCode, "MALFORMED_QUERY");
  await apiError("GET", q(`SELECT Id FROM Account ORDER BY ${Array(33).fill("Name").join(", ")}`), 400, "MALFORMED_QUERY");
  await apiError("GET", q("SELECT Id, Account.Name, account.name FROM Contact"), 400, "MALFORMED_QUERY", { text: "duplicate field selected" });
  assert.equal((await query("SELECT Id FROM Account WHERE Name IN ('nordlicht labs gmbh', 'HELIX DIAGNOSTICS LTD')")).totalSize, 3);
  assert.equal((await query("SELECT Id FROM Contact WHERE Email = 'zoe.mueller@nordlicht-labs.example.com'")).totalSize, 1, "text equality is case-insensitive");
  assert.deepEqual(ids(await query("SELECT Id FROM Account WHERE Industry IN ('Biotechnology','Healthcare') AND NumberOfEmployees > 100")), [ACC(101), ACC(102)]);
  assert.deepEqual(ids(await query("SELECT Id FROM Opportunity WHERE (Amount >= 50000 OR StageName = 'Closed Won') AND NOT IsClosed = true")), [OPP(401), OPP(408), OPP(409)]);
  assert.deepEqual(ids(await query("SELECT Id FROM Opportunity WHERE Amount = null")), [OPP(404)]);
  assert.equal((await query("SELECT Id FROM Opportunity WHERE Amount != null AND Amount <= 8500")).totalSize, 2);
  assert.deepEqual(ids(await query("SELECT Id FROM Opportunity WHERE CloseDate = THIS_MONTH")), [OPP(401), OPP(405)]);
  assert.equal((await query("SELECT Id FROM Opportunity WHERE CloseDate = NEXT_N_MONTHS:3")).totalSize, 5);
  assert.equal((await query("SELECT Id FROM Opportunity WHERE CloseDate > THIS_MONTH AND CloseDate >= 2026-10-01")).totalSize, 5);
  assert.equal((await query("SELECT Id FROM Opportunity WHERE CloseDate < NEXT_N_MONTHS:3 AND CloseDate > LAST_MONTH")).totalSize, 2);
  assert.deepEqual(ids(await query("SELECT Id FROM Lead WHERE CreatedDate >= LAST_N_DAYS:30")), [LEAD(301), LEAD(303), LEAD(305), LEAD(306)]);
  assert.equal((await query("SELECT Id FROM Lead WHERE CreatedDate < 2026-06-01T00:00:00Z")).totalSize, 2);
  assert.deepEqual(ids(await query("SELECT Id FROM Task WHERE ActivityDate < TODAY AND IsClosed = false")), [TASK(505)]);
  assert.deepEqual(ids(await query("SELECT Id FROM Task WHERE ActivityDate = TODAY")), [TASK(501)]);
  assert.equal((await query("SELECT Id FROM Lead WHERE Status NOT IN ('Open - Not Contacted') AND Rating != null")).totalSize, 4);
  assert.deepEqual(ids(await query("SELECT Id FROM Account WHERE Name = 'O\\'Neill Diagnostics'")), [ACC(105)]);
  assert.equal((await query("SELECT Id FROM Account WHERE Owner.Alias = 'dalva' AND Parent.Name != null")).totalSize, 1);
  assert.equal((await query("select id from account where industry = 'biotechnology'")).totalSize, 3, "keywords and names are case-insensitive");

  // Paging
  const onePage = await query("SELECT Id FROM Contact", { headers: { "sforce-query-options": "batchSize=200" } });
  assert.equal(onePage.done, true);
  assert.equal(onePage.records.length, 13);
  const page1 = await query("SELECT Id FROM Contact", { headers: { "sforce-query-options": "batchSize=5" } });
  assert.deepEqual({ done: page1.done, totalSize: page1.totalSize, length: page1.records.length }, { done: false, totalSize: 13, length: 5 });
  assert.match(page1.nextRecordsUrl, new RegExp(`^${D.replace(/\./g, "\\.")}/query/01g[A-Za-z0-9_-]+-5$`));
  const page2 = (await get(page1.nextRecordsUrl)).json;
  assert.equal(page2.records.length, 5);
  assert.equal(page2.records[0].Id, CON(206));
  const page3 = (await get(page2.nextRecordsUrl)).json;
  assert.deepEqual({ done: page3.done, length: page3.records.length, next: page3.nextRecordsUrl }, { done: true, length: 3, next: undefined });
  await apiError("GET", `${D}/query/01gBOGUS-2000`, 400, "INVALID_QUERY_LOCATOR", { text: "invalid query locator" });
  // Locators whose base64url decodes to bytes that are not valid UTF-8 fail cleanly, never crash:
  // "notalocator" starts with a stray 0x9E continuation byte, "9JCAgA" encodes U+110000, the others are a stray
  // continuation byte, an overlong "/", an encoded surrogate and a lead byte above 0xF7.
  for (const bad of ["01gnotalocator-5", "01g9JCAgA-0", "01ggA-0", "01gwK8-0", "01g7aCA-0", "01g-A-0"]) {
    await apiError("GET", `${D}/query/${bad}`, 400, "INVALID_QUERY_LOCATOR");
    await apiError("GET", `${D}/queryAll/${bad}`, 400, "INVALID_QUERY_LOCATOR");
    await operation("query.more", { locator: bad }, "tool.INVALID_QUERY_LOCATOR");
  }
  await apiError("GET", `${D}/query/${locator({ q: "SELECT Id FROM Contact", includeDeleted: false, offset: 5, batchSize: 5, userId: DIEGO })}`, 400, "INVALID_QUERY_LOCATOR");
  await apiError("GET", `${D}/query/${locator({ q: "SELECT Id FROM Contact", includeDeleted: false, offset: 500, batchSize: 5, userId: MAREN })}`, 400, "INVALID_QUERY_LOCATOR");
  await apiError("GET", `${D}/query/${locator({ q: "SELECT Id FROM Contact LIMIT", includeDeleted: false, offset: 5, batchSize: 5, userId: MAREN })}`, 400, "MALFORMED_QUERY");
  await apiError("GET", `${D}/query/${locator({ q: "SELECT Foo FROM Contact", includeDeleted: false, offset: 5, batchSize: 5, userId: MAREN })}`, 400, "INVALID_FIELD");
  await apiError("GET", `${D}/query/${locator({ q: "SELECT Id FROM Widget__c", includeDeleted: false, offset: 5, batchSize: 5, userId: MAREN })}`, 400, "INVALID_TYPE");
  const all1 = (await get(q("SELECT Id FROM Account", true), { headers: { "sforce-query-options": "batchSize=5" } })).json;
  assert.deepEqual({ totalSize: all1.totalSize, done: all1.done }, { totalSize: 10, done: false });
  assert.ok(all1.nextRecordsUrl.includes("/queryAll/"));
  const all2 = (await get(all1.nextRecordsUrl)).json;
  assert.equal(all2.records[4].Id, ACC(110), "queryAll includes the deleted account");

  // Rejections
  await apiError("GET", q("SELECT Id FROM Account GROUP BY Industry"), 400, "MALFORMED_QUERY", { text: "GROUP BY" });
  await apiError("GET", q("SELECT SUM(Amount) FROM Opportunity"), 400, "MALFORMED_QUERY", { text: "SUM()" });
  await apiError("GET", q("SELECT COUNT(Id) FROM Opportunity"), 400, "MALFORMED_QUERY");
  await apiError("GET", q("SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact)"), 400, "MALFORMED_QUERY", { text: "semi-join" });
  await apiError("GET", q("SELECT Account.Owner.Name FROM Contact"), 400, "MALFORMED_QUERY");
  await apiError("GET", q("SELECT Id FROM Account LIMIT"), 400, "MALFORMED_QUERY", { text: "unexpected token" });
  await apiError("GET", q("SELECT Id FROM Account WHERE Name = 'unterminated"), 400, "MALFORMED_QUERY");
  await apiError("GET", q("SELECT Id FROM Account FOR UPDATE"), 400, "MALFORMED_QUERY");
  await apiError("GET", q("SELECT Id FROM Account WHERE NumberOfEmployees > '10'"), 400, "MALFORMED_QUERY", { text: "must be of type number" });
  await apiError("GET", q("SELECT Id FROM Account WHERE CreatedDate = LAST_N_WEEKS:2"), 400, "MALFORMED_QUERY");
  await apiError("GET", q("SELECT Foo FROM Account"), 400, "INVALID_FIELD", { text: "No such column 'Foo' on entity 'Account'" });
  await apiError("GET", q("SELECT Id, (SELECT Id FROM Widgets) FROM Account"), 400, "INVALID_TYPE");
  await apiError("GET", q("SELECT Id FROM Widget__c"), 400, "INVALID_TYPE", { text: "sObject type 'Widget__c' is not supported" });
  await apiError("GET", `${D}/query`, 400, "MALFORMED_QUERY");
  await apiError("GET", q("SELECT Id FROM Account OFFSET 2001"), 400, "MALFORMED_QUERY");

  // Parameterized search
  const grouped = (await post(`${D}/parameterizedSearch`, { q: "nordlicht", sobjects: [{ name: "Account", fields: ["Id", "Name"] }, { name: "Contact", fields: ["Id", "Name", "Email"], where: "HasOptedOutOfEmail = false", limit: 5 }] })).json.searchRecords;
  assert.deepEqual(grouped.map((record) => record.attributes.type), ["Account", "Account", "Contact", "Contact"]);
  assert.deepEqual(grouped.map((record) => record.Id), [ACC(101), ACC(107), CON(201), CON(202)]);
  assert.equal(grouped[2].Email, "Zoe.Mueller@nordlicht-labs.example.com");
  const byName = (await post(`${D}/parameterizedSearch`, { q: "zoë", in: "NAME" })).json.searchRecords;
  assert.equal(byName.length, 1);
  assert.deepEqual(Object.keys(byName[0]).sort(), ["Id", "Name", "attributes"]);
  const byPhone = (await post(`${D}/parameterizedSearch`, { q: "+31 20", in: "PHONE" })).json.searchRecords;
  assert.deepEqual(byPhone.map((record) => record.Id), [CON(206)]);
  assert.deepEqual((await post(`${D}/parameterizedSearch`, { q: "søren kj*" })).json.searchRecords.map((record) => record.Id), [CON(202)]);
  // Search wildcards (linear automaton): prefix `*`, leading `*`, `?`, case-insensitivity.
  for (const term of ["nordl*", "NORDL*", "n?rdlicht", "*licht", "nord*ht"]) {
    assert.deepEqual((await post(`${D}/parameterizedSearch`, { q: term, in: "NAME", sobjects: [{ name: "Account" }] })).json.searchRecords.map((record) => record.Id), [ACC(101), ACC(107)], term);
  }
  assert.deepEqual((await post(`${D}/parameterizedSearch`, { q: "licht*", in: "NAME", sobjects: [{ name: "Account" }] })).json.searchRecords, [], "terms match token prefixes only");
  assert.equal((await post(`${D}/parameterizedSearch`, { q: "diagnostics", sobjects: [{ name: "Opportunity", orderBy: "Amount DESC NULLS LAST", limit: 1 }] })).json.searchRecords[0].Id, OPP(403));
  assert.equal((await post(`${D}/parameterizedSearch`, { q: "diagnostics", overallLimit: 2 })).json.searchRecords.length, 2);
  await apiError("POST", `${D}/parameterizedSearch`, 400, "MALFORMED_QUERY", { body: { q: "x" } });
  await apiError("POST", `${D}/parameterizedSearch`, 400, "MALFORMED_QUERY", { body: { q: "acme", sobjects: [{ name: "Account", where: "Name LIKE" }] } });
  await apiError("POST", `${D}/parameterizedSearch`, 400, "INVALID_TYPE", { body: { q: "acme", sobjects: [{ name: "Widget__c" }] } });
  await apiError("POST", `${D}/parameterizedSearch`, 400, "INVALID_FIELD", { body: { q: "acme", sobjects: [{ name: "Account", where: "Bogus = 1" }] } });
  await apiError("POST", `${D}/parameterizedSearch`, 400, "JSON_PARSER_ERROR", { body: { q: "acme", sobjects: [{ fields: ["Id"] }] } });
}

// ---------------------------------------------------------------------------------------------
// Drill: collections-composite (admin, baseline)
// ---------------------------------------------------------------------------------------------

async function collectionsComposite() {
  const created = (await post(`${D}/composite/sobjects`, { records: [{ attributes: { type: "Account" }, Name: "Batch A" }, { attributes: { type: "Contact" }, LastName: "Batch", AccountId: "@wrong" }, { attributes: { type: "Lead" }, LastName: "L", Company: "C" }] })).json;
  assert.deepEqual(created.map((entry) => entry.success), [true, false, true]);
  assert.equal(created[1].errors[0].statusCode, "MALFORMED_ID");
  assert.equal(created[1].id, null);
  const batchA = created[0].id;
  const leadL = created[2].id;
  assert.ok(isId(batchA, "001") && isId(leadL, "00Q"));
  const rolled = (await post(`${D}/composite/sobjects`, { allOrNone: true, records: [{ attributes: { type: "Account" }, Name: "Batch B" }, { attributes: { type: "Contact" }, LastName: "Batch", AccountId: "@wrong" }, { attributes: { type: "Lead" }, LastName: "L2", Company: "C" }] })).json;
  assert.deepEqual(rolled.map((entry) => entry.errors[0].statusCode), ["ALL_OR_NONE_OPERATION_ROLLED_BACK", "MALFORMED_ID", "ALL_OR_NONE_OPERATION_ROLLED_BACK"]);
  assert.equal((await query("SELECT COUNT() FROM Account WHERE Name = 'Batch B'")).totalSize, 0, "allOrNone wrote nothing");
  assert.equal((await query("SELECT COUNT() FROM Lead")).totalSize, 9);
  const mixed = (await post(`${D}/composite/sobjects`, { records: [{ attributes: { type: "Widget__c" }, Name: "x" }, { attributes: { type: "User" }, Username: "x@example.test" }, { attributes: { type: "Account" }, Industry: "Energy" }] })).json;
  assert.deepEqual(mixed.map((entry) => entry.errors[0].statusCode), ["INVALID_TYPE", "INVALID_TYPE_FOR_OPERATION", "REQUIRED_FIELD_MISSING"]);
  await apiError("POST", `${D}/composite/sobjects`, 400, "JSON_PARSER_ERROR", { body: { records: [] } });
  await apiError("POST", `${D}/composite/sobjects`, 400, "JSON_PARSER_ERROR", { body: { records: [{ Name: "no attributes" }] } });
  await apiError("POST", `${D}/composite/sobjects`, 400, "LIMIT_EXCEEDED", { body: { records: Array.from({ length: 201 }, () => ({ attributes: { type: "Lead" }, LastName: "x", Company: "y" })) }, text: "Cannot process more than 200 records" });

  const retrieved = (await post(`${D}/composite/sobjects/Account`, { ids: [ACC(101), ACC(999), ACC(110), CON(201)], fields: ["Id", "Name"] })).json;
  assert.equal(retrieved[0].Name, "Nordlicht Labs GmbH");
  assert.deepEqual(retrieved.slice(1), [null, null, null]);
  const viaGet = (await get(`${D}/composite/sobjects/Account?ids=${ACC(101)},${ACC(103)}&fields=Id,Name,Owner.Alias`)).json;
  assert.equal(viaGet.length, 2);
  assert.equal(viaGet[1].Owner.Alias, "dalva");
  await apiError("POST", `${D}/composite/sobjects/Account`, 400, "JSON_PARSER_ERROR", { body: { ids: [], fields: ["Id"] } });
  await apiError("POST", `${D}/composite/sobjects/Account`, 400, "JSON_PARSER_ERROR", { body: { ids: [ACC(101)], fields: [] } });
  await apiError("POST", `${D}/composite/sobjects/Account`, 400, "INVALID_FIELD", { body: { ids: [ACC(101)], fields: ["Nope"] } });
  await apiError("POST", `${D}/composite/sobjects/Account`, 400, "MALFORMED_ID", { body: { ids: ["zzz"], fields: ["Id"] } });
  await apiError("POST", `${D}/composite/sobjects/Widget__c`, 400, "INVALID_TYPE", { body: { ids: [ACC(101)], fields: ["Id"] } });
  await apiError("POST", `${D}/composite/sobjects/Account`, 400, "LIMIT_EXCEEDED", { body: { ids: Array.from({ length: 2001 }, () => ACC(101)), fields: ["Id"] } });

  const updated = (await api("PATCH", `${D}/composite/sobjects`, { body: { records: [{ attributes: { type: "Account" }, Id: ACC(101), Phone: "1" }, { attributes: { type: "Account" }, Id: ACC(999), Phone: "2" }, { attributes: { type: "Account" }, Phone: "3" }] } })).json;
  assert.deepEqual(updated.map((entry) => entry.success), [true, false, false]);
  assert.equal(updated[0].id, ACC(101));
  assert.deepEqual([updated[1].errors[0].statusCode, updated[2].errors[0].statusCode], ["NOT_FOUND", "MISSING_ARGUMENT"]);
  const updateRolled = (await api("PATCH", `${D}/composite/sobjects`, { body: { allOrNone: true, records: [{ attributes: { type: "Account" }, Id: ACC(103), Phone: "9" }, { attributes: { type: "Account" }, Id: ACC(999), Phone: "2" }] } })).json;
  assert.equal(updateRolled[0].errors[0].statusCode, "ALL_OR_NONE_OPERATION_ROLLED_BACK");
  assert.equal((await get(`${D}/sobjects/Account/${ACC(103)}?fields=Phone`)).json.Phone, "+1 503 555 0103");
  await apiError("PATCH", `${D}/composite/sobjects`, 400, "JSON_PARSER_ERROR", { body: { records: [] } });
  await apiError("PATCH", `${D}/composite/sobjects`, 400, "JSON_PARSER_ERROR", { body: { records: [{ Id: ACC(101), Phone: "no attributes" }] } });
  await apiError("PATCH", `${D}/composite/sobjects`, 400, "LIMIT_EXCEEDED", { body: { records: Array.from({ length: 201 }, () => ({ attributes: { type: "Account" }, Id: ACC(101) })) } });

  const upserted = (await api("PATCH", `${D}/composite/sobjects/Account/External_Id__c`, { body: { records: [{ attributes: { type: "Account" }, External_Id__c: "BW-ACC-0001", Website: "https://a.example.org" }, { attributes: { type: "Account" }, External_Id__c: "BW-ACC-0555", Name: "Upsert Batch" }, { attributes: { type: "Account" }, Name: "No external id" }, { attributes: { type: "Contact" }, External_Id__c: "BW-CON-0001" }] } })).json;
  assert.deepEqual(upserted.map((entry) => entry.created), [false, true, undefined, undefined]);
  assert.deepEqual([upserted[2].errors[0].statusCode, upserted[3].errors[0].statusCode], ["MISSING_ARGUMENT", "INVALID_TYPE"]);
  assert.equal(upserted[0].id, ACC(101));
  await apiError("PATCH", `${D}/composite/sobjects/Account/Customer_Tier__c`, 400, "INVALID_FIELD", { body: { records: [{ attributes: { type: "Account" }, Customer_Tier__c: "Team" }] } });
  await apiError("PATCH", `${D}/composite/sobjects/Account/Nope__c`, 400, "INVALID_FIELD", { body: { records: [{ attributes: { type: "Account" }, Nope__c: "x" }] } });
  await apiError("PATCH", `${D}/composite/sobjects/Widget__c/External_Id__c`, 400, "INVALID_TYPE", { body: { records: [{ attributes: { type: "Widget__c" }, External_Id__c: "x" }] } });
  await apiError("PATCH", `${D}/composite/sobjects/User/Id`, 400, "INVALID_TYPE_FOR_OPERATION", { body: { records: [{ attributes: { type: "User" }, Id: MAREN }] } });
  await apiError("PATCH", `${D}/composite/sobjects/Account/External_Id__c`, 400, "JSON_PARSER_ERROR", { body: { records: [] } });
  await apiError("PATCH", `${D}/composite/sobjects/Account/External_Id__c`, 400, "LIMIT_EXCEEDED", { body: { records: Array.from({ length: 201 }, (_, index) => ({ attributes: { type: "Account" }, External_Id__c: `X-${index}`, Name: "x" })) } });

  const deleted = (await api("DELETE", `${D}/composite/sobjects?ids=${batchA},${leadL},${ACC(999)},zzz`)).json;
  assert.deepEqual(deleted.map((entry) => entry.success), [true, true, false, false]);
  assert.deepEqual([deleted[2].errors[0].statusCode, deleted[3].errors[0].statusCode], ["NOT_FOUND", "MALFORMED_ID"]);
  const deleteRolled = (await api("DELETE", `${D}/composite/sobjects?ids=${ACC(103)},${ACC(999)}&allOrNone=true`)).json;
  assert.equal(deleteRolled[0].errors[0].statusCode, "ALL_OR_NONE_OPERATION_ROLLED_BACK");
  assert.equal((await get(`${D}/sobjects/Account/${ACC(103)}?fields=IsDeleted`)).json.IsDeleted, false);
  await apiError("DELETE", `${D}/composite/sobjects`, 400, "JSON_PARSER_ERROR");
  await apiError("DELETE", `${D}/composite/sobjects?ids=${Array.from({ length: 201 }, () => ACC(101)).join(",")}`, 400, "LIMIT_EXCEEDED");

  // Composite
  const compositeOk = (await post(`${D}/composite`, {
    allOrNone: true,
    compositeRequest: [
      { method: "POST", url: `${D}/sobjects/Account`, referenceId: "acc", body: { Name: "Composite Co" } },
      { method: "POST", url: `${D}/sobjects/Contact`, referenceId: "con", body: { LastName: "Composite", AccountId: "@{acc.id}" } },
      { method: "GET", url: `${D}/query?q=SELECT+Id,+Name+FROM+Contact+WHERE+AccountId+=+'@{acc.id}'`, referenceId: "q" },
      { method: "PATCH", url: `${D}/sobjects/Contact/@{q.records[0].Id}`, referenceId: "upd", body: { Title: "CTO" } },
      { method: "GET", url: `${D}/sobjects/Account/describe`, referenceId: "desc" },
      { method: "GET", url: `${D}/sobjects/Account/@{acc.id}?fields=Name,Owner.Name`, referenceId: "get" },
      { method: "GET", url: `${D}/sobjects/Contact`, referenceId: "info" },
      { method: "GET", url: `${D}/limits`, referenceId: "lim" },
      { method: "GET", url: `${D}/sobjects/Account/External_Id__c/BW-ACC-0001`, referenceId: "ext" },
      { method: "PATCH", url: `${D}/sobjects/Account/External_Id__c/BW-ACC-0888`, referenceId: "ups", body: { Name: "Composite Upsert" } },
      { method: "DELETE", url: `${D}/sobjects/Account/@{ups.id}`, referenceId: "delx" },
    ],
  })).json.compositeResponse;
  assert.deepEqual(compositeOk.map((entry) => entry.httpStatusCode), [201, 201, 200, 204, 200, 200, 200, 200, 200, 200, 204]);
  assert.deepEqual(compositeOk.map((entry) => entry.referenceId), ["acc", "con", "q", "upd", "desc", "get", "info", "lim", "ext", "ups", "delx"]);
  assert.equal(compositeOk[0].httpHeaders.Location, `${D}/sobjects/Account/${compositeOk[0].body.id}`);
  assert.equal(compositeOk[2].body.totalSize, 1);
  assert.equal(compositeOk[3].body, null);
  assert.ok(Array.isArray(compositeOk[4].body.fields));
  assert.equal(compositeOk[5].body.Owner.Name, "Maren Solberg");
  assert.equal(compositeOk[6].body.objectDescribe.name, "Contact");
  assert.equal(compositeOk[7].body.DailyApiRequests.Max, 15000);
  assert.equal(compositeOk[8].body.Id, ACC(101));
  assert.equal(compositeOk[9].body.created, true);
  assert.equal(compositeOk[0].body._limitInfo, undefined, "subrequest bodies are wire-shaped");
  assert.equal((await get(`${D}/sobjects/Contact/${compositeOk[1].body.id}?fields=Title`)).json.Title, "CTO");

  const halted = (await post(`${D}/composite`, {
    allOrNone: true,
    compositeRequest: [
      { method: "POST", url: `${D}/sobjects/Account`, referenceId: "acc", body: { Name: "Halted Co" } },
      { method: "POST", url: `${D}/sobjects/Opportunity`, referenceId: "opp", body: { Name: "No stage" } },
      { method: "GET", url: `${D}/limits`, referenceId: "lim" },
    ],
  })).json.compositeResponse;
  assert.deepEqual(halted.map((entry) => entry.httpStatusCode), [400, 400, 400]);
  assert.deepEqual(halted.map((entry) => entry.body[0].errorCode), ["PROCESSING_HALTED", "REQUIRED_FIELD_MISSING", "PROCESSING_HALTED"]);
  assert.equal((await query("SELECT COUNT() FROM Account WHERE Name = 'Halted Co'")).totalSize, 0);
  const partial = (await post(`${D}/composite`, {
    compositeRequest: [
      { method: "POST", url: `${D}/sobjects/Account`, referenceId: "acc", body: { Name: "Partial Co" } },
      { method: "POST", url: `${D}/sobjects/Opportunity`, referenceId: "opp", body: { Name: "No stage" } },
      { method: "POST", url: `${D}/sobjects/Contact`, referenceId: "con", body: { LastName: "Partial", AccountId: "@{acc.id}" } },
      { method: "GET", url: `${D}/sobjects/Account/updated`, referenceId: "upd" },
      { method: "GET", url: `${D}/sobjects/Account/@{nope.id}`, referenceId: "ref" },
      { method: "GET", url: `${D}/query?q=SELECT+Id+FROM+Widget__c`, referenceId: "badq" },
      { method: "GET", url: `/services/data/v99.0/limits`, referenceId: "badv" },
      { method: "GET", url: `${D}/sobjects/Account/@{opp.id}`, referenceId: "failedref" },
    ],
  })).json.compositeResponse;
  assert.deepEqual(partial.map((entry) => entry.httpStatusCode), [201, 400, 201, 400, 400, 400, 404, 400]);
  assert.deepEqual([partial[3].body[0].errorCode, partial[4].body[0].errorCode, partial[5].body[0].errorCode, partial[6].body[0].errorCode, partial[7].body[0].errorCode], ["MALFORMED_ID", "INVALID_INPUT", "INVALID_TYPE", "NOT_FOUND", "INVALID_INPUT"]);
  assert.equal((await query("SELECT COUNT() FROM Contact WHERE LastName = 'Partial'")).totalSize, 1);
  // Malformed percent-encoding in a subrequest url is a per-item Salesforce error, never a handler crash.
  const malformed = (await post(`${D}/composite`, {
    compositeRequest: [
      { method: "GET", url: `${D}/query?q=%E0%A4%A`, referenceId: "badq" },
      { method: "GET", url: `${D}/sobjects/Acc%ZZount`, referenceId: "badtype" },
      { method: "GET", url: `${D}/sobjects/Account/001%E0%A4%A`, referenceId: "badid" },
      { method: "GET", url: `${D}/sobjects/Account/${ACC(101)}?fields=Name,%ZZ`, referenceId: "badfields" },
      { method: "GET", url: `${D}/sobjects/Account/${ACC(101)}?fields=Name&%ZZ=1`, referenceId: "unusedparam" },
    ],
  })).json.compositeResponse;
  assert.deepEqual(malformed.map((entry) => [entry.referenceId, entry.httpStatusCode, entry.body?.[0]?.errorCode ?? null]), [["badq", 400, "MALFORMED_QUERY"], ["badtype", 404, "NOT_FOUND"], ["badid", 404, "NOT_FOUND"], ["badfields", 400, "INVALID_FIELD"], ["unusedparam", 200, null]]);
  assert.equal(typeof malformed[4].body.Name, "string", "an undecodable parameter the route does not read is ignored");
  const malformedHalted = (await post(`${D}/composite`, {
    allOrNone: true,
    compositeRequest: [
      { method: "POST", url: `${D}/sobjects/Account`, referenceId: "acc", body: { Name: "Malformed Co" } },
      { method: "GET", url: `${D}/query?q=%E0%A4%A`, referenceId: "badq" },
    ],
  })).json.compositeResponse;
  assert.deepEqual(malformedHalted.map((entry) => [entry.httpStatusCode, entry.body[0].errorCode]), [[400, "PROCESSING_HALTED"], [400, "MALFORMED_QUERY"]]);
  assert.equal((await query("SELECT COUNT() FROM Account WHERE Name = 'Malformed Co'")).totalSize, 0, "the halted composite left no partial state");
  await apiError("GET", `${D}/query?q=%E0%A4%A`, 400, "MALFORMED_QUERY");
  // Undecodable bytes inside a string literal would otherwise parse and silently match nothing.
  const badLiteral = "SELECT%20Id%20FROM%20Account%20WHERE%20Name%20%3D%20'%E0%A4%A'";
  await apiError("GET", `${D}/query?q=${badLiteral}`, 400, "MALFORMED_QUERY", { text: "not valid percent-encoded UTF-8" });
  await apiError("GET", `${D}/queryAll?q=${badLiteral}`, 400, "MALFORMED_QUERY", { text: "not valid percent-encoded UTF-8" });
  await apiError("POST", `${D}/composite`, 400, "LIMIT_EXCEEDED", { body: { compositeRequest: Array.from({ length: 26 }, (_, index) => ({ method: "GET", url: `${D}/limits`, referenceId: `r${index}` })) } });
  await apiError("POST", `${D}/composite`, 400, "LIMIT_EXCEEDED", { body: { compositeRequest: Array.from({ length: 6 }, (_, index) => ({ method: "GET", url: `${D}/query?q=SELECT+Id+FROM+Account`, referenceId: `q${index}` })) }, text: "query subrequests" });
  await apiError("POST", `${D}/composite`, 400, "JSON_PARSER_ERROR", { body: { compositeRequest: [{ method: "GET", url: `${D}/limits`, referenceId: "a" }, { method: "GET", url: `${D}/limits`, referenceId: "a" }] }, text: "Duplicate referenceId" });
  await apiError("POST", `${D}/composite`, 400, "JSON_PARSER_ERROR", { body: { compositeRequest: [{ method: "PUT", url: `${D}/limits`, referenceId: "a" }] } });
  await apiError("POST", `${D}/composite`, 400, "JSON_PARSER_ERROR", { body: { compositeRequest: [] } });
}

// ---------------------------------------------------------------------------------------------
// Drill: sharing (rep = Diego, baseline)
// ---------------------------------------------------------------------------------------------

async function sharing() {
  assert.deepEqual(ids(await query("SELECT Id FROM Opportunity")), [OPP(401), OPP(402), OPP(405), OPP(407)], "Private OWD: own opportunities only");
  assert.deepEqual(ids(await query("SELECT Id FROM Task")), [TASK(501), TASK(508)]);
  assert.equal((await query("SELECT Id FROM Account")).totalSize, 9, "Public Read Only: every account");
  const contacts = ids(await query("SELECT Id FROM Contact"));
  assert.equal(contacts.length, 12);
  assert.ok(!contacts.includes(CON(212)), "a contact without an account is private to its owner");
  assert.equal((await query("SELECT Id FROM Lead")).totalSize, 8);
  await apiError("GET", `${D}/sobjects/Opportunity/${OPP(403)}`, 404, "NOT_FOUND");
  await apiError("GET", `${D}/sobjects/Contact/${CON(212)}`, 404, "NOT_FOUND");
  await apiError("PATCH", `${D}/sobjects/Account/${ACC(104)}`, 403, "INSUFFICIENT_ACCESS_OR_READONLY", { body: { Phone: "x" }, text: INSUFFICIENT });
  assert.equal((await get(`${D}/sobjects/Account/${ACC(104)}?fields=Phone`)).json.Phone, "+41 61 555 0104", "the denied update left the row unchanged");
  await apiError("DELETE", `${D}/sobjects/Account/${ACC(104)}`, 403, "INSUFFICIENT_ACCESS_OR_READONLY");
  await apiError("PATCH", `${D}/sobjects/Account/External_Id__c/BW-ACC-0003`, 403, "INSUFFICIENT_ACCESS_OR_READONLY", { body: { Phone: "x" } });
  await patch(`${D}/sobjects/Account/${ACC(101)}`, { Phone: "+49 30 5550 1199" });
  await patch(`${D}/sobjects/Lead/${LEAD(301)}`, { Rating: "Warm" });
  await apiError("PATCH", `${D}/sobjects/Contact/${CON(204)}`, 403, "INSUFFICIENT_ACCESS_OR_READONLY", { body: { Title: "x" } });
  await patch(`${D}/sobjects/Contact/${CON(201)}`, { Title: "Head of Laboratory Operations" });
  const hidden = (await post(`${D}/sobjects/Opportunity`, { Name: "Handed over", StageName: "Prospecting", CloseDate: "2026-12-01", OwnerId: AIKO }, { status: 201 })).json.id;
  await apiError("GET", `${D}/sobjects/Opportunity/${hidden}`, 404, "NOT_FOUND");
  assert.deepEqual((await post(`${D}/composite/sobjects/Opportunity`, { ids: [OPP(403), OPP(401)], fields: ["Id"] })).json.map((entry) => entry?.Id ?? null), [null, OPP(401)]);
  assert.deepEqual((await get(`${D}/sobjects/Opportunity`)).json.recentItems.map((entry) => entry.Id).sort(), [OPP(401), OPP(402), OPP(405), OPP(407)]);
  assert.equal((await post(`${D}/parameterizedSearch`, { q: "Clinical Analyzer", in: "NAME" })).json.searchRecords.length, 0, "Aiko's opportunity name is hidden from Diego");
  assert.equal((await post(`${D}/parameterizedSearch`, { q: "Spectrometer", in: "NAME" })).json.searchRecords.length, 1);
  const halted = (await post(`${D}/composite`, { allOrNone: true, compositeRequest: [{ method: "PATCH", url: `${D}/sobjects/Account/${ACC(104)}`, referenceId: "a", body: { Phone: "x" } }, { method: "GET", url: `${D}/limits`, referenceId: "b" }] })).json.compositeResponse;
  assert.deepEqual(halted.map((entry) => [entry.httpStatusCode, entry.body[0].errorCode]), [[403, "INSUFFICIENT_ACCESS_OR_READONLY"], [400, "PROCESSING_HALTED"]]);
}

// ---------------------------------------------------------------------------------------------
// Drill: profile-permissions (sdr = Ben, baseline)
// ---------------------------------------------------------------------------------------------

async function profilePermissions() {
  const global = (await get(`${D}/sobjects`)).json.sobjects.map((entry) => entry.name);
  assert.deepEqual(global, ["Account", "Contact", "Lead", "Profile", "Task", "User"]);
  await apiError("GET", q("SELECT Id FROM Opportunity"), 400, "INVALID_TYPE", { text: "sObject type 'Opportunity' is not supported. If you are attempting to use a custom object, be sure to append the '__c' after the entity name. Please reference your WSDL or the describe call for the appropriate names." });
  await apiError("GET", `${D}/sobjects/Opportunity`, 404, "NOT_FOUND");
  await operation("sobjects.describe", { sobjectType: "Opportunity" }, "tool.NOT_FOUND");
  await apiError("GET", `${D}/sobjects/Opportunity/${OPP(401)}`, 404, "INVALID_TYPE");
  await apiError("POST", `${D}/sobjects/Opportunity`, 404, "INVALID_TYPE", { body: { Name: "x", StageName: "Prospecting", CloseDate: "2026-12-01" } });
  await apiError("PATCH", `${D}/sobjects/Opportunity/${OPP(401)}`, 404, "INVALID_TYPE", { body: { Name: "x" } });
  await apiError("DELETE", `${D}/sobjects/Opportunity/${OPP(401)}`, 404, "INVALID_TYPE");
  await apiError("PATCH", `${D}/sobjects/Opportunity/Id/${OPP(401)}`, 404, "INVALID_TYPE", { body: { Name: "x" } });
  await apiError("GET", q("SELECT Id, (SELECT Id FROM Opportunities) FROM Account"), 400, "INVALID_TYPE");
  await apiError("POST", `${D}/composite/sobjects/Opportunity`, 400, "INVALID_TYPE", { body: { ids: [OPP(401)], fields: ["Id"] } });
  await apiError("POST", `${D}/parameterizedSearch`, 400, "INVALID_TYPE", { body: { q: "renewal", sobjects: [{ name: "Opportunity" }] } });
  assert.equal((await post(`${D}/parameterizedSearch`, { q: "renewal" })).json.searchRecords.length, 0, "default search scope skips the unreadable type; Diego's task is Private");
  assert.equal((await post(`${D}/parameterizedSearch`, { q: "Intro email" })).json.searchRecords[0].Id, "00TFd0000000507MAA", "own tasks are searchable");
  await apiError("POST", `${D}/sobjects/Account`, 403, "INSUFFICIENT_ACCESS_OR_READONLY", { body: { Name: "SDR Co" } });
  const lead = (await post(`${D}/sobjects/Lead`, { LastName: "New", Company: "Co" }, { status: 201 })).json.id;
  assert.equal((await get(`${D}/sobjects/Lead/${lead}?fields=Status,OwnerId`)).json.OwnerId, BEN);
  await apiError("DELETE", `${D}/sobjects/Contact/${CON(201)}`, 403, "INSUFFICIENT_ACCESS_OR_READONLY");
  await apiError("PATCH", `${D}/sobjects/Account/${ACC(101)}`, 403, "INSUFFICIENT_ACCESS_OR_READONLY", { body: { Phone: "x" } });
  await apiError("PATCH", `${D}/sobjects/Account/External_Id__c/BW-ACC-0001`, 403, "INSUFFICIENT_ACCESS_OR_READONLY", { body: { Phone: "x" } });
  const items = (await post(`${D}/composite/sobjects`, { records: [{ attributes: { type: "Account" }, Name: "x" }, { attributes: { type: "Lead" }, LastName: "Batch", Company: "Co" }] })).json;
  assert.deepEqual([items[0].errors[0].statusCode, items[1].success], ["INSUFFICIENT_ACCESS_OR_READONLY", true]);
  const composite = (await post(`${D}/composite`, { compositeRequest: [{ method: "GET", url: `${D}/query?q=SELECT+Id+FROM+Opportunity`, referenceId: "q" }, { method: "GET", url: `${D}/sobjects/Opportunity/${OPP(401)}`, referenceId: "g" }] })).json.compositeResponse;
  assert.deepEqual(composite.map((entry) => [entry.httpStatusCode, entry.body[0].errorCode]), [[400, "INVALID_TYPE"], [404, "INVALID_TYPE"]]);
  assert.equal((await query("SELECT COUNT() FROM Lead")).totalSize, 10);
}

// ---------------------------------------------------------------------------------------------
// Drill: read-only (analyst = Lena, baseline)
// ---------------------------------------------------------------------------------------------

async function readOnly() {
  assert.equal((await query("SELECT Id FROM Opportunity")).totalSize, 0, "Private OWD without viewAll");
  assert.equal((await query("SELECT Id FROM Account")).totalSize, 9);
  assert.equal((await query("SELECT Id FROM Lead")).totalSize, 8);
  assert.equal((await query("SELECT Id FROM User WHERE IsActive = true")).totalSize, 5);
  assert.equal((await query("SELECT Id, Name, Profile.Name FROM User WHERE Username = 'lena.fischer@brightwater.example.com'")).records[0].Profile.Name, "Read Only");
  assert.equal((await query("SELECT Id, Name, UserLicense FROM Profile ORDER BY Name")).totalSize, 4);
  await apiError("POST", `${D}/sobjects/Account`, 403, "INSUFFICIENT_ACCESS_OR_READONLY", { body: { Name: "x" } });
  await apiError("PATCH", `${D}/sobjects/Lead/${LEAD(301)}`, 403, "INSUFFICIENT_ACCESS_OR_READONLY", { body: { Rating: "Cold" } });
  await apiError("DELETE", `${D}/sobjects/Lead/${LEAD(301)}`, 403, "INSUFFICIENT_ACCESS_OR_READONLY");
  await apiError("PATCH", `${D}/sobjects/Lead/Id/${LEAD(301)}`, 403, "INSUFFICIENT_ACCESS_OR_READONLY", { body: { Rating: "Cold" } });
  const items = (await api("PATCH", `${D}/composite/sobjects`, { body: { records: [{ attributes: { type: "Lead" }, Id: LEAD(301), Rating: "Cold" }] } })).json;
  assert.equal(items[0].errors[0].statusCode, "INSUFFICIENT_ACCESS_OR_READONLY");
  const composite = (await post(`${D}/composite`, { compositeRequest: [{ method: "POST", url: `${D}/sobjects/Account`, referenceId: "a", body: { Name: "x" } }] })).json.compositeResponse;
  assert.deepEqual([composite[0].httpStatusCode, composite[0].body[0].errorCode], [403, "INSUFFICIENT_ACCESS_OR_READONLY"]);
  await mcpInit();
  assert.equal((await mcp("run_soql_query", { query: "SELECT Id FROM Lead" })).totalSize, 8);
  assert.equal((await get(`${D}/sobjects/Lead/${LEAD(301)}?fields=Rating`)).json.Rating, "Hot", "nothing changed");
}

// ---------------------------------------------------------------------------------------------
// Drill: mcp-aliases (admin, baseline)
// ---------------------------------------------------------------------------------------------

async function mcpAliases() {
  await mcpInit();
  const listed = (await rpc("tools/list", {})).tools.map((tool) => tool.name);
  for (const name of ["run_soql_query", "get_username", ...ALL_OPERATIONS.map((id) => `salesforce.${id}`)]) assert.ok(listed.includes(name), `tools/list lacks ${name}`);
  const who = await mcp("get_username", {});
  assert.deepEqual({ username: who.preferred_username, user: who.user_id, org: who.organization_id }, { username: "maren.solberg@brightwater.example.com", user: MAREN, org: ORG });
  assert.equal((await mcp("get_username", { directory: "/tmp/project", defaultTargetOrg: true })).user_id, MAREN);
  await mcpError("get_username", { defaultDevHub: true }, "tool.NOT_FOUND");
  const top = await mcp("run_soql_query", { query: "SELECT Id, Name FROM Account ORDER BY Name LIMIT 3" });
  assert.equal(top.records.length, 3);
  assert.equal(top.records[0].Name, "Alder Creek Analytical");
  assert.match(top._limitInfo, /^api-usage=/);
  assert.equal((await mcp("run_soql_query", { query: "SELECT COUNT() FROM Lead", usernameOrAlias: "maren.solberg@brightwater.example.com" })).totalSize, 8);
  assert.equal((await mcp("run_soql_query", { query: "SELECT Id FROM Lead", usernameOrAlias: "msolb", directory: "/tmp/project" })).totalSize, 8);
  assert.equal((await mcp("run_soql_query", { q: "SELECT Id FROM Lead LIMIT 1" })).totalSize, 1);
  await mcpError("run_soql_query", { query: "SELECT Id FROM Lead", usernameOrAlias: "someone-else" }, "tool.NOT_FOUND", "No authorization information found for someone-else.");
  await mcpError("run_soql_query", { query: "SELECT Id FROM ApexClass", useToolingApi: true }, "tool.INVALID_TYPE");
  await mcpError("run_soql_query", { q: "SELECT Id FROM Account", query: "SELECT Id FROM Account" }, "tool.MALFORMED_QUERY");
  const invalid = await mcpError("run_soql_query", { query: 42 });
  assert.equal(invalid.status, "invalid", "schema-invalid MCP arguments are rejected before the Tool runs");
  const created = await mcp("salesforce.records.create", { sobjectType: "Lead", record: { LastName: "Alias", Company: "MCP Co" } });
  assert.ok(isId(created.id, "00Q"));
  assert.equal((await get(`${D}/sobjects/Lead/${created.id}?fields=Company`)).json.Company, "MCP Co", "the MCP-created lead is visible over REST");
  const describe = await mcp("salesforce.sobjects.describe", { sobjectType: "Task" });
  assert.equal(describe.fields.find((field) => field.name === "WhoId").referenceTo.length, 2);
  const versions = await mcp("salesforce.versions.list", {});
  assert.equal(versions.length, 21);
  const framework = await fetch(`${HTTP}${D}/composite/sobjects?ids=${ACC(101)}&allOrNone=maybe`, { method: "DELETE", headers: { authorization: `Bearer ${HTTP_TOKEN}` } });
  assert.equal(framework.status, 400, "schema-invalid arguments are the framework's 400");
  const frameworkBody = await framework.json();
  assert.equal(frameworkBody[0].errorCode, "JSON_PARSER_ERROR");
}

// ---------------------------------------------------------------------------------------------
// Drills: identities
// ---------------------------------------------------------------------------------------------

async function freshInstall() {
  const me = (await get("/services/oauth2/userinfo")).json;
  assert.equal(me.user_id, MAREN, "an actor without a username is the org's default identity");
  assert.equal((await query("SELECT Id FROM Opportunity")).totalSize, 9);
  const created = (await post(`${D}/sobjects/Account`, { Name: "Fresh Co" }, { status: 201 })).json;
  assert.equal(created.id, NEW_ACC("1001"));
}

async function denied() {
  await apiError("GET", "/services/oauth2/userinfo", 403, "API_DISABLED_FOR_ORG", { text: "The REST API is not enabled for this User" });
  await apiError("GET", q("SELECT Id FROM Account"), 403, "API_DISABLED_FOR_ORG");
  await apiError("POST", `${D}/sobjects/Account`, 403, "API_DISABLED_FOR_ORG", { body: { Name: "x" } });
  await mcpInit();
  const result = await rpc("tools/call", { name: "run_soql_query", arguments: { query: "SELECT Id FROM Account" } });
  assert.ok(result.isError);
  assert.equal(mcpValue(result).status, "denied");
}

async function invalidSession() {
  for (const entry of CALLS) await callError(entry, 401, "INVALID_SESSION_ID", SESSION_MESSAGE);
  await mcpInit();
  await mcpError("get_username", {}, "tool.INVALID_SESSION_ID");
}

async function inactiveUser() {
  await apiError("GET", "/services/oauth2/userinfo", 401, "INVALID_SESSION_ID", { text: SESSION_MESSAGE });
  await apiError("GET", q("SELECT Id FROM Account"), 401, "INVALID_SESSION_ID");
}

// ---------------------------------------------------------------------------------------------
// Drills: faults and bounds
// ---------------------------------------------------------------------------------------------

async function apiLimitExceeded() {
  for (const entry of CALLS) await callError(entry, 403, "REQUEST_LIMIT_EXCEEDED", "TotalRequests Limit exceeded.");
  await mcpInit();
  const error = (await mcpError("run_soql_query", { query: "SELECT Id FROM Account" }, "tool.REQUEST_LIMIT_EXCEEDED")).error;
  assert.equal(error.message, "TotalRequests Limit exceeded.");
}

async function rowLocked() {
  for (const index of WRITE_INDEXES) await callError(CALLS[index], 400, "UNABLE_TO_LOCK_ROW", "unable to obtain exclusive access");
  assert.equal((await query("SELECT Id FROM Account")).totalSize, 9, "reads keep working");
  assert.equal((await get(`${D}/sobjects/Account/${ACC(101)}?fields=Phone`)).json.Phone, "+49 30 5550 1100", "nothing was written");
  assert.equal((await get(`${D}/sobjects/Account/${ACC(103)}?fields=IsDeleted`)).json.IsDeleted, false);
}

async function writeCommittedLost() {
  await apiError("POST", `${D}/sobjects/Account`, 503, "SERVER_UNAVAILABLE", { body: { Name: "Lost Co", External_Id__c: "BW-ACC-LOST" }, text: "Server is currently unavailable" });
  const lost = await query("SELECT Id, Name FROM Account WHERE External_Id__c = 'BW-ACC-LOST'");
  assert.equal(lost.totalSize, 1, "the insert committed although the caller saw 503");
  assert.equal(lost.records[0].Id, NEW_ACC("1001"));
  assert.equal((await get(`${D}/sobjects/Account/${NEW_ACC("1001")}`)).json.Name, "Lost Co");
  await apiError("POST", `${D}/sobjects/Account`, 400, "DUPLICATE_VALUE", { body: { Name: "Lost Co", External_Id__c: "BW-ACC-LOST" } });
  await apiError("POST", `${D}/sobjects/Contact`, 503, "SERVER_UNAVAILABLE", { body: { LastName: "Ghost" } });
  assert.equal((await query("SELECT COUNT() FROM Contact WHERE LastName = 'Ghost'")).totalSize, 1, "a plain retry would silently duplicate");
  await apiError("PATCH", `${D}/sobjects/Account/External_Id__c/BW-ACC-NEW`, 503, "SERVER_UNAVAILABLE", { body: { Name: "Upsert Lost" } });
  assert.equal((await query("SELECT COUNT() FROM Account WHERE External_Id__c = 'BW-ACC-NEW'")).totalSize, 1);
  await apiError("POST", `${D}/composite/sobjects`, 503, "SERVER_UNAVAILABLE", { body: { records: [{ attributes: { type: "Lead" }, LastName: "Lost", Company: "Co" }] } });
  assert.equal((await query("SELECT COUNT() FROM Lead")).totalSize, 9);
  await apiError("PATCH", `${D}/composite/sobjects/Contact/External_Id__c`, 503, "SERVER_UNAVAILABLE", { body: { records: [{ attributes: { type: "Contact" }, External_Id__c: "BW-CON-LOST", LastName: "Lost" }] } });
  assert.equal((await query("SELECT COUNT() FROM Contact WHERE External_Id__c = 'BW-CON-LOST'")).totalSize, 1);
  await patch(`${D}/sobjects/Account/${NEW_ACC("1001")}`, { Phone: "1" });
  assert.equal((await get(`${D}/sobjects/Account/${NEW_ACC("1001")}?fields=Phone`)).json.Phone, "1", "updates are not covered by the fault");
}

async function tightLimits() {
  for (const entry of CALLS) await callError(entry, 400, "LIMIT_EXCEEDED", "state exceeds the supported bound of 2 rows for users");
  await mcpInit();
  await mcpError("get_username", {}, "tool.LIMIT_EXCEEDED");
}

// ---------------------------------------------------------------------------------------------
// Drill: large-responses (admin, baseline): byte-budgeted pages, search, collections and composite
// ---------------------------------------------------------------------------------------------

const MIB = 1048576;
const BUDGET_TEXT = "900,000-byte response budget";

/** Raw request measuring the encoded response bytes (the framework refuses bodies over 1 MiB). */
async function sized(method, path, body) {
  const response = await fetch(`${HTTP}${path}`, {
    method,
    headers: { authorization: `Bearer ${HTTP_TOKEN}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  assert.ok(response.status < 500, `${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  assert.ok(bytes.length < MIB, `${method} ${path}: ${bytes.length} bytes`);
  return { status: response.status, bytes: bytes.length, json: text.length > 0 ? JSON.parse(text) : undefined };
}

/** Follow nextRecordsUrl to the end; every page under 1 MiB, every row exactly once. */
async function pageThrough(first, expectedTotal, prior = []) {
  let page = await sized("GET", first);
  const seen = new Set(prior);
  let pages = 0;
  for (;;) {
    assert.equal(page.status, 200, JSON.stringify(page.json).slice(0, 300));
    pages += 1;
    assert.equal(page.json.totalSize, expectedTotal);
    for (const record of page.json.records) {
      assert.ok(!seen.has(record.Id), `row ${record.Id} returned twice`);
      seen.add(record.Id);
    }
    if (page.json.done) break;
    assert.ok(page.json.records.length > 0 && typeof page.json.nextRecordsUrl === "string");
    page = await sized("GET", page.json.nextRecordsUrl);
  }
  assert.equal(seen.size, expectedTotal);
  return pages;
}

async function largeResponses() {
  const kinds = ["a", "漢", "😀"];
  const created = [];
  for (const [index, unit] of kinds.entries()) {
    const Description = unit.repeat(32000 / unit.length);
    for (let batch = 0; batch < 2; batch += 1) {
      const records = Array.from({ length: 5 }, (_, n) => ({ attributes: { type: "Account" }, Name: `Large ${index}-${batch}-${n}`, Description }));
      const result = (await post(`${D}/composite/sobjects`, { allOrNone: true, records })).json;
      assert.ok(result.every((entry) => entry.success), JSON.stringify(result).slice(0, 300));
      created.push(...result.map((entry) => entry.id));
    }
  }
  assert.equal(created.length, 30);
  // Wide rows: pages stop before the encoded body passes the budget and resume at the first row not returned.
  assert.ok((await pageThrough(q("SELECT Id, Name, Description FROM Account"), 39)) >= 3);
  assert.ok((await pageThrough(q("SELECT Id, Name, Description FROM Account", true), 40)) >= 3);
  const small = (await get(q("SELECT Id, Name FROM Account"))).json;
  assert.deepEqual({ totalSize: small.totalSize, done: small.done, records: small.records.length }, { totalSize: 39, done: true, records: 39 });
  assert.equal(await pageThrough(q("SELECT Id FROM Account ORDER BY Name"), 39), 1);
  // A single row beyond the budget (child rows included) fails LIMIT_EXCEEDED, never a truncated row.
  const contacts = Array.from({ length: 10 }, (_, n) => ({ attributes: { type: "Contact" }, LastName: `Wide ${n}`, AccountId: created[0], Description: "漢".repeat(32000) }));
  for (let start = 0; start < 10; start += 5) assert.ok((await post(`${D}/composite/sobjects`, { allOrNone: true, records: contacts.slice(start, start + 5) })).json.every((entry) => entry.success));
  await apiError("GET", q(`SELECT Id, (SELECT Id, Description FROM Contacts) FROM Account WHERE Id = '${created[0]}'`), 400, "LIMIT_EXCEEDED", { text: BUDGET_TEXT });
  assert.equal((await query(`SELECT Id, (SELECT Id FROM Contacts) FROM Account WHERE Id = '${created[0]}'`)).records[0].Contacts.totalSize, 10);
  // Search has no paging; collections retrieve answers one array: both refuse bodies past the budget.
  await apiError("POST", `${D}/parameterizedSearch`, 400, "LIMIT_EXCEEDED", { body: { q: "Large*", sobjects: [{ name: "Account", fields: ["Id", "Description"] }] }, text: BUDGET_TEXT });
  const narrow = new Set((await post(`${D}/parameterizedSearch`, { q: "Large*", sobjects: [{ name: "Account", fields: ["Id", "Name"] }] })).json.searchRecords.map((record) => record.Id));
  assert.ok(created.every((id) => narrow.has(id)));
  await apiError("POST", `${D}/composite/sobjects/Account`, 400, "LIMIT_EXCEEDED", { body: { ids: created, fields: ["Id", "Description"] }, text: BUDGET_TEXT });
  const few = (await sized("POST", `${D}/composite/sobjects/Account`, { ids: created.slice(10, 15), fields: ["Id", "Description"] })).json;
  assert.deepEqual(few.map((record) => record.Id), created.slice(10, 15));
  // Composite: query pages shrink to the bytes left; reads that no longer fit become LIMIT_EXCEEDED entries.
  const five = await sized("POST", `${D}/composite`, { compositeRequest: [1, 2, 3, 4, 5].map((n) => ({ method: "GET", url: q("SELECT Id, Description FROM Account"), referenceId: `q${n}` })) });
  assert.equal(five.status, 200);
  const entries = five.json.compositeResponse;
  assert.equal(entries[0].httpStatusCode, 200);
  assert.equal(entries[0].body.done, false);
  assert.equal(entries.length, 5);
  for (const entry of entries) {
    if (entry.httpStatusCode === 200) assert.ok(entry.body.records.length > 0 && entry.body.done === false && typeof entry.body.nextRecordsUrl === "string");
    else assert.ok(entry.httpStatusCode === 400 && entry.body[0].errorCode === "LIMIT_EXCEEDED" && entry.body[0].message.includes(BUDGET_TEXT), JSON.stringify(entry.body));
  }
  assert.ok(entries.reduce((sum, entry) => sum + (entry.httpStatusCode === 200 ? entry.body.records.length : 0), 0) < 5 * 39, "the pages shrink to the bytes left");
  const rest = await pageThrough(entries[0].body.nextRecordsUrl, 39, ids(entries[0].body));
  assert.ok(rest >= 1);
  const reads = await sized("POST", `${D}/composite`, { compositeRequest: created.slice(10, 25).map((id, n) => ({ method: "GET", url: `${D}/sobjects/Account/${id}`, referenceId: `r${n}` })) });
  const statuses = reads.json.compositeResponse.map((entry) => entry.httpStatusCode);
  assert.ok(statuses.includes(200) && statuses.includes(400), statuses.join(","));
  assert.ok(statuses.indexOf(400) > statuses.lastIndexOf(200), "entries past the budget come after the admitted ones");
  // allOrNone: an oversized read fails the transaction, so the create before it rolls back.
  const halted = await sized("POST", `${D}/composite`, { allOrNone: true, compositeRequest: [{ method: "POST", url: `${D}/sobjects/Account`, body: { Name: "Rolled back by budget" }, referenceId: "made" }, ...created.slice(10, 25).map((id, n) => ({ method: "GET", url: `${D}/sobjects/Account/${id}`, referenceId: `r${n}` }))] });
  assert.equal(halted.json.compositeResponse[0].body[0].errorCode, "PROCESSING_HALTED");
  assert.equal((await query("SELECT COUNT() FROM Account WHERE Name = 'Rolled back by budget'")).totalSize, 0);
  // JSON bodies nested past 512 levels are refused at decode time (400), never a 500.
  const deep = `{"Name":${"[".repeat(3000)}${"]".repeat(3000)}}`;
  assert.equal((await sized("POST", `${D}/sobjects/Account`, deep)).status, 400);
  assert.equal((await sized("POST", `${D}/parameterizedSearch`, `{"q":"acme","sobjects":${"[".repeat(3000)}${"]".repeat(3000)}}`)).status, 400);
  // Caller names quoted in errors are clipped to 255 characters (framework messages cap at 4,000; fields maxLength 255).
  const long = (n) => "A".repeat(n);
  const clipped = `${long(254)}…`;
  for (const n of [3500, 4000, 6000]) {
    const created = await apiError("POST", `${D}/sobjects/Account`, 400, "INVALID_FIELD", { body: { Name: "Long key", [long(n)]: 1 }, text: `No such column '${clipped}' on sobject of type Account`, fields: [clipped] });
    assert.ok(created.json[0].message.length < 4000);
  }
  await apiError("POST", `${D}/sobjects/Account`, 400, "INVALID_FIELD", { body: { Name: "Long key", [long(255)]: 1 }, fields: [long(255)] });
  const emoji = await apiError("POST", `${D}/sobjects/Account`, 400, "INVALID_FIELD", { body: { Name: "Long key", ["😀".repeat(300)]: 1 } });
  assert.equal([...emoji.json[0].fields[0]].length, 255);
  await apiError("GET", q(`SELECT ${long(5000)} FROM Account`), 400, "INVALID_FIELD", { text: `'${clipped}'`, fields: [clipped] });
  await apiError("GET", q(`SELECT Id FROM Account WHERE ${long(6000)} = 'a'`), 400, "INVALID_FIELD", { fields: [clipped] });
  await apiError("GET", q(`SELECT Id FROM ${long(6000)}`), 400, "INVALID_TYPE", { text: `sObject type '${clipped}'` });
  await apiError("GET", q(`SELECT Id FROM Account WHERE Name = 'a' ${long(6000)}`), 400, "MALFORMED_QUERY", { text: clipped });
  await apiError("POST", `${D}/parameterizedSearch`, 400, "INVALID_TYPE", { body: { q: "abc", sobjects: [{ name: long(6000) }] }, text: `sObject type '${clipped}'` });
  await apiError("POST", `${D}/sobjects/Account`, 400, "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", { body: { Name: "Long picklist", Industry: long(6000) }, text: clipped });
  for (const n of [256, 4000]) {
    const items = (await post(`${D}/composite/sobjects`, { allOrNone: false, records: [{ attributes: { type: "Account" }, Name: "Long item", [long(n)]: 1 }] })).json;
    assert.deepEqual(items[0].errors[0].fields, [clipped], JSON.stringify(items).slice(0, 300));
    const upserted = (await api("PATCH", `${D}/composite/sobjects/Account/Id`, { body: { allOrNone: false, records: [{ attributes: { type: "Account" }, Id: created[0], [long(n)]: 1 }] } })).json;
    assert.deepEqual(upserted[0].errors[0].fields, [clipped], JSON.stringify(upserted).slice(0, 300));
    const updated = (await api("PATCH", `${D}/composite/sobjects`, { body: { allOrNone: false, records: [{ attributes: { type: "Account" }, id: created[0], [long(n)]: 1 }] } })).json;
    assert.deepEqual(updated[0].errors[0].fields, [clipped], JSON.stringify(updated).slice(0, 300));
  }
  const nested = (await post(`${D}/composite`, { compositeRequest: [{ method: "POST", url: `${D}/sobjects/Account`, body: { Name: "Long sub", [long(4000)]: 1 }, referenceId: "a" }] })).json;
  assert.deepEqual(nested.compositeResponse[0].body[0].fields, [clipped]);
  assert.equal((await query("SELECT COUNT() FROM Account")).totalSize, 39);
}

// ---------------------------------------------------------------------------------------------

const flows = {
  "rest-flow": restFlow,
  soql: soqlFlow,
  "collections-composite": collectionsComposite,
  sharing,
  "profile-permissions": profilePermissions,
  "read-only": readOnly,
  "mcp-aliases": mcpAliases,
  "fresh-install": freshInstall,
  denied,
  "invalid-session": invalidSession,
  "inactive-user": inactiveUser,
  "api-limit-exceeded": apiLimitExceeded,
  "row-locked": rowLocked,
  "write-committed-lost": writeCommittedLost,
  "tight-limits": tightLimits,
  "large-responses": largeResponses,
};
const selected = Object.keys(flows).find((name) => instruction.includes(`the ${name} conformance flow`));
if (selected === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
