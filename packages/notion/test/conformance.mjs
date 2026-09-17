// Notion Tool conformance target. A scripted Tool test, not a model-driven agent.
// Node built-ins only: fetch against the Notion-shaped /v1 routes, the canonical operation endpoint and
// raw MCP JSON-RPC (Streamable HTTP) for the Notion MCP server tool-name aliases. Every flow fails loudly on
// an unexpected status, header or body. The drill instruction selects the flow.
import assert from "node:assert/strict";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const instruction = String(JSON.parse(task).instruction ?? "");

const HTTP = process.env.FIREDRILL_HTTP_URL;
const HTTP_TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
const MCP = process.env.FIREDRILL_MCP_URL;
const MCP_TOKEN = process.env.FIREDRILL_MCP_TOKEN;
assert.ok(HTTP && HTTP_TOKEN && MCP && MCP_TOKEN, "HTTP and MCP bindings are required");

// Seeded ids (see starter.json) ------------------------------------------------------------------
const ID = {
  workspace: "fd000000-0000-4000-8000-000000000001",
  ines: "fd000000-0000-4000-8000-000100000001",
  tomas: "fd000000-0000-4000-8000-000100000002",
  priya: "fd000000-0000-4000-8000-000100000003",
  marco: "fd000000-0000-4000-8000-000100000004",
  yuki: "fd000000-0000-4000-8000-000100000005",
  agentBot: "fd000000-0000-4000-8000-000100000006",
  notesBot: "fd000000-0000-4000-8000-000100000007",
  home: "fd000000-0000-4000-8000-000200000001",
  engineering: "fd000000-0000-4000-8000-000200000002",
  onboarding: "fd000000-0000-4000-8000-000200000003",
  design: "fd000000-0000-4000-8000-000200000004",
  meetings: "fd000000-0000-4000-8000-000200000005",
  sync0908: "fd000000-0000-4000-8000-000200000006",
  sync0901: "fd000000-0000-4000-8000-000200000007",
  scratch: "fd000000-0000-4000-8000-000200000008",
  roadmap: "fd000000-0000-4000-8000-000200000009",
  dbProjects: "fd000000-0000-4000-8000-000300000001",
  dbTasks: "fd000000-0000-4000-8000-000300000002",
  dbDecisions: "fd000000-0000-4000-8000-000300000003",
  dsProjects: "fd000000-0000-4000-8000-000400000001",
  dsTasks: "fd000000-0000-4000-8000-000400000002",
  dsDecisions: "fd000000-0000-4000-8000-000400000003",
  atlas: "fd000000-0000-4000-8000-000200000100",
  beacon: "fd000000-0000-4000-8000-000200000101",
  t1: "fd000000-0000-4000-8000-000200000120",
  t3: "fd000000-0000-4000-8000-000200000122",
  t4: "fd000000-0000-4000-8000-000200000123",
  t7: "fd000000-0000-4000-8000-000200000126",
  toggle: "fd000000-0000-4000-8000-00050000000e",
  actionItem: "fd000000-0000-4000-8000-00050000001f",
  designHeading: "fd000000-0000-4000-8000-000500000009",
  bookmark: "fd000000-0000-4000-8000-000500000018",
  discussion1: "fd000000-0000-4000-8000-000800000001",
  missingPage: "fd000000-0000-4000-8000-000200000777",
  newPage: "fd000000-0000-4000-8000-000200001002",
};
const ALL_OPERATIONS = [
  "users.me", "users.list", "users.get", "search", "pages.create", "pages.retrieve", "pages.update", "pages.retrieve-property", "pages.move",
  "pages.retrieve-markdown", "pages.update-markdown", "databases.create", "databases.retrieve", "data-sources.retrieve", "data-sources.query",
  "data-sources.update", "blocks.retrieve", "blocks.children.list", "blocks.children.append", "blocks.update", "blocks.delete", "comments.create",
  "comments.list", "workspace.context", "workspace.trash",
];
const ALIASES = [
  "API-get-self", "API-get-users", "API-get-user", "API-post-search", "API-post-page", "API-retrieve-a-page", "API-patch-page",
  "API-retrieve-a-page-property", "API-move-page", "API-retrieve-page-markdown", "API-update-page-markdown", "API-retrieve-a-database",
  "API-retrieve-a-data-source", "API-query-data-source", "API-update-a-data-source", "API-retrieve-a-block", "API-get-block-children",
  "API-patch-block-children", "API-update-a-block", "API-delete-a-block", "API-create-a-comment", "API-retrieve-a-comment",
];
const text = (content) => ({ type: "text", text: { content } });
const plain = (items) => items.map((item) => item.plain_text).join("");

// ---------------------------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------------------------

/** Notion-shaped request. `status` is asserted; the JSON body and headers are returned. */
async function api(method, path, { body, status = 200, headers = {} } = {}) {
  const response = await fetch(`${HTTP}${path}`, {
    method,
    headers: { authorization: `Bearer ${HTTP_TOKEN}`, "notion-version": "2025-09-03", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  const json = raw.length > 0 ? JSON.parse(raw) : undefined;
  assert.equal(response.status, status, `${method} ${path} ${body === undefined ? "" : JSON.stringify(body).slice(0, 200)} -> ${response.status} ${raw.slice(0, 500)}`);
  return { json, headers: response.headers, status: response.status };
}
const get = (path, options) => api("GET", path, options);
const post = (path, body, options) => api("POST", path, { ...options, body });
const patch = (path, body, options) => api("PATCH", path, { ...options, body });
const del = (path, options) => api("DELETE", path, options);

/** Expect Notion's error envelope with the given HTTP status, `code` and a message containing `textPart`. */
async function apiError(method, path, status, code, textPart, options = {}) {
  const result = await api(method, path, { ...options, status });
  const error = result.json;
  assert.ok(error && error.object === "error", `${method} ${path}: no Notion error envelope: ${JSON.stringify(error)}`);
  assert.equal(error.status, status, JSON.stringify(error));
  assert.equal(error.code, code, `${method} ${path}: ${JSON.stringify(error)}`);
  assert.ok(typeof error.request_id === "string" && error.request_id.startsWith("corr_"), `${method} ${path}: no request_id`);
  if (textPart !== undefined) assert.ok(error.message.includes(textPart), `${method} ${path}: expected ${JSON.stringify(textPart)} in ${JSON.stringify(error.message)}`);
  return result;
}

/**
 * Route-fuzz retrofit (2026-09-16): every JSON route's `decode` measures body nesting iteratively
 * (firedrill/tools/notion/lib/json-depth.mjs, bound 512) and refuses a deeper body with 400 before argument
 * validation, which would otherwise overflow and answer an opaque 500 around 2,995-3,155 levels.
 */
async function deepBody(method, path, rawBody, label, expected = 400) {
  const response = await fetch(`${HTTP}${path}`, {
    method,
    headers: { authorization: `Bearer ${HTTP_TOKEN}`, "notion-version": "2025-09-03", "content-type": "application/json" },
    body: rawBody,
  });
  const text = await response.text();
  if (expected === "below-500") assert.ok(response.status < 500, `${method} ${path} ${label} -> ${response.status} ${text.slice(0, 300)}`);
  else assert.equal(response.status, expected, `${method} ${path} ${label} -> ${response.status} ${text.slice(0, 300)}`);
  assert.ok(!/RangeError|call stack|Cannot read propert/i.test(text), `${method} ${path} ${label} leaked a runtime error: ${text.slice(0, 300)}`);
}
const deepObject = (depth) => `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
const deepArray = (depth) => `${"[".repeat(depth)}1${"]".repeat(depth)}`;

/** All twelve JSON routes refuse over-deep bodies at the reported depths; 512 itself still reaches the handler. */
async function assertDeepBodiesRefused(blockId) {
  const routes = [
    ["POST", "/v1/search", "filter"],
    ["POST", "/v1/pages", "parent"],
    ["PATCH", `/v1/pages/${ID.design}`, "properties"],
    ["POST", `/v1/pages/${ID.design}/move`, "parent"],
    ["PATCH", `/v1/pages/${ID.design}/markdown`, "position"],
    ["POST", "/v1/databases", "parent"],
    ["POST", `/v1/databases/${ID.dbTasks}/query`, "filter"],
    ["POST", `/v1/data_sources/${ID.dsTasks}/query`, "filter"],
    ["PATCH", `/v1/data_sources/${ID.dsTasks}`, "properties"],
    ["PATCH", `/v1/blocks/${blockId}/children`, "children"],
    ["PATCH", `/v1/blocks/${ID.toggle}`, "type"],
    ["POST", "/v1/comments", "parent"],
  ];
  for (const [method, path, property] of routes) {
    for (const depth of [513, 2995, 3000, 3150, 3155]) {
      await deepBody(method, path, `{"${property}":${deepObject(depth)}}`, `objects under ${property} at ${depth}`);
      await deepBody(method, path, `{"${property}":${deepArray(depth)}}`, `arrays under ${property} at ${depth}`);
    }
    await deepBody(method, path, deepObject(3155), "objects top-level at 3155");
    // At the bound the guard does not fire: the body reaches validation and the handler, which answer it (400, or
    // 200 where the provider ignores an unrecognised value, such as an unknown block `type`) — never 5xx.
    await deepBody(method, path, `{"${property}":${deepObject(511)}}`, `objects under ${property} at 511`, "below-500");
  }
}

/** Canonical operation call (`POST /v1/operations/notion/<operation>`), returning the framework outcome. */
async function op(operation, args, idempotencyKey) {
  const response = await fetch(`${HTTP}/v1/operations/notion/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }),
  });
  const result = await response.json();
  assert.ok(result.outcome, `${operation}: unexpected HTTP ${response.status} ${JSON.stringify(result).slice(0, 300)}`);
  return result.outcome;
}
async function opOk(operation, args, idempotencyKey) {
  const outcome = await op(operation, args, idempotencyKey);
  assert.equal(outcome.status, "ok", `${operation} ${JSON.stringify(args).slice(0, 200)}: ${JSON.stringify(outcome).slice(0, 400)}`);
  return outcome.value;
}
async function opError(operation, args, code) {
  const outcome = await op(operation, args);
  assert.equal(outcome.status, "tool_error", `${operation} ${JSON.stringify(args).slice(0, 200)}: ${JSON.stringify(outcome).slice(0, 400)}`);
  assert.equal(outcome.error.code, `tool.${code}`, JSON.stringify(outcome.error));
  return outcome.error;
}

let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${MCP_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  assert.equal(response.status, 200, `MCP ${method} -> HTTP ${response.status}`);
  const raw = await response.text();
  const type = response.headers.get("content-type") ?? "";
  const messages = type.includes("text/event-stream")
    ? raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim()))
    : [JSON.parse(raw)];
  const reply = messages.find((message) => message.id === rpcId);
  assert.ok(reply, `MCP ${method}: no JSON-RPC reply`);
  if (reply.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}
async function mcpInit() {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "notion-conformance", version: "0.1.0" } });
}
async function mcp(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(!result.isError, `${name} ${JSON.stringify(args)}: ${JSON.stringify(result).slice(0, 500)}`);
  return result.structuredContent;
}
async function mcpError(name, args, code) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(result.isError, `${name} ${JSON.stringify(args)} unexpectedly succeeded`);
  const error = result.structuredContent?.error;
  assert.ok(error, `${name}: ${JSON.stringify(result).slice(0, 400)}`);
  assert.equal(error.code, code, JSON.stringify(error));
  return error;
}

const ids = (list) => list.map((item) => item.id);
const query = (source, body, options) => post(`/v1/data_sources/${source}/query`, body, options);
const queryIds = async (source, body) => ids((await query(source, body)).json.results);
const titleOf = (page) => plain((page.properties.Name ?? page.properties.title).title);

