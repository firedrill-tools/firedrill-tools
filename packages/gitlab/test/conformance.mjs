// GitLab Tool conformance target. A scripted Tool test, not a model-driven agent.
// Node built-ins only: fetch against the GitLab-shaped REST routes (PRIVATE-TOKEN header), the canonical
// /v1/operations endpoint and raw MCP JSON-RPC (Streamable HTTP) for the GitLab MCP server tool-name aliases.
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

const RP = "/api/v4/projects/101";
const BA = "/api/v4/projects/102";
const DF = "/api/v4/projects/103";
const NONE = "/api/v4/projects/999";
const ORIGIN = "https://gitlab.example.test";
const WORLD_TIME = "2026-09-15T09:00:00.000Z";
const ZERO = "0".repeat(40);
const ALL_OPERATIONS = [
  "users.get",
  "projects.list",
  "projects.get",
  "labels.list",
  "branches.list",
  "branches.get",
  "branches.create",
  "commits.list",
  "commits.get",
  "commits.create",
  "repository.get-file",
  "repository.list-tree",
  "issues.list",
  "issues.get",
  "issues.create",
  "issues.update",
  "issues.delete",
  "issues.list-notes",
  "notes.save",
  "merge-requests.list",
  "merge-requests.get",
  "merge-requests.save",
  "merge-requests.list-commits",
  "merge-requests.list-diffs",
  "merge-requests.list-notes",
  "merge-requests.merge",
];
const ALIASES = [
  "get_user",
  "list_projects",
  "get_project",
  "search_labels",
  "list_branches",
  "add_branch",
  "list_commits",
  "get_commit",
  "add_commit",
  "get_repository_file",
  "list_repository_tree",
  "get_issue",
  "create_issue",
  "save_note",
  "list_merge_requests",
  "get_merge_request",
  "save_merge_request",
  "get_merge_request_commits",
  "get_merge_request_diffs",
  "get_merge_request_notes",
  "accept_merge_request",
];

// ---------------------------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------------------------

const b64decode = (text) => Buffer.from(text, "base64").toString("utf8");

/** GitLab-shaped request; asserts the status and returns the parsed body (JSON or text) and headers. */
async function api(method, path, { body, status = 200, token = HTTP_TOKEN, rawBody, contentType } = {}) {
  const hasBody = body !== undefined || rawBody !== undefined;
  const response = await fetch(`${HTTP}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { "PRIVATE-TOKEN": token }),
      ...(hasBody ? { "content-type": contentType ?? "application/json" } : {}),
    },
    ...(hasBody ? { body: rawBody ?? JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  assert.equal(response.status, status, `${method} ${path} ${body === undefined ? "" : JSON.stringify(body).slice(0, 200)} -> ${response.status} ${text.slice(0, 500)}`);
  return { json, text, headers: response.headers, status: response.status };
}
const get = (path, options) => api("GET", path, options);
const post = (path, body, options) => api("POST", path, { ...options, body });
const put = (path, body, options) => api("PUT", path, { ...options, body });
const del = (path, options) => api("DELETE", path, options);

/** Expect a GitLab error envelope: `{"message": …}` (string, array or field map) or `{"error": …}`, containing `text`. */
async function apiError(method, path, status, text, options = {}) {
  const result = await api(method, path, { ...options, status });
  assert.ok(result.json && (result.json.message !== undefined || result.json.error !== undefined), `${method} ${path}: no GitLab error envelope: ${result.text.slice(0, 300)}`);
  assert.ok(JSON.stringify(result.json).includes(text), `${method} ${path}: expected ${JSON.stringify(text)} in ${result.text.slice(0, 400)}`);
  return result;
}

/** Canonical operation endpoint. `expected` is "ok" or a Tool error code. */
async function op(operationId, args, expected = "ok") {
  const response = await fetch(`${HTTP}/v1/operations/gitlab/${operationId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  });
  const json = await response.json();
  assert.ok(json.outcome, `canonical ${operationId}: ${JSON.stringify(json).slice(0, 300)}`);
  if (expected === "ok") {
    assert.equal(json.outcome.status, "ok", `${operationId} ${JSON.stringify(args)}: ${JSON.stringify(json.outcome).slice(0, 400)}`);
    return json.outcome.value;
  }
  assert.equal(json.outcome.status, "tool_error", `${operationId} ${JSON.stringify(args)}: ${JSON.stringify(json.outcome).slice(0, 400)}`);
  assert.equal(json.outcome.error.code, `tool.${expected}`, `${operationId}: ${JSON.stringify(json.outcome.error)}`);
  return json.outcome.error;
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
  const messages = (response.headers.get("content-type") ?? "").includes("text/event-stream")
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
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gitlab-conformance", version: "0.1.0" } });
}
async function mcp(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(!result.isError, `${name} ${JSON.stringify(args)}: ${JSON.stringify(result).slice(0, 500)}`);
  return result.structuredContent;
}
async function mcpError(name, args, code) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(result.isError, `${name} ${JSON.stringify(args)} unexpectedly succeeded`);
  if (code) assert.equal(result.structuredContent?.error?.code, code, JSON.stringify(result).slice(0, 400));
  return result.structuredContent;
}

const iids = (items) => items.map((item) => item.iid);
const names = (items) => items.map((item) => item.name);
const rel = (headers, relation) => {
  const match = new RegExp(`<([^>]+)>; rel="${relation}"`).exec(headers.get("link") ?? "");
  return match === null ? undefined : match[1];
};

// ---------------------------------------------------------------------------------------------
// Drill: rest-read (owner = mara.lindqvist, baseline)
// ---------------------------------------------------------------------------------------------

