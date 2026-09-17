// Gmail Tool conformance target. A scripted Tool test, not a model-driven agent.
// Uses only Node built-ins: fetch against the Gmail-shaped HTTP routes, the canonical
// /v1/operations endpoint, and raw MCP JSON-RPC (Streamable HTTP) for the Google tool-name aliases.
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

const DANA = "dana.reyes@example.test";
const SAM = "sam.okafor@example.test";
const NO_ROW = "marcus.lindqvist@example.test"; // a starter sender that owns no mailboxes row
const ME = `${HTTP}/gmail/v1/users/me`;

// ---------------------------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------------------------

async function rest(method, path, { body, status = 200, headers = {} } = {}) {
  const response = await fetch(path.startsWith("http") ? path : `${ME}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${HTTP_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const json = text.length > 0 ? JSON.parse(text) : undefined;
  assert.equal(response.status, status, `${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return { json, headers: response.headers, status: response.status };
}

/** Expect a Gmail-shaped error envelope with the given HTTP status and reason. */
async function restError(method, path, status, reason, options = {}, label = "") {
  const where = label === "" ? `${method} ${path}` : `${method} ${path} (${label})`;
  const result = await rest(method, path, { ...options, status });
  assert.ok(result.json?.error, `expected Gmail error envelope for ${where}`);
  assert.equal(result.json.error.code, status, where);
  assert.equal(result.json.error.errors[0].reason, reason, `${where}: ${JSON.stringify(result.json)}`);
  return result;
}

async function op(operationId, args, expected = "ok") {
  const response = await fetch(`${HTTP}/v1/operations/gmail/${operationId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  });
  const json = await response.json();
  assert.ok(json.outcome, `canonical ${operationId}: ${JSON.stringify(json).slice(0, 300)}`);
  if (expected === "ok") {
    assert.equal(json.outcome.status, "ok", `${operationId}: ${JSON.stringify(json.outcome).slice(0, 300)}`);
    return json.outcome.value;
  }
  assert.equal(json.outcome.status, "tool_error", `${operationId}: ${JSON.stringify(json.outcome).slice(0, 300)}`);
  assert.equal(json.outcome.error.code, `tool.${expected}`, JSON.stringify(json.outcome.error));
  return json.outcome.error;
}

let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(MCP, {
    method: "POST",
    headers: {
      authorization: `Bearer ${MCP_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
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

async function mcp(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result).slice(0, 400)}`);
  return result.structuredContent;
}

async function mcpError(name, args, code) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(result.isError, `${name} unexpectedly succeeded`);
  const error = result.structuredContent?.error;
  assert.ok(error, `${name}: ${JSON.stringify(result).slice(0, 400)}`);
  if (code) assert.equal(error.code, code, JSON.stringify(error));
  return result.structuredContent;
}

const ids = (list) => list.map((item) => item.id).sort();
const same = (left, right) => assert.deepEqual([...left].sort(), [...right].sort());
const base64url = (text) => Buffer.from(text, "utf8").toString("base64url");

// ---------------------------------------------------------------------------------------------
// Drill: rest-flow (owner, baseline)
// ---------------------------------------------------------------------------------------------

async function restFlow() {
  // Profile and labels -------------------------------------------------------------------------
  const profile = (await rest("GET", "/profile")).json;
  assert.deepEqual(profile, { emailAddress: DANA, messagesTotal: 20, threadsTotal: 12, historyId: "1200" }, "REST profile carries Gmail's four fields only");
  const canonicalProfile = await op("profile.get", {});
  assert.equal(canonicalProfile.serverTime, "2026-09-14T09:00:00.000Z", "canonical profile exposes the world's virtual now");
  assert.equal(canonicalProfile.emailAddress, DANA);

  const labels = (await rest("GET", "/labels")).json.labels;
  assert.equal(labels.length, 18, "14 system + 4 user labels");
  assert.equal(labels.find((label) => label.id === "Label_4")?.name, "Customers/Escalations");
  assert.equal(labels.find((label) => label.id === "INBOX")?.type, "system");
  assert.ok(!("threadsTotal" in labels[0]), "REST list carries no counts");

  // Reads and search ---------------------------------------------------------------------------
  const list = async (query) => (await rest("GET", `/messages${query}`)).json;
  const defaults = await list("");
  assert.equal(defaults.resultSizeEstimate, 18, "trash and spam excluded by default");
  assert.ok(!ids(defaults.messages).includes("18f0000000000701") && !ids(defaults.messages).includes("18f0000000000801"));
  assert.equal((await list("?includeSpamTrash=true")).resultSizeEstimate, 20);
  same(ids((await list("?q=is:unread")).messages), ["18f0000000000101", "18f0000000000103", "18f0000000000504", "18f0000000000601"]);
  same(ids((await list("?q=in:spam")).messages), ["18f0000000000801"]);
  same(ids((await list("?q=in:trash")).messages), ["18f0000000000701"]);
  same(ids((await list("?q=has:attachment")).messages), ["18f0000000000201", "18f0000000000d01"]);
  same(ids((await list("?q=filename:INV")).messages), ["18f0000000000201"]);
  same(ids((await list("?q=from:priya")).messages), ["18f0000000000101", "18f0000000000103"]);
  same(ids((await list("?q=to:sam.okafor")).messages), ["18f0000000000501", "18f0000000000504"]);
  same(ids((await list("?q=cc:sam.okafor")).messages), ["18f0000000000502"]);
  same(ids((await list("?q=bcc:board")).messages), ["18f0000000000b01"]);
  same(ids((await list(`?q=${encodeURIComponent('subject:"Refund for"')}`)).messages), ["18f0000000000101", "18f0000000000102", "18f0000000000103", "18f0000000000104"]);
  same(ids((await list("?q=label:Label_3")).messages), ["18f0000000000401", "18f0000000000402"]);
  same(ids((await list("?q=label:recruiting")).messages), ["18f0000000000401", "18f0000000000402"]);
  same(ids((await list("?q=label:customers-escalations")).messages), ["18f0000000000103"]);
  same(ids((await list("?q=is:starred")).messages), ["18f0000000000402"]);
  const archive = ids((await list("?q=in:archive")).messages);
  assert.ok(archive.includes("18f0000000000901") && archive.includes("18f0000000000902") && !archive.includes("18f0000000000101"));
  const newer = ids((await list("?q=newer_than:7d")).messages);
  assert.ok(newer.includes("18f0000000000101") && !newer.includes("18f0000000000501"));
  const older = ids((await list("?q=older_than:30d")).messages);
  assert.ok(older.includes("18f0000000000501") && older.includes("18f0000000000901") && !older.includes("18f0000000000101"));
  const after = ids((await list("?q=after:2026/09/12")).messages);
  assert.ok(after.includes("18f0000000000103") && after.includes("18f0000000000201") && !after.includes("18f0000000000102"));
  same(ids((await list("?q=before:2026-08-01")).messages), ["18f0000000000901", "18f0000000000902"]);
  same(ids((await list(`?q=${encodeURIComponent("rfc822msgid:<inv-2026-0912@northwind.example.com>")}`)).messages), ["18f0000000000201"]);
  assert.equal((await list("?q=in:sent")).resultSizeEstimate, 4, "102, 502, 902 and the bcc-only b01");
  same(ids((await list("?q=in:drafts")).messages), ["18f0000000000104", "18f0000000000c01"]);
  same(ids((await list(`?q=${encodeURIComponent("{from:priya from:legal}")}`)).messages), ["18f0000000000101", "18f0000000000103", "18f0000000000d01"]);
  same(ids((await list(`?q=${encodeURIComponent("from:priya OR from:legal -is:unread")}`)).messages), ["18f0000000000d01"]);
  assert.equal((await list("?q=postmortem")).resultSizeEstimate, 4, "bare words search subject, snippet and body");
  same(ids((await list("?labelIds=Label_2")).messages), ["18f0000000000201"]);
  assert.equal((await list("?q=is:unread&labelIds=Label_1")).resultSizeEstimate, 2);
  await restError("GET", "/messages?q=category:promotions", 400, "invalidArgument");
  await restError("GET", "/messages?labelIds=Label_999", 400, "invalidArgument");
  await restError("GET", "/messages?q=%22unbalanced", 400, "invalidArgument");
  // Invalid calendar dates are refused, never rolled into a later real date; valid dates still match.
  for (const route of ["/messages", "/threads", "/drafts"]) {
    for (const bad of ["after:2024/13/45", "before:2024/02/30", "after:2024/00/10", "older:2023/02/29", "newer:2024/1/0", "after:2024-01/05", "newer_than:99999999999999999999d"]) {
      const refused = await restError("GET", `${route}?q=${encodeURIComponent(bad)}`, 400, "invalidArgument");
      assert.match(refused.json.error.message, /date|duration/i, `${route} ${bad}: ${refused.json.error.message}`);
    }
  }
  assert.equal((await list("?q=after:2024/1/5")).resultSizeEstimate, 18, "a valid single-digit date still matches");
  assert.equal((await list("?q=before:2024/02/29")).resultSizeEstimate, 0, "leap day is a real date");
  assert.equal((await list("?q=older_than:0d")).resultSizeEstimate, 18, "older_than:0d = everything before the virtual now");
  assert.equal((await list("?q=after:0024/01/01")).resultSizeEstimate, 18, "year 0024 is not read as 1924");
  same(ids((await list("?q=after:2026/09/13 before:2026/09/14")).messages), ids((await list("?q=after:1789257600 before:1789344000")).messages));
  // U+FFFD in a query is a mangled request (malformed percent-encoding): refused, never searched.
  for (const route of ["/messages", "/threads", "/drafts"]) {
    for (const mangled of ["from%3A%E0%A4%A", "%E0%A4", "%EF%BF%BD", "subject:%C0%AF"]) {
      const refused = await restError("GET", `${route}?q=${mangled}`, 400, "invalidArgument");
      assert.match(refused.json.error.message, /U\+FFFD/, `${route} ${mangled}`);
    }
  }
  await restError("GET", "/messages?labelIds=%E0%A4%A", 400, "badRequest");
  await restError("GET", "/messages?pageToken=%E0%A4%A", 400, "invalidArgument");
  await restError("GET", "/messages/18f0000000000301?format=metadata&metadataHeaders=Sub%E0%A4ject", 400, "invalidArgument");

  const page1 = await list("?maxResults=5");
  assert.equal(page1.messages.length, 5);
  assert.ok(page1.nextPageToken);
  const page2 = await list(`?maxResults=5&pageToken=${encodeURIComponent(page1.nextPageToken)}`);
  assert.equal(page2.messages.length, 5);
  assert.equal(new Set([...ids(page1.messages), ...ids(page2.messages)]).size, 10, "pages do not overlap");
  await restError("GET", `/messages?q=is:unread&maxResults=5&pageToken=${encodeURIComponent(page1.nextPageToken)}`, 400, "invalidArgument");
  await restError("GET", "/messages?pageToken=not-a-token", 400, "invalidArgument");

  // Forged page tokens. A page token is caller input: it comes back from the caller and can be rewritten. Every
  // forgery below keeps the real scope hash wherever it can, so only the forged part is under test, and every one of
  // them must answer Gmail's invalid-cursor error over both the provider-shaped route and the canonical operation.
  const asToken = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const payloadOf = (token) => JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  const realScope = payloadOf(page1.nextPageToken).s;
  let nested = "x";
  for (let depth = 0; depth < 700; depth += 1) nested = [nested];
  const forged = {
    // The original defect: a deeply nested array element made Array.prototype.toString recurse inside String().
    "nested array element": asToken({ s: realScope, a: ["1789257600000", nested] }),
    "nested array payload": asToken(nested),
    "wrong scope": asToken({ s: `${realScope}0`, a: payloadOf(page1.nextPageToken).a }),
    "non-string anchor": asToken({ s: realScope, a: [1789257600000, 18] }),
    "object anchor": asToken({ s: realScope, a: ["1789257600000", { id: "18f0000000000301" }] }),
    "oversized anchor id": asToken({ s: realScope, a: ["1789257600000", "a".repeat(200)] }),
    "extra keys": asToken({ s: realScope, a: payloadOf(page1.nextPageToken).a, o: 0 }),
    "prototype key": asToken({ s: realScope, ["__proto__"]: { polluted: true } }),
    "offset token in an anchor route": asToken({ s: realScope, o: 0 }),
    "bad base64 alphabet": "!!!not-base64!!!",
    "standard-alphabet base64": Buffer.from(JSON.stringify({ s: realScope, o: 0 }), "utf8").toString("base64"),
    "truncated base64 quantum": `${page1.nextPageToken.slice(0, 8)}A`,
    "not json": Buffer.from("this is not json", "utf8").toString("base64url"),
    "invalid utf-8": Buffer.from([0xc3, 0x28, 0x7b, 0x7d]).toString("base64url"),
    empty: "%20",
  };
  for (const [name, token] of Object.entries(forged)) {
    assert.ok(token.length <= 2048, `${name} stays inside the declared pageToken bound`);
    await restError("GET", `/messages?pageToken=${encodeURIComponent(token)}`, 400, "invalidArgument", {}, name);
    await restError("GET", `/threads?pageToken=${encodeURIComponent(token)}`, 400, "invalidArgument", {}, name);
    await restError("GET", `/drafts?pageToken=${encodeURIComponent(token)}`, 400, "invalidArgument", {}, name);
    await op("messages.list", { pageToken: token }, "INVALID_PAGE_TOKEN");
    await op("labels.list", { pageToken: token }, "INVALID_PAGE_TOKEN");
    await op("drafts.list", { pageToken: token }, "INVALID_PAGE_TOKEN");
  }
  // Forging only the offset of a real labels cursor is refused the same way; the genuine one still pages.
  const labelPage = await op("labels.list", { pageSize: 2 });
  assert.ok(labelPage.nextPageToken, "labels.list pages");
  const labelPayload = payloadOf(labelPage.nextPageToken);
  assert.ok(await op("labels.list", { pageSize: 2, pageToken: labelPage.nextPageToken }));
  for (const offset of [-1, 1.5, 1e21, "2", null]) {
    await op("labels.list", { pageSize: 2, pageToken: asToken({ s: labelPayload.s, o: offset }) }, "INVALID_PAGE_TOKEN");
  }

  let seen = [];
  let token;
  do {
    const page = await list(`?maxResults=7${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
    seen = [...seen, ...ids(page.messages)];
    token = page.nextPageToken;
  } while (token);
  assert.equal(new Set(seen).size, 18, "walking every page yields each visible message once");

  const full = (await rest("GET", "/messages/18f0000000000201?format=full")).json;
  assert.equal(full.payload.mimeType, "multipart/mixed");
  assert.equal(full.payload.parts[1].body.attachmentId, "att_18f000000000a001");
  assert.equal(Buffer.from(full.payload.parts[0].body.data, "base64url").toString("utf8").startsWith("Your invoice"), true);
  const metadata = (await rest("GET", "/messages/18f0000000000301?format=metadata&metadataHeaders=Subject&metadataHeaders=From")).json;
  assert.deepEqual(metadata.payload.headers.map((header) => header.name), ["From", "Subject"]);
  assert.ok(!("parts" in metadata.payload) && !("data" in metadata.payload.body));
  const minimal = (await rest("GET", "/messages/18f0000000000101")).json;
  assert.ok("payload" in minimal, "default format is full");
  assert.ok(!("payload" in (await rest("GET", "/messages/18f0000000000101?format=minimal")).json));
  await restError("GET", "/messages/18f0000000000101?format=raw", 400, "invalidArgument");
  await restError("GET", "/messages/18f00000000000ff", 404, "notFound");

  const inboxThreads = (await rest("GET", "/threads?q=in:inbox&maxResults=5")).json;
  assert.equal(inboxThreads.resultSizeEstimate, 7);
  assert.deepEqual(inboxThreads.threads.map((thread) => thread.id), ["18f0000000000601", "18f0000000000101", "18f0000000000501", "18f0000000000201", "18f0000000000301"]);
  assert.ok(!("messages" in inboxThreads.threads[0]), "REST thread list carries id/snippet/historyId only");
  const inboxPage2 = (await rest("GET", `/threads?q=in:inbox&maxResults=5&pageToken=${encodeURIComponent(inboxThreads.nextPageToken)}`)).json;
  assert.deepEqual(inboxPage2.threads.map((thread) => thread.id), ["18f0000000000401", "18f0000000000d01"]);
  assert.equal(inboxPage2.nextPageToken, undefined);
  assert.equal((await rest("GET", "/threads")).json.resultSizeEstimate, 10, "all threads except trash-only and spam-only");
  assert.equal((await rest("GET", "/threads?includeSpamTrash=true")).json.resultSizeEstimate, 12);
  await restError("GET", "/threads?q=size:1m", 400, "invalidArgument");
  await restError("GET", "/threads?pageToken=zzz", 400, "invalidArgument");

  const threadFull = (await rest("GET", "/threads/18f0000000000101")).json;
  assert.deepEqual(threadFull.messages.map((message) => message.id), ["18f0000000000101", "18f0000000000102", "18f0000000000103", "18f0000000000104"]);
  assert.ok(threadFull.messages[0].payload.body.data, "full thread messages carry bodies");
  const threadMeta = (await rest("GET", "/threads/18f0000000000101?format=metadata")).json;
  assert.ok(threadMeta.messages[0].payload.headers.length > 0 && !("data" in threadMeta.messages[0].payload.body));
  assert.ok(!("payload" in (await rest("GET", "/threads/18f0000000000101?format=minimal")).json.messages[0]));
  await restError("GET", "/threads/18f00000000000ff", 404, "notFound");

  const attachment = (await rest("GET", "/messages/18f0000000000201/attachments/att_18f000000000a001")).json;
  assert.equal(attachment.size, 297);
  assert.ok(Buffer.from(attachment.data, "base64url").toString("utf8").includes("INV-2026-0912"));
  assert.deepEqual((await rest("GET", "/messages/18f0000000000d01/attachments/att_18f000000000a002")).json, { attachmentId: "att_18f000000000a002", size: 0, data: "" });
  await restError("GET", "/messages/18f0000000000d01/attachments/att_18f000000000a001", 404, "notFound");
  await restError("GET", "/messages/18f0000000000201/attachments/att_0000000000000000", 404, "notFound");

  const drafts = (await rest("GET", "/drafts")).json;
  assert.deepEqual(drafts.drafts.map((draft) => draft.id), ["r5900000000000000102", "r5900000000000000101"]);
  assert.deepEqual((await rest("GET", "/drafts?q=subject:Refund")).json.drafts.map((draft) => draft.id), ["r5900000000000000102"]);
  await restError("GET", "/drafts?q=larger:1m", 400, "invalidArgument");
  await restError("GET", "/drafts?pageToken=nope", 400, "invalidArgument");
  assert.equal((await rest("GET", "/drafts/r5900000000000000101")).json.message.id, "18f0000000000c01");
  await restError("GET", "/drafts/r5900000000000000999", 404, "notFound");

  // Label mutations ----------------------------------------------------------------------------
  const created = (await rest("POST", "/labels", { body: { name: "Vendors", color: { textColor: "#ffffff", backgroundColor: "#123456" } } })).json;
  assert.equal(created.id, "Label_301");
  assert.equal(created.type, "user");
  await restError("POST", "/labels", 409, "aborted", { body: { name: "vendors" } });
  await restError("POST", "/labels", 400, "invalidArgument", { body: { name: "INBOX" } });
  const patched = (await rest("PATCH", "/labels/Label_301", { body: { color: { textColor: "#000000", backgroundColor: "#ffff00" } } })).json;
  assert.deepEqual(patched.color, { textColor: "#000000", backgroundColor: "#ffff00" });
  assert.equal((await rest("PUT", "/labels/Label_301", { body: { name: "Suppliers" } })).json.name, "Suppliers");
  await restError("PATCH", "/labels/Label_301", 409, "aborted", { body: { name: "Customers" } });
  await restError("PATCH", "/labels/Label_301", 400, "invalidArgument", { body: { name: "/bad/" } });
  // Route fuzz retrofit: JSON bodies nested past 512 levels answer 400 before argument validation.
  const deepObject = (depth) => `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
  const deepArray = (depth) => `${"[".repeat(depth)}1${"]".repeat(depth)}`;
  const deep = async (method, path, rawBody) => {
    const response = await fetch(`${ME}${path}`, { method, headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" }, body: rawBody });
    const text = await response.text();
    assert.equal(response.status, 400, `${method} ${path} deep body -> ${response.status} ${text.slice(0, 300)}`);
  };
  await deep("PATCH", "/labels/Label_301", `{"color":${deepObject(2000)}}`);
  await deep("PATCH", "/labels/Label_301", `{"color":${deepArray(2500)}}`);
  await deep("POST", "/labels", `{"name":"Deep","color":${deepObject(3110)}}`);
  await deep("POST", "/labels", `{"name":"Deep","color":{"textColor":"#000000","x":${deepArray(513)}}}`);
  await restError("PATCH", "/labels/Label_301", 400, "badRequest", { body: { color: { textColor: { nested: { deeper: ["#000000"] } }, backgroundColor: "#ffff00" } } });
  await restError("PATCH", "/labels/INBOX", 400, "failedPrecondition", { body: { name: "Mail" } });
  await restError("PATCH", "/labels/Label_999", 404, "notFound", { body: { name: "Ghost" } });
  await restError("DELETE", "/labels/INBOX", 400, "failedPrecondition");
  await restError("DELETE", "/labels/Label_999", 404, "notFound");
  assert.equal((await rest("PUT", "/labels/Label_301", { body: {}, status: 400 })).json.code, "framework.HTTP_REQUEST_MAPPING_FAILED", "PUT requires name");

  // Message label mutations --------------------------------------------------------------------
  const modified = (await rest("POST", "/messages/18f0000000000101/modify", { body: { addLabelIds: ["STARRED", "Label_301"], removeLabelIds: ["UNREAD"] } })).json;
  assert.ok(modified.labelIds.includes("STARRED") && modified.labelIds.includes("Label_301") && !modified.labelIds.includes("UNREAD"));
  assert.ok(!("payload" in modified));
  await restError("POST", "/messages/18f0000000000101/modify", 400, "invalidArgument", { body: { addLabelIds: ["DRAFT"] } });
  await restError("POST", "/messages/18f0000000000101/modify", 400, "invalidArgument", { body: { addLabelIds: ["Label_999"] } });
  await restError("POST", "/messages/18f0000000000101/modify", 400, "invalidArgument", { body: {} });
  await restError("POST", "/messages/18f00000000000ff/modify", 404, "notFound", { body: { addLabelIds: ["STARRED"] } });
  await restError("POST", "/messages/batchModify", 404, "notFound", { body: { ids: ["18f0000000000401", "18f00000000000ff"], removeLabelIds: ["INBOX"] } });
  assert.ok((await rest("GET", "/messages/18f0000000000401?format=minimal")).json.labelIds.includes("INBOX"), "failed batch left no partial change");
  await restError("POST", "/messages/batchModify", 400, "invalidArgument", { body: { ids: ["18f0000000000401"] } });
  await rest("POST", "/messages/batchModify", { body: { ids: ["18f0000000000401", "18f0000000000402"], removeLabelIds: ["INBOX"] }, status: 204 });
  assert.ok(!(await rest("GET", "/messages/18f0000000000402?format=minimal")).json.labelIds.includes("INBOX"));
  assert.equal((await rest("GET", "/threads?q=in:inbox")).json.resultSizeEstimate, 6, "archived thread left the inbox");

  // Trash and untrash --------------------------------------------------------------------------
  const trashed = (await rest("POST", "/messages/18f0000000000601/trash")).json;
  assert.ok(trashed.labelIds.includes("TRASH") && !trashed.labelIds.includes("INBOX"));
  await restError("POST", "/messages/18f0000000000601/trash", 400, "failedPrecondition");
  const restored = (await rest("POST", "/messages/18f0000000000601/untrash")).json;
  assert.ok(restored.labelIds.includes("INBOX") && !restored.labelIds.includes("TRASH"));
  await restError("POST", "/messages/18f0000000000101/untrash", 400, "failedPrecondition");
  await restError("POST", "/messages/18f00000000000ff/trash", 404, "notFound");
  await restError("POST", "/messages/18f00000000000ff/untrash", 404, "notFound");

  // Thread mutations ---------------------------------------------------------------------------
  const threadModified = (await rest("POST", "/threads/18f0000000000401/modify", { body: { addLabelIds: ["IMPORTANT"] } })).json;
  assert.ok(threadModified.messages.every((message) => message.labelIds.includes("IMPORTANT")));
  await restError("POST", "/threads/18f0000000000401/modify", 400, "invalidArgument", { body: { addLabelIds: ["DRAFT"] } });
  await restError("POST", "/threads/18f00000000000ff/modify", 404, "notFound", { body: { addLabelIds: ["STARRED"] } });
  const threadTrashed = (await rest("POST", "/threads/18f0000000000901/trash")).json;
  assert.ok(threadTrashed.messages.every((message) => message.labelIds.includes("TRASH")));
  await restError("POST", "/threads/18f0000000000701/trash", 400, "failedPrecondition");
  await restError("POST", "/threads/18f00000000000ff/trash", 404, "notFound");

  // Drafts -------------------------------------------------------------------------------------
  const multipart = base64url(
    "To: partner@example.org\r\nSubject: Multipart draft\r\nContent-Type: multipart/alternative; boundary=\"b1\"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=C3=A9 plain part\r\n--b1\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Caf&eacute; html part</p>\r\n--b1--\r\n",
  );
  const draft = (await rest("POST", "/drafts", { body: { message: { raw: multipart } } })).json;
  assert.match(draft.id, /^r59\d{17}$/);
  assert.deepEqual(draft.message.labelIds, ["DRAFT"]);
  const draftRead = (await rest("GET", `/drafts/${draft.id}`)).json;
  assert.equal(draftRead.message.payload.mimeType, "multipart/alternative");
  assert.equal(Buffer.from(draftRead.message.payload.parts[0].body.data, "base64url").toString("utf8"), "Café plain part");
  const withAttachment = base64url(
    "To: a@example.org\r\nSubject: Attached\r\nContent-Type: multipart/mixed; boundary=\"m\"\r\n\r\n--m\r\nContent-Type: text/plain\r\n\r\nhi\r\n--m\r\nContent-Type: application/pdf; name=\"x.pdf\"\r\nContent-Disposition: attachment; filename=\"x.pdf\"\r\n\r\nAAAA\r\n--m--\r\n",
  );
  await restError("POST", "/drafts", 400, "invalidArgument", { body: { message: { raw: withAttachment } } });
  await restError("POST", "/drafts", 404, "notFound", { body: { message: { raw: multipart, threadId: "18f00000000000ff" } } });
  const updated = (await rest("PUT", "/drafts/r5900000000000000101", { body: { message: { to: ["finance@example.test"], cc: ["cfo@example.test"], subject: "Q3 budget sign-off (v2)", body: "Updated body." } } })).json;
  assert.equal(updated.message.id, "18f0000000000c01", "update keeps the draft's message id");
  const updatedView = (await rest("GET", "/drafts?q=subject:v2")).json;
  assert.deepEqual(updatedView.drafts.map((item) => item.id), ["r5900000000000000101"]);
  const threadsBeforeMove = (await rest("GET", "/profile")).json.threadsTotal;
  const moved = (await rest("PUT", "/drafts/r5900000000000000101", { body: { message: { threadId: "18f0000000000301", to: ["finance@example.test"], subject: "Q3 budget sign-off (v2)", body: "Moved into the newsletter thread." } } })).json;
  assert.equal(moved.message.id, "18f0000000000c01", "a move keeps the draft's message id");
  assert.equal(moved.message.threadId, "18f0000000000301", "threadId on PUT moves the draft into that thread");
  assert.deepEqual((await rest("GET", "/threads/18f0000000000301?format=minimal")).json.messages.map((message) => message.id), ["18f0000000000301", "18f0000000000c01"]);
  await restError("GET", "/threads/18f0000000000c01", 404, "notFound");
  const movedMeta = (await rest("GET", "/messages/18f0000000000c01?format=metadata")).json;
  assert.equal(movedMeta.threadId, "18f0000000000301");
  const parentMessageId = (await rest("GET", "/messages/18f0000000000301?format=metadata")).json.payload.headers.find((header) => header.name === "Message-ID").value;
  assert.equal(movedMeta.payload.headers.find((header) => header.name === "In-Reply-To")?.value, parentMessageId, "the move threads the draft under the thread's last message");
  assert.equal((await rest("GET", "/profile")).json.threadsTotal, threadsBeforeMove - 1, "the emptied single-draft thread disappeared");
  await restError("PUT", "/drafts/r5900000000000000101", 404, "notFound", { body: { message: { threadId: "18f00000000000ff", subject: "x" } } });
  assert.equal((await rest("GET", "/drafts/r5900000000000000101")).json.message.threadId, "18f0000000000301", "a refused move changes nothing");
  await restError("PUT", "/drafts/r5900000000000000999", 404, "notFound", { body: { message: { to: ["x@example.org"], subject: "x" } } });
  await restError("PUT", "/drafts/r5900000000000000101", 400, "invalidArgument", { body: { message: { to: ["not an address"], subject: "x" } } });
  const empty = (await rest("POST", "/drafts", { body: { message: { subject: "Nobody yet", body: "recipients come later" } } })).json;
  await restError("POST", "/drafts/send", 400, "invalidArgument", { body: { id: empty.id } });
  await rest("DELETE", `/drafts/${empty.id}`, { status: 204 });
  const sentDraft = (await rest("POST", "/drafts/send", { body: { id: "r5900000000000000102" } })).json;
  assert.equal(sentDraft.threadId, "18f0000000000101", "reply draft stays in its thread");
  assert.deepEqual(sentDraft.labelIds, ["SENT"]);
  const threadAfter = (await rest("GET", "/threads/18f0000000000101?format=minimal")).json;
  assert.deepEqual(threadAfter.messages.map((message) => message.id), ["18f0000000000101", "18f0000000000102", "18f0000000000103", sentDraft.id]);
  await restError("GET", "/drafts/r5900000000000000102", 404, "notFound");
  await restError("POST", "/drafts/send", 404, "notFound", { body: { id: "r5900000000000000102" } });
  await rest("DELETE", `/drafts/${draft.id}`, { status: 204 });
  await restError("DELETE", `/drafts/${draft.id}`, 404, "notFound");
  assert.deepEqual((await rest("GET", "/drafts")).json.drafts.map((item) => item.id), ["r5900000000000000101"]);

  // Send ---------------------------------------------------------------------------------------
  const raw = base64url(`From: ${DANA}\r\nTo: Sam <${SAM}>, outside@example.org\r\nSubject: Hello from raw\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHi Sam, this is a raw RFC 2822 message.\r\n`);
  const sent = (await rest("POST", "/messages/send", { body: { raw } })).json;
  assert.deepEqual(sent.labelIds, ["SENT"]);
  const sentList = (await rest("GET", "/messages?q=in:sent")).json;
  assert.ok(ids(sentList.messages).includes(sent.id));
  const sentFull = (await rest("GET", `/messages/${sent.id}`)).json;
  assert.equal(sentFull.payload.headers.find((header) => header.name === "To").value, `${SAM}, outside@example.org`);
  assert.equal(sentFull.payload.headers.find((header) => header.name === "From").value, `Dana Reyes <${DANA}>`);
  const reply = (await rest("POST", "/messages/send", { body: { replyToMessageId: "18f0000000000103", body: "Following up by API." } })).json;
  assert.equal(reply.threadId, "18f0000000000101");
  const replyFull = (await rest("GET", `/messages/${reply.id}?format=metadata`)).json;
  assert.equal(replyFull.payload.headers.find((header) => header.name === "Subject").value, "Re: Refund for order 48213");
  assert.equal(replyFull.payload.headers.find((header) => header.name === "In-Reply-To").value, "<a1f3.48213.2@example.com>");
  await restError("POST", "/messages/send", 404, "notFound", { body: { raw, threadId: "18f00000000000ff" } });
  await restError("POST", "/messages/send", 400, "invalidArgument", { body: { subject: "no one", body: "x" } });
  await restError("POST", "/messages/send", 400, "invalidArgument", { body: { to: ["bad address"], body: "x" } });

  // Delegation is refused for any userId other than me / own address ---------------------------
  await restError("GET", `${HTTP}/gmail/v1/users/someone.else@example.test/profile`, 403, "forbidden");
  assert.equal((await rest("GET", `${HTTP}/gmail/v1/users/${DANA}/profile`)).json.emailAddress, DANA);
  const other = "someone.else@example.test";
  const forbiddenCalls = {
    "profile.get": {},
    "labels.list": {},
    "labels.create": { displayName: "x" },
    "labels.update": { labelId: "Label_1" },
    "labels.delete": { labelId: "Label_1" },
    "messages.list": {},
    "messages.get": { id: "18f0000000000101" },
    "messages.modify": { id: "18f0000000000101", addLabelIds: ["STARRED"] },
    "messages.batch-modify": { ids: ["18f0000000000101"], addLabelIds: ["STARRED"] },
    "messages.label": { messageId: "18f0000000000101", labelIds: ["STARRED"] },
    "messages.unlabel": { messageId: "18f0000000000101", labelIds: ["STARRED"] },
    "messages.trash": { id: "18f0000000000101" },
    "messages.untrash": { id: "18f0000000000101" },
    "messages.send": { to: ["x@example.org"], body: "x" },
    "attachments.get": { messageId: "18f0000000000201", id: "att_18f000000000a001" },
    "threads.list": {},
    "threads.get": { threadId: "18f0000000000101" },
    "threads.modify": { id: "18f0000000000101", addLabelIds: ["STARRED"] },
    "threads.label": { threadId: "18f0000000000101", labelIds: ["STARRED"] },
    "threads.unlabel": { threadId: "18f0000000000101", labelIds: ["STARRED"] },
    "threads.trash": { id: "18f0000000000101" },
    "drafts.list": {},
    "drafts.get": { id: "r5900000000000000101" },
    "drafts.create": { to: ["x@example.org"] },
    "drafts.update": { id: "r5900000000000000101", subject: "x" },
    "drafts.send": { id: "r5900000000000000101" },
    "drafts.delete": { id: "r5900000000000000101" },
  };
  assert.equal(Object.keys(forbiddenCalls).length, 27);
  for (const [operationId, args] of Object.entries(forbiddenCalls)) await op(operationId, { userId: other, ...args }, "FORBIDDEN");
  assert.equal((await rest("GET", "/profile")).json.messagesTotal, 22, "forbidden calls changed nothing");

  // Label deletion removes the label from messages ---------------------------------------------
  await rest("DELETE", "/labels/Label_301", { status: 204 });
  assert.ok(!(await rest("GET", "/labels")).json.labels.some((label) => label.id === "Label_301"));
  assert.ok(!(await rest("GET", "/messages/18f0000000000101?format=minimal")).json.labelIds.includes("Label_301"));

  // User labels named like Object.prototype members are ordinary labels: label: search must resolve them, never an
  // inherited member (constructor, __proto__, toString, hasOwnProperty), on messages.list and threads.list.
  const protoNames = ["constructor", "__proto__", "toString", "hasOwnProperty"];
  const protoLabels = [];
  for (const name of protoNames) {
    const label = (await rest("POST", "/labels", { body: { name } })).json;
    assert.equal(label.name, name);
    protoLabels.push(label);
  }
  assert.equal(Object.prototype.polluted, undefined, "no prototype pollution");
  for (const [index, label] of protoLabels.entries()) {
    const target = ["18f0000000000201", "18f0000000000301", "18f0000000000501", "18f0000000000601"][index];
    await rest("POST", `/messages/${target}/modify`, { body: { addLabelIds: [label.id] } });
    const q = encodeURIComponent(`label:${label.name}`);
    same(ids((await list(`?q=${q}`)).messages), [target]);
    same(ids((await rest("GET", `/threads?q=${q}`)).json.threads ?? []), [target]);
    const negated = ids((await list(`?q=${encodeURIComponent(`-label:${label.name}`)}`)).messages);
    assert.ok(!negated.includes(target) && negated.length > 0, `-label:${label.name} excludes only the labelled message`);
    same(ids((await list(`?q=${encodeURIComponent(`label:${label.id}`)}`)).messages), [target]);
  }
  assert.equal((await list(`?q=${encodeURIComponent("label:valueOf")}`)).resultSizeEstimate, 0, "an unknown prototype-member name matches nothing");
  same(ids((await list("?q=in:inbox")).messages), ids((await list("?q=label:inbox")).messages));
  for (const label of protoLabels) await rest("DELETE", `/labels/${label.id}`, { status: 204 });

  // Response byte budget ------------------------------------------------------------------------
  // Two maximum-size CJK messages in one thread (3 UTF-8 bytes per character, all within the schema limits): each
  // message alone fits one response, the whole thread in full format does not, and it is refused with the declared
  // Gmail error instead of a framework 500. Lighter formats and every list keep working.
  const cjk = String.fromCharCode(0x6f22);
  const big = { to: ["outside@example.org"], subject: "Large", body: cjk.repeat(65000), htmlBody: `<p>${cjk.repeat(130000)}</p>` };
  const bigFirst = (await rest("POST", "/messages/send", { body: big })).json;
  const bigSecond = (await rest("POST", "/messages/send", { body: { ...big, threadId: bigFirst.threadId } })).json;
  assert.equal(bigSecond.threadId, bigFirst.threadId);
  const tooLarge = await restError("GET", `/threads/${bigFirst.threadId}?format=full`, 400, "failedPrecondition");
  assert.match(tooLarge.json.error.message, /^Response too large for this Tool/);
  assert.equal(tooLarge.json.error.status, "FAILED_PRECONDITION");
  const minimalThread = (await rest("GET", `/threads/${bigFirst.threadId}?format=minimal`)).json;
  same(ids(minimalThread.messages), [bigFirst.id, bigSecond.id]);
  const mcpTooLarge = await op("threads.get", { threadId: bigFirst.threadId }, "FAILED_PRECONDITION");
  assert.match(mcpTooLarge.message, /Response too large/);
  const oneMessage = await fetch(`${ME}/messages/${bigSecond.id}?format=full`, { headers: { authorization: `Bearer ${HTTP_TOKEN}` } });
  const oneBytes = Buffer.from(await oneMessage.arrayBuffer());
  assert.equal(oneMessage.status, 200);
  assert.ok(oneBytes.length < 1024 * 1024, `messages.get full stays under 1 MiB (${oneBytes.length} bytes)`);
  assert.equal(JSON.parse(oneBytes.toString("utf8")).payload.parts[1].body.size, 3 + 130000 * 3 + 4);
  const listed = new Set();
  let listToken;
  do {
    const page = (await rest("GET", `/threads?maxResults=100${listToken ? `&pageToken=${encodeURIComponent(listToken)}` : ""}`)).json;
    for (const thread of page.threads ?? []) listed.add(thread.id);
    listToken = page.nextPageToken;
  } while (listToken);
  assert.ok(listed.has(bigFirst.threadId), "threads.list still pages to the large thread");
  return { sentMessageId: sent.id, replyMessageId: reply.id };
}

// ---------------------------------------------------------------------------------------------
// Drill: mcp-aliases (owner, baseline)
// ---------------------------------------------------------------------------------------------

async function mcpAliases() {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gmail-conformance", version: "0.1.0" } });
  const tools = (await rpc("tools/list", {})).tools.map((tool) => tool.name);
  const aliases = ["list_labels", "create_label", "update_label", "delete_label", "search_threads", "get_thread", "label_thread", "unlabel_thread", "label_message", "unlabel_message", "list_drafts", "create_draft"];
  for (const alias of aliases) assert.ok(tools.includes(alias), `alias ${alias} missing`);
  assert.equal(tools.filter((name) => name.startsWith("gmail.")).length, 27, "every canonical name is listed");

  const listed = await mcp("list_labels", {});
  assert.deepEqual(listed.labels.map((label) => label.labelId), ["Label_1", "Label_2", "Label_3", "Label_4"]);
  assert.equal(listed.labels[0].threadsTotal, 2, "Customers: threads T1 and T9");
  assert.equal(listed.labels[0].threadsUnread, 1);
  const first = await mcp("list_labels", { pageSize: 2 });
  assert.equal(first.labels.length, 2);
  const second = await mcp("list_labels", { pageSize: 2, pageToken: first.nextPageToken });
  assert.deepEqual(second.labels.map((label) => label.labelId), ["Label_3", "Label_4"]);
  assert.equal(second.nextPageToken, undefined);
  await mcpError("list_labels", { pageToken: "broken" }, "tool.INVALID_PAGE_TOKEN");

  const created = await mcp("create_label", { displayName: "Projects/Apollo", color: { textColor: "#ffffff", backgroundColor: "#8e63ce" } });
  assert.equal(created.labelId, "Label_301");
  assert.equal(created.threadsTotal, 0);
  const renamed = await mcp("update_label", { labelId: "Label_301", displayName: "Projects/Artemis" });
  assert.equal(renamed.name, "Projects/Artemis");
  await mcpError("update_label", { labelId: "Label_999", displayName: "x" }, "tool.NOT_FOUND");

  const inbox = await mcp("search_threads", { query: "in:inbox", pageSize: 5 });
  assert.equal(inbox.threads.length, 5);
  assert.equal(inbox.resultSizeEstimate, 7);
  assert.ok(inbox.threads[0].messages[0].snippet && inbox.threads[0].messages[0].sender);
  assert.ok(!("plaintextBody" in inbox.threads[0].messages[0]), "search results are MINIMAL");
  const inboxPage2 = await mcp("search_threads", { query: "in:inbox", pageSize: 5, pageToken: inbox.nextPageToken });
  assert.equal(inboxPage2.threads.length, 2);
  assert.equal((await mcp("search_threads", {})).resultSizeEstimate, 10);
  assert.equal((await mcp("search_threads", { includeTrash: true })).resultSizeEstimate, 12);
  await mcpError("search_threads", { query: "deliveredto:me" }, "tool.INVALID_ARGUMENT");
  await mcpError("search_threads", { query: "after:2024/13/45" }, "tool.INVALID_ARGUMENT");
  await mcpError("search_threads", { query: "from:\uFFFD" }, "tool.INVALID_ARGUMENT");

  const minimalThread = await mcp("get_thread", { threadId: "18f0000000000201", messageFormat: "MINIMAL" });
  assert.ok(!("plaintextBody" in minimalThread.messages[0]) && !("attachmentIds" in minimalThread.messages[0]));
  const fullThread = await mcp("get_thread", { threadId: "18f0000000000201" });
  assert.deepEqual(fullThread.messages[0].attachmentIds, ["att_18f000000000a001"]);
  assert.equal(fullThread.messages[0].attachments[0].filename, "INV-2026-0912.pdf");
  assert.ok(fullThread.messages[0].plaintextBody.startsWith("Your invoice"));
  assert.equal(fullThread.messages[0].date, "2026-09-12");
  await mcpError("get_thread", { threadId: "18f00000000000ff" }, "tool.NOT_FOUND");

  const labelled = await mcp("label_thread", { threadId: "18f0000000000401", labelIds: ["STARRED", "Label_301"] });
  assert.ok(labelled.labelIds.includes("Label_301") && labelled.labelIds.includes("STARRED"));
  const unlabelled = await mcp("unlabel_thread", { threadId: "18f0000000000401", labelIds: ["Label_301"] });
  assert.ok(!unlabelled.labelIds.includes("Label_301"));
  await mcpError("label_thread", { threadId: "18f00000000000ff", labelIds: ["STARRED"] }, "tool.NOT_FOUND");
  await mcpError("label_thread", { threadId: "18f0000000000401", labelIds: ["DRAFT"] }, "tool.INVALID_ARGUMENT");
  await mcpError("unlabel_thread", { threadId: "18f00000000000ff", labelIds: ["STARRED"] }, "tool.NOT_FOUND");
  await mcpError("unlabel_thread", { threadId: "18f0000000000401", labelIds: ["Label_999"] }, "tool.INVALID_ARGUMENT");

  const messageLabelled = await mcp("label_message", { messageId: "18f0000000000101", labelIds: ["STARRED"] });
  assert.ok(messageLabelled.labelIds.includes("STARRED"));
  const messageUnlabelled = await mcp("unlabel_message", { messageId: "18f0000000000101", labelIds: ["UNREAD"] });
  assert.ok(!messageUnlabelled.labelIds.includes("UNREAD"));
  await mcpError("label_message", { messageId: "18f00000000000ff", labelIds: ["STARRED"] }, "tool.NOT_FOUND");
  await mcpError("label_message", { messageId: "18f0000000000101", labelIds: ["SENT"] }, "tool.INVALID_ARGUMENT");
  await mcpError("unlabel_message", { messageId: "18f00000000000ff", labelIds: ["STARRED"] }, "tool.NOT_FOUND");
  await mcpError("unlabel_message", { messageId: "18f0000000000101", labelIds: ["DRAFT"] }, "tool.INVALID_ARGUMENT");

  const draft = await mcp("create_draft", { to: ["priya.natarajan@example.com"], body: "Refund RF-77120 confirmed by the MCP alias.", replyToMessageId: "18f0000000000103" });
  assert.equal(draft.threadId, "18f0000000000101");
  assert.equal(draft.subject, "Re: Refund for order 48213");
  assert.deepEqual(draft.toRecipients, ["priya.natarajan@example.com"]);
  assert.equal(draft.plaintextBody, "Refund RF-77120 confirmed by the MCP alias.");
  await mcpError("create_draft", { to: ["a@example.org"], attachments: [{ content: "QUJD", filename: "a.txt" }] }, "tool.INVALID_ARGUMENT");
  await mcpError("create_draft", { to: ["a@example.org"], replyToMessageId: "18f00000000000ff" }, "tool.NOT_FOUND");
  const drafts = await mcp("list_drafts", { query: "subject:Refund" });
  assert.deepEqual(drafts.drafts.map((item) => item.id).sort(), ["r5900000000000000102", draft.id].sort());
  await mcpError("list_drafts", { query: "category:updates" }, "tool.INVALID_ARGUMENT");
  await mcpError("list_drafts", { pageToken: "nope" }, "tool.INVALID_PAGE_TOKEN");

  const sent = await mcp("gmail.drafts.send", { id: draft.id });
  assert.equal(sent.threadId, "18f0000000000101");
  const thread = (await rest("GET", "/threads/18f0000000000101?format=minimal")).json;
  assert.equal(thread.messages.length, 5, "thread grew by the sent reply; the draft message is gone");
  assert.equal(thread.messages[4].id, sent.id);
  await mcp("delete_label", { labelId: "Label_301" });
  await mcpError("delete_label", { labelId: "Label_301" }, "tool.NOT_FOUND");
  await mcpError("delete_label", { labelId: "TRASH" }, "tool.FAILED_PRECONDITION");
  assert.deepEqual((await mcp("list_drafts", {})).drafts.map((item) => item.id), ["r5900000000000000102", "r5900000000000000101"]);
}

// ---------------------------------------------------------------------------------------------
// Drill: isolation (colleague, baseline)
// ---------------------------------------------------------------------------------------------

async function isolation() {
  const profile = (await rest("GET", "/profile")).json;
  assert.equal(profile.emailAddress, SAM);
  assert.equal(profile.messagesTotal, 3);
  const mine = (await rest("GET", "/messages")).json;
  same(ids(mine.messages), ["18f0000000000101", "18f0000000000102", "18f0000000000103"]);
  // All three of Sam's ids equal Dana's 101/102/103 (and his thread 101 equals hers). Rows are keyed per mailbox, so
  // every read by id must answer Sam's message, never Dana's "Refund for order 48213" thread, over the REST route and
  // over the canonical /v1/operations path alike.
  const subjectOf = (message) => message.payload.headers.find((header) => header.name === "Subject").value;
  const collided = (await rest("GET", "/messages/18f0000000000101?format=metadata")).json;
  assert.equal(subjectOf(collided), "Can you review the Q3 budget draft?", "same id, Sam's message");
  assert.equal(collided.threadId, "18f0000000000101", "Sam's thread id also collides with Dana's");
  const samSubjects = {
    "18f0000000000102": "Re: Can you review the Q3 budget draft?",
    "18f0000000000103": "[team] Nightly build failed: integration-suite",
  };
  for (const [id, subject] of Object.entries(samSubjects)) {
    const viaRest = (await rest("GET", `/messages/${id}?format=metadata`)).json;
    assert.equal(viaRest.id, id);
    assert.equal(subjectOf(viaRest), subject, `REST ${id}: Sam's message, not Dana's`);
    assert.ok(!subjectOf(viaRest).includes("Refund"), `REST ${id}: Dana's row must not leak`);
    const viaCanonical = await op("messages.get", { id, format: "metadata" });
    assert.equal(viaCanonical.id, id);
    assert.equal(subjectOf(viaCanonical), subject, `canonical ${id}: Sam's message, not Dana's`);
  }
  const samThread = (await rest("GET", "/threads/18f0000000000101?format=metadata")).json;
  assert.deepEqual(samThread.messages.map((message) => message.id), ["18f0000000000101", "18f0000000000102"], "Sam's thread 101 holds his two messages, not Dana's four");
  await restError("GET", "/threads/18f0000000000201", 404, "notFound");
  await restError("POST", "/messages/18f0000000000201/modify", 404, "notFound", { body: { addLabelIds: ["STARRED"] } });
  const read = (await rest("POST", "/messages/18f0000000000103/modify", { body: { removeLabelIds: ["UNREAD"] } })).json;
  assert.ok(!read.labelIds.includes("UNREAD"));
  const threads = (await rest("GET", "/threads")).json;
  assert.equal(threads.resultSizeEstimate, 2);
  // Dana owns a mailboxes row and receives one INBOX copy (drill state assertions). Marcus appears in the starter
  // data only as a sender: no mailboxes row exists for him and none is created by being addressed, so deliver()
  // skips him (drill asserts zero mailboxes and zero messages rows for his address) while the SENT copy keeps the Cc.
  const sent = (await rest("POST", "/messages/send", { body: { to: [DANA], cc: [NO_ROW], subject: "Budget reviewed", body: "All good from my side." } })).json;
  assert.deepEqual(sent.labelIds, ["SENT"]);
  const sentHeaders = (await rest("GET", `/messages/${sent.id}?format=metadata`)).json.payload.headers;
  assert.equal(sentHeaders.find((header) => header.name === "Cc").value, NO_ROW, "the sender's copy keeps the undelivered Cc");
  assert.equal((await rest("GET", "/messages?q=in:sent")).json.resultSizeEstimate, 2);
  await restError("GET", `${HTTP}/gmail/v1/users/${DANA}/profile`, 403, "forbidden");
  assert.equal((await rest("GET", "/profile")).json.messagesTotal, 4);
}

// ---------------------------------------------------------------------------------------------
// Drill: denied (auditor, baseline)
// ---------------------------------------------------------------------------------------------

async function denied() {
  const profile = await rest("GET", "/profile", { status: 403 });
  assert.equal(profile.json.error.errors[0].reason, "forbidden");
  assert.equal(profile.json.error.status, "PERMISSION_DENIED");
  await rest("GET", "/threads", { status: 403 });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gmail-conformance", version: "0.1.0" } });
  const result = await rpc("tools/call", { name: "search_threads", arguments: {} });
  assert.ok(result.isError);
  assert.equal(result.structuredContent.status, "denied");
}

// ---------------------------------------------------------------------------------------------
// Drill: send-rate-limited (owner, scenario send-rate-limited)
// ---------------------------------------------------------------------------------------------

async function sendRateLimited() {
  const before = (await rest("GET", "/messages?q=in:sent")).json.resultSizeEstimate;
  const limited = await restError("POST", "/messages/send", 429, "rateLimitExceeded", { body: { to: [SAM], subject: "x", body: "y" } });
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(limited.json.error.errors[0].domain, "usageLimits");
  assert.equal(limited.json.error.status, "RESOURCE_EXHAUSTED");
  await restError("POST", "/drafts/send", 429, "rateLimitExceeded", { body: { id: "r5900000000000000101" } });
  assert.equal((await rest("GET", "/drafts")).json.drafts.length, 2, "draft survives a refused send");
  assert.equal((await rest("GET", "/messages?q=in:sent")).json.resultSizeEstimate, before);
  assert.equal((await rest("GET", "/profile")).json.messagesTotal, 20);
}

// ---------------------------------------------------------------------------------------------
// Drill: mailbox-unavailable (owner, scenario mailbox-unavailable)
// ---------------------------------------------------------------------------------------------

async function mailboxUnavailable() {
  const listing = await restError("GET", "/messages", 503, "backendError");
  assert.equal(listing.json.error.status, "UNAVAILABLE");
  await restError("GET", "/threads?q=in:inbox", 503, "backendError");
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gmail-conformance", version: "0.1.0" } });
  await mcpError("search_threads", { query: "in:inbox" }, "tool.BACKEND_ERROR");
  assert.equal((await rest("GET", "/messages/18f0000000000101?format=minimal")).json.id, "18f0000000000101", "reads by id still work");
  assert.equal((await rest("GET", "/labels")).json.labels.length, 18);
  assert.equal((await rest("GET", "/threads/18f0000000000101?format=minimal")).json.messages.length, 4);
}

// ---------------------------------------------------------------------------------------------
// Drill: fresh-install (newcomer: no identity attributes, every grant; baseline)
// ---------------------------------------------------------------------------------------------

async function freshInstall() {
  // Without an `email` attribute the actor acts as the primary seeded mailbox (lowest mailbox row id), not an empty one.
  const profile = (await rest("GET", "/profile")).json;
  assert.deepEqual(profile, { emailAddress: DANA, messagesTotal: 20, threadsTotal: 12, historyId: "1200" });
  assert.equal((await op("profile.get", {})).serverTime, "2026-09-14T09:00:00.000Z");
  assert.equal((await rest("GET", "/messages")).json.resultSizeEstimate, 18, "the seeded inbox is visible");
  assert.equal((await rest("GET", "/labels")).json.labels.length, 18);
  assert.equal((await rest("GET", "/threads?q=in:inbox")).json.resultSizeEstimate, 7);
  assert.equal((await rest("GET", `${HTTP}/gmail/v1/users/${DANA}/profile`)).json.emailAddress, DANA, "the resolved address is accepted as userId");
  await restError("GET", `${HTTP}/gmail/v1/users/${SAM}/profile`, 403, "forbidden");
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gmail-conformance", version: "0.1.0" } });
  assert.deepEqual((await mcp("list_labels", {})).labels.map((label) => label.labelId), ["Label_1", "Label_2", "Label_3", "Label_4"]);
  const sent = (await rest("POST", "/messages/send", { body: { to: [SAM], subject: "Hello from a fresh install", body: "Sent without any actor attributes." } })).json;
  assert.deepEqual(sent.labelIds, ["SENT"]);
  const header = (await rest("GET", `/messages/${sent.id}?format=metadata`)).json.payload.headers.find((item) => item.name === "From").value;
  assert.equal(header, `Dana Reyes <${DANA}>`, "the seeded display name is used, not the actor id");
  assert.equal((await rest("GET", "/profile")).json.messagesTotal, 21);
}

// ---------------------------------------------------------------------------------------------
// Drill: mailbox-over-bound (owner, scenario mailbox-over-bound)
// ---------------------------------------------------------------------------------------------

async function mailboxOverBound() {
  // Dana's mailbox row declares limits { labels: 3, drafts: 1 } against 4 user labels and 2 drafts; Sam's declares
  // { messages: 2 } against 3 messages. Every whole-mailbox read and every capacity-checked write must refuse
  // explicitly; reads and label changes by id must still work; nothing may be stored by a refused call.
  const precondition = (method, path, options) => restError(method, path, 400, "failedPrecondition", options);
  const refusedList = await precondition("GET", "/labels");
  assert.match(refusedList.json.error.message, /more than 3 labels rows/);
  await precondition("POST", "/labels", { body: { name: "One more" } });
  await precondition("PATCH", "/labels/Label_1", { body: { name: "Renamed" } });
  await precondition("GET", "/messages?q=is:unread");
  await precondition("GET", "/threads");
  await precondition("GET", "/drafts");
  await precondition("POST", "/drafts", { body: { message: { to: ["someone@example.org"], subject: "No room", body: "x" } } });
  const fullRecipient = await precondition("POST", "/messages/send", { body: { to: [SAM], subject: "Bounce", body: "Sam's mailbox is over its bound." } });
  assert.match(fullRecipient.json.error.message, /sam\.okafor@example\.test holds more than 2 messages rows/);
  await precondition("POST", "/drafts/send", { body: { id: "r5900000000000000101" } });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gmail-conformance", version: "0.1.0" } });
  await mcpError("search_threads", { query: "in:inbox" }, "tool.FAILED_PRECONDITION");
  await mcpError("list_labels", {}, "tool.FAILED_PRECONDITION");

  // Reads by id and by-id label changes never scan the mailbox.
  assert.equal((await rest("GET", "/profile")).json.messagesTotal, 20);
  assert.equal((await rest("GET", "/messages/18f0000000000101?format=minimal")).json.id, "18f0000000000101");
  assert.equal((await rest("GET", "/threads/18f0000000000101?format=minimal")).json.messages.length, 4);
  assert.equal((await rest("GET", "/drafts/r5900000000000000101")).json.message.id, "18f0000000000c01");
  const read = (await rest("POST", "/messages/18f0000000000101/modify", { body: { removeLabelIds: ["UNREAD"], addLabelIds: ["Label_2"] } })).json;
  assert.ok(!read.labelIds.includes("UNREAD") && read.labelIds.includes("Label_2"), "label changes by id validate labels by id");
  // Dana herself has room (20 of 5000 messages), so mail to an address without a mailbox row still goes out.
  const sent = (await rest("POST", "/messages/send", { body: { to: ["outside@example.org"], subject: "Still sending", body: "Only the full recipient was refused." } })).json;
  assert.deepEqual(sent.labelIds, ["SENT"]);
  assert.equal((await rest("GET", "/profile")).json.messagesTotal, 21);
  assert.equal((await rest("GET", "/drafts/r5900000000000000101")).json.id, "r5900000000000000101", "the refused draft send kept the draft");
}

// ---------------------------------------------------------------------------------------------
// Drill: response-budget (owner, baseline)
// ---------------------------------------------------------------------------------------------

async function responseBudget() {
  // Threading headers from raw MIME are bounded like the stored Message-ID (300 characters); longer ones are refused
  // with invalidArgument instead of failing the state write, and References keeps its latest 20 ids everywhere.
  const raw = (headers) => base64url(`To: outside@example.org\r\nSubject: Threading bounds\r\n${headers}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nhi`);
  const refs = (count, width = 8) => Array.from({ length: count }, (_, index) => `<${String(index).padStart(width, "r")}@example.org>`).join(" ");
  const okSend = (await rest("POST", "/messages/send", { body: { raw: raw(`In-Reply-To: <${"a".repeat(298)}>`) } })).json;
  assert.deepEqual(okSend.labelIds, ["SENT"]);
  const longReply = await restError("POST", "/messages/send", 400, "invalidArgument", { body: { raw: raw(`In-Reply-To: ${"a".repeat(301)}`) } });
  assert.match(longReply.json.error.message, /In-Reply-To header: longer than 300/);
  await restError("POST", "/messages/send", 400, "invalidArgument", { body: { raw: raw(`References: <x@example.org> ${"b".repeat(301)}`) } });
  await restError("POST", "/drafts", 400, "invalidArgument", { body: { message: { raw: raw(`In-Reply-To: ${"c".repeat(301)}`) } } });
  const draft = (await rest("POST", "/drafts", { body: { message: { raw: raw("X-Firedrill-Case: draft") } } })).json;
  await restError("PUT", `/drafts/${draft.id}`, 400, "invalidArgument", { body: { message: { raw: raw(`References: ${"d".repeat(301)}`) } } });
  await rest("PUT", `/drafts/${draft.id}`, { body: { message: { raw: raw(`In-Reply-To: <p@example.org>\r\nReferences: ${refs(25)}`) } } });
  const edited = (await rest("GET", `/messages/${draft.message.id}?format=metadata`)).json;
  const references = edited.payload.headers.find((header) => header.name === "References").value.split(" ");
  assert.equal(references.length, 20, "a draft edit keeps the latest 20 References ids, as a send does");
  assert.equal(references[0], "<rrrrrrr5@example.org>", "the oldest five ids are the ones dropped");

  // A wide thread: 60 messages, each with 50 recipients of 254 characters and 20 References ids of 300 characters. The
  // REST minimal rendering is small and served; metadata and full renderings and every canonical summary view are over
  // the byte budget and refused with the declared error, whose advice names only renderings that fit.
  const address = (index) => `${"a".repeat(60)}${String(index).padStart(4, "0")}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;
  const wide = (threadId) => ({
    raw: raw(`To: ${Array.from({ length: 50 }, (_, index) => address(index)).join(", ")}\r\nIn-Reply-To: <${"e".repeat(298)}>\r\nReferences: ${refs(20, 284)}`),
    ...(threadId ? { threadId } : {}),
  });
  const first = (await rest("POST", "/messages/send", { body: wide() })).json;
  const wideIds = [first.id];
  for (let index = 1; index < 60; index += 1) wideIds.push((await rest("POST", "/messages/send", { body: wide(first.threadId) })).json.id);
  const minimal = await fetch(`${ME}/threads/${first.threadId}?format=minimal`, { headers: { authorization: `Bearer ${HTTP_TOKEN}` } });
  const minimalBytes = Buffer.from(await minimal.arrayBuffer());
  assert.equal(minimal.status, 200);
  assert.ok(minimalBytes.length < 64 * 1024, `REST minimal thread is measured as rendered (${minimalBytes.length} bytes)`);
  same(ids(JSON.parse(minimalBytes.toString("utf8")).messages), wideIds);
  const metadata = await restError("GET", `/threads/${first.threadId}?format=metadata`, 400, "failedPrecondition");
  assert.match(metadata.json.error.message, /^Response too large for this Tool: .* in format=metadata .*fits with format=minimal;/);
  const fullThread = await restError("GET", `/threads/${first.threadId}?format=full`, 400, "failedPrecondition");
  assert.match(fullThread.json.error.message, /fits with format=minimal;/);
  assert.doesNotMatch(fullThread.json.error.message, /format=metadata/, "advice never names a rendering that does not fit");
  const canonicalThread = await op("threads.get", { threadId: first.threadId, messageFormat: "MINIMAL" }, "FAILED_PRECONDITION");
  assert.match(canonicalThread.message, /Response too large.*fits with restFormat minimal/);
  // restFormat is measured on what the operation returns, whichever surface asks: minimal hands back only the REST
  // minimal fields (small, and exactly what was measured), metadata and full stay refused for canonical and MCP callers.
  const slimThread = await op("threads.get", { threadId: first.threadId, messageFormat: "FULL_CONTENT", restFormat: "minimal" });
  assert.ok(Buffer.byteLength(JSON.stringify(slimThread)) < 64 * 1024, "canonical restFormat minimal returns the small shape it measured");
  same(ids(slimThread.messages), wideIds);
  assert.ok(slimThread.messages.every((message) => message.toRecipients === undefined && message.plaintextBody === undefined));
  await op("threads.get", { threadId: first.threadId, restFormat: "metadata" }, "FAILED_PRECONDITION");
  await op("threads.get", { threadId: first.threadId, restFormat: "full" }, "FAILED_PRECONDITION");
  const mcpSlim = await mcp("get_thread", { threadId: first.threadId, restFormat: "minimal" });
  assert.ok(Buffer.byteLength(JSON.stringify(mcpSlim)) < 64 * 1024, "MCP get_thread with restFormat minimal stays small");
  await mcpError("get_thread", { threadId: first.threadId, restFormat: "metadata" }, "tool.FAILED_PRECONDITION");
  await mcpError("get_thread", { threadId: first.threadId }, "tool.FAILED_PRECONDITION");
  assert.equal((await rest("GET", `/messages/${wideIds[3]}?format=metadata`)).json.id, wideIds[3], "each message still reads alone");

  // Lists never hand back an entry above the budget: the canonical thread view refuses it, withoutMessages and REST pages
  // are measured on their own small shape and stay full pages.
  const canonicalList = await op("threads.list", { pageSize: 1 }, "FAILED_PRECONDITION");
  assert.match(canonicalList.message, /withoutMessages: true/);
  await mcpError("search_threads", { pageSize: 5 }, "tool.FAILED_PRECONDITION");
  const slim = await op("threads.list", { pageSize: 100, withoutMessages: true });
  assert.equal(slim.threads[0].id, first.threadId);
  assert.ok(slim.threads.length > 10 && slim.threads.every((thread) => thread.messages === undefined));
  const restList = (await rest("GET", "/threads?maxResults=500")).json;
  assert.equal(restList.threads[0].id, first.threadId);
  assert.equal(restList.threads.length, slim.threads.length, "REST pages are sized on the REST entry, not the canonical view");

  // A thread holds at most 200 messages (the declared bound of every thread output and event payload): the 201st send,
  // a draft created in the thread and a draft moved into it are refused with the declared error, the thread still reads
  // in full, and the refused calls stored nothing.
  const small = (threadId) => ({ to: ["outside@example.org"], subject: "Long thread", body: "one more", ...(threadId ? { threadId } : {}) });
  const long = (await rest("POST", "/messages/send", { body: small() })).json;
  for (let index = 1; index < 200; index += 1) await rest("POST", "/messages/send", { body: small(long.threadId) });
  const fullThreadSend = await restError("POST", "/messages/send", 400, "failedPrecondition", { body: small(long.threadId) });
  assert.match(fullThreadSend.json.error.message, /^Thread [0-9a-f]{16} in mailbox dana\.reyes@example\.test is full: it already holds 200 messages/);
  await restError("POST", "/drafts", 400, "failedPrecondition", { body: { message: small(long.threadId) } });
  const parked = (await rest("POST", "/drafts", { body: { message: small() } })).json;
  const fullThreadMove = await restError("PUT", `/drafts/${parked.id}`, 400, "failedPrecondition", { body: { message: small(long.threadId) } });
  assert.match(fullThreadMove.json.error.message, /is full: it already holds 200 messages/);
  assert.equal((await rest("GET", `/drafts/${parked.id}`)).json.message.threadId, parked.message.threadId, "the refused move left the draft in its own thread");
  const longThread = (await rest("GET", `/threads/${long.threadId}?format=minimal`)).json;
  assert.equal(longThread.messages.length, 200, "a thread at its bound still reads in full");
  assert.equal((await op("threads.get", { threadId: long.threadId, restFormat: "minimal" })).messages.length, 200);
  const trashed = await op("threads.trash", { id: long.threadId });
  assert.equal(trashed.messages.length, 200, "a thread at its bound can still be trashed (200 ids in the event payload)");
  return { wideThreadId: first.threadId, messages: wideIds.length, longThreadId: long.threadId };
}

// ---------------------------------------------------------------------------------------------

const flows = {
  "rest-flow": restFlow,
  "mcp-aliases": mcpAliases,
  isolation,
  denied,
  "send-rate-limited": sendRateLimited,
  "mailbox-unavailable": mailboxUnavailable,
  "fresh-install": freshInstall,
  "mailbox-over-bound": mailboxOverBound,
  "response-budget": responseBudget,
};
const selected = Object.keys(flows).find((name) => instruction.includes(name));
if (selected === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
const result = await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected, ...(result ?? {}) }));