/** One representative request per operation, all valid against the baseline (used by the unauthorized and bounded flows). */
const CALLS = {
  "users.list": ["GET", "/v1/users"],
  "users.get": ["GET", `/v1/users/${ID.ines}`],
  search: ["POST", "/v1/search", { query: "sync" }],
  "pages.create": ["POST", "/v1/pages", { parent: { page_id: ID.scratch }, properties: { title: [text("Probe")] } }],
  "pages.retrieve": ["GET", `/v1/pages/${ID.t1}`],
  "pages.update": ["PATCH", `/v1/pages/${ID.t1}`, { properties: { Estimate: { number: 9 } } }],
  "pages.retrieve-property": ["GET", `/v1/pages/${ID.t1}/properties/title`],
  "pages.move": ["POST", `/v1/pages/${ID.scratch}/move`, { parent: { type: "page_id", page_id: ID.onboarding } }],
  "pages.retrieve-markdown": ["GET", `/v1/pages/${ID.design}/markdown`],
  "pages.update-markdown": ["PATCH", `/v1/pages/${ID.scratch}/markdown`, { type: "insert_content", content: "Probe line" }],
  "databases.create": ["POST", "/v1/databases", { parent: { page_id: ID.scratch }, title: [text("Probe db")], initial_data_source: { properties: { Name: { title: {} } } } }],
  "databases.retrieve": ["GET", `/v1/databases/${ID.dbTasks}`],
  "data-sources.retrieve": ["GET", `/v1/data_sources/${ID.dsTasks}`],
  "data-sources.query": ["POST", `/v1/data_sources/${ID.dsTasks}/query`, {}],
  "data-sources.update": ["PATCH", `/v1/data_sources/${ID.dsDecisions}`, { description: [text("Probe")] }],
  "blocks.retrieve": ["GET", `/v1/blocks/${ID.designHeading}`],
  "blocks.children.list": ["GET", `/v1/blocks/${ID.design}/children`],
  "blocks.children.append": ["PATCH", `/v1/blocks/${ID.scratch}/children`, { children: [{ type: "paragraph", paragraph: { rich_text: [text("Probe")] } }] }],
  "blocks.update": ["PATCH", `/v1/blocks/${ID.designHeading}`, { heading_1: { rich_text: [text("Design principles")] } }],
  "blocks.delete": ["DELETE", `/v1/blocks/${ID.bookmark}`],
  "comments.create": ["POST", "/v1/comments", { parent: { page_id: ID.t1 }, rich_text: [text("Probe")] }],
  "comments.list": ["GET", `/v1/comments?block_id=${ID.sync0908}`],
};
const call = ([method, path, body], options) => api(method, path, { ...options, ...(body === undefined ? {} : { body }) });
const callError = ([method, path, body], status, code, textPart) => apiError(method, path, status, code, textPart, body === undefined ? {} : { body });

// ---------------------------------------------------------------------------------------------
// Drill: workspace-read (member, baseline)
// ---------------------------------------------------------------------------------------------

async function workspaceRead() {
  const context = await opOk("workspace.context", {});
  assert.equal(context.now, "2026-09-14T09:00:00.000Z", "now comes from virtual time");
  assert.equal(context.workspace.name, "Halvard Robotics");
  assert.equal(context.user.id, ID.ines);
  assert.equal(context.integration.capabilities.content, "read_update_insert");
  assert.equal(context.limits.max_rows_per_namespace, 10000);

  // Users -------------------------------------------------------------------------------------
  const me = (await get("/v1/users/me")).json;
  assert.equal(me.type, "bot");
  assert.equal(me.id, ID.agentBot);
  assert.equal(me.bot.owner.type, "workspace");
  assert.equal(me.bot.workspace_name, "Halvard Robotics");
  assert.deepEqual(await opOk("users.me", {}), me, "the canonical users.me answers the same bot");
  const sizes = [];
  let cursor;
  for (;;) {
    const page = (await get(`/v1/users?page_size=3${cursor === undefined ? "" : `&start_cursor=${cursor}`}`)).json;
    assert.equal(page.object, "list");
    assert.equal(page.type, "user");
    sizes.push(page.results.length);
    if (!page.has_more) { assert.equal(page.next_cursor, null); break; }
    cursor = page.next_cursor;
  }
  assert.deepEqual(sizes, [3, 3, 2], "eight users paginate 3/3/2");
  await apiError("GET", "/v1/users?page_size=250", 400, "validation_error", "query.page_size should be ≤ 100, instead was 250.");
  await apiError("GET", "/v1/users?page_size=-1", 400, "validation_error", "query.page_size should be ≥ 1, instead was -1.");
  // Query page_size that is not a decimal integer reaches the handler and fails with Notion's envelope, never a mapping error.
  for (const route of ["/v1/users?", `/v1/blocks/${ID.design}/children?`, `/v1/comments?block_id=${ID.sync0908}&`, `/v1/pages/${ID.t1}/properties/title?`]) {
    for (const [value, textPart] of [["abc", 'query.page_size should be a number, instead was `"abc"`.'], ["", 'instead was `""`.'], ["1e999", '`"1e999"`'], ["1.5", '`"1.5"`'], ["99999999999", "instead was 99999999999."], ["0", "instead was 0."], ["101", "instead was 101."]]) {
      await apiError("GET", `${route}page_size=${value}`, 400, "validation_error", textPart);
    }
  }
  await apiError("GET", "/v1/users?start_cursor=fd000000-0000-4000-8000-000100000099", 400, "validation_error", "The start_cursor provided is invalid.");
  const ines = (await get(`/v1/users/${ID.ines}`)).json;
  assert.equal(ines.person.email, "ines.okafor@halvard.example", "with_emails shows e-mails");
  const yuki = (await get(`/v1/users/${ID.yuki.replaceAll("-", "")}`)).json;
  assert.equal(yuki.id, ID.yuki, "32-hex ids are accepted and answered dashed");
  await apiError("GET", "/v1/users/not-a-uuid", 400, "validation_error", "path.user_id should be a valid uuid");
  const longId = (await apiError("GET", `/v1/users/${"a".repeat(4096)}`, 400, "validation_error", "path.user_id should be a valid uuid")).json;
  assert.ok(longId.message.length <= 1000 && longId.message.endsWith("…"), "a long echoed id is capped to the 1000-character message contract");
  await apiError("GET", "/v1/users/fd000000-0000-4000-8000-000100000099", 404, "object_not_found", "Could not find user with ID");

  // Search ------------------------------------------------------------------------------------
  const everything = (await post("/v1/search", {})).json;
  assert.equal(everything.type, "page_or_data_source");
  assert.equal(everything.results.length, 30, "8 live wiki pages + 5 projects + 14 tasks + 3 data sources; Roadmap 2025 is in the trash");
  assert.deepEqual(everything.request_status, { type: "complete" });
  const times = everything.results.map((item) => Date.parse(item.last_edited_time));
  assert.ok(times.every((value, index) => index === 0 || value <= times[index - 1]), "default order is last_edited_time descending");
  const sync = (await post("/v1/search", { query: "weekly SYNC" })).json;
  assert.deepEqual(ids(sync.results), [ID.sync0908, ID.sync0901], "every token matches case-insensitively, newest first");
  const ascending = (await post("/v1/search", { query: "sync", sort: { timestamp: "last_edited_time", direction: "ascending" } })).json;
  assert.deepEqual(ids(ascending.results), [ID.sync0901, ID.sync0908]);
  const sources = (await post("/v1/search", { filter: { property: "object", value: "data_source" } })).json;
  assert.equal(sources.results.length, 3);
  assert.ok(sources.results.every((item) => item.object === "data_source"));
  assert.equal((await post("/v1/search", { query: "no such title anywhere" })).json.results.length, 0);
  const first = (await post("/v1/search", { query: "sync", page_size: 1 })).json;
  assert.equal(first.has_more, true);
  assert.equal(first.next_cursor, ID.sync0908);
  const second = (await post("/v1/search", { query: "sync", page_size: 1, start_cursor: first.next_cursor })).json;
  assert.deepEqual(ids(second.results), [ID.sync0901]);
  assert.equal(second.has_more, false);
  await apiError("POST", "/v1/search", 400, "validation_error", "The start_cursor provided is invalid.", { body: { query: "sync", start_cursor: ID.home } });
  await apiError("POST", "/v1/search", 400, "validation_error", "body.filter", { body: { filter: { property: "object", value: "database" } } });
  await apiError("POST", "/v1/search", 400, "validation_error", "body.page_size should be ≥ 1, instead was 0.", { body: { page_size: 0 } });
  await apiError("POST", "/v1/search", 400, "validation_error", "body.page_size should be ≤ 100, instead was 101.", { body: { page_size: 101 } });
  await apiError("POST", "/v1/search", 400, "validation_error", 'body.page_size should be a number, instead was `"abc"`.', { body: { page_size: "abc" } });
  // A search term carrying U+FFFD arrived mangled: it fails instead of silently matching nothing, and legitimate
  // non-ASCII terms keep working.
  await apiError("POST", "/v1/search", 400, "validation_error", "body.query contains an invalid character (U+FFFD)", { body: { query: "sy\uFFFDnc" } });
  assert.equal((await post("/v1/search", { query: "sync" })).json.results.length > 0, true, "a plain search still matches");

  // Pages -------------------------------------------------------------------------------------
  const task = (await get(`/v1/pages/${ID.t1}`)).json;
  assert.equal(task.object, "page");
  assert.equal(task.parent.type, "data_source_id");
  assert.equal(task.parent.database_id, ID.dbTasks);
  assert.equal(task.properties.Status.status.name, "In progress");
  assert.equal(task.properties.Assignee.people[0].name, "Tomas Lindqvist", "people values are expanded to user objects");
  assert.equal(task.properties["Created by"].created_by.id, ID.tomas, "computed properties are materialised");
  assert.equal(task.properties["Last edited"].last_edited_time, task.last_edited_time);
  assert.deepEqual(task.properties.Project.relation, [{ id: ID.atlas }]);
  assert.equal(task.properties.Project.has_more, false);
  assert.ok(task.url.startsWith("https://www.notion.so/Firmware-bring-up-for-arm-controller-v2-"));
  const filtered = (await get(`/v1/pages/${ID.t1}?filter_properties=title&filter_properties=tdue`)).json;
  assert.deepEqual(Object.keys(filtered.properties).sort(), ["Due", "Name"]);
  await apiError("GET", `/v1/pages/${ID.t1}?filter_properties=nope`, 400, "validation_error", "Could not find property with name or id: nope");
  // A mangled filter_properties (U+FFFD from a bad percent-escape) is named where Notion documents it: on the query string.
  await apiError("GET", `/v1/pages/${ID.t1}?filter_properties=%E0%A4%A`, 400, "validation_error", "query.filter_properties contains an invalid character (U+FFFD)");
  const canonicalMangled = await opError("pages.retrieve", { page_id: ID.t1, filter_properties: ["ti\uFFFDtle"] }, "VALIDATION_ERROR");
  assert.match(canonicalMangled.message, /query\.filter_properties contains an invalid character \(U\+FFFD\)/);
  await apiError("GET", `/v1/pages/${ID.missingPage}`, 404, "object_not_found", "Could not find page with ID");
  const trashed = (await get(`/v1/pages/${ID.roadmap}`)).json;
  assert.equal(trashed.in_trash, true, "trashed pages stay readable by id");
  assert.equal(trashed.archived, true);
  const home = (await get(`/v1/pages/${ID.home}`)).json;
  assert.deepEqual(home.parent, { type: "workspace", workspace: true });
  assert.equal(home.icon.emoji, "🏠");

  // Blocks ------------------------------------------------------------------------------------
  const engineeringBlock = (await get(`/v1/blocks/${ID.engineering}`)).json;
  assert.equal(engineeringBlock.type, "child_page");
  assert.equal(engineeringBlock.child_page.title, "Engineering");
  assert.equal(engineeringBlock.parent.page_id, ID.home);
  await apiError("GET", `/v1/blocks/${ID.home}`, 404, "object_not_found", "Could not find block with ID", "a workspace-level page has no block");
  const toggle = (await get(`/v1/blocks/${ID.toggle}`)).json;
  assert.equal(toggle.type, "toggle");
  assert.equal(toggle.has_children, true);
  const pages = [];
  cursor = undefined;
  for (;;) {
    const page = (await get(`/v1/blocks/${ID.design}/children?page_size=5${cursor === undefined ? "" : `&start_cursor=${cursor}`}`)).json;
    assert.equal(page.type, "block");
    pages.push(page.results.map((block) => block.type));
    if (!page.has_more) break;
    cursor = page.next_cursor;
  }
  assert.deepEqual(pages.map((page) => page.length), [5, 5, 3], "13 top-level blocks paginate 5/5/3");
  assert.deepEqual(pages.flat().slice(0, 6), ["heading_1", "paragraph", "bulleted_list_item", "bulleted_list_item", "bulleted_list_item", "toggle"]);
  const toggleChildren = (await get(`/v1/blocks/${ID.toggle}/children`)).json;
  assert.deepEqual(toggleChildren.results.map((block) => block.type), ["to_do", "to_do", "paragraph"]);
  assert.equal(toggleChildren.results[0].to_do.checked, true);
  assert.equal((await get(`/v1/blocks/${ID.scratch}/children`)).json.results.length, 0, "an empty page lists no children");
  await apiError("GET", `/v1/blocks/${ID.design}/children?start_cursor=${ID.toggle}&page_size=0`, 400, "validation_error", "page_size");
  await apiError("GET", `/v1/blocks/${ID.roadmap}/children`, 200, undefined, undefined).catch(() => undefined);

  // Property items --------------------------------------------------------------------------
  const title = (await get(`/v1/pages/${ID.t1}/properties/title`)).json;
  assert.equal(title.object, "list");
  assert.equal(title.type, "property_item");
  assert.equal(title.results[0].title.plain_text, "Firmware bring-up for arm controller v2");
  assert.equal(title.property_item.next_url, null);
  const status = (await get(`/v1/pages/${ID.t1}/properties/tsta`)).json;
  assert.equal(status.object, "property_item");
  assert.equal(status.status.name, "In progress");
  const assignee = (await get(`/v1/pages/${ID.t1}/properties/Assignee`)).json;
  assert.equal(assignee.results[0].people.id, ID.tomas, "property names are accepted too");
  await apiError("GET", `/v1/pages/${ID.t1}/properties/zzzz`, 400, "validation_error", "Could not find property with name or id: zzzz");
  // property_id path semantics: the path is decoded once by the server; a client that percent-encodes the id again
  // (e.g. a URL-encoded Notion id such as %3AUPp sent as %253AUPp) still resolves, and malformed encodings never throw.
  for (const encoded of ["%74sta", "%2574sta"]) assert.equal((await get(`/v1/pages/${ID.t1}/properties/${encoded}`)).json.id, "tsta", encoded);
  assert.equal((await get(`/v1/pages/${ID.t1}/properties/%2541ssignee`)).json.results[0].people.id, ID.tomas);
  for (const [encoded, shownId] of [["%25", "%"], ["%25E0%25A4%25A", "%E0%A4%A"], ["%25ZZ", "%ZZ"]]) {
    await apiError("GET", `/v1/pages/${ID.t1}/properties/${encoded}`, 400, "validation_error", `Could not find property with name or id: ${shownId}`);
  }
  await apiError("GET", `/v1/pages/${ID.t1}/properties/tsta?page_size=abc`, 400, "validation_error", "query.page_size should be a number");

  // Markdown ----------------------------------------------------------------------------------
  const markdown = (await get(`/v1/pages/${ID.design}/markdown`)).json;
  assert.equal(markdown.object, "page_markdown");
  assert.ok(markdown.markdown.startsWith("# Design principles\n\nWe build robots that are **safe by default**, *boring to operate*"));
  assert.ok(markdown.markdown.includes("<details>\n<summary>Review checklist</summary>"));
  assert.ok(markdown.markdown.includes("```c\nvoid estop()"));
  assert.ok(markdown.markdown.includes(`<unknown type="bookmark" id="${ID.bookmark}"`));
  assert.deepEqual(markdown.unknown_block_ids, [ID.bookmark]);
  assert.equal((await get(`/v1/pages/${ID.scratch}/markdown`)).json.markdown, "");

  // Databases and data sources ----------------------------------------------------------------
  const database = (await get(`/v1/databases/${ID.dbTasks}`)).json;
  assert.equal(database.object, "database");
  assert.equal(database.properties, undefined, "2025-09-03 containers carry no schema");
  assert.deepEqual(database.data_sources, [{ id: ID.dsTasks, name: "Tasks" }]);
  assert.equal(database.is_inline, false);
  const source = (await get(`/v1/data_sources/${ID.dsTasks}`)).json;
  assert.equal(source.object, "data_source");
  assert.equal(source.parent.database_id, ID.dbTasks);
  assert.equal(source.database_parent.page_id, ID.home);
  assert.deepEqual(Object.keys(source.properties).sort(), ["Assignee", "Created by", "Done", "Due", "Estimate", "Last edited", "Name", "Notes", "Priority", "Project", "Status", "Tags", "Ticket"]);
  assert.equal(source.properties.Status.status.options.length, 5);
  assert.equal(source.properties.Project.relation.data_source_id, ID.dsProjects);
  assert.equal((await get(`/v1/databases/${ID.dbDecisions}`)).json.is_inline, true);
  await apiError("GET", `/v1/databases/${ID.dsTasks}`, 404, "object_not_found", "Could not find database with ID");
  await apiError("GET", "/v1/data_sources/abc", 400, "validation_error", "path.data_source_id should be a valid uuid");
  const legacy = (await post(`/v1/databases/${ID.dbTasks}/query`, { page_size: 3 })).json;
  assert.equal(legacy.results.length, 3, "the legacy database query resolves the first data source");
  assert.equal(legacy.has_more, true);
  assert.equal(legacy.results[0].id, ID.t1, "default order is creation (row-id) order");

  // Missing objects and malformed ids on every remaining route -----------------------------------
  await apiError("GET", "/v1/blocks/zzz", 400, "validation_error", "path.block_id should be a valid uuid");
  await apiError("PATCH", `/v1/blocks/${ID.missingPage}`, 404, "object_not_found", "Could not find block with ID", { body: { paragraph: { rich_text: [] } } });
  await apiError("DELETE", `/v1/blocks/${ID.missingPage}`, 404, "object_not_found", "Could not find block with ID");
  await apiError("GET", `/v1/data_sources/${ID.missingPage}`, 404, "object_not_found", "Could not find data source with ID");
  await apiError("PATCH", `/v1/data_sources/${ID.missingPage}`, 404, "object_not_found", "Could not find data source with ID", { body: { description: [] } });
  await apiError("GET", "/v1/databases/zzz", 400, "validation_error", "path.database_id should be a valid uuid");
  await apiError("POST", `/v1/pages/${ID.missingPage}/move`, 404, "object_not_found", "Could not find page with ID", { body: { parent: { type: "page_id", page_id: ID.home } } });
  await apiError("GET", "/v1/pages/zzz/markdown", 400, "validation_error", "path.page_id should be a valid uuid");
  await apiError("GET", `/v1/pages/${ID.missingPage}/properties/title`, 404, "object_not_found", "Could not find page with ID");
  await apiError("PATCH", `/v1/pages/${ID.missingPage}`, 404, "object_not_found", "Could not find page with ID", { body: { in_trash: true } });
  await apiError("PATCH", `/v1/pages/${ID.missingPage}/markdown`, 404, "object_not_found", "Could not find page with ID", { body: { type: "insert_content", content: "x" } });

  // Not part of the surface --------------------------------------------------------------------
  for (const [method, path] of [["POST", "/v1/oauth/token"], ["GET", "/v1/file_uploads"], ["POST", "/v1/data_sources"]]) {
    const response = await fetch(`${HTTP}${path}`, { method, headers: { authorization: `Bearer ${HTTP_TOKEN}` } });
    assert.ok([404, 405].includes(response.status), `${method} ${path} -> ${response.status}`);
    await response.text();
  }
}

