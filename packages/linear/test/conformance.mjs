// Linear Tool conformance target. A scripted Tool test, not a model-driven agent.
// Node built-ins only: fetch against the Linear-shaped `POST /graphql` route (raw API-key style
// `Authorization` header), the canonical Firedrill operation endpoint, and raw MCP JSON-RPC
// (Streamable HTTP) for the official Linear MCP server tool-name aliases. Every flow fails loudly
// on an unexpected status, header or body.
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

const U = (n) => `0000000a-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const T = (n) => `0000000b-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const S = (n) => `0000000c-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const L = (n) => `0000000d-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const P = (n) => `0000000e-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const C = (n) => `0000000f-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const I = (n) => `00000010-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const K = (n) => `00000011-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const MAYA = U(1);
const DANIEL = U(2);
const SOFIA = U(3);
const KENJI = U(4);
const LARS = U(5);
const ENG = T(1);
const MOB = T(2);
const SEC = T(3);
const NOW = "2026-09-14T09:00:00.000Z";
const NOT_FOUND_ISSUE = "Entity not found: Issue - Could not find referenced Issue.";
const AUTH_MESSAGE = "Authentication required, not authenticated";

const ALL_OPERATIONS = [
  "organization.get", "viewer.get", "users.list", "users.get", "teams.list", "teams.get", "workflow-states.list", "labels.list", "labels.create",
  "projects.list", "projects.get", "projects.save", "cycles.list", "issues.list", "issues.get", "issues.create", "issues.update", "issues.save",
  "issues.archive", "comments.list", "comments.create", "comments.update", "comments.save", "graphql.execute",
];
const ALIASES = [
  "get_workspace", "list_users", "get_user", "list_teams", "get_team", "list_issue_statuses", "list_issue_labels", "create_issue_label", "list_projects",
  "get_project", "save_project", "list_cycles", "list_issues", "get_issue", "save_issue", "list_comments", "save_comment",
];

/** One representative call per semantic operation (the canonical endpoint), in ALL_OPERATIONS order minus graphql.execute. */
const CALLS = [
  ["organization.get", {}],
  ["viewer.get", {}],
  ["users.list", {}],
  ["users.get", { query: "me" }],
  ["teams.list", {}],
  ["teams.get", { query: "ENG" }],
  ["workflow-states.list", { team: "ENG" }],
  ["labels.list", {}],
  ["labels.create", { name: "probe", teamId: ENG }],
  ["projects.list", {}],
  ["projects.get", { query: "3f2a9c1e" }],
  ["projects.save", { id: P(1), description: "probe" }],
  ["cycles.list", { teamId: "ENG" }],
  ["issues.list", {}],
  ["issues.get", { id: "ENG-1" }],
  ["issues.create", { team: "ENG", title: "Probe" }],
  ["issues.update", { id: "ENG-1", title: "Probe" }],
  ["issues.save", { id: "ENG-1", priority: 3 }],
  ["issues.archive", { id: "ENG-13" }],
  ["comments.list", { issueId: "ENG-2" }],
  ["comments.create", { issueId: "ENG-2", body: "Probe" }],
  ["comments.update", { id: K(1), body: "Probe" }],
  ["comments.save", { issueId: "ENG-2", body: "Probe" }],
];
const WRITE_OPERATIONS = ["labels.create", "projects.save", "issues.create", "issues.update", "issues.save", "issues.archive", "comments.create", "comments.update", "comments.save"];

// ---------------------------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------------------------

function checkHeaders(headers, where) {
  assert.equal(headers.get("x-ratelimit-requests-limit"), "1500", `${where}: missing X-RateLimit-Requests-Limit`);
  assert.ok(headers.get("x-ratelimit-requests-remaining") !== null, `${where}: missing X-RateLimit-Requests-Remaining`);
  assert.ok(headers.get("x-complexity") !== null, `${where}: missing X-Complexity`);
}

/** POST /graphql with the raw world token as the Authorization value (Linear API-key style). */
async function graphqlRaw(body, { status = 200, headers = {}, rawBody, contentType } = {}) {
  const response = await fetch(`${HTTP}/graphql`, {
    method: "POST",
    headers: { authorization: HTTP_TOKEN, "content-type": contentType ?? "application/json", ...headers },
    body: rawBody ?? JSON.stringify(body),
  });
  const text = await response.text();
  const json = text.length > 0 ? JSON.parse(text) : undefined;
  assert.equal(response.status, status, `POST /graphql ${JSON.stringify(body ?? rawBody).slice(0, 300)} -> ${response.status} ${text.slice(0, 500)}`);
  return { json, headers: response.headers, status: response.status };
}

async function gql(query, variables, operationName) {
  const result = await graphqlRaw({ query, ...(variables === undefined ? {} : { variables }), ...(operationName === undefined ? {} : { operationName }) });
  checkHeaders(result.headers, query.slice(0, 60));
  assert.ok(result.json.data !== undefined && result.json.errors === undefined, `expected data: ${JSON.stringify(result.json).slice(0, 400)}`);
  return result.json.data;
}

/** Expect Linear's error envelope with the given HTTP status, error code and message fragment. */
async function gqlError(query, status, code, text, variables, operationName) {
  const result = await graphqlRaw({ query, ...(variables === undefined ? {} : { variables }), ...(operationName === undefined ? {} : { operationName }) }, { status });
  checkHeaders(result.headers, query.slice(0, 60));
  const body = result.json;
  assert.ok(body && Array.isArray(body.errors) && body.errors.length > 0 && body.data === undefined, `no Linear error envelope: ${JSON.stringify(body)}`);
  const entry = body.errors[0];
  assert.ok(entry.extensions && typeof entry.extensions.type === "string", `error entry without extensions.type: ${JSON.stringify(entry)}`);
  if (code !== undefined) assert.equal(entry.extensions.code, code, `${query.slice(0, 80)}: ${JSON.stringify(body)}`);
  if (code !== undefined && code !== "RATELIMITED") {
    assert.ok(/^\d+$/.test(result.headers.get("x-ratelimit-requests-reset") ?? ""), `${query.slice(0, 60)}: a Tool-raised error must carry X-RateLimit-Requests-Reset`);
  }
  if (text !== undefined) assert.ok(String(entry.message).includes(text), `${query.slice(0, 80)}: expected ${JSON.stringify(text)}, got ${JSON.stringify(body)}`);
  return result;
}

/** Canonical Firedrill operation endpoint (`arguments` + optional `idempotencyKey`). */
async function operation(id, args, expected, idempotencyKey) {
  const response = await fetch(`${HTTP}/v1/operations/linear/${id}`, {
    method: "POST",
    headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }),
  });
  const result = await response.json();
  assert.ok(result.outcome, `operation ${id}: ${response.status} ${JSON.stringify(result).slice(0, 300)}`);
  if (expected === undefined) assert.equal(result.outcome.status, "ok", `operation ${id} ${JSON.stringify(args).slice(0, 200)}: ${JSON.stringify(result.outcome).slice(0, 500)}`);
  else assert.ok(result.outcome.status === expected || result.outcome.error?.code === expected, `operation ${id} ${JSON.stringify(args).slice(0, 200)}: expected ${expected}, got ${JSON.stringify(result.outcome).slice(0, 500)}`);
  return result.outcome;
}
const op = (id, args, key) => operation(id, args, undefined, key).then((outcome) => outcome.value);
async function opError(id, args, code, text, key) {
  const outcome = await operation(id, args, `tool.${code}`, key);
  if (text !== undefined) assert.ok(String(outcome.error.message).includes(text), `operation ${id}: ${JSON.stringify(outcome.error).slice(0, 400)}`);
  return outcome;
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
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "linear-conformance", version: "0.1.0" } });
}
function mcpValue(result) {
  assert.ok(Array.isArray(result.content) && result.content[0]?.type === "text", `MCP result without a text block: ${JSON.stringify(result).slice(0, 300)}`);
  const value = JSON.parse(result.content[0].text);
  assert.deepEqual(result.structuredContent, value, "structuredContent must mirror the text block");
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
  if (code !== undefined) {
    assert.ok(outcome.error, `${name}: ${JSON.stringify(result).slice(0, 400)}`);
    assert.equal(outcome.error.code, code, JSON.stringify(outcome.error).slice(0, 400));
    if (text !== undefined) assert.ok(String(outcome.error.message).includes(text), JSON.stringify(outcome.error).slice(0, 400));
  }
  return outcome;
}

const identifiers = (connection) => connection.nodes.map((node) => node.identifier);
const names = (connection) => connection.nodes.map((node) => node.name);

// Forged pagination tokens: code points above U+10FFFF (F4 90 80 80), a 5-byte lead (F8 88 80 80), an overlong NUL (C0 80),
// a UTF-16 surrogate (ED A0 80), a truncated 4-byte sequence, invalid base64, base64 of non-JSON, JSON of the wrong shape
// ({} and [1]), non-canonical trailing bits and the empty string. Each must be Linear's INVALID_INPUT "Invalid cursor".
const FORGED_CURSORS = ["9JCAgA", "-IiAgA", "wIA", "7aCA", "8J-Y", "@@@@", "bm90IGpzb24", "e30", "WzFd", "QR", ""];

// Every paginated GraphQL connection: [selection with $after, variables besides after].
const GRAPHQL_CONNECTIONS = [
  ["query Q($after: String) { users(after: $after) { nodes { id } } }"],
  ["query Q($after: String) { teams(after: $after) { nodes { id } } }"],
  [`query Q($after: String) { workflowStates(after: $after, filter: { team: { id: { eq: "${ENG}" } } }) { nodes { id } } }`],
  ["query Q($after: String) { issueLabels(after: $after) { nodes { id } } }"],
  ["query Q($after: String) { projects(after: $after) { nodes { id } } }"],
  [`query Q($after: String) { cycles(after: $after, filter: { team: { id: { eq: "${ENG}" } } }) { nodes { id } } }`],
  ["query Q($after: String) { issues(after: $after) { nodes { id } } }"],
  ['query Q($after: String) { searchIssues(term: "a", after: $after) { nodes { id } } }'],
  ['query Q($after: String) { comments(after: $after, filter: { issue: { id: { eq: "ENG-2" } } }) { nodes { id } } }'],
  ["query Q($after: String) { organization { users(after: $after) { nodes { id } } } }"],
  ["query Q($after: String) { organization { teams(after: $after) { nodes { id } } } }"],
  ["query Q($after: String) { organization { labels(after: $after) { nodes { id } } } }"],
  ["query Q($after: String) { viewer { teams(after: $after) { nodes { id } } } }"],
  ["query Q($after: String) { viewer { assignedIssues(after: $after) { nodes { id } } } }"],
  ["query Q($after: String) { viewer { createdIssues(after: $after) { nodes { id } } } }"],
  ...["members", "states", "labels", "projects", "cycles", "issues"].map((field) => [`query Q($after: String) { team(id: "ENG") { ${field}(after: $after) { nodes { id } } } }`]),
  ['query Q($after: String) { issue(id: "ENG-2") { state { issues(after: $after) { nodes { id } } } } }'],
  ...["children", "issues"].map((field) => [`query Q($after: String) { issueLabels(first: 1) { nodes { ${field}(after: $after) { nodes { id } } } } }`]),
  ...["teams", "issues", "members"].map((field) => [`query Q($after: String) { projects(first: 1) { nodes { ${field}(after: $after) { nodes { id } } } } }`]),
  ['query Q($after: String) { issue(id: "ENG-2") { cycle { issues(after: $after) { nodes { id } } } } }'],
  ...["children", "labels", "comments"].map((field) => [`query Q($after: String) { issue(id: "ENG-2") { ${field}(after: $after) { nodes { id } } } }`]),
  ['query Q($after: String) { issue(id: "ENG-2") { comments(first: 1) { nodes { children(after: $after) { nodes { id } } } } } }'],
];

async function forgedCursorsGraphql() {
  for (const [query] of GRAPHQL_CONNECTIONS) {
    // The unforged query must succeed, so each failure below is the cursor and nothing else.
    assert.ok((await gql(query, {})) !== null);
    for (const after of FORGED_CURSORS) {
      const result = await gqlError(query, 400, "INVALID_INPUT", "Invalid cursor", { after });
      assert.equal(result.json.errors[0].extensions.type, "invalid input", `${query}: ${JSON.stringify(result.json)}`);
      assert.equal(result.json.errors[0].extensions.userError, true);
    }
  }
  // A literal argument takes the same path as a variable.
  await gqlError('{ issues(after: "9JCAgA") { nodes { id } } }', 400, "INVALID_INPUT", "Invalid cursor");
}

// Caller-named keys that exist on Object.prototype. A filter must treat them as unknown fields (never as inherited members),
// and the GraphQL executor as unknown fields, arguments and types. JSON `__proto__` keys are removed by the framework before
// the handler runs; a GraphQL literal `__proto__` reaches the Tool and is an unknown field.
const INHERITED_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty"];
// An identifier with a well-formed prefix and more digits than any issue number (beyond the 512-character row-id bound).
const LONG_IDENTIFIER = `ENG-${"1".repeat(600)}`;

