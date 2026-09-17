// Google Docs Tool conformance target. A scripted Tool test, not a model-driven agent.
// Node built-ins only: fetch against the Docs API v1 and Drive API v3-shaped routes, the canonical
// /v1/operations endpoint, and raw MCP JSON-RPC for the two published Google Docs MCP tool names.
//
// `firedrill tool test` requires every declared operation, every declared error, every event and every fault to be
// observed, so each flow below deliberately triggers its share of them. Expected values are derived from the starter
// data in firedrill/world.json (4 users, 9 documents, 17 shares, 8 comments, 4 replies, 12 revisions).
import assert from "node:assert/strict";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const invocation = JSON.parse(task);
const instruction = String(invocation.instruction ?? "");
const selected = /`([a-z-]+)`/.exec(instruction)?.[1];

const HTTP = process.env.FIREDRILL_HTTP_URL;
const HTTP_TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
const MCP = process.env.FIREDRILL_MCP_URL;
const MCP_TOKEN = process.env.FIREDRILL_MCP_TOKEN;
assert.ok(HTTP && HTTP_TOKEN && MCP && MCP_TOKEN, "HTTP and MCP bindings are required");

const V1 = `${HTTP}/v1`;
const V3 = `${HTTP}/drive/v3`;

const DANA = "dana.reyes@example.test";
const MIGUEL = "miguel.santos@example.test";
const PRIYA = "priya.natarajan@example.test";
const NOW = "2026-09-14T09:00:00.000Z";
const DOC_MIME = "application/vnd.google-apps.document";

const D = (digit) => `1st${"0".repeat(40)}${digit}`;
const GENERATED = (digit) => `1fd${"0".repeat(40)}${digit}`;
const C = (digit) => `AAAS${"0".repeat(15)}${digit}`;
const REPLY = (digit) => `AAAR${"0".repeat(15)}${digit}`;
const LAUNCH = D(1);
const SYNC = D(2);
const PRICING = D(3);
const ESCALATION = D(5);
const OFFSITE = D(6);
const EMPTY_DOC = D(7);
const RELEASE = D(8);
const ROADMAP = D(9);
const MISSING = `1zz${"0".repeat(40)}9`;

// ---------------------------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------------------------