// ---------------------------------------------------------------------------------------------
// Drill: task-triage (member, baseline)
// ---------------------------------------------------------------------------------------------

async function taskTriage() {
  const S = ID.dsTasks;
  assert.deepEqual(await queryIds(S, { filter: { property: "Status", status: { equals: "In progress" } } }), [ID.t1, "fd000000-0000-4000-8000-000200000125"]);
  assert.deepEqual(await queryIds(S, { filter: { and: [{ property: "Priority", select: { equals: "High" } }, { property: "Done", checkbox: { equals: false } }] } }), [ID.t1, ID.t3]);
  const nested = await queryIds(S, {
    filter: { or: [{ property: "Priority", select: { equals: "Urgent" } }, { and: [{ property: "Status", status: { equals: "Backlog" } }, { property: "Assignee", people: { is_empty: true } }] }] },
  });
  assert.deepEqual(nested, [ID.t4, "fd000000-0000-4000-8000-00020000012c"], "two-level nesting works");
  assert.deepEqual(await queryIds(S, { filter: { and: [{ property: "Due", date: { on_or_before: "2026-09-14" } }, { property: "Done", checkbox: { equals: false } }] } }), [ID.t3, ID.t4], "overdue + due today, open only");
  assert.deepEqual(await queryIds(S, { filter: { property: "Due", date: { equals: "2026-09-14" } } }), [ID.t3]);
  assert.deepEqual(await queryIds(S, { filter: { property: "Due", date: { next_week: {} } } }), [ID.t1, ID.t3], "today through today+7 by calendar day");
  assert.deepEqual(await queryIds(S, { filter: { timestamp: "created_time", created_time: { past_week: {} } } }), ["fd000000-0000-4000-8000-000200000127", "fd000000-0000-4000-8000-00020000012c", "fd000000-0000-4000-8000-00020000012d"]);
  assert.deepEqual(await queryIds(S, { filter: { property: "Assignee", people: { contains: ID.priya } } }), [ID.t3, "fd000000-0000-4000-8000-000200000124", "fd000000-0000-4000-8000-000200000127", "fd000000-0000-4000-8000-00020000012b"]);
  assert.equal((await queryIds(S, { filter: { property: "Project", relation: { contains: ID.beacon } } })).length, 4);
  assert.deepEqual(await queryIds(S, { filter: { property: "Tags", multi_select: { contains: "infra" } } }), ["fd000000-0000-4000-8000-000200000126", "fd000000-0000-4000-8000-00020000012b", "fd000000-0000-4000-8000-00020000012d"]);
  assert.deepEqual(await queryIds(S, { filter: { property: "Due", date: { is_empty: true } } }), ["fd000000-0000-4000-8000-000200000127", "fd000000-0000-4000-8000-000200000129", "fd000000-0000-4000-8000-00020000012c"]);
  assert.deepEqual(await queryIds(S, { filter: { property: "Name", title: { contains: "FIRMWARE" } } }), [ID.t1, ID.t4, "fd000000-0000-4000-8000-00020000012d"], "title contains is case-insensitive");
  assert.deepEqual(await queryIds(S, { filter: { property: "Estimate", number: { greater_than_or_equal_to: 8 } } }), [ID.t1, ID.t4, "fd000000-0000-4000-8000-000200000126", "fd000000-0000-4000-8000-00020000012a"]);
  assert.deepEqual(await queryIds(S, { filter: { property: "Ticket", url: { is_not_empty: true } } }), [ID.t1, ID.t4]);
  const sorted = (await query(S, { sorts: [{ property: "Due", direction: "ascending" }, { property: "Priority", direction: "descending" }], filter_properties: ["title", "tdue"] })).json;
  assert.deepEqual(Object.keys(sorted.results[0].properties).sort(), ["Due", "Name"]);
  const dues = sorted.results.map((page) => page.properties.Due.date?.start ?? null);
  const defined = dues.filter((value) => value !== null);
  assert.deepEqual(defined, [...defined].sort(), "ascending by Due");
  assert.deepEqual(dues.slice(-3), [null, null, null], "empties sort last");
  const byPriority = (await query(S, { sorts: [{ property: "Priority", direction: "descending" }], page_size: 2 })).json;
  assert.deepEqual(byPriority.results.map((page) => page.properties.Priority.select.name), ["Urgent", "High"], "select sorts by option order");
  const sizes = [];
  let cursor;
  for (;;) {
    const page = (await query(S, { page_size: 5, ...(cursor === undefined ? {} : { start_cursor: cursor }) })).json;
    sizes.push(page.results.length);
    if (!page.has_more) break;
    cursor = page.next_cursor;
  }
  assert.deepEqual(sizes, [5, 5, 4], "14 tasks paginate 5/5/4");
  assert.equal((await query(ID.dsDecisions, {})).json.results.length, 0, "the Decisions log is empty");
  await apiError("POST", `/v1/data_sources/${S}/query`, 400, "validation_error", "nests compound filters deeper than 2 levels", {
    body: { filter: { and: [{ or: [{ and: [{ property: "Done", checkbox: { equals: true } }] }] }] } },
  });
  await apiError("POST", `/v1/data_sources/${S}/query`, 400, "validation_error", "Could not find property with name or id: Nope", { body: { filter: { property: "Nope", checkbox: { equals: true } } } });
  // Mangled percent-encoding (U+FFFD) in a filter or sort is corruption, not a value to match.
  await apiError("POST", `/v1/data_sources/${S}/query`, 400, "validation_error", "body.filter.title.contains contains an invalid character (U+FFFD)", { body: { filter: { property: "Name", title: { contains: "Ro\uFFFDad" } } } });
  await apiError("POST", `/v1/data_sources/${S}/query`, 400, "validation_error", "body.filter.property contains an invalid character (U+FFFD)", { body: { filter: { property: "Na\uFFFDme", title: { contains: "a" } } } });
  await apiError("POST", `/v1/data_sources/${S}/query`, 400, "validation_error", "body.sorts[0].property contains an invalid character (U+FFFD)", { body: { sorts: [{ property: "Na\uFFFDme", direction: "ascending" }] } });
  // filter_properties is a query-string parameter of this route too (the body copy maps onto the same argument), so
  // the label is query.filter_properties whichever way it arrived.
  await apiError("POST", `/v1/data_sources/${S}/query?filter_properties=%E0%A4%A`, 400, "validation_error", "query.filter_properties contains an invalid character (U+FFFD)", { body: {} });
  await apiError("POST", `/v1/data_sources/${S}/query`, 400, "validation_error", "query.filter_properties contains an invalid character (U+FFFD)", { body: { filter_properties: ["ti\uFFFDtle"] } });
  const canonicalQueryMangled = await opError("data-sources.query", { data_source_id: S, filter_properties: ["ti\uFFFDtle"] }, "VALIDATION_ERROR");
  assert.match(canonicalQueryMangled.message, /query\.filter_properties contains an invalid character \(U\+FFFD\)/);
  await apiError("POST", `/v1/data_sources/${S}/query`, 400, "validation_error", "not a supported condition for checkbox", { body: { filter: { property: "Done", checkbox: { contains: "x" } } } });
  await apiError("POST", `/v1/data_sources/${S}/query`, 400, "validation_error", "body.filter.status should be defined", { body: { filter: { property: "Status", select: { equals: "Done" } } } });
  await apiError("POST", `/v1/data_sources/${S}/query`, 400, "validation_error", "The start_cursor provided is invalid.", { body: { start_cursor: ID.home } });
  await apiError("POST", `/v1/data_sources/${ID.missingPage}/query`, 404, "object_not_found", "Could not find data source with ID", { body: {} });
  const trashedOnly = (await query(S, { in_trash: true })).json;
  assert.equal(trashedOnly.results.length, 0);

  // Create a task -------------------------------------------------------------------------------
  const created = (
    await post("/v1/pages", {
      parent: { data_source_id: S },
      properties: {
        Name: { title: [text("Bench-test the OTA rollback")] },
        Status: { status: { name: "Todo" } },
        Assignee: { people: [{ object: "user", id: ID.tomas }] },
        Due: { date: { start: "2026-09-16" } },
        Priority: { select: { name: "Critical" } },
        Tags: { multi_select: [{ name: "firmware" }, { name: "release" }] },
        Estimate: { number: 3 },
        Project: { relation: [{ id: ID.atlas }] },
      },
    })
  ).json;
  assert.equal(created.id, ID.newPage, "ids come from the counter row (0x1000 and 0x1001 went to the two new select options)");
  assert.equal(created.created_by.id, ID.ines, "writes are attributed to the actor's userId");
  assert.equal(created.properties.Priority.select.name, "Critical", "unknown select options are created");
  assert.deepEqual(created.properties.Tags.multi_select.map((option) => option.name), ["firmware", "release"]);
  assert.equal(created.properties.Done.checkbox, false, "omitted properties get empty values");
  assert.equal(created.properties.Notes.rich_text.length, 0);
  const schema = (await get(`/v1/data_sources/${S}`)).json.properties;
  assert.ok(schema.Priority.select.options.some((option) => option.name === "Critical"), "the schema gained the option");
  assert.ok(schema.Tags.multi_select.options.some((option) => option.name === "release"));
  await apiError("POST", "/v1/pages", 400, "validation_error", "Bogus is not a property that exists.", { body: { parent: { data_source_id: S }, properties: { Bogus: { checkbox: true } } } });
  await apiError("POST", "/v1/pages", 400, "validation_error", "Status is expected to be status.", { body: { parent: { data_source_id: S }, properties: { Status: { select: { name: "Todo" } } } } });
  await apiError("POST", "/v1/pages", 400, "validation_error", "Status option", { body: { parent: { data_source_id: S }, properties: { Status: { status: { name: "Nope" } } } } });
  await apiError("POST", "/v1/pages", 400, "validation_error", "reference pages of the related data source", { body: { parent: { data_source_id: S }, properties: { Project: { relation: [{ id: ID.t1 }] } } } });
  await apiError("POST", "/v1/pages", 400, "validation_error", "integrations cannot create pages at the workspace root", { body: { parent: { type: "workspace", workspace: true }, properties: {} } });
  await apiError("POST", "/v1/pages", 404, "object_not_found", "Could not find page with ID", { body: { parent: { page_id: ID.missingPage }, properties: {} } });

  // Update it --------------------------------------------------------------------------------
  const updated = (await patch(`/v1/pages/${created.id}`, { properties: { Status: { status: { name: "Done" } }, Done: { checkbox: true }, Due: null } })).json;
  assert.equal(updated.properties.Status.status.name, "Done");
  assert.equal(updated.properties.Done.checkbox, true);
  assert.equal(updated.properties.Due.date, null, "null clears a value");
  assert.equal(updated.properties.Estimate.number, 3, "untouched properties stay");
  assert.equal((await get(`/v1/pages/${created.id}`)).json.properties.Status.status.name, "Done", "reads reflect the write");
  await apiError("PATCH", `/v1/pages/${created.id}`, 400, "validation_error", "Cannot update property", { body: { properties: { "Created by": { created_by: { id: ID.marco } } } } });
  assert.equal((await queryIds(S, { filter: { property: "Status", status: { equals: "Done" } } })).length, 5);

  // Move it out and back ------------------------------------------------------------------------
  const moved = (await post(`/v1/pages/${created.id}/move`, { parent: { type: "page_id", page_id: ID.engineering } })).json;
  assert.deepEqual(moved.parent, { type: "page_id", page_id: ID.engineering });
  assert.deepEqual(Object.keys(moved.properties), ["title"], "moving into a page keeps only the title");
  assert.equal(plain(moved.properties.title.title), "Bench-test the OTA rollback");
  const engineeringChildren = (await get(`/v1/blocks/${ID.engineering}/children`)).json.results;
  assert.equal(engineeringChildren.at(-1).id, created.id, "a child_page block appeared at the end of Engineering");
  assert.equal(engineeringChildren.at(-1).child_page.title, "Bench-test the OTA rollback");
  assert.equal((await queryIds(S, { filter: { property: "Name", title: { contains: "Bench-test" } } })).length, 0, "it left the data source");
  await apiError("POST", `/v1/pages/${ID.engineering}/move`, 400, "validation_error", "should not be the page itself or one of its descendants", { body: { parent: { type: "page_id", page_id: created.id } } });
  const back = (await post(`/v1/pages/${created.id}/move`, { parent: { type: "data_source_id", data_source_id: S } })).json;
  assert.equal(back.parent.data_source_id, S);
  assert.equal(back.properties.Status.status, null, "re-keyed to the schema with empty values");
  assert.equal(plain(back.properties.Name.title), "Bench-test the OTA rollback");
  assert.ok(!(await get(`/v1/blocks/${ID.engineering}/children`)).json.results.some((block) => block.id === created.id), "the child_page block is gone again");

  // Comments ---------------------------------------------------------------------------------
  const comment = (await post("/v1/comments", { parent: { page_id: created.id }, rich_text: [text("Scheduled for the Thursday bench slot.")] })).json;
  assert.equal(comment.object, "comment");
  assert.equal(comment.created_by.id, ID.ines);
  assert.deepEqual(comment.display_name, { type: "user", resolved_name: "Ines Okafor" });
  const reply = (await post("/v1/comments", { discussion_id: comment.discussion_id, rich_text: [text("Ack, "), { type: "mention", mention: { user: { id: ID.tomas } } }] })).json;
  assert.equal(reply.discussion_id, comment.discussion_id);
  assert.equal(reply.parent.page_id, created.id);
  assert.equal(reply.rich_text[1].plain_text, "@Tomas Lindqvist");
  await apiError("POST", "/v1/comments", 400, "validation_error", "exactly one of body.parent or body.discussion_id", { body: { rich_text: [text("x")] } });
  await apiError("POST", "/v1/comments", 400, "validation_error", "non-empty", { body: { parent: { page_id: created.id }, rich_text: [] } });
  await apiError("POST", "/v1/comments", 404, "object_not_found", "Could not find discussion with ID", { body: { discussion_id: "fd000000-0000-4000-8000-000800000099", rich_text: [text("x")] } });
  const firstComment = (await get(`/v1/comments?block_id=${created.id}&page_size=1`)).json;
  assert.equal(firstComment.results.length, 1);
  assert.equal(firstComment.next_cursor, comment.id);
  const secondComment = (await get(`/v1/comments?block_id=${created.id}&page_size=1&start_cursor=${firstComment.next_cursor}`)).json;
  assert.deepEqual(ids(secondComment.results), [reply.id]);
  assert.equal(secondComment.has_more, false);
  await apiError("GET", "/v1/comments", 400, "validation_error", "arguments do not match notion.comments.list");
  await apiError("GET", `/v1/comments?block_id=${ID.missingPage}`, 404, "object_not_found", "Could not find block with ID");
}