async function restRead() {
  // Identity ----------------------------------------------------------------------------------
  const me = (await get("/api/v4/user")).json;
  assert.equal(me.username, "mara.lindqvist");
  assert.equal(me.email, "mara.lindqvist@example.test");
  assert.equal(me.server_time, undefined, "REST /user does not carry the Tool's server_time extension");
  assert.equal((await get("/api/v4/users/5")).json.username, "ravi.menon");
  assert.equal((await get("/api/v4/users/5")).json.email, undefined, "public user shape has no email");
  await apiError("GET", "/api/v4/users/999", 404, "404 User Not Found");
  await apiError("GET", "/api/v4/users/not-a-number", 404, "404 User Not Found");
  await op("users.get", {}, "BAD_REQUEST");
  assert.equal((await op("users.get", { username: "THEO.BRANDT" })).id, 3);
  await get("/api/v4/user", { token: null, status: 401 });

  // Projects ----------------------------------------------------------------------------------
  const projects = await get("/api/v4/projects");
  assert.deepEqual(projects.json.map((project) => project.path_with_namespace), ["northwind/route-planner", "northwind/billing-api", "mara.lindqvist/dotfiles"]);
  assert.equal(projects.headers.get("x-total"), "3");
  assert.equal(projects.headers.get("x-page"), "1");
  assert.equal((await get("/api/v4/projects?membership=true&visibility=private")).json.length, 1);
  assert.equal((await get("/api/v4/projects?search=route")).json.length, 1);
  assert.deepEqual((await get("/api/v4/projects?order_by=name&sort=asc")).json.map((project) => project.id), [102, 103, 101]);
  assert.deepEqual((await get("/api/v4/projects?archived=true")).json.map((project) => project.id), [103]);
  await apiError("GET", "/api/v4/projects?per_page=abc", 400, "per_page is invalid");
  await op("projects.list", { group_id: 999 }, "NOT_FOUND");
  assert.equal((await op("projects.list", { group_id: 11 })).items.length, 2);
  const routePlanner = (await get(RP)).json;
  assert.equal(routePlanner.open_issues_count, 12);
  assert.equal(routePlanner.permissions.project_access.access_level, 50);
  assert.equal(routePlanner.readme_url, `${ORIGIN}/northwind/route-planner/-/blob/main/README.md`);
  assert.equal(routePlanner.http_url_to_repo, `${ORIGIN}/northwind/route-planner.git`);
  assert.equal((await op("projects.get", { project_id: "Northwind/Route-Planner" })).id, 101, "paths are case-insensitive");
  assert.equal((await op("projects.get", { url: `${ORIGIN}/northwind/billing-api` })).id, 102);
  await get("/api/v4/projects/northwind%2Froute-planner", { status: 404 }); // framework rejects %2F in path segments (documented)
  await apiError("GET", NONE, 404, "404 Project Not Found");
  await op("projects.get", {}, "BAD_REQUEST");

  // Labels ------------------------------------------------------------------------------------
  const labels = await get(`${RP}/labels?with_counts=true`);
  assert.deepEqual(names(labels.json), ["bug", "documentation", "feature", "good first issue", "needs review", "priority::high"]);
  const bug = labels.json.find((label) => label.name === "bug");
  assert.deepEqual([bug.open_issues_count, bug.closed_issues_count], [2, 1]);
  assert.equal(labels.json.find((label) => label.name === "feature").open_merge_requests_count, 1);
  assert.equal((await get(`${RP}/labels?search=PRIOR`)).json.length, 1);
  await op("labels.list", { full_path: "northwind/route-planner", is_project: false }, "BAD_REQUEST");
  await apiError("GET", `${NONE}/labels`, 404, "404 Project Not Found");

  // Branches ----------------------------------------------------------------------------------
  const branches = (await get(`${RP}/repository/branches`)).json;
  assert.deepEqual(names(branches), ["docs/api-guide", "feature/eta-cache", "feature/traffic-layer", "fix/timezone-drift", "main"]);
  assert.equal(branches.find((branch) => branch.name === "fix/timezone-drift").merged, true);
  assert.equal(branches.find((branch) => branch.name === "feature/eta-cache").merged, false);
  const main = branches.find((branch) => branch.name === "main");
  assert.deepEqual([main.default, main.protected, main.can_push], [true, true, true]);
  const pages = [];
  let next = `${RP}/repository/branches?per_page=2`;
  while (next !== undefined) {
    const page = await get(next);
    pages.push(names(page.json));
    next = rel(page.headers, "next");
  }
  assert.deepEqual(pages, [["docs/api-guide", "feature/eta-cache"], ["feature/traffic-layer", "fix/timezone-drift"], ["main"]], "link header walks three pages");
  assert.deepEqual(names((await get(`${RP}/repository/branches?search=^feature`)).json), ["feature/eta-cache", "feature/traffic-layer"]);
  assert.deepEqual(names((await get(`${RP}/repository/branches?search=drift$`)).json), ["fix/timezone-drift"]);
  await apiError("GET", `${RP}/repository/branches?regex=%5Efeat`, 400, "regex is not supported");
  // JSON nesting past 512 levels is refused while decoding (400), before recursive argument validation can overflow.
  const nest = (depth, wrap) => { let value = 1; for (let i = 0; i < depth; i += 1) value = wrap(value); return value; };
  for (const depth of [600, 2998, 3152]) {
    for (const wrap of [(v) => [v], (v) => ({ a: v })]) {
      await api("POST", `${RP}/issues`, { rawBody: JSON.stringify({ title: "deep", assignee_ids: nest(depth, wrap) }), status: 400 });
      await api("POST", `${RP}/repository/commits`, { rawBody: JSON.stringify({ branch: "main", commit_message: "deep", actions: nest(depth, wrap) }), status: 400 });
    }
  }
  await apiError("GET", `${NONE}/repository/branches`, 404, "404 Project Not Found");
  assert.equal((await get(`${RP}/repository/branches/main`)).json.commit.id, main.commit.id);
  assert.equal((await op("branches.get", { id: "northwind/route-planner", branch: "feature/eta-cache" })).name, "feature/eta-cache");
  await apiError("GET", `${RP}/repository/branches/nope`, 404, "404 Branch Not Found");
  await op("branches.get", { id: 101 }, "BAD_REQUEST");

  // Commits -----------------------------------------------------------------------------------
  const commits = await get(`${RP}/repository/commits`);
  assert.deepEqual(commits.json.map((commit) => commit.title), [
    "Merge branch 'fix/timezone-drift' into 'main'",
    "Tune ETA speed factor and bump version",
    "Pin the server time zone to UTC",
    "Add route planning endpoint",
    "Initial import of route planner",
  ]);
  assert.equal(commits.headers.get("x-total"), null, "commit lists omit x-total like GitLab");
  const [A8, A3, A7, A2, A1] = commits.json.map((commit) => commit.id);
  assert.equal(A8, main.commit.id);
  const firstPage = await get(`${RP}/repository/commits?per_page=2`);
  assert.equal(firstPage.json.length, 2);
  assert.equal(firstPage.headers.get("x-next-page"), "2");
  assert.equal((await get(`${RP}/repository/commits?ref_name=feature/eta-cache`)).json.length, 3);
  assert.deepEqual((await get(`${RP}/repository/commits?path=package.json`)).json.map((commit) => commit.id), [A3, A1]);
  assert.equal((await get(`${RP}/repository/commits?since=2026-08-01T00:00:00Z`)).json.length, 2);
  assert.equal((await get(`${RP}/repository/commits?until=2026-06-30`)).json.length, 2);
  assert.equal((await get(`${RP}/repository/commits?author=theo`)).json.length, 3);
  assert.deepEqual((await get(`${RP}/repository/commits?first_parent=true`)).json.map((commit) => commit.id), [A8, A3, A2, A1]);
  assert.ok((await get(`${RP}/repository/commits?with_stats=true&per_page=1`)).json[0].stats.total >= 1);
  await apiError("GET", `${RP}/repository/commits?ref_name=nope`, 404, "404 Reference Not Found");
  await apiError("GET", `${RP}/repository/commits?all=true`, 400, "all is not supported");
  await apiError("GET", `${RP}/repository/commits?since=yesterday`, 400, "since is invalid");
  const merge = (await get(`${RP}/repository/commits/${A8}`)).json;
  assert.deepEqual(merge.parent_ids, [A3, A7]);
  assert.equal(merge.project_id, 101);
  assert.equal((await get(`${RP}/repository/commits/${A8.slice(0, 8)}`)).json.id, A8, "unique short sha");
  const diff = (await get(`${RP}/repository/commits/${A3}/diff`)).json;
  assert.deepEqual(diff.map((entry) => entry.new_path), ["package.json", "src/routes/eta.ts"]);
  assert.ok(diff[0].diff.startsWith("@@ -"), "unified diff hunk");
  assert.equal((await get(`${RP}/repository/commits/${A3}?stats=false`)).json.stats, undefined);
  await apiError("GET", `${RP}/repository/commits/${ZERO}`, 404, "404 Commit Not Found");
  await op("commits.get", { project_id: 101, commit_sha: A3, include: ["notes"] }, "BAD_REQUEST");
  assert.equal((await op("commits.get", { url: `${ORIGIN}/northwind/route-planner/-/commit/${A2}` })).id, A2);

  // Files and tree ----------------------------------------------------------------------------
  const readme = await get(`${RP}/repository/files/README.md?ref=main`);
  assert.equal(readme.json.text, undefined, "REST file responses carry GitLab's fields only");
  assert.ok(b64decode(readme.json.content).startsWith("# Route Planner"));
  assert.equal(readme.headers.get("x-gitlab-blob-id"), readme.json.blob_id);
  assert.equal(readme.json.last_commit_id, A2);
  assert.match(readme.json.content_sha256, /^[0-9a-f]{64}$/);
  const raw = await get(`${RP}/repository/files/README.md/raw`);
  assert.equal(raw.text, b64decode(readme.json.content));
  assert.ok((raw.headers.get("content-type") ?? "").startsWith("text/plain"));
  await apiError("GET", `${RP}/repository/files/README.md`, 400, "ref is missing");
  await apiError("GET", `${RP}/repository/files/nope.md?ref=main`, 404, "404 File Not Found");
  await apiError("GET", `${RP}/repository/files/README.md?ref=nope`, 404, "404 Commit Not Found");
  await get(`${RP}/repository/files/src%2Froutes%2Feta.ts?ref=main`, { status: 404 }); // %2F limitation (documented)
  const eta = await op("repository.get-file", { project_id: 101, file_path: "src/routes/eta.ts", ref: "main", offset: 0, limit: 2 });
  assert.equal(eta.text, 'import { store } from "../cache/store";\n');
  assert.equal(eta.last_commit_id, A3);
  const tree = (await get(`${RP}/repository/tree?path=src&recursive=true`)).json;
  assert.deepEqual(tree.map((entry) => `${entry.type}:${entry.path}`), [
    "tree:src/cache",
    "tree:src/routes",
    "blob:src/cache/store.ts",
    "blob:src/index.ts",
    "blob:src/routes/eta.ts",
    "blob:src/routes/plan.ts",
  ]);
  assert.deepEqual(names((await get(`${RP}/repository/tree`)).json), ["src", "README.md", "package.json"]);
  await apiError("GET", `${RP}/repository/tree?path=nope`, 404, "404 Tree Not Found");
  await apiError("GET", `${RP}/repository/tree?per_page=x`, 400, "per_page is invalid");

  // Issues ------------------------------------------------------------------------------------
  const opened = [];
  for (const page of [1, 2, 3]) {
    const result = await get(`${RP}/issues?state=opened&per_page=5&page=${page}`);
    assert.equal(result.headers.get("x-total"), "12");
    assert.equal(result.headers.get("x-total-pages"), "3");
    opened.push(...iids(result.json));
  }
  assert.deepEqual(opened, [14, 13, 5, 12, 3, 11, 10, 7, 4, 1, 8, 6]);
  assert.equal((await get(`${RP}/issues?state=opened&per_page=5&page=4`)).json.length, 0, "over-range page is empty");
  // Participants collected by following next pages (as the app's people pickers do) include users who appear only on
  // older records, and match what one oversized page reports.
  const participants = async (path) => {
    const seen = new Set();
    for (let page = 1; page !== null; ) {
      const result = await get(`${path}${path.includes("?") ? "&" : "?"}state=all&order_by=updated_at&per_page=2&page=${page}`);
      for (const item of result.json) for (const user of [item.author, ...(item.assignees ?? []), ...(item.reviewers ?? [])]) seen.add(user.username);
      page = result.headers.get("x-next-page") ? Number(result.headers.get("x-next-page")) : null;
    }
    return seen;
  };
  const issuePeople = await participants(`${RP}/issues`);
  const mrPeople = await participants(`${RP}/merge_requests`);
  for (const username of ["deploy-bot", "june.park"]) assert.ok(issuePeople.has(username), `paged issue participants include ${username}`);
  const onePage = new Set((await get(`${RP}/issues?state=all&per_page=100`)).json.flatMap((item) => [item.author, ...item.assignees].map((user) => user.username)));
  assert.deepEqual([...issuePeople].sort(), [...onePage].sort());
  assert.ok(mrPeople.size >= 1);
  // The app's "!<iid>" search reads one merge request directly; an unknown iid is the provider's 404.
  assert.equal((await get(`${RP}/merge_requests/1`)).json.iid, 1);
  await apiError("GET", `${RP}/merge_requests/999999`, 404, "404 Merge Request Not Found");
  assert.deepEqual(iids((await get(`${RP}/issues?labels=bug,priority::high`)).json), [1]);
  assert.deepEqual(iids((await get(`${RP}/issues?search=timezone`)).json), [13, 1]);
  assert.deepEqual(iids((await get(`${RP}/issues?search=timezone&in=title`)).json), [13]);
  assert.equal((await get(`${RP}/issues?state=closed&labels=feature`)).json.length, 0);
  assert.deepEqual(iids((await get(`${RP}/issues?iids[]=2&iids[]=9`)).json), [9, 2]);
  assert.deepEqual(iids((await get(`${RP}/issues?assignee_username=ines.okafor`)).json), [1]);
  assert.deepEqual(iids((await get(`${RP}/issues?confidential=true`)).json), [3]);
  assert.equal((await get(`${RP}/issues?with_labels_details=true&iids[]=1`)).json[0].labels[0].color, "#dc143c");
  await apiError("GET", `${RP}/issues?milestone=v1`, 400, "milestone is not supported");
  await apiError("GET", `${RP}/issues?not[labels]=bug`, 400, "not is not supported");
  await apiError("GET", `${RP}/issues?search=%FF`, 400, "search is invalid");
  // Mangled percent-encoding: the framework decodes %E0%A4%A to U+FFFD; every search and filter answers GitLab's 400
  // `{"error": "<name> is invalid"}` instead of an empty list. A correctly encoded U+FFFD (%EF%BF%BD) is rejected too.
  for (const bad of ["a%E0%A4%A", "%E0%A4%A", "a%EF%BF%BD"]) {
    await apiError("GET", `/api/v4/projects?search=${bad}`, 400, "search is invalid");
    await apiError("GET", `${RP}/issues?search=${bad}`, 400, "search is invalid");
    await apiError("GET", `${RP}/merge_requests?search=${bad}`, 400, "search is invalid");
    await apiError("GET", `${RP}/repository/branches?search=${bad}`, 400, "search is invalid");
    await apiError("GET", `${RP}/labels?search=${bad}`, 400, "search is invalid");
    await apiError("GET", `${RP}/issues?labels=bug,${bad}`, 400, "labels is invalid");
    await apiError("GET", `${RP}/merge_requests?labels=${bad}`, 400, "labels is invalid");
    await apiError("GET", `${RP}/issues?author_username=${bad}`, 400, "author_username is invalid");
    await apiError("GET", `${RP}/merge_requests?scope=${bad}`, 400, "scope is invalid");
  }
  // %ZZ is not malformed UTF-8: it stays literal text and matches nothing.
  assert.deepEqual((await get(`/api/v4/projects?search=route%ZZ`)).json, []);
  assert.deepEqual((await get(`${RP}/issues?search=timezone%ZZ`)).json, []);
  // Legitimate non-ASCII searches keep working (the matching issue is created in rest-write; here only the shape).
  for (const term of ["café", "漢字", "🔥"]) assert.deepEqual((await get(`${RP}/issues?search=${encodeURIComponent(term)}`)).json, []);
  await apiError("GET", `${NONE}/issues`, 404, "404 Project Not Found");
  const confidential = (await get(`${RP}/issues/3`)).json;
  assert.equal(confidential.confidential, true);
  assert.equal(confidential.references.full, "northwind/route-planner#3");
  const incident = (await get(`${RP}/issues/5`)).json;
  assert.deepEqual([incident.issue_type, incident.type], ["incident", "INCIDENT"]);
  assert.deepEqual((await get(`${RP}/issues/1`)).json.task_completion_status, { count: 2, completed_count: 1 });
  await apiError("GET", `${RP}/issues/999`, 404, "404 Issue Not Found");
  await op("issues.get", { id: 101 }, "BAD_REQUEST");
  const notes = (await get(`${RP}/issues/1/notes?sort=asc`)).json;
  assert.equal(notes.length, 3);
  assert.equal(notes[0].system, true);
  assert.equal(notes[0].body, 'added ~"bug" ~"priority::high" labels');
  assert.equal((await get(`${RP}/issues/1/notes?activity_filter=only_comments`)).json.length, 2);
  assert.equal((await get(`${BA}/issues/1/notes`)).json[0].internal, true, "internal notes are visible to the owner");
  await apiError("GET", `${RP}/issues/999/notes`, 404, "404 Issue Not Found");
  await apiError("GET", `${RP}/issues/1/notes?page=x`, 400, "page is invalid");

  // Merge requests ----------------------------------------------------------------------------
  assert.deepEqual(iids((await get(`${RP}/merge_requests?state=merged`)).json), [1]);
  assert.deepEqual(iids((await get(`${RP}/merge_requests?state=opened`)).json), [4, 3, 2]);
  assert.deepEqual(iids((await get(`${RP}/merge_requests?draft=yes`)).json), [4]);
  assert.deepEqual(iids((await get(`${RP}/merge_requests?reviewer_username=theo.brandt`)).json), [2]);
  await apiError("GET", `${RP}/merge_requests?scope=created_by_me`, 400, "scope created_by_me is not supported");
  await apiError("GET", `${NONE}/merge_requests`, 404, "404 Project Not Found");
  const mr2 = (await get(`${RP}/merge_requests/2`)).json;
  assert.deepEqual([mr2.detailed_merge_status, mr2.merge_status, mr2.has_conflicts, mr2.changes_count], ["mergeable", "can_be_merged", false, 2]);
  assert.equal(mr2.diff_refs.base_sha, A2);
  assert.equal(mr2.user.can_merge, true);
  const mr3 = (await get(`${RP}/merge_requests/3`)).json;
  assert.deepEqual([mr3.detailed_merge_status, mr3.has_conflicts, mr3.merge_status], ["conflict", true, "cannot_be_merged"]);
  assert.deepEqual([(await get(`${RP}/merge_requests/4`)).json.detailed_merge_status, (await get(`${RP}/merge_requests/4`)).json.draft], ["draft_status", true]);
  assert.equal((await get(`${BA}/merge_requests/1`)).json.detailed_merge_status, "need_rebase");
  assert.equal((await get(`${RP}/merge_requests/1`)).json.merge_commit_sha, A8);
  await apiError("GET", `${RP}/merge_requests/999`, 404, "404 Merge Request Not Found");
  await op("merge-requests.get", { project_id: 101, merge_request_iid: 2, include: ["pipelines"] }, "BAD_REQUEST");
  assert.equal((await get(`${RP}/merge_requests/2/commits`)).json.length, 1);
  assert.deepEqual((await get(`${RP}/merge_requests/2/diffs`)).json.map((entry) => entry.new_path), ["src/cache/store.ts", "test/cache.test.ts"]);
  assert.equal((await get(`${RP}/merge_requests/2/notes`)).json.length, 3);
  await apiError("GET", `${RP}/merge_requests/999/commits`, 404, "404 Merge Request Not Found");
  await apiError("GET", `${RP}/merge_requests/2/commits?per_page=x`, 400, "per_page is invalid");
  await apiError("GET", `${RP}/merge_requests/999/diffs`, 404, "404 Merge Request Not Found");
  await apiError("GET", `${RP}/merge_requests/2/diffs?page=x`, 400, "page is invalid");
  await apiError("GET", `${RP}/merge_requests/999/notes`, 404, "404 Merge Request Not Found");
  await op("merge-requests.list-notes", { project_id: 101, merge_request_iid: 2, last: 1 }, "BAD_REQUEST");
}

