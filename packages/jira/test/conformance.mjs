// Jira Cloud Tool conformance target. A scripted Tool test, not a model-driven agent.
// Node built-ins only: fetch against the Jira-shaped REST routes (and the canonical Firedrill
// operation endpoint for the one route-less operation) plus raw MCP JSON-RPC (Streamable HTTP)
// for the Atlassian Remote MCP Server tool-name aliases. Every flow fails loudly on an unexpected
// status, header or body.
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

const PRIYA = "712020:0f3b4a6e-1c2d-4e5f-8a9b-000000000001";
const MARCUS = "712020:0f3b4a6e-1c2d-4e5f-8a9b-000000000002";
const TOMASZ = "712020:0f3b4a6e-1c2d-4e5f-8a9b-000000000004";
const AIKO = "712020:0f3b4a6e-1c2d-4e5f-8a9b-000000000005";
const APP = "712020:0f3b4a6e-1c2d-4e5f-8a9b-000000000006";
const CLOUD_ID = "3f9c2b1e-7d4a-4c6e-9b8f-2a1d5e6f7c80";
const SERVER_TIME = "2026-09-14T09:00:00.000+0000";
const API = "/rest/api/3";
const AGILE = "/rest/agile/1.0";
const ISSUE_NOT_FOUND = "Issue does not exist or you do not have permission to see it.";
const UNAVAILABLE = "Service temporarily unavailable. Please try again later.";

const ALL_OPERATIONS = [
  "resources.list", "myself.get", "server-info.get", "projects.search", "projects.get", "projects.statuses", "issue-types.create-meta", "priorities.list", "statuses.list",
  "issues.create", "issues.get", "issues.update", "issues.delete", "issues.assign", "issues.transitions", "issues.transition", "issues.search", "issues.count",
  "comments.list", "comments.add", "comments.update", "comments.delete", "users.search", "users.assignable", "boards.list", "sprints.list", "sprints.move-issues",
];
const ALIASES = [
  "getAccessibleAtlassianResources", "atlassianUserInfo", "getVisibleJiraProjects", "getJiraProjectIssueTypesMetadata", "createJiraIssue", "getJiraIssue",
  "editJiraIssue", "getTransitionsForJiraIssue", "transitionJiraIssue", "searchJiraIssuesUsingJql", "addCommentToJiraIssue", "lookupJiraAccountId",
];

/** One representative request per operation, in ALL_OPERATIONS order (`projects.get` goes through the canonical endpoint). */
const CALLS = [
  ["GET", "/oauth/token/accessible-resources"],
  ["GET", `${API}/myself`],
  ["GET", `${API}/serverInfo`],
  ["GET", `${API}/project/search`],
  ["OP", "projects.get", { projectIdOrKey: "SFR" }],
  ["GET", `${API}/project/SFR/statuses`],
  ["GET", `${API}/issue/createmeta/SFR/issuetypes`],
  ["GET", `${API}/priority`],
  ["GET", `${API}/status`],
  ["POST", `${API}/issue`, { fields: { project: { key: "SFR" }, issuetype: { name: "Task" }, summary: "Probe" } }],
  ["GET", `${API}/issue/SFR-1`],
  ["PUT", `${API}/issue/SFR-1`, { fields: { summary: "Probe" } }],
  ["DELETE", `${API}/issue/SFR-11`],
  ["PUT", `${API}/issue/SFR-1/assignee`, { accountId: MARCUS }],
  ["GET", `${API}/issue/SFR-1/transitions`],
  ["POST", `${API}/issue/SFR-1/transitions`, { transition: { id: "21" } }],
  ["POST", `${API}/search/jql`, { jql: "project = SFR" }],
  ["POST", `${API}/search/approximate-count`, { jql: "project = SFR" }],
  ["GET", `${API}/issue/SFR-12/comment`],
  ["POST", `${API}/issue/SFR-12/comment`, { body: "Probe" }],
  ["PUT", `${API}/issue/SFR-12/comment/10250`, { body: "Probe" }],
  ["DELETE", `${API}/issue/SFR-12/comment/10250`],
  ["GET", `${API}/user/search?query=priya`],
  ["GET", `${API}/user/assignable/search?project=SFR`],
  ["GET", `${AGILE}/board`],
  ["GET", `${AGILE}/board/1/sprint`],
  ["POST", `${AGILE}/sprint/3/issue`, { issues: ["SFR-11"] }],
];
const WRITE_INDEXES = [9, 11, 12, 13, 15, 19, 20, 21, 26];

// ---------------------------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------------------------

/** Jira-shaped request; `status` is asserted, headers checked, the JSON body (if any) returned. */
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
  assert.ok(response.headers.get("x-arequestid"), `${method} ${path}: missing X-AREQUESTID`);
  assert.equal(response.headers.get("x-ratelimit-limit"), "100", `${method} ${path}: missing rate-limit headers`);
  if (status === 204) assert.equal(text, "", `${method} ${path}: 204 must have no body`);
  return { json, headers: response.headers, status: response.status, bytes: Buffer.byteLength(text) };
}
const get = (path, options) => api("GET", path, options);
const post = (path, body, options) => api("POST", path, { ...options, body });
const put = (path, body, options) => api("PUT", path, { ...options, body });
const del = (path, options) => api("DELETE", path, { ...options, status: 204 });
const q = (value) => encodeURIComponent(value);

/** Expect Jira's error envelope: `errorMessages`/`errors` (or the 401 Seraph envelope) containing `text`. */
async function apiError(method, path, status, text, options = {}) {
  const result = await api(method, path, { ...options, status });
  const body = result.json;
  const texts = [];
  if (status === 401) {
    assert.equal(body["status-code"], 401, `${method} ${path}: ${JSON.stringify(body)}`);
    assert.equal(result.headers.get("x-seraph-loginreason"), "AUTHENTICATED_FAILED");
    texts.push(body.message);
  } else {
    assert.ok(body && Array.isArray(body.errorMessages) && typeof body.errors === "object", `${method} ${path}: no Jira error envelope: ${JSON.stringify(body)}`);
    texts.push(...body.errorMessages, ...Object.values(body.errors));
  }
  if (text !== undefined) assert.ok(texts.some((candidate) => String(candidate).includes(text)), `${method} ${path}: expected ${JSON.stringify(text)}, got ${JSON.stringify(body)}`);
  return result;
}
const fieldError = (method, path, field, body, text) =>
  apiError(method, path, 400, text, body === undefined ? {} : { body }).then((result) => {
    assert.ok(result.json.errors[field] !== undefined, `${method} ${path}: expected errors.${field}, got ${JSON.stringify(result.json)}`);
    return result;
  });

/** Canonical Firedrill operation endpoint (used for the route-less `projects.get`). */
async function operation(id, args, expected) {
  const response = await fetch(`${HTTP}/v1/operations/jira/${id}`, {
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
  if (method === "OP") return operation(path, body, options.code);
  return api(method, path, { ...options, ...(body === undefined ? {} : { body }) });
}
async function callError([method, path, body], status, text) {
  if (method === "OP") {
    const outcome = await operation(path, body, `tool.${text.code}`);
    assert.ok(outcome.error.message.includes(text.message), JSON.stringify(outcome));
    return outcome;
  }
  return apiError(method, path, status, text.message, body === undefined ? {} : { body });
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
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "jira-conformance", version: "0.1.0" } });
}
/**
 * The tool result value. MCP requires `structuredContent` to be an object, so the framework wraps
 * array-shaped results (and the error outcome of array-shaped operations) as `{ result: ... }`;
 * the JSON text block always carries the unwrapped value, so read that.
 */
function mcpValue(result) {
  assert.ok(Array.isArray(result.content) && result.content[0]?.type === "text", `MCP result without a text block: ${JSON.stringify(result).slice(0, 300)}`);
  if (result.isError && result.structuredContent === undefined) {
    // The MCP layer validated the arguments against the operation's input schema before the Tool ran.
    return { status: "invalid", error: { code: "invalid", message: result.content[0].text } };
  }
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
    const error = outcome.error;
    assert.ok(error, `${name}: ${JSON.stringify(result).slice(0, 400)}`);
    assert.equal(error.code, code, JSON.stringify(error));
    if (text) assert.ok(String(error.message).includes(text), JSON.stringify(error));
  }
  return outcome;
}

const keys = (issues) => issues.map((issue) => issue.key);
const sorted = (values) => [...values].sort();
const names = (users) => users.map((user) => user.displayName);
const ADF = (text) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const adfText = (doc) => doc.content.map((block) => (block.content ?? []).map((node) => node.text ?? "").join("")).join("\n");

// ---------------------------------------------------------------------------------------------
// Drill: rest-flow (admin = Priya, baseline)
// ---------------------------------------------------------------------------------------------

