// GitHub Tool conformance target. A scripted Tool test, not a model-driven agent.
// Node built-ins only: fetch against the GitHub-shaped REST routes, the canonical /v1/operations endpoint and
// raw MCP JSON-RPC (Streamable HTTP) for the GitHub MCP server tool-name aliases.
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

const OWNER = "acme-robotics";
const REPO = "telemetry-service";
const R = `/repos/${OWNER}/${REPO}`;
const FC = "/repos/acme-robotics/fleet-console";
const DF = "/repos/dana-reyes/dotfiles";
const ZERO = "0".repeat(40);
const ONES = "1".repeat(40);
const ALL_OPERATIONS = [
  "users.get-authenticated",
  "repos.list-for-authenticated-user",
  "repos.get",
  "repos.list-branches",
  "repos.get-branch",
  "repos.create-branch",
  "repos.list-commits",
  "repos.get-commit",
  "repos.get-content",
  "repos.create-or-update-file",
  "issues.list-labels-for-repo",
  "issues.list",
  "issues.read",
  "issues.write",
  "issues.add-comment",
  "issues.add-labels",
  "issues.remove-label",
  "issues.add-assignees",
  "issues.search",
  "pulls.list",
  "pulls.read",
  "pulls.create",
  "pulls.update",
  "pulls.create-review",
  "pulls.check-merged",
  "pulls.merge",
];
const ALIASES = [
  "get_me",
  "list_branches",
  "create_branch",
  "list_commits",
  "get_commit",
  "get_file_contents",
  "create_or_update_file",
  "list_issues",
  "issue_read",
  "issue_write",
  "add_issue_comment",
  "search_issues",
  "list_pull_requests",
  "pull_request_read",
  "create_pull_request",
  "update_pull_request",
  "pull_request_review_write",
  "merge_pull_request",
];

// ---------------------------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------------------------

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const unb64 = (text) => Buffer.from(text, "base64").toString("utf8");