// ---------------------------------------------------------------------------------------------
// Drill: rest-write (owner, baseline)
// ---------------------------------------------------------------------------------------------

async function restWrite() {
  const A8 = (await get(`${RP}/repository/branches/main`)).json.commit.id;

  // Branches and commits ----------------------------------------------------------------------
  const created = (await post(`${RP}/repository/branches`, { branch: "feature/agent", ref: "main" }, { status: 201 })).json;
  assert.deepEqual([created.name, created.commit.id, created.protected], ["feature/agent", A8, false]);
  await apiError("POST", `${RP}/repository/branches`, 400, "Branch already exists", { body: { branch: "feature/agent", ref: "main" } });
  await apiError("POST", `${RP}/repository/branches`, 400, "Invalid reference name: nope", { body: { branch: "feature/other", ref: "nope" } });
  await apiError("POST", `${RP}/repository/branches`, 400, "Branch name is invalid", { body: { branch: "bad..name", ref: "main" } });
  await apiError("POST", `${RP}/repository/branches`, 400, "branch is missing", { body: { ref: "main" } });
  await apiError("POST", `${NONE}/repository/branches`, 404, "404 Project Not Found", { body: { branch: "x", ref: "main" } });
  await apiError("POST", `${DF}/repository/branches`, 403, "403 Forbidden", { body: { branch: "x", ref: "main" } });

  const commit = (
    await post(
      `${RP}/repository/commits`,
      {
        branch: "feature/agent",
        commit_message: "Add agent notes\n\nGenerated by the conformance flow.",
        actions: [
          { action: "create", file_path: "docs/agent.md", content: "# Agent notes\n" },
          { action: "update", file_path: "README.md", content: "# Route Planner (agent)\n" },
          { action: "move", previous_path: "src/routes/plan.ts", file_path: "src/routes/planning.ts" },
          { action: "create", file_path: "data/depots.csv", content: Buffer.from("id,name\n1,Bergen\n").toString("base64"), encoding: "base64" },
        ],
      },
      { status: 201 },
    )
  ).json;
  assert.deepEqual(commit.parent_ids, [A8]);
  assert.ok(commit.stats.additions >= 3);
  assert.equal(commit.title, "Add agent notes");
  const readme = (await get(`${RP}/repository/files/README.md/raw?ref=feature/agent`)).text;
  assert.equal(readme, "# Route Planner (agent)\n", "read after write");
  const moved = await op("repository.get-file", { project_id: 101, file_path: "src/routes/planning.ts", ref: "feature/agent" });
  assert.ok(moved.text.includes("planRoute"));
  assert.equal((await op("repository.get-file", { project_id: 101, file_path: "data/depots.csv", ref: "feature/agent" })).text, "id,name\n1,Bergen\n");
  const renamed = (await get(`${RP}/repository/commits/${commit.id}/diff`)).json.find((entry) => entry.renamed_file);
  assert.deepEqual([renamed.old_path, renamed.new_path], ["src/routes/plan.ts", "src/routes/planning.ts"]);
  assert.equal((await get(`${RP}/repository/branches?search=agent`)).json[0].commit.id, commit.id);
  const commitBody = (actions, extra = {}) => ({ branch: "feature/agent", commit_message: "x", actions, ...extra });
  await apiError("POST", `${RP}/repository/commits`, 400, "A file with this name already exists", { body: commitBody([{ action: "create", file_path: "README.md", content: "x" }]) });
  await apiError("POST", `${RP}/repository/commits`, 400, "A file with this name doesn't exist", { body: commitBody([{ action: "delete", file_path: "nope.md" }]) });
  await apiError("POST", `${RP}/repository/commits`, 400, "Invalid base64 content", { body: commitBody([{ action: "create", file_path: "x.bin", content: "@@@", encoding: "base64" }]) });
  await apiError("POST", `${RP}/repository/commits`, 400, "Invalid file path", { body: commitBody([{ action: "create", file_path: "../escape.txt", content: "x" }]) });
  await apiError("POST", `${RP}/repository/commits`, 400, "actions is empty", { body: commitBody([]) });
  await apiError("POST", `${RP}/repository/commits`, 409, "The file has changed since you started editing it: README.md", {
    body: commitBody([{ action: "update", file_path: "README.md", content: "stale", last_commit_id: A8 }]),
  });
  await apiError("POST", `${RP}/repository/commits`, 400, "You must provide a branch to start from", { body: { branch: "feature/new", commit_message: "x", actions: [{ action: "create", file_path: "n.txt", content: "n" }] } });
  await apiError("POST", `${NONE}/repository/commits`, 404, "404 Project Not Found", { body: commitBody([{ action: "create", file_path: "n.txt" }]) });
  await apiError("POST", `${DF}/repository/commits`, 403, "403 Forbidden", { body: { branch: "main", commit_message: "x", actions: [{ action: "create", file_path: "n.txt" }] } });
  assert.equal((await get(`${RP}/repository/branches/main`)).json.commit.id, A8, "failed commits left main untouched");

  // Issues ------------------------------------------------------------------------------------
  const issue = (await post(`${RP}/issues`, { title: "Agent triage: flaky ETA test", description: "Seen twice this week.", labels: "triage", assignee_ids: [4, 999999] }, { status: 404 })).json;
  assert.equal(issue.message, "404 User Not Found", "unknown assignee ids are rejected");
  const createdIssue = (await post(`${RP}/issues`, { title: "Agent triage: flaky ETA test", description: "Seen twice this week.", labels: "triage", assignee_ids: [4] }, { status: 201 })).json;
  assert.deepEqual([createdIssue.iid, createdIssue.labels, createdIssue.assignees.map((user) => user.username), createdIssue.author.username], [15, ["triage"], ["ines.okafor"], "mara.lindqvist"]);
  assert.equal((await get(`${RP}/labels?search=triage`)).json[0].color, "#6699cc", "unknown labels are created");
  assert.equal((await get(RP)).json.open_issues_count, 13);
  await apiError("POST", `${RP}/issues`, 400, '{"error":"title is missing"}', { body: { description: "no title" } });
  await apiError("POST", `${RP}/issues`, 400, '{"message":{"title":["is too long (maximum is 255 characters)"]}}', { body: { title: "t".repeat(256) } });
  await apiError("POST", `${RP}/issues`, 400, "due_date is invalid", { body: { title: "x", due_date: "2026-02-30" } });
  await apiError("POST", `${NONE}/issues`, 404, "404 Project Not Found", { body: { title: "x" } });
  await apiError("POST", `${DF}/issues`, 403, "403 Forbidden", { body: { title: "Archived project" } });

  const updated = (await put(`${RP}/issues/15`, { state_event: "close", add_labels: "bug", remove_labels: "triage" })).json;
  assert.deepEqual([updated.state, updated.labels, updated.closed_by.username], ["closed", ["bug"], "mara.lindqvist"]);
  assert.equal((await get(RP)).json.open_issues_count, 12);
  const systemNotes = (await get(`${RP}/issues/15/notes?sort=asc`)).json.map((note) => note.body);
  assert.deepEqual(systemNotes, ["closed", 'added ~"bug" label and removed ~"triage" label']);
  await apiError("PUT", `${RP}/issues/15`, 400, "state_event does not have a valid value", { body: { state_event: "explode" } });
  await apiError("PUT", `${RP}/issues/15`, 400, "at least one parameter must be provided", { body: {} });
  await apiError("PUT", `${RP}/issues/999`, 404, "404 Issue Not Found", { body: { title: "x" } });
  await apiError("PUT", `${DF}/issues/1`, 403, "403 Forbidden", { body: { title: "x" } });

  const note = (await post(`${RP}/issues/15/notes`, { body: "Closing as a duplicate of #1." }, { status: 201 })).json;
  assert.deepEqual([note.noteable_type, note.noteable_iid, note.system], ["Issue", 15, false]);
  assert.equal((await get(`${RP}/issues/15`)).json.user_notes_count, 1);
  await apiError("POST", `${RP}/issues/15/notes`, 400, '{"error":"body is missing"}', { body: { body: "" } });
  await apiError("POST", `${RP}/issues/999/notes`, 404, "404 Issue Not Found", { body: { body: "x" } });
  await apiError("POST", `${DF}/issues/1/notes`, 403, "403 Forbidden", { body: { body: "x" } });

  await del(`${RP}/issues/15`, { status: 204 });
  await apiError("GET", `${RP}/issues/15`, 404, "404 Issue Not Found");
  await apiError("DELETE", `${RP}/issues/999`, 404, "404 Issue Not Found");
  await apiError("DELETE", `${DF}/issues/1`, 403, "403 Forbidden");
  await op("issues.delete", { id: 101 }, "BAD_REQUEST");

  // Merge requests ----------------------------------------------------------------------------
  const mr = (await post(`${RP}/merge_requests`, { source_branch: "feature/agent", target_branch: "main", title: "Agent notes", reviewer_ids: [3], labels: "documentation" }, { status: 201 })).json;
  assert.deepEqual([mr.iid, mr.detailed_merge_status, mr.reviewers[0].username, mr.labels, mr.changes_count], [6, "mergeable", "theo.brandt", ["documentation"], 4]);
  await apiError("POST", `${RP}/merge_requests`, 409, '{"message":["Another open merge request already exists for this source branch: !6"]}', {
    body: { source_branch: "feature/agent", target_branch: "main", title: "Again" },
  });
  await apiError("POST", `${RP}/merge_requests`, 400, "You can't use same project/branch for source and target", { body: { source_branch: "main", target_branch: "main", title: "x" } });
  await apiError("POST", `${RP}/merge_requests`, 400, 'Source branch \\"nope\\" does not exist', { body: { source_branch: "nope", target_branch: "main", title: "x" } });
  await apiError("POST", `${RP}/merge_requests`, 400, "title is missing", { body: { source_branch: "feature/agent", target_branch: "main" } });
  await apiError("POST", `${NONE}/merge_requests`, 404, "404 Project Not Found", { body: { source_branch: "a", target_branch: "b", title: "x" } });
  await apiError("POST", `${DF}/merge_requests`, 403, "403 Forbidden", { body: { source_branch: "main", target_branch: "other", title: "x" } });

  const draft = (await put(`${RP}/merge_requests/6`, { title: "Draft: Agent notes" })).json;
  assert.deepEqual([draft.draft, draft.detailed_merge_status], [true, "draft_status"]);
  await apiError("PUT", `${RP}/merge_requests/6/merge`, 405, "405 Method Not Allowed", { body: {} });
  const ready = (await put(`${RP}/merge_requests/6`, { title: "Agent notes" })).json;
  assert.deepEqual([ready.draft, ready.detailed_merge_status], [false, "mergeable"]);
  assert.ok((await get(`${RP}/merge_requests/6/notes?sort=asc`)).json.map((entry) => entry.body).includes("marked this merge request as **draft**"));
  await apiError("PUT", `${RP}/merge_requests/6/merge`, 409, `SHA does not match HEAD of source branch: ${commit.id}`, { body: { sha: "1".repeat(40) } });
  await apiError("PUT", `${RP}/merge_requests/3/merge`, 406, "Branch cannot be merged", { body: {} });
  await apiError("PUT", `${BA}/merge_requests/1/merge`, 406, "Branch cannot be merged", { body: {} });
  await apiError("PUT", `${RP}/merge_requests/999/merge`, 404, "404 Merge Request Not Found", { body: {} });
  await op("merge-requests.merge", { project_id: 101, merge_request_iid: 2, strategy: "auto_merge" }, "BAD_REQUEST");
  await apiError("PUT", `${RP}/merge_requests/5`, 400, "Cannot reopen merge request", { body: { state_event: "reopen" } });
  await apiError("PUT", `${RP}/merge_requests/1`, 400, "Cannot change the state of a merged merge request", { body: { state_event: "close" } });
  await apiError("PUT", `${RP}/merge_requests/999`, 404, "404 Merge Request Not Found", { body: { title: "x" } });

  const merged = (await put(`${RP}/merge_requests/2/merge`, { squash: true, should_remove_source_branch: true, merge_commit_message: "Merge the ETA cache cap" })).json;
  assert.deepEqual([merged.state, merged.merged_by.username, merged.detailed_merge_status], ["merged", "mara.lindqvist", "not_open"]);
  assert.match(merged.merge_commit_sha, /^[0-9a-f]{40}$/);
  assert.match(merged.squash_commit_sha, /^[0-9a-f]{40}$/);
  const mainAfter = (await get(`${RP}/repository/branches/main`)).json.commit;
  assert.equal(mainAfter.id, merged.merge_commit_sha);
  assert.equal(mainAfter.title, "Merge the ETA cache cap");
  assert.equal((await get(`${RP}/repository/branches?search=eta-cache`)).json.length, 0, "source branch removed");
  const mainTree = names((await get(`${RP}/repository/tree?path=test`)).json);
  assert.deepEqual(mainTree, ["cache.test.ts"], "merge tree carries the source changes");
  assert.equal((await op("repository.get-file", { project_id: 101, file_path: "src/index.ts", ref: "main" })).text.includes('process.env.TZ = "UTC"'), true, "and keeps the target's changes");
  assert.equal((await get(`${RP}/merge_requests/3`)).json.detailed_merge_status, "conflict");
  assert.equal((await get(`${RP}/merge_requests/6`)).json.detailed_merge_status, "mergeable", "open MRs on the target are recomputed");
  assert.ok((await get(`${RP}/merge_requests/2/notes`)).json.some((entry) => entry.system && entry.body === "merged"));
  assert.equal((await get(`${RP}/merge_requests?state=merged`)).json.length, 2);
  await largeResponses();
  // Non-ASCII searches match (the mangled-encoding rejections live in rest-read).
  const unicodeIssue = (await post(`${RP}/issues`, { title: "Café 漢字 🔥 encoding check", labels: "étiquette-漢字" }, { status: 201 })).json;
  for (const term of ["café", "漢字", "🔥"]) {
    assert.deepEqual(iids((await get(`${RP}/issues?search=${encodeURIComponent(term)}`)).json), [unicodeIssue.iid], term);
  }
  assert.deepEqual(iids((await get(`${RP}/issues?labels=${encodeURIComponent("étiquette-漢字")}`)).json), [unicodeIssue.iid]);
}