async function inheritedKeysGraphql() {
  const filters = [["issues", "IssueFilter"], ["projects", "ProjectFilter"], ["users", "UserFilter"], ["teams", "TeamFilter"], ["issueLabels", "IssueLabelFilter"]];
  for (const key of [...INHERITED_KEYS, "__proto__"]) {
    for (const [field, type] of filters) {
      await gqlError(`{ ${field}(filter: { ${key}: { eq: "x" } }) { nodes { id } } }`, 400, "INVALID_INPUT", `Unknown filter field "${key}" on ${type}`);
    }
    await gqlError(`{ issues(filter: { assignee: { ${key}: { eq: "x" } } }) { nodes { id } } }`, 400, "INVALID_INPUT", `Unknown filter field "${key}" on UserFilter`);
    await gqlError(`{ issues(filter: { labels: { ${key}: { eq: "x" } } }) { nodes { id } } }`, 400, "INVALID_INPUT", `Unknown filter field "${key}" on IssueLabelFilter`);
    await gqlError(`{ issues(filter: { title: { ${key}: "x" } }) { nodes { id } } }`, 400, "INVALID_INPUT", `Unknown comparator "${key}" on IssueFilter.title`);
    await gqlError(`{ workflowStates(filter: { team: { id: { eq: "${ENG}" } }, ${key}: { eq: "x" } }) { nodes { id } } }`, 400, "INVALID_INPUT", `Unknown filter field "${key}" on WorkflowStateFilter`);
    await gqlError(`{ comments(filter: { issue: { id: { eq: "ENG-2" } }, ${key}: { eq: "x" } }) { nodes { id } } }`, 400, "INVALID_INPUT", `Unknown filter field "${key}" on CommentFilter`);
  }
  for (const key of INHERITED_KEYS) {
    // The same key through a JSON variable (JSON `__proto__` never reaches the Tool, see above).
    await gqlError("query Q($f: IssueFilter) { issues(filter: $f) { nodes { id } } }", 400, "INVALID_INPUT", `Unknown filter field "${key}" on IssueFilter`, { f: { [key]: { eq: "x" } } });
    await gqlError(`{ ${key} }`, 400, "NOT_IMPLEMENTED", `Field "Query.${key}" is not implemented by this Tool.`);
    await gqlError(`{ viewer { ${key} } }`, 400, "NOT_IMPLEMENTED", `Field "User.${key}" is not implemented by this Tool.`);
    await gqlError(`{ issues(${key}: 1) { nodes { id } } }`, 400, "NOT_IMPLEMENTED", `Unknown argument "${key}" on field "Query.issues".`);
    await gqlError(`{ viewer { ... on ${key} { id } } }`, 400, "GRAPHQL_VALIDATION_FAILED", `Unknown type "${key}".`);
    await gqlError(`query Q($x: ${key}) { issues(filter: $x) { nodes { id } } }`, 400, "GRAPHQL_VALIDATION_FAILED", `Expected type "${key}"`, { x: 5 });
    await gqlError("query Q($after: String) { issues(after: $after) { nodes { id } } }", 400, "GRAPHQL_VALIDATION_FAILED", `Variable "$${key}" is not defined by operation "Q".`, { [key]: "x" });
  }
}

async function longIdentifiersGraphql() {
  const vars = { id: LONG_IDENTIFIER };
  await gqlError("query Q($id: String!) { issue(id: $id) { id } }", 400, "NOT_FOUND", NOT_FOUND_ISSUE, vars);
  await gqlError('mutation M($id: String!) { issueUpdate(id: $id, input: { title: "x" }) { success } }', 400, "NOT_FOUND", NOT_FOUND_ISSUE, vars);
  await gqlError("mutation M($id: String!) { issueArchive(id: $id) { success } }", 400, "NOT_FOUND", NOT_FOUND_ISSUE, vars);
  await gqlError('mutation M($id: String!) { commentCreate(input: { issueId: $id, body: "x" }) { success } }', 400, "NOT_FOUND", NOT_FOUND_ISSUE, vars);
  await gqlError(`mutation M($id: String!) { issueCreate(input: { teamId: "${ENG}", title: "x", parentId: $id }) { success } }`, 400, "NOT_FOUND", NOT_FOUND_ISSUE, vars);
  await gqlError("query Q($id: String!) { comments(filter: { issue: { id: { eq: $id } } }) { nodes { id } } }", 400, "NOT_FOUND", NOT_FOUND_ISSUE, vars);
  // Past the documented 9-digit issue number but within the row-id bound: the same not-found answer.
  await gqlError('{ issue(id: "ENG-1234567890") { id } }', 400, "NOT_FOUND", NOT_FOUND_ISSUE);
  const junk = "a".repeat(600);
  for (const [field, entity] of [["user", "User"], ["team", "Team"], ["project", "Project"]]) {
    await gqlError(`query Q($id: String!) { ${field}(id: $id) { id } }`, 400, "NOT_FOUND", `Entity not found: ${entity}`, { id: junk });
  }
}

async function inheritedKeysCanonical() {
  const calls = [
    ["issues.list", {}, "IssueFilter"],
    ["users.list", {}, "UserFilter"],
    ["teams.list", {}, "TeamFilter"],
    ["projects.list", {}, "ProjectFilter"],
    ["labels.list", {}, "IssueLabelFilter"],
    ["cycles.list", { teamId: ENG }, "CycleFilter"],
    ["comments.list", { issueId: "ENG-2" }, "CommentFilter"],
    ["workflow-states.list", { teamId: ENG }, "WorkflowStateFilter"],
  ];
  for (const key of INHERITED_KEYS) {
    for (const [id, base, type] of calls) await opError(id, { ...base, filter: { [key]: { eq: "x" } } }, "INVALID_INPUT", `Unknown filter field "${key}" on ${type}`);
    await opError("issues.list", { filter: { assignee: { [key]: { eq: "x" } } } }, "INVALID_INPUT", `Unknown filter field "${key}" on UserFilter`);
  }
  await mcpInit();
  await mcpError("list_issues", { filter: { constructor: { eq: "x" } } }, "tool.INVALID_INPUT", 'Unknown filter field "constructor" on IssueFilter');
  await mcpError("list_projects", { filter: { valueOf: { eq: "x" } } }, "tool.INVALID_INPUT", 'Unknown filter field "valueOf" on ProjectFilter');
}

async function forgedCursorsCanonical() {
  const calls = [
    ["users.list", {}, ["after", "cursor"]],
    ["teams.list", {}, ["after", "cursor"]],
    ["workflow-states.list", { teamId: ENG }, ["after"]],
    ["labels.list", {}, ["after", "cursor"]],
    ["projects.list", {}, ["after", "cursor"]],
    ["projects.get", { query: "Spatial Audio Engine" }, ["issuesAfter"]],
    ["cycles.list", { teamId: ENG }, ["after"]],
    ["issues.list", {}, ["after", "cursor"]],
    ["comments.list", { issueId: "ENG-2" }, ["after", "cursor"]],
  ];
  for (const [id, base, names] of calls) {
    await op(id, base);
    for (const name of names) {
      for (const value of FORGED_CURSORS) {
        // The declared input schema requires a non-empty cursor, so "" is refused by the framework before the handler runs.
        if (value === "") {
          const outcome = await operation(id, { ...base, [name]: value }, "invalid");
          assert.equal(outcome.error.code, "framework.INVALID_OPERATION_INPUT", `${id} ${name}: ${JSON.stringify(outcome.error)}`);
        } else await opError(id, { ...base, [name]: value }, "INVALID_INPUT", "Invalid cursor");
      }
    }
  }
}

async function pageThrough(build, read) {
  const collected = [];
  let cursor;
  let pages = 0;
  for (;;) {
    const connection = read(await gql(build(cursor)));
    collected.push(...connection.nodes);
    pages += 1;
    assert.ok(pages <= 50, "runaway pagination");
    if (!connection.pageInfo.hasNextPage) return { nodes: collected, pages };
    cursor = connection.pageInfo.endCursor;
    assert.ok(typeof cursor === "string" && cursor.length > 0, "hasNextPage without endCursor");
  }
}

// ---------------------------------------------------------------------------------------------
// Drill: graphql-flow (admin = Maya, baseline)
// ---------------------------------------------------------------------------------------------