async function raw(method, url, { body, headers = {}, contentType } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${HTTP_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": contentType ?? "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

async function call(method, url, { status = 200, body, headers, contentType } = {}) {
  const result = await raw(method, url, { body, headers, contentType });
  assert.equal(result.status, status, `${method} ${url} -> ${result.status} ${result.text.slice(0, 500)}`);
  const type = result.headers.get("content-type") ?? "";
  const json = type.includes("application/json") && result.text.length > 0 ? JSON.parse(result.text) : undefined;
  return { json, text: result.text, headers: result.headers, status: result.status };
}

/** Drive REST call relative to /drive/v3. */
const drive = (method, path, options) => call(method, `${V3}${path}`, options);
/** Docs REST call relative to /v1. */
const docs = (method, path, options) => call(method, `${V1}${path}`, options);

/** Expects the Drive classic error envelope with the given HTTP status and `reason`. */
async function driveError(method, path, status, reason, options = {}) {
  const result = await drive(method, path, { ...options, status });
  assert.ok(result.json?.error?.errors, `expected a Drive error envelope for ${method} ${path}: ${result.text.slice(0, 300)}`);
  assert.equal(result.json.error.code, status);
  assert.equal(result.json.error.errors[0].reason, reason, result.text);
  return result.json.error;
}

/** Expects the Docs google.rpc error envelope with the given HTTP status and `status` string. */
async function docsError(method, path, status, statusName, options = {}) {
  const result = await docs(method, path, { ...options, status });
  assert.ok(result.json?.error, `expected a Docs error envelope for ${method} ${path}: ${result.text.slice(0, 300)}`);
  assert.equal(result.json.error.code, status);
  assert.equal(result.json.error.status, statusName, result.text);
  return result.json.error;
}

async function op(operationId, args, expected = "ok") {
  const response = await fetch(`${HTTP}/v1/operations/google-docs/${operationId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  });
  const json = await response.json();
  assert.ok(json.outcome, `canonical ${operationId}: ${JSON.stringify(json).slice(0, 400)}`);
  if (expected === "ok") {
    assert.equal(json.outcome.status, "ok", `${operationId}: ${JSON.stringify(json.outcome).slice(0, 400)}`);
    return json.outcome.value;
  }
  assert.equal(json.outcome.status, "tool_error", `${operationId}: ${JSON.stringify(json.outcome).slice(0, 400)}`);
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
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim()))
    : [JSON.parse(text)];
  const reply = messages.find((message) => message.id === rpcId);
  assert.ok(reply, `MCP ${method}: no JSON-RPC reply`);
  if (reply.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

const mcpReady = { done: false };
async function mcpInit() {
  if (mcpReady.done) return;
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "google-docs-conformance", version: "0.1.0" } });
  mcpReady.done = true;
}

async function mcp(name, args) {
  await mcpInit();
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(!result.isError, `${name} ${JSON.stringify(args)}: ${JSON.stringify(result).slice(0, 600)}`);
  const structured = result.structuredContent ?? {};
  return structured.result ?? structured;
}

const query = (params) => new URLSearchParams(params).toString();
const listFiles = async (params) => (await drive("GET", `/files?${query(params)}`)).json;
const names = (files) => files.map((file) => file.name).sort();
const ids = (items) => items.map((item) => item.id);
const countMatching = async (q) => (await listFiles({ q })).files.length;
const batchPath = (documentId) => `/documents/${documentId}:batchUpdate`;
const batch = (documentId, requests, writeControl) =>
  docs("POST", batchPath(documentId), { body: writeControl === undefined ? { requests } : { requests, writeControl } });
const batchFails = (documentId, requests, status, statusName, writeControl) =>
  docsError("POST", batchPath(documentId), status, statusName, {
    body: writeControl === undefined ? { requests } : { requests, writeControl },
  });
const readDocument = async (documentId) => (await docs("GET", `/documents/${documentId}`)).json;
const textOf = async (documentId) => (await op("documents.get", { documentId })).content;

const insertText = (index, text) => ({ insertText: { text, location: { index } } });
const appendText = (text) => ({ insertText: { text, endOfSegmentLocation: {} } });

// ---------------------------------------------------------------------------------------------
// Flow: read-and-search
// ---------------------------------------------------------------------------------------------

async function readAndSearch() {
  const about = (await drive("GET", "/about")).json;
  assert.equal(about.kind, "drive#about");
  assert.equal(about.user.emailAddress, DANA);
  assert.equal(about.user.me, true);
  assert.equal(about.user.displayName, "Dana Reyes");
  assert.deepEqual(about.exportFormats[DOC_MIME], ["text/plain", "text/markdown", "text/html"]);
  assert.equal(about.canCreateDrives, false);
  assert.ok(!("serverTime" in about), "the REST About resource carries no serverTime");
  assert.ok(!("limits" in about), "the REST About resource carries no limits block");
  const canonicalAbout = await op("about.get", {});
  assert.equal(canonicalAbout.serverTime, NOW, "the canonical read exposes the world's virtual now");
  assert.equal(canonicalAbout.limits.maxDocuments, 200);
  assert.deepEqual(Object.keys((await drive("GET", "/about?fields=user,storageQuota")).json).sort(), [
    "kind",
    "storageQuota",
    "user",
  ]);
  await driveError("GET", "/about?fields=nope", 400, "invalidParameter");

  // files.list: the documented `q` grammar -------------------------------------------------------
  const everything = await listFiles({});
  assert.equal(everything.kind, "drive#fileList");
  assert.equal(everything.incompleteSearch, false);
  assert.equal(everything.files.length, 8, "everything Dana can see, the trashed agenda included");
  assert.ok(!ids(everything.files).includes(ROADMAP), "Sam's unshared document stays invisible");
  assert.ok(ids(everything.files).includes(OFFSITE), "a trashed document is listed when no trashed filter is given");
  assert.equal(everything.files[0].mimeType, DOC_MIME);
  assert.ok(!("permissions" in everything.files[0]), "a list response carries no permission rows");
  assert.equal(await countMatching("trashed = false"), 7);
  assert.equal(await countMatching("trashed = true"), 1);
  assert.equal(await countMatching("name contains 'Q4'"), 1);
  assert.equal(await countMatching("name contains '4 launch'"), 0, "name contains matches word prefixes only");
  assert.equal(await countMatching("fullText contains 'binding constraint'"), 1);
  assert.equal(await countMatching(`'${MIGUEL}' in writers`), 2, "Miguel writes the launch plan and owns the rubric");
  assert.equal(await countMatching(`'${DANA}' in owners`), 6);
  assert.equal(await countMatching("starred = true"), 2);
  assert.equal(await countMatching("sharedWithMe = true"), 2);
  assert.equal(await countMatching("modifiedTime > '2026-09-10'"), 3);
  assert.equal(await countMatching("not starred = true and trashed = false"), 5);
  assert.equal(await countMatching("name contains 'zzz'"), 0, "an empty result is an empty page, not an error");
  assert.deepEqual(names((await listFiles({ q: `mimeType = '${DOC_MIME}' and starred = true` })).files), [
    "Pricing update - DRAFT",
    "Q4 launch plan",
  ]);
  assert.equal(await countMatching("mimeType = 'application/pdf'"), 0, "a non-Docs mimeType simply matches nothing");

  // Pagination ----------------------------------------------------------------------------------
  const first = await listFiles({ pageSize: "2", orderBy: "name" });
  assert.equal(first.files.length, 2);
  assert.ok(first.nextPageToken, "a second page is offered");
  const second = await listFiles({ pageSize: "2", orderBy: "name", pageToken: first.nextPageToken });
  assert.equal(second.files.length, 2);
  const third = await listFiles({ pageSize: "2", orderBy: "name", pageToken: second.nextPageToken });
  assert.equal(third.files.length, 2);
  const seen = [...first.files, ...second.files, ...third.files].map((file) => file.id);
  assert.equal(new Set(seen).size, 6, "pages do not overlap");
  assert.deepEqual(
    names([...first.files, ...second.files, ...third.files]),
    names([...first.files, ...second.files, ...third.files]).slice().sort(),
  );
  await driveError("GET", `/files?${query({ pageToken: "not-a-cursor" })}`, 400, "badRequest");

  // Rejected queries ------------------------------------------------------------------------------
  const parents = await driveError("GET", `/files?${query({ q: "'root' in parents" })}`, 400, "invalid");
  assert.ok(parents.message.includes("folders"), parents.message);
  await driveError("GET", `/files?${query({ q: "name ~ 'x'" })}`, 400, "invalid");
  // Malformed percent-encoding arrives as U+FFFD: the expression is corrupt, never a search for that character.
  for (const raw of ["name%20contains%20%27%E0%27", "name%20%3D%20%27%ZZ%E0%27", "fullText%20contains%20%27%C3%27"]) {
    const mangled = await driveError("GET", `/files?q=${raw}`, 400, "invalid");
    assert.equal(mangled.errors[0].location, "q", JSON.stringify(mangled));
    assert.equal(mangled.message, "Invalid Value");
  }

  // files.get --------------------------------------------------------------------------------------
  const launch = (await drive("GET", `/files/${LAUNCH}`)).json;
  assert.equal(launch.kind, "drive#file");
  assert.equal(launch.name, "Q4 launch plan");
  assert.equal(launch.ownedByMe, true);
  assert.equal(launch.shared, true);
  assert.equal(launch.starred, true);
  assert.equal(launch.capabilities.canEdit, true);
  assert.equal(launch.capabilities.canShare, true);
  assert.equal(launch.version, "3");
  assert.equal(launch.quotaBytesUsed, "0");
  assert.equal(launch.owners[0].emailAddress, DANA);
  assert.equal(launch.permissions.length, 2, "the owner sees the permission rows");
  await driveError("GET", `/files/${ROADMAP}`, 404, "notFound");
  await driveError("GET", `/files/${LAUNCH}?fields=bogus`, 400, "invalidParameter");

  // Nested `fields` sub-selections: parenthesised at any depth and slash paths; scalar sub-selections are rejected.
  const masked = (await drive("GET", `/files/${LAUNCH}?${query({ fields: "id,capabilities(canEdit,canShare),owners(emailAddress)" })}`)).json;
  assert.deepEqual(Object.keys(masked).sort(), ["capabilities", "id", "kind", "owners"]);
  assert.deepEqual(masked.capabilities, { canEdit: true, canShare: true }, "only the selected capabilities are returned");
  assert.deepEqual(masked.owners, [{ emailAddress: DANA }], "the sub-selection applies to every array item");
  assert.deepEqual((await drive("GET", `/files/${LAUNCH}?${query({ fields: "capabilities/canComment" })}`)).json, {
    kind: "drive#file",
    capabilities: { canComment: true },
  });
  assert.deepEqual(await listFiles({ q: "name contains 'Q4'", fields: "files(id,owners(displayName))" }), {
    kind: "drive#fileList",
    files: [{ id: LAUNCH, owners: [{ displayName: "Dana Reyes" }] }],
  });
  await driveError("GET", `/files/${LAUNCH}?${query({ fields: "name(first)" })}`, 400, "invalidParameter");
  await driveError("GET", `/files/${LAUNCH}?${query({ fields: "owners(bogus)" })}`, 400, "invalidParameter");

  // documents.get ------------------------------------------------------------------------------------
  const document = await readDocument(LAUNCH);
  assert.equal(document.documentId, LAUNCH);
  assert.equal(document.title, "Q4 launch plan");
  assert.equal(document.revisionId, "ALBJ4000000000000001");
  assert.ok(!("content" in document), "the REST Document carries no verbalized content field");
  const section = document.body.content[0];
  assert.equal(section.startIndex, 0);
  assert.equal(section.endIndex, 1);
  assert.ok(section.sectionBreak, "body.content[0] is the implicit section break");
  const title = document.body.content[1];
  assert.equal(title.paragraph.paragraphStyle.namedStyleType, "TITLE");
  assert.equal(title.paragraph.elements[0].textRun.content, "Q4 launch plan\n");
  assert.equal(title.startIndex, 1);
  assert.equal(title.endIndex, 1 + "Q4 launch plan\n".length);
  const table = document.body.content.find((element) => element.table !== undefined);
  assert.equal(table.table.rows, 3);
  assert.equal(table.table.columns, 3);
  assert.equal(table.table.tableRows[0].tableCells[0].content[0].paragraph.elements[0].textRun.content, "Milestone\n");
  assert.equal(Object.keys(document.namedRanges).length, 1);
  assert.equal(Object.keys(document.namedRanges)[0], "launch-summary");
  assert.deepEqual(document.inlineObjects, {});
  assert.deepEqual(document.headers, {});
  const launchAfterRead = (await drive("GET", `/files/${LAUNCH}`)).json;
  assert.equal(launchAfterRead.viewedByMeTime, launch.viewedByMeTime, "documents.get is a read: it does not mark the file as viewed");

  // UTF-16 index arithmetic over astral characters ------------------------------------------------
  const release = await readDocument(RELEASE);
  const emojiParagraph = release.body.content[2];
  const emojiRun = emojiParagraph.paragraph.elements.find((element) => element.textRun?.content === "🚀");
  assert.ok(emojiRun, "the rocket is its own run");
  assert.equal(emojiRun.endIndex - emojiRun.startIndex, 2, "an astral character counts two UTF-16 units");
  const cafe = emojiParagraph.paragraph.elements.at(-1).textRun;
  assert.ok(cafe.content.includes("café"), cafe.content);
  const lengths = release.body.content.map((element) => element.endIndex - element.startIndex);
  assert.equal(
    release.body.content.at(-1).endIndex,
    lengths.reduce((total, value) => total + value, 0),
    "the rendered indices are contiguous from 0",
  );
  const canonicalRelease = await op("documents.get", { documentId: RELEASE });
  assert.ok(canonicalRelease.content.includes("🚀"), "the canonical read returns the verbalized text");
  assert.equal(canonicalRelease.content.length, 197);

  await docsError("GET", `/documents/${ROADMAP}`, 404, "NOT_FOUND");
  const badMode = await docsError("GET", `/documents/${LAUNCH}?suggestionsViewMode=SUGGESTIONS_INLINE`, 400, "INVALID_ARGUMENT");
  assert.equal(badMode.details[0].fieldViolations[0].field, "suggestionsViewMode");
}

// ---------------------------------------------------------------------------------------------
// Flow: create-and-edit
// ---------------------------------------------------------------------------------------------

async function createAndEdit() {
  await docsError("POST", "/documents", 400, "INVALID_ARGUMENT", { body: { title: "" } });

  const created = (await docs("POST", "/documents", { body: { title: "Launch retrospective", body: { content: [] } } })).json;
  const id = created.documentId;
  assert.equal(id, GENERATED(1), "ids come from the counter row, not from randomness");
  assert.equal(created.title, "Launch retrospective");
  assert.equal(created.body.content.length, 2, "a new document is a section break and one empty paragraph");
  assert.equal(created.body.content[1].paragraph.elements[0].textRun.content, "\n");
  assert.ok(!("content" in created));

  // First batch: text, a heading, character styling and bullets, through Google's MCP tool name.
  const firstBatch = await mcp("update_doc", {
    documentId: id,
    requests: [
      appendText("What went well\nTrial flag shipped early\nDocs stayed in sync\n"),
      { updateParagraphStyle: { range: { startIndex: 1, endIndex: 15 }, paragraphStyle: { namedStyleType: "HEADING_1" }, fields: "namedStyleType" } },
      { updateTextStyle: { range: { startIndex: 1, endIndex: 15 }, textStyle: { bold: true }, fields: "bold" } },
      { createParagraphBullets: { range: { startIndex: 16, endIndex: 60 }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } },
    ],
  });
  assert.equal(firstBatch.documentId, id);
  assert.equal(firstBatch.replies.length, 4);
  assert.ok(firstBatch.writeControl.requiredRevisionId.startsWith("ALBJ4"));

  const afterFirst = await mcp("read_doc", { documentId: id });
  assert.ok(afterFirst.content.startsWith("What went well\n"), afterFirst.content);
  assert.equal(afterFirst.body.content[1].paragraph.paragraphStyle.namedStyleType, "HEADING_1");
  assert.equal(afterFirst.body.content[1].paragraph.elements[0].textRun.textStyle.bold, true);
  assert.ok(afterFirst.body.content[2].paragraph.bullet, "the second paragraph is bulleted");
  assert.equal(Object.keys(afterFirst.lists).length, 1);

  // Second batch over the wire: insert in the middle and check the index maths.
  const before = await readDocument(id);
  const marker = before.body.content[2];
  const second = (await batch(id, [insertText(marker.startIndex, "Also: ")])).json;
  assert.equal(second.replies.length, 1);
  const after = await readDocument(id);
  assert.equal(after.body.content[2].paragraph.elements[0].textRun.content, "Also: Trial flag shipped early\n");
  assert.equal(after.body.content[2].endIndex, marker.endIndex + 6);
  assert.notEqual(after.revisionId, before.revisionId, "every committed batch changes the revision id");

  const file = (await drive("GET", `/files/${id}`)).json;
  assert.equal(file.name, "Launch retrospective");
  assert.equal(file.version, "3");
  assert.equal(file.modifiedByMe, true);
  assert.equal(file.size, String((await textOf(id)).length));

  // Exports ---------------------------------------------------------------------------------------
  const plain = await drive("GET", `/files/${id}/export?mimeType=text/plain`);
  assert.ok(plain.headers.get("content-type").startsWith("text/plain"), plain.headers.get("content-type"));
  assert.equal(plain.text, await textOf(id), "the plain export is exactly the verbalized text");
  const markdown = await drive("GET", `/files/${id}/export?mimeType=text/markdown`);
  assert.ok(markdown.text.startsWith("# **What went well**"), markdown.text.slice(0, 80));
  assert.ok(markdown.text.includes("- Also: Trial flag shipped early"), markdown.text);
  const html = await drive("GET", `/files/${id}/export?mimeType=text/html`);
  assert.ok(html.text.includes("<h1><b>What went well</b></h1>"), html.text.slice(0, 200));
  assert.ok(html.text.includes("<ul><li>Also: Trial flag shipped early</li>"), html.text);

  await driveError("GET", `/files/${id}/export`, 400, "invalid");
  await driveError("GET", `/files/${id}/export?mimeType=application/pdf`, 403, "fileNotExportable");
  await driveError("GET", `/files/${ROADMAP}/export?mimeType=text/plain`, 404, "notFound");
}

// ---------------------------------------------------------------------------------------------
// Flow: tables-and-ranges
// ---------------------------------------------------------------------------------------------

async function tablesAndRanges() {
  const id = EMPTY_DOC;
  const start = await readDocument(id);
  assert.equal(start.body.content.length, 2);
  assert.equal(start.body.content[1].endIndex, 2, "an empty document ends at index 2");

  await batch(id, [insertText(1, "Alpha\nBeta\nGamma\n")]);
  assert.equal(await textOf(id), "Alpha\nBeta\nGamma\n\n");

  // A table at the end of the body.
  await batch(id, [{ insertTable: { rows: 2, columns: 2, endOfSegmentLocation: {} } }]);
  let document = await readDocument(id);
  let table = document.body.content.find((element) => element.table !== undefined);
  assert.ok(table, "the table is a structural element of the body");
  assert.equal(table.table.rows, 2);
  assert.equal(table.table.columns, 2);
  assert.equal(table.endIndex - table.startIndex, 2 + 2 * (1 + 2 * (1 + 1)), "table = start + per row + per cell + content + newline");

  // Text into the first cell, then a row and a column.
  const firstCell = table.table.tableRows[0].tableCells[0];
  await batch(id, [insertText(firstCell.startIndex + 1, "Owner")]);
  document = await readDocument(id);
  table = document.body.content.find((element) => element.table !== undefined);
  assert.equal(table.table.tableRows[0].tableCells[0].content[0].paragraph.elements[0].textRun.content, "Owner\n");

  await batch(id, [
    { insertTableRow: { tableCellLocation: { tableStartLocation: { index: table.startIndex }, rowIndex: 0, columnIndex: 0 }, insertBelow: true } },
    { insertTableColumn: { tableCellLocation: { tableStartLocation: { index: table.startIndex }, rowIndex: 0, columnIndex: 1 }, insertRight: true } },
  ]);
  document = await readDocument(id);
  table = document.body.content.find((element) => element.table !== undefined);
  assert.equal(table.table.rows, 3);
  assert.equal(table.table.columns, 3);
  assert.equal(table.table.tableRows.length, 3);
  assert.equal(table.table.tableRows[0].tableCells.length, 3);
  assert.equal(table.table.tableRows[0].tableCells[0].content[0].paragraph.elements[0].textRun.content, "Owner\n");

  await batch(id, [
    { deleteTableColumn: { tableCellLocation: { tableStartLocation: { index: table.startIndex }, rowIndex: 0, columnIndex: 2 } } },
    { deleteTableRow: { tableCellLocation: { tableStartLocation: { index: table.startIndex }, rowIndex: 2, columnIndex: 0 } } },
  ]);
  document = await readDocument(id);
  table = document.body.content.find((element) => element.table !== undefined);
  assert.equal(table.table.rows, 2);
  assert.equal(table.table.columns, 2);

  // Named ranges follow later edits, and their content can be replaced.
  document = await readDocument(id);
  const beta = document.body.content[2];
  assert.equal(beta.paragraph.elements[0].textRun.content, "Beta\n");
  const namedReply = (await batch(id, [{ createNamedRange: { name: "beta-line", range: { startIndex: beta.startIndex, endIndex: beta.endIndex - 1 } } }])).json;
  const namedRangeId = namedReply.replies[0].createNamedRange.namedRangeId;
  assert.ok(namedRangeId.startsWith("kix."), namedRangeId);

  await batch(id, [insertText(1, "Zero\n")]);
  document = await readDocument(id);
  const shifted = document.namedRanges["beta-line"].namedRanges[0].ranges[0];
  assert.equal(shifted.startIndex, beta.startIndex + 5, "an insertion before a named range shifts it");

  await batch(id, [{ replaceNamedRangeContent: { namedRangeId, text: "Beta rewritten" } }]);
  assert.ok((await textOf(id)).includes("Beta rewritten"), await textOf(id));
  await batch(id, [{ deleteNamedRange: { namedRangeId } }]);
  document = await readDocument(id);
  assert.deepEqual(document.namedRanges, {});

  // A page break, bullets on and off, a global replace and a deletion that merges paragraphs.
  document = await readDocument(id);
  const gamma = document.body.content.find((element) => element.paragraph?.elements?.[0]?.textRun?.content === "Gamma\n");
  await batch(id, [
    { insertPageBreak: { location: { index: gamma.startIndex } } },
    { createParagraphBullets: { range: { startIndex: gamma.startIndex + 1, endIndex: gamma.endIndex }, bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } },
  ]);
  document = await readDocument(id);
  const withBreak = document.body.content.find((element) => element.paragraph?.elements?.some((child) => child.pageBreak !== undefined));
  assert.ok(withBreak, "the page break is an element of its paragraph");
  assert.ok(withBreak.paragraph.bullet, "the paragraph is now numbered");

  await batch(id, [{ deleteParagraphBullets: { range: { startIndex: withBreak.startIndex, endIndex: withBreak.endIndex } } }]);
  document = await readDocument(id);
  assert.ok(!document.body.content.some((element) => element.paragraph?.bullet !== undefined), "no bulleted paragraph is left");

  const replaced = (await batch(id, [{ replaceAllText: { containsText: { text: "Beta rewritten", matchCase: true }, replaceText: "Beta final" } }])).json;
  assert.equal(replaced.replies[0].replaceAllText.occurrencesChanged, 1);
  assert.ok((await textOf(id)).includes("Beta final"));

  document = await readDocument(id);
  const zero = document.body.content[1];
  assert.equal(zero.paragraph.elements[0].textRun.content, "Zero\n");
  await batch(id, [{ deleteContentRange: { range: { startIndex: zero.startIndex, endIndex: zero.endIndex } } }]);
  const text = await textOf(id);
  assert.ok(!text.startsWith("Zero"), text);
  assert.ok(text.startsWith("Alpha"), text);
}

// ---------------------------------------------------------------------------------------------
// Flow: invalid-requests
// ---------------------------------------------------------------------------------------------

async function invalidRequests() {
  const id = RELEASE;
  const before = await readDocument(id);
  const end = before.body.content.at(-1).endIndex;

  const cases = [
    [[{ insertFoo: { text: "x" } }], "requests[0].insertFoo"],
    [[], "requests"],
    [[insertText(0, "x")], "requests[0].insertText.location.index"],
    [[insertText(end + 50, "x")], "requests[0].insertText.location.index"],
    [[{ insertText: { text: "x" } }], "requests[0].insertText.location"],
    [[{ insertText: { text: "x", location: { index: 2 }, endOfSegmentLocation: {} } }], "requests[0].insertText.location"],
    [[{ insertText: { text: "x", location: { index: 2, segmentId: "header-1" } } }], "requests[0].insertText.location.segmentId"],
    [[{ insertText: { text: "line\rbreak", location: { index: 2 } } }], "requests[0].insertText.text"],
    [[{ deleteContentRange: { range: { startIndex: 10, endIndex: 4 } } }], "requests[0].deleteContentRange.range.startIndex"],
    [[{ deleteContentRange: { range: { startIndex: 1, endIndex: end } } }], "requests[0].deleteContentRange.range.endIndex"],
    [[{ replaceAllText: { containsText: { text: "a", searchByRegex: true }, replaceText: "b" } }], "requests[0].replaceAllText.containsText.searchByRegex"],
    [[{ updateTextStyle: { range: { startIndex: 1, endIndex: 5 }, textStyle: { bold: true }, fields: "bold,glow" } }], "requests[0].updateTextStyle.fields"],
    [[{ insertTableRow: { tableCellLocation: { tableStartLocation: { index: 3 }, rowIndex: 0, columnIndex: 0 } } }], "requests[0].insertTableRow.tableCellLocation.tableStartLocation.index"],
    [[{ insertInlineImage: { uri: "https://example.test/logo.png", location: { index: 2 } } }], "requests[0].insertInlineImage"],
    [[{ createNamedRange: { name: "", range: { startIndex: 1, endIndex: 5 } } }], "requests[0].createNamedRange.name"],
    [[{ deleteNamedRange: { namedRangeId: "kix.1", name: "both" } }], "requests[0].deleteNamedRange.namedRangeId"],
  ];
  for (const [requests, field] of cases) {
    const error = await batchFails(id, requests, 400, "INVALID_ARGUMENT");
    assert.equal(error.details[0].fieldViolations[0].field, field, `${JSON.stringify(requests).slice(0, 120)} -> ${JSON.stringify(error)}`);
  }

  // A batch whose first request is valid and whose second is not applies nothing.
  await batchFails(id, [appendText("Partial "), { insertFoo: {} }], 400, "INVALID_ARGUMENT");

  // Access failures on the same route, so the two other Docs envelopes are exercised too.
  await docsError("POST", `/documents/${MISSING}:batchUpdate`, 404, "NOT_FOUND", { body: { requests: [appendText("x")] } });
  await docsError("POST", `/documents/${id}`, 404, "NOT_FOUND", { body: { requests: [appendText("x")] } });

  const after = await readDocument(id);
  assert.deepEqual(after, before, "no rejected request changed the document");
  assert.equal(after.revisionId, "ALBJ4000000000000008");
}

// ---------------------------------------------------------------------------------------------
// Flow: write-control
// ---------------------------------------------------------------------------------------------

async function writeControl() {
  const read = await readDocument(LAUNCH);
  const stale = read.revisionId;

  const committed = (await batch(LAUNCH, [appendText("Miguel: sizing done.\n")])).json;
  assert.notEqual(committed.writeControl.requiredRevisionId, stale);

  const refused = await batchFails(LAUNCH, [appendText("Miguel: duplicate.\n")], 400, "FAILED_PRECONDITION", {
    requiredRevisionId: stale,
  });
  assert.ok(refused.message.includes(stale), refused.message);
  const unchanged = await readDocument(LAUNCH);
  assert.equal(unchanged.revisionId, committed.writeControl.requiredRevisionId, "the refused batch changed nothing");
  assert.ok(!(await textOf(LAUNCH)).includes("duplicate"));

  const retried = (await batch(LAUNCH, [appendText("Miguel: sizing reviewed.\n")], { requiredRevisionId: unchanged.revisionId })).json;
  assert.notEqual(retried.writeControl.requiredRevisionId, unchanged.revisionId);
  const text = await textOf(LAUNCH);
  assert.ok(text.includes("sizing done."), text.slice(-200));
  assert.ok(text.includes("sizing reviewed."), text.slice(-200));

  const file = (await drive("GET", `/files/${LAUNCH}`)).json;
  assert.equal(file.version, "5");
  assert.equal(file.lastModifyingUser.emailAddress, MIGUEL);
  const revisions = (await drive("GET", `/files/${LAUNCH}/revisions`)).json;
  assert.equal(revisions.revisions.length, 5);
  assert.equal(revisions.revisions.at(-1).lastModifyingUser.emailAddress, MIGUEL);

  // Route fuzz retrofit: JSON bodies nested past 512 levels are refused 400 by the codec, before argument validation.
  const deepObject = (depth) => `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
  const deepArray = (depth) => `${"[".repeat(depth)}1${"]".repeat(depth)}`;
  for (const depth of [600, 2950, 2998, 3080, 3155]) {
    const nestedUnder = (key, inner) => `{${JSON.stringify(key)}:${inner}}`;
    const probes = [
      ["POST", `${V1}/documents`, nestedUnder("title", deepArray(depth))],
      ["POST", `${V1}/documents/${RELEASE}:batchUpdate`, nestedUnder("writeControl", deepArray(depth))],
      ["POST", `${V3}/files/${LAUNCH}/comments`, nestedUnder("quotedFileContent", deepObject(depth))],
      ["POST", `${V3}/files/${LAUNCH}/comments`, nestedUnder("quotedFileContent", deepArray(depth))],
      ["POST", `${V3}/files/${LAUNCH}/comments/${C(1)}/replies`, nestedUnder("content", deepArray(depth))],
      ["PATCH", `${V3}/files/${LAUNCH}/comments/${C(1)}`, nestedUnder("content", deepArray(depth))],
      ["PATCH", `${V3}/files/${EMPTY_DOC}`, nestedUnder("name", deepArray(depth))],
      ["POST", `${V3}/files/${EMPTY_DOC}/copy`, nestedUnder("name", deepArray(depth))],
      ["POST", `${V3}/files/${EMPTY_DOC}/permissions`, nestedUnder("role", deepArray(depth))],
      ["POST", `${V3}/files/${EMPTY_DOC}/permissions`, deepObject(depth)],
    ];
    for (const [method, url, body] of probes) {
      const result = await raw(method, url, { body });
      assert.equal(result.status, 400, `${method} ${url} nested ${depth} -> ${result.status} ${result.text.slice(0, 200)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Flow: permissions
// ---------------------------------------------------------------------------------------------

async function permissionsFlow() {
  const list = (await drive("GET", `/files/${LAUNCH}/permissions`)).json;
  assert.equal(list.kind, "drive#permissionList");
  assert.equal(list.permissions.length, 2);
  assert.equal(list.permissions[0].role, "owner", "the owner row comes first");
  assert.equal(list.permissions[0].emailAddress, DANA);
  assert.equal(list.permissions[1].emailAddress, MIGUEL);
  assert.equal(list.permissions[1].deleted, false);

  const paged = (await drive("GET", `/files/${LAUNCH}/permissions?pageSize=1`)).json;
  assert.equal(paged.permissions.length, 1);
  assert.ok(paged.nextPageToken);
  const secondPage = (await drive("GET", `/files/${LAUNCH}/permissions?pageSize=1&pageToken=${encodeURIComponent(paged.nextPageToken)}`)).json;
  assert.equal(secondPage.permissions[0].emailAddress, MIGUEL);
  await driveError("GET", `/files/${LAUNCH}/permissions?pageToken=nonsense`, 400, "badRequest");
  await driveError("GET", `/files/${LAUNCH}/permissions?pageSize=0`, 400, "invalidParameter");
  await driveError("GET", `/files/${ROADMAP}/permissions`, 404, "notFound");

  const shared = (await drive("POST", `/files/${EMPTY_DOC}/permissions`, { body: { role: "reader", type: "user", emailAddress: MIGUEL } })).json;
  assert.equal(shared.kind, "drive#permission");
  assert.equal(shared.role, "reader");
  assert.equal(shared.type, "user");
  const changed = (await drive("POST", `/files/${EMPTY_DOC}/permissions`, { body: { role: "writer", type: "user", emailAddress: MIGUEL } })).json;
  assert.equal(changed.id, shared.id, "a repeated grantee keeps its permission id and changes role");
  assert.equal(changed.role, "writer");
  const domain = (await drive("POST", `/files/${EMPTY_DOC}/permissions`, { body: { role: "reader", type: "domain", domain: "example.test", allowFileDiscovery: false } })).json;
  assert.equal(domain.type, "domain");
  assert.equal(domain.domain, "example.test");

  const afterShare = (await drive("GET", `/files/${EMPTY_DOC}/permissions`)).json;
  assert.equal(afterShare.permissions.length, 3);

  await driveError("POST", `/files/${EMPTY_DOC}/permissions`, 400, "invalidSharingRequest", { body: { role: "owner", type: "user", emailAddress: MIGUEL } });
  await driveError("POST", `/files/${EMPTY_DOC}/permissions`, 400, "invalid", { body: { role: "editor", type: "user", emailAddress: MIGUEL } });
  await driveError("POST", `/files/${EMPTY_DOC}/permissions`, 400, "invalidSharingRequest", { body: { role: "writer", type: "anyone" } });
  await driveError("POST", `/files/${ROADMAP}/permissions`, 404, "notFound", { body: { role: "reader", type: "user", emailAddress: MIGUEL } });

  await drive("DELETE", `/files/${EMPTY_DOC}/permissions/${domain.id}`, { status: 204 });
  assert.equal((await drive("GET", `/files/${EMPTY_DOC}/permissions`)).json.permissions.length, 2);
  await driveError("DELETE", `/files/${EMPTY_DOC}/permissions/${afterShare.permissions[0].id}`, 400, "badRequest");
  await driveError("DELETE", `/files/${EMPTY_DOC}/permissions/07000000000000009999`, 404, "notFound");

  // The grantee now sees the document as shared with them.
  const view = (await drive("GET", `/files/${EMPTY_DOC}`)).json;
  assert.equal(view.shared, true);
  assert.equal(view.permissionIds.length, 2);
}

// ---------------------------------------------------------------------------------------------
// Flow: comments
// ---------------------------------------------------------------------------------------------

async function commentsFlow() {
  const open = (await drive("GET", `/files/${SYNC}/comments`)).json;
  assert.equal(open.kind, "drive#commentList");
  assert.equal(open.comments.length, 5, "the deleted comment is hidden by default");
  assert.equal(open.comments[0].id, C(5), "the newest modification comes first");
  assert.equal(open.comments[0].author.emailAddress, DANA);
  assert.ok(open.comments.some((comment) => comment.resolved === true), "the resolved thread is still listed");
  const anchored = open.comments.find((comment) => comment.id === C(1));
  assert.ok(anchored.anchor.includes('"txt"'), anchored.anchor);
  assert.equal(anchored.quotedFileContent.value, "We will keep the trial length at fourteen days and revisit after launch.");
  assert.equal(anchored.htmlContent, anchored.content.replaceAll("'", "&#39;"));

  const withDeleted = (await drive("GET", `/files/${SYNC}/comments?includeDeleted=true`)).json;
  assert.equal(withDeleted.comments.length, 6);
  assert.ok(withDeleted.comments.some((comment) => comment.deleted === true && comment.content === ""));

  const page = (await drive("GET", `/files/${SYNC}/comments?pageSize=2`)).json;
  assert.equal(page.comments.length, 2);
  assert.ok(page.nextPageToken);
  const nextPage = (await drive("GET", `/files/${SYNC}/comments?pageSize=2&pageToken=${encodeURIComponent(page.nextPageToken)}`)).json;
  assert.equal(nextPage.comments.length, 2);
  assert.equal(new Set([...ids(page.comments), ...ids(nextPage.comments)]).size, 4);

  const recent = (await drive("GET", `/files/${SYNC}/comments?startModifiedTime=2026-09-11T11:00:00.000Z`)).json;
  assert.equal(recent.comments.length, 4);
  await driveError("GET", `/files/${SYNC}/comments?startModifiedTime=yesterday`, 400, "invalid");
  await driveError("GET", `/files/${SYNC}/comments?pageToken=nope`, 400, "badRequest");
  await driveError("GET", `/files/${ROADMAP}/comments`, 404, "notFound");

  assert.equal((await drive("GET", `/files/${SYNC}/comments/${C(1)}`)).json.id, C(1));
  await driveError("GET", `/files/${SYNC}/comments/${C(6)}`, 404, "notFound");
  assert.equal((await drive("GET", `/files/${SYNC}/comments/${C(6)}?includeDeleted=true`)).json.deleted, true);

  // Create, anchored to a range and unanchored.
  const document = await readDocument(LAUNCH);
  const owners = document.body.content[2];
  const created = await op("comments.create", {
    fileId: LAUNCH,
    content: "Is the status still in review?",
    range: { startIndex: owners.startIndex, endIndex: owners.endIndex - 1 },
  });
  assert.equal(created.kind, "drive#comment");
  assert.equal(created.quotedFileContent.value, "Owner: Dana Reyes. Status: in review with the pricing and support leads.");
  assert.ok(JSON.parse(created.anchor).a[0].txt.o === owners.startIndex, created.anchor);
  const plain = (await drive("POST", `/files/${LAUNCH}/comments`, { body: { content: "No anchor on this one." } })).json;
  assert.ok(!("anchor" in plain));

  await driveError("POST", `/files/${LAUNCH}/comments`, 400, "invalid", { body: { content: "   " } });
  await driveError("POST", `/files/${ROADMAP}/comments`, 404, "notFound", { body: { content: "hi" } });
  await driveError("POST", `/files/${ESCALATION}/comments`, 403, "insufficientFilePermissions", { body: { content: "A reader cannot comment." } });

  // Update and delete follow the author-only rule.
  const edited = (await drive("PATCH", `/files/${LAUNCH}/comments/${plain.id}`, { body: { content: "No anchor, edited." } })).json;
  assert.equal(edited.content, "No anchor, edited.");
  assert.equal(edited.modifiedTime, NOW, "the edit is stamped with the world's virtual now");
  await driveError("PATCH", `/files/${SYNC}/comments/${C(1)}`, 403, "insufficientFilePermissions", { body: { content: "Not mine to edit." } });
  await driveError("PATCH", `/files/${LAUNCH}/comments/${plain.id}`, 400, "invalid", { body: { content: "" } });
  await driveError("PATCH", `/files/${LAUNCH}/comments/${C(1)}`, 404, "notFound", { body: { content: "nope" } });

  await drive("DELETE", `/files/${LAUNCH}/comments/${plain.id}`, { status: 204 });
  const tombstone = (await drive("GET", `/files/${LAUNCH}/comments/${plain.id}?includeDeleted=true`)).json;
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.content, "");
  await driveError("DELETE", `/files/${LAUNCH}/comments/${C(2)}`, 404, "notFound");

  // Replies.
  const replies = (await drive("GET", `/files/${LAUNCH}/comments/${C(7)}/replies`)).json;
  assert.equal(replies.kind, "drive#replyList");
  assert.equal(replies.replies.length, 3);
  assert.equal(replies.replies[0].id, REPLY(2), "replies are listed oldest first");
  const firstReplies = (await drive("GET", `/files/${LAUNCH}/comments/${C(7)}/replies?pageSize=2`)).json;
  assert.equal(firstReplies.replies.length, 2);
  const restReplies = (await drive("GET", `/files/${LAUNCH}/comments/${C(7)}/replies?pageSize=2&pageToken=${encodeURIComponent(firstReplies.nextPageToken)}`)).json;
  assert.equal(restReplies.replies.length, 1);
  await driveError("GET", `/files/${LAUNCH}/comments/${C(7)}/replies?pageToken=bad`, 400, "badRequest");
  await driveError("GET", `/files/${LAUNCH}/comments/${C(7)}/replies?pageSize=0`, 400, "invalidParameter");
  await driveError("GET", `/files/${ROADMAP}/comments/${C(7)}/replies`, 404, "notFound");

  const answered = (await drive("POST", `/files/${SYNC}/comments/${C(1)}/replies`, { body: { content: "Making it configurable is on the list." } })).json;
  assert.equal(answered.kind, "drive#reply");
  const resolved = (await drive("POST", `/files/${SYNC}/comments/${C(1)}/replies`, { body: { action: "resolve" } })).json;
  assert.equal(resolved.action, "resolve");
  assert.equal((await drive("GET", `/files/${SYNC}/comments/${C(1)}`)).json.resolved, true);
  await driveError("POST", `/files/${SYNC}/comments/${C(1)}/replies`, 400, "badRequest", { body: { action: "resolve" } });
  const reopened = (await drive("POST", `/files/${SYNC}/comments/${C(1)}/replies`, { body: { action: "reopen" } })).json;
  assert.equal(reopened.action, "reopen");
  assert.equal((await drive("GET", `/files/${SYNC}/comments/${C(1)}`)).json.resolved, false);
  await driveError("POST", `/files/${SYNC}/comments/${C(1)}/replies`, 400, "invalid", { body: {} });
  await driveError("POST", `/files/${SYNC}/comments/${C(9)}/replies`, 404, "notFound", { body: { content: "no such thread" } });
  await driveError("POST", `/files/${ESCALATION}/comments/${C(8)}/replies`, 403, "insufficientFilePermissions", { body: { content: "A reader cannot reply." } });

  const thread = (await drive("GET", `/files/${SYNC}/comments/${C(1)}`)).json;
  assert.equal(thread.replies.length, 3);
}

// ---------------------------------------------------------------------------------------------
// Flow: file-lifecycle
// ---------------------------------------------------------------------------------------------

async function fileLifecycle() {
  // Viewing: reads never count as opening a file; files.update { viewedByMeTime } (what the app sends on open) does.
  const unopened = (await drive("GET", `/files/${EMPTY_DOC}`)).json;
  assert.equal(unopened.viewedByMe, false);
  assert.ok(!("viewedByMeTime" in unopened));
  await readDocument(EMPTY_DOC);
  await drive("GET", `/files/${EMPTY_DOC}/export?mimeType=text/plain`);
  assert.equal((await drive("GET", `/files/${EMPTY_DOC}`)).json.viewedByMe, false, "documents.get and files.export do not mark the file viewed");
  const opened = (await drive("PATCH", `/files/${EMPTY_DOC}`, { body: { viewedByMeTime: "2026-09-14T08:30:00Z" } })).json;
  assert.equal(opened.viewedByMe, true);
  assert.equal(opened.viewedByMeTime, "2026-09-14T08:30:00.000Z");
  assert.equal(opened.modifiedTime, unopened.modifiedTime, "viewing is per user and does not touch modifiedTime");
  assert.equal(opened.version, unopened.version);
  await driveError("PATCH", `/files/${EMPTY_DOC}`, 400, "invalid", { body: { viewedByMeTime: "yesterday" } });

  const renamed = (await drive("PATCH", `/files/${EMPTY_DOC}`, { body: { name: "Scratch pad" } })).json;
  assert.equal(renamed.name, "Scratch pad");
  assert.equal(renamed.version, "2");
  const described = (await drive("PATCH", `/files/${EMPTY_DOC}`, { body: { description: "Somewhere to draft." } })).json;
  assert.equal(described.description, "Somewhere to draft.");

  const beforeStar = (await drive("GET", `/files/${RELEASE}`)).json;
  const starred = (await drive("PATCH", `/files/${RELEASE}`, { body: { starred: true } })).json;
  assert.equal(starred.starred, true);
  assert.equal(starred.modifiedTime, beforeStar.modifiedTime, "starring is per user and does not touch modifiedTime");
  assert.equal(starred.version, beforeStar.version);

  const trashed = (await drive("PATCH", `/files/${RELEASE}`, { body: { trashed: true } })).json;
  assert.equal(trashed.trashed, true);
  assert.equal(trashed.explicitlyTrashed, true);
  assert.ok(trashed.trashedTime);
  assert.equal(trashed.capabilities.canEdit, false, "a trashed document cannot be edited");
  assert.equal((await listFiles({ q: "trashed = true" })).files.length, 2);
  const restored = (await drive("PATCH", `/files/${RELEASE}`, { body: { trashed: false } })).json;
  assert.equal(restored.trashed, false);
  assert.ok(!("trashedTime" in restored));

  await driveError("PATCH", `/files/${EMPTY_DOC}`, 400, "invalid", { body: {} });
  await driveError("PATCH", `/files/${ROADMAP}`, 404, "notFound", { body: { name: "Not mine" } });

  // Read-only fields in the body: Drive answers 403 fieldNotWritable before any other validation, and nothing changes.
  const beforeUnwritable = (await drive("GET", `/files/${EMPTY_DOC}?fields=name,version`)).json;
  const notWritable = await driveError("PATCH", `/files/${EMPTY_DOC}`, 403, "fieldNotWritable", { body: { id: "x", name: "Renamed?" } });
  assert.equal(notWritable.message, "The resource body includes fields which are not directly writable.");
  assert.ok(!notWritable.message.includes("Renamed?"), "no caller text is echoed");
  await driveError("PATCH", `/files/${EMPTY_DOC}`, 403, "fieldNotWritable", { body: { mimeType: "text/plain", owners: [] } });
  await driveError("PATCH", `/files/${ROADMAP}`, 403, "fieldNotWritable", { body: { id: "x" } }); // before the file lookup, as Drive
  assert.deepEqual((await drive("GET", `/files/${EMPTY_DOC}?fields=name,version`)).json, beforeUnwritable, "a refused patch changes nothing");
  const canonicalUnwritable = await op("files.update", { fileId: EMPTY_DOC, name: "x", unwritableFields: ["id"] }, "PERMISSION_DENIED");
  assert.equal(canonicalUnwritable.details.reason, "fieldNotWritable");

  // Wrong-typed query values reach the handler and answer Drive's 400 invalid on the parameter, not a framework envelope.
  const badInteger = await driveError("GET", `/files?pageSize=abc`, 400, "invalid");
  assert.equal(badInteger.errors[0].location, "pageSize");
  assert.equal(badInteger.errors[0].locationType, "parameter");
  assert.equal(badInteger.message, "Invalid value 'abc'. Values must match the following regular expression: '^-?[0-9]+$'");
  const badBoolean = await driveError("GET", `/files/${EMPTY_DOC}?supportsAllDrives=maybe`, 400, "invalid");
  assert.equal(badBoolean.errors[0].location, "supportsAllDrives");
  assert.equal(badBoolean.message, "Invalid boolean value: 'maybe'.");
  const longValue = `z${"9".repeat(300)}`;
  const clipped = await driveError("GET", `/files/${EMPTY_DOC}/revisions?pageSize=${longValue}`, 400, "invalid");
  assert.ok(clipped.message.includes(longValue.slice(0, 64)) && !clipped.message.includes(longValue.slice(0, 65)), "value clipped to 64");
  assert.equal((await driveError("GET", `/files/${LAUNCH}/permissions?pageSize=1e2`, 400, "invalid")).errors[0].location, "pageSize");
  assert.equal((await driveError("GET", `/files/${LAUNCH}/comments?includeDeleted=1`, 400, "invalid")).errors[0].location, "includeDeleted");
  assert.equal((await driveError("GET", `/files/${LAUNCH}/comments/${C(1)}?includeDeleted=yes`, 400, "invalid")).errors[0].location, "includeDeleted");
  assert.equal((await driveError("GET", `/files/${LAUNCH}/comments/${C(1)}/replies?pageSize=x`, 400, "invalid")).errors[0].location, "pageSize");
  assert.equal(
    (await driveError("POST", `/files/${EMPTY_DOC}/permissions?transferOwnership=nope`, 400, "invalid", { body: { role: "reader", type: "user", emailAddress: MIGUEL } })).errors[0].location,
    "transferOwnership",
  );
  const docsBoolean = await docsError("GET", `/documents/${EMPTY_DOC}?includeTabsContent=yes`, 400, "INVALID_ARGUMENT");
  assert.equal(docsBoolean.message, `Invalid value at 'include_tabs_content' (TYPE_BOOL), "yes"`);
  assert.equal(docsBoolean.details[0].fieldViolations[0].field, "includeTabsContent");
  const canonicalInvalid = await op("files.list", { invalidParameter: { name: "pageSize", value: "abc", kind: "integer" } }, "INVALID_ARGUMENT");
  assert.equal(canonicalInvalid.details.location, "pageSize");
  // Well-typed values still work exactly as before.
  assert.equal((await drive("GET", `/files/${EMPTY_DOC}?supportsAllDrives=true&fields=id`)).json.id, EMPTY_DOC);

  // Copy: body only, no comments and its own revision 1.
  const copy = (await drive("POST", `/files/${EMPTY_DOC}/copy`, { body: { name: "Scratch pad (copy)" } })).json;
  assert.equal(copy.name, "Scratch pad (copy)");
  assert.equal(copy.id, `1fd${"0".repeat(40)}1`);
  assert.equal(copy.ownedByMe, true);
  assert.equal(copy.version, "1");
  assert.equal((await drive("GET", `/files/${copy.id}/comments`)).json.comments.length, 0);
  assert.equal((await drive("GET", `/files/${copy.id}/revisions`)).json.revisions.length, 1);
  assert.equal(await textOf(copy.id), await textOf(EMPTY_DOC));

  await driveError("POST", `/files/${OFFSITE}/copy`, 400, "badRequest", { body: {} });
  await driveError("POST", `/files/${ROADMAP}/copy`, 404, "notFound", { body: {} });
  await driveError("POST", `/files/${EMPTY_DOC}/copy`, 400, "invalid", { body: { name: "x".repeat(600) } });

  // Revisions.
  const revisions = (await drive("GET", `/files/${LAUNCH}/revisions`)).json;
  assert.equal(revisions.kind, "drive#revisionList");
  assert.equal(revisions.revisions.length, 3);
  assert.equal(revisions.revisions[0].id, "1", "revisions are listed oldest first");
  assert.ok(!("requestTypes" in revisions.revisions[0]), "the REST Revision carries no Docs-side extras");
  const firstRevisions = (await drive("GET", `/files/${LAUNCH}/revisions?pageSize=2`)).json;
  assert.equal(firstRevisions.revisions.length, 2);
  await driveError("GET", `/files/${LAUNCH}/revisions?pageToken=bad`, 400, "badRequest");
  await driveError("GET", `/files/${LAUNCH}/revisions?pageSize=0`, 400, "invalidParameter");
  await driveError("GET", `/files/${ROADMAP}/revisions`, 404, "notFound");

  const revision = (await drive("GET", `/files/${LAUNCH}/revisions/3`)).json;
  assert.equal(revision.kind, "drive#revision");
  assert.equal(revision.mimeType, "application/vnd.google-apps.document");
  assert.equal(revision.keepForever, false);
  const canonicalRevision = await op("revisions.get", { fileId: LAUNCH, revisionId: "3" });
  assert.ok(Array.isArray(canonicalRevision.requestTypes), "the canonical read keeps the request kinds of that edit");
  await driveError("GET", `/files/${LAUNCH}/revisions/999`, 404, "notFound");
  await driveError("GET", `/files/${ROADMAP}/revisions/1`, 404, "notFound");

  // Permanent delete cascades over every row that belongs to the document.
  await drive("DELETE", `/files/${LAUNCH}`, { status: 204 });
  await driveError("GET", `/files/${LAUNCH}`, 404, "notFound");
  await driveError("GET", `/files/${LAUNCH}/comments`, 404, "notFound");
  await driveError("DELETE", `/files/${ROADMAP}`, 404, "notFound");
  assert.equal((await listFiles({})).files.length, 8, "the copy replaced the deleted document in the listing");
}

// ---------------------------------------------------------------------------------------------
// Flow: grant-denied (framework-level)
// ---------------------------------------------------------------------------------------------

async function grantDenied() {
  const listing = await listFiles({});
  assert.ok(listing.files.length >= 1, "the read grants still work");
  const document = await readDocument(SYNC);
  assert.equal(document.title, "Weekly product sync notes");

  for (const [method, path, body] of [
    ["POST", `/files/${SYNC}/comments`, { content: "no grant" }],
    ["PATCH", `/files/${SYNC}`, { name: "no grant" }],
    ["POST", `/files/${SYNC}/permissions`, { role: "reader", type: "user", emailAddress: MIGUEL }],
  ]) {
    const error = await driveError(method, path, 403, "insufficientPermissions", { body });
    assert.equal(error.message, "Insufficient Permission");
  }
  const docsDenied = await docsError("POST", `/documents/${SYNC}:batchUpdate`, 403, "PERMISSION_DENIED", {
    body: { requests: [appendText("no grant")] },
  });
  assert.ok(docsDenied.message.includes("scopes"), docsDenied.message);
}

// ---------------------------------------------------------------------------------------------
// Flow: role-denied (package-level)
// ---------------------------------------------------------------------------------------------

async function roleDenied() {
  const about = (await drive("GET", "/about")).json;
  assert.equal(about.user.emailAddress, PRIYA);

  await docsError("POST", `/documents/${SYNC}:batchUpdate`, 403, "PERMISSION_DENIED", { body: { requests: [appendText("commenter")] } });
  await driveError("PATCH", `/files/${SYNC}`, 403, "insufficientFilePermissions", { body: { name: "Renamed by a commenter" } });
  const trashDenied = await driveError("PATCH", `/files/${SYNC}`, 403, "insufficientFilePermissions", { body: { trashed: true } });
  assert.ok(trashDenied.message.includes("owner"), trashDenied.message);
  await driveError("DELETE", `/files/${SYNC}`, 403, "insufficientFilePermissions");
  await driveError("POST", `/files/${SYNC}/permissions`, 403, "insufficientFilePermissions", { body: { role: "reader", type: "user", emailAddress: MIGUEL } });
  await driveError("DELETE", `/files/${SYNC}/permissions/06000000000000000002`, 403, "insufficientFilePermissions");
  await driveError("DELETE", `/files/${SYNC}/comments/${C(1)}`, 403, "insufficientFilePermissions");
  await driveError("POST", `/files/${PRICING}/comments`, 403, "insufficientFilePermissions", { body: { content: "A link reader cannot comment." } });

  // What a commenter may still do.
  assert.equal((await drive("GET", `/files/${SYNC}`)).json.capabilities.canEdit, false);
  assert.equal((await drive("GET", `/files/${SYNC}/comments`)).json.comments.length, 5);
  assert.equal((await readDocument(SYNC)).title, "Weekly product sync notes");
}

// ---------------------------------------------------------------------------------------------
// Flow: fresh-identity
// ---------------------------------------------------------------------------------------------

async function freshIdentity() {
  const about = (await drive("GET", "/about")).json;
  assert.equal(about.user.emailAddress, DANA, "an actor with no attributes acts as the primary seeded user");
  assert.equal(about.user.me, true);

  const listing = await listFiles({});
  assert.equal(listing.files.length, 8, "the fresh actor sees a populated home, not an empty account");

  const document = await readDocument(LAUNCH);
  assert.equal(document.title, "Q4 launch plan");

  const created = (await docs("POST", "/documents", { body: { title: "First document" } })).json;
  const file = (await drive("GET", `/files/${created.documentId}`)).json;
  assert.equal(file.owners[0].emailAddress, DANA, "the document belongs to the seeded user, not to a stray account");
  await drive("DELETE", `/files/${created.documentId}`, { status: 204 });
}

// ---------------------------------------------------------------------------------------------
// Flow: rate-limited (scenario)
// ---------------------------------------------------------------------------------------------

async function rateLimited() {
  const quota = await docsError("POST", "/documents", 429, "RESOURCE_EXHAUSTED", { body: { title: "Blocked" } });
  assert.ok(quota.message.includes("Quota exceeded"), quota.message);
  await docsError("POST", `/documents/${LAUNCH}:batchUpdate`, 429, "RESOURCE_EXHAUSTED", { body: { requests: [appendText("blocked")] } });

  const limited = await raw("PATCH", `${V3}/files/${LAUNCH}`, { body: { name: "Blocked" } });
  assert.equal(limited.status, 403);
  assert.equal(JSON.parse(limited.text).error.errors[0].reason, "userRateLimitExceeded");
  assert.equal(limited.headers.get("retry-after"), "30");
  await driveError("POST", `/files/${LAUNCH}/copy`, 403, "userRateLimitExceeded", { body: {} });
  await driveError("DELETE", `/files/${LAUNCH}`, 403, "userRateLimitExceeded");
  await driveError("POST", `/files/${LAUNCH}/permissions`, 403, "userRateLimitExceeded", { body: { role: "reader", type: "user", emailAddress: PRIYA } });
  await driveError("POST", `/files/${LAUNCH}/comments`, 403, "userRateLimitExceeded", { body: { content: "blocked" } });
  await driveError("POST", `/files/${LAUNCH}/comments/${C(7)}/replies`, 403, "userRateLimitExceeded", { body: { content: "blocked" } });

  // Reads are unaffected and nothing was written.
  assert.equal((await listFiles({})).files.length, 8);
  assert.equal((await readDocument(LAUNCH)).revisionId, "ALBJ4000000000000001");
  assert.equal((await drive("GET", `/files/${LAUNCH}`)).json.name, "Q4 launch plan");
  assert.equal((await drive("GET", `/files/${LAUNCH}/comments`)).json.comments.length, 1);
}

// ---------------------------------------------------------------------------------------------
// Flow: backend-error (scenario)
// ---------------------------------------------------------------------------------------------

async function backendError() {
  const before = await op("files.get", { fileId: LAUNCH });
  const outage = await docsError("GET", `/documents/${LAUNCH}`, 500, "INTERNAL");
  assert.equal(outage.message, "Internal error encountered.");
  await docsError("POST", `/documents/${LAUNCH}:batchUpdate`, 500, "INTERNAL", { body: { requests: [appendText("lost")] } });
  await driveError("GET", "/files", 500, "backendError");
  await driveError("GET", `/files/${LAUNCH}/export?mimeType=text/plain`, 500, "backendError");

  // The write path failed before anything was written: the document is byte-identical.
  const after = await op("files.get", { fileId: LAUNCH });
  assert.deepEqual(after, before, "the outage left the document untouched");
  assert.equal((await drive("GET", `/files/${LAUNCH}/revisions`)).json.revisions.length, 3);
}

// ---------------------------------------------------------------------------------------------
// Flow: lost-update (scenario)
// ---------------------------------------------------------------------------------------------

async function lostUpdate() {
  const read = await readDocument(LAUNCH);
  const stale = read.revisionId;
  const startText = await textOf(LAUNCH);

  // The service answers 503 although the edit was committed.
  const first = await docsError("POST", `/documents/${LAUNCH}:batchUpdate`, 503, "UNAVAILABLE", { body: { requests: [appendText("Decision: ship on 17 November.\n")] } });
  assert.equal(first.message, "The service is currently unavailable.");
  const afterFirst = await readDocument(LAUNCH);
  assert.notEqual(afterFirst.revisionId, stale, "the edit was committed even though the caller saw 503");
  assert.equal((await drive("GET", `/files/${LAUNCH}/revisions`)).json.revisions.length, 4);

  // A blind retry writes it twice: that is the trap this fault exists to expose.
  await docsError("POST", `/documents/${LAUNCH}:batchUpdate`, 503, "UNAVAILABLE", { body: { requests: [appendText("Decision: ship on 17 November.\n")] } });
  const duplicated = await textOf(LAUNCH);
  const occurrences = duplicated.split("Decision: ship on 17 November.").length - 1;
  assert.equal(occurrences, 2, "the blind retry duplicated the text");
  assert.equal(duplicated.length, startText.length + 2 * "Decision: ship on 17 November.\n".length);

  // A retry that carries the revision it read is refused instead, which is the correct client behaviour.
  const refused = await docsError("POST", `/documents/${LAUNCH}:batchUpdate`, 400, "FAILED_PRECONDITION", {
    body: { requests: [appendText("Decision: ship on 17 November.\n")], writeControl: { requiredRevisionId: stale } },
  });
  assert.ok(refused.message.includes(stale), refused.message);
  assert.equal(await textOf(LAUNCH), duplicated, "the refused retry changed nothing");
  assert.equal((await drive("GET", `/files/${LAUNCH}/revisions`)).json.revisions.length, 5);
}

// ---------------------------------------------------------------------------------------------
// Flow: tight-limits (scenario)
// ---------------------------------------------------------------------------------------------

async function tightLimits() {
  const limits = (await op("about.get", {})).limits;
  assert.equal(limits.maxDocuments, 9);
  assert.equal(limits.maxRequestsPerBatch, 3);

  const documents = await docsError("POST", "/documents", 400, "FAILED_PRECONDITION", { body: { title: "One too many" } });
  assert.ok(documents.message.includes("9 documents"), documents.message);
  const copy = await driveError("POST", `/files/${EMPTY_DOC}/copy`, 400, "badRequest", { body: {} });
  assert.ok(copy.message.includes("9 documents"), copy.message);

  const comments = await driveError("POST", `/files/${SYNC}/comments`, 400, "badRequest", { body: { content: "One comment too many." } });
  assert.ok(comments.message.includes("6 comments"), comments.message);
  const replies = await driveError("POST", `/files/${LAUNCH}/comments/${C(7)}/replies`, 400, "badRequest", { body: { content: "One reply too many." } });
  assert.ok(replies.message.includes("3 replies"), replies.message);
  const permissions = await driveError("POST", `/files/${SYNC}/permissions`, 400, "badRequest", {
    body: { role: "reader", type: "user", emailAddress: "guest@example.com" },
  });
  assert.ok(permissions.message.includes("3 permissions"), permissions.message);

  const tooManyRequests = await docsError("POST", `/documents/${LAUNCH}:batchUpdate`, 400, "FAILED_PRECONDITION", {
    body: { requests: [appendText("a"), appendText("b"), appendText("c"), appendText("d")] },
  });
  assert.ok(tooManyRequests.message.includes("3 requests"), tooManyRequests.message);
  const tooLong = await docsError("POST", `/documents/${LAUNCH}:batchUpdate`, 400, "FAILED_PRECONDITION", {
    body: { requests: [appendText("x".repeat(200))] },
  });
  assert.ok(tooLong.message.includes("500 characters"), tooLong.message);

  // Nothing was truncated and point reads still work.
  assert.equal((await drive("GET", `/files/${LAUNCH}`)).json.version, "3");
  assert.equal((await drive("GET", `/files/${SYNC}/comments`)).json.comments.length, 5);
}

// ---------------------------------------------------------------------------------------------
// Flow: scan-bound (scenario)
// ---------------------------------------------------------------------------------------------

async function scanBound() {
  const about = await driveError("GET", "/about", 400, "badRequest");
  assert.ok(about.message.includes("bound of 8 rows"), about.message);
  const listing = await driveError("GET", "/files", 400, "badRequest");
  assert.ok(listing.message.includes("bound of 8 rows"), listing.message);

  // Point reads are never blocked and never truncated.
  assert.equal((await drive("GET", `/files/${LAUNCH}`)).json.name, "Q4 launch plan");
  assert.equal((await readDocument(LAUNCH)).title, "Q4 launch plan");
  assert.equal((await drive("GET", `/files/${SYNC}/comments`)).json.comments.length, 5);
  assert.equal((await drive("GET", `/files/${LAUNCH}/revisions`)).json.revisions.length, 3);
}

// ---------------------------------------------------------------------------------------------
// Flow: response-budget (scenario)
// ---------------------------------------------------------------------------------------------

async function pageAll(path, key) {
  const seen = [];
  let pageToken;
  let pages = 0;
  do {
    const separator = path.includes("?") ? "&" : "?";
    const page = (await drive("GET", `${path}${pageToken ? `${separator}pageToken=${encodeURIComponent(pageToken)}` : ""}`)).json;
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 65_536, `${path} page over the byte budget`);
    assert.ok(page[key].length > 0 || pageToken === undefined, `${path} returned an empty page with a token`);
    seen.push(...page[key].map((entry) => entry.id));
    pageToken = page.nextPageToken;
    pages += 1;
  } while (pageToken !== undefined);
  assert.equal(new Set(seen).size, seen.length, `${path} returned an entry twice`);
  return { ids: seen, pages };
}

async function responseBudget() {
  assert.equal((await op("about.get", {})).limits.maxResponseBytes, 65_536);

  // A body authored past the budget cannot be read in one response: declared error, not an oversized body.
  const tooBig = await docsError("GET", `/documents/${EMPTY_DOC}`, 400, "FAILED_PRECONDITION");
  assert.ok(tooBig.message.includes("65536 bytes"), tooBig.message);
  await driveError("GET", `/files/${EMPTY_DOC}/export?mimeType=text/html`, 403, "exportSizeLimitExceeded");
  const plain = await drive("GET", `/files/${EMPTY_DOC}/export?mimeType=text/plain`);
  assert.equal(plain.text.length, 12_001);

  // The batch that would push documents.get past the budget is refused and commits nothing; a small one still works.
  const before = await readDocument(PRICING);
  const refused = await docsError("POST", `/documents/${PRICING}:batchUpdate`, 400, "FAILED_PRECONDITION", {
    body: { requests: [appendText('"'.repeat(12_000))] },
  });
  assert.ok(refused.message.includes("65536 bytes"), refused.message);
  assert.equal((await readDocument(PRICING)).revisionId, before.revisionId);
  await docs("POST", `/documents/${PRICING}:batchUpdate`, { body: { requests: [appendText(" Budget check.")] } });
  assert.notEqual((await readDocument(PRICING)).revisionId, before.revisionId);

  // files.list pages end early by bytes with a real token; every document appears exactly once.
  const startingFiles = (await pageAll("/files?pageSize=100", "files")).ids.length;
  const description = "文".repeat(2048);
  for (let index = 0; index < 12; index += 1) {
    await drive("POST", `/files/${LAUNCH}/copy`, { body: { name: `Budget copy ${index + 1}`, description } });
  }
  const files = await pageAll("/files?pageSize=100", "files");
  assert.ok(files.pages >= 2, `files.list used ${files.pages} page(s)`);
  assert.equal(files.ids.length, startingFiles + 12);

  // Comment threads: two 4,096-character comments do not fit one page; a reply that would grow a thread past the
  // budget is refused; a single thread already over it answers the declared error rather than an oversized page.
  const big = '"'.repeat(4096);
  const first = (await drive("POST", `/files/${PRICING}/comments`, { body: { content: big } })).json;
  const second = (await drive("POST", `/files/${PRICING}/comments`, { body: { content: big } })).json;
  const comments = await pageAll(`/files/${PRICING}/comments?pageSize=20`, "comments");
  assert.ok(comments.pages >= 2, `comments.list used ${comments.pages} page(s)`);
  assert.ok(comments.ids.includes(first.id) && comments.ids.includes(second.id));
  const thread = await driveError("POST", `/files/${PRICING}/comments/${first.id}/replies`, 400, "badRequest", { body: { content: "Agreed." } });
  assert.ok(thread.message.includes("comment thread"), thread.message);
  const small = (await drive("POST", `/files/${PRICING}/comments`, { body: { content: "Short note." } })).json;
  await drive("POST", `/files/${PRICING}/comments/${small.id}/replies`, { body: { content: "Agreed." } });
  const oversized = await driveError("GET", `/files/${RELEASE}/comments`, 400, "badRequest");
  assert.ok(oversized.message.includes("single entry"), oversized.message);
  const whole = (await drive("GET", `/files/${RELEASE}/comments/AAAS0000000000000090`)).json;
  assert.equal(whole.replies.length, 2);
}

// ---------------------------------------------------------------------------------------------
// Flow: live-pagination — the next page survives the last returned entry being renamed or deleted
// ---------------------------------------------------------------------------------------------

/** Follows nextPageToken from `first`, running `mutate(page)` after each page; returns every id seen. */
async function pageWhileMutating(path, key, first, mutate) {
  const seen = [];
  let page = first;
  for (let guard = 0; guard < 100; guard += 1) {
    seen.push(...page[key].map((entry) => entry.id));
    await mutate(page);
    if (page.nextPageToken === undefined) return seen;
    const separator = path.includes("?") ? "&" : "?";
    page = (await drive("GET", `${path}${separator}pageToken=${encodeURIComponent(page.nextPageToken)}`)).json;
  }
  throw new Error(`${path} never ended`);
}

async function livePagination() {
  // Revisions and replies resume by their order too (ids never change): pages are disjoint and complete.
  const revisions = await pageAll(`/files/${LAUNCH}/revisions?pageSize=1`, "revisions");
  assert.deepEqual(revisions.ids, ["1", "2", "3"]);
  const replies = await pageAll(`/files/${LAUNCH}/comments/${C(7)}/replies?pageSize=1`, "replies");
  assert.ok(replies.ids.length >= 2 && replies.pages === replies.ids.length);

  // Renaming the last returned file re-sorts it to the end; the untouched files after it are still all returned.
  const byName = `/files?${query({ q: `'${DANA}' in owners`, orderBy: "name", pageSize: "2" })}`;
  const everyFile = ids((await drive("GET", `/files?${query({ q: `'${DANA}' in owners`, pageSize: "100" })}`)).json.files);
  assert.equal(everyFile.length, 6);
  let renamed = 0;
  const renamedSeen = await pageWhileMutating(byName, "files", (await drive("GET", byName)).json, async (page) => {
    if (renamed >= 2 || page.files.length === 0 || page.nextPageToken === undefined) return;
    const last = page.files[page.files.length - 1];
    await drive("PATCH", `/files/${last.id}`, { body: { name: `zz renamed ${renamed} ${last.name}` } });
    renamed += 1;
  });
  assert.equal(renamed, 2);
  assert.deepEqual([...new Set(renamedSeen)].sort(), [...everyFile].sort(), "no file is dropped when a returned file is renamed");

  // Hard-deleting the last returned file keeps the token valid.
  const owned = `/files?${query({ q: `'${DANA}' in owners`, orderBy: "name", pageSize: "2" })}`;
  const ownedAll = ids((await drive("GET", `/files?${query({ q: `'${DANA}' in owners`, pageSize: "100" })}`)).json.files);
  let deleted;
  const deletedSeen = await pageWhileMutating(owned, "files", (await drive("GET", owned)).json, async (page) => {
    if (deleted !== undefined || page.nextPageToken === undefined) return;
    deleted = page.files[page.files.length - 1].id;
    await drive("DELETE", `/files/${deleted}`, { status: 204 });
  });
  assert.ok(deleted);
  assert.deepEqual([...deletedSeen].sort(), [...ownedAll].sort(), "every owned file is listed once across the delete");

  // Comments: list a page, delete it, then fetch the next page.
  const doc = (await docs("POST", "/documents", { body: { title: "Paging under edits" } })).json;
  const created = [];
  for (let index = 0; index < 5; index += 1) {
    created.push((await drive("POST", `/files/${doc.documentId}/comments`, { body: { content: `Comment ${index}` } })).json.id);
  }
  const commentsPath = `/files/${doc.documentId}/comments?pageSize=2`;
  const commentSeen = await pageWhileMutating(commentsPath, "comments", (await drive("GET", commentsPath)).json, async (page) => {
    for (const comment of page.comments) await drive("DELETE", `/files/${doc.documentId}/comments/${comment.id}`, { status: 204 });
  });
  assert.deepEqual([...commentSeen].sort(), [...created].sort(), "deleting a page of comments does not end or break paging");
  assert.equal((await drive("GET", `/files/${doc.documentId}/comments`)).json.comments.length, 0);

  // Permissions: revoke the last returned grant before asking for the next page.
  for (const email of [MIGUEL, PRIYA]) {
    await drive("POST", `/files/${doc.documentId}/permissions`, { body: { role: "reader", type: "user", emailAddress: email } });
  }
  await drive("POST", `/files/${doc.documentId}/permissions`, { body: { role: "reader", type: "domain", domain: "example.test" } });
  const grantsPath = `/files/${doc.documentId}/permissions?pageSize=2`;
  const grantsBefore = ids((await drive("GET", `/files/${doc.documentId}/permissions`)).json.permissions);
  assert.equal(grantsBefore.length, 4);
  let revoked;
  const grantSeen = await pageWhileMutating(grantsPath, "permissions", (await drive("GET", grantsPath)).json, async (page) => {
    if (revoked !== undefined) return;
    revoked = page.permissions[page.permissions.length - 1].id;
    await drive("DELETE", `/files/${doc.documentId}/permissions/${revoked}`, { status: 204 });
  });
  assert.deepEqual([...grantSeen].sort(), [...grantsBefore].sort());

}

// ---------------------------------------------------------------------------------------------

const flows = {
  "read-and-search": readAndSearch,
  "create-and-edit": createAndEdit,
  "tables-and-ranges": tablesAndRanges,
  "invalid-requests": invalidRequests,
  "write-control": writeControl,
  "permissions-flow": permissionsFlow,
  "comments-flow": commentsFlow,
  "file-lifecycle": fileLifecycle,
  "grant-denied": grantDenied,
  "role-denied": roleDenied,
  "fresh-identity": freshIdentity,
  "rate-limited": rateLimited,
  "backend-error": backendError,
  "lost-update": lostUpdate,
  "tight-limits": tightLimits,
  "scan-bound": scanBound,
  "response-budget": responseBudget,
  "live-pagination": livePagination,
};

if (selected === undefined || flows[selected] === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