// ---------------------------------------------------------------------------------------------
// Drill: mcp-aliases (owner, baseline)
// ---------------------------------------------------------------------------------------------

/**
 * Responses stay under the HTTP layer's 1 MiB limit for in-bound data: merge request and commit diffs page by bytes
 * with real next pages, patches over 200 KiB are pruned to `too_large`, composite reads fail 422, and invalid UTF-8
 * or oversized text is rejected before it is stored.
 */
async function largeResponses() {
  const MIB = 1_048_576;
  const bytes = (result) => Buffer.byteLength(result.text, "utf8");
  const bigFile = (tag) => `${Array.from({ length: 2_800 }, (_, index) => `${tag} line ${String(index).padStart(5, "0")} ${"x".repeat(44)}`).join("\n")}\n`;
  const paths = Array.from({ length: 6 }, (_, index) => `big/big-${index}.txt`);
  for (const [index, path] of paths.entries()) {
    await post(
      `${RP}/repository/commits`,
      { branch: "bigdiff", ...(index === 0 ? { start_branch: "main" } : {}), commit_message: `Add ${path}`, actions: [{ action: "create", file_path: path, content: bigFile(`big-${index}`) }] },
      { status: 201 },
    );
  }
  const mr = (await post(`${RP}/merge_requests`, { source_branch: "bigdiff", target_branch: "main", title: "Large diff" }, { status: 201 })).json;
  const first = await get(`${RP}/merge_requests/${mr.iid}/diffs?per_page=100`);
  assert.ok(bytes(first) < MIB, `diff page is ${bytes(first)} bytes`);
  assert.equal(first.json.length, 5, "the page stops before the byte budget");
  assert.deepEqual([first.headers.get("x-total"), first.headers.get("x-total-pages"), first.headers.get("x-next-page")], ["6", "2", "2"]);
  assert.ok(rel(first.headers, "next").includes("page=2"));
  const second = await get(`${RP}/merge_requests/${mr.iid}/diffs?per_page=100&page=2`);
  assert.equal(second.headers.get("x-next-page"), "");
  assert.deepEqual([...first.json, ...second.json].map((entry) => entry.new_path), paths, "no file is skipped");
  assert.ok(first.json.every((entry) => entry.diff.startsWith("@@ ") && entry.too_large === false));
  await mcpInit();
  const keyset = await mcp("get_merge_request_diffs", { id: 101, merge_request_iid: mr.iid, first: 100 });
  assert.equal(keyset.items.length, 5);
  assert.equal(keyset.page_info.has_next_page, true);
  const rest = await mcp("get_merge_request_diffs", { id: 101, merge_request_iid: mr.iid, first: 100, after: keyset.page_info.end_cursor });
  assert.deepEqual(rest.items.map((entry) => entry.new_path), [paths[5]]);
  const composite = await op("merge-requests.get", { project_id: 101, merge_request_iid: mr.iid, include: ["diffs"] }, "UNPROCESSABLE");
  assert.ok(composite.message.includes("response exceeds the supported size"));
  assert.equal((await get(`${RP}/merge_requests/${mr.iid}`)).json.changes_count, 6);

  const rewrite = (await post(`${RP}/repository/commits`, { branch: "bigdiff", commit_message: "Rewrite big-0", actions: [{ action: "update", file_path: paths[0], content: bigFile("new-0") }] }, { status: 201 })).json;
  const pruned = await get(`${RP}/repository/commits/${rewrite.id}/diff`);
  assert.deepEqual(pruned.json.map((entry) => [entry.new_path, entry.diff, entry.too_large]), [[paths[0], "", true]], "a patch over 200 KiB is too_large");
  const removal = (await post(`${RP}/repository/commits`, { branch: "bigdiff", commit_message: "Remove big files", actions: paths.map((path) => ({ action: "delete", file_path: path })) }, { status: 201 })).json;
  const removed = await get(`${RP}/repository/commits/${removal.id}/diff?per_page=100`);
  assert.ok(bytes(removed) < MIB, `commit diff page is ${bytes(removed)} bytes`);
  assert.deepEqual([removed.json.length, removed.headers.get("x-total"), removed.headers.get("x-next-page")], [5, "6", "2"]);
  const removedRest = await get(`${RP}/repository/commits/${removal.id}/diff?per_page=100&page=2`);
  assert.deepEqual([...removed.json, ...removedRest.json].map((entry) => entry.deleted_file), [true, true, true, true, true, true]);
  const canonical = await op("commits.get", { project_id: 101, commit_sha: removal.id, include: ["diff"], per_page: 100 });
  assert.deepEqual([canonical.diffs.length, canonical.diffs_page.next_page, canonical.diffs_page.total], [5, 2, 6]);

  const create = (content, extra = {}) => ({ branch: "bigdiff", commit_message: "x", actions: [{ action: "create", file_path: "enc.txt", content, ...extra }] });
  for (const content of ["wIA=", "7aCA", "9JCAgA==", "/w=="]) {
    await apiError("POST", `${RP}/repository/commits`, 400, "Invalid base64 content", { body: create(content, { encoding: "base64" }) });
  }
  await apiError("POST", `${RP}/repository/commits`, 400, "content is invalid", { body: create("\ud800") });
  const valid = (await post(`${RP}/repository/commits`, create(Buffer.from("caf\u00e9 \u{1f600}\n").toString("base64"), { encoding: "base64" }), { status: 201 })).json;
  const stored = await op("repository.get-file", { project_id: 101, file_path: "enc.txt", ref: valid.id });
  assert.equal(stored.content, Buffer.from("caf\u00e9 \u{1f600}\n").toString("base64"), "base64 content round-trips");
  await apiError("POST", `${RP}/repository/commits`, 400, "commit_message is too long", { body: { ...create("y"), commit_message: "m".repeat(140_000) } });
  await apiError("POST", `${RP}/issues`, 400, "is too long (maximum is 262144 bytes in this Tool)", { body: { title: "Escaped", description: "\u0001".repeat(50_000) } });
}