// ---------------------------------------------------------------------------------------------
// Drill: page-authoring (member, baseline)
// ---------------------------------------------------------------------------------------------

async function pageAuthoring() {
  const created = (
    await post("/v1/pages", {
      parent: { page_id: ID.onboarding },
      properties: { title: [text("Lab safety refresher")] },
      icon: { type: "emoji", emoji: "🧪" },
      children: [
        { object: "block", type: "heading_2", heading_2: { rich_text: [text("Before you start")] } },
        { type: "paragraph", paragraph: { rich_text: [text("Read this "), { type: "text", text: { content: "carefully" }, annotations: { bold: true } }, text(".")] } },
        {
          type: "bulleted_list_item",
          bulleted_list_item: {
            rich_text: [text("Wear goggles")],
            children: [{ type: "bulleted_list_item", bulleted_list_item: { rich_text: [text("Even for demos")], children: [{ type: "paragraph", paragraph: { rich_text: [text("No exceptions.")] } }] } }],
          },
        },
        { type: "to_do", to_do: { rich_text: [text("Sign the attendance sheet")], checked: false } },
      ],
    })
  ).json;
  assert.equal(created.icon.emoji, "🧪");
  const onboardingChildren = (await get(`/v1/blocks/${ID.onboarding}/children`)).json.results;
  assert.equal(onboardingChildren.at(-1).type, "child_page");
  assert.equal(onboardingChildren.at(-1).id, created.id);
  const children = (await get(`/v1/blocks/${created.id}/children`)).json.results;
  assert.deepEqual(children.map((block) => block.type), ["heading_2", "paragraph", "bulleted_list_item", "to_do"]);
  assert.equal(children[2].has_children, true);
  const grandchildren = (await get(`/v1/blocks/${children[2].id}/children`)).json.results;
  assert.equal(grandchildren.length, 1);
  assert.equal((await get(`/v1/blocks/${grandchildren[0].id}/children`)).json.results[0].paragraph.rich_text[0].plain_text, "No exceptions.");
  assert.equal((await get(`/v1/pages/${ID.onboarding}`)).json.last_edited_time, "2026-09-14T09:00:00.000Z", "the parent page was touched");

  // Append after a sibling ----------------------------------------------------------------------
  const appended = (
    await patch(`/v1/blocks/${created.id}/children`, {
      children: [{ type: "callout", callout: { rich_text: [text("Emergency stop is the red button.")], icon: { type: "emoji", emoji: "🛑" } } }, { type: "divider", divider: {} }],
      after: children[0].id,
    })
  ).json;
  assert.equal(appended.object, "list");
  assert.deepEqual(appended.results.map((block) => block.type), ["callout", "divider"]);
  assert.equal(appended.has_more, false);
  const reordered = (await get(`/v1/blocks/${created.id}/children`)).json.results;
  assert.deepEqual(reordered.map((block) => block.type), ["heading_2", "callout", "divider", "paragraph", "bulleted_list_item", "to_do"]);
  await apiError("PATCH", `/v1/blocks/${created.id}/children`, 400, "validation_error", "body.children.length should be ≤ 100", {
    body: { children: Array.from({ length: 101 }, () => ({ type: "paragraph", paragraph: { rich_text: [text("x")] } })) },
  });
  const deep = { type: "bulleted_list_item", bulleted_list_item: { rich_text: [text("1")], children: [{ type: "bulleted_list_item", bulleted_list_item: { rich_text: [text("2")], children: [{ type: "bulleted_list_item", bulleted_list_item: { rich_text: [text("3")], children: [{ type: "paragraph", paragraph: { rich_text: [text("4")] } }] } }] } }] } };
  await apiError("PATCH", `/v1/blocks/${created.id}/children`, 400, "validation_error", "deeper than 2 levels", { body: { children: [deep] } });
  await apiError("PATCH", `/v1/blocks/${created.id}/children`, 400, "validation_error", "body.children[0].type should be one of", { body: { children: [{ type: "table", table: { table_width: 2 } }] } });
  await apiError("PATCH", `/v1/blocks/${created.id}/children`, 400, "validation_error", 'should be "text" or "mention"', { body: { children: [{ type: "paragraph", paragraph: { rich_text: [{ type: "equation", equation: { expression: "e=mc^2" } }] } }] } });
  await apiError("PATCH", `/v1/blocks/${created.id}/children`, 400, "validation_error", "body.after should be the id of a child block", { body: { children: [{ type: "paragraph", paragraph: { rich_text: [text("x")] } }], after: ID.toggle } });
  await apiError("PATCH", `/v1/blocks/${reordered[2].id}/children`, 400, "validation_error", "do not support children", { body: { children: [{ type: "paragraph", paragraph: { rich_text: [text("x")] } }] } });
  await apiError("PATCH", `/v1/blocks/${ID.missingPage}/children`, 404, "object_not_found", "Could not find block with ID", { body: { children: [{ type: "paragraph", paragraph: { rich_text: [text("x")] } }] } });

  // Update blocks -----------------------------------------------------------------------------
  const paragraph = reordered[3];
  const edited = (await patch(`/v1/blocks/${paragraph.id}`, { paragraph: { rich_text: [text("Read this twice.")], color: "blue_background" } })).json;
  assert.equal(edited.paragraph.rich_text[0].plain_text, "Read this twice.");
  assert.equal(edited.paragraph.color, "blue_background");
  const todo = reordered[5];
  const checked = (await patch(`/v1/blocks/${todo.id}`, { to_do: { checked: true } })).json;
  assert.equal(checked.to_do.checked, true);
  assert.equal(checked.to_do.rich_text[0].plain_text, "Sign the attendance sheet", "partial updates keep the text");
  const wrapped = (await patch(`/v1/blocks/${reordered[0].id}`, { type: { heading_2: { rich_text: [text("Before you begin")] } } })).json;
  assert.equal(wrapped.heading_2.rich_text[0].plain_text, "Before you begin", "the MCP wrapper form is accepted");
  await apiError("PATCH", `/v1/blocks/${paragraph.id}`, 400, "validation_error", "a block's type cannot be changed", { body: { heading_1: { rich_text: [text("x")] } } });
  await apiError("PATCH", `/v1/blocks/${created.id}`, 400, "validation_error", "child_page blocks are updated through", { body: { paragraph: { rich_text: [] } } });

  // Delete and restore ----------------------------------------------------------------------------
  const deleted = (await del(`/v1/blocks/${reordered[4].id}`)).json;
  assert.equal(deleted.archived, true);
  assert.equal(deleted.in_trash, true);
  const afterDelete = (await get(`/v1/blocks/${created.id}/children`)).json.results;
  assert.deepEqual(afterDelete.map((block) => block.type), ["heading_2", "callout", "divider", "paragraph", "to_do"]);
  assert.equal((await get(`/v1/blocks/${reordered[4].id}`)).json.archived, true, "trashed blocks stay readable");
  assert.equal((await get(`/v1/blocks/${grandchildren[0].id}`)).json.in_trash, true, "descendants are trashed too");
  const restored = (await patch(`/v1/blocks/${reordered[4].id}`, { archived: false })).json;
  assert.equal(restored.in_trash, false);
  assert.equal((await get(`/v1/blocks/${created.id}/children`)).json.results.length, 6);
  assert.equal((await get(`/v1/blocks/${grandchildren[0].id}`)).json.in_trash, false);
  await apiError("DELETE", `/v1/blocks/${created.id}`, 400, "validation_error", "child_page blocks cannot be deleted here");
  await apiError("DELETE", "/v1/blocks/zzz", 400, "validation_error", "path.block_id should be a valid uuid");

  // Markdown --------------------------------------------------------------------------------------
  const before = (await get(`/v1/pages/${created.id}/markdown`)).json;
  assert.ok(before.markdown.startsWith("## Before you begin\n\n> 🛑 Emergency stop is the red button.\n\n---\n\nRead this twice."));
  await apiError("PATCH", `/v1/pages/${created.id}/markdown`, 400, "validation_error", "Set allow_deleting_content to true", { body: { type: "replace_content", new_str: "# Fresh" } });
  await apiError("PATCH", `/v1/pages/${created.id}/markdown`, 400, "validation_error", "was not found in the page content", { body: { type: "update_content", content_updates: [{ old_str: "never there", new_str: "x" }] } });
  await apiError("PATCH", `/v1/pages/${created.id}/markdown`, 400, "validation_error", "allow_async", { body: { type: "insert_content", content: "x", allow_async: true } });
  await apiError("PATCH", `/v1/pages/${created.id}/markdown`, 400, "validation_error", "body.type should be one of", { body: { type: "replace_content_range", new_str: "x" } });
  const inserted = (await patch(`/v1/pages/${created.id}/markdown`, { type: "insert_content", content: "### Checklist\n\n- [ ] Badge visible\n- [x] Goggles on", position: { type: "end" } })).json;
  assert.ok(inserted.markdown.endsWith("### Checklist\n\n- [ ] Badge visible\n- [x] Goggles on"));
  const updatedMarkdown = (await patch(`/v1/pages/${created.id}/markdown`, { type: "update_content", content_updates: [{ old_str: "Read this twice.", new_str: "Read this **three** times." }] })).json;
  assert.ok(updatedMarkdown.markdown.includes("Read this **three** times."));
  assert.equal((await get(`/v1/blocks/${paragraph.id}`)).json.paragraph.rich_text[1].annotations.bold, true, "the paragraph was updated in place (same block id)");
  const fresh = "# Fresh start\n\nA paragraph with *italics* and a [link](https://docs.example/safety).\n\n- one\n- two\n\n1. first\n2. second\n\n> A quote\n\n> 💡 A callout\n\n```python\nprint(1)\n```\n\n---\n\n<details>\n<summary>More</summary>\n\nHidden text.\n\n</details>";
  const replaced = (await patch(`/v1/pages/${created.id}/markdown`, { type: "replace_content", new_str: fresh, allow_deleting_content: true })).json;
  assert.equal(replaced.markdown, fresh, "the dialect round-trips");
  assert.equal((await get(`/v1/pages/${created.id}/markdown`)).json.markdown, fresh);
  const replacedBlocks = (await get(`/v1/blocks/${created.id}/children`)).json.results;
  assert.deepEqual(replacedBlocks.map((block) => block.type), ["heading_1", "paragraph", "bulleted_list_item", "bulleted_list_item", "numbered_list_item", "numbered_list_item", "quote", "callout", "code", "divider", "toggle"]);
  assert.equal(replacedBlocks[7].callout.icon.emoji, "💡");
  assert.equal(replacedBlocks[8].code.language, "python");
  await apiError("GET", `/v1/pages/${ID.missingPage}/markdown`, 404, "object_not_found", "Could not find page with ID");

  // Databases --------------------------------------------------------------------------------------
  const database = (
    await post("/v1/databases", {
      parent: { page_id: created.id },
      title: [text("Sprint retro")],
      is_inline: true,
      initial_data_source: { properties: { Name: { title: {} }, "Went well": { rich_text: {} }, Owner: { people: {} }, Mood: { select: { options: [{ name: "😀", color: "green" }, { name: "😐" }] } } } },
    })
  ).json;
  assert.equal(database.object, "database");
  assert.equal(database.is_inline, true);
  assert.equal(database.data_sources.length, 1);
  const sourceId = database.data_sources[0].id;
  assert.equal((await get(`/v1/blocks/${created.id}/children`)).json.results.at(-1).type, "child_database");
  const source = (await get(`/v1/data_sources/${sourceId}`)).json;
  assert.deepEqual(Object.keys(source.properties).sort(), ["Mood", "Name", "Owner", "Went well"]);
  assert.equal(source.properties.Mood.select.options[1].color, "default");
  await apiError("POST", "/v1/databases", 400, "validation_error", "exactly one property of type title", { body: { parent: { page_id: created.id }, initial_data_source: { properties: { A: { rich_text: {} } } } } });
  await apiError("POST", "/v1/databases", 400, "validation_error", "supported property type", { body: { parent: { page_id: created.id }, initial_data_source: { properties: { Name: { title: {} }, F: { formula: { expression: "1" } } } } } });
  await apiError("POST", "/v1/databases", 404, "object_not_found", "Could not find page with ID", { body: { parent: { page_id: ID.missingPage }, initial_data_source: { properties: { Name: { title: {} } } } } });
  const row = (await post("/v1/pages", { parent: { database_id: database.id }, properties: { Name: { title: [text("Retro 1")] }, "Went well": { rich_text: [text("Shipped on time")] }, Owner: { people: [{ id: ID.priya }] } } })).json;
  assert.equal(row.parent.data_source_id, sourceId, "the legacy database_id parent resolves to the first data source");
  const reshaped = (await patch(`/v1/data_sources/${sourceId}`, { properties: { Score: { number: { format: "percent" } }, "Went well": { name: "Highlights" }, Owner: null }, description: [text("One row per sprint")] })).json;
  assert.deepEqual(Object.keys(reshaped.properties).sort(), ["Highlights", "Mood", "Name", "Score"]);
  assert.equal(reshaped.properties.Score.number.format, "percent");
  assert.equal(reshaped.description[0].plain_text, "One row per sprint");
  const rowAfter = (await get(`/v1/pages/${row.id}`)).json;
  assert.equal(plain(rowAfter.properties.Highlights.rich_text), "Shipped on time", "values follow the rename");
  assert.equal(rowAfter.properties.Owner, undefined, "removed properties disappear from pages");
  assert.equal(rowAfter.properties.Score.number, null, "added properties are materialised empty");
  await apiError("PATCH", `/v1/data_sources/${sourceId}`, 400, "validation_error", "The title property cannot be removed.", { body: { properties: { Name: null } } });
  await apiError("PATCH", `/v1/data_sources/${sourceId}`, 400, "validation_error", "is not a property that exists", { body: { properties: { Ghost: null } } });
  // A property cannot be named __proto__ (the key would vanish from plain-object schemas).
  await apiError("PATCH", `/v1/data_sources/${sourceId}`, 400, "validation_error", "uses the reserved property name __proto__", { body: { properties: { Highlights: { name: "__proto__" } } } });
  const retyped = (await patch(`/v1/data_sources/${sourceId}`, { properties: { Highlights: { checkbox: {} } } })).json;
  assert.equal(retyped.properties.Highlights.type, "checkbox");
  assert.equal((await get(`/v1/pages/${row.id}`)).json.properties.Highlights.checkbox, false, "retyping clears values");
  const queried = (await query(sourceId, { filter: { property: "Name", title: { starts_with: "retro" } } })).json;
  assert.deepEqual(ids(queried.results), [row.id]);
  const trashedSource = (await patch(`/v1/data_sources/${sourceId}`, { in_trash: true })).json;
  assert.equal(trashedSource.in_trash, true);
  assert.equal((await get(`/v1/pages/${row.id}`)).json.in_trash, true, "trashing a source trashes its pages");
  assert.equal((await query(sourceId, {})).json.results.length, 0);
  assert.equal((await query(sourceId, { in_trash: true })).json.results.length, 1);

  // Bounded markdown parsing: adversarial markers and nesting answer declared errors quickly ---------
  // Request bodies stay below 64 KiB here: larger drill arguments stop `firedrill tool test` itself (framework limit, see
  // specs/notion/VERIFICATION.md); the 100 000-character cases are reproduced there against `firedrill serve`.
  const MD = `/v1/pages/${created.id}/markdown`;
  const legit = "- one\n  - two\n    - three\n- **bold**, *italic*, ~~gone~~, `code` and [link](https://docs.example/n)\n\n<details>\n<summary>Outer</summary>\n\n- inner\n  - deeper\n\n</details>\n\nanchor-line";
  assert.ok((await patch(MD, { type: "insert_content", content: legit })).json.markdown.endsWith(`\n\n${legit}`), "two-level lists, inline marks and a details block round-trip");
  const quick = async (label, run) => {
    const started = performance.now();
    const result = await run();
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 3000, `${label} took ${Math.round(elapsed)} ms`);
    return result;
  };
  const tooLong = "text.content.length should be ≤ 2000";
  const nestedTooDeep = "body.content[0].children[0].children[0].children nests blocks deeper than 2 levels in one request.";
  // replace_content checks that the page's inline database survives before validating rich text, so for the rich-text
  // cases that guard answers (after a parse that must still be fast); parser errors (nesting, block count) come first.
  const keepsDatabase = "child pages and databases cannot be removed through markdown";
  for (const [label, content, textPart, replaceTextPart = textPart] of [
    ["[ x60000", "[".repeat(60000), tooLong, keepsDatabase],
    ["[a]( x15000", "[a](".repeat(15000), tooLong, keepsDatabase],
    ["` x60000", "`".repeat(60000), "code.language should be a supported language", keepsDatabase],
    ["<details> x3", "<details>\n".repeat(3) + "x", nestedTooDeep],
    ["<details> x3000", "<details>\n".repeat(3000) + "x", nestedTooDeep],
    ["<details> x6000", "<details>\n".repeat(6000) + "x", nestedTooDeep],
    ["indented list x200", Array.from({ length: 200 }, (_, i) => `${"  ".repeat(i)}- x`).join("\n"), nestedTooDeep],
    ["1001 paragraphs", Array.from({ length: 1001 }, (_, i) => `p${i}`).join("\n\n"), "should contain ≤ 1000 block elements"],
  ]) {
    await quick(`insert ${label}`, () => apiError("PATCH", MD, 400, "validation_error", textPart, { body: { type: "insert_content", content } }));
    await quick(`replace ${label}`, () => apiError("PATCH", MD, 400, "validation_error", replaceTextPart, { body: { type: "replace_content", new_str: content, allow_deleting_content: true } }));
  }
  const canonicalError = await quick("canonical <details> x6000", () => opError("pages.update-markdown", { page_id: created.id, type: "insert_content", content: "<details>\n".repeat(6000) + "x" }, "VALIDATION_ERROR"));
  assert.ok(canonicalError.message.includes(nestedTooDeep), canonicalError.message);
  await quick("canonical [ x60000", () => opError("pages.update-markdown", { page_id: created.id, type: "replace_content", new_str: "[".repeat(60000), allow_deleting_content: true }, "VALIDATION_ERROR"));
  await quick("update_content <details> x6000", () =>
    apiError("PATCH", MD, 400, "validation_error", "the markdown nests blocks deeper than 64 levels", { body: { type: "update_content", content_updates: [{ old_str: "anchor-line", new_str: "<details>\n".repeat(6000) + "x" }] } }));
  // update_content: the size of every step is checked before it is built, the entry count is capped, replacements are literal.
  const doubling = Array.from({ length: 25 }, () => ({ old_str: "e", new_str: "ee", replace_all_matches: true }));
  await quick("update_content e->ee x25", () => apiError("PATCH", MD, 400, "validation_error", "the resulting markdown exceeds 102400 bytes (at body.content_updates[", { body: { type: "update_content", content_updates: doubling } }));
  await quick("update_content 101 entries", () =>
    apiError("PATCH", MD, 400, "validation_error", "body.content_updates.length should be ≤ 100, instead was 101.", { body: { type: "update_content", content_updates: Array.from({ length: 101 }, () => ({ old_str: "anchor-line", new_str: "anchor-line" })) } }));
  await apiError("PATCH", MD, 400, "validation_error", "body.content_updates[0].old_str matched more than one place; make it unique or set replace_all_matches to true.", { body: { type: "update_content", content_updates: [{ old_str: "e", new_str: "x" }] } });
  const literal = (await patch(MD, { type: "update_content", content_updates: [{ old_str: "anchor-line", new_str: "anchor-$&-line" }] })).json.markdown;
  assert.ok(literal.endsWith("anchor-$&-line"), "new_str is inserted literally ($& is not a pattern)");
  await patch(MD, { type: "update_content", content_updates: [{ old_str: "anchor-$&-line", new_str: "anchor-line" }] });
  // Replacing a page's blocks again and again stays fast and exact: trashed blocks are never renumbered or rescanned per
  // entry. (300 short paragraphs keep the drill evidence small; the 1000-block x8 case is timed in VERIFICATION.md.)
  const bulk = (await post("/v1/pages", { parent: { page_id: created.id }, properties: { title: [text("Bulk")] } })).json;
  for (let round = 0; round < 4; round += 1) {
    const doc = Array.from({ length: 300 }, (_, i) => `${round}.${i}`).join("\n\n");
    const replaced = (await quick(`replace 1000 blocks #${round}`, () => patch(`/v1/pages/${bulk.id}/markdown`, { type: "replace_content", new_str: doc, allow_deleting_content: true }))).json;
    assert.equal(replaced.markdown, doc, `replace #${round} renders exactly the new document`);
  }
  const bulkChildren = (await get(`/v1/blocks/${bulk.id}/children?page_size=2`)).json.results;
  assert.deepEqual(bulkChildren.map((block) => plain(block.paragraph.rich_text)), ["3.0", "3.1"]);
  for (const marker of ["**", "~~"]) {
    const markdown = (await quick(`${marker} x30000`, () => patch(MD, { type: "insert_content", content: marker.repeat(30000) }))).json.markdown;
    assert.ok(markdown.includes(legit), "paired markers only toggle formatting");
  }
  // 150 toggle levels is about 450 JSON levels, below the codec's 512 bound, so the handler's own bound answers.
  let deepChild = { type: "paragraph", paragraph: { rich_text: [] } };
  for (let level = 0; level < 150; level += 1) deepChild = { type: "toggle", toggle: { rich_text: [] }, children: [deepChild] };
  await quick("append nested 150 deep", () => apiError("PATCH", `/v1/blocks/${created.id}/children`, 400, "validation_error", "body.children[0].children[0].children[0].children nests blocks deeper than 2 levels", { body: { children: [deepChild] } }));
  await assertDeepBodiesRefused(created.id);
  // Stored trees stay within 64 levels below the page: 21 appends of three levels reach 63, one more level is allowed.
  const toggleChain = (label) => ({ type: "toggle", toggle: { rich_text: [text(`${label}.1`)] }, children: [{ type: "toggle", toggle: { rich_text: [text(`${label}.2`)] }, children: [{ type: "toggle", toggle: { rich_text: [text(`${label}.3`)] } }] }] });
  let chainParent = created.id;
  for (let round = 0; round < 21; round += 1) {
    let id = (await patch(`/v1/blocks/${chainParent}/children`, { children: [toggleChain(`r${round}`)] })).json.results[0].id;
    for (let step = 0; step < 2; step += 1) id = (await get(`/v1/blocks/${id}/children`)).json.results[0].id;
    chainParent = id;
  }
  await apiError("PATCH", `/v1/blocks/${chainParent}/children`, 400, "validation_error", "would nest blocks 66 levels below the page; the limit is 64", { body: { children: [toggleChain("over")] } });
  await patch(`/v1/blocks/${chainParent}/children`, { children: [{ type: "paragraph", paragraph: { rich_text: [text("level 64")] } }] });
  const deepMarkdown = (await quick("retrieve 64-level page", () => get(MD))).json.markdown;
  assert.ok(deepMarkdown.includes("<summary>r20.3</summary>") && deepMarkdown.includes("level 64"), "the 64-level tree renders");
}