async function graphqlFlow() {
  const viewer = (await gql("{ viewer { id name email admin isMe organization { urlKey } teams { nodes { key } } } }")).viewer;
  assert.equal(viewer.id, MAYA);
  assert.equal(viewer.admin, true);
  assert.equal(viewer.isMe, true);
  assert.equal(viewer.organization.urlKey, "lumenaudio");
  assert.deepEqual(viewer.teams.nodes.map((team) => team.key), ["ENG", "MOB", "SEC"]);
  const organization = (await gql("{ organization { name urlKey userCount teamCount } }")).organization;
  assert.deepEqual(organization, { name: "Lumen Audio", urlKey: "lumenaudio", userCount: 5, teamCount: 3 });

  // Teams: two pages of a three-team connection ordered by createdAt (descending)
  const teamsQuery = "query Teams($first: Int, $after: String) { teams(first: $first, after: $after, orderBy: createdAt) { nodes { id key name private cyclesEnabled issueCount activeCycle { number } } pageInfo { hasNextPage endCursor } } }";
  const page1 = (await gql(teamsQuery, { first: 2 })).teams;
  assert.deepEqual(page1.nodes.map((team) => team.key), ["SEC", "MOB"]);
  assert.equal(page1.pageInfo.hasNextPage, true);
  const page2 = (await gql(teamsQuery, { first: 2, after: page1.pageInfo.endCursor })).teams;
  assert.deepEqual(page2.nodes.map((team) => team.key), ["ENG"]);
  assert.equal(page2.pageInfo.hasNextPage, false);
  assert.equal(page2.nodes[0].activeCycle.number, 2);
  assert.equal(page1.nodes[1].activeCycle, null);
  assert.equal(page1.nodes[0].private, true);

  const eng = (await gql('{ team(id: "ENG") { states { nodes { name type position } } labels { nodes { name } } all: labels(includeArchived: true) { nodes { name archivedAt } } defaultIssueState { name } } }')).team;
  assert.deepEqual(eng.states.nodes.map((state) => state.name), ["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled", "Duplicate"]);
  assert.deepEqual(eng.states.nodes.map((state) => state.position), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(names(eng.labels).sort(), ["backend", "frontend"]);
  assert.deepEqual(names(eng.all).sort(), ["backend", "frontend", "legacy"]);
  assert.equal(eng.all.nodes.find((label) => label.name === "legacy").archivedAt, "2026-08-20T10:00:00.000Z");
  assert.equal(eng.defaultIssueState.name, "Backlog");
  assert.equal((await gql(`{ workflowStates(filter: { team: { id: { eq: "${MOB}" } } }) { nodes { name } } }`)).workflowStates.nodes.length, 5);
  assert.deepEqual(names((await gql("{ issueLabels(filter: { team: { null: true } }) { nodes { name } } }")).issueLabels).sort(), ["Bug", "Feature", "Improvement"]);
  const labelPages = await pageThrough((cursor) => `{ issueLabels(first: 2${cursor === undefined ? "" : `, after: "${cursor}"`}) { nodes { name } pageInfo { hasNextPage endCursor } } }`, (data) => data.issueLabels);
  assert.equal(labelPages.nodes.length, 7);
  assert.equal(labelPages.pages, 4);

  const cycles = (await gql(`{ cycles(filter: { team: { id: { eq: "${ENG}" } } }) { nodes { number isActive isFuture isPast progress } } }`)).cycles;
  assert.deepEqual(cycles.nodes.map((cycle) => cycle.number), [1, 2, 3]);
  assert.deepEqual(cycles.nodes.map((cycle) => cycle.isActive), [false, true, false]);
  assert.equal(cycles.nodes[0].progress, 1);
  assert.equal(cycles.nodes[0].isPast, true);
  assert.equal(cycles.nodes[2].isFuture, true);

  const projects = (await gql("{ projects { nodes { name state status { type } lead { name } teams { nodes { key } } } } }")).projects;
  assert.deepEqual(names(projects), ["Spatial Audio Engine", "Companion App 2.0", "SOC 2 Readiness"]);
  assert.equal(projects.nodes[0].status.type, "started");
  assert.equal(projects.nodes[0].lead.name, "Daniel Okafor");
  assert.deepEqual(projects.nodes[1].teams.nodes.map((team) => team.key), ["MOB", "ENG"]);
  assert.equal((await gql('{ project(id: "3f2a9c1e") { name url } }')).project.name, "Spatial Audio Engine");

  const eng2 = (await gql('{ issue(id: "ENG-2") { identifier title priority priorityLabel state { name type } assignee { displayName } labels { nodes { name } } cycle { number } url branchName comments(first: 2) { nodes { body user { name } parent { id } } pageInfo { hasNextPage endCursor } } children { nodes { identifier } } } }')).issue;
  assert.equal(eng2.priorityLabel, "High");
  assert.equal(eng2.state.type, "started");
  assert.equal(eng2.assignee.displayName, "amelie");
  assert.ok(eng2.url.endsWith("/issue/ENG-2/crackling-on-96-khz-playback"), eng2.url);
  assert.ok(eng2.branchName.startsWith("maya/eng-2-"), eng2.branchName);
  assert.equal(eng2.comments.nodes.length, 2);
  assert.equal(eng2.comments.pageInfo.hasNextPage, true);
  assert.equal(eng2.comments.nodes[0].user.name, "Maya Lindqvist");
  assert.equal(eng2.children.nodes.length, 0);
  const more = (await gql(`{ issue(id: "ENG-2") { comments(first: 10, after: "${eng2.comments.pageInfo.endCursor}") { nodes { body parent { id } } pageInfo { hasNextPage } } } }`)).issue.comments;
  assert.equal(more.nodes.length, 4);
  assert.equal(more.pageInfo.hasNextPage, false);
  assert.equal(more.nodes.filter((comment) => comment.parent !== null).length, 1, "one threaded reply");
  assert.deepEqual(identifiers((await gql(`{ issue(id: "${I(1)}") { children { nodes { identifier } } } }`)).issue.children), ["ENG-4", "ENG-5"]);

  const issuePages = await pageThrough((cursor) => `{ issues(first: 5, orderBy: updatedAt${cursor === undefined ? "" : `, after: "${cursor}"`}) { nodes { identifier updatedAt } pageInfo { hasNextPage endCursor } } }`, (data) => data.issues);
  assert.equal(issuePages.nodes.length, 23);
  assert.equal(issuePages.pages, 5);
  assert.equal(issuePages.nodes[0].identifier, "ENG-14");
  assert.deepEqual(identifiers((await gql("{ issues(includeArchived: true, filter: { archivedAt: { null: false } }) { nodes { identifier } } }")).issues), ["ENG-3"]);
  assert.deepEqual(identifiers((await gql('{ searchIssues(term: "crackling") { nodes { identifier } } }')).searchIssues), ["ENG-2"]);

  const fragments = await gql('fragment IssueCore on Issue { id identifier title } query { a: issue(id: "ENG-1") { ...IssueCore } b: issue(id: "MOB-1") { ...IssueCore ... on Issue { team { key } } __typename } }');
  assert.equal(fragments.a.identifier, "ENG-1");
  assert.equal(fragments.b.team.key, "MOB");
  assert.equal(fragments.b.__typename, "Issue");
  // The same fragment spread twice by siblings (and again inside an inline fragment) is valid GraphQL, not a cycle.
  const siblings = await gql('fragment F on Issue { id identifier } { issue(id: "ENG-1") { ...F ...F } }');
  assert.equal(siblings.issue.identifier, "ENG-1");
  const inline = await gql('{ issue(id: "ENG-1") { ...F ... on Issue { ...F title } } } fragment F on Issue { id identifier }');
  assert.equal(inline.issue.identifier, "ENG-1");
  assert.equal(typeof inline.issue.title, "string");
  const conditional = await gql('query Q($withDesc: Boolean!) { issue(id: "ENG-1") { id description @include(if: $withDesc) title @skip(if: $withDesc) } }', { withDesc: false });
  assert.deepEqual(Object.keys(conditional.issue), ["id", "title"]);
  const typed = (await gql('{ issues(first: 1) { __typename nodes { __typename identifier } } }')).issues;
  assert.equal(typed.__typename, "IssueConnection");
  assert.equal(typed.nodes[0].__typename, "Issue");

  // Mutations
  const created = (await gql("mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success lastSyncId issue { id identifier number state { name } creator { id } createdAt } } }", {
    input: { teamId: ENG, title: "Denoise preset ships with wrong gain", description: "Reported by beta cohort", priority: 2, assigneeId: DANIEL, labelIds: [L(1), L(4)], cycleId: C(2), projectId: P(1) },
  })).issueCreate;
  assert.equal(created.success, true);
  assert.equal(created.lastSyncId, 4201);
  assert.equal(created.issue.identifier, "ENG-15");
  assert.equal(created.issue.state.name, "Backlog");
  assert.equal(created.issue.creator.id, MAYA);
  assert.equal(created.issue.createdAt, NOW);
  const eng15 = created.issue.id;
  await gqlError('mutation { issueCreate(input: { team: "ENG", title: "x" }) { success } }', 400, "INVALID_INPUT", 'Unknown field "team"');
  const updated = (await gql(`mutation { issueUpdate(id: "ENG-15", input: { stateId: "${S(3)}", addedLabelIds: ["${L(5)}"], removedLabelIds: ["${L(4)}"], dueDate: "2026-09-30", assigneeId: null }) { lastSyncId issue { startedAt assignee { id } labels { nodes { name } } dueDate } } }`)).issueUpdate;
  assert.equal(updated.lastSyncId, 4202);
  assert.equal(updated.issue.startedAt, NOW);
  assert.equal(updated.issue.assignee, null);
  assert.deepEqual(names(updated.issue.labels).sort(), ["Bug", "frontend"]);
  await gqlError('mutation { issueUpdate(id: "ENG-15", input: { parentId: "ENG-15" }) { success } }', 400, "INVALID_INPUT", "its own parent");
  await gqlError(`mutation { issueUpdate(id: "ENG-15", input: { labelIds: ["${L(6)}"] }) { success } }`, 400, "INVALID_INPUT", "archived");
  await gqlError(`mutation { issueUpdate(id: "ENG-15", input: { cycleId: "${C(1)}", stateId: "${S(10)}" }) { success } }`, 400, "INVALID_INPUT", "does not belong to team ENG");
  await gqlError(`mutation { issueUpdate(id: "ENG-15", input: { teamId: "${MOB}" }) { success } }`, 400, "INVALID_INPUT", "team is not supported");
  const comment = (await gql('mutation { commentCreate(input: { issueId: "ENG-15", body: "Repro attached" }) { lastSyncId comment { id body url user { id } } } }')).commentCreate;
  assert.equal(comment.lastSyncId, 4203);
  assert.equal(comment.comment.user.id, MAYA);
  const reply = (await gql(`mutation { commentCreate(input: { issueId: "ENG-15", body: "reply", parentId: "${comment.comment.id}" }) { comment { id parent { id } } } }`)).commentCreate.comment;
  assert.equal(reply.parent.id, comment.comment.id);
  await gqlError(`mutation { commentCreate(input: { issueId: "ENG-15", body: "nested", parentId: "${reply.id}" }) { success } }`, 400, "INVALID_INPUT", "Replies cannot be nested");
  const edited = (await gql(`mutation { commentUpdate(id: "${comment.comment.id}", input: { body: "Repro attached (v2)" }) { lastSyncId comment { body editedAt } } }`)).commentUpdate;
  assert.equal(edited.comment.editedAt, NOW);
  assert.equal(edited.lastSyncId, 4205);
  const project = (await gql(`mutation { projectCreate(input: { name: "Firmware 3.0", teamIds: ["${ENG}", "${MOB}"], leadId: "${DANIEL}", state: "planned", targetDate: "2026-11-30" }) { lastSyncId project { id slugId url startedAt status { name } teams { nodes { key } } } } }`)).projectCreate;
  assert.equal(project.lastSyncId, 4206);
  assert.equal(project.project.startedAt, null);
  assert.equal(project.project.status.name, "Planned");
  assert.ok(project.project.url.endsWith(`/project/firmware-3-0-${project.project.slugId}`), project.project.url);
  const started = (await gql(`mutation { projectUpdate(id: "${project.project.id}", input: { state: "started" }) { project { startedAt state } } }`)).projectUpdate.project;
  assert.equal(started.startedAt, NOW);
  await gqlError(`mutation { projectUpdate(id: "${project.project.id}", input: { teamIds: [] }) { success } }`, 400, "INVALID_INPUT", "at least one team");
  const label = (await gql(`mutation { issueLabelCreate(input: { name: "regression", color: "#f2994a", teamId: "${ENG}" }) { lastSyncId issueLabel { name team { key } } } }`)).issueLabelCreate;
  assert.equal(label.issueLabel.team.key, "ENG");
  await gqlError('mutation { issueLabelCreate(input: { name: "bug" }) { success } }', 400, "INVALID_INPUT", "already exists");
  assert.equal((await gql('mutation { issueLabelCreate(input: { name: "Ops" }) { issueLabel { team { key } } } }')).issueLabelCreate.issueLabel.team, null);
  const archived = (await gql('mutation { issueArchive(id: "ENG-15") { success lastSyncId entity { archivedAt } } }')).issueArchive;
  assert.equal(archived.entity.archivedAt, NOW);
  assert.equal(archived.lastSyncId, 4210);
  await gqlError('mutation { issueArchive(id: "ENG-15") { success } }', 400, "INVALID_INPUT", "already archived");
  await gqlError('mutation { issueUpdate(id: "ENG-15", input: { title: "x" }) { success } }', 400, "INVALID_INPUT", "archived issue");
  assert.equal((await gql(`{ issues(filter: { id: { eq: "${eng15}" } }) { nodes { id } } }`)).issues.nodes.length, 0);
  assert.equal((await gql(`{ issues(includeArchived: true, filter: { id: { eq: "${eng15}" } }) { nodes { id } } }`)).issues.nodes.length, 1);
  const batched = await gql('mutation { a: commentCreate(input: { issueId: "ENG-2", body: "first" }) { lastSyncId } b: commentCreate(input: { issueId: "ENG-2", body: "second" }) { lastSyncId } }');
  assert.equal(batched.a.lastSyncId, 4211);
  assert.equal(batched.b.lastSyncId, 4212);
  await gqlError('mutation { a: commentCreate(input: { issueId: "ENG-2", body: "x" }) { comment { id } } b: commentCreate(input: { issueId: "ENG-999", body: "y" }) { comment { id } } }', 400, "NOT_FOUND", NOT_FOUND_ISSUE);
  assert.equal((await gql('{ issue(id: "ENG-2") { comments(first: 50) { nodes { id } } } }')).issue.comments.nodes.length, 8, "the mixed document wrote nothing");

  // Framework-owned edges around the route
  const get = await fetch(`${HTTP}/graphql`, { headers: { authorization: HTTP_TOKEN } });
  assert.equal(get.status, 405, "GET /graphql");
  const oauth = await fetch(`${HTTP}/oauth/token`, { method: "POST", headers: { authorization: HTTP_TOKEN } });
  assert.equal(oauth.status, 404, "POST /oauth/token has no route");
  const bearer = await fetch(`${HTTP}/graphql`, { method: "POST", headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ query: "{ viewer { id } }" }) });
  assert.equal(bearer.status, 401, "Bearer scheme is rejected by the framework header-auth kind");
  const form = await fetch(`${HTTP}/graphql`, { method: "POST", headers: { authorization: HTTP_TOKEN, "content-type": "application/x-www-form-urlencoded" }, body: "query=x" });
  assert.equal(form.status, 415, "form bodies are not accepted");
}

// ---------------------------------------------------------------------------------------------
// Drill: graphql-errors (admin, baseline)
// ---------------------------------------------------------------------------------------------

// Caller text echoed into error messages (ids, input keys, field, argument, fragment, type, directive and variable names, filter
// keys, syntax tokens, variable values, input keys in paths) is clipped, so a declared error never exceeds the framework's
// 4000-character message cap. Before the clip, a 3977-character teamId turned INVALID_INPUT into HTTP 500
// framework.HTTP_RESPONSE_MAPPING_FAILED on POST /graphql and a zod too_big 400 on canonical graphql.execute.
async function longTokensGraphql() {
  const LONG = "a".repeat(5000);
  const NAME = `a${"b".repeat(4999)}`;
  const bounded = (result, code) => {
    const entry = result.json.errors[0];
    assert.ok(entry.message.length <= 4000 && entry.extensions.userPresentableMessage.length <= 4000, `unbounded message: ${entry.message.length}`);
    assert.ok(entry.message.includes("\u2026"), "a clipped echo is marked with an ellipsis");
    for (const segment of entry.path ?? []) assert.ok(typeof segment === "number" || segment.length <= 200, "path segments are clipped");
    if (code !== undefined) assert.equal(entry.extensions.code, code);
  };
  const II = "INVALID_INPUT";
  const V = "GRAPHQL_VALIDATION_FAILED";
  const NI = "NOT_IMPLEMENTED";
  const probes = [
    [`mutation { issueCreate(input: { teamId: "${"x".repeat(3977)}", title: "x" }) { success } }`, II, "is not a UUID"],
    [`mutation { issueCreate(input: { teamId: "${LONG}", title: "x" }) { success } }`, II, "is not a UUID"],
    [`mutation { issueCreate(input: { teamId: "${ENG}", title: "x", ${NAME}: 1 }) { success } }`, II, "on IssueCreateInput"],
    [`mutation { issueUpdate(id: "ENG-2", input: { ${NAME}: 1 }) { success } }`, II, "on IssueUpdateInput"],
    [`mutation { issueLabelCreate(input: { name: "zz", color: "#eb5757", teamId: "${LONG}" }) { success } }`, II, "is not a UUID"],
    [`mutation { issueLabelCreate(input: { name: "zz", color: "#eb5757", parentId: "${LONG}" }) { success } }`, II, "is not a UUID"],
    [`mutation { issueLabelCreate(input: { name: "zz", ${NAME}: 1 }) { success } }`, II, "on IssueLabelCreateInput"],
    [`mutation { projectCreate(input: { name: "zz", teamIds: ["${LONG}"] }) { success } }`, II, "is not a UUID"],
    [`mutation { projectCreate(input: { name: "zz", teamIds: ["${ENG}"], state: "${LONG}" }) { success } }`, II, "Unknown project state"],
    [`mutation { projectCreate(input: { name: "zz", ${NAME}: 1 }) { success } }`, II, "on ProjectCreateInput"],
    [`mutation { commentCreate(input: { issueId: "ENG-2", body: "x", ${NAME}: 1 }) { success } }`, II, "on CommentCreateInput"],
    [`{ viewer { ${NAME} } }`, NI, 'Field "User.'],
    [`{ ${NAME} { id } }`, NI, 'Field "Query.'],
    [`{ issues(${NAME}: 1) { nodes { id } } }`, NI, "Unknown argument"],
    [`{ viewer { ...${NAME} } }`, V, "Unknown fragment"],
    [`{ viewer { ... on ${NAME} { id } } }`, V, "Unknown type"],
    [`{ viewer { id @${NAME} } }`, V, "Unknown directive"],
    [`{ issue(id: $${NAME}) { id } }`, V, "Variable"],
    [`query Q($${NAME}: String) { viewer { id } }`, V, "is never used"],
    [`{ issues(first: "${LONG}") { nodes { id } } }`, V, "has invalid value"],
    [`{ viewer { id } } ${NAME}`, V, "Syntax Error: Unexpected Name"],
    [`{ viewer("${LONG}") }`, V, "Syntax Error"],
    [`{ issues(filter: { ${NAME}: { eq: "1" } }) { nodes { id } } }`, II, "Unknown filter field"],
    [`{ issues(filter: { title: { ${NAME}: "1" } }) { nodes { id } } }`, II, "Unknown comparator"],
    [`{ cycles(filter: { team: { ${NAME}: { eq: "x" } } }) { nodes { id } } }`, II, "is supported on this filter"],
  ];
  for (const [query, code, text] of probes) bounded(await gqlError(query, 400, code, text), code);
  bounded(await gqlError("query Q($id: String!) { issue(id: $id) { id } }", 400, V, "got invalid value", { id: [LONG] }), V);
  // A 5,000-character alias: the error path names the input field, not the alias, and every string segment stays within the bound.
  const aliased = await gqlError(`mutation { ${NAME}: issueCreate(input: { teamId: "bad", title: "x" }) { success } }`, 400, II, 'Team id "bad" is not a UUID');
  for (const segment of aliased.json.errors[0].path ?? []) assert.ok(typeof segment === "number" || segment.length <= 200);
  // The canonical endpoint answers the same declared errors instead of a framework validation failure.
  for (const [query, code] of [[`mutation { issueCreate(input: { teamId: "${LONG}", title: "x" }) { success } }`, II], [`{ viewer { ${NAME} } }`, NI]]) {
    const outcome = await opError("graphql.execute", { query }, code);
    assert.ok(outcome.error.message.length <= 4000, "canonical message is bounded");
  }
}