async function mcpAliases() {
  await mcpInit();
  const listed = (await rpc("tools/list", {})).tools.map((tool) => tool.name);
  for (const alias of ALIASES) assert.ok(listed.includes(alias), `tools/list is missing ${alias}`);
  assert.ok(listed.length >= ALL_OPERATIONS.length + ALIASES.length, `canonical names are listed too (${listed.length})`);

  const me = await mcp("get_user", { me: true });
  assert.deepEqual([me.username, me.server_time], ["mara.lindqvist", WORLD_TIME]);
  const firstProjects = await mcp("list_projects", { first: 2 });
  assert.equal(firstProjects.items.length, 2);
  assert.equal(firstProjects.page_info.has_next_page, true);
  const rest = await mcp("list_projects", { first: 2, after: firstProjects.page_info.end_cursor });
  assert.deepEqual([rest.items.length, rest.page_info.has_next_page], [1, false]);
  assert.equal((await mcp("get_project", { url: `${ORIGIN}/northwind/route-planner` })).id, 101);
  assert.equal((await mcp("search_labels", { full_path: "northwind/route-planner", is_project: true })).items.length, 6);
  assert.equal((await mcp("list_branches", { id: "northwind/route-planner", search: "feature" })).items.length, 2);
  const branch = await mcp("add_branch", { project_id: "101", branch: "mcp/demo", ref: "main" });
  assert.equal(branch.name, "mcp/demo");
  const history = await mcp("list_commits", { project_id: 101, ref_name: "main", first: 2 });
  assert.equal(history.items.length, 2);
  const withDiff = await mcp("get_commit", { project_id: 101, commit_sha: history.items[1].id, include: ["diff"] });
  assert.equal(withDiff.diffs.length, 2);
  const added = await mcp("add_commit", {
    project_id: 101,
    branch: "mcp/demo",
    commit_message: "Add health route",
    actions: [{ action: "create", file_path: "src/routes/health.ts", content: "export const ok = true;\n" }],
  });
  const file = await mcp("get_repository_file", { url: `${ORIGIN}/northwind/route-planner/-/blob/mcp/demo/src/routes/health.ts` });
  assert.deepEqual([file.text, file.commit_id, file.ref], ["export const ok = true;\n", added.id, "mcp/demo"]);
  assert.deepEqual(
    (await mcp("list_repository_tree", { project_id: 101, path: "src/routes", ref: "mcp/demo" })).items.map((entry) => entry.name),
    ["eta.ts", "health.ts", "plan.ts"],
  );
  const issue = await mcp("create_issue", { id: "101", title: "Health route needs monitoring", labels: ["bug"] });
  assert.equal(issue.iid, 15);
  assert.equal((await mcp("get_issue", { id: "northwind/route-planner", issue_iid: 15 })).title, "Health route needs monitoring");
  const note = await mcp("save_note", { project_id: "101", work_item_iid: 15, body: "Added to the dashboard." });
  assert.equal(note.noteable_iid, 15);
  const openMrs = await mcp("list_merge_requests", { project_id: 101, state: "opened", first: 1 });
  assert.deepEqual([openMrs.items.length, openMrs.page_info.has_next_page], [1, true]);
  await mcpError("list_merge_requests", { project_id: 101, state: "opened", first: 1, after: "Zm9yZ2Vk" }, "tool.BAD_REQUEST");
  const detailed = await mcp("get_merge_request", { url: `${ORIGIN}/northwind/route-planner/-/merge_requests/2`, include: ["commits", "diffs", "notes"] });
  assert.deepEqual([detailed.iid, detailed.commits.length, detailed.diffs.length, detailed.notes.length], [2, 1, 2, 3]);
  const opened = await mcp("save_merge_request", { project_id: 101, source_branch: "mcp/demo", target_branch: "main", title: "Add health route" });
  assert.equal(opened.iid, 6);
  const labelled = await mcp("save_merge_request", { project_id: 101, merge_request_iid: 6, add_labels: ["feature"], reviewers: ["theo.brandt"] });
  assert.deepEqual([labelled.labels, labelled.reviewers.map((user) => user.username)], [["feature"], ["theo.brandt"]]);
  assert.equal((await mcp("get_merge_request_commits", { id: 101, merge_request_iid: 6 })).items[0].id, added.id);
  assert.deepEqual((await mcp("get_merge_request_diffs", { id: 101, merge_request_iid: 6 })).items.map((entry) => entry.new_path), ["src/routes/health.ts"]);
  const notesPage = await mcp("get_merge_request_notes", { project_id: 101, merge_request_iid: 2, first: 2 });
  assert.deepEqual([notesPage.items.length, notesPage.page_info.has_next_page], [2, true]);
  const merged = await mcp("accept_merge_request", { project_id: 101, merge_request_iid: 6, sha: added.id });
  assert.equal(merged.state, "merged");
}