// ---------------------------------------------------------------------------------------------
// Drill: trash-and-restore (member, baseline)
// ---------------------------------------------------------------------------------------------

async function trashAndRestore() {
  const seededTrash = await opOk("workspace.trash", {});
  assert.equal(seededTrash.type, "page_or_database");
  assert.deepEqual(ids(seededTrash.results), [ID.roadmap], "only the seeded Roadmap 2025 page starts in the trash");
  await opError("workspace.trash", { page_size: 0 }, "VALIDATION_ERROR");
  const trashed = (await patch(`/v1/pages/${ID.meetings}`, { in_trash: true })).json;
  assert.equal(trashed.in_trash, true);
  assert.equal(trashed.archived, true);
  const afterTrash = await opOk("workspace.trash", { page_size: 1 });
  assert.deepEqual(ids(afterTrash.results), [ID.meetings], "the newest deletion comes first and children of a trashed page are not listed as roots");
  assert.equal(afterTrash.has_more, true);
  assert.equal(afterTrash.next_cursor, ID.meetings);
  const child = (await get(`/v1/pages/${ID.sync0908}`)).json;
  assert.equal(child.in_trash, true, "child pages are trashed with their parent");
  assert.equal((await get(`/v1/blocks/${ID.actionItem}`)).json.in_trash, true, "blocks are trashed with their page");
  assert.equal((await post("/v1/search", { query: "sync" })).json.results.length, 0, "trashed pages leave search");
  assert.equal((await post("/v1/search", { query: "meeting" })).json.results.length, 0);
  assert.ok(!(await get(`/v1/blocks/${ID.home}/children`)).json.results.some((block) => block.id === ID.meetings), "the child_page block left the listing");
  await apiError("PATCH", `/v1/pages/${ID.sync0908}`, 400, "validation_error", "Can't edit block that is archived", { body: { properties: { title: [text("x")] } } });
  await apiError("POST", `/v1/pages/${ID.scratch}/move`, 400, "validation_error", "in the trash", { body: { parent: { type: "page_id", page_id: ID.meetings } } });
  const restored = (await patch(`/v1/pages/${ID.meetings}`, { archived: false })).json;
  assert.equal(restored.in_trash, false);
  assert.equal((await get(`/v1/pages/${ID.sync0908}`)).json.in_trash, false, "the subtree came back");
  assert.equal((await get(`/v1/blocks/${ID.actionItem}`)).json.in_trash, false);
  assert.deepEqual(ids((await post("/v1/search", { query: "sync" })).json.results), [ID.sync0908, ID.sync0901]);
  assert.equal((await post("/v1/search", { query: "roadmap" })).json.results.length, 0, "the seeded trashed page is hidden");
  const roadmap = (await patch(`/v1/pages/${ID.roadmap}`, { in_trash: false })).json;
  assert.equal(roadmap.in_trash, false);
  assert.deepEqual(ids((await post("/v1/search", { query: "roadmap" })).json.results), [ID.roadmap]);
  assert.equal((await get(`/v1/blocks/${ID.roadmap}/children`)).json.results.length, 1, "its paragraph is back");
  const emptied = await opOk("workspace.trash", {});
  assert.deepEqual(emptied.results, [], "the trash is empty once everything is restored");
  assert.equal(emptied.has_more, false);
}