/** Filter chain of `levels` relation/collection hops: children.some (1), parent (1), alternating. */
function relationChain(levels, leaf) {
  let inner = leaf;
  for (let level = levels; level >= 1; level -= 1) inner = level % 2 === 1 ? { children: { some: inner } } : { parent: inner };
  return inner;
}

/** Parse-time nesting bounds, filter bounds, date validation and the response byte budget over POST /graphql (and canonical graphql.execute). */
async function nestingBoundsGraphql() {
  const V = "GRAPHQL_VALIDATION_FAILED";
  const nest = (open, inner, close, n) => `${open.repeat(n)}${inner}${close.repeat(n)}`;
  // List and object literals: 64 levels parse (and then fail argument validation), 65 and 5,000 are a syntax error, never a stack overflow.
  await gqlError(`{ issues(filter: ${nest("[", "1", "]", 64)}) { nodes { id } } }`, 400, V, 'Argument "filter" has invalid value');
  for (const n of [65, 5000]) {
    await gqlError(`{ issues(filter: ${nest("[", "1", "]", n)}) { nodes { id } } }`, 400, V, "List and object values nest deeper than the maximum depth of 64.");
    await gqlError(`{ issues(filter: ${nest("{ a: ", "1", " }", n)}) { nodes { id } } }`, 400, V, "List and object values nest deeper than the maximum depth of 64.");
    await gqlError(`query Q($f: IssueFilter = ${nest("[", "1", "]", n)}) { issues(filter: $f) { nodes { id } } }`, 400, V, "maximum depth of 64.");
  }
  // List type references: 32 wrappers parse, 33 and 5,000 do not.
  await gqlError(`query Q($f: ${nest("[", "Int", "]", 32)}) { viewer { id } }`, 400, V, 'Variable "$f" is never used');
  for (const n of [33, 5000]) await gqlError(`query Q($f: ${nest("[", "Int", "]", n)}) { viewer { id } }`, 400, V, "Type reference nesting exceeds the maximum depth of 32.");
  // Selection sets: inline fragments nest up to the 32-set parse limit; field selection sets stop at query depth 8 while parsing.
  assert.equal((await gql(`{ viewer { ${nest("... on User { ", "id", " }", 30)} } }`)).viewer.id, MAYA);
  for (const n of [31, 2000]) await gqlError(`{ viewer { ${nest("... on User { ", "id", " }", n)} } }`, 400, V, "Selection set nesting exceeds the maximum depth of 32.");
  await gqlError(`{ ${nest("viewer { ", "id", " }", 3000)} }`, 400, V, "Query depth 9 exceeds the maximum of 8.");
  const spreads = (n) => `{ viewer { ...F0 } } ${Array.from({ length: n }, (_, i) => `fragment F${i} on User { id ${i + 1 < n ? `...F${i + 1}` : ""} }`).join(" ")}`;
  assert.equal((await gql(spreads(32))).viewer.id, MAYA);
  await gqlError(spreads(33), 400, V, "Fragment spreads and inline fragments nest deeper than the maximum depth of 32.");
  // Repeated spreads: a fragment already applied to a selection set adds nothing and merged fields hold each selection set
  // once, so a 2- or 3-way spread at each of 32 levels (2^32 merged selections before) answers at once with the same data.
  const doubling = (n, k) => `{ ...F0 } ${Array.from({ length: n }, (_, i) => `fragment F${i} on Query { viewer { id } ${i + 1 < n ? `...F${i + 1} `.repeat(k) : ""}}`).join(" ")}`;
  for (const [n, k] of [[26, 2], [28, 2], [32, 2], [32, 3]]) assert.equal((await gql(doubling(n, k))).viewer.id, MAYA, `doubling x${n}/${k}`);
  await gqlError(doubling(33, 2), 400, V, "Fragment spreads and inline fragments nest deeper than the maximum depth of 32.");
  const throughInline = (n) => `{ ...F0 } ${Array.from({ length: n }, (_, i) => `fragment F${i} on Query { viewer { id } ${i + 1 < n ? `... on Query { ...F${i + 1} } ... on Query { ...F${i + 1} }` : ""} }`).join(" ")}`;
  assert.equal((await gql(throughInline(16))).viewer.id, MAYA);
  await gqlError(throughInline(17), 400, V, "maximum depth of 32.");
  assert.equal((await op("graphql.execute", { query: doubling(32, 2) })).data.viewer.id, MAYA, "canonical doubling x32");
  await opError("graphql.execute", { query: doubling(33, 2) }, V, "maximum depth of 32.");
  // Aliases: the same field with the same arguments merges; different (also nested) arguments are a conflict.
  const merged = await gql('{ a: issue(id: "ENG-1") { id } a: issue(id: "ENG-1") { identifier team { key } } a: issue(id: "ENG-1") { team { name } } }');
  assert.equal(merged.a.identifier, "ENG-1");
  assert.equal(merged.a.team.key, "ENG");
  assert.equal(typeof merged.a.team.name, "string");
  await gqlError('{ a: issue(id: "ENG-1") { id } a: issue(id: "MOB-1") { id } }', 400, V, 'Fields "a" conflict because they have differing arguments or names.');
  await gqlError('{ a: issues(filter: { title: { eq: "x" } }) { nodes { id } } a: issues(filter: { id: { eq: "x" } }) { nodes { id } } }', 400, V, 'Fields "a" conflict');
  await gqlError('{ a: viewer { id } a: viewer }', 400, V, 'Fields "a" conflict because they have differing selections.');
  // One variable used at positions of different filter types is validated for each type, in either order.
  for (const order of ["title: $c, createdAt: $c", "createdAt: $c, title: $c"]) {
    await gqlError(`query Q($c: StringComparator) { issues(filter: { ${order} }) { nodes { id } } }`, 400, "INVALID_INPUT", 'Unknown comparator "contains" on IssueFilter.createdAt', { c: { contains: "a" } });
  }
  for (const order of ["team: $f, assignee: $f", "assignee: $f, team: $f"]) {
    await gqlError(`query Q($f: TeamFilter) { issues(filter: { ${order} }) { nodes { id } } }`, 400, "INVALID_INPUT", 'Unknown filter field "key" on UserFilter', { f: { key: { eq: "ENG" } } });
  }
  const deepJson = (n) => JSON.parse(`${'{"a":'.repeat(n)}1${"}".repeat(n)}`);
  await gqlError("query Q($f: IssueFilter) { issues(filter: $f) { nodes { id } } }", 400, V, "nests lists and objects deeper than the maximum depth of 64.", { f: deepJson(65) });
  // JSON body nesting on the route: past 512 levels the codec answers INVALID_INPUT before any recursive argument validation
  // (3,000 levels used to overflow the stack there and answer an opaque framework 500); 511 levels still reach the schema.
  for (const [n, fragment] of [[511, "arguments do not match"], [512, "deeper than the maximum depth of 512"], [3000, "deeper than the maximum depth of 512"]]) {
    const deep = await graphqlRaw(undefined, { status: 400, rawBody: `{"query":"{ viewer { id } }","zzz":${"[".repeat(n)}1${"]".repeat(n)}}` });
    assert.equal(deep.json.errors[0].extensions.code, "INVALID_INPUT", `nested body x${n}: ${JSON.stringify(deep.json)}`);
    assert.ok(String(deep.json.errors[0].message).includes(fragment), `nested body x${n}: ${JSON.stringify(deep.json)}`);
  }
  // Filter depth and size: 16 nested relation/collection levels evaluate, 17 and 22 are INVALID_INPUT before any row is read.
  const byId = (levels, leaf) => ({ id: { eq: I(1) }, ...relationChain(levels, leaf) });
  const filterQuery = "query Q($f: IssueFilter) { issues(filter: $f) { nodes { identifier } } }";
  assert.deepEqual((await gql(filterQuery, { f: byId(16, { title: { eq: "__no_such_title__" } }) })).issues.nodes, []);
  assert.deepEqual((await gql(filterQuery, { f: { id: { eq: I(1) }, children: { some: { parent: { title: { contains: "calibration" } } } } } })).issues.nodes.map((row) => row.identifier), ["ENG-1"]);
  for (const levels of [17, 22]) await gqlError(filterQuery, 400, "INVALID_INPUT", "Filter nesting depth exceeds the maximum of 16", { f: byId(levels, { title: { eq: "x" } }) });
  await gqlError(filterQuery, 400, "INVALID_INPUT", "Filter has more than 2000 nodes", { f: { or: Array.from({ length: 700 }, (_, i) => ({ title: { eq: `t${i}` } })) } });
  // Dates: impossible calendar dates, empty durations and fractional years are INVALID_INPUT, including inside in/nin.
  for (const value of ["2026-02-30", "P", "PT"]) await gqlError(`{ issues(filter: { createdAt: { gt: "${value}" } }) { nodes { id } } }`, 400, "INVALID_INPUT", "Invalid date-time value on IssueFilter.createdAt");
  await gqlError('{ issues(filter: { createdAt: { in: ["P1.5Y"] } }) { nodes { id } } }', 400, "INVALID_INPUT", "Invalid date-time value on IssueFilter.createdAt");
  await gqlError('{ issues(filter: { updatedAt: { nin: ["2026-09-01", "2026-13-01"] } }) { nodes { id } } }', 400, "INVALID_INPUT", "Invalid date-time value on IssueFilter.updatedAt");
  // A body failing the input schema still carries a complete Linear entry with extensions.code.
  const schemaInvalid = await graphqlRaw({ query: 5 }, { status: 400 });
  assert.equal(schemaInvalid.json.errors[0].extensions.code, "INVALID_INPUT");
  // Connection edges carry the cursor page() encoded for each row (regression: `edges` once crashed with TOOL_HANDLER_CRASH).
  const edged = (await gql("{ issues(first: 3) { nodes { id } edges { cursor node { id } } pageInfo { endCursor } } }")).issues;
  assert.deepEqual(edged.edges.map((edge) => edge.node.id), edged.nodes.map((node) => node.id));
  assert.equal(edged.edges[2].cursor, edged.pageInfo.endCursor);
  const afterEdge = (await gql("query Q($a: String) { issues(first: 1, after: $a) { nodes { id } } }", { a: edged.edges[0].cursor })).issues;
  assert.equal(afterEdge.nodes[0].id, edged.nodes[1].id, "an edge cursor continues the list");
  // Response budget: a result whose encoded data would pass 900,000 bytes is the declared error, never a 1 MiB framework 500.
  const aliases = Array.from({ length: 100 }, (_, i) => `a${i}: issues(first: 250) { nodes { ...Big } edges { cursor node { ...Big } } }`).join(" ");
  await gqlError(`query Huge { ${aliases} } fragment Big on Issue { id identifier title description url branchName createdAt updatedAt }`, 400, V, "Query result is too large");
  // Canonical graphql.execute answers the same declared errors.
  await opError("graphql.execute", { query: `{ issues(filter: ${nest("[", "1", "]", 5000)}) { nodes { id } } }` }, V, "maximum depth of 64.");
  await opError("graphql.execute", { query: `query Q($f: ${nest("[", "Int", "]", 5000)}) { viewer { id } }` }, V, "maximum depth of 32.");
}