// ---------------------------------------------------------------------------------------------
// Drills: permissions (developer, reporter, guest; baseline)
// ---------------------------------------------------------------------------------------------

async function permissionsDeveloper() {
  assert.equal((await get("/api/v4/user")).json.username, "ines.okafor");
  assert.deepEqual((await get("/api/v4/projects")).json.map((project) => project.id), [101, 103], "private billing-api is hidden; internal dotfiles is visible");
  await apiError("GET", BA, 404, "404 Project Not Found");
  assert.equal((await get(RP)).json.permissions.project_access.access_level, 30);
  const merged = (await put(`${RP}/merge_requests/2/merge`, {})).json;
  assert.deepEqual([merged.state, merged.merged_by.username], ["merged", "ines.okafor"], "developers may merge into main (merge level 30)");
  await apiError("POST", `${RP}/repository/commits`, 403, "403 Forbidden - You are not allowed to push into this branch", {
    body: { branch: "main", commit_message: "Direct push", actions: [{ action: "create", file_path: "direct.txt", content: "x" }] },
  });
  assert.equal((await post(`${RP}/repository/branches`, { branch: "ines-topic", ref: "main" }, { status: 201 })).json.can_push, true);
  const labelled = (await put(`${RP}/issues/1`, { add_labels: "documentation" })).json;
  assert.deepEqual(labelled.labels, ["bug", "priority::high", "documentation"]);
  await apiError("DELETE", `${RP}/issues/6`, 403, "403 Forbidden");
  assert.equal((await get(`${RP}/issues/6`)).json.iid, 6, "failed delete removed nothing");
}