// ---------------------------------------------------------------------------------------------
// Drill: mcp-aliases (member, baseline)
// ---------------------------------------------------------------------------------------------

async function mcpAliases() {
  await mcpInit();
  const tools = (await rpc("tools/list", {})).tools.map((tool) => tool.name);
  for (const alias of ALIASES) assert.ok(tools.includes(alias), `alias ${alias} missing`);
  for (const operationId of ALL_OPERATIONS) assert.ok(tools.includes(`notion.${operationId}`), `canonical notion.${operationId} missing`);
  assert.equal(tools.length, ALIASES.length + ALL_OPERATIONS.length);
  const me = await mcp("API-get-self", {});
  assert.equal(me.id, ID.agentBot);
  const search = await mcp("API-post-search", { query: "design", filter: { property: "object", value: "page" } });
  assert.deepEqual(ids(search.results), [ID.design]);
  const page = await mcp("API-retrieve-a-page", { page_id: ID.t3 });
  assert.equal(page.properties.Status.status.name, "Todo");
  const queried = await mcp("API-query-data-source", { data_source_id: ID.dsTasks, filter: { property: "Assignee", people: { contains: ID.priya } }, page_size: 2 });
  assert.equal(queried.results.length, 2);
  assert.equal(queried.has_more, true);
  const children = await mcp("API-get-block-children", { block_id: ID.sync0908, page_size: 3 });
  assert.equal(children.results.length, 3);
  const updated = await mcp("API-patch-page", { page_id: ID.t3, properties: { Status: { status: { name: "In progress" } } } });
  assert.equal(updated.properties.Status.status.name, "In progress");
  const block = await mcp("API-update-a-block", { block_id: ID.actionItem, type: { to_do: { checked: true } } });
  assert.equal(block.to_do.checked, true);
  const comments = await mcp("API-retrieve-a-comment", { block_id: ID.sync0908, page_size: 2 });
  assert.equal(comments.results.length, 2);
  assert.equal(comments.has_more, true);
  const missing = await mcpError("API-retrieve-a-page", { page_id: ID.missingPage }, "tool.OBJECT_NOT_FOUND");
  assert.ok(missing.message.includes("Could not find page with ID"));
}