async function restFlow() {
  // Site and identity
  const resources = (await get("/oauth/token/accessible-resources")).json;
  assert.equal(resources.length, 1);
  assert.equal(resources[0].id, CLOUD_ID);
  assert.ok(resources[0].scopes.includes("write:jira-work"));
  const me = (await get(`${API}/myself`)).json;
  assert.equal(me.accountId, PRIYA);
  assert.equal(me.emailAddress, "priya.natarajan@stellarforge.example.com");
  assert.equal(me.active, true);
  assert.ok(me.avatarUrls["48x48"]);
  const info = (await get(`${API}/serverInfo`)).json;
  assert.equal(info.deploymentType, "Cloud");
  assert.equal(info.serverTime, SERVER_TIME);

  // Projects
  const projects = (await get(`${API}/project/search`)).json;
  assert.equal(projects.total, 3);
  assert.deepEqual(projects.values.map((project) => project.key), ["PLAT", "SEC", "SFR"]);
  assert.equal(projects.values[2].lead.accountId, PRIYA);
  assert.equal(projects.values[1].isPrivate, true);
  assert.equal((await get(`${API}/project/search?query=plat`)).json.total, 1);
  assert.equal((await get(`${API}/project/search?keys=SFR&keys=SEC`)).json.total, 2);
  assert.equal((await get(`${API}/project/search?typeKey=business`)).json.values[0].key, "SEC");
  const firstPage = (await get(`${API}/project/search?maxResults=2`)).json;
  assert.equal(firstPage.isLast, false);
  assert.ok(firstPage.nextPage.endsWith("/rest/api/3/project/search?startAt=2&maxResults=2"));
  const secondPage = (await get(`${API}/project/search?startAt=2&maxResults=2`)).json;
  assert.equal(secondPage.isLast, true);
  assert.deepEqual(secondPage.values.map((project) => project.key), ["SFR"]);
  await apiError("GET", `${API}/project/search?maxResults=0`, 400, "maxResults");
  await apiError("GET", `${API}/project/search?orderBy=bogus`, 400, "orderBy");
  assert.equal((await get(`${API}/project/search?action=edit`)).json.total, 3);
  assert.equal((await get(`${API}/project/search?expand=issueTypes&keys=PLAT`)).json.values[0].issueTypes.length, 3);
  const noRoute = await fetch(`${HTTP}${API}/project/SFR`, { headers: { authorization: `Bearer ${HTTP_TOKEN}` } });
  assert.equal(noRoute.status, 404, "GET /project/{key} has no route (framework overlap rule)");
  const sfrStatuses = (await get(`${API}/project/SFR/statuses`)).json;
  assert.equal(sfrStatuses.length, 5);
  assert.equal(sfrStatuses[0].statuses.length, 4);
  const platStatuses = (await get(`${API}/project/10001/statuses`)).json;
  assert.equal(platStatuses.length, 3);
  assert.equal(platStatuses[0].statuses.length, 5);
  await apiError("GET", `${API}/project/NOPE/statuses`, 404, "No project could be found with key 'NOPE'.");
  const meta = (await get(`${API}/issue/createmeta/PLAT/issuetypes`)).json;
  assert.deepEqual(meta.issueTypes.map((type) => type.name), ["Task", "Bug", "Subtask"]);
  const metaPage = (await get(`${API}/issue/createmeta/PLAT/issuetypes?maxResults=1`)).json;
  assert.equal(metaPage.total, 3);
  assert.equal(metaPage.issueTypes.length, 1);
  await apiError("GET", `${API}/issue/createmeta/PLAT/issuetypes?maxResults=0`, 400, "maxResults");
  await apiError("GET", `${API}/issue/createmeta/NOPE/issuetypes`, 404, "No project could be found with key 'NOPE'.");
  assert.equal((await get(`${API}/priority`)).json.length, 5);
  assert.equal((await get(`${API}/status`)).json.length, 9);

  // Issue reads
  const sfr3 = (await get(`${API}/issue/SFR-3`)).json;
  assert.equal(sfr3.fields.subtasks.length, 2);
  assert.equal(sfr3.fields.parent.key, "SFR-1");
  assert.equal(sfr3.fields.customfield_10020[0].id, 2);
  assert.equal(sfr3.fields.comment.total, 0);
  assert.equal((await get(`${API}/issue/10102`)).json.key, "SFR-3");
  assert.deepEqual(Object.keys((await get(`${API}/issue/SFR-3?fields=summary,status`)).json.fields), ["summary", "status"]);
  const navigable = (await get(`${API}/issue/SFR-3?fields=*navigable`)).json.fields;
  assert.ok(navigable.description === undefined && navigable.comment === undefined && navigable.summary !== undefined);
  const minusComment = (await get(`${API}/issue/SFR-3?fields=-comment`)).json.fields;
  assert.ok(minusComment.comment === undefined && minusComment.description !== undefined);
  assert.deepEqual((await get(`${API}/issue/SFR-3?fields=bogus`)).json.fields, {});
  const expanded = (await get(`${API}/issue/SFR-3?expand=names,transitions`)).json;
  assert.equal(expanded.names.customfield_10020, "Sprint");
  assert.equal(expanded.transitions.length, 4);
  await apiError("GET", `${API}/issue/SFR-999`, 404, ISSUE_NOT_FOUND);
  const noGet = await fetch(`${HTTP}${API}/issue/10100/comment/x`, { headers: { authorization: `Bearer ${HTTP_TOKEN}` } });
  assert.ok(noGet.status === 404 || noGet.status === 405, `GET comment by id has no route: ${noGet.status}`);

  // Create
  const created = (await post(`${API}/issue`, { fields: { project: { key: "SFR" }, issuetype: { name: "Bug" }, summary: "Lidar returns stale frames after dock", description: "Observed on rover 3", priority: { name: "High" }, assignee: { accountId: MARCUS }, labels: ["lidar"] } }, { status: 201 })).json;
  assert.deepEqual({ id: created.id, key: created.key }, { id: "10200", key: "SFR-15" });
  const sfr15 = (await get(`${API}/issue/SFR-15`)).json.fields;
  assert.equal(sfr15.status.name, "To Do");
  assert.equal(sfr15.reporter.accountId, PRIYA);
  assert.equal(sfr15.creator.accountId, PRIYA);
  assert.equal(sfr15.description.type, "doc");
  assert.equal(sfr15.description.content.length, 1);
  assert.equal(sfr15.priority.id, "2");
  assert.equal(sfr15.created, SERVER_TIME);
  assert.equal(sfr15.updated, SERVER_TIME);
  assert.equal((await post(`${API}/issue`, { fields: { project: { id: "10000" }, issuetype: { id: "10002" }, summary: "Created by id" } }, { status: 201 })).json.key, "SFR-16");
  await fieldError("POST", `${API}/issue`, "summary", { fields: { project: { key: "SFR" }, issuetype: { name: "Bug" } } }, "You must specify a summary of the issue.");
  await fieldError("POST", `${API}/issue`, "issuetype", { fields: { project: { key: "PLAT" }, issuetype: { name: "Epic" }, summary: "x" } }, "The issue type selected is invalid.");
  await fieldError("POST", `${API}/issue`, "bogus", { fields: { project: { key: "SFR" }, issuetype: { name: "Task" }, summary: "x", bogus: "y" } }, "Field 'bogus' cannot be set.");
  await fieldError("POST", `${API}/issue`, "labels", { fields: { project: { key: "SFR" }, issuetype: { name: "Task" }, summary: "x", labels: ["two words"] } }, "contains spaces");
  await fieldError("POST", `${API}/issue`, "assignee", { fields: { project: { key: "SFR" }, issuetype: { name: "Task" }, summary: "x", assignee: { accountId: AIKO } } }, "User 'Aiko Tanaka' cannot be assigned issues.");
  await fieldError("POST", `${API}/issue`, "assignee", { fields: { project: { key: "SFR" }, issuetype: { name: "Task" }, summary: "x", assignee: { accountId: APP } } });
  await fieldError("POST", `${API}/issue`, "parent", { fields: { project: { key: "SFR" }, issuetype: { name: "Subtask" }, summary: "x" } });
  await fieldError("POST", `${API}/issue`, "parent", { fields: { project: { key: "SFR" }, issuetype: { name: "Subtask" }, summary: "x", parent: { key: "SFR-1" } } }, "appropriate hierarchy");
  await fieldError("POST", `${API}/issue`, "parent", { fields: { project: { key: "SFR" }, issuetype: { name: "Story" }, summary: "x", parent: { key: "SFR-2" } } }, "appropriate hierarchy");
  await fieldError("POST", `${API}/issue`, "duedate", { fields: { project: { key: "SFR" }, issuetype: { name: "Task" }, summary: "x", duedate: "next week" } });
  assert.equal((await post(`${API}/issue`, { projectKey: "SFR", issueTypeName: "Task", summary: "Flat create", assignee_account_id: MARCUS }, { status: 201 })).json.key, "SFR-17", "failed creates consume no key");
  await apiError("POST", `${API}/issue`, 400, "not both", { body: { projectKey: "SFR", issueTypeName: "Task", summary: "x", fields: { summary: "y" } } });
  // Route fuzz retrofit: bodies nested past 512 levels answer 400 before validation; long unknown keys answer Jira's 400.
  const deepObject = (depth) => `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
  const deepArray = (depth) => `${"[".repeat(depth)}1${"]".repeat(depth)}`;
  const deep = async (method, path, rawBody) => {
    const response = await fetch(`${HTTP}${path}`, { method, headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" }, body: rawBody });
    const text = await response.text();
    assert.equal(response.status, 400, `${method} ${path} deep body -> ${response.status} ${text.slice(0, 300)}`);
  };
  await deep("POST", `${API}/issue`, deepObject(2000));
  await deep("POST", `${API}/issue`, `{"fields":${deepObject(3000)}}`);
  await deep("PUT", `${API}/issue/SFR-12/comment/10250`, `{"body":${deepObject(2500)}}`);
  await deep("POST", `${API}/issue/SFR-1/transitions`, `{"transition":${deepArray(2995)}}`);
  await deep("POST", `${API}/issue`, `{"fields":{"project":{"key":"SFR"},"x":${deepArray(513)}}}`);
  const longKey = "k".repeat(5000);
  const longKeyResult = await apiError("POST", `${API}/issue`, 400, "cannot be set", { body: { fields: { project: { key: "SFR" }, issuetype: { name: "Task" }, summary: "x", [longKey]: 1 } } });
  assert.ok(Object.keys(longKeyResult.json.errors).every((key) => key.length <= 210), "error-map keys are clipped");
  assert.ok(JSON.stringify(longKeyResult.json).length < 2000, "long key is clipped in the error body");
  // Two long keys that share their first 200 characters stay distinct entries (clip + stable digest of the full key).
  const pairA = `${longKey}a`;
  const pairB = `${longKey}b`;
  const pair = await apiError("POST", `${API}/issue`, 400, "cannot be set", { body: { fields: { project: { key: "SFR" }, issuetype: { name: "Task" }, summary: "x", [pairA]: 1, [pairB]: 2 } } });
  const pairKeys = Object.keys(pair.json.errors).filter((key) => key.startsWith("kkkk"));
  assert.equal(pairKeys.length, 2, `long keys collapsed: ${JSON.stringify(pairKeys)}`);
  assert.ok(pairKeys.every((key) => /^k{200}…#[0-9a-f]{8}$/.test(key)), `unexpected clipped key shape: ${JSON.stringify(pairKeys)}`);
  const pairAgain = await apiError("PUT", `${API}/issue/SFR-15`, 400, "cannot be set", { body: { update: { [pairA]: [{ add: "x" }], [pairB]: [{ add: "y" }] } } });
  assert.deepEqual(Object.keys(pairAgain.json.errors).filter((key) => key.startsWith("kkkk")).sort(), pairKeys.sort(), "clipped keys are stable across operations");
  await apiError("PUT", `${API}/issue/SFR-15`, 400, "cannot be set", { body: { update: { [longKey]: [{ add: "x" }] } } });
  await apiError("POST", `${API}/issue/SFR-1/transitions`, 400, undefined, { body: { transition: { id: "21" }, fields: { [longKey]: 1 } } });

  // Update
  await put(`${API}/issue/SFR-15`, { fields: { summary: "Lidar stale frames (docked)", duedate: "2026-09-30", assignee: null }, update: { labels: [{ add: "sensor" }, { remove: "lidar" }] } }, { status: 204 });
  const updated = (await get(`${API}/issue/SFR-15?fields=labels,assignee,summary,duedate,updated`)).json.fields;
  assert.deepEqual(updated.labels, ["sensor"]);
  assert.equal(updated.assignee, null);
  assert.equal(updated.duedate, "2026-09-30");
  assert.equal(updated.summary, "Lidar stale frames (docked)");
  await fieldError("PUT", `${API}/issue/SFR-15`, "status", { fields: { status: { id: "10003" } } }, "Field 'status' cannot be set.");
  await apiError("PUT", `${API}/issue/SFR-15?returnIssue=true`, 400, "returnIssue", { body: { fields: { summary: "x" } } });
  await apiError("PUT", `${API}/issue/SFR-999`, 404, ISSUE_NOT_FOUND, { body: { fields: { summary: "x" } } });

  // Assign
  await put(`${API}/issue/SFR-15/assignee`, { accountId: MARCUS }, { status: 204 });
  assert.equal((await get(`${API}/issue/SFR-15?fields=assignee`)).json.fields.assignee.accountId, MARCUS);
  await put(`${API}/issue/SFR-15/assignee`, { accountId: null }, { status: 204 });
  await put(`${API}/issue/SFR-15/assignee`, { accountId: "-1" }, { status: 204 });
  assert.equal((await get(`${API}/issue/SFR-15?fields=assignee`)).json.fields.assignee.accountId, PRIYA, "SFR default assignee is the lead");
  await put(`${API}/issue/PLAT-1/assignee`, { accountId: "-1" }, { status: 204 });
  assert.equal((await get(`${API}/issue/PLAT-1?fields=assignee`)).json.fields.assignee, null, "PLAT default assignee is unassigned");
  await fieldError("PUT", `${API}/issue/PLAT-1/assignee`, "assignee", { accountId: AIKO }, "User 'Aiko Tanaka' cannot be assigned issues.");
  await apiError("PUT", `${API}/issue/SFR-999/assignee`, 404, ISSUE_NOT_FOUND, { body: { accountId: null } });

  // Transitions
  const transitions = (await get(`${API}/issue/SFR-15/transitions`)).json.transitions;
  assert.deepEqual(transitions.map((transition) => transition.id), ["11", "21", "31", "41"]);
  assert.equal(transitions[3].to.statusCategory.key, "done");
  assert.equal(transitions[0].isLooped, true);
  assert.equal((await get(`${API}/issue/SFR-15/transitions?transitionId=41`)).json.transitions.length, 1);
  await apiError("GET", `${API}/issue/SFR-999/transitions`, 404, ISSUE_NOT_FOUND);
  await post(`${API}/issue/SFR-15/transitions`, { transition: { id: "41" } }, { status: 204 });
  const done = (await get(`${API}/issue/SFR-15?fields=status,resolution,resolutiondate,statuscategorychangedate`)).json.fields;
  assert.equal(done.status.name, "Done");
  assert.equal(done.resolution.name, "Done");
  assert.equal(done.resolutiondate, SERVER_TIME);
  assert.equal(done.statuscategorychangedate, SERVER_TIME);
  await post(`${API}/issue/SFR-15/transitions`, { transition: { id: "11" }, update: { comment: [{ add: { body: "Reopening — still reproduces" } }] } }, { status: 204 });
  const reopened = (await get(`${API}/issue/SFR-15?fields=status,resolution,comment`)).json.fields;
  assert.equal(reopened.status.name, "To Do");
  assert.equal(reopened.resolution, null);
  assert.equal(reopened.comment.total, 1);
  await post(`${API}/issue/PLAT-1/transitions`, { transition: { id: "31" } }, { status: 204 });
  await apiError("POST", `${API}/issue/PLAT-1/transitions`, 400, "Transition id '11' is not valid for this issue.", { body: { transition: { id: "11" } } });
  await fieldError("POST", `${API}/issue/PLAT-1/transitions`, "resolution", { transition: { id: "41" }, fields: { resolution: { name: "Duplicate" } } });
  await post(`${API}/issue/PLAT-1/transitions`, { transition: { id: "41" } }, { status: 204 });
  assert.equal((await get(`${API}/issue/PLAT-1?fields=status`)).json.fields.status.name, "Reopened");
  await post(`${API}/issue/PLAT-1/transitions`, { transition: { id: "21" }, fields: { resolution: { name: "Won't Do" } } }, { status: 204 });
  assert.equal((await get(`${API}/issue/PLAT-1?fields=resolution`)).json.fields.resolution.id, "10001");
  await apiError("POST", `${API}/issue/PLAT-1/transitions`, 400, "Transition id '99' is not valid for this issue.", { body: { transition: { id: "99" } } });
  await apiError("POST", `${API}/issue/SFR-999/transitions`, 404, ISSUE_NOT_FOUND, { body: { transition: { id: "11" } } });

  // Comments
  const comments = (await get(`${API}/issue/SFR-12/comment`)).json;
  assert.equal(comments.total, 6);
  assert.equal(comments.maxResults, 50);
  assert.equal(comments.comments[0].id, "10250");
  const pages = [];
  for (const startAt of [0, 2, 4]) pages.push((await get(`${API}/issue/SFR-12/comment?maxResults=2&startAt=${startAt}`)).json);
  assert.deepEqual(pages.map((page) => page.comments.length), [2, 2, 2]);
  assert.equal(pages[2].startAt, 4);
  assert.equal((await get(`${API}/issue/SFR-12/comment?orderBy=-created`)).json.comments[0].id, "10255");
  await apiError("GET", `${API}/issue/SFR-12/comment?orderBy=bogus`, 400, "orderBy");
  await apiError("GET", `${API}/issue/SFR-12/comment?maxResults=0`, 400, "maxResults");
  await apiError("GET", `${API}/issue/SFR-999/comment`, 404, ISSUE_NOT_FOUND);
  const comment = (await post(`${API}/issue/SFR-15/comment`, { body: ADF("Bench reproduction attached.") }, { status: 201 })).json;
  assert.equal(comment.author.accountId, PRIYA);
  assert.equal(comment.jsdPublic, true);
  assert.equal(adfText((await post(`${API}/issue/SFR-15/comment`, { body: "plain string" }, { status: 201 })).json.body), "plain string");
  assert.equal(adfText((await post(`${API}/issue/SFR-15/comment`, { commentBody: "flat spelling" }, { status: 201 })).json.body), "flat spelling");
  await fieldError("POST", `${API}/issue/SFR-15/comment`, "comment", { body: "" }, "Comment body can not be empty!");
  await apiError("POST", `${API}/issue/SFR-15/comment`, 400, "not both", { body: { body: ADF("x"), commentBody: "x" } });
  await fieldError("POST", `${API}/issue/SFR-15/comment`, "comment", { body: { type: "doc" } }, "Atlassian Document");
  await apiError("POST", `${API}/issue/SFR-15/comment`, 400, "visibility", { body: { body: "x", visibility: { type: "role", value: "Administrators" } } });
  await apiError("POST", `${API}/issue/SFR-999/comment`, 404, ISSUE_NOT_FOUND, { body: { body: "x" } });
  const edited = (await put(`${API}/issue/SFR-15/comment/${comment.id}`, { body: "edited" })).json;
  assert.equal(edited.updateAuthor.accountId, PRIYA);
  assert.equal(adfText(edited.body), "edited");
  assert.equal((await put(`${API}/issue/SFR-12/comment/10254`, { body: "Edited by the project lead." })).json.id, "10254", "an Administrator edits another user's comment");
  await apiError("PUT", `${API}/issue/SFR-2/comment/10250`, 404, "Can not find a comment", { body: { body: "x" } });
  await fieldError("PUT", `${API}/issue/SFR-15/comment/${comment.id}`, "comment", { body: "" }, "Comment body can not be empty!");
  await del(`${API}/issue/SFR-15/comment/${comment.id}`);
  await apiError("DELETE", `${API}/issue/SFR-15/comment/${comment.id}`, 404, "Can not find a comment");

  // JQL search
  const jql = "project = SFR ORDER BY key ASC";
  const page1 = (await post(`${API}/search/jql`, { jql, maxResults: 5 })).json;
  assert.deepEqual(keys(page1.issues), ["SFR-1", "SFR-2", "SFR-3", "SFR-4", "SFR-5"]);
  assert.deepEqual(Object.keys(page1.issues[0].fields), []);
  assert.equal(page1.isLast, false);
  assert.ok(page1.nextPageToken);
  const page2 = (await post(`${API}/search/jql`, { jql, maxResults: 5, nextPageToken: page1.nextPageToken })).json;
  const page3 = (await post(`${API}/search/jql`, { jql, maxResults: 5, nextPageToken: page2.nextPageToken })).json;
  const page4 = (await post(`${API}/search/jql`, { jql, maxResults: 5, nextPageToken: page3.nextPageToken })).json;
  assert.deepEqual(keys(page2.issues), ["SFR-6", "SFR-7", "SFR-8", "SFR-9", "SFR-10"]);
  assert.deepEqual(keys(page3.issues), ["SFR-11", "SFR-12", "SFR-13", "SFR-14", "SFR-15"]);
  assert.deepEqual(keys(page4.issues), ["SFR-16", "SFR-17"]);
  assert.equal(page4.isLast, true);
  assert.equal(page4.nextPageToken, undefined);
  await apiError("POST", `${API}/search/jql`, 400, "The page token is invalid.", { body: { jql, nextPageToken: "zzz" } });
  await apiError("POST", `${API}/search/jql`, 400, "The page token is invalid.", { body: { jql: "project = PLAT", nextPageToken: page1.nextPageToken } });
  const withFields = (await get(`${API}/search/jql?jql=${q("project = SFR")}&fields=summary,status&maxResults=100`)).json;
  assert.equal(withFields.issues.length, 17);
  assert.deepEqual(Object.keys(withFields.issues[0].fields), ["summary", "status"]);
  const full = (await get(`${API}/search/jql?jql=${q("key = SFR-15")}&fields=*all&expand=names`)).json;
  assert.ok(full.issues[0].fields.description !== undefined && full.issues[0].fields.comment !== undefined);
  assert.equal(full.names.summary, "Summary");
  assert.equal((await post(`${API}/search/approximate-count`, { jql: "project = SFR" })).json.count, 17);

  // Users
  assert.equal((await get(`${API}/user/search?query=marcus`)).json.length, 1);
  assert.equal((await get(`${API}/user/search?query=stellarforge`)).json.length, 5, "every account with a stellarforge e-mail (active and inactive)");
  assert.equal((await get(`${API}/user/search?query=${q("wiś")}`)).json[0].accountId, TOMASZ);
  await apiError("GET", `${API}/user/search?query=`, 400, "query parameter is required");
  assert.equal((await get(`${API}/user/search?query=stellarforge&maxResults=2&startAt=2`)).json.length, 2);
  assert.deepEqual(names((await get(`${API}/user/assignable/search?project=SFR`)).json), ["Elena Sokolova", "Marcus Oyelaran", "Priya Natarajan", "Tomasz Wiśniewski"]);
  assert.deepEqual(names((await get(`${API}/user/assignable/search?project=PLAT`)).json), ["Elena Sokolova", "Marcus Oyelaran", "Priya Natarajan"]);
  assert.equal((await get(`${API}/user/assignable/search?issueKey=SFR-12&query=priya`)).json.length, 1);
  await apiError("GET", `${API}/user/assignable/search?project=SFR&issueKey=SFR-1`, 400, "Either project or issueKey must be specified.");
  await apiError("GET", `${API}/user/assignable/search`, 400, "Either project or issueKey must be specified.");
  await apiError("GET", `${API}/user/assignable/search?project=NOPE`, 404, "No project could be found with key 'NOPE'.");

  // Boards and sprints
  const boards = (await get(`${AGILE}/board`)).json;
  assert.equal(boards.total, 2);
  assert.equal(boards.values[0].location.projectKey, "SFR");
  assert.equal((await get(`${AGILE}/board?type=scrum`)).json.total, 1);
  assert.equal((await get(`${AGILE}/board?projectKeyOrId=PLAT`)).json.values[0].id, 2);
  await apiError("GET", `${AGILE}/board?type=bogus`, 400, "board type");
  await apiError("GET", `${AGILE}/board?projectKeyOrId=NOPE`, 404, "No project could be found with key 'NOPE'.");
  const sprints = (await get(`${AGILE}/board/1/sprint`)).json;
  assert.deepEqual(sprints.values.map((sprint) => sprint.state), ["closed", "active", "future"]);
  assert.equal((await get(`${AGILE}/board/1/sprint?state=active`)).json.values[0].id, 2);
  assert.equal((await get(`${AGILE}/board/1/sprint?state=active,future`)).json.values.length, 2);
  await apiError("GET", `${AGILE}/board/1/sprint?state=bogus`, 400, "sprint state");
  await apiError("GET", `${AGILE}/board/2/sprint`, 400, "The board does not support sprints.");
  await apiError("GET", `${AGILE}/board/99/sprint`, 404, "The board does not exist or you do not have permission to view it.");
  await post(`${AGILE}/sprint/3/issue`, { issues: ["SFR-10", "10111"] }, { status: 204 });
  assert.equal((await get(`${API}/issue/SFR-10?fields=customfield_10020`)).json.fields.customfield_10020[0].id, 3);
  await apiError("POST", `${AGILE}/sprint/1/issue`, 400, "Cannot move issues to a closed sprint.", { body: { issues: ["SFR-10"] } });
  await apiError("POST", `${AGILE}/sprint/3/issue`, 400, "Issue 'PLAT-1' cannot be moved to this sprint because it is not on the board.", { body: { issues: ["PLAT-1"] } });
  await apiError("POST", `${AGILE}/sprint/3/issue`, 400, "Subtasks cannot be moved to a sprint independently.", { body: { issues: ["SFR-5"] } });
  await apiError("POST", `${AGILE}/sprint/3/issue`, 400, "between 1 and 50", { body: { issues: [] } });
  await apiError("POST", `${AGILE}/sprint/3/issue`, 404, ISSUE_NOT_FOUND, { body: { issues: ["SFR-999"] } });
  await apiError("POST", `${AGILE}/sprint/99/issue`, 404, "The sprint does not exist", { body: { issues: ["SFR-1"] } });

  // Deletes
  await apiError("DELETE", `${API}/issue/SFR-3`, 400, "has subtasks");
  await del(`${API}/issue/SFR-3?deleteSubtasks=true`);
  await apiError("GET", `${API}/issue/SFR-4`, 404, ISSUE_NOT_FOUND);
  await apiError("GET", `${API}/issue/SFR-5`, 404, ISSUE_NOT_FOUND);
  await del(`${API}/issue/SFR-16`);
  await apiError("DELETE", `${API}/issue/SFR-16`, 404, ISSUE_NOT_FOUND);

  // Unsupported provider routes never reach a handler
  const bulk = await fetch(`${HTTP}${API}/issue/bulk`, { method: "POST", headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(bulk.status, 405, "POST /issue/bulk: the path matches /issue/{issueIdOrKey}, which has no POST route (405, never a stub)");
  const bulkGet = await fetch(`${HTTP}${API}/issue/bulk`, { headers: { authorization: `Bearer ${HTTP_TOKEN}` } });
  assert.equal(bulkGet.status, 404, "GET /issue/bulk resolves to issues.get for the key 'bulk', which does not exist");
  const worklog = await fetch(`${HTTP}${API}/issue/SFR-1/worklog`, { headers: { authorization: `Bearer ${HTTP_TOKEN}` } });
  assert.equal(worklog.status, 404, "no worklog route");
  const v2 = await fetch(`${HTTP}/rest/api/2/issue/SFR-1`, { headers: { authorization: `Bearer ${HTTP_TOKEN}` } });
  assert.equal(v2.status, 404);
  const form = await fetch(`${HTTP}${API}/issue`, { method: "POST", headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/x-www-form-urlencoded" }, body: "summary=x" });
  assert.equal(form.status, 415);
}

// ---------------------------------------------------------------------------------------------
// Drill: mcp-aliases (admin, baseline)
// ---------------------------------------------------------------------------------------------

async function mcpAliases() {
  await mcpInit();
  const listed = (await rpc("tools/list", {})).tools.map((tool) => tool.name);
  for (const name of [...ALIASES, ...ALL_OPERATIONS.map((id) => `jira.${id}`)]) assert.ok(listed.includes(name), `tools/list lacks ${name}`);
  assert.equal((await mcp("getAccessibleAtlassianResources", {}))[0].id, CLOUD_ID);
  await mcpError("getAccessibleAtlassianResources", { cloudId: "wrong" }, "tool.NOT_FOUND");
  assert.equal((await mcp("atlassianUserInfo", { cloudId: CLOUD_ID })).accountId, PRIYA);
  await mcpError("atlassianUserInfo", { cloudId: "wrong" }, "tool.NOT_FOUND");
  const rover = await mcp("getVisibleJiraProjects", { cloudId: CLOUD_ID, searchString: "rover", maxResults: 10 });
  assert.deepEqual(rover.values.map((project) => project.key), ["SFR"]);
  await mcpError("getVisibleJiraProjects", { cloudId: "wrong" }, "tool.NOT_FOUND");
  const plat = await mcp("jira.projects.get", { projectIdOrKey: "PLAT", expand: ["issueTypes"] });
  assert.equal(plat.issueTypes.length, 3);
  assert.equal(plat.assigneeType, "UNASSIGNED");
  await mcpError("jira.projects.get", { projectIdOrKey: "NOPE" }, "tool.NOT_FOUND", "No project could be found with key 'NOPE'.");
  assert.equal((await mcp("getJiraProjectIssueTypesMetadata", { cloudId: CLOUD_ID, projectIdOrKey: "SFR" })).issueTypes.length, 5);
  await mcpError("getJiraProjectIssueTypesMetadata", { cloudId: "wrong", projectIdOrKey: "SFR" }, "tool.NOT_FOUND");
  const created = await mcp("createJiraIssue", { cloudId: CLOUD_ID, projectKey: "SFR", issueTypeName: "Task", summary: "MCP created", description: "via alias", assignee_account_id: MARCUS });
  assert.equal(created.key, "SFR-15");
  await mcpError("createJiraIssue", { cloudId: "wrong", projectKey: "SFR", issueTypeName: "Task", summary: "x" }, "tool.NOT_FOUND");
  await mcpError("createJiraIssue", { cloudId: CLOUD_ID, projectKey: "SFR", issueTypeName: "Task", summary: "x", fields: { summary: "y" } }, "tool.VALIDATION_ERROR");
  const issue = await mcp("getJiraIssue", { cloudId: CLOUD_ID, issueIdOrKey: "SFR-15", fields: ["summary", "assignee"] });
  assert.equal(issue.fields.summary, "MCP created");
  assert.equal(issue.fields.assignee.accountId, MARCUS);
  await mcpError("getJiraIssue", { cloudId: "wrong", issueIdOrKey: "SFR-1" }, "tool.NOT_FOUND");
  const invalid = await mcpError("getJiraIssue", {});
  assert.equal(invalid.status, "invalid", "schema-invalid MCP arguments are rejected before the Tool runs");
  assert.ok(invalid.error.message.includes("issueIdOrKey"), invalid.error.message);
  await apiError("GET", `${API}/issue/createmeta/PLAT/issuetypes?maxResults=abc`, 400, "arguments do not match");
  await mcp("editJiraIssue", { cloudId: CLOUD_ID, issueIdOrKey: "SFR-15", fields: { priority: { name: "Low" } } });
  await mcpError("editJiraIssue", { cloudId: "wrong", issueIdOrKey: "SFR-15", fields: { priority: { name: "Low" } } }, "tool.NOT_FOUND");
  assert.equal((await mcp("getTransitionsForJiraIssue", { cloudId: CLOUD_ID, issueIdOrKey: "SFR-15" })).transitions.length, 4);
  await mcpError("getTransitionsForJiraIssue", { cloudId: "wrong", issueIdOrKey: "SFR-15" }, "tool.NOT_FOUND");
  assert.equal((await mcp("transitionJiraIssue", { cloudId: CLOUD_ID, issueIdOrKey: "SFR-15", transition: { id: "21" } })).status.name, "In Progress");
  await mcpError("transitionJiraIssue", { cloudId: "wrong", issueIdOrKey: "SFR-15", transition: { id: "21" } }, "tool.NOT_FOUND");
  assert.equal(adfText((await mcp("addCommentToJiraIssue", { cloudId: CLOUD_ID, issueIdOrKey: "SFR-15", commentBody: "Looks good" })).body), "Looks good");
  await mcpError("addCommentToJiraIssue", { cloudId: "wrong", issueIdOrKey: "SFR-15", commentBody: "x" }, "tool.NOT_FOUND");
  const mine = await mcp("searchJiraIssuesUsingJql", { cloudId: CLOUD_ID, jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC", maxResults: 10, fields: ["summary", "status"] });
  assert.ok(keys(mine.issues).includes("SFR-3") && !keys(mine.issues).includes("SFR-15"));
  await mcpError("searchJiraIssuesUsingJql", { cloudId: CLOUD_ID, jql: "fixVersion = 1.0" }, "tool.INVALID_JQL", "Field 'fixVersion' does not exist");
  await mcpError("searchJiraIssuesUsingJql", { cloudId: "wrong", jql: "" }, "tool.NOT_FOUND");
  assert.equal((await mcp("lookupJiraAccountId", { cloudId: CLOUD_ID, searchString: "elena" })).length, 1);
  await mcpError("lookupJiraAccountId", { cloudId: "wrong", searchString: "elena" }, "tool.NOT_FOUND");
  const http = (await get(`${API}/issue/SFR-15`)).json.fields;
  assert.equal(http.priority.name, "Low");
  assert.equal(http.status.name, "In Progress");
  assert.equal(http.comment.total, 1, "the MCP-created comment is visible over REST");
}

// ---------------------------------------------------------------------------------------------
// Drill: jql (member = Marcus, baseline)
// ---------------------------------------------------------------------------------------------

const SFR = (numbers) => numbers.map((number) => `SFR-${number}`);
const JQL_SETS = [
  ['project = SFR AND status = "To Do"', SFR([1, 5, 6, 9, 10, 11, 13, 14])],
  ['status in ("In Progress", "In Review")', [...SFR([2, 3, 12]), "PLAT-2"]],
  ["statusCategory = Done", [...SFR([4, 7, 8]), "PLAT-3", "PLAT-4", "SEC-2"]],
  ["statusCategory != Done AND project != SEC", [...SFR([1, 2, 3, 5, 6, 9, 10, 11, 12, 13, 14]), "PLAT-1", "PLAT-2", "PLAT-5", "PLAT-6"]],
  ["assignee = currentUser()", [...SFR([2, 4, 7, 12]), "PLAT-1", "PLAT-3", "PLAT-6"]],
  ["assignee is EMPTY", [...SFR([1, 5, 9, 11, 14]), "PLAT-4"]],
  ['assignee = "priya.natarajan@stellarforge.example.com"', [...SFR([3, 13]), "PLAT-5", "SEC-2"]],
  [`reporter in (currentUser(), "${APP}")`, [...SFR([3, 6, 11]), "PLAT-2"]],
  ["issuetype = Bug", [...SFR([6, 10]), "PLAT-2", "PLAT-4"]],
  ["type in (Epic, Subtask)", [...SFR([1, 4, 5]), "PLAT-6"]],
  ["priority >= High", [...SFR([2, 6, 12]), "PLAT-2", "SEC-1"]],
  ["priority = 3", [...SFR([1, 3, 4, 5, 7, 9, 11, 13, 14]), "PLAT-1", "PLAT-3", "PLAT-6", "SEC-2"]],
  ["labels = navigation", SFR([2, 12])],
  ["labels in (docs, lidar)", SFR([2, 11])],
  ["labels is EMPTY", [...SFR([1, 3, 4, 5, 7, 8, 9, 10, 13, 14]), "PLAT-1", "PLAT-2", "PLAT-3", "PLAT-4", "PLAT-5", "PLAT-6", "SEC-2"]],
  ["sprint = 2", SFR([2, 3, 4, 5, 6])],
  ['sprint = "SFR Sprint 2"', SFR([2, 3, 4, 5, 6])],
  ["sprint in openSprints()", SFR([2, 3, 4, 5, 6])],
  ["sprint in closedSprints()", SFR([7, 8])],
  ["sprint in futureSprints()", SFR([9])],
  ["sprint is EMPTY AND project = SFR", SFR([1, 10, 11, 12, 13, 14])],
  ["parent = SFR-1", SFR([2, 3])],
  ["parent is not EMPTY", [...SFR([2, 3, 4, 5]), "PLAT-6"]],
  ["resolution = Unresolved AND project = PLAT", ["PLAT-1", "PLAT-2", "PLAT-5", "PLAT-6"]],
  ["resolution = \"Won't Do\"", SFR([8])],
  ['resolution in (Done, "Cannot Reproduce")', [...SFR([4, 7]), "PLAT-3", "PLAT-4", "SEC-2"]],
  ["key in (SFR-1, 10105)", SFR([1, 6])],
  ["key > SFR-10", SFR([11, 12, 13, 14])],
  ["summary ~ docking", SFR([1, 6, 7, 13])],
  ['summary ~ "dock*"', SFR([1, 6, 7, 9, 13, 14])],
  ["summary ~ überwachung", SFR([14])],
  ['text ~ "stale"', [...SFR([10, 12]), "SEC-2"]],
  ["comment ~ stale", SFR([12])],
  ["description ~ rover", SFR([1, 2, 3, 4, 6, 12, 14])],
  ['comment ~ "reopen*"', SFR([12])],
  ["created >= -2d", SFR([14])],
  // Compound Jira periods: terms sum, a leading sign applies to the whole period, whitespace between terms is optional.
  ["created >= \"-1d 1d\"", SFR([14])],
  ["created >= \"-1w 6d 23h 60m\" AND created < -1d", [...SFR([9, 13]), "SEC-1"]],
  ["created >= \"-2w\" AND created < \"-1w2d\"", ["SEC-1"]],
  ["created >= \"- 1w 1d\" AND created < \"-1w 1d\"", []],
  ['created >= "2026-09-01" AND created < "2026-09-14"', [...SFR([9, 13, 14]), "SEC-1"]],
  ['updated >= startOfDay("-7d")', [...SFR([2, 3, 4, 6, 9, 12, 13, 14]), "PLAT-2"]],
  ["duedate <= now()", SFR([6])],
  ['duedate = "2026-09-20"', SFR([13])],
  ["duedate is EMPTY", [...SFR([1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 14]), "PLAT-1", "PLAT-2", "PLAT-3", "PLAT-4", "PLAT-5", "PLAT-6", "SEC-1", "SEC-2"]],
  ["resolved >= -30d", [...SFR([4, 7, 8]), "PLAT-3", "PLAT-4", "SEC-2"]],
  ["NOT (project = SFR OR project = PLAT)", ["SEC-1", "SEC-2"]],
  ["(project = SFR AND type = Bug) OR key = PLAT-2", [...SFR([6, 10]), "PLAT-2"]],
  // EMPTY/NULL on fields that have an empty state (Atlassian JQL reference): matches, never a crash.
  ["assignee in (EMPTY)", [...SFR([1, 5, 9, 11, 14]), "PLAT-4"]],
  ["project is EMPTY", []],
  ["priority is not EMPTY AND project = PLAT", ["PLAT-1", "PLAT-2", "PLAT-3", "PLAT-4", "PLAT-5", "PLAT-6"]],
  ["created = EMPTY", []],
  ["duedate != EMPTY", SFR([6, 13])],
  ["description is EMPTY", [...SFR([5, 9]), "PLAT-6"]],
  ["parent in (SFR-1, null) AND project = SFR", SFR([1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14])],
];
const CREATED_DESC = ["SFR-14", "SFR-13", "SFR-9", "SEC-1", "SFR-6", "SFR-8", "SFR-7", "PLAT-6", "PLAT-5", "PLAT-4", "SFR-12", "SEC-2", "PLAT-3", "SFR-11", "PLAT-2", "SFR-10", "PLAT-1", "SFR-5", "SFR-4", "SFR-3", "SFR-2", "SFR-1"];
const JQL_ERRORS = [
  ["project = SFR AND", "Error in the JQL Query"],
  ["project ~ SFR", "The operator '~' is not supported by the 'project' field."],
  ["status was Done", "The JQL construct 'was' is not supported by this Tool."],
  ["fixVersion = 1.0", "Field 'fixVersion' does not exist or you do not have permission to view it."],
  ['assignee in membersOf("x")', "membersOf"],
  ["cf[10020] = 2", "Field 'cf[10020]' does not exist"],
  ["created >= tomorrow", "Date value 'tomorrow' for field 'created' is invalid."],
  // Malformed periods report the same invalid-date message that names the '4w 2d' compound form.
  ["created >= \"4w 2\"", "period format e.g. '-5d', '4w 2d'"],
  ["created >= \"4w 2y\"", "Date value '4w 2y' for field 'created' is invalid."],
  ["created >= \"1d 1d 1d 1d 1d 1d 1d 1d 1d\"", "Date value '1d 1d 1d 1d 1d 1d 1d 1d 1d' for field 'created' is invalid."],
  ["created >= \"1234567d\"", "Date value '1234567d' for field 'created' is invalid."],
  ['updated >= startOfDay("-1w 2x")', "Invalid argument for JQL function 'startOfDay'."],
  ["key = SFR-1 ORDER BY bogus", "Not able to sort using field 'bogus'."],
  ["((", "Error in the JQL Query"],
  ["project = NOPE", "The value 'NOPE' does not exist for the field 'project'."],
  // Issue key, status and ordered comparisons have no empty state: a JQL validation error, not a handler crash.
  ["key in (null)", "The field 'key' does not support searching for EMPTY values."],
  ["key in (SFR-1, EMPTY)", "The field 'key' does not support searching for EMPTY values."],
  ["key > null", "The field 'key' does not support searching for EMPTY values."],
  ["issuekey is EMPTY", "The operator 'is' is not supported by the 'issuekey' field."],
  ["status = EMPTY", "The field 'status' does not support searching for EMPTY values."],
  ["created > EMPTY", "The operator '>' does not support searching for EMPTY values on the field 'created'."],
  [`${"(".repeat(65)}key = SFR-1${")".repeat(65)}`, "The query nests parentheses or NOT more than 64 levels deep."],
  ['summary ~ "dock�"', "malformed character encoding"],
  // Caller-chosen function and field names that match inherited object members must miss, never resolve.
  ["sprint in constructor()", "The JQL function 'constructor' is not supported by this Tool."],
  ["sprint in __proto__()", "The JQL function '__proto__' is not supported by this Tool."],
  ["sprint not in constructor()", "The JQL function 'constructor' is not supported by this Tool."],
  ["constructor = SFR", "Field 'constructor' does not exist or you do not have permission to view it."],
  ["__proto__ is EMPTY", "Field '__proto__' does not exist or you do not have permission to view it."],
  ["project = SFR ORDER BY toString", "Not able to sort using field 'toString'."],
];

async function jqlFlow() {
  const search = async (jql) => keys((await post(`${API}/search/jql`, { jql, fields: ["key"], maxResults: 100 })).json.issues);
  for (const [jql, expected] of JQL_SETS) assert.deepEqual(sorted(await search(jql)), sorted(expected), `JQL ${jql}`);
  assert.deepEqual(await search("project = sfr ORDER BY priority DESC, key ASC"), SFR([6, 2, 12, 1, 3, 4, 5, 7, 9, 11, 13, 14, 8, 10]));
  assert.deepEqual(await search("ORDER BY created DESC"), CREATED_DESC);
  assert.deepEqual(await search(""), CREATED_DESC, "the default order is created DESC");
  assert.deepEqual(await search("order by key"), ["PLAT-1", "PLAT-2", "PLAT-3", "PLAT-4", "PLAT-5", "PLAT-6", "SEC-1", "SEC-2", ...SFR([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])]);
  const byDue = await search("ORDER BY duedate ASC");
  assert.deepEqual(byDue.slice(0, 2), ["SFR-6", "SFR-13"], "nulls last");
  assert.equal(byDue.length, 22);
  for (const [jql, text] of JQL_ERRORS) await apiError("POST", `${API}/search/jql`, 400, text, { body: { jql } });
  await apiError("POST", `${API}/search/jql`, 400, "maxResults", { body: { jql: "", maxResults: 101 } });
  await apiError("GET", `${API}/search/jql?jql=${q("key = EMPTY")}`, 400, "The field 'key' does not support searching for EMPTY values.");
  for (const [jql, expected] of [JQL_SETS[0], JQL_SETS[2], JQL_SETS[12], JQL_SETS[41], JQL_SETS[45]]) {
    assert.equal((await post(`${API}/search/approximate-count`, { jql })).json.count, expected.length, `count ${jql}`);
  }
  await apiError("POST", `${API}/search/approximate-count`, 400, "Error in the JQL Query", { body: { jql: "((" } });
  await apiError("POST", `${API}/search/approximate-count`, 400, "The field 'key' does not support searching for EMPTY values.", { body: { jql: "key = null" } });
  await apiError("POST", `${API}/search/approximate-count`, 400, "The JQL function 'constructor' is not supported by this Tool.", { body: { jql: "sprint not in constructor()" } });
}

// ---------------------------------------------------------------------------------------------
// Drill: permissions (viewer = Tomasz: PLAT Viewer, SFR open, SEC hidden)
// ---------------------------------------------------------------------------------------------

async function permissions() {
  assert.equal((await get(`${API}/myself`)).json.accountId, TOMASZ);
  assert.deepEqual((await get(`${API}/project/search`)).json.values.map((project) => project.key), ["PLAT", "SFR"], "SEC is hidden");
  assert.deepEqual((await get(`${API}/project/search?action=edit`)).json.values.map((project) => project.key), ["SFR"]);
  await apiError("GET", `${API}/issue/SEC-1`, 404, ISSUE_NOT_FOUND);
  await apiError("PUT", `${API}/issue/SEC-1`, 404, ISSUE_NOT_FOUND, { body: { fields: { summary: "x" } } });
  await apiError("GET", `${API}/issue/SEC-1/comment`, 404, ISSUE_NOT_FOUND);
  await apiError("GET", `${API}/project/SEC/statuses`, 404, "No project could be found with key 'SEC'.");
  assert.deepEqual((await post(`${API}/search/jql`, { jql: "project = SEC" })).json.issues, []);
  assert.deepEqual((await post(`${API}/search/jql`, { jql: "text ~ incident" })).json.issues, [], "SEC content never leaks");
  assert.equal((await post(`${API}/search/approximate-count`, { jql: "" })).json.count, 20);
  assert.equal((await get(`${API}/issue/PLAT-2?fields=summary`)).json.fields.summary, "Telemetry ingest drops packets under load");
  const denied = "You do not have permission to edit issues in this project.";
  await apiError("PUT", `${API}/issue/PLAT-2`, 403, denied, { body: { fields: { summary: "x" } } });
  assert.equal((await get(`${API}/issue/PLAT-2?fields=summary`)).json.fields.summary, "Telemetry ingest drops packets under load", "nothing changed");
  await apiError("POST", `${API}/issue/PLAT-2/comment`, 403, "You do not have permission to comment on issues in this project.", { body: { body: "x" } });
  await apiError("PUT", `${API}/issue/PLAT-2/assignee`, 403, "You do not have permission to assign issues in this project.", { body: { accountId: null } });
  await apiError("POST", `${API}/issue/PLAT-2/transitions`, 403, "You do not have permission to transition issues in this project.", { body: { transition: { id: "21" } } });
  await apiError("POST", `${API}/issue`, 403, "You do not have permission to create issues in this project.", { body: { fields: { project: { key: "PLAT" }, issuetype: { name: "Task" }, summary: "x" } } });
  await apiError("DELETE", `${API}/issue/PLAT-2`, 403, "You do not have permission to delete issues in this project.");
  assert.equal(adfText((await put(`${API}/issue/PLAT-2/comment/10260`, { body: "my edit" })).json.body), "my edit", "a Viewer edits their own comment");
  await apiError("PUT", `${API}/issue/PLAT-2/comment/10259`, 403, "You do not have permission to edit this comment.", { body: { body: "x" } });
  await apiError("DELETE", `${API}/issue/PLAT-2/comment/10259`, 403, "You do not have permission to delete this comment.");
  assert.deepEqual(names((await get(`${API}/user/assignable/search?project=PLAT`)).json), ["Elena Sokolova", "Marcus Oyelaran", "Priya Natarajan"]);
  assert.equal((await get(`${AGILE}/board`)).json.total, 2);
  await apiError("POST", `${AGILE}/sprint/3/issue`, 403, denied, { body: { issues: ["PLAT-1"] } });
  await post(`${AGILE}/sprint/3/issue`, { issues: ["SFR-11"] }, { status: 204 });
  const created = (await post(`${API}/issue`, { fields: { project: { key: "SFR" }, issuetype: { name: "Task" }, summary: "Field radio check" } }, { status: 201 })).json;
  assert.equal(created.key, "SFR-15");
  await put(`${API}/issue/SFR-15`, { fields: { summary: "Field radio check (rover 2)" } }, { status: 204 });
  const comment = (await post(`${API}/issue/SFR-15/comment`, { body: "Scheduled for Thursday." }, { status: 201 })).json;
  await apiError("DELETE", `${API}/issue/SFR-15`, 403, "You do not have permission to delete issues in this project.");
  await del(`${API}/issue/SFR-15/comment/${comment.id}`);
}

// ---------------------------------------------------------------------------------------------
// Drill: private-viewer (member = Marcus resolved by e-mail: SEC Viewer, SFR/PLAT Member)
// ---------------------------------------------------------------------------------------------

async function privateViewer() {
  assert.equal((await get(`${API}/myself`)).json.accountId, MARCUS);
  assert.equal((await get(`${API}/issue/SEC-1?fields=summary`)).json.fields.summary, "Incident 2026-09: exposed staging credentials");
  assert.equal((await get(`${API}/issue/SEC-1/comment`)).json.total, 1);
  await apiError("POST", `${API}/issue/SEC-1/comment`, 403, "You do not have permission to comment on issues in this project.", { body: { body: "x" } });
  await apiError("PUT", `${API}/issue/SEC-1`, 403, "You do not have permission to edit issues in this project.", { body: { fields: { summary: "x" } } });
  await apiError("POST", `${API}/issue`, 403, "You do not have permission to create issues in this project.", { body: { fields: { project: { key: "SEC" }, issuetype: { name: "Task" }, summary: "x" } } });
  assert.deepEqual(names((await get(`${API}/user/assignable/search?project=SEC`)).json), ["Elena Sokolova", "Priya Natarajan"]);
  await put(`${API}/issue/PLAT-1`, { fields: { summary: "Rotate service tokens quarterly" } }, { status: 204 });
  await apiError("DELETE", `${API}/issue/PLAT-6`, 403, "You do not have permission to delete issues in this project.");
  assert.equal((await post(`${API}/issue/SFR-12/comment`, { body: "Patch merged." }, { status: 201 })).json.author.accountId, MARCUS);
}

// ---------------------------------------------------------------------------------------------
// Drill: default-identity (fresh actor with no attributes → seeded default user)
// ---------------------------------------------------------------------------------------------

async function defaultIdentity() {
  assert.equal((await get(`${API}/myself`)).json.accountId, PRIYA, "an actor without provider attributes is the seeded default user");
  assert.equal((await get(`${API}/project/search`)).json.total, 3);
  const created = (await post(`${API}/issue`, { fields: { project: { key: "SEC" }, issuetype: { name: "Task" }, summary: "Review VPN access list" } }, { status: 201 })).json;
  assert.equal(created.key, "SEC-3");
  assert.equal((await get(`${API}/issue/SEC-3?fields=reporter`)).json.fields.reporter.accountId, PRIYA);
  await apiError("DELETE", `${API}/issue/SEC-3`, 403, "You do not have permission to delete issues in this project.");
}

// ---------------------------------------------------------------------------------------------
// Drills: denied / invalid-auth / deactivated-user
// ---------------------------------------------------------------------------------------------

async function denied() {
  const message = "You do not have permission to perform this action.";
  await apiError("GET", `${API}/myself`, 403, message);
  await apiError("GET", `${API}/issue/SFR-1`, 403, message);
  await apiError("POST", `${API}/issue`, 403, message, { body: { fields: { project: { key: "SFR" }, issuetype: { name: "Task" }, summary: "x" } } });
  await mcpInit();
  const result = await rpc("tools/call", { name: "getJiraIssue", arguments: { issueIdOrKey: "SFR-1" } });
  assert.ok(result.isError);
  assert.equal(mcpValue(result).status, "denied");
}

async function invalidAuth() {
  for (const entry of CALLS) await callError(entry, 401, { code: "UNAUTHORIZED", message: "Client must be authenticated to access this resource." });
  await mcpInit();
  await mcpError("atlassianUserInfo", {}, "tool.UNAUTHORIZED");
}

async function deactivatedUser() {
  await apiError("GET", `${API}/myself`, 401, "Client must be authenticated to access this resource.");
  await apiError("POST", `${API}/search/jql`, 401, "Client must be authenticated", { body: { jql: "" } });
}

// ---------------------------------------------------------------------------------------------
// Drills: faults
// ---------------------------------------------------------------------------------------------

async function rateLimited() {
  for (const entry of CALLS) {
    const result = await callError(entry, 429, { code: "RATE_LIMITED", message: "Rate limit exceeded." });
    if (entry[0] !== "OP") {
      assert.equal(result.headers.get("retry-after"), "2");
      assert.equal(result.headers.get("x-ratelimit-remaining"), "0");
    }
  }
  await mcpInit();
  const error = (await mcpError("searchJiraIssuesUsingJql", { jql: "" }, "tool.RATE_LIMITED")).error;
  assert.equal(error.message, "Rate limit exceeded.");
}

async function writeUnavailable() {
  for (const index of WRITE_INDEXES) await callError(CALLS[index], 503, { code: "SERVICE_UNAVAILABLE", message: UNAVAILABLE });
  assert.equal((await get(`${API}/myself`)).json.accountId, PRIYA, "reads keep working");
  assert.equal((await get(`${API}/project/search`)).json.total, 3);
  assert.equal((await get(`${API}/issue/SFR-1?fields=summary`)).json.fields.summary, "Autonomous docking");
  assert.equal((await post(`${API}/search/jql`, { jql: "project = SFR" })).json.issues.length, 14);
  assert.equal((await get(`${AGILE}/board`)).json.total, 2);
  await apiError("GET", `${API}/issue/SFR-15`, 404, ISSUE_NOT_FOUND, {});
  assert.equal((await get(`${API}/issue/SFR-12/comment`)).json.total, 6, "nothing was written");
  assert.equal((await get(`${API}/issue/SFR-11?fields=customfield_10020`)).json.fields.customfield_10020, null);
}

async function transitionCommittedLost() {
  await apiError("POST", `${API}/issue/PLAT-1/transitions`, 503, UNAVAILABLE, { body: { transition: { id: "21" } } });
  const plat1 = (await get(`${API}/issue/PLAT-1?fields=status,resolution`)).json.fields;
  assert.equal(plat1.status.name, "Resolved", "the transition committed although the caller saw 503");
  assert.equal(plat1.resolution.name, "Done");
  await apiError("POST", `${API}/issue/PLAT-1/transitions`, 400, "Transition id '21' is not valid for this issue.", { body: { transition: { id: "21" } } });
  await apiError("POST", `${API}/issue/SFR-2/transitions`, 503, UNAVAILABLE, { body: { transition: { id: "41" }, update: { comment: [{ add: { body: "closing" } }] } } });
  const sfr2 = (await get(`${API}/issue/SFR-2?fields=status,comment`)).json.fields;
  assert.equal(sfr2.status.name, "Done");
  assert.equal(sfr2.comment.total, 3);
  await put(`${API}/issue/PLAT-1`, { fields: { summary: "after outage" } }, { status: 204 });
}

// ---------------------------------------------------------------------------------------------
// Drills: tight-limits (site.limits lowered below the starter data)
// ---------------------------------------------------------------------------------------------

async function tightLimits() {
  for (const entry of CALLS) await callError(entry, 500, { code: "FAILED_PRECONDITION", message: "state exceeds the supported bound of 2 rows for users" });
}

async function tightLimitsAdmin() {
  assert.equal((await get(`${API}/myself`)).json.accountId, PRIYA, "a direct accountId lookup needs no scan");
  assert.equal((await get(`${API}/issue/10100?fields=summary`)).json.fields.summary, "Autonomous docking", "an id lookup of summary only needs no issue scan");
  await apiError("GET", `${API}/issue/SFR-1`, 500, "state exceeds the supported bound of 5 rows for issues");
  await apiError("GET", `${API}/project/search`, 500, "state exceeds the supported bound of 2 rows for projects");
  await apiError("POST", `${API}/search/jql`, 500, "state exceeds the supported bound of 2 rows for projects", { body: { jql: "" } });
  await apiError("GET", `${API}/issue/10111/comment`, 500, "state exceeds the supported bound of 2 rows for comments");
  await apiError("POST", `${API}/issue/10111/comment`, 500, "bound of 2 rows for comments", { body: { body: "x" } });
  await apiError("GET", `${AGILE}/board`, 500, "state exceeds the supported bound of 1 rows for boards");
}

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Drill: response-budget (text caps on write, byte-filled pages on read)
// ---------------------------------------------------------------------------------------------

const MIB = 1024 * 1024;
const TOO_LONG = "The entered text is too long. It exceeds the allowed limit of 32,767 characters.";

async function responseBudget() {
  const max = "界".repeat(32767);
  const over = "界".repeat(32768);
  const adf = (text) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  const task = (summary, description) => ({ fields: { project: { key: "SFR" }, issuetype: { name: "Task" }, summary, description } });
  assert.equal(JSON.stringify(adf("")).length, 97);
  await fieldError("POST", `${API}/issue`, "description", task("over", over), TOO_LONG);
  await fieldError("POST", `${API}/issue`, "description", task("over adf", adf("界".repeat(32767 - 96))), TOO_LONG);
  await fieldError("PUT", `${API}/issue/SFR-1`, "description", { fields: { description: over } }, TOO_LONG);
  await fieldError("POST", `${API}/issue/SFR-1/comment`, "comment", { body: over }, TOO_LONG);
  await fieldError("POST", `${API}/issue/SFR-1/comment`, "comment", { body: adf("界".repeat(32767 - 96)) }, TOO_LONG);
  await fieldError("PUT", `${API}/issue/SFR-1`, "comment", { update: { comment: [{ add: { body: over } }] } }, TOO_LONG);
  await fieldError("POST", `${API}/issue/SFR-1/transitions`, "comment", { transition: { id: "21" }, update: { comment: [{ add: { body: over } }] } }, TOO_LONG);
  const small = (await post(`${API}/search/jql`, { jql: "project = SFR ORDER BY key ASC", maxResults: 5, fields: ["summary"] })).json;
  assert.deepEqual(small.issues.map((issue) => issue.key), ["SFR-1", "SFR-2", "SFR-3", "SFR-4", "SFR-5"]);
  assert.equal(small.isLast, false);

  // Maximum-size issues: 12 plain-text descriptions and one ADF document exactly at the limit.
  const keys = [];
  for (let index = 0; index < 12; index += 1) keys.push((await post(`${API}/issue`, task(`budget ${index}`, max), { status: 201 })).json.key);
  keys.push((await post(`${API}/issue`, task("budget adf", adf("界".repeat(32767 - 97))), { status: 201 })).json.key);
  assert.equal(keys[0], "SFR-15");

  const seen = [];
  let token;
  let pages = 0;
  do {
    const page = await post(`${API}/search/jql`, { jql: "summary ~ budget ORDER BY key ASC", fields: ["description", "comment"], maxResults: 100, ...(token ? { nextPageToken: token } : {}) });
    assert.ok(page.bytes < MIB, `search page of ${page.bytes} bytes`);
    assert.ok(page.json.issues.length > 0);
    seen.push(...page.json.issues.map((issue) => issue.key));
    token = page.json.nextPageToken;
    assert.equal(page.json.isLast, token === undefined);
    pages += 1;
  } while (token !== undefined && pages < 50);
  assert.ok(pages > 1, "maximum-size issues span several pages");
  assert.deepEqual(seen, keys, "every issue exactly once, in order");
  assert.equal((await post(`${API}/search/approximate-count`, { jql: "summary ~ budget" })).json.count, 13);

  // Ten maximum-size comments: the inline comment field keeps what fits, comments.list pages by bytes.
  const before = (await get(`${API}/issue/SFR-1/comment?maxResults=1`)).json.total;
  for (let index = 0; index < 10; index += 1) await post(`${API}/issue/SFR-1/comment`, { body: max }, { status: 201 });
  const total = before + 10;
  const issue = await get(`${API}/issue/SFR-1`);
  assert.ok(issue.bytes < MIB, `issue of ${issue.bytes} bytes`);
  const inline = issue.json.fields.comment;
  assert.equal(inline.total, total);
  assert.ok(inline.comments.length > 0 && inline.comments.length < total && inline.maxResults === inline.comments.length, JSON.stringify({ ...inline, comments: inline.comments.length }));
  const commentIds = [];
  let startAt = 0;
  for (let guard = 0; guard < 40 && startAt < total; guard += 1) {
    const page = await get(`${API}/issue/SFR-1/comment?maxResults=100&startAt=${startAt}`);
    assert.ok(page.bytes < MIB && page.json.total === total && page.json.comments.length > 0);
    if (startAt === 0) assert.ok(page.json.maxResults < total && page.json.maxResults === page.json.comments.length);
    commentIds.push(...page.json.comments.map((comment) => comment.id));
    startAt += page.json.maxResults;
  }
  assert.equal(new Set(commentIds).size, total);
  assert.equal(commentIds.length, total);
}

// ---------------------------------------------------------------------------------------------
// Drill: oversized-issue (one issue too large for any single response)
// ---------------------------------------------------------------------------------------------

async function oversizedIssue() {
  const summary = (index) => `subtask ${String(index).padStart(3, "0")} `.padEnd(255, "s");
  for (let index = 0; index < 680; index += 1) {
    await post(`${API}/issue`, { fields: { project: { key: "SFR" }, issuetype: { name: "Subtask" }, parent: { key: "SFR-2" }, summary: summary(index) } }, { status: 201 });
  }
  await apiError("GET", `${API}/issue/SFR-2`, 400, "The issue 'SFR-2' is too large to return");
  await apiError("GET", `${API}/issue/SFR-2?fields=subtasks`, 400, "Request fewer fields");
  assert.equal((await get(`${API}/issue/SFR-2?fields=summary,status`)).json.key, "SFR-2");
  await apiError("POST", `${API}/search/jql`, 400, "The issue 'SFR-2' is too large to return", { body: { jql: "key = SFR-2", fields: ["subtasks"] } });
  assert.equal((await post(`${API}/search/jql`, { jql: "key = SFR-2", fields: ["summary"] })).json.issues[0].key, "SFR-2");
  const children = [];
  let token;
  let pages = 0;
  do {
    const page = await post(`${API}/search/jql`, { jql: "parent = SFR-2 ORDER BY key ASC", fields: ["summary"], maxResults: 100, ...(token ? { nextPageToken: token } : {}) });
    assert.ok(page.bytes < MIB);
    children.push(...page.json.issues.map((child) => child.key));
    token = page.json.nextPageToken;
    pages += 1;
  } while (token !== undefined && pages < 20);
  assert.equal(new Set(children).size, children.length);
  assert.ok(children.length >= 680, `${children.length} children`);
  assert.equal((await post(`${API}/search/approximate-count`, { jql: "parent = SFR-2" })).json.count, children.length);
}

const flows = {
  "rest-flow": restFlow,
  "mcp-aliases": mcpAliases,
  jql: jqlFlow,
  permissions,
  "private-viewer": privateViewer,
  "default-identity": defaultIdentity,
  denied,
  "invalid-auth": invalidAuth,
  "deactivated-user": deactivatedUser,
  "rate-limited": rateLimited,
  "write-unavailable": writeUnavailable,
  "transition-committed-lost": transitionCommittedLost,
  "tight-limits-admin": tightLimitsAdmin,
  "tight-limits": tightLimits,
  "response-budget": responseBudget,
  "oversized-issue": oversizedIssue,
};
const selected = Object.keys(flows).find((name) => instruction.includes(`the ${name} conformance flow`));
if (selected === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