async function graphqlErrors() {
  const V = "GRAPHQL_VALIDATION_FAILED";
  await gqlError("{ viewer { id }", 400, V, "Syntax Error: Expected Name, found <EOF>.");
  await gqlError("query A { viewer { id } } query B { viewer { id } }", 400, V, "Must provide operation name if query contains multiple operations.");
  await gqlError("query A { viewer { id } } query B { viewer { id } }", 400, V, 'Unknown operation named "C".', undefined, "C");
  await gqlError("{ viewer { id } } { organization { id } }", 400, V, "anonymous operation");
  await gqlError("query ($id: String!) { issue(id: $id) { id } }", 400, V, 'Variable "$id" of required type "String!" was not provided.');
  await gqlError("query ($id: String!) { issue(id: $id) { id } }", 400, V, "String cannot represent", { id: 5 });
  await gqlError('{ issue(id: "ENG-1") { ...Missing } }', 400, V, 'Unknown fragment "Missing".');
  await gqlError("{ issue { id } }", 400, V, 'argument "id" of type "String!" is required');
  await gqlError('{ issue(id: "ENG-1") { slaBreachesAt } }', 400, "NOT_IMPLEMENTED", 'Field "Issue.slaBreachesAt" is not implemented by this Tool.');
  await gqlError("{ projectMilestones { nodes { id } } }", 400, "NOT_IMPLEMENTED", 'Field "Query.projectMilestones" is not implemented');
  await gqlError("{ __schema { types { name } } }", 400, "NOT_IMPLEMENTED", "Introspection");
  await gqlError("subscription { issueUpdated { id } }", 400, V, "Subscriptions are not supported.");
  await gqlError('{ issue(id: "ENG-1") { comments(filter: { body: { eq: "x" } }) { nodes { id } } } }', 400, "NOT_IMPLEMENTED", 'Unknown argument "filter"');
  await gqlError('{ issues(filter: { fixVersion: { eq: "1" } }) { nodes { id } } }', 400, "INVALID_INPUT", 'Unknown filter field "fixVersion" on IssueFilter');
  await gqlError("{ issues(first: 251) { nodes { id } } }", 400, "INVALID_INPUT", "between 1 and 250");
  await gqlError('{ issues(after: "not-a-cursor") { nodes { id } } }', 400, "INVALID_INPUT", "Invalid cursor");
  await gqlError('{ issue(id: "ENG-1") { team { issues { nodes { team { issues { nodes { team { issues { nodes { id } } } } } } } } } } }', 400, V, "depth 9 exceeds the maximum of 8");
  await gqlError('{ issue(id: "ENG-999") { id } }', 400, "NOT_FOUND", NOT_FOUND_ISSUE).then((result) => assert.equal(result.json.errors[0].extensions.type, "invalid input"));
  assert.equal((await gql('{ issue(id: "SEC-1") { identifier } }')).issue.identifier, "SEC-1", "Maya is a SEC member");
  await gqlError('{ user(id: "nobody@lumenaudio.example.com") { id } }', 400, "NOT_FOUND", "Entity not found: User");
  await gqlError('{ user(id: "D") { id } }', 400, "NOT_FOUND");
  await gqlError('{ viewer { id } } fragment F on Issue { id }', 400, V, 'Fragment "F" is never used.');
  await gqlError('{ issue(id: "ENG-1") { ...A } } fragment A on Issue { ...B } fragment B on Issue { ...A }', 400, V, 'Cannot spread fragment "A" within itself.');
  await gqlError('{ viewer { id @foo } }', 400, V, 'Unknown directive "@foo".');
  await gqlError('query Q($x: String) { viewer { id } }', 400, V, 'Variable "$x" is never used in operation "Q".', { x: "1" });
  await gqlError('{ viewer }', 400, V, "must have a selection of subfields");
  await gqlError('{ viewer { id { x } } }', 400, V, "must not have a selection");
  await gqlError('{ issue(id: "ENG-1") { ... on Team { id } } }', 400, V, "can never be of type");
  const array = await graphqlRaw(undefined, { status: 400, rawBody: "[1]" });
  assert.equal(array.json.errors[0].extensions.type, "invalid input");
  const missing = await graphqlRaw({ variables: {} }, { status: 400 });
  assert.equal(missing.json.errors[0].extensions.type, "invalid input");
  await graphqlRaw({ query: `{ viewer { id } } ${"#".repeat(70_000)}` }, { status: 400 });
  await forgedCursorsGraphql();
  await inheritedKeysGraphql();
  await longIdentifiersGraphql();
  await longTokensGraphql();
  await nestingBoundsGraphql();
  assert.equal((await gql("{ viewer { id } }")).viewer.id, MAYA);
}

// ---------------------------------------------------------------------------------------------
// Drill: mcp-aliases (admin, baseline)
// ---------------------------------------------------------------------------------------------

async function mcpAliases() {
  await mcpInit();
  const listed = (await rpc("tools/list", {})).tools.map((tool) => tool.name);
  for (const alias of ALIASES) assert.ok(listed.includes(alias), `missing alias ${alias}`);
  for (const id of ALL_OPERATIONS) assert.ok(listed.includes(`linear.${id}`), `missing canonical linear.${id}`);

  assert.equal((await mcp("get_workspace", {})).urlKey, "lumenaudio");
  assert.equal((await mcp("get_user", { query: "me" })).id, MAYA);
  assert.equal((await mcp("get_user", { query: "daniel.okafor@lumenaudio.example.com" })).id, DANIEL);
  assert.equal((await mcp("get_user", { query: "Amélie Dubois" })).id, U(6));
  await mcpError("get_user", { query: "nobody" }, "tool.NOT_FOUND");
  const usersPage = await mcp("list_users", { query: "a", limit: 2 });
  assert.equal(usersPage.nodes.length, 2);
  assert.equal(usersPage.pageInfo.hasNextPage, true);
  const usersPage2 = await mcp("list_users", { query: "a", limit: 2, cursor: usersPage.pageInfo.endCursor });
  assert.equal(usersPage2.nodes.length, 2);
  assert.equal((await mcp("list_users", { team: "MOB" })).nodes.length, 3);
  assert.equal((await mcp("list_users", { includeDisabled: true })).nodes.length, 6);
  await mcpError("list_users", { team: "NOPE" }, "tool.NOT_FOUND");
  assert.equal((await mcp("list_teams", {})).nodes.length, 3);
  assert.equal((await mcp("list_teams", { query: "eng" })).nodes.length, 1);
  assert.equal((await mcp("list_teams", { createdAt: "-P1D" })).nodes.length, 0);
  assert.equal((await mcp("get_team", { query: "ENG" })).key, "ENG");
  assert.equal((await mcp("get_team", { query: "Engineering" })).key, "ENG");
  assert.equal((await mcp("get_team", { query: "SEC" })).private, true);
  assert.equal((await mcp("list_issue_statuses", { team: "MOB" })).nodes.length, 5);
  assert.equal((await mcp("list_issue_labels", {})).nodes.length, 7);
  assert.equal((await mcp("list_issue_labels", { team: "ENG" })).nodes.length, 5);
  assert.equal((await mcp("list_issue_labels", { includeArchived: true, team: "ENG" })).nodes.length, 6);
  await mcpError("list_issue_labels", { includeGroups: true }, "tool.INVALID_INPUT");
  const needsRepro = await mcp("create_issue_label", { name: "needs-repro", color: "#f2c94c", teamId: MOB });
  assert.equal(needsRepro.issueLabel.team.key, "MOB");
  assert.equal((await mcp("list_projects", {})).nodes.length, 3);
  assert.equal((await mcp("list_projects", { team: "MOB" })).nodes.length, 1);
  assert.equal((await mcp("list_projects", { state: "started" })).nodes.length, 2);
  assert.equal((await mcp("list_projects", { member: "me" })).nodes.length, 3);
  await mcpError("list_projects", { label: "x" }, "tool.INVALID_INPUT");
  assert.equal((await mcp("get_project", { query: "Spatial Audio Engine" })).slugId, "3f2a9c1e");
  await mcpError("get_project", { query: "3f2a9c1e", includeResources: true }, "tool.INVALID_INPUT");
  const kiosk = (await mcp("save_project", { name: "Retail Demo Kiosk", addTeams: ["MOB"], lead: "me", state: "planned" })).project;
  assert.equal(kiosk.lead.id, MAYA);
  await mcpError("save_project", { id: kiosk.id, state: "started", removeTeams: ["MOB"] }, "tool.INVALID_INPUT", "at least one team");
  assert.equal((await mcp("save_project", { id: kiosk.id, summary: "short" })).project.id, kiosk.id);
  assert.equal((await mcp("list_cycles", { teamId: "ENG" })).nodes.length, 3);
  assert.deepEqual((await mcp("list_cycles", { teamId: "ENG", type: "current" })).nodes.map((cycle) => cycle.number), [2]);
  assert.equal((await mcp("list_cycles", { teamId: "MOB" })).nodes.length, 0);

  const list = async (args) => identifiers(await mcp("list_issues", args));
  assert.deepEqual(await list({ assignee: "me" }), ["ENG-12", "ENG-13", "SEC-3"]);
  assert.deepEqual(await list({ assignee: "null", team: "ENG" }), ["ENG-10", "ENG-5"]);
  assert.deepEqual(await list({ state: "started", team: "ENG" }), ["ENG-12", "ENG-2", "ENG-6"]);
  assert.deepEqual(await list({ state: "In Progress", team: "MOB" }), ["MOB-1"]);
  assert.equal((await list({ label: "Bug" })).length, 7);
  assert.deepEqual((await list({ priority: 1 })).sort(), ["ENG-1", "ENG-12", "MOB-2", "SEC-2"]);
  assert.deepEqual(await list({ project: "Companion App 2.0" }), ["MOB-1", "ENG-9"]);
  assert.equal((await list({ cycle: "2", team: "ENG" })).length, 4);
  assert.deepEqual(await list({ parentId: "ENG-1" }), ["ENG-4", "ENG-5"]);
  assert.deepEqual(await list({ query: "clipping" }), ["ENG-14"]);
  assert.deepEqual(await list({ createdAt: "-P2D" }), ["ENG-12"]);
  assert.equal((await list({ includeArchived: true, team: "ENG" })).length, 14);
  const paged = [];
  let cursor;
  for (let pages = 0; pages < 10; pages += 1) {
    const connection = await mcp("list_issues", { limit: 5, orderBy: "createdAt", ...(cursor === undefined ? {} : { cursor }) });
    paged.push(...identifiers(connection));
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }
  assert.equal(paged.length, 23);
  assert.equal(paged[0], "ENG-12");
  const partial = await mcp("list_issues", { fields: ["title", "status", "assignee"], limit: 1 });
  assert.deepEqual(Object.keys(partial.nodes[0]).sort(), ["assignee", "id", "state", "title"]);
  await mcpError("list_issues", { fields: ["triageIntel"] }, "tool.INVALID_INPUT", "triageIntel");
  await mcpError("list_issues", { delegate: "Linear" }, "tool.INVALID_INPUT", "delegate");
  const eng2 = await mcp("get_issue", { id: "ENG-2" });
  assert.equal(eng2.comments.nodes.length, 6);
  assert.equal(eng2.children.nodes.length, 0);
  assert.ok(eng2.branchName.startsWith("maya/eng-2-"));
  assert.equal((await mcp("get_issue", { id: I(2) })).identifier, "ENG-2");
  await mcpError("get_issue", { id: "P-ENG-1" }, "tool.NOT_FOUND");
  await mcpError("get_issue", { id: "ENG-2", includeRelations: true }, "tool.INVALID_INPUT");

  const saved = (await mcp("save_issue", { team: "MOB", title: "Widget resize glitch", assignee: "Kenji Watanabe", priority: 3, labels: ["Bug", "android"], project: "Companion App 2.0" })).issue;
  assert.equal(saved.identifier, "MOB-7");
  assert.equal(saved.assignee.id, KENJI);
  assert.deepEqual(names(saved.labels).sort(), ["Bug", "android"]);
  const moved = (await mcp("save_issue", { id: "MOB-7", state: "In Progress", addLabels: ["ios"], dueDate: "2026-10-01" })).issue;
  assert.equal(moved.state.name, "In Progress");
  assert.deepEqual(names(moved.labels).sort(), ["Bug", "android", "ios"]);
  assert.equal(moved.dueDate, "2026-10-01");
  await mcpError("save_issue", { id: "MOB-7", labels: ["Bug"], addLabels: ["ios"] }, "tool.INVALID_INPUT", "Cannot combine");
  await mcpError("save_issue", { id: "MOB-7", removeLabels: ["backend"] }, "tool.INVALID_INPUT", "does not belong to team MOB");
  await mcpError("save_issue", { id: "MOB-7", assignee: "Lars Bergström" }, "tool.INVALID_INPUT", "not an active user");
  assert.equal((await mcp("save_issue", { id: "MOB-7", assignee: null, estimate: null })).issue.assignee, null);
  await mcpError("save_issue", { id: "MOB-7", template: "Bug report" }, "tool.INVALID_INPUT", "template");
  await mcpError("save_issue", { title: "no team" }, "tool.INVALID_INPUT", "team");
  const commentsPage = await mcp("list_comments", { issueId: "ENG-2", limit: 2 });
  assert.equal(commentsPage.nodes.length, 2);
  const commentsPage2 = await mcp("list_comments", { issueId: "ENG-2", limit: 2, cursor: commentsPage.pageInfo.endCursor });
  const commentsPage3 = await mcp("list_comments", { issueId: "ENG-2", limit: 2, cursor: commentsPage2.pageInfo.endCursor });
  assert.equal(commentsPage3.pageInfo.hasNextPage, false);
  assert.equal((await mcp("list_comments", { issueId: "ENG-2", orderBy: "createdAt" })).nodes[0].id, K(6));
  await mcpError("list_comments", { projectId: "x" }, "tool.INVALID_INPUT");
  const thread = (await mcp("save_comment", { issueId: "MOB-7", body: "Confirmed on Pixel 9" })).comment;
  const replied = (await mcp("save_comment", { parentId: thread.id, body: "and Pixel 8" })).comment;
  assert.equal(replied.issue.identifier, "MOB-7");
  assert.equal(replied.parent.id, thread.id);
  assert.equal((await mcp("save_comment", { id: replied.id, body: "and Pixel 8a" })).comment.editedAt, NOW);
  await mcpError("save_comment", { body: "orphan" }, "tool.INVALID_INPUT");
  assert.equal((await mcp("linear.viewer.get", {})).id, MAYA);
  assert.equal((await mcp("linear.issues.archive", { id: "MOB-7" })).entity.archivedAt, NOW);
  const confirmed = (await gql('{ issue(id: "MOB-7") { archivedAt labels { nodes { name } } } }')).issue;
  assert.equal(confirmed.archivedAt, NOW, "the MCP archive is visible over HTTP");
  assert.deepEqual(names(confirmed.labels).sort(), ["Bug", "android", "ios"]);
}

// ---------------------------------------------------------------------------------------------
// Drill: canonical-ops (admin, baseline) — the Firedrill operation endpoint, both spellings
// ---------------------------------------------------------------------------------------------