// ---------------------------------------------------------------------------------------------
// Drill: scope-notes-bot (notes-bot, baseline)
// ---------------------------------------------------------------------------------------------

async function scopeNotesBot() {
  const me = await opOk("users.me", {});
  assert.equal((await get("/v1/users/me")).json.id, ID.notesBot, "GET /v1/users/me is served by users.get");
  assert.equal(me.id, ID.notesBot);
  assert.equal(me.name, "Notes Sync");
  const page = (await get(`/v1/pages/${ID.sync0908}`)).json;
  assert.equal(page.id, ID.sync0908);
  assert.deepEqual(page.created_by, { object: "user", id: ID.priya });
  const children = (await get(`/v1/blocks/${ID.sync0908}/children`)).json.results;
  assert.equal(children.length, 8);
  await apiError("GET", `/v1/pages/${ID.engineering}`, 404, "object_not_found", "shared with your integration");
  await apiError("GET", `/v1/pages/${ID.t1}`, 404, "object_not_found", "Could not find page with ID");
  await apiError("GET", `/v1/blocks/${ID.design}/children`, 404, "object_not_found");
  await apiError("GET", `/v1/databases/${ID.dbTasks}`, 404, "object_not_found");
  const search = (await post("/v1/search", {})).json;
  assert.deepEqual(ids(search.results).sort(), [ID.meetings, ID.sync0908, ID.sync0901].sort(), "only the shared subtree is searchable");
  const comments = (await get(`/v1/comments?block_id=${ID.sync0908}`)).json;
  assert.equal(comments.results.length, 3);
  assert.deepEqual(comments.results[0].created_by, { object: "user", id: ID.marco }, "user_information: none hides names and e-mails");
  await apiError("POST", "/v1/pages", 403, "restricted_resource", "insert content capabilities", { body: { parent: { page_id: ID.meetings }, properties: { title: [text("x")] } } });
  await apiError("PATCH", `/v1/pages/${ID.sync0908}`, 403, "restricted_resource", "update content capabilities", { body: { properties: { title: [text("x")] } } });
  await apiError("POST", `/v1/pages/${ID.sync0901}/move`, 403, "restricted_resource", "update content capabilities", { body: { parent: { type: "page_id", page_id: ID.meetings } } });
  await apiError("PATCH", `/v1/pages/${ID.sync0908}/markdown`, 403, "restricted_resource", "update content capabilities", { body: { type: "insert_content", content: "x" } });
  await apiError("POST", "/v1/databases", 403, "restricted_resource", "insert content capabilities", { body: { parent: { page_id: ID.meetings }, initial_data_source: { properties: { Name: { title: {} } } } } });
  await apiError("PATCH", `/v1/data_sources/${ID.dsTasks}`, 403, "restricted_resource", "update content capabilities", { body: { description: [] } });
  await apiError("PATCH", `/v1/blocks/${ID.sync0908}/children`, 403, "restricted_resource", "insert content capabilities", { body: { children: [{ type: "paragraph", paragraph: { rich_text: [text("x")] } }] } });
  await apiError("PATCH", `/v1/blocks/${ID.actionItem}`, 403, "restricted_resource", "update content capabilities", { body: { to_do: { checked: true } } });
  await apiError("DELETE", `/v1/blocks/${ID.actionItem}`, 403, "restricted_resource", "update content capabilities");
  await apiError("POST", "/v1/comments", 403, "restricted_resource", "insert comment capabilities", { body: { parent: { page_id: ID.sync0908 }, rich_text: [text("x")] } });
  await apiError("GET", "/v1/users", 403, "restricted_resource", "user information capabilities");
  await apiError("GET", `/v1/users/${ID.ines}`, 403, "restricted_resource", "user information capabilities");
  assert.equal((await get(`/v1/pages/${ID.sync0908}`)).json.last_edited_time, "2026-09-08T10:05:00.000Z", "nothing was written");
}

// ---------------------------------------------------------------------------------------------
// Drill: scope-board-bot (board-bot, baseline)
// ---------------------------------------------------------------------------------------------

async function scopeBoardBot() {
  const me = await opOk("users.me", {});
  assert.equal(me.name, "Status Board");
  const users = (await get("/v1/users")).json;
  assert.equal(users.results.length, 8);
  assert.deepEqual(users.results[0].person, {}, "without_emails hides e-mail addresses");
  assert.equal(users.results[0].name, "Ines Okafor", "but names stay visible");
  assert.deepEqual((await get(`/v1/users/${ID.yuki}`)).json.person, {});
  const task = (await get(`/v1/pages/${ID.t1}`)).json;
  assert.equal(task.properties.Assignee.people[0].name, "Tomas Lindqvist");
  assert.equal(task.properties.Assignee.people[0].person.email, undefined);
  assert.equal((await post("/v1/search", { query: "engineering" })).json.results.length, 1, "workspace-wide access");
  await apiError("GET", `/v1/comments?block_id=${ID.sync0908}`, 403, "restricted_resource", "read comment capabilities");
  await apiError("POST", "/v1/comments", 403, "restricted_resource", "insert comment capabilities", { body: { parent: { page_id: ID.sync0908 }, rich_text: [text("x")] } });
}

// ---------------------------------------------------------------------------------------------
// Drill: scope-stranger (stranger, baseline)
// ---------------------------------------------------------------------------------------------

async function scopeStranger() {
  for (const operationId of ALL_OPERATIONS) {
    if (operationId === "workspace.context" || operationId === "workspace.trash" || operationId === "users.me") {
      await opError(operationId, {}, "UNAUTHORIZED");
      continue;
    }
    await callError(CALLS[operationId], 401, "unauthorized", "The bearer token is not valid.");
  }
  await mcpInit();
  await mcpError("API-get-self", {}, "tool.UNAUTHORIZED");
}

// ---------------------------------------------------------------------------------------------
// Drill: scope-auditor (auditor, baseline)
// ---------------------------------------------------------------------------------------------

async function scopeAuditor() {
  for (const operationId of ["pages.retrieve", "search", "pages.create"]) {
    const result = await callError(CALLS[operationId], 403, "restricted_resource", "not granted to the calling actor");
    assert.equal(result.json.object, "error");
  }
  await mcpInit();
  const result = await rpc("tools/call", { name: "API-get-self", arguments: {} });
  assert.ok(result.isError);
  assert.equal(result.structuredContent?.error?.code, "world.OPERATION_DENIED", JSON.stringify(result).slice(0, 300));
}

// ---------------------------------------------------------------------------------------------
// Drill: scope-agent-only (agent-only, baseline)
// ---------------------------------------------------------------------------------------------

async function scopeAgentOnly() {
  const me = await opOk("users.me", {});
  assert.equal(me.id, ID.agentBot, "no attributes → the first integration's bot");
  const context = await opOk("workspace.context", {});
  assert.equal(context.user.id, ID.agentBot);
  assert.equal(context.user.type, "bot");
  assert.equal(context.integration.access.type, "workspace");
  assert.equal((await post("/v1/search", { query: "engineering" })).json.results.length, 1, "the whole workspace is visible");
  const comment = (await post("/v1/comments", { parent: { page_id: ID.t1 }, rich_text: [text("Bring-up suite is green again.")] })).json;
  assert.equal(comment.id, "fd000000-0000-4000-8000-000600001000", "the comment takes counter 0x1000, its discussion 0x1001");
  assert.equal(comment.created_by.id, ID.agentBot, "writes are attributed to the bot");
  assert.deepEqual(comment.display_name, { type: "integration", resolved_name: "Firedrill Agent" });
  const page = (await post("/v1/pages", { parent: { page_id: ID.scratch }, properties: { title: { title: [text("Bot notes")] } } })).json;
  assert.equal(page.id, "fd000000-0000-4000-8000-000200001002");
  assert.equal(page.created_by.id, ID.agentBot);
}

// ---------------------------------------------------------------------------------------------
// Fault drills
// ---------------------------------------------------------------------------------------------