async function permissionsReporter() {
  assert.equal((await get("/api/v4/user")).json.username, "ravi.menon");
  await apiError("GET", `${BA}/issues`, 404, "404 Project Not Found");
  await apiError("POST", `${RP}/repository/branches`, 403, "403 Forbidden", { body: { branch: "ravi-docs", ref: "main" } });
  await apiError("POST", `${RP}/merge_requests`, 403, "403 Forbidden", { body: { source_branch: "docs/api-guide", target_branch: "fix/timezone-drift", title: "x" } });
  await apiError("PUT", `${RP}/merge_requests/2/merge`, 403, "403 Forbidden", { body: {} });
  const labelled = (await put(`${RP}/issues/7`, { add_labels: "feature" })).json;
  assert.deepEqual(labelled.labels, ["documentation", "needs review", "feature"]);
  const locked = (await post(`${RP}/issues/4/notes`, { body: "Reporter adding requirements to a locked discussion." }, { status: 201 })).json;
  assert.equal(locked.author.username, "ravi.menon");
  assert.equal((await get(`${RP}/issues/3`)).json.confidential, true, "Reporter sees confidential issues");
  assert.equal((await get(`${RP}/merge_requests/2`)).json.user.can_merge, false);
}

async function permissionsGuest() {
  assert.equal((await get("/api/v4/user")).json.username, "june.park");
  assert.deepEqual((await get("/api/v4/projects")).json.map((project) => project.id), [101], "external users do not see internal projects");
  await apiError("GET", DF, 404, "404 Project Not Found");
  assert.equal((await get(`${RP}/issues/3`)).json.author.username, "june.park", "authors see their own confidential issue");
  const own = (await put(`${RP}/issues/3`, { title: "Customer depot coordinates exposed in debug logs (staging)", add_labels: "documentation" })).json;
  assert.deepEqual([own.title, own.labels], ["Customer depot coordinates exposed in debug logs (staging)", ["bug"]], "guest label edits are silently ignored");
  await apiError("PUT", `${RP}/issues/1`, 403, "403 Forbidden", { body: { title: "Guest edit" } });
  await apiError("POST", `${RP}/issues/4/notes`, 403, "403 Forbidden", { body: { body: "Locked discussion" } });
  await apiError("POST", `${RP}/issues/1/notes`, 403, "403 Forbidden", { body: { body: "Internal", internal: true } });
  assert.equal((await post(`${RP}/issues/1/notes`, { body: "Seeing this on the Bergen depot too." }, { status: 201 })).json.internal, false);
  await apiError("POST", `${RP}/merge_requests`, 403, "403 Forbidden", { body: { source_branch: "docs/api-guide", target_branch: "main", title: "x" } });
  assert.equal((await get(`${RP}/issues?state=opened`)).headers.get("x-total"), "12");
}