/** GitHub-shaped request. `status` is asserted; the JSON body (if any) and headers are returned. */
async function api(method, path, { body, status = 200, headers = {}, contentType, rawBody, scheme = "token" } = {}) {
  const hasBody = body !== undefined || rawBody !== undefined;
  const response = await fetch(`${HTTP}${path}`, {
    method,
    headers: {
      authorization: `${scheme} ${HTTP_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(hasBody ? { "content-type": contentType ?? "application/json" } : {}),
      ...headers,
    },
    ...(hasBody ? { body: rawBody ?? JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const json = text.length > 0 ? JSON.parse(text) : undefined;
  assert.equal(response.status, status, `${method} ${path} ${body === undefined ? "" : JSON.stringify(body).slice(0, 200)} -> ${response.status} ${text.slice(0, 400)}`);
  return { json, headers: response.headers, status: response.status };
}
const get = (path, options) => api("GET", path, options);
const post = (path, body, options) => api("POST", path, { ...options, body });
const patch = (path, body, options) => api("PATCH", path, { ...options, body });
const put = (path, body, options) => api("PUT", path, { ...options, body });
const del = (path, options) => api("DELETE", path, options);

/** Expect a GitHub-shaped error envelope: status, `message` containing `text`, `status` string field. */
async function apiError(method, path, status, text, options = {}) {
  const result = await api(method, path, { ...options, status });
  assert.ok(result.json && typeof result.json.message === "string", `${method} ${path}: no GitHub error envelope: ${JSON.stringify(result.json)}`);
  assert.equal(result.json.status, String(status), `${method} ${path}: status field ${JSON.stringify(result.json)}`);
  const texts = [result.json.message, ...(Array.isArray(result.json.errors) ? result.json.errors.map((error) => error.message ?? "") : [])];
  assert.ok(texts.some((candidate) => candidate.includes(text)), `${method} ${path}: expected message containing ${JSON.stringify(text)}, got ${JSON.stringify(result.json)}`);
  return result;
}

/** Canonical operation endpoint. */
async function op(operationId, args, expected = "ok") {
  const response = await fetch(`${HTTP}/v1/operations/github/${operationId}`, {
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
  assert.equal(json.outcome.error.code, `tool.${expected}`, JSON.stringify(json.outcome.error));
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
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "github-conformance", version: "0.1.0" } });
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

const numbers = (items) => items.map((item) => item.number);
const names = (items) => items.map((item) => item.name);
const rel = (headers, relation) => {
  const link = headers.get("link") ?? "";
  const match = new RegExp(`<([^>]+)>; rel="${relation}"`).exec(link);
  return match === null ? undefined : match[1];
};
async function walk(path, options = {}) {
  const pages = [];
  let next = path;
  while (next !== undefined) {
    const page = await get(next, options);
    pages.push(page.json);
    next = rel(page.headers, "next");
  }
  return pages;
}

// ---------------------------------------------------------------------------------------------
// Drill: rest-flow (maintainer = Dana, baseline)
// ---------------------------------------------------------------------------------------------

async function restFlow() {
  // Identity --------------------------------------------------------------------------------
  const me = (await get("/user")).json;
  assert.equal(me.login, "dana-reyes");
  assert.equal(me.plan.name, "free");
  assert.equal(me.total_private_repos, 1);
  assert.equal(me.email, "dana.reyes@example.test");
  const bearer = (await get("/user", { scheme: "Bearer" })).json;
  assert.equal(bearer.login, "dana-reyes", "Bearer scheme is accepted as well as token");

  // Repositories ------------------------------------------------------------------------------
  const repos = (await get("/user/repos")).json;
  assert.deepEqual(repos.map((repo) => repo.full_name), ["acme-robotics/fleet-console", "acme-robotics/telemetry-service", "dana-reyes/dotfiles"]);
  assert.equal(repos[0].permissions.admin, true);
  assert.equal((await get("/user/repos?visibility=private")).json.length, 1);
  assert.equal((await get("/user/repos?sort=updated")).json[0].full_name, "acme-robotics/telemetry-service");
  assert.deepEqual((await get("/user/repos?affiliation=owner")).json.map((repo) => repo.full_name), ["dana-reyes/dotfiles"]);
  assert.equal((await get("/user/repos?type=member")).json.length, 2);
  await apiError("GET", "/user/repos?type=all&visibility=public", 422, "cannot specify type");
  await apiError("GET", "/user/repos?affiliation=friend", 422, "Validation Failed");
  const telemetry = (await get("/repos/acme-robotics/Telemetry-Service")).json;
  assert.equal(telemetry.full_name, "acme-robotics/telemetry-service", "owner/repo are case-insensitive");
  assert.equal(telemetry.permissions.admin, true);
  assert.equal(telemetry.open_issues_count, 13);
  assert.equal(telemetry.license.spdx_id, "Apache-2.0");
  await apiError("GET", "/repos/acme-robotics/nope", 404, "Not Found");

  // Branches ----------------------------------------------------------------------------------
  const branches = (await get(`${R}/branches`)).json;
  assert.deepEqual(names(branches), ["chore/bump-deps", "docs/runbook", "feat/otel-exporter", "fix/metrics-buffer", "main"]);
  assert.deepEqual(names((await get(`${R}/branches?protected=true`)).json), ["main"]);
  // page / per_page coerce as api.github.com does: non-positive-integer values fall back to the defaults
  // (page 1, 30 items), per_page above 100 clamps to 100; none of them is a mapping error.
  const defaultBranches = (await get(`${R}/branches`)).json;
  for (const query of ["per_page=abc", "per_page=0", "per_page=-5", "per_page=2.5", "per_page=", "page=0", "page=-1", "page=zz", "per_page=__proto__&page=constructor"]) {
    assert.deepEqual((await get(`${R}/branches?${query}`)).json, defaultBranches, `?${query} answers the default page`);
  }
  assert.deepEqual((await get(`${R}/branches?per_page=500`)).json, (await get(`${R}/branches?per_page=100`)).json, "per_page above 100 clamps to 100");
  const clampedLink = (await get(`${R}/issues/31/comments?per_page=500&page=0`)).headers.get("link");
  assert.ok(clampedLink === null || clampedLink.includes("per_page=100"), `clamped link header: ${clampedLink}`);
  assert.equal((await get(`${R}/issues/31/comments?per_page=1&page=zz`)).headers.get("link")?.includes('rel="next"'), true, "page=zz is page 1");
  const branchPages = await walk(`${R}/branches?per_page=2`);
  assert.equal(branchPages.length, 3, "link header walks three pages");
  assert.deepEqual(branchPages.flat().map((branch) => branch.name), names(branches));
  const main = (await get(`${R}/branches/main`)).json;
  assert.equal(main.protection.required_pull_request_reviews.required_approving_review_count, 1);
  assert.equal(main.protection.required_pull_request_reviews.dismiss_stale_reviews, true);
  const C3 = main.commit.sha;
  assert.match(C3, /^[0-9a-f]{40}$/);
  const fixBranch = (await get(`${R}/branches/fix/metrics-buffer`)).json;
  assert.equal(fixBranch.name, "fix/metrics-buffer", "slashed branch names use the depth-2 route");
  assert.equal((await get(`${R}/branches/fix%2Fmetrics-buffer`, { status: 404 })).status, 404, "a percent-encoded slash is rejected by the framework's path matcher (documented)");
  const C4 = fixBranch.commit.sha;
  assert.equal(fixBranch.protected, false);
  await apiError("GET", `${R}/branches/nope`, 404, "Branch not found");

  // Commits -----------------------------------------------------------------------------------
  const mainCommits = (await get(`${R}/commits`)).json;
  assert.equal(mainCommits.length, 3);
  assert.equal(mainCommits[0].sha, C3);
  assert.equal(mainCommits[0].author.login, "dana-reyes");
  const C1 = mainCommits[2].sha;
  const fixCommits = (await get(`${R}/commits?sha=fix/metrics-buffer`)).json;
  assert.equal(fixCommits.length, 3);
  assert.equal(fixCommits[0].sha, C4);
  assert.equal((await get(`${R}/commits?path=package.json`)).json.length, 2);
  assert.equal((await get(`${R}/commits?author=sam-okoro`)).json.length, 1);
  assert.equal((await get(`${R}/commits?since=2026-08-20T00:00:00Z`)).json.length, 1);
  assert.equal((await get(`${R}/commits?until=2026-08-10T00:00:00Z`)).json.length, 1);
  await apiError("GET", `${R}/commits?sha=${ZERO}`, 404, "No commit found for SHA");
  await apiError("GET", `${R}/commits?since=yesterday`, 422, "Validation Failed");
  const commitPage = await get(`${R}/commits?per_page=2`);
  assert.equal(commitPage.json.length, 2);
  assert.ok(rel(commitPage.headers, "next"));
  const c3 = (await get(`${R}/commits/${C3}`)).json;
  assert.ok(c3.stats.total > 0);
  assert.equal(c3.files.length, 2);
  assert.ok(c3.files[0].patch.startsWith("@@"));
  assert.equal((await get(`${R}/commits/main`)).json.sha, C3);
  assert.equal((await get(`${R}/commits/fix/metrics-buffer`)).json.sha, C4, "depth-2 commit route");
  await apiError("GET", `${R}/commits/${ONES}`, 404, "No commit found for SHA");

  // Contents ----------------------------------------------------------------------------------
  const root = (await get(`${R}/contents`)).json;
  assert.deepEqual(names(root), ["README.md", "package.json", "src"]);
  assert.equal(root[2].type, "dir");
  const buffer = (await get(`${R}/contents/src/metrics/buffer.ts?ref=fix/metrics-buffer`)).json;
  assert.equal(buffer.type, "file");
  assert.equal(buffer.encoding, "base64");
  assert.ok(unb64(buffer.content).includes("capacity"));
  assert.match(buffer.sha, /^[0-9a-f]{40}$/);
  const src = (await get(`${R}/contents/src`)).json;
  assert.deepEqual(names(src), ["config.ts", "exporter.ts", "index.ts", "metrics"]);
  await apiError("GET", `${R}/contents/nope`, 404, "Not Found");
  assert.equal((await get(`${R}/contents/a/b/c/d/e`, { status: 404 })).status, 404, "deeper than four segments is unroutable");
  await apiError("GET", `${R}/contents/README.md?ref=${ZERO}`, 404, "No commit found");
  // Inherited Object member names are ordinary missing names (never a lookup on the prototype chain).
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "__defineGetter__"]) {
    await apiError("GET", `${R}/contents/${name}`, 404, "Not Found");
    await apiError("GET", `${R}/contents/src/${name}`, 404, "Not Found");
    await apiError("GET", `${R}/contents/${name}/x`, 404, "Not Found");
    await apiError("GET", `${R}/contents/README.md?ref=${name}`, 404, "No commit found");
    await apiError("GET", `${R}/branches/${name}`, 404, "Branch not found");
    await apiError("GET", `${R}/commits/${name}`, 404, "No commit found for SHA");
    await apiError("DELETE", `${R}/issues/31/labels/${name}`, 404, "Label does not exist");
    assert.deepEqual((await get(`${R}/issues?labels=${name}`)).json, [], `labels=${name} matches nothing`);
  }
  assert.equal((await get(`${R}/labels/constructor`, { status: 404 })).status, 404, "single-label reads are not an implemented route");
  await apiError("POST", `${R}/pulls/47/reviews`, 422, "Validation Failed", { body: { event: "constructor", body: "x" } });

  // Create and update a file ------------------------------------------------------------------
  const created = (await put(`${R}/contents/docs/CHANGELOG.md`, { message: "docs: start the changelog", content: b64("# Changelog\n\n## 1.5.0\n"), branch: "main" })).json;
  assert.equal(created.commit.parents[0].sha, C3);
  assert.equal(created.content.encoding, "base64");
  assert.equal(unb64(created.content.content), "# Changelog\n\n## 1.5.0\n");
  const BLOB1 = created.content.sha;
  await apiError("PUT", `${R}/contents/docs/CHANGELOG.md`, 422, '"sha" wasn\'t supplied', { body: { message: "again", content: b64("x"), branch: "main" } });
  await apiError("PUT", `${R}/contents/docs/CHANGELOG.md`, 409, "does not match", { body: { message: "again", content: b64("x"), branch: "main", sha: ZERO } });
  const updated = (await put(`${R}/contents/docs/CHANGELOG.md`, { message: "docs: add 1.5.1", content: b64("# Changelog\n\n## 1.5.1\n\n## 1.5.0\n"), branch: "main", sha: BLOB1 })).json;
  assert.notEqual(updated.content.sha, BLOB1);
  assert.equal(updated.commit.parents[0].sha, created.commit.sha);
  assert.equal((await get(`${R}/commits?sha=main`)).json.length, 5);
  assert.equal((await get(`${R}/branches/main`)).json.commit.sha, updated.commit.sha);
  assert.equal((await api("PUT", `${R}/contents/docs/NOTES.md`, { body: { message: "x", content: "!!!not base64", branch: "main" }, status: 400 })).status, 400, "invalid base64 is a request mapping error");
  await apiError("PUT", `${R}/contents/docs/NOTES.md`, 422, "Validation Failed", { body: { message: "", content: b64("x"), branch: "main" } });
  // JSON nesting past 512 levels is refused while decoding (400), before recursive argument validation can overflow.
  const nest = (depth, leaf, wrap) => { let value = leaf; for (let i = 0; i < depth; i += 1) value = wrap(value); return value; };
  for (const depth of [600, 2950, 2998, 3152]) {
    assert.equal((await api("POST", `${R}/issues/31/comments`, { rawBody: JSON.stringify({ body: nest(depth, 1, (v) => ({ a: v })) }), status: 400 })).status, 400, `object body nested ${depth}`);
    assert.equal((await api("PATCH", `${R}/pulls/47`, { rawBody: JSON.stringify({ reviewers: nest(depth, 1, (v) => [v]) }), status: 400 })).status, 400, `array body nested ${depth}`);
    assert.equal((await api("POST", `${R}/issues/31/labels`, { rawBody: JSON.stringify(nest(depth, "bug", (v) => [v])), status: 400 })).status, 400, `labels nested ${depth}`);
  }
  await apiError("PUT", `${R}/contents/docs/NOTES.md`, 404, "Branch not found", { body: { message: "x", content: b64("x"), branch: "nope" } });

  // Labels and issue listing --------------------------------------------------------------------
  assert.deepEqual(names((await get(`${R}/labels`)).json), ["bug", "documentation", "enhancement", "good first issue", "help wanted", "priority: high", "wontfix"]);
  const openIssues = (await get(`${R}/issues`)).json;
  assert.deepEqual(numbers(openIssues), [43, 41, 40, 39, 37, 36, 35, 33, 31]);
  assert.ok(openIssues.every((issue) => issue.pull_request === undefined), "pull requests are excluded");
  assert.equal((await get(`${R}/issues?state=all`)).json.length, 12);
  const emptyPage = await get(`${R}/issues?state=closed&page=3&per_page=2`);
  assert.deepEqual(emptyPage.json, []);
  assert.ok(rel(emptyPage.headers, "prev"));
  assert.deepEqual(numbers((await get(`${R}/issues?labels=bug,priority:%20high`)).json), [31]);
  assert.equal((await get(`${R}/issues?assignee=none`)).json.length, 7);
  assert.deepEqual(numbers((await get(`${R}/issues?assignee=*`)).json), [36, 31]);
  assert.deepEqual(numbers((await get(`${R}/issues?creator=release-bot`)).json), [39]);
  assert.deepEqual(numbers((await get(`${R}/issues?since=2026-09-08T00:00:00Z`)).json), [43, 37]);
  assert.equal((await get(`${R}/issues?sort=comments&direction=desc`)).json[0].number, 31);
  const issuePages = await walk(`${R}/issues?state=all&per_page=5`);
  assert.equal(issuePages.length, 3);
  assert.equal(issuePages.flat().length, 12);
  await apiError("GET", `${R}/issues?mentioned=dana-reyes`, 422, "Validation Failed");
  await apiError("GET", `${R}/issues?sort=bogus`, 422, "Validation Failed");
  const issue31 = (await get(`${R}/issues/31`)).json;
  assert.equal(issue31.title, "Metrics buffer grows without bound under sustained load");
  assert.deepEqual(names(issue31.labels), ["bug", "priority: high"]);
  assert.equal(issue31.assignee.login, "priya-nair");
  assert.equal(issue31.comments, 3);
  assert.equal(issue31.author_association, "MEMBER");
  const issue45 = (await get(`${R}/issues/45`)).json;
  assert.ok(issue45.pull_request.url.endsWith("/pulls/45"), "pull numbers are served with the pull_request stub");
  assert.equal(issue45.draft, false);
  await apiError("GET", `${R}/issues/99`, 404, "Not Found");
  const comments31 = (await get(`${R}/issues/31/comments`)).json;
  assert.equal(comments31.length, 3);
  assert.equal(comments31[0].user.login, "priya-nair");
  assert.ok(rel((await get(`${R}/issues/31/comments?per_page=2`)).headers, "next"));
  assert.equal((await get(`${R}/issues/31/labels`)).json.length, 2);

  // Issue writes ------------------------------------------------------------------------------
  const issue48 = (await post(`${R}/issues`, { title: "Exporter drops samples when the console is offline", body: "Seen during the 2026-09-13 outage.", labels: ["bug", "needs-triage"], assignees: ["priya-nair"] }, { status: 201 })).json;
  assert.equal(issue48.number, 48);
  assert.deepEqual(names(issue48.labels), ["bug", "needs-triage"], "unknown labels are created for triage and above");
  assert.equal(issue48.assignees.length, 1);
  assert.equal(issue48.author_association, "MEMBER");
  assert.equal((await get(R)).json.open_issues_count, 14);
  assert.equal((await get(`${R}/labels`)).json.length, 8);
  const missingTitle = await apiError("POST", `${R}/issues`, 422, "Validation Failed", { body: { body: "no title" } });
  assert.equal(missingTitle.json.errors[0].code, "missing_field");
  await apiError("POST", `${R}/issues`, 422, "Validation Failed", { body: { title: "   " } });
  const closed48 = (await patch(`${R}/issues/48`, { state: "closed", state_reason: "not_planned" })).json;
  assert.equal(closed48.state, "closed");
  assert.equal(closed48.state_reason, "not_planned");
  assert.ok(closed48.closed_at);
  assert.equal(closed48.closed_by.login, "dana-reyes");
  assert.equal((await get(R)).json.open_issues_count, 13);
  await apiError("PATCH", `${R}/issues/48`, 422, "Validation Failed", { body: { state: "open", state_reason: "completed" } });
  const reopened48 = (await patch(`${R}/issues/48`, { state: "open" })).json;
  assert.equal(reopened48.state_reason, "reopened");
  assert.equal(reopened48.closed_at, null);
  const badAssignee = await apiError("PATCH", `${R}/issues/48`, 422, "Validation Failed", { body: { assignees: ["nobody"] } });
  assert.equal(badAssignee.json.errors[0].field, "assignees");
  await apiError("PATCH", `${R}/issues/48`, 422, "Validation Failed", { body: { title: "" } });
  await apiError("PATCH", `${R}/issues/45`, 422, "Validation Failed", { body: { title: "x" } });
  assert.deepEqual(names((await patch(`${R}/issues/48`, { labels: ["documentation"] })).json.labels), ["documentation"], "labels replace the whole set");
  await apiError("PATCH", `${R}/issues/48`, 422, "Validation Failed", { body: { milestone: 3 } });

  // Comments, labels, assignees -----------------------------------------------------------------
  const comment = (await post(`${R}/issues/48/comments`, { body: "Investigating with the console team." }, { status: 201 })).json;
  assert.equal(comment.user.login, "dana-reyes");
  assert.equal((await get(`${R}/issues/48`)).json.comments, 1);
  await apiError("POST", `${R}/issues/48/comments`, 422, "Validation Failed", { body: { body: "" } });
  assert.equal((await post(`${R}/issues/35/comments`, { body: "Locking stays; discussion continues in #43." }, { status: 201 })).json.issue_url.endsWith("/issues/35"), true, "triage and above may comment on locked issues");
  assert.deepEqual(names((await post(`${R}/issues/48/labels`, ["enhancement"])).json), ["documentation", "enhancement"], "bare-array body");
  assert.deepEqual(names((await post(`${R}/issues/48/labels`, { labels: ["wontfix"] })).json), ["documentation", "enhancement", "wontfix"]);
  await apiError("POST", `${R}/issues/48/labels`, 422, "Validation Failed", { body: { labels: ["   "] } });
  await apiError("DELETE", `${R}/issues/48/labels/priority%3A%20high`, 404, "Label does not exist");
  assert.deepEqual(names((await del(`${R}/issues/31/labels/priority%3A%20high`)).json), ["bug"]);
  const assigned = (await post(`${R}/issues/48/assignees`, { assignees: ["sam-okoro"] }, { status: 201 })).json;
  assert.deepEqual(assigned.assignees.map((user) => user.login), ["priya-nair", "sam-okoro"]);
  await apiError("POST", `${R}/issues/48/assignees`, 422, "Validation Failed", { body: { assignees: ["ghost-user"] } });

  // Search ------------------------------------------------------------------------------------
  const bugs = (await get(`/search/issues?q=${encodeURIComponent("repo:acme-robotics/telemetry-service is:issue is:open label:bug")}`)).json;
  assert.equal(bugs.total_count, 1, "#48 lost its bug label when the label set was replaced");
  assert.equal(bugs.incomplete_results, false);
  assert.deepEqual(numbers(bugs.items), [31]);
  assert.deepEqual(numbers((await get(`/search/issues?q=${encodeURIComponent("repo:acme-robotics/telemetry-service is:issue label:documentation")}`)).json.items), [48, 43, 37, 32]);
  const bufferSearch = (await get(`/search/issues?q=${encodeURIComponent("buffer in:title")}`)).json;
  assert.ok(bufferSearch.total_count >= 2);
  assert.ok(bufferSearch.items.every((item) => item.title.toLowerCase().includes("buffer")));
  assert.ok(bufferSearch.items.every((item) => typeof item.score === "number"));
  assert.deepEqual(numbers((await get(`/search/issues?q=${encodeURIComponent("is:pr is:open author:priya-nair")}`)).json.items), [46, 45]);
  const merged = (await get(`/search/issues?q=${encodeURIComponent("is:merged")}`)).json;
  assert.equal(merged.total_count, 1);
  assert.equal(merged.items[0].repository_url.endsWith("/fleet-console"), true);
  const busy = (await get(`/search/issues?q=${encodeURIComponent("comments:>2")}`)).json;
  assert.ok(busy.items.length >= 1 && busy.items.every((item) => item.comments > 2));
  const unsupported = await apiError("GET", `/search/issues?q=${encodeURIComponent("org:acme")}`, 422, "Validation Failed");
  assert.ok(unsupported.json.errors[0].message.includes("Unsupported qualifier"));
  await apiError("GET", "/search/issues?q=", 422, "Validation Failed");
  await apiError("GET", `/search/issues?q=is:open&sort=reactions`, 422, "Validation Failed");
  const sorted = (await get(`/search/issues?q=is:open&sort=updated&order=asc`)).json.items;
  assert.ok(sorted.length > 2 && sorted[0].updated_at <= sorted[1].updated_at);
  const searchPage = await get(`/search/issues?q=is:open&per_page=2&page=2`);
  assert.equal(searchPage.json.items.length, 2);
  assert.ok(rel(searchPage.headers, "prev"));

  // Pull request reads ----------------------------------------------------------------------------
  assert.deepEqual(numbers((await get(`${R}/pulls`)).json), [44, 47, 46, 45], "newest created first");
  assert.deepEqual(numbers((await get(`${R}/pulls?sort=updated&direction=asc`)).json), [45, 46, 47, 44]);
  assert.equal((await get(`${R}/pulls?state=all`)).json.length, 5);
  assert.deepEqual(numbers((await get(`${R}/pulls?head=acme-robotics:fix/metrics-buffer`)).json), [45]);
  assert.equal((await get(`${R}/pulls?base=main`)).json.length, 4);
  assert.ok(!("mergeable" in (await get(`${R}/pulls`)).json[0]), "list items omit the full-only fields");
  await apiError("GET", `${R}/pulls?sort=popularity`, 422, "Validation Failed");
  await apiError("GET", `${R}/pulls?state=bogus`, 422, "Validation Failed");
  const pull45 = (await get(`${R}/pulls/45`)).json;
  assert.equal(pull45.mergeable, true);
  assert.equal(pull45.mergeable_state, "clean");
  assert.equal(pull45.commits, 1);
  assert.equal(pull45.changed_files, 2);
  assert.equal(pull45.merged, false);
  assert.equal(pull45.head.sha, C4);
  assert.equal(pull45.base.sha, updated.commit.sha, "base sha follows the base branch after the file commits");
  assert.equal((await get(`${R}/pulls/44`)).json.mergeable_state, "draft");
  assert.equal((await get(`${R}/pulls/46`)).json.mergeable_state, "blocked");
  const pull47 = (await get(`${R}/pulls/47`)).json;
  assert.equal(pull47.mergeable, false);
  assert.equal(pull47.mergeable_state, "dirty");
  await apiError("GET", `${R}/pulls/31`, 404, "Not Found");
  const files45 = (await get(`${R}/pulls/45/files`)).json;
  assert.equal(files45.length, 2);
  assert.ok(files45[0].patch.startsWith("@@"));
  assert.deepEqual((await get(`${R}/pulls/45/commits`)).json.map((commit) => commit.sha), [C4]);
  const reviews45 = (await get(`${R}/pulls/45/reviews`)).json;
  assert.equal(reviews45.length, 1);
  assert.equal(reviews45[0].state, "APPROVED");
  assert.equal(reviews45[0].user.login, "sam-okoro");
  await apiError("GET", `${R}/pulls/45/merge`, 404, "Not Found");
  const fleetMerged = await get(`${FC}/pulls/9/merge`, { status: 204 });
  assert.equal(fleetMerged.json, undefined);

  // Merging -----------------------------------------------------------------------------------
  await apiError("PUT", `${R}/pulls/47/merge`, 405, "Pull Request is not mergeable", { body: {} });
  await apiError("PUT", `${R}/pulls/44/merge`, 405, "Pull Request is not mergeable", { body: {} });
  await apiError("PUT", `${R}/pulls/46/merge`, 405, "approving review is required", { body: {} });
  await apiError("PUT", `${R}/pulls/38/merge`, 405, "Pull Request is not mergeable", { body: {} });
  await apiError("PUT", `${R}/pulls/45/merge`, 409, "Head branch was modified", { body: { sha: ZERO } });
  await apiError("PUT", `${R}/pulls/45/merge`, 422, "Validation Failed", { body: { merge_method: "fast-forward" } });
  const squash = (await put(`${R}/pulls/45/merge`, { merge_method: "squash", commit_title: "Cap the metrics buffer (#45)", sha: C4 })).json;
  assert.equal(squash.merged, true);
  assert.equal(squash.message, "Pull Request successfully merged");
  const SQUASH = squash.sha;
  const merged45 = (await get(`${R}/pulls/45`)).json;
  assert.equal(merged45.merged, true);
  assert.equal(merged45.merge_commit_sha, SQUASH);
  assert.equal(merged45.state, "closed");
  assert.equal(merged45.merged_by.login, "dana-reyes");
  assert.equal(merged45.mergeable_state, "unknown");
  await get(`${R}/pulls/45/merge`, { status: 204 });
  assert.equal((await get(`${R}/commits?sha=main`)).json.length, 6);
  const squashCommit = (await get(`${R}/commits/${SQUASH}`)).json;
  assert.equal(squashCommit.parents.length, 1);
  assert.ok(squashCommit.commit.message.startsWith("Cap the metrics buffer (#45)"));
  assert.equal((await get(`${R}/branches/main`)).json.commit.sha, SQUASH);
  assert.ok(unb64((await get(`${R}/contents/src/metrics/buffer.ts`)).json.content).includes("capacity"), "the merged file is on main");
  const pull46 = (await get(`${R}/pulls/46`)).json;
  assert.equal(pull46.mergeable_state, "blocked");
  assert.equal(pull46.mergeable, true);
  assert.equal(pull46.base.sha, SQUASH);
  await apiError("PATCH", `${R}/pulls/45`, 422, "merged pull request", { body: { state: "open" } });
  const approval = (await post(`${R}/pulls/46/reviews`, { event: "APPROVE" })).json;
  assert.equal(approval.state, "APPROVED");
  assert.equal(approval.commit_id, pull46.head.sha);
  assert.equal((await get(`${R}/pulls/46`)).json.mergeable_state, "clean");
  const rebase = (await put(`${R}/pulls/46/merge`, { merge_method: "rebase" })).json;
  assert.equal(rebase.merged, true);
  assert.equal((await get(`${R}/commits?sha=main`)).json.length, 7);
  const rebased = (await get(`${R}/commits/${rebase.sha}`)).json;
  assert.equal(rebased.parents[0].sha, SQUASH);
  assert.equal(rebased.commit.message, "Add an OpenTelemetry exporter skeleton");
  assert.equal((await get(`${R}/pulls/46`)).json.merged, true);
  assert.equal((await get(R)).json.open_issues_count, 12, "13 + #48 - #45 - #46");

  // Branch and pull creation --------------------------------------------------------------------
  await apiError("POST", `${R}/pulls`, 422, "already exists", { body: { title: "dup", head: "docs/runbook", base: "main" } });
  await apiError("POST", `${R}/pulls`, 422, "Validation Failed", { body: { title: "same", head: "main", base: "main" } });
  const badHead = await apiError("POST", `${R}/pulls`, 422, "Validation Failed", { body: { title: "x", head: "ghost-branch", base: "main" } });
  assert.equal(badHead.json.errors[0].field, "head");
  assert.equal((await apiError("POST", `${R}/pulls`, 422, "Validation Failed", { body: { title: "x", head: "docs/runbook", base: "nope" } })).json.errors[0].field, "base");
  await apiError("POST", `${R}/pulls`, 422, "Validation Failed", { body: { title: "x", head: "someone-else:docs/runbook", base: "main" } });
  const ref = (await post(`${R}/git/refs`, { ref: "refs/heads/feat/retry-policy", sha: rebase.sha }, { status: 201 })).json;
  assert.equal(ref.ref, "refs/heads/feat/retry-policy");
  assert.equal(ref.object.sha, rebase.sha);
  await apiError("POST", `${R}/git/refs`, 422, "Reference already exists", { body: { ref: "refs/heads/feat/retry-policy", sha: rebase.sha } });
  await apiError("POST", `${R}/git/refs`, 422, "Validation Failed", { body: { ref: "heads/x", sha: rebase.sha } });
  await apiError("POST", `${R}/git/refs`, 422, "Object does not exist", { body: { ref: "refs/heads/y", sha: ONES } });
  assert.equal((await post(`${R}/git/refs`, { ref: "refs/heads/from-default" }, { status: 201 })).json.object.sha, rebase.sha, "missing sha defaults to the default branch head (extension)");
  await apiError("POST", `${R}/pulls`, 422, "No commits between main and feat/retry-policy", { body: { title: "Add retry policy", head: "feat/retry-policy", base: "main" } });
  await put(`${R}/contents/src/retry.ts`, { message: "Add a retry policy", content: b64("export const retries = 3;\n"), branch: "feat/retry-policy" });
  const pull49 = (await post(`${R}/pulls`, { title: "Add retry policy", head: "feat/retry-policy", base: "main", draft: true }, { status: 201 })).json;
  assert.equal(pull49.number, 49);
  assert.equal(pull49.commits, 1);
  assert.equal(pull49.draft, true);
  assert.equal(pull49.mergeable_state, "draft");
  assert.equal(pull49.changed_files, 1);
  assert.equal(pull49.head.label, "acme-robotics:feat/retry-policy");
  const ready = (await patch(`${R}/pulls/49`, { draft: false, body: "Adds exponential backoff to the exporter." })).json;
  assert.equal(ready.draft, false);
  assert.equal(ready.mergeable_state, "blocked");
  await apiError("POST", `${R}/pulls/49/reviews`, 422, "Can not approve your own pull request", { body: { event: "APPROVE" } });
  await apiError("POST", `${R}/pulls/49/reviews`, 422, "Can not request changes on your own pull request", { body: { event: "REQUEST_CHANGES", body: "x" } });
  await apiError("POST", `${R}/pulls/49/reviews`, 422, "Review body is required", { body: { event: "COMMENT" } });
  await apiError("POST", `${R}/pulls/49/reviews`, 422, "Validation Failed", { body: { event: "BOGUS", body: "x" } });
  assert.equal((await post(`${R}/pulls/49/reviews`, { event: "COMMENT", body: "Self-note: add a test." })).json.state, "COMMENTED");
  assert.equal((await api("POST", `${R}/pulls/49/reviews`, { body: { event: "COMMENT", body: "x", comments: [{ path: "src/retry.ts", body: "nit" }] }, status: 400 })).status, 400, "review comments are unsupported");
  await apiError("POST", `${R}/pulls/99/reviews`, 404, "Not Found", { body: { event: "APPROVE" } });
  const closed49 = (await patch(`${R}/pulls/49`, { state: "closed" })).json;
  assert.ok(closed49.closed_at);
  assert.equal(closed49.merged, false);
  await apiError("PATCH", `${R}/pulls/38`, 422, "Validation Failed", { body: { state: "open" } });
  const rebased47 = (await patch(`${R}/pulls/47`, { base: "docs/runbook" })).json;
  assert.equal(rebased47.base.ref, "docs/runbook");
  assert.equal(rebased47.mergeable_state, "dirty");
  await apiError("PATCH", `${R}/pulls/47`, 422, "Validation Failed", { body: { base: "nope" } });
  await apiError("PATCH", `${R}/pulls/47`, 422, "Validation Failed", { body: { title: "" } });
  await apiError("PATCH", `${R}/pulls/99`, 404, "Not Found", { body: { title: "x" } });
  await apiError("PATCH", `${R}/pulls/44`, 422, "Review cannot be requested from pull request author", { body: { reviewers: ["dana-reyes"] } });
  assert.deepEqual((await patch(`${R}/pulls/44`, { reviewers: ["lee-chen"] })).json.requested_reviewers.map((user) => user.login), ["lee-chen"]);

  // Archived repository: every write is forbidden, reads keep working ---------------------------------
  const archived = "Repository was archived so is read-only.";
  await apiError("POST", `${DF}/issues`, 403, archived, { body: { title: "x" } });
  await apiError("PATCH", `${DF}/issues/2`, 403, archived, { body: { title: "x" } });
  await apiError("POST", `${DF}/issues/2/comments`, 403, archived, { body: { body: "x" } });
  await apiError("POST", `${DF}/issues/2/labels`, 403, archived, { body: { labels: ["x"] } });
  await apiError("DELETE", `${DF}/issues/2/labels/x`, 403, archived);
  await apiError("POST", `${DF}/issues/2/assignees`, 403, archived, { body: { assignees: ["dana-reyes"] } });
  await apiError("POST", `${DF}/git/refs`, 403, archived, { body: { ref: "refs/heads/x", sha: ZERO } });
  await apiError("PUT", `${DF}/contents/x.md`, 403, archived, { body: { message: "x", content: b64("x") } });
  await apiError("POST", `${DF}/pulls`, 403, archived, { body: { title: "x", head: "x", base: "main" } });
  await apiError("PATCH", `${DF}/pulls/1`, 403, archived, { body: { title: "x" } });
  await apiError("POST", `${DF}/pulls/1/reviews`, 403, archived, { body: { event: "APPROVE" } });
  await apiError("PUT", `${DF}/pulls/1/merge`, 403, archived, { body: {} });
  assert.equal((await get(`${DF}/issues/2`)).json.title, "Move to a private repository");
  assert.equal((await get(DF)).json.archived, true);

  // Unknown repository: every repository-scoped operation answers 404 ---------------------------------
  const X = "/repos/acme-robotics/nope";
  await apiError("GET", `${X}/branches`, 404, "Not Found");
  await apiError("GET", `${X}/branches/main`, 404, "Not Found");
  await apiError("POST", `${X}/git/refs`, 404, "Not Found", { body: { ref: "refs/heads/x", sha: ZERO } });
  await apiError("GET", `${X}/commits`, 404, "Not Found");
  await apiError("GET", `${X}/commits/main`, 404, "Not Found");
  await apiError("GET", `${X}/contents`, 404, "Not Found");
  await apiError("PUT", `${X}/contents/x.md`, 404, "Not Found", { body: { message: "x", content: b64("x") } });
  await apiError("GET", `${X}/labels`, 404, "Not Found");
  await apiError("GET", `${X}/issues`, 404, "Not Found");
  await apiError("GET", `${X}/issues/1`, 404, "Not Found");
  await apiError("POST", `${X}/issues`, 404, "Not Found", { body: { title: "x" } });
  await apiError("POST", `${X}/issues/1/comments`, 404, "Not Found", { body: { body: "x" } });
  await apiError("POST", `${X}/issues/1/labels`, 404, "Not Found", { body: { labels: ["x"] } });
  await apiError("DELETE", `${X}/issues/1/labels/x`, 404, "Not Found");
  await apiError("POST", `${X}/issues/1/assignees`, 404, "Not Found", { body: { assignees: ["dana-reyes"] } });
  await apiError("GET", `${X}/pulls`, 404, "Not Found");
  await apiError("GET", `${X}/pulls/1`, 404, "Not Found");
  await apiError("POST", `${X}/pulls`, 404, "Not Found", { body: { title: "x", head: "x", base: "main" } });
  await apiError("PATCH", `${X}/pulls/1`, 404, "Not Found", { body: { title: "x" } });
  await apiError("POST", `${X}/pulls/1/reviews`, 404, "Not Found", { body: { event: "APPROVE" } });
  await apiError("GET", `${X}/pulls/1/merge`, 404, "Not Found");
  await apiError("PUT", `${X}/pulls/1/merge`, 404, "Not Found", { body: {} });

  // Framework boundaries and canonical-only argument shapes ---------------------------------------
  assert.equal((await get(`${R}/milestones`, { status: 404 })).status, 404, "unimplemented GitHub routes do not exist");
  assert.equal((await api("POST", `${R}/issues`, { rawBody: "title=x", contentType: "application/x-www-form-urlencoded", status: 415 })).status, 415);
  await op("issues.read", { owner: OWNER, repo: REPO, issue_number: 31, method: "get_sub_issues" }, "VALIDATION_FAILED");
  await op("repos.get-content", { owner: OWNER, repo: REPO, path: "../etc/passwd" }, "VALIDATION_FAILED");
  await op("repos.get-content", { owner: OWNER, repo: REPO, path: "README.md", ref: "main", sha: C4 }, "VALIDATION_FAILED");
  await op("issues.list", { owner: OWNER, repo: REPO, milestone: "v1" }, "VALIDATION_FAILED");
  await op("pulls.read", { owner: OWNER, repo: REPO, pullNumber: 44, method: "get_diff" }, "VALIDATION_FAILED");
  assert.equal((await op("pulls.read", { owner: OWNER, repo: REPO, pullNumber: 45, method: "get_comments" })).comments.length, 2);
  const stats = await op("repos.get-commit", { owner: OWNER, repo: REPO, sha: "main", detail: "stats" });
  assert.ok(stats.files.every((file) => file.patch === undefined));
  assert.equal((await op("repos.get-commit", { owner: OWNER, repo: REPO, sha: "main", detail: "none" })).files, undefined);
  const utf = await op("repos.get-content", { owner: OWNER, repo: REPO, path: "README.md" });
  assert.equal(utf.encoding, "utf-8");
  assert.ok(utf.content.startsWith("# telemetry-service"));
  await op("pulls.create-review", { owner: OWNER, repo: REPO, pullNumber: 44, event: "COMMENT", body: "x", commitID: C4, commit_id: C3 }, "VALIDATION_FAILED");
  await op("pulls.merge", { owner: OWNER, repo: REPO, pullNumber: 44, sha: C4, expectedHeadSha: C3 }, "VALIDATION_FAILED");

  // Inherited Object member names are real names when created (GitHub accepts them) -----------------------
  assert.equal((await post(`${R}/git/refs`, { ref: "refs/heads/constructor" }, { status: 201 })).json.ref, "refs/heads/constructor");
  assert.equal((await get(`${R}/branches/constructor`)).json.name, "constructor");
  const ctorFile = (await put(`${R}/contents/constructor`, { message: "Add a file named constructor", content: b64("ctor\n"), branch: "constructor" })).json;
  assert.equal(ctorFile.content.path, "constructor");
  await apiError("PUT", `${R}/contents/constructor`, 422, '"sha" wasn\'t supplied', { body: { message: "again", content: b64("x"), branch: "constructor" } });
  await put(`${R}/contents/src/toString`, { message: "Add src/toString", content: b64("ts\n"), branch: "constructor" });
  assert.equal(unb64((await get(`${R}/contents/constructor?ref=constructor`)).json.content), "ctor\n");
  assert.equal(unb64((await get(`${R}/contents/src/toString?ref=constructor`)).json.content), "ts\n");
  assert.ok(names((await get(`${R}/contents?ref=constructor`)).json).includes("constructor"));
  await apiError("GET", `${R}/contents/constructor`, 404, "Not Found");
  // A file or directory named `__proto__` is an ordinary tree entry (GitHub accepts the name): create, read back
  // as a file and as a directory listing, and it never leaks onto Object.prototype or into other branches.
  const protoFile = (await put(`${R}/contents/__proto__`, { message: "Add a file named __proto__", content: b64("proto\n"), branch: "constructor" })).json;
  assert.equal(protoFile.content.path, "__proto__");
  assert.equal(protoFile.content.type, "file");
  await put(`${R}/contents/src/__proto__/x.ts`, { message: "Add src/__proto__/x.ts", content: b64("px\n"), branch: "constructor" });
  assert.equal(unb64((await get(`${R}/contents/__proto__?ref=constructor`)).json.content), "proto\n");
  assert.equal(unb64((await get(`${R}/contents/src/__proto__/x.ts?ref=constructor`)).json.content), "px\n");
  assert.deepEqual(names((await get(`${R}/contents/src/__proto__?ref=constructor`)).json), ["x.ts"]);
  assert.ok(names((await get(`${R}/contents?ref=constructor`)).json).includes("__proto__"));
  assert.equal((await get(`${R}/contents/src?ref=constructor`)).json.find((entry) => entry.name === "__proto__")?.type, "dir");
  await apiError("PUT", `${R}/contents/__proto__`, 422, '"sha" wasn\'t supplied', { body: { message: "again", content: b64("x"), branch: "constructor" } });
  await apiError("GET", `${R}/contents/__proto__`, 404, "Not Found");
  assert.equal(Object.prototype.hasOwnProperty.call({}, "__proto__"), false);
  assert.equal(((await get(`${R}/commits?sha=constructor&path=__proto__`)).json).length, 1, "commit history filtered by a __proto__ path");
  const protoCanonical = await op("repos.get-content", { owner: OWNER, repo: REPO, path: "src/__proto__/x.ts", ref: "constructor" });
  assert.equal(protoCanonical.path, "src/__proto__/x.ts");
  const oddLabels = (await post(`${R}/issues`, { title: "Labels with inherited names", labels: ["__proto__", "constructor"] }, { status: 201 })).json;
  assert.deepEqual(oddLabels.labels.map((label) => label.name), ["__proto__", "constructor"]);
  assert.deepEqual(numbers((await get(`${R}/issues?labels=constructor`)).json), [oddLabels.number]);

  // Mangled percent-encoding: the framework decodes %E0%A4%A to U+FFFD; filters and q must answer 422, not [].
  const mangledQueries = [
    "/search/issues?q=bug%E0%A4%A",
    "/search/issues?q=label:bu%E0%A4%A",
    "/search/issues?q=bug%EF%BF%BD",
    `${R}/issues?labels=bug%E0%A4%A`,
    `${R}/issues?assignee=dana%E0%A4%A`,
    `${R}/issues?creator=x%EF%BF%BD`,
    `${R}/commits?path=src%E0%A4%A`,
    `${R}/commits?author=dana%E0%A4%A`,
    `${R}/pulls?base=main%E0%A4%A`,
    `${R}/pulls?head=acme-robotics:fix%E0%A4%A`,
  ];
  for (const path of mangledQueries) {
    const rejected = await apiError("GET", path, 422, "U+FFFD");
    assert.equal(rejected.json.message, "Validation Failed");
    assert.equal(rejected.json.errors[0].code, "invalid");
  }
  assert.equal((await apiError("GET", "/search/issues?q=bug%E0%A4%A", 422, "U+FFFD")).json.errors[0].field, "q");
  assert.equal((await apiError("GET", `${R}/issues?labels=bug%E0%A4%A`, 422, "U+FFFD")).json.errors[0].field, "labels");
  await op("issues.search", { query: "is:open \uFFFD" }, "VALIDATION_FAILED");
  await op("issues.list", { owner: OWNER, repo: REPO, labels: ["bug", "x\uFFFD"] }, "VALIDATION_FAILED");
  // %ZZ is not malformed UTF-8: it stays literal text and matches nothing.
  assert.equal((await get("/search/issues?q=bug%ZZ")).json.total_count, 0);
  assert.deepEqual((await get(`${R}/issues?labels=bug%ZZ`)).json, []);
  // Legitimate non-ASCII searches and filters still work.
  const unicode = (await post(`${R}/issues`, { title: "Café 漢字 🔥 telemetry", labels: ["étiquette-漢字"] }, { status: 201 })).json;
  for (const term of ["café", "漢字", "🔥"]) {
    assert.deepEqual(numbers((await get(`/search/issues?q=${encodeURIComponent(`${term} in:title`)}`)).json.items), [unicode.number], term);
  }
  assert.deepEqual(numbers((await get(`${R}/issues?labels=${encodeURIComponent("étiquette-漢字")}`)).json), [unicode.number]);
  return { squash: SQUASH, rebase: rebase.sha };
}

// ---------------------------------------------------------------------------------------------
// Drill: mcp-aliases (maintainer, baseline)
// ---------------------------------------------------------------------------------------------

async function mcpAliases() {
  await mcpInit();
  const tools = (await rpc("tools/list", {})).tools.map((tool) => tool.name);
  for (const alias of ALIASES) assert.ok(tools.includes(alias), `alias ${alias} missing`);
  for (const operationId of ALL_OPERATIONS) assert.ok(tools.includes(`github.${operationId}`), `canonical github.${operationId} missing`);
  const base = { owner: OWNER, repo: REPO };

  assert.equal((await mcp("get_me", {})).login, "dana-reyes");
  const branches = await mcp("list_branches", { ...base, perPage: 2, page: 2 });
  assert.deepEqual(names(branches.branches), ["feat/otel-exporter", "fix/metrics-buffer"]);
  assert.equal(branches.total_count, 5);
  const ref = await mcp("create_branch", { ...base, branch: "feat/mcp-branch", from_branch: "main" });
  assert.equal(ref.ref, "refs/heads/feat/mcp-branch");
  const MAIN = ref.object.sha;
  assert.equal((await mcp("list_commits", { ...base, sha: "main", perPage: 2 })).commits.length, 2);
  const commit = await mcp("get_commit", { ...base, sha: "main", detail: "stats" });
  assert.equal(commit.sha, MAIN);
  assert.ok(commit.stats.total > 0);
  assert.ok(commit.files.every((file) => file.patch === undefined));
  const dir = await mcp("get_file_contents", { ...base, path: "src/", ref: "main" });
  assert.deepEqual(names(dir.entries), ["config.ts", "exporter.ts", "index.ts", "metrics"]);
  const readme = await mcp("get_file_contents", { ...base, path: "README.md" });
  assert.equal(readme.encoding, "utf-8");
  assert.ok(readme.content.startsWith("# telemetry-service"));
  const file = await mcp("create_or_update_file", { ...base, path: "docs/mcp.md", content: "plain text, no base64", message: "docs: mcp note", branch: "feat/mcp-branch" });
  assert.equal(file.content.content, "plain text, no base64");
  assert.equal(file.commit.parents[0].sha, MAIN);

  const first = await mcp("list_issues", { ...base, state: "OPEN", orderBy: "UPDATED_AT", direction: "DESC", perPage: 3 });
  assert.equal(first.issues.length, 3);
  assert.equal(first.issues[0].number, 43);
  assert.equal(first.page_info.has_next_page, true);
  assert.ok(first.page_info.end_cursor);
  const second = await mcp("list_issues", { ...base, state: "OPEN", orderBy: "UPDATED_AT", direction: "DESC", perPage: 3, after: first.page_info.end_cursor });
  assert.equal(second.issues.length, 3);
  assert.notEqual(second.issues[0].number, first.issues[0].number);
  assert.equal(second.total_count, 9);
  await mcpError("list_issues", { ...base, after: "garbage" }, "tool.VALIDATION_FAILED");
  await mcpError("list_issues", { ...base, after: first.page_info.end_cursor, page: 2 }, "tool.VALIDATION_FAILED");
  await mcpError("list_issues", { repo: REPO });

  assert.equal((await mcp("issue_read", { ...base, issue_number: 31, method: "get" })).number, 31);
  assert.equal((await mcp("issue_read", { ...base, issue_number: 31, method: "get_comments" })).comments.length, 3);
  assert.equal((await mcp("issue_read", { ...base, issue_number: 31, method: "get_labels" })).labels.length, 2);
  await mcpError("issue_read", { ...base, issue_number: 31, method: "get_sub_issues" }, "tool.VALIDATION_FAILED");
  const issue = await mcp("issue_write", { ...base, method: "create", title: "MCP-created issue", body: "Opened through the MCP alias.", labels: ["bug"] });
  assert.equal(issue.number, 48);
  assert.deepEqual(names(issue.labels), ["bug"]);
  const closed = await mcp("issue_write", { ...base, method: "update", issue_number: 48, state: "closed", state_reason: "duplicate" });
  assert.equal(closed.state, "closed");
  assert.equal(closed.state_reason, "duplicate");
  await mcpError("issue_write", { ...base, method: "bogus", title: "x" }, "tool.VALIDATION_FAILED");
  const comment = await mcp("add_issue_comment", { ...base, issue_number: 48, body: "Commented through the MCP alias." });
  assert.equal(comment.user.login, "dana-reyes");
  await mcpError("add_issue_comment", { ...base, issue_number: 48, body: "x", reaction: "+1" }, "tool.VALIDATION_FAILED");
  const search = await mcp("search_issues", { query: "is:issue is:open label:bug", ...base });
  assert.deepEqual(numbers(search.items), [31], "owner/repo prepend the repo qualifier");
  await mcpError("search_issues", { query: "is:open", sort: "reactions" }, "tool.VALIDATION_FAILED");
  assert.equal((await mcp("list_pull_requests", { ...base, state: "open", sort: "updated" })).pull_requests.length, 4);
  assert.equal((await mcp("pull_request_read", { ...base, pullNumber: 45, method: "get" })).mergeable_state, "clean");
  assert.equal((await mcp("pull_request_read", { ...base, pullNumber: 45, method: "get_files" })).files.length, 2);
  assert.equal((await mcp("pull_request_read", { ...base, pullNumber: 45, method: "get_commits" })).commits.length, 1);
  assert.equal((await mcp("pull_request_read", { ...base, pullNumber: 45, method: "get_reviews" })).reviews.length, 1);
  assert.equal((await mcp("pull_request_read", { ...base, pullNumber: 45, method: "get_comments" })).comments.length, 2);
  await mcpError("pull_request_read", { ...base, pullNumber: 45, method: "get_diff" }, "tool.VALIDATION_FAILED");
  await mcpError("create_pull_request", { ...base, title: "MCP branch", head: "feat/mcp-branch", base: "main", reviewers: ["dana-reyes"] }, "tool.VALIDATION_FAILED");
  const pull = await mcp("create_pull_request", { ...base, title: "MCP branch", head: "feat/mcp-branch", base: "main", body: "Opened through the MCP alias.", reviewers: ["sam-okoro"] });
  assert.equal(pull.number, 49);
  assert.deepEqual(pull.requested_reviewers.map((user) => user.login), ["sam-okoro"]);
  assert.equal(pull.mergeable_state, "blocked");
  const renamed = await mcp("update_pull_request", { ...base, pullNumber: 49, reviewers: [], title: "MCP branch (renamed)" });
  assert.equal(renamed.title, "MCP branch (renamed)");
  assert.equal(renamed.requested_reviewers.length, 0);
  const review = await mcp("pull_request_review_write", { ...base, pullNumber: 46, method: "create", event: "APPROVE" });
  assert.equal(review.state, "APPROVED");
  await mcpError("pull_request_review_write", { ...base, pullNumber: 46, method: "submit_pending", event: "APPROVE" }, "tool.VALIDATION_FAILED");
  await mcpError("merge_pull_request", { ...base, pullNumber: 46, merge_method: "merge", expectedHeadSha: ZERO }, "tool.CONFLICT");
  const merged = await mcp("merge_pull_request", { ...base, pullNumber: 46, merge_method: "merge" });
  assert.equal(merged.merged, true);
  const mergeCommit = (await get(`${R}/commits/${merged.sha}`)).json;
  assert.equal(mergeCommit.parents.length, 2, "a merge commit has two parents");
  assert.ok(mergeCommit.commit.message.startsWith("Merge pull request #46 from acme-robotics/feat/otel-exporter"));
  assert.equal((await get(`${R}/issues/48`)).json.state, "closed", "the MCP write is visible over HTTP");
  assert.equal((await get(`${R}/pulls/46`)).json.merged, true);
}

// ---------------------------------------------------------------------------------------------
// Drills: permissions (contributor = Priya, write; reader = Lee, triage)
// ---------------------------------------------------------------------------------------------

async function permissionsWrite() {
  assert.deepEqual((await get("/user/repos")).json.map((repo) => repo.full_name), ["acme-robotics/telemetry-service"]);
  await apiError("GET", FC, 404, "Not Found");
  await apiError("GET", `${FC}/issues/10`, 404, "Not Found");
  assert.equal((await get(`/search/issues?q=is:merged`)).json.total_count, 0, "the private repository's merged pull is invisible");
  const own = (await post(`${R}/issues`, { title: "Exporter retries are not logged" }, { status: 201 })).json;
  assert.equal(own.number, 48);
  assert.equal(own.author_association, "MEMBER");
  assert.equal((await patch(`${R}/issues/48`, { title: "Exporter retries are not logged (renamed)" })).json.title, "Exporter retries are not logged (renamed)");
  assert.equal((await patch(`${R}/issues/31`, { title: "Metrics buffer grows without bound" })).json.title, "Metrics buffer grows without bound", "write includes triage");
  assert.equal((await patch(`${R}/issues/36`, { state: "closed" })).json.state, "closed");
  const merged = (await put(`${R}/pulls/45/merge`, {})).json;
  assert.equal(merged.merged, true);
  assert.equal((await get(`${R}/pulls/45`)).json.merged_by.login, "priya-nair");
  await apiError("POST", `${R}/pulls/46/reviews`, 422, "Can not approve your own pull request", { body: { event: "APPROVE" } });
  assert.equal((await post(`${R}/git/refs`, { ref: "refs/heads/priya/experiment", sha: merged.sha }, { status: 201 })).json.object.sha, merged.sha);
  assert.equal((await post(`${R}/issues/35/comments`, { body: "Write access may comment on locked issues." }, { status: 201 })).json.author_association, "MEMBER");
}

async function permissionsTriage() {
  await apiError("GET", FC, 404, "Not Found");
  assert.equal((await post(`${R}/issues`, { title: "Support: exporter banner is confusing" }, { status: 201 })).json.number, 48);
  assert.deepEqual(names((await post(`${R}/issues/31/labels`, { labels: ["wontfix"] })).json), ["bug", "priority: high", "wontfix"]);
  assert.deepEqual((await post(`${R}/issues/31/assignees`, { assignees: ["lee-chen"] }, { status: 201 })).json.assignees.map((user) => user.login), ["priya-nair", "lee-chen"]);
  assert.equal((await patch(`${R}/issues/31`, { state: "closed" })).json.state_reason, "completed");
  assert.equal((await post(`${R}/issues/35/comments`, { body: "Triage may comment on locked issues." }, { status: 201 })).json.author_association, "MEMBER");
  const push = "Must have push access to the repository.";
  await apiError("POST", `${R}/git/refs`, 403, push, { body: { ref: "refs/heads/lee/x", sha: ZERO } });
  await apiError("PUT", `${R}/contents/x.md`, 403, push, { body: { message: "x", content: b64("x") } });
  await apiError("POST", `${R}/pulls`, 403, push, { body: { title: "x", head: "docs/runbook", base: "main" } });
  await apiError("PUT", `${R}/pulls/44/merge`, 403, push, { body: {} });
  await apiError("PATCH", `${R}/pulls/44`, 403, push, { body: { reviewers: ["sam-okoro"] } });
  assert.equal((await post(`${R}/pulls/46/reviews`, { event: "APPROVE" })).json.state, "APPROVED");
  assert.equal((await get(`${R}/pulls/46`)).json.mergeable_state, "blocked", "a triage approval does not satisfy branch protection");
  assert.equal((await post(`${R}/pulls/47/reviews`, { event: "COMMENT", body: "Please mention the fastify major bump in the changelog." })).json.state, "COMMENTED");
}

// ---------------------------------------------------------------------------------------------
// Drill: denied (auditor, no grants)
// ---------------------------------------------------------------------------------------------

async function denied() {
  const message = "Resource not accessible by personal access token";
  await apiError("GET", "/user", 403, message);
  await apiError("GET", `${R}/issues`, 403, message);
  await apiError("POST", `${R}/issues`, 403, message, { body: { title: "x" } });
  await mcpInit();
  const result = await rpc("tools/call", { name: "get_me", arguments: {} });
  assert.ok(result.isError);
  assert.equal(result.structuredContent.status, "denied");
}

// ---------------------------------------------------------------------------------------------
// Drill: invalid-auth (ghost: login without a users row)
// ---------------------------------------------------------------------------------------------

async function invalidAuth() {
  await apiError("GET", "/user", 401, "Bad credentials");
  await apiError("GET", `${R}/issues`, 401, "Bad credentials");
  await apiError("POST", `${R}/issues`, 401, "Bad credentials", { body: { title: "x" } });
  await mcpInit();
  await mcpError("list_issues", { owner: OWNER, repo: REPO }, "tool.UNAUTHORIZED");
  const base = { owner: OWNER, repo: REPO };
  const minimal = {
    "users.get-authenticated": {},
    "repos.list-for-authenticated-user": {},
    "repos.get": base,
    "repos.list-branches": base,
    "repos.get-branch": { ...base, branch: "main" },
    "repos.create-branch": { ...base, branch: "x" },
    "repos.list-commits": base,
    "repos.get-commit": { ...base, sha: "main" },
    "repos.get-content": base,
    "repos.create-or-update-file": { ...base, path: "x.md", message: "x", content: "x" },
    "issues.list-labels-for-repo": base,
    "issues.list": base,
    "issues.read": { ...base, issue_number: 31, method: "get" },
    "issues.write": { ...base, method: "create", title: "x" },
    "issues.add-comment": { ...base, issue_number: 31, body: "x" },
    "issues.add-labels": { ...base, issue_number: 31, labels: ["bug"] },
    "issues.remove-label": { ...base, issue_number: 31, name: "bug" },
    "issues.add-assignees": { ...base, issue_number: 31, assignees: ["dana-reyes"] },
    "issues.search": { query: "is:open" },
    "pulls.list": base,
    "pulls.read": { ...base, pullNumber: 45, method: "get" },
    "pulls.create": { ...base, title: "x", head: "docs/runbook", base: "main" },
    "pulls.update": { ...base, pullNumber: 44, title: "x" },
    "pulls.create-review": { ...base, pullNumber: 45, event: "APPROVE" },
    "pulls.check-merged": { ...base, pullNumber: 45 },
    "pulls.merge": { ...base, pullNumber: 45 },
  };
  for (const operationId of ALL_OPERATIONS) {
    assert.ok(operationId in minimal, `no minimal arguments for ${operationId}`);
    await op(operationId, minimal[operationId], "UNAUTHORIZED");
  }
}

// ---------------------------------------------------------------------------------------------
// Drill: default-identity (newcomer: no attributes, like the actor `firedrill tool add` creates)
// ---------------------------------------------------------------------------------------------

async function defaultIdentity() {
  const me = (await get("/user")).json;
  assert.equal(me.login, "dana-reyes", "an actor without a login attribute acts as the primary seeded user");
  assert.equal("server_time" in me, false, "GET /user stays GitHub-shaped");
  const canonical = await op("users.get-authenticated", {});
  assert.equal(canonical.login, "dana-reyes");
  assert.match(canonical.server_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(canonical.server_time >= "2026-09-14T09:00:00Z", `server_time follows world virtual time: ${canonical.server_time}`);
  const repos = (await get("/user/repos")).json;
  assert.deepEqual(repos.map((repo) => repo.full_name).sort(), ["acme-robotics/fleet-console", "acme-robotics/telemetry-service", "dana-reyes/dotfiles"]);
  assert.equal((await op("repos.list-for-authenticated-user", {})).repositories.length, 3);
  assert.equal((await get(FC)).json.permissions.admin, true, "the private repository is visible to the default identity");
  assert.equal((await get(`${R}/issues`)).json.length, 9);
  const search = (await get(`/search/issues?q=${encodeURIComponent(`repo:${OWNER}/${REPO} is:issue is:open`)}`)).json;
  assert.equal(search.total_count, 9);
  const everything = await op("issues.search", {});
  assert.equal(everything.total_count, 21, "a search without query or q lists every visible issue and pull request");
  const bothForms = await op("issues.search", { query: "is:open", q: "is:open" }, "VALIDATION_FAILED");
  assert.equal(bothForms.message, "Validation Failed");
  assert.equal((await get(`${R}/pulls`)).json.length, 4);
  const created = (await post(`${R}/issues`, { title: "Filed from a fresh install" }, { status: 201 })).json;
  assert.equal(created.number, 48);
  assert.equal(created.user.login, "dana-reyes");
  await mcpInit();
  assert.equal((await mcp("get_me", {})).login, "dana-reyes");
}

// ---------------------------------------------------------------------------------------------
// Drill: rate-limited (maintainer, scenario rate-limited)
// ---------------------------------------------------------------------------------------------

async function rateLimited() {
  const limited = async (method, path, body) => {
    const result = await apiError(method, path, 403, "API rate limit exceeded", body === undefined ? {} : { body });
    assert.equal(result.headers.get("retry-after"), "60");
    assert.equal(result.headers.get("x-ratelimit-remaining"), "0");
    assert.equal(result.json.documentation_url, "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api");
  };
  await limited("POST", `${R}/issues`, { title: "x" });
  await limited("PATCH", `${R}/issues/31`, { title: "x" });
  await limited("POST", `${R}/issues/31/comments`, { body: "x" });
  await limited("POST", `${R}/issues/31/labels`, { labels: ["wontfix"] });
  await limited("DELETE", `${R}/issues/31/labels/bug`);
  await limited("POST", `${R}/issues/31/assignees`, { assignees: ["sam-okoro"] });
  await limited("POST", `${R}/git/refs`, { ref: "refs/heads/x", sha: ZERO });
  await limited("PUT", `${R}/contents/README.md`, { message: "x", content: b64("x") });
  await limited("POST", `${R}/pulls`, { title: "x", head: "docs/runbook", base: "main" });
  await limited("PATCH", `${R}/pulls/44`, { title: "x" });
  await limited("POST", `${R}/pulls/46/reviews`, { event: "APPROVE" });
  await limited("PUT", `${R}/pulls/45/merge`, {});
  await mcpInit();
  const error = (await mcpError("add_issue_comment", { owner: OWNER, repo: REPO, issue_number: 31, body: "x" }, "tool.RATE_LIMITED")).error;
  assert.ok(error.message.startsWith("API rate limit exceeded"));
  const reads = await get(`${R}/issues`);
  assert.equal(reads.json.length, 9, "reads keep working");
  assert.equal(reads.headers.get("x-ratelimit-remaining"), "4999");
  assert.equal((await get(`${R}/issues/31`)).json.comments, 3, "nothing was written");
  assert.equal((await get(`${R}/pulls/45`)).json.merged, false);
}

// ---------------------------------------------------------------------------------------------
// Drill: merge-unavailable (maintainer, scenario merge-unavailable)
// ---------------------------------------------------------------------------------------------

async function mergeUnavailable() {
  await apiError("PUT", `${R}/pulls/45/merge`, 503, "Service Unavailable", { body: { merge_method: "merge" } });
  const readme = (await get(`${R}/contents/README.md`)).json;
  await apiError("PUT", `${R}/contents/README.md`, 503, "Service Unavailable", { body: { message: "x", content: b64("# changed\n"), sha: readme.sha } });
  assert.equal((await post(`${R}/issues/31/comments`, { body: "Comments still work while merging is unavailable." }, { status: 201 })).json.issue_url.endsWith("/issues/31"), true);
  assert.equal((await get(`${R}/pulls/45`)).json.merged, false);
  assert.equal((await get(`${R}/branches/main`)).json.commit.sha, (await get(`${R}/commits`)).json[0].sha);
}

// ---------------------------------------------------------------------------------------------
// Drill: response-budget (maintainer, baseline). Pages are cut by count and UTF-8 bytes under the 1 MiB cap.
// ---------------------------------------------------------------------------------------------

const MIB = 1_048_576;
/** Follow `link` rel="next" from `path`; every page must be 200 and under 1 MiB; returns the items in order. */
async function walkBytes(path, pick = (json) => json) {
  const items = [];
  const sizes = [];
  let next = path;
  while (next !== undefined) {
    const response = await fetch(`${HTTP}${next}`, { headers: { authorization: `token ${HTTP_TOKEN}` } });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, `${next} -> ${response.status} ${bytes.toString("utf8").slice(0, 300)}`);
    assert.ok(bytes.length < MIB, `${next} answered ${bytes.length} bytes`);
    sizes.push(bytes.length);
    items.push(...pick(JSON.parse(bytes.toString("utf8"))));
    next = rel(response.headers, "next");
    assert.ok(sizes.length <= 20, "link walk terminates");
  }
  return { items, sizes };
}
const once = (values, label) => assert.equal(new Set(values).size, values.length, `${label}: every item exactly once`);

async function responseBudget() {
  const big = "漢".repeat(65_000); // 195 KB of UTF-8, well within GitHub's 65,536-character body limit
  for (let index = 0; index < 8; index += 1) await post(`${R}/issues/31/comments`, { body: big }, { status: 201 });
  const comments = await walkBytes(`${R}/issues/31/comments?per_page=100`);
  assert.ok(comments.sizes.length >= 2, "large comments spill onto a second page");
  once(comments.items.map((comment) => comment.id), "comments");
  assert.equal(comments.items.length, 11);
  assert.equal((await get(`${R}/issues/31`)).json.comments, 11);
  const canonical = await op("issues.read", { owner: OWNER, repo: REPO, issue_number: 31, method: "get_comments", perPage: 100 });
  assert.equal(canonical.total_count, 11);
  assert.equal(canonical.total_pages, comments.sizes.length);
  assert.equal(canonical.comments.length, comments.items.length - (await get(`${R}/issues/31/comments?per_page=100&page=2`)).json.length);

  for (let index = 0; index < 7; index += 1) await post(`${R}/issues`, { title: `Large report ${index}`, body: big }, { status: 201 });
  const issues = await walkBytes(`${R}/issues?state=all&per_page=100`);
  assert.ok(issues.sizes.length >= 2, "large issues spill onto a second page");
  once(issues.items.map((issue) => issue.number), "issues");
  // GET …/issues lists issues only (pull requests excluded), so compare with the operation's own count.
  assert.equal(issues.items.length, (await op("issues.list", { owner: OWNER, repo: REPO, state: "all", perPage: 1 })).total_count);
  const search = await walkBytes(`/search/issues?q=${encodeURIComponent(`repo:${OWNER}/${REPO}`)}&per_page=100`, (json) => json.items);
  assert.ok(search.sizes.length >= 2);
  once(search.items.map((item) => item.id), "search");
  assert.equal(search.items.length, (await get(`/search/issues?q=${encodeURIComponent(`repo:${OWNER}/${REPO}`)}&per_page=1`)).json.total_count);
  const small = await get(`${R}/issues?state=all&per_page=5&page=2`);
  assert.equal(small.json.length, 5, "small pages still hold per_page items");

  // A 65,536-character file of control characters escapes to 6 JSON bytes per character.
  const first = (await put(`${R}/contents/big/huge.txt`, { message: "big", content: b64(String.fromCharCode(1).repeat(65_536)), branch: "main" })).json;
  const second = (await put(`${R}/contents/big/huge.txt`, { message: "big 2", content: b64(String.fromCharCode(2).repeat(65_536)), branch: "main", sha: first.content.sha })).json;
  assert.equal(unb64((await get(`${R}/contents/big/huge.txt`)).json.content).length, 65_536);
  const commit = await walkBytes(`${R}/commits/${second.commit.sha}`, (json) => json.files);
  assert.equal(commit.items.length, 1);
  assert.ok(commit.items[0].patch.startsWith("@@"), "a patch that fits is returned");

  const wide = String.fromCharCode(3).repeat(1_000);
  for (let index = 0; index < 24; index += 1) {
    await op("repos.create-or-update-file", { owner: OWNER, repo: REPO, path: `wide/${String(index).padStart(2, "0")}${wide}`, message: "wide", content: "x", branch: "main" });
  }
  await apiError("GET", `${R}/contents/wide`, 422, "too large");
  const commits = await walkBytes(`${R}/commits?per_page=100`);
  once(commits.items.map((entry) => entry.sha), "commits");
}

// ---------------------------------------------------------------------------------------------

const flows = {
  "rest-flow": restFlow,
  "mcp-aliases": mcpAliases,
  "permissions-write": permissionsWrite,
  "permissions-triage": permissionsTriage,
  denied,
  "invalid-auth": invalidAuth,
  "default-identity": defaultIdentity,
  "rate-limited": rateLimited,
  "merge-unavailable": mergeUnavailable,
  "response-budget": responseBudget,
};
const selected = Object.keys(flows).find((name) => instruction.includes(name));
if (selected === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
const result = await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected, ...(result ?? {}) }));