async function rateLimited() {
  for (const operationId of ["search", "data-sources.query", "blocks.children.list", "pages.retrieve"]) {
    const result = await callError(CALLS[operationId], 429, "rate_limited", "You have been rate limited.");
    assert.equal(result.headers.get("retry-after"), "1", `${operationId}: Retry-After header`);
  }
  assert.equal((await opOk("users.me", {})).id, ID.agentBot, "other reads keep working");
  assert.equal((await get(`/v1/databases/${ID.dbTasks}`)).json.id, ID.dbTasks);
  await mcpInit();
  const error = await mcpError("API-post-search", { query: "sync" }, "tool.RATE_LIMITED");
  assert.equal(error.retryable, true);
}

async function writeUnavailable() {
  for (const operationId of ["pages.create", "pages.update", "blocks.children.append", "comments.create"]) {
    await callError(CALLS[operationId], 503, "service_unavailable", "Notion is unavailable");
  }
  assert.equal((await get(`/v1/pages/${ID.t1}`)).json.properties.Estimate.number, 8, "nothing was written");
  assert.equal((await get(`/v1/blocks/${ID.scratch}/children`)).json.results.length, 0);
  const block = (await patch(`/v1/blocks/${ID.actionItem}`, { to_do: { checked: true } })).json;
  assert.equal(block.to_do.checked, true, "blocks.update is not covered by the fault");
}

async function updateLost() {
  await apiError("PATCH", `/v1/pages/${ID.t7}`, 409, "conflict_error", "Conflict occurred while saving.", { body: { properties: { Status: { status: { name: "In progress" } } } } });
  const page = (await get(`/v1/pages/${ID.t7}`)).json;
  assert.equal(page.properties.Status.status.name, "In progress", "the update committed although the caller saw 409");
  assert.equal(page.last_edited_time, "2026-09-14T09:00:00.000Z");
}

async function bounded() {
  const BOUNDED = ["users.list", "search", "pages.create", "pages.update", "pages.move", "pages.retrieve-markdown", "pages.update-markdown", "databases.create", "data-sources.query", "data-sources.update", "blocks.children.list", "blocks.children.append", "blocks.update", "blocks.delete", "comments.create", "comments.list"];
  for (const operationId of BOUNDED) {
    const request = operationId === "comments.create" ? ["POST", "/v1/comments", { discussion_id: ID.discussion1, rich_text: [text("Probe")] }] : CALLS[operationId];
    await callError(request, 400, "validation_error", "state exceeds the supported bound of 4 rows");
  }
  await opError("workspace.trash", {}, "FAILED_PRECONDITION");
  const context = await opOk("workspace.context", {});
  assert.equal(context.limits.max_rows_per_namespace, 4);
  assert.equal((await opOk("users.me", {})).id, ID.agentBot);
  assert.equal((await get(`/v1/pages/${ID.t1}`)).json.id, ID.t1, "point reads do not scan");
}

// ---------------------------------------------------------------------------------------------
// Drill: byte-budget (member, baseline) — responses stay under 1 MiB; lists page by encoded bytes
// ---------------------------------------------------------------------------------------------

const encodedBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const cjkItems = (count) => Array.from({ length: count }, () => text("界".repeat(2000)));

/** Walk a Notion list to the end, asserting every page is a real, bounded page; returns ids and page count. */
async function walkList(first, next) {
  const seen = [];
  let pages = 0;
  let result = await first();
  for (;;) {
    pages += 1;
    assert.ok(encodedBytes(result.json) < 1_000_000, `list page of ${encodedBytes(result.json)} bytes`);
    assert.ok(result.json.results.length > 0 || !result.json.has_more, "an empty page claims has_more");
    seen.push(...ids(result.json.results));
    if (!result.json.has_more) break;
    assert.equal(result.json.next_cursor, seen[seen.length - 1], "next_cursor names the last returned item");
    result = await next(result.json.next_cursor);
  }
  assert.equal(new Set(seen).size, seen.length, "every item appears exactly once");
  return { seen, pages };
}

async function byteBudget() {
  // One paragraph whose rendering (text.content + plain_text) passes the object budget is refused; nothing is stored.
  const before = (await get(`/v1/blocks/${ID.scratch}/children`)).json.results.length;
  await apiError("PATCH", `/v1/blocks/${ID.scratch}/children`, 400, "validation_error", "once rendered", { body: { children: [{ type: "paragraph", paragraph: { rich_text: cjkItems(100) } }] } });
  await apiError("PATCH", `/v1/blocks/${ID.scratch}/children`, 400, "validation_error", "text.link.url.length should be ≤ 2000", { body: { children: [{ paragraph: { rich_text: [{ text: { content: "x", link: { url: `https://example.com/${"a".repeat(2000)}` } } }] } }] } });
  assert.equal((await get(`/v1/blocks/${ID.scratch}/children`)).json.results.length, before);
  // Near-limit blocks are stored and read back one page at a time with a real cursor.
  const page = (await post("/v1/pages", { parent: { page_id: ID.scratch }, properties: { title: [text("Byte budget")] } })).json;
  const appended = [];
  for (let index = 0; index < 3; index += 1) {
    const result = await patch(`/v1/blocks/${page.id}/children`, { children: [{ type: "paragraph", paragraph: { rich_text: cjkItems(65) } }] });
    appended.push(...ids(result.json.results));
  }
  appended.push(...ids((await patch(`/v1/blocks/${page.id}/children`, { children: [{ type: "paragraph", paragraph: { rich_text: [text("small")] } }] })).json.results));
  const children = await walkList(() => get(`/v1/blocks/${page.id}/children?page_size=100`), (cursor) => get(`/v1/blocks/${page.id}/children?page_size=100&start_cursor=${cursor}`));
  assert.deepEqual(children.seen, appended);
  assert.ok(children.pages >= 3, `children in ${children.pages} pages`);
  await apiError("GET", `/v1/pages/${page.id}/markdown`, 400, "validation_error", "The response is too large");
  // Comments, search and a data source query fill pages by bytes as well.
  for (let index = 0; index < 2; index += 1) await post("/v1/comments", { parent: { page_id: page.id }, rich_text: cjkItems(64) });
  const comments = await walkList(() => get(`/v1/comments?block_id=${page.id}&page_size=100`), (cursor) => get(`/v1/comments?block_id=${page.id}&page_size=100&start_cursor=${cursor}`));
  assert.equal(comments.seen.length, 2);
  assert.equal(comments.pages, 2);
  const created = [];
  for (let index = 0; index < 2; index += 1) {
    created.push((await post("/v1/pages", { parent: { page_id: page.id }, properties: { title: [text("zqbudget "), ...cjkItems(64)] } })).json.id);
    created.push((await post("/v1/pages", { parent: { data_source_id: ID.dsTasks }, properties: { Name: { title: [text("zqbudget "), ...cjkItems(64)] } } })).json.id);
  }
  const found = await walkList(() => post("/v1/search", { query: "zqbudget", page_size: 100 }), (cursor) => post("/v1/search", { query: "zqbudget", page_size: 100, start_cursor: cursor }));
  assert.deepEqual([...found.seen].sort(), [...created].sort());
  assert.equal(found.pages, 4);
  const rows = await walkList(() => query(ID.dsTasks, { page_size: 100 }), (cursor) => query(ID.dsTasks, { page_size: 100, start_cursor: cursor }));
  for (const id of created.filter((_, index) => index % 2 === 1)) assert.ok(rows.seen.includes(id), `query is missing ${id}`);
  const title = await get(`/v1/pages/${created[0]}/properties/title?page_size=100`);
  assert.equal(title.json.results.length, 65);
  // A database whose title and description together render past the object budget is refused.
  await apiError("POST", "/v1/databases", 400, "validation_error", "bytes once rendered", { body: { parent: { page_id: page.id }, title: cjkItems(64), description: cjkItems(64), initial_data_source: { properties: { Name: { title: {} } } } } });
}

/** Raw PATCH that returns whatever status the Tool answers (used where a refusal point is being searched for). */
async function patchAny(path, body) {
  const response = await fetch(`${HTTP}${path}`, { method: "PATCH", headers: { authorization: `Bearer ${HTTP_TOKEN}`, "notion-version": "2025-09-03", "content-type": "application/json" }, body: JSON.stringify(body) });
  const raw = await response.text();
  return { status: response.status, json: raw.length > 0 ? JSON.parse(raw) : undefined };
}

/**
 * A page near the object budget stays readable while its data source schema grows: the schema is bounded by what it
 * adds to every page (created_by renders an expanded user per page), refused at exactly limit + 1, accepted at limit.
 */
async function schemaGrowth() {
  const LIMIT = 150_000;
  const parentId = (await post("/v1/pages", { parent: { page_id: ID.scratch }, properties: { title: [text("Schema growth")] } })).json.id;
  const database = (await post("/v1/databases", { parent: { page_id: parentId }, title: [text("Schema growth")], initial_data_source: { properties: { Name: { title: {} } } } })).json;
  const source = database.data_sources[0].id;
  const path = `/v1/data_sources/${source}`;
  // A small row keeps the drill's evidence small; the 64-item near-limit row is proven by the live probe in VERIFICATION.md.
  const row = (await post("/v1/pages", { parent: { data_source_id: source }, properties: { Name: { title: cjkItems(4) } } })).json.id;
  const added = (message) => Number(/would add (\d+) bytes to the rendering of each of its pages/.exec(message)?.[1]);
  // Grow in batches of 100 created_by properties until the page-cost bound refuses a batch (nothing of it is stored).
  let batches = 0;
  for (;;) {
    const properties = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`c${batches}.${index}`, { created_by: {} }]));
    const result = await patchAny(path, { properties });
    if (result.status === 400) {
      assert.equal(result.json.code, "validation_error");
      assert.ok(added(result.json.message) > LIMIT, result.json.message);
      break;
    }
    assert.equal(result.status, 200, JSON.stringify(result.json).slice(0, 300));
    batches += 1;
    assert.ok(batches < 100, "the schema page-cost bound never refused");
  }
  assert.equal(Object.keys((await get(path)).json.properties).length, 1 + batches * 100);
  // Size one more property's name so the total is exactly limit + 1 (refused), then limit (accepted).
  const probeLength = 60_000;
  const probe = await apiError("PATCH", path, 400, "validation_error", "to the rendering of each of its pages", { body: { properties: { ["p".repeat(probeLength)]: { created_by: {} } } } });
  const exactLength = probeLength - (added(probe.json.message) - (LIMIT + 1));
  assert.ok(exactLength > 1, `probe reported ${probe.json.message}`);
  await apiError("PATCH", path, 400, "validation_error", `would add ${LIMIT + 1} bytes`, { body: { properties: { ["p".repeat(exactLength)]: { created_by: {} } } } });
  await patch(path, { properties: { ["p".repeat(exactLength - 1)]: { created_by: {} } } });
  // The row and its whole data source stay readable, under 1 MiB.
  const retrieved = await get(`/v1/pages/${row}`);
  assert.ok(encodedBytes(retrieved.json) < 1_000_000, `page of ${encodedBytes(retrieved.json)} bytes`);
  const rows = await walkList(() => query(source, { page_size: 1 }), (cursor) => query(source, { page_size: 1, start_cursor: cursor }));
  assert.deepEqual(rows.seen, [row]);
}

// ---------------------------------------------------------------------------------------------

const flows = {
  "workspace-read": workspaceRead,
  "task-triage": taskTriage,
  "page-authoring": pageAuthoring,
  "trash-and-restore": trashAndRestore,
  "mcp-aliases": mcpAliases,
  "scope-notes-bot": scopeNotesBot,
  "scope-board-bot": scopeBoardBot,
  "scope-stranger": scopeStranger,
  "scope-auditor": scopeAuditor,
  "scope-agent-only": scopeAgentOnly,
  "rate-limited": rateLimited,
  "write-unavailable": writeUnavailable,
  "update-lost": updateLost,
  bounded,
  "byte-budget": byteBudget,
  "schema-growth": schemaGrowth,
};
const selected = Object.keys(flows).find((name) => instruction.includes(`the ${name} conformance flow`));
if (selected === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