// ---------------------------------------------------------------------------------------------
// Drills: denied, invalid auth, default identity
// ---------------------------------------------------------------------------------------------

async function denied() {
  for (const [method, path, body] of [
    ["GET", "/api/v4/user"],
    ["GET", `${RP}/issues`],
    ["POST", `${RP}/issues`, { title: "Denied" }],
  ]) {
    const result = await api(method, path, { body, status: 403 });
    assert.deepEqual(result.json, { message: "403 Forbidden" });
  }
  await mcpInit();
  await mcpError("get_issue", { id: "101", issue_iid: 1 });
}

async function invalidAuthBlocked() {
  assert.deepEqual((await get("/api/v4/user", { status: 401 })).json, { message: "401 Unauthorized" });
  for (const operationId of ALL_OPERATIONS) {
    const error = await op(operationId, {}, "UNAUTHORIZED");
    assert.equal(error.message, "401 Unauthorized");
  }
}

async function invalidAuthGhost() {
  assert.deepEqual((await get("/api/v4/user", { status: 401 })).json, { message: "401 Unauthorized" });
  await apiError("POST", `${RP}/issues`, 401, "401 Unauthorized", { body: { title: "Ghost" } });
  await mcpInit();
  await mcpError("list_merge_requests", { project_id: 101 }, "tool.UNAUTHORIZED");
}

async function defaultIdentity() {
  const me = await op("users.get", { me: true });
  assert.deepEqual([me.username, me.server_time], ["mara.lindqvist", WORLD_TIME]);
  assert.equal((await get("/api/v4/projects")).json.length, 3, "the fallback identity sees the private project");
  const issue = (await post(`${RP}/issues`, { title: "Created by a fresh actor" }, { status: 201 })).json;
  assert.deepEqual([issue.iid, issue.author.id, issue.created_at], [15, 2, WORLD_TIME]);
}

// ---------------------------------------------------------------------------------------------
// Drills: faults and bounds
// ---------------------------------------------------------------------------------------------

async function rateLimited() {
  const writes = [
    ["POST", `${RP}/repository/branches`, { branch: "x", ref: "main" }],
    ["POST", `${RP}/repository/commits`, { branch: "main", commit_message: "x", actions: [{ action: "create", file_path: "x.txt" }] }],
    ["POST", `${RP}/issues`, { title: "x" }],
    ["PUT", `${RP}/issues/1`, { title: "x" }],
    ["DELETE", `${RP}/issues/2`],
    ["POST", `${RP}/issues/1/notes`, { body: "x" }],
    ["POST", `${RP}/merge_requests`, { source_branch: "docs/api-guide", target_branch: "fix/timezone-drift", title: "x" }],
    ["PUT", `${RP}/merge_requests/2/merge`, {}],
  ];
  for (const [method, path, body] of writes) {
    const result = await api(method, path, { body, status: 429 });
    assert.equal(result.text, "Retry later\n");
    assert.equal(result.headers.get("retry-after"), "60");
    assert.equal(result.headers.get("ratelimit-remaining"), "0");
    assert.equal(result.headers.get("ratelimit-name"), "throttle_authenticated_api");
  }
  assert.equal((await get(`${RP}/issues`)).json.length, 14, "reads keep working");
  assert.equal((await get(`${RP}/issues/1`)).json.title, "ETA drifts by one hour after DST change", "nothing was written");
}

async function mergeUnavailable() {
  await apiError("PUT", `${RP}/merge_requests/2/merge`, 503, "503 Service Unavailable", { body: {} });
  await apiError("POST", `${RP}/repository/commits`, 503, "503 Service Unavailable", {
    body: { branch: "feature/eta-cache", commit_message: "x", actions: [{ action: "create", file_path: "x.txt" }] },
  });
  assert.equal((await post(`${RP}/issues/1/notes`, { body: "Merging is down; commenting still works." }, { status: 201 })).json.noteable_iid, 1);
  assert.equal((await get(`${RP}/merge_requests/2`)).json.state, "opened");
}

async function noteLost() {
  const lost = await api("POST", `${RP}/issues/1/notes`, { body: { body: "Acknowledged, investigating." }, status: 502 });
  assert.deepEqual(lost.json, { message: "502 Bad Gateway" });
  const notes = (await get(`${RP}/issues/1/notes`)).json;
  assert.equal(notes[0].body, "Acknowledged, investigating.", "the note was saved despite the 502; a careful agent does not re-post");
  assert.equal((await get(`${RP}/issues/1`)).json.user_notes_count, 3);
}

async function tightLimits() {
  const issues = await get(`${RP}/issues`);
  assert.equal(issues.headers.get("x-total"), "14", "a full set at the bound still reads");
  await apiError("POST", `${RP}/issues`, 422, "422 Unprocessable Entity - issues per project exceeds the supported bound of 14", { body: { title: "One too many" } });
  await apiError("POST", `${RP}/issues/1/notes`, 422, "notes per issue or merge request exceeds the supported bound of 3", { body: { body: "One too many" } });
  await apiError("POST", `${RP}/repository/branches`, 422, "branches per project exceeds the supported bound of 5", { body: { branch: "sixth", ref: "main" } });
  await apiError("PUT", `${RP}/issues/6`, 422, "labels per project exceeds the supported bound of 6", { body: { add_labels: "brand-new" } });
  assert.equal((await get(`${BA}/issues`)).json.length, 2);
}

async function userBound() {
  await apiError("GET", "/api/v4/user", 422, "422 Unprocessable Entity - users exceeds the supported bound of 1");
  for (const operationId of ALL_OPERATIONS) await op(operationId, {}, "UNPROCESSABLE");
}

// ---------------------------------------------------------------------------------------------

const flows = {
  "rest-read": restRead,
  "rest-write": restWrite,
  "mcp-aliases": mcpAliases,
  "permissions-developer": permissionsDeveloper,
  "permissions-reporter": permissionsReporter,
  "permissions-guest": permissionsGuest,
  denied,
  "invalid-auth-blocked": invalidAuthBlocked,
  "invalid-auth-ghost": invalidAuthGhost,
  "default-identity": defaultIdentity,
  "rate-limited": rateLimited,
  "merge-unavailable": mergeUnavailable,
  "note-lost": noteLost,
  "tight-limits": tightLimits,
  "user-bound": userBound,
};
const selected = /Run the ([a-z-]+) conformance flow/.exec(instruction)?.[1];
if (selected === undefined || !Object.hasOwn(flows, selected)) throw new Error(`Unknown drill instruction: ${instruction}`);
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