async function canonicalOps() {
  const created = await op("issues.create", { input: { teamId: ENG, title: "Canonical GraphQL spelling", priority: 3 } });
  assert.equal(created.issue.identifier, "ENG-15");
  const friendly = await op("issues.create", { team: "MOB", title: "Canonical friendly spelling", assignee: "me" }, "create-mob-7");
  assert.equal(friendly.issue.identifier, "MOB-7");
  const replayed = await op("issues.create", { team: "MOB", title: "Canonical friendly spelling", assignee: "me" }, "create-mob-7");
  assert.equal(replayed.issue.identifier, "MOB-7", "the same idempotency key replays the recorded outcome");
  assert.equal((await op("issues.update", { id: "ENG-15", input: { priority: 1 } })).issue.priority, 1);
  assert.equal((await op("issues.update", { id: "ENG-15", title: "Renamed" })).issue.title, "Renamed");
  await opError("issues.update", { id: "ENG-15", input: { title: "a" }, title: "b" }, "INVALID_INPUT", "Cannot combine");
  const comment = (await op("comments.create", { issueId: "ENG-15", body: "canonical" })).comment;
  assert.equal(comment.issue.identifier, "ENG-15");
  assert.equal((await op("comments.update", { id: K(9), body: "edited by the admin" })).comment.editedAt, NOW, "an admin edits the guest's comment");
  assert.equal((await op("workflow-states.list", { teamId: SEC })).nodes.length, 6);
  await opError("labels.create", { name: "child", team: "ENG", parent: "backend" }, "INVALID_INPUT", "is not a group");
  assert.deepEqual((await op("cycles.list", { filter: { team: { id: { eq: ENG } }, isFuture: { eq: true } } })).nodes.map((cycle) => cycle.number), [3]);
  assert.equal((await op("teams.get", { id: MOB })).key, "MOB");
  assert.equal((await op("projects.get", { id: P(3) })).name, "SOC 2 Readiness");
  assert.equal((await op("organization.get", {})).teamCount, 3);
  const group = (await op("labels.create", { name: "Area", isGroup: true, teamId: ENG })).issueLabel;
  assert.equal(group.isGroup, true);
  assert.equal((await op("labels.create", { name: "dsp", teamId: ENG, parentId: group.id })).issueLabel.parent.id, group.id);
  await opError("issues.update", { id: "ENG-15", labels: ["Area"] }, "INVALID_INPUT", "is a group");
}

// ---------------------------------------------------------------------------------------------
// Drill: canonical-errors (admin, baseline) — NOT_FOUND and INVALID_INPUT on every operation that declares them
// ---------------------------------------------------------------------------------------------

/** Filter depth/node bounds, inherited keys at depth and date validation on the canonical list operations. */
async function filterBoundsCanonical() {
  const II = "INVALID_INPUT";
  const leaf = { title: { eq: "__no_such_title__" } };
  const started = Date.now();
  assert.deepEqual((await op("issues.list", { filter: { id: { eq: I(1) }, ...relationChain(16, leaf) } })).nodes, []);
  for (const levels of [17, 22]) await opError("issues.list", { filter: { id: { eq: I(1) }, ...relationChain(levels, leaf) } }, II, "Filter nesting depth exceeds the maximum of 16");
  await opError("issues.list", { filter: { and: Array.from({ length: 667 }, (_, i) => ({ title: { eq: `t${i}` } })) } }, II, "Filter has more than 2000 nodes");
  assert.equal((await op("issues.list", { filter: { or: Array.from({ length: 600 }, (_, i) => ({ title: { eq: `t${i}` } })) } })).nodes.length, 0);
  let nestedAnd = { name: { eq: "x" } };
  for (let level = 0; level < 17; level += 1) nestedAnd = { and: [nestedAnd] };
  await opError("projects.list", { filter: nestedAnd }, II, "Filter nesting depth exceeds the maximum of 16");
  for (const key of ["constructor", "toString", "valueOf"]) await opError("issues.list", { filter: relationChain(9, { [key]: { eq: "x" } }) }, II, `Unknown filter field "${key}"`);
  for (const value of ["2026-02-30", "P", "PT", "P1.5Y"]) {
    await opError("issues.list", { filter: { createdAt: { gt: value } } }, II, "Invalid date-time value");
    await opError("issues.list", { filter: { createdAt: { in: [value] } } }, II, "Invalid date-time value");
  }
  await opError("issues.list", { createdAt: "P" }, II, "must be an ISO-8601 date-time or duration");
  assert.ok(Date.now() - started < 5000, `filter bound probes took ${Date.now() - started} ms`);
}

async function canonicalErrors() {
  const NF = "NOT_FOUND";
  const II = "INVALID_INPUT";
  const GHOST_COMMENT = "00000011-0000-4000-8000-00000000ffff";
  await opError("users.list", { team: "NOPE" }, NF, "Entity not found: Team");
  await opError("users.list", { query: "a", limit: 3, first: 3 }, II, "Cannot combine");
  await opError("users.get", { query: "nobody" }, NF, "Entity not found: User");
  await opError("users.get", {}, II, "Provide");
  await opError("teams.list", { cursor: "not-a-cursor" }, II, "Invalid cursor");
  await opError("teams.get", { query: "NOPE" }, NF, "Entity not found: Team");
  await opError("teams.get", {}, II, "Provide");
  await opError("workflow-states.list", { team: "NOPE" }, NF, "Entity not found: Team");
  await opError("workflow-states.list", {}, II, "Provide");
  await opError("labels.list", { team: "NOPE" }, NF, "Entity not found: Team");
  await opError("labels.list", { includeGroups: true }, II, "includeGroups");
  await opError("labels.create", { name: "x", team: "NOPE" }, NF, "Entity not found: Team");
  await opError("labels.create", { name: "Bug" }, II, "already exists");
  await opError("projects.list", { team: "NOPE" }, NF, "Entity not found: Team");
  await opError("projects.list", { label: "x" }, II, "label");
  await opError("projects.get", { query: "NOPE" }, NF, "Entity not found: Project");
  await opError("projects.get", { query: "3f2a9c1e", includeResources: true }, II, "not modelled");
  await opError("projects.save", { id: "NOPE", name: "x" }, NF, "Entity not found: Project");
  await opError("projects.save", { name: "x" }, II, "at least one team");
  await opError("cycles.list", { teamId: "NOPE" }, NF, "Entity not found: Team");
  await opError("cycles.list", { type: "current" }, II, "requires a team");
  await opError("issues.list", { team: "NOPE" }, NF, "Entity not found: Team");
  await opError("issues.list", { fields: ["triageIntel"] }, II, "triageIntel");
  await opError("issues.get", { id: "ENG-999" }, NF, NOT_FOUND_ISSUE);
  await opError("issues.get", { id: "ENG-1", includeRelations: true }, II, "not modelled");
  await opError("issues.create", { team: "NOPE", title: "x" }, NF, "Entity not found: Team");
  await opError("issues.create", { team: "ENG", title: "   " }, II, "Title cannot be empty");
  await opError("issues.update", { id: "ENG-999", title: "x" }, NF, NOT_FOUND_ISSUE);
  await opError("issues.update", { id: "ENG-1", labels: ["legacy"] }, II, "archived");
  await opError("issues.save", { id: "ENG-999", title: "x" }, NF, NOT_FOUND_ISSUE);
  await opError("issues.save", { title: "x" }, II, "team");
  await opError("issues.archive", { id: "ENG-999" }, NF, NOT_FOUND_ISSUE);
  await opError("issues.archive", { id: "ENG-3" }, II, "already archived");
  await opError("comments.list", { issueId: "ENG-999" }, NF, NOT_FOUND_ISSUE);
  await opError("comments.list", { issueId: "ENG-2", projectId: "x" }, II, "projectId");
  await opError("comments.create", { issueId: "ENG-999", body: "x" }, NF, NOT_FOUND_ISSUE);
  await opError("comments.create", { issueId: "ENG-2", body: "  " }, II, "Comment body cannot be empty");
  await opError("comments.update", { id: GHOST_COMMENT, body: "x" }, NF, "Entity not found: Comment");
  await opError("comments.update", { id: K(1), body: "" }, II, "Comment body cannot be empty");
  await opError("comments.save", { parentId: GHOST_COMMENT, body: "x" }, NF, "Entity not found: Comment");
  await opError("comments.save", { body: "x" }, II, "Provide");
  await forgedCursorsCanonical();
  await inheritedKeysCanonical();
  await filterBoundsCanonical();
  assert.equal((await op("issues.list", {})).nodes.length, 23, "nothing changed");
}

// ---------------------------------------------------------------------------------------------
// Drill: tight-limits (admin, tight-limits scenario) — every bounded scan fails FAILED_PRECONDITION
// ---------------------------------------------------------------------------------------------

async function tightLimits() {
  const FP = "FAILED_PRECONDITION";
  const bound = (namespace, limit) => `state exceeds the supported bound of ${limit} rows for ${namespace}`;
  await opError("organization.get", {}, FP, bound("users", 2));
  await opError("viewer.get", {}, FP, bound("teams", 1));
  await opError("users.list", {}, FP, bound("users", 2));
  await opError("users.get", { query: "daniel" }, FP, bound("users", 2));
  await opError("teams.list", {}, FP, bound("teams", 1));
  await opError("teams.get", { query: "ENG" }, FP, bound("teams", 1));
  await opError("workflow-states.list", { teamId: ENG }, FP, bound("workflow-states", 3));
  await opError("labels.list", {}, FP, bound("labels", 2));
  await opError("labels.create", { name: "x", teamId: ENG }, FP, bound("labels", 2));
  await opError("projects.list", {}, FP, bound("projects", 1));
  await opError("projects.get", { query: "3f2a9c1e" }, FP, bound("projects", 1));
  await opError("projects.save", { name: "x", addTeams: [ENG] }, FP, bound("projects", 1));
  await opError("cycles.list", { teamId: ENG }, FP, bound("cycles", 1));
  await opError("issues.list", {}, FP, bound("issues", 5));
  await opError("issues.get", { id: "ENG-2" }, FP, bound("issues", 5));
  await opError("issues.create", { team: ENG, title: "x" }, FP, bound("issues", 5));
  await opError("issues.update", { id: "ENG-1", labels: ["Bug"] }, FP, bound("labels", 2));
  await opError("issues.save", { id: "ENG-1", assignee: "daniel" }, FP, bound("users", 2));
  await opError("comments.list", { issueId: "ENG-2" }, FP, bound("comments", 2));
  await opError("comments.create", { issueId: "ENG-2", body: "x" }, FP, bound("comments", 2));
  await opError("comments.update", { id: K(1), body: "x" }, FP, bound("comments", 10));
  await opError("comments.save", { id: K(1), body: "x" }, FP, bound("comments", 10));
  await gqlError("{ teams { nodes { id } } }", 500, FP, bound("teams", 1));
  assert.equal((await op("issues.archive", { id: "ENG-13" })).entity.identifier, "ENG-13", "an id lookup needs no scan");
}

// ---------------------------------------------------------------------------------------------
// Drill: filters (member = Daniel by e-mail, baseline)
// ---------------------------------------------------------------------------------------------

async function filters() {
  const list = async (filter, extra = "") => identifiers((await gql(`{ issues(filter: ${filter}${extra}) { nodes { identifier } } }`)).issues);
  assert.deepEqual(await list('{ team: { key: { eq: "ENG" } } }'), ["ENG-14", "ENG-12", "ENG-2", "ENG-6", "ENG-10", "ENG-1", "ENG-9", "ENG-13", "ENG-7", "ENG-11", "ENG-4", "ENG-8", "ENG-5"]);
  assert.deepEqual(await list('{ state: { type: { in: ["started"] } } }'), ["ENG-12", "ENG-2", "MOB-1", "ENG-6"]);
  assert.deepEqual(await list('{ state: { name: { eq: "Todo" } } }'), ["ENG-14", "ENG-10", "MOB-2", "ENG-1", "ENG-13", "ENG-7", "MOB-5"]);
  assert.deepEqual(await list("{ assignee: { isMe: { eq: true } } }"), ["ENG-14", "MOB-2", "ENG-1", "MOB-4"]);
  assert.deepEqual(await list("{ assignee: { null: true } }"), ["ENG-10", "MOB-6", "MOB-3", "ENG-5"]);
  assert.deepEqual(await list('{ assignee: { email: { eq: "amelie.dubois@lumenaudio.example.com" } } }'), ["ENG-2", "ENG-11", "ENG-8"]);
  assert.deepEqual(await list("{ priority: { lte: 2, gte: 1 } }"), ["ENG-14", "ENG-12", "ENG-2", "MOB-1", "ENG-6", "ENG-10", "MOB-2", "ENG-1", "MOB-6", "ENG-4", "MOB-4", "ENG-8"]);
  assert.deepEqual(await list('{ labels: { some: { name: { eq: "Bug" } } } }'), ["ENG-14", "ENG-2", "ENG-6", "ENG-10", "MOB-2", "MOB-6", "MOB-4"]);
  assert.deepEqual(await list('{ labels: { every: { name: { neq: "Bug" } } } }'), ["ENG-12", "MOB-1", "ENG-1", "ENG-9", "ENG-13", "ENG-7", "ENG-11", "ENG-4", "MOB-5", "MOB-3", "ENG-8", "ENG-5"]);
  assert.deepEqual(await list('{ labels: { name: { eq: "backend" } } }'), ["ENG-12", "ENG-6", "ENG-1", "ENG-4", "ENG-5"]);
  assert.deepEqual(await list("{ cycle: { number: { eq: 2 } } }"), ["ENG-12", "ENG-2", "ENG-6", "ENG-10"]);
  assert.deepEqual(await list('{ project: { slugId: { eq: "3f2a9c1e" } } }'), ["ENG-6", "ENG-1", "ENG-11", "ENG-4", "ENG-5"]);
  assert.deepEqual(await list(`{ parent: { id: { eq: "${I(1)}" } } }`), ["ENG-4", "ENG-5"]);
  assert.deepEqual(await list('{ children: { some: { state: { type: { eq: "completed" } } } } }'), ["ENG-1"]);
  assert.deepEqual(await list('{ dueDate: { lt: "2026-09-14" } }'), ["ENG-6"]);
  assert.deepEqual(await list("{ dueDate: { null: false } }"), ["ENG-2", "ENG-6"]);
  assert.deepEqual(await list('{ createdAt: { gte: "-P2D" } }'), ["ENG-12"]);
  assert.deepEqual(await list('{ updatedAt: { gte: "2026-09-14T00:00:00Z" } }'), ["ENG-14", "ENG-12"]);
  assert.deepEqual(await list('{ title: { containsIgnoreCase: "CRASH" } }'), ["MOB-2", "MOB-6"]);
  assert.deepEqual(await list('{ description: { contains: "beta" } }'), ["ENG-14", "MOB-6"]);
  assert.deepEqual(await list('{ number: { in: [1, 2] }, team: { key: { eq: "MOB" } } }'), ["MOB-1", "MOB-2"]);
  assert.deepEqual(await list('{ or: [{ priority: { eq: 1 } }, { state: { type: { eq: "completed" } } }] }'), ["ENG-12", "MOB-2", "ENG-1", "ENG-4", "MOB-4"]);
  assert.deepEqual(await list('{ and: [{ team: { key: { eq: "ENG" } } }, { assignee: { null: true } }] }'), ["ENG-10", "ENG-5"]);
  assert.deepEqual(await list("{ archivedAt: { null: false } }"), []);
  assert.deepEqual(await list("{ archivedAt: { null: false } }", ", includeArchived: true"), ["ENG-3"]);
  assert.equal(identifiers((await gql("{ issues(orderBy: createdAt) { nodes { identifier } } }")).issues)[0], "ENG-12");
  assert.equal(identifiers((await gql("{ issues(orderBy: updatedAt) { nodes { identifier } } }")).issues)[0], "ENG-14");
  const all = await pageThrough((cursor) => `{ issues(first: 4${cursor === undefined ? "" : `, after: "${cursor}"`}) { nodes { identifier } pageInfo { hasNextPage endCursor } } }`, (data) => data.issues);
  assert.equal(all.nodes.length, 19, "Daniel sees ENG and MOB, never SEC");
  assert.equal(all.pages, 5);
  assert.ok(!all.nodes.some((issue) => issue.identifier.startsWith("SEC-")));
  const first = (await gql('{ issues(first: 4, filter: { team: { key: { eq: "ENG" } } }) { pageInfo { endCursor } } }')).issues.pageInfo.endCursor;
  await gqlError(`{ issues(first: 4, after: "${first}", filter: { team: { key: { eq: "MOB" } } }) { nodes { id } } }`, 400, "INVALID_INPUT", "Invalid cursor");
  await gqlError("{ issues(first: 0) { nodes { id } } }", 400, "INVALID_INPUT");
  assert.equal((await gql("{ users(filter: { active: { eq: false } }) { nodes { id } } }")).users.nodes.length, 0);
  assert.deepEqual((await gql("{ users(includeDisabled: true, filter: { active: { eq: false } }) { nodes { id } } }")).users.nodes.map((user) => user.id), [LARS]);
  assert.deepEqual(names((await gql(`{ projects(filter: { teams: { some: { id: { eq: "${MOB}" } } } }) { nodes { name } } }`)).projects), ["Companion App 2.0"]);
  assert.equal((await gql("{ projects { nodes { id } } }")).projects.nodes.length, 2, "SOC 2 is hidden from Daniel");
  const comments1 = (await gql('{ comments(filter: { issue: { id: { eq: "ENG-2" } } }, orderBy: createdAt, first: 4) { nodes { id } pageInfo { hasNextPage endCursor } } }')).comments;
  assert.equal(comments1.nodes.length, 4);
  assert.equal(comments1.nodes[0].id, K(6));
  const comments2 = (await gql(`{ comments(filter: { issue: { id: { eq: "ENG-2" } } }, orderBy: createdAt, first: 4, after: "${comments1.pageInfo.endCursor}") { nodes { id } pageInfo { hasNextPage } } }`)).comments;
  assert.equal(comments2.nodes.length, 2);
  assert.equal(comments2.pageInfo.hasNextPage, false);
  await gqlError('{ comments(filter: { issue: { id: { eq: "SEC-1" } } }) { nodes { id } } }', 400, "NOT_FOUND", NOT_FOUND_ISSUE);
}

// ---------------------------------------------------------------------------------------------
// Drill: permissions (guest = Kenji, MOB only, baseline)
// ---------------------------------------------------------------------------------------------

async function permissions() {
  const viewer = (await gql("{ viewer { guest teams { nodes { key } } } }")).viewer;
  assert.equal(viewer.guest, true);
  assert.deepEqual(viewer.teams.nodes.map((team) => team.key), ["MOB"]);
  assert.deepEqual((await gql("{ teams { nodes { key } } }")).teams.nodes.map((team) => team.key), ["MOB"]);
  await gqlError('{ team(id: "ENG") { id } }', 400, "NOT_FOUND", "Entity not found: Team");
  await gqlError('{ issue(id: "ENG-1") { id } }', 400, "NOT_FOUND", NOT_FOUND_ISSUE);
  assert.deepEqual(identifiers((await gql("{ issues { nodes { identifier } } }")).issues), ["MOB-1", "MOB-2", "MOB-6", "MOB-4", "MOB-5", "MOB-3"]);
  assert.deepEqual(names((await gql("{ projects { nodes { name } } }")).projects), ["Companion App 2.0"]);
  assert.deepEqual(names((await gql("{ issueLabels { nodes { name } } }")).issueLabels).sort(), ["Bug", "Feature", "Improvement", "android", "ios"]);
  assert.equal((await gql("{ users { nodes { id } } }")).users.nodes.length, 5, "users are workspace-wide");
  assert.equal((await gql(`mutation { issueCreate(input: { teamId: "${MOB}", title: "Guest-filed crash" }) { issue { identifier } } }`)).issueCreate.issue.identifier, "MOB-7");
  await gqlError(`mutation { issueCreate(input: { teamId: "${ENG}", title: "hidden" }) { success } }`, 400, "NOT_FOUND", "Entity not found: Team");
  assert.equal((await gql('mutation { issueUpdate(id: "MOB-2", input: { priority: 2 }) { issue { priority } } }')).issueUpdate.issue.priority, 2);
  assert.equal((await gql('mutation { commentCreate(input: { issueId: "MOB-2", body: "Also on Pixel 8" }) { comment { user { id } } } }')).commentCreate.comment.user.id, KENJI);
  await gqlError(`mutation { commentUpdate(id: "${K(10)}", input: { body: "x" }) { success } }`, 403, "FORBIDDEN", "You don't have permission to edit this comment.");
  assert.equal((await gql(`mutation { commentUpdate(id: "${K(9)}", input: { body: "Background sync works on Wi-Fi and cellular now." }) { comment { editedAt } } }`)).commentUpdate.comment.editedAt, NOW);
  await gqlError(`mutation { projectCreate(input: { name: "Guest project", teamIds: ["${MOB}"] }) { success } }`, 403, "FORBIDDEN", "Guests cannot create projects.");
  await gqlError(`mutation { projectUpdate(id: "${P(2)}", input: { state: "started" }) { success } }`, 403, "FORBIDDEN");
  await gqlError('mutation { issueLabelCreate(input: { name: "guest-label" }) { success } }', 403, "FORBIDDEN", "workspace labels");
  assert.equal((await gql(`mutation { issueLabelCreate(input: { name: "tablet", teamId: "${MOB}" }) { issueLabel { name } } }`)).issueLabelCreate.issueLabel.name, "tablet");
  assert.equal((await gql('mutation { issueArchive(id: "MOB-6") { entity { archivedAt } } }')).issueArchive.entity.archivedAt, NOW);
  // The same permission rules over the canonical operation endpoint
  await opError("labels.create", { name: "guest-workspace-label" }, "FORBIDDEN", "workspace labels");
  await opError("projects.save", { name: "Guest project", addTeams: ["MOB"] }, "FORBIDDEN", "Guests cannot create projects.");
  await opError("comments.update", { id: K(10), body: "x" }, "FORBIDDEN", "permission to edit this comment");
  await opError("comments.save", { id: K(10), body: "x" }, "FORBIDDEN", "permission to edit this comment");
}

// ---------------------------------------------------------------------------------------------
// Drill: private-team (member = Daniel: ENG + MOB, not SEC)
// ---------------------------------------------------------------------------------------------

async function privateTeam() {
  await gqlError('{ team(id: "SEC") { id } }', 400, "NOT_FOUND", "Entity not found: Team");
  await gqlError('{ issue(id: "SEC-1") { id } }', 400, "NOT_FOUND", NOT_FOUND_ISSUE);
  await gqlError('{ project(id: "SOC 2 Readiness") { id } }', 400, "NOT_FOUND", "Entity not found: Project");
  assert.deepEqual((await gql('{ user(id: "Sofia Reyes") { teams { nodes { key } } } }')).user.teams.nodes.map((team) => team.key), ["ENG"], "SEC membership never leaks");
  assert.equal((await gql("{ organization { teamCount } }")).organization.teamCount, 2);
  assert.equal((await gql('{ searchIssues(term: "SOC") { nodes { id } } }')).searchIssues.nodes.length, 0);
  await gqlError('mutation { commentCreate(input: { issueId: "SEC-1", body: "x" }) { success } }', 400, "NOT_FOUND", NOT_FOUND_ISSUE);
  assert.equal((await gql(`mutation { issueUpdate(id: "ENG-10", input: { assigneeId: "${SOFIA}" }) { issue { assignee { id } } } }`)).issueUpdate.issue.assignee.id, SOFIA);
  await gqlError(`mutation { issueUpdate(id: "ENG-1", input: { assigneeId: "${KENJI}" }) { success } }`, 400, "INVALID_INPUT", "Kenji Watanabe is not a member of team ENG");
}

// ---------------------------------------------------------------------------------------------
// Drills: default-identity / denied / invalid-auth / suspended-user
// ---------------------------------------------------------------------------------------------

async function defaultIdentity() {
  const viewer = (await gql("{ viewer { id email admin } }")).viewer;
  assert.equal(viewer.id, MAYA, "an actor without identity attributes is the seeded default user");
  assert.equal(viewer.admin, true);
  assert.equal((await gql("{ teams { nodes { key } } }")).teams.nodes.length, 3);
  const created = (await gql(`mutation { issueCreate(input: { teamId: "${SEC}", title: "Fresh install works" }) { issue { identifier creator { id } } } }`)).issueCreate.issue;
  assert.equal(created.identifier, "SEC-5");
  assert.equal(created.creator.id, MAYA);
  await mcpInit();
  assert.equal((await mcp("get_user", { query: "me" })).id, MAYA);
}

async function denied() {
  const result = await graphqlRaw({ query: "{ viewer { id } }" }, { status: 403 });
  assert.deepEqual(result.json, { errors: [{ message: "Not authorized", extensions: { type: "forbidden", userError: false } }] });
  const outcome = await operation("issues.create", { team: "ENG", title: "x" }, "denied");
  assert.equal(outcome.status, "denied");
  await mcpInit();
  const mcpResult = await rpc("tools/call", { name: "get_workspace", arguments: {} });
  assert.ok(mcpResult.isError);
  assert.equal(mcpValue(mcpResult).status, "denied");
}

async function invalidAuth() {
  const result = await gqlError("{ viewer { id } }", 401, "AUTHENTICATION_ERROR", AUTH_MESSAGE);
  assert.equal(result.json.errors[0].extensions.type, "authentication error");
  await gqlError(`mutation { issueCreate(input: { teamId: "${ENG}", title: "x" }) { success } }`, 401, "AUTHENTICATION_ERROR");
  for (const [id, args] of CALLS) await opError(id, args, "AUTHENTICATION_ERROR", AUTH_MESSAGE);
  await mcpInit();
  await mcpError("list_issues", {}, "tool.AUTHENTICATION_ERROR", AUTH_MESSAGE);
}

async function suspendedUser() {
  await gqlError("{ viewer { id } }", 401, "AUTHENTICATION_ERROR", AUTH_MESSAGE);
  await opError("viewer.get", {}, "AUTHENTICATION_ERROR", AUTH_MESSAGE);
  await opError("issues.list", {}, "AUTHENTICATION_ERROR", AUTH_MESSAGE);
}

// ---------------------------------------------------------------------------------------------
// Drills: faults
// ---------------------------------------------------------------------------------------------

async function rateLimited() {
  for (const [id, args] of CALLS) await opError(id, args, "RATELIMITED", "Rate limit exceeded");
  const result = await gqlError("{ viewer { id } }", 429, "RATELIMITED", "Rate limit exceeded");
  assert.equal(result.headers.get("retry-after"), "60");
  assert.equal(result.headers.get("x-ratelimit-requests-remaining"), "0");
  assert.equal(result.json.errors[0].extensions.type, "ratelimited");
  await mcpInit();
  await mcpError("list_issues", {}, "tool.RATELIMITED", "Rate limit exceeded");
}

async function writeUnavailable() {
  for (const [id, args] of CALLS) if (WRITE_OPERATIONS.includes(id)) await opError(id, args, "INTERNAL_ERROR", "Internal error occurred");
  await mcpInit();
  await mcpError("save_issue", { team: "ENG", title: "x" }, "tool.INTERNAL_ERROR", "Internal error occurred");
  assert.equal((await op("viewer.get", {})).id, MAYA, "reads keep working");
  assert.equal((await op("issues.list", {})).nodes.length, 23);
  assert.equal((await gql("{ issues(first: 1) { nodes { id } } }")).issues.nodes.length, 1);
  assert.equal((await gql('{ issue(id: "ENG-2") { comments(first: 50) { nodes { id } } } }')).issue.comments.nodes.length, 6, "nothing was written");
  const created = (await gql(`mutation { issueCreate(input: { teamId: "${ENG}", title: "GraphQL mutations are not covered by this fault" }) { issue { identifier } } }`)).issueCreate.issue;
  assert.equal(created.identifier, "ENG-15", "the fault binds to the semantic operations, not to graphql.execute (documented)");
}

async function issueCreateCommittedLost() {
  const args = { team: "ENG", title: "Bench regression on M4" };
  await opError("issues.create", args, "INTERNAL_ERROR", "Internal error occurred");
  assert.deepEqual(identifiers((await gql('{ issues(filter: { title: { eq: "Bench regression on M4" } }) { nodes { identifier } } }')).issues), ["ENG-15"], "the create committed although the caller saw an error");
  await opError("issues.create", args, "INTERNAL_ERROR");
  assert.deepEqual(identifiers((await gql('{ issues(filter: { title: { eq: "Bench regression on M4" } }, orderBy: createdAt) { nodes { identifier } } }')).issues).sort(), ["ENG-15", "ENG-16"], "a naive retry created a duplicate");
  await opError("issues.create", args, "INTERNAL_ERROR", undefined, "bench-regression-m4");
  await opError("issues.create", args, "INTERNAL_ERROR", undefined, "bench-regression-m4");
  assert.equal((await gql('{ issues(filter: { title: { eq: "Bench regression on M4" } }) { nodes { identifier } } }')).issues.nodes.length, 3, "the keyed retry replayed the recorded outcome instead of creating a fourth issue");
  await mcpInit();
  await mcpError("save_issue", { team: "ENG", title: "Bench regression on M4 (mcp)" }, "tool.INTERNAL_ERROR", "Internal error occurred");
  assert.equal((await gql('{ issue(id: "ENG-18") { title } }')).issue.title, "Bench regression on M4 (mcp)");
  assert.equal((await op("issues.update", { id: "ENG-15", priority: 2 })).issue.priority, 2, "update is not covered by the fault");
}

async function tightLimitsByEmail() {
  const message = "state exceeds the supported bound of 2 rows for users";
  await opError("issues.archive", { id: "ENG-13" }, "FAILED_PRECONDITION", message);
  await gqlError('mutation { issueArchive(id: "ENG-13") { success } }', 500, "FAILED_PRECONDITION", message);
}

// ---------------------------------------------------------------------------------------------
// Drill: project-pages (admin, project-pages scenario) — 265 project issues page through projects.get, never cut
// ---------------------------------------------------------------------------------------------

async function projectPages() {
  const II = "INVALID_INPUT";
  const SPATIAL = P(1);
  const ids = (connection) => connection.nodes.map((node) => node.identifier);
  const list1 = await op("issues.list", { project: SPATIAL, first: 250 });
  assert.equal(list1.pageInfo.hasNextPage, true);
  const list2 = await op("issues.list", { project: SPATIAL, first: 250, after: list1.pageInfo.endCursor });
  assert.equal(list2.pageInfo.hasNextPage, false);
  const expected = [...ids(list1), ...ids(list2)];
  assert.equal(expected.length, 265, "the scenario project holds 265 visible issues");

  const preview = await op("projects.get", { id: SPATIAL });
  assert.equal(preview.issues.nodes.length, 50, "default issue page is 50");
  assert.equal(preview.issues.pageInfo.hasNextPage, true);
  assert.ok(typeof preview.issues.pageInfo.endCursor === "string" && preview.issues.pageInfo.endCursor.length > 0);
  const page1 = await op("projects.get", { id: SPATIAL, issuesFirst: 250 });
  assert.equal(page1.issues.nodes.length, 250);
  assert.equal(page1.issues.pageInfo.hasNextPage, true, "a full page with more behind it says so");
  assert.deepEqual(ids(preview.issues), ids(page1.issues).slice(0, 50), "pages share one order");
  const page2 = await op("projects.get", { id: SPATIAL, issuesFirst: 250, issuesAfter: page1.issues.pageInfo.endCursor });
  assert.equal(page2.issues.nodes.length, 15);
  assert.equal(page2.issues.pageInfo.hasNextPage, false);
  const paged = [...ids(page1.issues), ...ids(page2.issues)];
  assert.equal(new Set(paged).size, 265, "no duplicates across pages");
  assert.deepEqual([...paged].sort(), [...expected].sort(), "projects.get pages cover exactly the project's issues");

  const nested = (await gql('query Rest($after: String) { project(id: "3f2a9c1e") { issues(first: 250, after: $after) { nodes { identifier } pageInfo { hasNextPage } } } }', { after: page1.issues.pageInfo.endCursor })).project.issues;
  assert.deepEqual(ids(nested), ids(page2.issues), "a projects.get cursor continues GraphQL project.issues");
  assert.equal(nested.pageInfo.hasNextPage, false);

  await mcpInit();
  const viaMcp = await mcp("get_project", { query: "3f2a9c1e", issuesFirst: 250 });
  assert.equal(viaMcp.issues.nodes.length, 250);
  assert.equal(viaMcp.issues.pageInfo.hasNextPage, true);

  await opError("projects.get", { id: SPATIAL, issuesAfter: "bogus" }, II, "Invalid cursor");
  await opError("projects.get", { id: SPATIAL, issuesAfter: list1.pageInfo.endCursor }, II, "Invalid cursor");

  // Zone-less date-times are read as UTC, never host-local; non-ISO text is rejected.
  const zoneless = await op("issues.list", { project: SPATIAL, createdAt: "2026-08-01T02:00:00", first: 250 });
  const zoned = await op("issues.list", { project: SPATIAL, createdAt: "2026-08-01T02:00:00Z", first: 250 });
  assert.deepEqual(ids(zoneless), ids(zoned));
  assert.ok(zoned.nodes.length > 0 && zoned.nodes.length < 265);
  await opError("issues.list", { createdAt: "Aug 1 2026" }, II, "ISO-8601");

  // One filter work budget per request (2,000,000 steps): a 600-entry `or` under 5 aliases over 284 issues evaluates,
  // the same filter under 20 aliases is INVALID_INPUT before it can block the server.
  const wide = { or: Array.from({ length: 600 }, (_, i) => ({ title: { eq: `t${i}` } })) };
  const aliased = (n) => `query Wide($f: IssueFilter) { ${Array.from({ length: n }, (_, i) => `a${i}: issues(first: 1, filter: $f) { nodes { id } }`).join(" ")} }`;
  const started = Date.now();
  assert.deepEqual((await gql(aliased(5), { f: wide })).a4.nodes, []);
  await gqlError(aliased(20), 400, II, "Filter is too complex", { f: wide });
  assert.ok(Date.now() - started < 5000, `filter budget probes took ${Date.now() - started} ms`);

  // String comparisons are linear (KMP for needles over 6 characters) and charged by compared characters (one step per 16):
  // a 32,001-character needle that native search takes 138 ms per value on answers at once; 100 containsIgnoreCase clauses
  // over one 65,536-character description evaluate, 600 exceed the budget instead of blocking the server.
  const inProject = { project: { id: { eq: SPATIAL } } };
  await op("issues.update", { id: expected[0], description: "a".repeat(65_536) });
  const clauses = (n) => ({ ...inProject, or: Array.from({ length: n }, (_, i) => ({ description: { containsIgnoreCase: `zz${String(i)}` } })) });
  const longStarted = Date.now();
  assert.deepEqual((await op("issues.list", { filter: { ...inProject, description: { contains: `${"a".repeat(16_000)}b${"a".repeat(16_000)}` } }, first: 1 })).nodes, []);
  assert.deepEqual((await op("issues.list", { filter: clauses(100), first: 1 })).nodes, []);
  await opError("issues.list", { filter: clauses(600), first: 1 }, II, "Filter is too complex");
  assert.ok(Date.now() - longStarted < 5000, `long-needle budget probes took ${Date.now() - longStarted} ms`);

  // Root issues and searchIssues under 100 aliases sort the visible issues once per request, and every alias sees the same page.
  const rootStarted = Date.now();
  const roots = await gql(`{ ${Array.from({ length: 100 }, (_, i) => `a${i}: issues(first: 1, orderBy: ${i % 2 === 0 ? "createdAt" : "updatedAt"}, includeArchived: ${i % 3 === 0 ? "true" : "false"}) { nodes { identifier } }`).join(" ")} }`);
  assert.deepEqual(roots.a98.nodes, roots.a0.nodes.length === 0 ? [] : roots.a98.nodes);
  assert.deepEqual(roots.a2.nodes, roots.a4.nodes, "aliases with the same arguments see the same page");
  const createdFirst = (await op("issues.list", { orderBy: "createdAt", first: 1 })).nodes[0].identifier;
  assert.equal(roots.a2.nodes[0].identifier, createdFirst, "the cached order matches issues.list");
  const searches = await gql(`{ ${Array.from({ length: 100 }, (_, i) => `s${i}: searchIssues(term: "spatial", first: 1) { nodes { identifier } }`).join(" ")} }`);
  assert.deepEqual(searches.s99.nodes, searches.s0.nodes);
  assert.ok(Date.now() - rootStarted < 5000, `100-alias root list probes took ${Date.now() - rootStarted} ms`);
}

async function commentCap() {
  await gqlError('mutation { commentCreate(input: { issueId: "ENG-90", body: "one more" }) { success } }', 500, "FAILED_PRECONDITION", "state exceeds the supported bound of 500 rows for comments");
  const nested = (await gql('{ issue(id: "ENG-90") { comments(first: 250) { nodes { id } pageInfo { hasNextPage endCursor } } } }')).issue.comments;
  assert.equal(nested.nodes.length, 250);
  assert.equal(nested.pageInfo.hasNextPage, true);
  const page1 = await op("comments.list", { issueId: "ENG-90", first: 250 });
  assert.equal(page1.nodes.length, 250);
  assert.equal(page1.pageInfo.hasNextPage, true);
  const page2 = await op("comments.list", { issueId: "ENG-90", first: 250, after: page1.pageInfo.endCursor });
  assert.equal(page2.nodes.length, 250);
  assert.equal(page2.pageInfo.hasNextPage, false);

  // issues.get inlines one page of comments with cursors (never a cut list): `commentsFirst`/`commentsAfter` share the
  // order and cursor scope of GraphQL `issue(id) { comments(first, after) }`, so a cursor from either continues on the other.
  const ids = (connection) => connection.nodes.map((node) => node.id);
  const preview = await op("issues.get", { id: "ENG-90" });
  assert.equal(preview.comments.nodes.length, 50, "default comment page is 50");
  assert.equal(preview.comments.pageInfo.hasNextPage, true);
  assert.ok(typeof preview.comments.pageInfo.endCursor === "string" && preview.comments.pageInfo.endCursor.length > 0, "the inline page exposes a cursor");
  assert.deepEqual(ids(preview.comments), ids(nested).slice(0, 50), "the inline page is the first GraphQL page");
  const inline1 = await op("issues.get", { id: "ENG-90", commentsFirst: 250 });
  assert.equal(inline1.comments.nodes.length, 250);
  assert.equal(inline1.comments.pageInfo.hasNextPage, true);
  assert.deepEqual(ids(inline1.comments), ids(nested));
  const inline2 = await op("issues.get", { id: "ENG-90", commentsFirst: 250, commentsAfter: inline1.comments.pageInfo.endCursor });
  assert.equal(inline2.comments.nodes.length, 250);
  assert.equal(inline2.comments.pageInfo.hasNextPage, false);
  assert.equal(new Set([...ids(inline1.comments), ...ids(inline2.comments)]).size, 500, "issues.get pages cover all 500 comments once");
  const rest = (await gql('query Rest($after: String) { issue(id: "ENG-90") { comments(first: 250, after: $after) { nodes { id } pageInfo { hasNextPage } } } }', { after: inline1.comments.pageInfo.endCursor })).issue.comments;
  assert.deepEqual(ids(rest), ids(inline2.comments), "an issues.get cursor continues GraphQL issue.comments");
  assert.equal(rest.pageInfo.hasNextPage, false);
  const viaNested = await op("issues.get", { id: "ENG-90", commentsFirst: 250, commentsAfter: nested.pageInfo.endCursor });
  assert.deepEqual(ids(viaNested.comments), ids(inline2.comments), "a GraphQL issue.comments cursor continues issues.get");
  await mcpInit();
  const viaMcp = await mcp("get_issue", { id: "ENG-90", commentsFirst: 3 });
  assert.deepEqual(ids(viaMcp.comments), ids(nested).slice(0, 3));
  assert.equal(viaMcp.comments.pageInfo.hasNextPage, true);
  await opError("issues.get", { id: "ENG-90", commentsAfter: "bogus" }, "INVALID_INPUT", "Invalid cursor");
  await opError("issues.get", { id: "ENG-90", commentsAfter: page1.pageInfo.endCursor }, "INVALID_INPUT", "Invalid cursor");
  const empty = await op("issues.get", { id: "ENG-5" });
  assert.deepEqual(empty.comments, { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } });
}

// ---------------------------------------------------------------------------------------------

const flows = {
  "graphql-flow": graphqlFlow,
  "graphql-errors": graphqlErrors,
  "mcp-aliases": mcpAliases,
  "canonical-ops": canonicalOps,
  "canonical-errors": canonicalErrors,
  "tight-limits": tightLimits,
  filters,
  permissions,
  "private-team": privateTeam,
  "default-identity": defaultIdentity,
  denied,
  "invalid-auth": invalidAuth,
  "suspended-user": suspendedUser,
  "rate-limited": rateLimited,
  "write-unavailable": writeUnavailable,
  "issue-create-committed-lost": issueCreateCommittedLost,
  "comment-cap": commentCap,
  "tight-limits-by-email": tightLimitsByEmail,
  "project-pages": projectPages,
};
const selected = Object.keys(flows).find((name) => instruction.includes(`the ${name} conformance flow`));
if (selected === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
