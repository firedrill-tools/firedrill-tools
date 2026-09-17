// Google Drive Tool conformance target. A scripted Tool test, not a model-driven agent.
// Uses only Node built-ins: fetch against the Drive API v3-shaped routes, the canonical /v1/operations endpoint,
// and raw MCP JSON-RPC (Streamable HTTP) for Google's Drive MCP tool names.
//
// Coverage note: `firedrill tool test` requires every declared error of every operation to be observed, so this
// script deliberately triggers each of them. The row bounds (FAILED_PRECONDITION on whole-Drive reads and on
// bounded writes) are reached in the `over-bound` scenario, whose `meta.limits` row sits far below the starter data.
//
// Expected counts below are derived from the starter data (firedrill/world.json): Dana sees her 19 non-root items
// (F1-F19, F9 trashed) plus F21, F23, F24 (inherited via F23), F26 and F27-F29 (inherited via F26) = 26; Sam sees his
// 9 items (F21-F29) + F2 + F3-F6 (inherited) + F7, F13, F16 (direct) + F11 (anyone) + F12 (domain) = 19 non-trashed;
// Ravi sees F11, F12 and F25.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inflateRawSync, inflateSync } from "node:zlib";

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
const RAVI = "ravi.menon@example.test";
const PRIYA = "priya.natarajan@example.com";
const PID = { dana: "06000000000000000001", sam: "06000000000000000002", ravi: "06000000000000000003", priya: "05000000000000000001" };
const BASE32 = "0123456789abcdefghijklmnopqrstuv";
const F = (n) => `1st${"0".repeat(29)}${BASE32[n]}`;
const GENERATED = (n) => `1fd${"0".repeat(29)}${BASE32[n]}`;
const FOLDER = "application/vnd.google-apps.folder";
const DOC = "application/vnd.google-apps.document";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const V3 = `${HTTP}/drive/v3`;
const UPLOAD = `${HTTP}/upload/drive/v3`;
const NOW = "2026-09-14T09:00:00.000Z";
const BASELINE_FILES = 31;

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

/** Drive REST call; `path` is relative to /drive/v3 unless absolute. Asserts the HTTP status and parses JSON. */
async function rest(method, path, { status = 200, body, headers, contentType, absolute = false } = {}) {
  const url = absolute ? path : `${V3}${path}`;
  const result = await raw(method, url, { body, headers, contentType });
  assert.equal(result.status, status, `${method} ${url} -> ${result.status} ${result.text.slice(0, 500)}`);
  const type = result.headers.get("content-type") ?? "";
  const json = type.includes("application/json") && result.text.length > 0 ? JSON.parse(result.text) : undefined;
  return { json, text: result.text, headers: result.headers, status: result.status };
}

/** Expect the Drive error envelope with the given HTTP status and `reason`. */
async function restError(method, path, status, reason, options = {}) {
  const result = await rest(method, path, { ...options, status });
  assert.ok(result.json?.error?.errors, `expected a Drive error envelope for ${method} ${path}: ${result.text.slice(0, 300)}`);
  assert.equal(result.json.error.code, status);
  assert.equal(result.json.error.errors[0].reason, reason, result.text);
  return result;
}

async function op(operationId, args, expected = "ok") {
  const response = await fetch(`${HTTP}/v1/operations/google-drive/${operationId}`, {
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

async function mcpInit() {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "google-drive-conformance", version: "0.1.0" } });
}

async function mcp(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(!result.isError, `${name} ${JSON.stringify(args)}: ${JSON.stringify(result).slice(0, 600)}`);
  return result.structuredContent;
}

async function mcpError(name, args, code) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(result.isError, `${name} ${JSON.stringify(args)} unexpectedly succeeded: ${JSON.stringify(result).slice(0, 300)}`);
  const error = result.structuredContent?.error;
  assert.ok(error, `${name}: ${JSON.stringify(result).slice(0, 400)}`);
  if (code) assert.equal(error.code, code, JSON.stringify(error));
  return result.structuredContent;
}

const ids = (items) => items.map((item) => item.id);
const q = (params) => new URLSearchParams(params).toString();
const md5 = (input) => createHash("md5").update(input).digest("hex");
const list = async (params, expectedStatus = 200) => (await rest("GET", `/files?${q(params)}`, { status: expectedStatus })).json;
const count = async (query) => (await list({ q: query })).files.length;
const byteBody = async (path) => {
  const response = await fetch(`${V3}${path}`, { headers: { authorization: `Bearer ${HTTP_TOKEN}` } });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, bytes, contentType: response.headers.get("content-type") ?? "" };
};

// ---------------------------------------------------------------------------------------------
// Drill: rest-flow (owner = Dana, baseline)
// ---------------------------------------------------------------------------------------------

async function restFlow() {
  // About ------------------------------------------------------------------------------------
  const start = (await rest("GET", "/changes/startPageToken")).json;
  assert.equal(start.kind, "drive#startPageToken");
  assert.equal(start.startPageToken, "1");

  const about = (await rest("GET", "/about")).json;
  assert.equal(about.kind, "drive#about");
  assert.equal(about.user.emailAddress, DANA);
  assert.equal(about.user.me, true);
  assert.equal(about.user.displayName, "Dana Reyes");
  assert.equal(about.user.permissionId, PID.dana);
  assert.deepEqual(about.storageQuota, { usage: "21954", usageInDrive: "21954", usageInTrash: "252", limit: "16106127360" });
  assert.equal(about.folderColorPalette.length, 24);
  assert.equal(about.canCreateDrives, false);
  assert.ok(!("serverTime" in about), "the REST About resource carries no server time");
  assert.deepEqual(about.exportFormats[DOC], ["text/plain", "text/markdown", "text/html"]);
  assert.equal((await op("about.get", {})).serverTime, NOW, "the canonical read exposes the world's virtual now");
  assert.deepEqual(Object.keys((await rest("GET", "/about?fields=user,storageQuota")).json).sort(), ["kind", "storageQuota", "user"]);
  await restError("GET", "/about?fields=nope", 400, "invalidParameter");

  // files.list: the documented query grammar ---------------------------------------------------
  const everything = await list({});
  assert.equal(everything.kind, "drive#fileList");
  assert.equal(everything.incompleteSearch, false);
  assert.equal(everything.files.length, 26, "everything Dana can see, trashed included");
  assert.ok(ids(everything.files).includes(F(9)), "the trashed retro is listed without a trashed filter");
  assert.ok(!ids(everything.files).includes(F(22)) && !ids(everything.files).includes(F(25)), "Sam's private items stay invisible");
  assert.ok(!("title" in everything.files[0]) && !("parentId" in everything.files[0]), "MCP conveniences are stripped on REST");
  assert.equal(await count("trashed = false"), 25);
  assert.equal(await count("'root' in parents and trashed = false"), 10);
  assert.equal(await count(`'${F(2)}' in parents`), 4);
  assert.equal(await count(`'${F(14)}' in parents`), 0);
  assert.equal(await count("fullText contains 'observability'"), 1);
  assert.deepEqual(ids((await list({ q: "fullText contains 'observability'" })).files), [F(7)]);
  assert.equal(await count("name contains 'Meeting'"), 2);
  assert.equal(await count("name contains 'eeting'"), 0, "name contains matches word prefixes only");
  assert.equal(await count("name contains 'meeting notes 2026-09-12'"), 1);
  assert.deepEqual(ids((await list({ q: "starred = true" })).files), [F(10)]);
  assert.equal(await count("sharedWithMe = true"), 3);
  assert.equal(await count(`mimeType != '${FOLDER}' and trashed = false`), 19);
  assert.equal(await count(`mimeType = '${FOLDER}' and trashed = false`), 6);
  assert.equal(await count("modifiedTime > '2026-09-01'"), 15);
  assert.equal(await count("modifiedTime > '2026-09-01T00:00:00Z' and modifiedTime <= '2026-09-10T09:05:00.000Z'"), 8);
  assert.deepEqual(ids((await list({ q: "properties has { key='team' and value='platform' }" })).files), [F(7)]);
  assert.equal(await count("properties has { key='team' and value='design' }"), 0);
  assert.deepEqual(ids((await list({ q: "visibility = 'anyoneWithLink'" })).files), [F(11)]);
  assert.deepEqual(ids((await list({ q: "visibility = 'domainCanFind'" })).files), [F(12)]);
  assert.deepEqual(ids((await list({ q: `shortcutDetails.targetId = '${F(21)}'` })).files), [F(15)]);
  const samWrites = ids((await list({ q: `'${SAM}' in writers and trashed = false` })).files);
  for (const id of [F(2), F(3), F(13), F(21), F(24)]) assert.ok(samWrites.includes(id), `${id} is writable by Sam`);
  assert.ok(!samWrites.includes(F(7)) && !samWrites.includes(F(1)), "reader/none is not a writer");
  assert.equal(await count(`'${SAM}' in owners`), 7);
  assert.equal(await count(`'${RAVI}' in readers`), 2, "readers include domain and link access");
  assert.equal(await count("not trashed = true and (name contains 'Meeting' or name = 'logo.png')"), 3);
  assert.equal(await count("viewedByMeTime > '2026-09-12'"), 1);
  for (const bad of ["foo = 1", "name >= 'a'", "trashed = 'maybe'", "(name = 'a'", "mimeType contains 'x'", "'x' in parents and"]) {
    const error = await restError("GET", `/files?${q({ q: bad })}`, 400, "invalid");
    assert.equal(error.json.error.errors[0].location, "q");
  }
  await restError("GET", "/files?orderBy=size", 400, "invalid");
  await restError("GET", "/files?spaces=appDataFolder", 400, "invalid");
  await restError("GET", "/files?corpora=allDrives", 400, "invalid");
  await restError("GET", "/files?pageSize=1001", 400, "invalid");
  assert.equal((await rest("GET", "/files?pageSize=abc", { status: 400 })).status, 400, "framework mapping error");
  assert.equal((await rest("GET", "/files?driveId=x", { status: 400 })).status, 400, "shared drives are refused");

  // Ordering and pagination --------------------------------------------------------------------
  assert.deepEqual(ids((await list({ q: `'${F(26)}' in parents`, orderBy: "name_natural" })).files), [F(27), F(28), F(29)]);
  assert.deepEqual(ids((await list({ q: `'${F(26)}' in parents`, orderBy: "name_natural desc" })).files), [F(29), F(28), F(27)]);
  assert.deepEqual(ids((await list({ q: "'root' in parents and trashed = false", orderBy: "folder,name" })).files), [F(1), F(14), F(13), F(16), F(19), F(17), F(18), F(12), F(15), F(11)]);
  assert.deepEqual(ids((await list({ q: "'root' in parents and trashed = false", orderBy: "modifiedTime desc", pageSize: 3 })).files), [F(14), F(18), F(17)]);
  const page1 = await list({ q: `'${F(26)}' in parents`, pageSize: 2, orderBy: "name" });
  assert.equal(page1.files.length, 2);
  assert.ok(page1.nextPageToken, "a second page exists");
  const page2 = await list({ q: `'${F(26)}' in parents`, pageSize: 2, orderBy: "name", pageToken: page1.nextPageToken });
  assert.deepEqual(ids(page2.files), [F(29)]);
  assert.equal(page2.nextPageToken, undefined);
  await restError("GET", `/files?${q({ q: `'${F(26)}' in parents`, pageSize: 2, orderBy: "name", pageToken: `${page1.nextPageToken}x` })}`, 400, "badRequest");
  await restError("GET", `/files?${q({ q: "trashed = false", pageSize: 2, pageToken: page1.nextPageToken })}`, 400, "badRequest");
  const masked = (await rest("GET", `/files?${q({ q: "'root' in parents", fields: "files(id,name),nextPageToken" })}`)).json;
  assert.deepEqual(Object.keys(masked).sort(), ["files", "kind"]);
  assert.deepEqual(Object.keys(masked.files[0]).sort(), ["id", "name"]);
  await restError("GET", "/files?fields=files(id,bogus)", 400, "invalidParameter");

  // files.get ----------------------------------------------------------------------------------
  const notes = (await rest("GET", `/files/${F(3)}`)).json;
  assert.equal(notes.kind, "drive#file");
  assert.equal(notes.name, "Billing v2 - design notes");
  assert.equal(notes.version, "7");
  assert.equal(notes.size, "1341");
  assert.equal(notes.owners[0].emailAddress, DANA);
  assert.equal(notes.lastModifyingUser.emailAddress, SAM);
  assert.equal(notes.ownedByMe, true);
  assert.equal(notes.shared, true);
  assert.deepEqual(notes.parents, [F(2)]);
  assert.equal(notes.capabilities.canEdit, true);
  assert.equal(notes.capabilities.canShare, true);
  assert.equal(notes.capabilities.canDelete, true);
  assert.equal(notes.permissions.length, 2, "owner's view lists the direct rows");
  assert.deepEqual(notes.permissionIds, [PID.dana, PID.priya]);
  assert.ok(notes.exportLinks["text/plain"]);
  assert.ok(!("title" in notes) && !("owner" in notes) && !("contentSnippet" in notes));
  await restError("GET", `/files/${F(22)}`, 404, "notFound");
  await restError("GET", `/files/${F(25)}`, 404, "notFound");
  const planning = (await rest("GET", `/files/${F(21)}`)).json;
  assert.equal(planning.ownedByMe, false);
  assert.equal(planning.sharedWithMeTime, "2026-09-08T09:00:00.000Z");
  assert.equal(planning.sharingUser.emailAddress, SAM);
  assert.equal(planning.capabilities.canEdit, false);
  assert.equal(planning.capabilities.canCopy, true);
  assert.equal(planning.capabilities.canTrash, false);
  assert.ok(!("permissions" in planning), "non-owners do not see the permission list on the file");
  const shortcut = (await rest("GET", `/files/${F(15)}`)).json;
  assert.deepEqual(shortcut.shortcutDetails, { targetId: F(21), targetMimeType: DOC });
  const root = (await rest("GET", "/files/root")).json;
  assert.equal(root.id, F(0));
  assert.equal(root.name, "My Drive");
  assert.ok(!("parents" in root));
  assert.equal(root.capabilities.canShare, false);
  const pdfMeta = (await rest("GET", `/files/${F(6)}?fields=id,name,md5Checksum,size,fileExtension,webContentLink`)).json;
  assert.deepEqual(Object.keys(pdfMeta).sort(), ["fileExtension", "id", "kind", "md5Checksum", "name", "size", "webContentLink"]);
  assert.equal(pdfMeta.fileExtension, "pdf");
  const pdf = await byteBody(`/files/${F(6)}?alt=media`);
  assert.equal(pdf.status, 200);
  assert.ok(pdf.contentType.startsWith("application/pdf"), pdf.contentType);
  assert.equal(pdf.bytes.length, 3172);
  assert.equal(md5(pdf.bytes), pdfMeta.md5Checksum, "alt=media bytes match the advertised checksum");
  assert.equal(pdf.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  const roadmapMedia = await rest("GET", `/files/${F(7)}?alt=media`);
  assert.ok(roadmapMedia.headers.get("content-type").startsWith("text/markdown"));
  assert.ok(roadmapMedia.text.includes("Observability"));
  assert.equal((await rest("GET", `/files/${F(6)}`)).json.viewedByMe, true, "a media read records a view");
  await restError("GET", `/files/${F(3)}?alt=media`, 403, "fileNotExportable");
  await restError("GET", `/files/${F(1)}?alt=media`, 403, "fileNotExportable");
  await restError("GET", `/files/${F(3)}?alt=xml`, 400, "invalid");
  await restError("GET", `/files/${F(3)}?fields=nope`, 400, "invalidParameter");

  // files.export ---------------------------------------------------------------------------------
  const plain = await rest("GET", `/files/${F(3)}/export?mimeType=text/plain`);
  assert.ok(plain.headers.get("content-type").startsWith("text/plain"));
  assert.ok(plain.text.startsWith("Billing v2 - design notes"));
  assert.equal((await rest("GET", `/files/${F(3)}/export?mimeType=text/markdown`)).text, plain.text);
  assert.ok((await rest("GET", `/files/${F(3)}/export?mimeType=text/html`)).text.includes("<pre>"));
  const csv = await rest("GET", `/files/${F(4)}/export?mimeType=text/csv`);
  assert.ok(csv.text.startsWith("account,plan,cadence"));
  assert.ok((await rest("GET", `/files/${F(4)}/export?mimeType=text/tab-separated-values`)).text.startsWith("account\tplan\tcadence"));
  assert.ok((await rest("GET", `/files/${F(5)}/export?mimeType=text/plain`)).text.includes("Slide 1"));
  await restError("GET", `/files/${F(3)}/export?mimeType=application/pdf`, 400, "badRequest");
  await restError("GET", `/files/${F(3)}/export`, 400, "required");
  await restError("GET", `/files/${F(6)}/export?mimeType=text/plain`, 403, "fileNotExportable");
  await restError("GET", `/files/${F(1)}/export?mimeType=text/plain`, 403, "fileNotExportable");
  await restError("GET", `/files/${GENERATED(31)}/export?mimeType=text/plain`, 404, "notFound");

  // files.create -----------------------------------------------------------------------------------
  const clientWork = (await rest("POST", "/files", { body: { name: "Client work", mimeType: FOLDER, parents: [F(1)], folderColorRgb: "#16A765" } })).json;
  assert.ok(clientWork.id.startsWith("1fd"));
  assert.equal(clientWork.mimeType, FOLDER);
  assert.deepEqual(clientWork.parents, [F(1)]);
  assert.equal(clientWork.folderColorRgb, "#16a765");
  assert.equal(clientWork.createdTime, NOW);
  assert.equal(clientWork.capabilities.canAddChildren, true);
  const notesDoc = (await rest("POST", "/files", { body: { name: "Notes", mimeType: DOC } })).json;
  assert.deepEqual(notesDoc.parents, [F(0)], "no parent means the caller's root");
  assert.equal(notesDoc.size, "0");
  assert.ok(notesDoc.exportLinks["text/markdown"]);
  const blank = (await rest("POST", "/files", { body: { name: "blank.bin" } })).json;
  assert.equal(blank.mimeType, "application/octet-stream");
  assert.equal(blank.size, "0");
  assert.equal(blank.md5Checksum, "d41d8cd98f00b204e9800998ecf8427e");
  const hello = (await rest("POST", `${UPLOAD}/files?uploadType=media`, { absolute: true, body: "hello", contentType: "text/plain" })).json;
  assert.equal(hello.name, "Untitled");
  assert.deepEqual(hello.parents, [F(0)]);
  assert.equal(hello.mimeType, "text/plain");
  assert.equal(hello.size, "5");
  assert.equal(hello.md5Checksum, "5d41402abc4b2a76b9719d911017c592");
  assert.equal(hello.fileExtension, undefined);
  await restError("POST", `${UPLOAD}/files?uploadType=multipart`, 400, "badRequest", { absolute: true, body: "--x", contentType: "multipart/related; boundary=x" });
  await restError("POST", `${UPLOAD}/files`, 400, "badRequest", { absolute: true, body: "hello", contentType: "text/plain" });
  await restError("POST", "/files", 404, "notFound", { body: { name: "x", parents: [F(22)] } });
  await restError("POST", "/files", 400, "badRequest", { body: { name: "x", parents: [F(7)] } });
  await restError("POST", "/files", 403, "insufficientFilePermissions", { body: { name: "x", parents: [F(26)] } });
  await restError("POST", "/files", 400, "badRequest", { body: { name: "x", parents: [F(1), F(8)] } });
  await restError("POST", "/files", 400, "badRequest", { body: { name: "x", folderColorRgb: "#ff0000" } });
  await restError("POST", "/files", 400, "badRequest", { body: { name: "x", mimeType: SHORTCUT } });
  await restError("POST", "/files", 400, "badRequest", { body: { name: "x", mimeType: "application/vnd.google-apps.form" } });
  await op("files.create", { name: "x", mimeType: FOLDER, textContent: "content on a folder" }, "INVALID_ARGUMENT");
  await op("files.create", { name: "x", textContent: "a", base64Content: "YQ==" }, "INVALID_ARGUMENT");
  await op("files.create", { name: "x", base64Content: "not base64!!" }, "INVALID_ARGUMENT");
  await op("files.create", { name: "x", properties: Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`k${index}`, "v"])) }, "INVALID_ARGUMENT");
  const link = (await rest("POST", "/files", { body: { name: "Link to roadmap", mimeType: SHORTCUT, shortcutDetails: { targetId: F(7) } } })).json;
  assert.deepEqual(link.shortcutDetails, { targetId: F(7), targetMimeType: "text/markdown" });
  const inDesignSystem = (await rest("POST", "/files", { body: { name: "Dana in design system", mimeType: DOC, parents: [F(23)] } })).json;
  assert.equal(inDesignSystem.owners[0].emailAddress, DANA, "created inside Sam's folder, owned by Dana");
  assert.deepEqual(inDesignSystem.parents, [F(23)]);
  assert.equal(inDesignSystem.capabilities.canShare, true, "own file: sharing allowed even though the folder disallows writers to share");
  assert.equal((await rest("GET", `/files/${F(23)}`)).json.capabilities.canShare, false, "writersCanShare=false on Sam's folder");
  assert.equal((await rest("GET", `/files/${F(24)}`)).json.capabilities.canShare, false);
  await restError("POST", `/files/${F(24)}/permissions`, 403, "insufficientFilePermissions", { body: { role: "reader", type: "user", emailAddress: RAVI } });

  // files.update: content -------------------------------------------------------------------------
  const roadmapBefore = (await rest("GET", `/files/${F(7)}`)).json;
  const newRoadmap = "# Roadmap v2\n\nObservability stays the second theme.\n";
  const roadmapAfter = (await rest("PATCH", `${UPLOAD}/files/${F(7)}?uploadType=media`, { absolute: true, body: newRoadmap, contentType: "text/markdown" })).json;
  assert.equal(roadmapAfter.version, "7");
  assert.equal(roadmapAfter.size, String(Buffer.byteLength(newRoadmap)));
  assert.notEqual(roadmapAfter.headRevisionId, roadmapBefore.headRevisionId);
  assert.notEqual(roadmapAfter.md5Checksum, roadmapBefore.md5Checksum);
  assert.equal(roadmapAfter.md5Checksum, md5(newRoadmap));
  assert.equal(roadmapAfter.modifiedTime, NOW);
  assert.equal((await rest("GET", `/files/${F(7)}?alt=media`)).text, newRoadmap);
  await restError("PATCH", `${UPLOAD}/files/${F(1)}?uploadType=media`, 400, "badRequest", { absolute: true, body: "x", contentType: "text/plain" });
  await restError("PATCH", `${UPLOAD}/files/${F(21)}?uploadType=media`, 403, "insufficientFilePermissions", { absolute: true, body: "x", contentType: "text/plain" });
  await restError("PATCH", `${UPLOAD}/files/${F(7)}?uploadType=resumable`, 400, "badRequest", { absolute: true, body: "x", contentType: "text/plain" });

  // files.update: metadata ------------------------------------------------------------------------
  const renamed = (await rest("PATCH", `/files/${F(7)}`, { body: { name: "Platform roadmap v2.md", description: "Second draft" } })).json;
  assert.equal(renamed.version, "8");
  assert.equal(renamed.name, "Platform roadmap v2.md");
  assert.equal(renamed.description, "Second draft");
  assert.equal(renamed.lastModifyingUser.emailAddress, DANA);
  assert.equal(renamed.modifiedByMe, true);
  const starred = (await rest("PATCH", `/files/${F(7)}`, { body: { starred: true } })).json;
  assert.equal(starred.starred, true);
  assert.equal(starred.version, "8", "starring is per-user and does not bump the version");
  assert.deepEqual(ids((await list({ q: "starred = true", orderBy: "name" })).files), [F(10), F(7)]);
  const viewed = (await rest("PATCH", `/files/${F(7)}`, { body: { viewedByMeTime: "2026-09-14T08:00:00Z" } })).json;
  assert.equal(viewed.viewedByMeTime, "2026-09-14T08:00:00.000Z");
  const props = (await rest("PATCH", `/files/${F(7)}`, { body: { properties: { team: null, owner: "dana" } } })).json;
  assert.deepEqual(props.properties, { quarter: "H2-2026", owner: "dana" });
  assert.equal(props.version, "9");
  const restricted = (await rest("PATCH", `/files/${F(7)}`, { body: { copyRequiresWriterPermission: true } })).json;
  assert.equal(restricted.copyRequiresWriterPermission, true);
  assert.equal(restricted.viewersCanCopyContent, false);
  assert.equal((await rest("PATCH", `/files/${F(7)}`, { body: { copyRequiresWriterPermission: false } })).json.version, "11");
  assert.equal((await rest("PATCH", `/files/${F(7)}`, { body: { name: "Platform roadmap v2.md" } })).json.version, "11", "an empty-effect patch changes nothing");
  await restError("PATCH", `/files/${F(7)}`, 400, "badRequest", { body: { folderColorRgb: "#ff0000" } });
  await restError("PATCH", `/files/${F(7)}`, 400, "badRequest", { body: {} });
  await restError("PATCH", `/files/${F(7)}`, 400, "badRequest", { body: { name: "" } });
  await restError("PATCH", `/files/${F(3)}`, 400, "badRequest", { body: { mimeType: "text/plain" } });
  await restError("PATCH", `/files/${F(21)}`, 403, "insufficientFilePermissions", { body: { name: "x" } });
  await restError("PATCH", `/files/${F(21)}`, 403, "insufficientFilePermissions", { body: { writersCanShare: false } });
  await restError("PATCH", "/files/root", 403, "insufficientFilePermissions", { body: { name: "Renamed root" } });
  await restError("PATCH", `/files/${GENERATED(31)}`, 404, "notFound", { body: { name: "x" } });
  const colored = (await rest("PATCH", `/files/${F(1)}`, { body: { folderColorRgb: "#FF7537" } })).json;
  assert.equal(colored.folderColorRgb, "#ff7537");

  // files.update: move ------------------------------------------------------------------------------
  const moved = (await rest("PATCH", `/files/${notesDoc.id}?addParents=${clientWork.id}&removeParents=root`, { body: {} })).json;
  assert.deepEqual(moved.parents, [clientWork.id]);
  assert.equal(moved.version, "2");
  assert.equal(moved.modifiedTime, NOW);
  await restError("PATCH", `/files/${F(1)}?addParents=${F(2)}&removeParents=${F(0)}`, 400, "badRequest", { body: {} });
  await restError("PATCH", `/files/${F(7)}?addParents=${F(1)},${F(8)}`, 400, "badRequest", { body: {} });
  await restError("PATCH", `/files/${F(7)}?addParents=${F(8)}&removeParents=${F(2)}`, 400, "badRequest", { body: {} });
  await restError("PATCH", `/files/${F(7)}?addParents=${F(9)}`, 400, "badRequest", { body: {} });
  await restError("PATCH", `/files/${F(7)}?addParents=${F(26)}`, 403, "insufficientFilePermissions", { body: {} });
  await restError("PATCH", `/files/${F(7)}?removeParents=${F(1)}`, 400, "badRequest", { body: {} });
  const tokensMoved = (await rest("PATCH", `/files/${F(24)}?addParents=${F(1)}&removeParents=${F(23)}`, { body: {} })).json;
  assert.deepEqual(tokensMoved.parents, [F(1)], "an inherited writer may move Sam's file into Dana's folder");
  assert.equal(tokensMoved.ownedByMe, false);
  assert.deepEqual((await rest("PATCH", `/files/${F(24)}?addParents=${F(23)}&removeParents=${F(1)}`, { body: {} })).json.parents, [F(23)]);

  // files.update: trash and restore ------------------------------------------------------------------
  const trashed = (await rest("PATCH", `/files/${clientWork.id}`, { body: { trashed: true } })).json;
  assert.equal(trashed.trashed, true);
  assert.equal(trashed.explicitlyTrashed, true);
  assert.equal(trashed.trashedTime, NOW);
  assert.equal(trashed.trashingUser.emailAddress, DANA);
  const trashedChild = (await rest("GET", `/files/${notesDoc.id}`)).json;
  assert.equal(trashedChild.trashed, true);
  assert.equal(trashedChild.explicitlyTrashed, false);
  assert.deepEqual(ids((await list({ q: "trashed = true", orderBy: "name" })).files), [F(9), clientWork.id, notesDoc.id]);
  await restError("PATCH", `/files/${blank.id}?addParents=${clientWork.id}&removeParents=root`, 400, "badRequest", { body: {} });
  await restError("PATCH", `/files/${notesDoc.id}`, 400, "badRequest", { body: { trashed: false } });
  await restError("POST", `/files/${F(7)}/copy`, 400, "badRequest", { body: { parents: [clientWork.id] } });
  const restored = (await rest("PATCH", `/files/${clientWork.id}`, { body: { trashed: false } })).json;
  assert.equal(restored.trashed, false);
  assert.equal((await rest("GET", `/files/${notesDoc.id}`)).json.trashed, false, "the cascade restores the child");
  await restError("PATCH", `/files/${F(21)}`, 403, "insufficientFilePermissions", { body: { trashed: true } });
  await restError("PATCH", "/files/root", 403, "insufficientFilePermissions", { body: { trashed: true } });

  // files.copy ------------------------------------------------------------------------------------------
  const copy = (await rest("POST", `/files/${F(21)}/copy`, { body: {} })).json;
  assert.equal(copy.name, "Copy of Q3 planning notes");
  assert.deepEqual(copy.parents, [F(0)], "a reader's copy lands in the caller's root");
  assert.equal(copy.ownedByMe, true);
  assert.equal(copy.mimeType, DOC);
  assert.equal((await op("files.read-content", { fileId: copy.id })).fileContent, (await op("files.read-content", { fileId: F(21) })).fileContent);
  await restError("POST", `/files/${F(1)}/copy`, 400, "badRequest", { body: {} });
  await restError("POST", `/files/${F(22)}/copy`, 404, "notFound", { body: {} });
  await restError("POST", `/files/${F(7)}/copy`, 403, "insufficientFilePermissions", { body: { parents: [F(26)] } });
  await restError("POST", `/files/${F(7)}/copy`, 400, "badRequest", { body: { parents: [F(1), F(8)] } });
  const pdfCopy = (await rest("POST", `/files/${F(6)}/copy`, { body: { name: "Vendor comparison (copy).pdf", parents: [F(14)], description: "" } })).json;
  assert.equal(pdfCopy.md5Checksum, pdfMeta.md5Checksum);
  assert.equal(pdfCopy.size, "3172");
  assert.deepEqual(pdfCopy.parents, [F(14)]);
  assert.equal(pdfCopy.description, undefined);
  assert.equal(await count(`'${F(14)}' in parents`), 1);

  // permissions -----------------------------------------------------------------------------------------
  const notesPermissions = (await rest("GET", `/files/${F(3)}/permissions`)).json;
  assert.equal(notesPermissions.kind, "drive#permissionList");
  assert.deepEqual(ids(notesPermissions.permissions), [PID.dana, PID.priya, PID.sam]);
  assert.equal(notesPermissions.permissions[1].displayName, "Priya Natarajan");
  assert.deepEqual(notesPermissions.permissions[2].permissionDetails, [{ permissionType: "file", role: "writer", inheritedFrom: F(2), inherited: true }]);
  assert.equal(notesPermissions.permissions[2].displayName, "Sam Okafor");
  await restError("GET", `/files/${F(3)}/permissions/${PID.sam}`, 404, "notFound");
  assert.equal((await rest("GET", `/files/${F(2)}/permissions/${PID.sam}`)).json.role, "writer");
  assert.equal((await rest("GET", `/files/${F(3)}/permissions/${PID.priya}`)).json.emailAddress, PRIYA);
  await restError("GET", `/files/${F(3)}/permissions/${PID.priya}?fields=nope`, 400, "invalidParameter");
  await restError("GET", `/files/${F(3)}/permissions?fields=nope`, 400, "invalidParameter");
  await restError("GET", `/files/${F(22)}/permissions`, 404, "notFound");
  const raviRow = (await rest("POST", `/files/${F(7)}/permissions`, { body: { role: "commenter", type: "user", emailAddress: RAVI, expirationTime: "2026-12-01T00:00:00Z" } })).json;
  assert.equal(raviRow.kind, "drive#permission");
  assert.equal(raviRow.id, PID.ravi, "in-world users keep one permission id everywhere");
  assert.equal(raviRow.displayName, "Ravi Menon");
  assert.equal(raviRow.expirationTime, "2026-12-01T00:00:00.000Z");
  assert.equal(raviRow.deleted, false);
  const anyone = (await rest("POST", `/files/${F(7)}/permissions`, { body: { role: "reader", type: "anyone" } })).json;
  assert.equal(anyone.id, "anyoneWithLink");
  assert.equal(anyone.allowFileDiscovery, false);
  assert.deepEqual(ids((await list({ q: "visibility = 'anyoneWithLink'", orderBy: "name" })).files), [F(7), F(11)]);
  await restError("POST", `/files/${F(7)}/permissions`, 400, "badRequest", { body: { role: "reader", type: "domain", domain: "example.test", expirationTime: "2026-12-01T00:00:00Z" } });
  await restError("POST", `/files/${F(7)}/permissions`, 400, "badRequest", { body: { role: "owner", type: "user", emailAddress: SAM } });
  await restError("POST", `/files/${F(7)}/permissions`, 400, "invalid", { body: { role: "editor", type: "user", emailAddress: SAM } });
  await restError("POST", `/files/${F(7)}/permissions`, 400, "badRequest", { body: { role: "reader", type: "user", emailAddress: "not-an-email" } });
  await restError("POST", `/files/${F(7)}/permissions?emailMessage=hi`, 400, "badRequest", { body: { role: "reader", type: "user", emailAddress: "guest@example.org" } });
  await restError("POST", `/files/${F(7)}/permissions`, 400, "badRequest", { body: { role: "reader", type: "user", emailAddress: RAVI, expirationTime: "2020-01-01T00:00:00Z" } });
  await restError("POST", `/files/${F(7)}/permissions?transferOwnership=true`, 400, "invalidSharingRequest", { body: { role: "owner", type: "anyone" } });
  const upgraded = (await rest("POST", `/files/${F(7)}/permissions`, { body: { role: "reader", type: "user", emailAddress: RAVI } })).json;
  assert.equal(upgraded.id, PID.ravi, "an existing grantee is updated in place");
  assert.equal(upgraded.role, "reader");
  const group = (await rest("POST", `/files/${F(7)}/permissions`, { body: { role: "reader", type: "group", emailAddress: "design@example.test" } })).json;
  assert.equal(group.id, "07000000000000000001");
  assert.equal(group.type, "group");
  const guest = (await rest("POST", `/files/${F(7)}/permissions?sendNotificationEmail=true&emailMessage=Take%20a%20look`, { body: { role: "reader", type: "user", emailAddress: "guest@example.org" } })).json;
  assert.equal(guest.id, "07000000000000000002", "an outside address gets a generated id");
  assert.equal(guest.displayName, undefined);
  const transferred = (await rest("POST", `/files/${F(19)}/permissions?transferOwnership=true&moveToNewOwnersRoot=true`, { body: { role: "owner", type: "user", emailAddress: SAM } })).json;
  assert.equal(transferred.role, "owner");
  assert.equal(transferred.id, PID.sam);
  const logo = (await rest("GET", `/files/${F(19)}`)).json;
  assert.equal(logo.owners[0].emailAddress, SAM);
  assert.deepEqual(logo.parents, [F(20)]);
  assert.equal(logo.ownedByMe, false);
  assert.equal(logo.capabilities.canEdit, true, "the previous owner keeps writer access");
  assert.equal(logo.capabilities.canDelete, false);
  assert.equal(logo.sharedWithMeTime, NOW);
  await restError("POST", `/files/${F(17)}/permissions?transferOwnership=true`, 400, "invalidSharingRequest", { body: { role: "owner", type: "user", emailAddress: PRIYA } });
  await restError("POST", `/files/${F(17)}/permissions?transferOwnership=true`, 400, "invalidSharingRequest", { body: { role: "owner", type: "user", emailAddress: DANA } });
  await restError("POST", `/files/${F(21)}/permissions`, 403, "insufficientFilePermissions", { body: { role: "reader", type: "user", emailAddress: RAVI } });
  await restError("POST", `/files/${F(22)}/permissions`, 404, "notFound", { body: { role: "reader", type: "user", emailAddress: RAVI } });
  const patchedRavi = (await rest("PATCH", `/files/${F(7)}/permissions/${PID.ravi}?removeExpiration=true`, { body: { role: "commenter" } })).json;
  assert.equal(patchedRavi.role, "commenter");
  assert.equal(patchedRavi.expirationTime, undefined);
  const expiring = (await rest("PATCH", `/files/${F(7)}/permissions/${PID.ravi}`, { body: { expirationTime: "2027-01-01T00:00:00Z" } })).json;
  assert.equal(expiring.expirationTime, "2027-01-01T00:00:00.000Z");
  await restError("PATCH", `/files/${F(7)}/permissions/${PID.dana}`, 400, "badRequest", { body: { role: "reader" } });
  await restError("PATCH", `/files/${F(7)}/permissions/${PID.ravi}`, 400, "badRequest", { body: {} });
  await restError("PATCH", `/files/${F(7)}/permissions/${PID.ravi}`, 400, "invalid", { body: { role: "editor" } });
  await restError("PATCH", `/files/${F(7)}/permissions/anyoneWithLink`, 400, "badRequest", { body: { expirationTime: "2027-01-01T00:00:00Z" } });
  await restError("PATCH", `/files/${F(3)}/permissions/${PID.priya}?transferOwnership=true`, 400, "invalidSharingRequest", { body: { role: "owner" } });
  await restError("PATCH", `/files/${F(3)}/permissions/${PID.priya}`, 400, "badRequest", { body: { role: "owner" } });
  await restError("PATCH", `/files/${F(21)}/permissions/${PID.sam}`, 403, "insufficientFilePermissions", { body: { role: "reader" } });
  await restError("PATCH", `/files/${F(7)}/permissions/${PID.priya}`, 404, "notFound", { body: { role: "reader" } });
  await restError("PATCH", `/files/${F(3)}/permissions/${PID.priya}?fields=nope`, 400, "invalidParameter", { body: { role: "reader" } });
  await rest("DELETE", `/files/${F(7)}/permissions/${PID.ravi}`, { status: 204 });
  await restError("DELETE", `/files/${F(7)}/permissions/${PID.ravi}`, 404, "notFound");
  await restError("DELETE", `/files/${F(7)}/permissions/${PID.dana}`, 400, "badRequest");
  await restError("DELETE", `/files/${F(21)}/permissions/${PID.sam}`, 403, "insufficientFilePermissions");
  await restError("DELETE", `/files/${F(22)}/permissions/${PID.sam}`, 404, "notFound");
  const roadmapPermissions = (await rest("GET", `/files/${F(7)}/permissions?pageSize=2`)).json;
  assert.equal(roadmapPermissions.permissions.length, 2);
  assert.equal(roadmapPermissions.permissions[0].role, "owner");
  assert.ok(roadmapPermissions.nextPageToken);
  const second = (await rest("GET", `/files/${F(7)}/permissions?pageSize=2&pageToken=${encodeURIComponent(roadmapPermissions.nextPageToken)}`)).json;
  assert.equal(second.permissions.length, 2);
  const third = (await rest("GET", `/files/${F(7)}/permissions?pageSize=2&pageToken=${encodeURIComponent(second.nextPageToken)}`)).json;
  assert.equal(third.permissions.length, 1);
  assert.equal(third.nextPageToken, undefined);
  await restError("GET", `/files/${F(7)}/permissions?pageSize=2&pageToken=broken`, 400, "badRequest");
  await restError("GET", `/files/${F(7)}/permissions?pageSize=1001`, 400, "invalid");

  // changes ------------------------------------------------------------------------------------------------
  const changes = (await rest("GET", "/changes?pageToken=1&pageSize=1000")).json;
  assert.equal(changes.kind, "drive#changeList");
  assert.ok(changes.changes.length >= 20, `every mutation above is journaled (${changes.changes.length})`);
  assert.ok(changes.newStartPageToken, "the last page carries newStartPageToken");
  const roadmapChange = changes.changes.find((change) => change.fileId === F(7));
  assert.equal(roadmapChange.removed, false);
  assert.equal(roadmapChange.file.name, "Platform roadmap v2.md");
  assert.equal(roadmapChange.changeType, "file");
  assert.equal(roadmapChange.time, NOW);
  await restError("GET", "/changes", 400, "required");
  await restError("GET", "/changes?pageToken=999999", 400, "badRequest");
  await restError("GET", "/changes?pageToken=abc", 400, "badRequest");
  await restError("GET", "/changes?pageToken=1&spaces=photos", 400, "invalid");
  await restError("GET", "/changes?pageToken=1&fields=nope", 400, "invalidParameter");
  let token = "1";
  let paged = 0;
  for (let round = 0; round < 100; round += 1) {
    const page = (await rest("GET", `/changes?pageToken=${token}&pageSize=7`)).json;
    paged += page.changes.length;
    if (page.nextPageToken === undefined) {
      assert.equal(page.newStartPageToken, changes.newStartPageToken);
      break;
    }
    token = page.nextPageToken;
  }
  assert.equal(paged, changes.changes.length, "paging with pageSize 7 visits every change once");

  // files.delete -------------------------------------------------------------------------------------------
  await rest("DELETE", `/files/${clientWork.id}`, { status: 204 });
  await restError("GET", `/files/${clientWork.id}`, 404, "notFound");
  await restError("GET", `/files/${notesDoc.id}`, 404, "notFound");
  await restError("DELETE", "/files/root", 403, "insufficientFilePermissions");
  await restError("DELETE", `/files/${F(21)}`, 403, "insufficientFilePermissions");
  await restError("DELETE", `/files/${F(19)}`, 403, "insufficientFilePermissions");
  await restError("DELETE", `/files/${GENERATED(31)}`, 404, "notFound");
  const afterDelete = (await rest("GET", `/changes?pageToken=${changes.newStartPageToken}`)).json;
  const removedIds = afterDelete.changes.filter((change) => change.removed).map((change) => change.fileId).sort();
  assert.deepEqual(removedIds, [clientWork.id, notesDoc.id].sort(), "the cascade journals one removal per file");
  assert.equal((await rest("GET", `/changes?pageToken=${changes.newStartPageToken}&includeRemoved=false`)).json.changes.length, 0);
  assert.equal((await list({ q: "trashed = false" })).files.length, 25 + 6, "26 minus the deleted folder and doc, plus the six surviving creations");

  // Starter binaries are real files: the bytes served decode as the declared type, and size/md5Checksum match them.
  await starterBinariesDecode();
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Walks every PNG chunk (length, type, CRC), inflates IDAT and checks the scanline count against IHDR. */
function assertPng(bytes, label) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${label}: PNG signature`);
  let offset = 8;
  const types = [];
  const idat = [];
  let header;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(bytes.readUInt32BE(offset + 8 + length), crc32(bytes.subarray(offset + 4, offset + 8 + length)), `${label}: ${type} CRC`);
    if (type === "IHDR") header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9] };
    if (type === "IDAT") idat.push(data);
    types.push(type);
    offset += 12 + length;
  }
  assert.equal(offset, bytes.length, `${label}: chunks end exactly at the last byte`);
  assert.equal(types[0], "IHDR");
  assert.equal(types.at(-1), "IEND");
  assert.ok(header.width > 0 && header.height > 0, `${label}: IHDR dimensions`);
  assert.equal(header.depth, 8);
  assert.equal(header.color, 2);
  const pixels = inflateSync(Buffer.concat(idat));
  assert.equal(pixels.length, header.height * (1 + header.width * 3), `${label}: IDAT inflates to ${header.width}x${header.height} RGB scanlines`);
  return header;
}

/** Finds the ZIP end-of-central-directory record, walks the central directory and inflates every entry against its CRC. */
function assertZip(bytes, label, expectedEntries) {
  let eocd = -1;
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) {
      eocd = index;
      break;
    }
  }
  assert.ok(eocd >= 0, `${label}: ZIP end-of-central-directory record`);
  const entries = bytes.readUInt16LE(eocd + 10);
  let cursor = bytes.readUInt32LE(eocd + 16);
  const names = [];
  for (let entry = 0; entry < entries; entry += 1) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50, `${label}: central directory header`);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extra = bytes.readUInt16LE(cursor + 30);
    const comment = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assert.equal(bytes.readUInt32LE(local), 0x04034b50, `${label}: local header for ${name}`);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const stored = bytes.subarray(start, start + compressed);
    const body = method === 8 ? inflateRawSync(stored) : stored;
    assert.equal(crc32(body), crc, `${label}: CRC of ${name}`);
    names.push(name);
    cursor += 46 + nameLength + extra + comment;
  }
  assert.deepEqual(names, expectedEntries, `${label}: archive entries`);
}

/** Checks the PDF header, trailer and that every xref offset points at its `n 0 obj`. */
function assertPdf(bytes, label) {
  const text = bytes.toString("latin1");
  assert.ok(text.startsWith("%PDF-1."), `${label}: PDF header`);
  assert.ok(text.trimEnd().endsWith("%%EOF"), `${label}: %%EOF`);
  const startxref = Number(text.match(/startxref\s+(\d+)\s+%%EOF\s*$/)?.[1]);
  assert.ok(text.startsWith("xref", startxref), `${label}: startxref points at the xref table`);
  const table = text.slice(startxref).split("\n");
  const count = Number(table[1].split(" ")[1]);
  for (let object = 1; object < count; object += 1) {
    const offset = Number(table[2 + object].slice(0, 10));
    assert.ok(text.startsWith(`${object} 0 obj`, offset), `${label}: xref entry ${object}`);
  }
}

async function starterBinariesDecode() {
  const expected = [
    [F(6), "application/pdf", 3172, (bytes) => assertPdf(bytes, "Vendor comparison.pdf")],
    [F(13), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 5104, (bytes) => assertZip(bytes, "docx", ["[Content_Types].xml", "_rels/.rels", "word/document.xml"])],
    [F(16), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 4488, (bytes) => assertZip(bytes, "xlsx", ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"])],
    [F(19), "image/png", 1216, (bytes) => assert.deepEqual(assertPng(bytes, "logo.png"), { width: 32, height: 32, depth: 8, color: 2 })],
    [F(27), "image/png", 712, (bytes) => assert.deepEqual(assertPng(bytes, "IMG_0401.png"), { width: 48, height: 36, depth: 8, color: 2 })],
    [F(28), "image/png", 698, (bytes) => assert.deepEqual(assertPng(bytes, "IMG_0402.png"), { width: 48, height: 36, depth: 8, color: 2 })],
    [F(29), "image/png", 731, (bytes) => assert.deepEqual(assertPng(bytes, "IMG_0403.png"), { width: 48, height: 36, depth: 8, color: 2 })],
  ];
  for (const [fileId, mimeType, size, check] of expected) {
    const meta = (await rest("GET", `/files/${fileId}?fields=id,mimeType,size,md5Checksum`)).json;
    assert.equal(meta.mimeType, mimeType);
    assert.equal(meta.size, String(size));
    const media = await byteBody(`/files/${fileId}?alt=media`);
    assert.equal(media.status, 200);
    assert.ok(media.contentType.startsWith(mimeType), media.contentType);
    assert.equal(media.bytes.length, size, `${fileId}: alt=media length equals size`);
    assert.equal(md5(media.bytes), meta.md5Checksum, `${fileId}: alt=media bytes match md5Checksum`);
    check(media.bytes);
    const download = await op("files.download", { fileId });
    assert.equal(download.mimeType, mimeType);
    assert.ok(Buffer.from(download.content, "base64").equals(media.bytes), `${fileId}: files.download returns the same bytes`);
  }
}

// ---------------------------------------------------------------------------------------------
// Drill: mcp-aliases (owner = Dana, baseline)
// ---------------------------------------------------------------------------------------------

async function mcpAliases() {
  await mcpInit();
  const tools = (await rpc("tools/list", {})).tools.map((tool) => tool.name);
  for (const alias of ["search_files", "list_recent_files", "get_file_metadata", "get_file_permissions", "read_file_content", "download_file_content", "create_file", "copy_file"]) {
    assert.ok(tools.includes(alias), `alias ${alias} is listed`);
  }
  for (const operation of ["about.get", "files.list", "files.recent", "files.get", "files.create", "files.update", "files.copy", "files.delete", "files.empty-trash", "files.export", "files.download", "files.read-content", "permissions.list", "permissions.get", "permissions.create", "permissions.update", "permissions.delete", "changes.start-page-token", "changes.list"]) {
    assert.ok(tools.includes(`google-drive.${operation}`), `canonical google-drive.${operation} is listed`);
  }

  const search = await mcp("search_files", { query: "name contains 'Meeting' and trashed = false", pageSize: 1 });
  assert.equal(search.kind, "drive#fileList");
  assert.equal(search.files.length, 1);
  assert.ok(search.nextPageToken);
  const first = search.files[0];
  assert.equal(first.title, first.name);
  assert.equal(first.parentId, F(0));
  assert.equal(first.fileSize, first.size);
  assert.equal(first.viewUrl, first.webViewLink);
  assert.equal(first.owner, DANA);
  assert.ok(first.contentSnippet.startsWith("Meeting notes"));
  assert.equal(first.canAddChildren, false);
  const searchPage2 = await mcp("search_files", { query: "name contains 'Meeting' and trashed = false", pageSize: 1, pageToken: search.nextPageToken });
  assert.equal(searchPage2.files.length, 1);
  assert.notEqual(searchPage2.files[0].id, first.id);
  assert.equal(searchPage2.nextPageToken, undefined);
  assert.ok(!("contentSnippet" in (await mcp("search_files", { query: "trashed = false", excludeContentSnippets: true })).files[0]));
  await mcpError("search_files", { query: "foo = 1" }, "tool.INVALID_ARGUMENT");
  await mcpError("search_files", { query: "trashed = false", pageToken: "broken" }, "tool.INVALID_PAGE_TOKEN");

  const recent = await mcp("list_recent_files", {});
  assert.equal(recent.files[0].id, F(18), "the doc viewed on 13 September is the most recent");
  assert.equal(recent.files.length, 10);
  assert.ok(!ids(recent.files).includes(F(9)) && !ids(recent.files).includes(F(1)), "trashed items and folders are not recent");
  const recentPage = await mcp("list_recent_files", { pageSize: 3 });
  assert.equal(recentPage.files.length, 3);
  const recentPage2 = await mcp("list_recent_files", { pageSize: 3, pageToken: recentPage.nextPageToken });
  assert.equal(recentPage2.files.length, 3);
  assert.equal(new Set([...ids(recentPage.files), ...ids(recentPage2.files)]).size, 6);
  assert.equal((await mcp("list_recent_files", { orderBy: "lastModified" })).files[0].id, F(5));
  assert.deepEqual((await mcp("list_recent_files", { orderBy: "lastModifiedByMe" })).files, [], "Dana has modified nothing herself in the starter data");
  await mcpError("list_recent_files", { pageSize: 5000 }, "tool.INVALID_ARGUMENT");
  await mcpError("list_recent_files", { pageToken: "broken" }, "tool.INVALID_PAGE_TOKEN");

  const metadata = await mcp("get_file_metadata", { fileId: F(3) });
  assert.equal(metadata.file.title, "Billing v2 - design notes");
  assert.equal(metadata.file.parentId, F(2));
  assert.equal(metadata.file.fileSize, "1341");
  assert.ok(metadata.file.contentSnippet.length <= 200);
  await mcpError("get_file_metadata", { fileId: F(22) }, "tool.NOT_FOUND");

  const permissions = await mcp("get_file_permissions", { fileId: F(3) });
  assert.deepEqual(permissions.permissions.map((row) => [row.role, row.type, row.emailAddress, row.displayName]), [
    ["owner", "user", DANA, "Dana Reyes"],
    ["reader", "user", PRIYA, "Priya Natarajan"],
    ["writer", "user", SAM, "Sam Okafor"],
  ]);

  const csv = await mcp("read_file_content", { fileId: F(4) });
  assert.ok(csv.fileContent.startsWith("account,plan,cadence"));
  assert.equal(csv.textFormattingNotSupported, true);
  assert.equal(csv.commentsNotSupported, true);
  assert.deepEqual(csv.contentAnchoredComments, []);
  const pdf = await mcp("read_file_content", { fileId: F(6) });
  assert.equal(pdf.fileContent, "");
  assert.equal(pdf.textFormattingNotSupported, true);
  assert.equal((await mcp("read_file_content", { fileId: F(15) })).fileContent, (await mcp("read_file_content", { fileId: F(21) })).fileContent, "a shortcut resolves to its target");
  assert.equal((await mcp("read_file_content", { fileId: F(1) })).fileContent, "");
  await mcpError("read_file_content", { fileId: F(22) }, "tool.NOT_FOUND");

  const download = await mcp("download_file_content", { fileId: F(3) });
  assert.equal(download.id, F(3));
  assert.equal(download.title, "Billing v2 - design notes");
  assert.equal(download.mimeType, "text/plain");
  assert.ok(Buffer.from(download.content, "base64").toString("utf8").startsWith("Billing v2 - design notes"));
  assert.equal((await mcp("download_file_content", { fileId: F(3), exportMimeType: "text/markdown" })).mimeType, "text/markdown");
  assert.equal((await mcp("download_file_content", { fileId: F(4) })).mimeType, "text/csv");
  const pdfDownload = await mcp("download_file_content", { fileId: F(6) });
  assert.equal(pdfDownload.mimeType, "application/pdf");
  assert.equal(md5(Buffer.from(pdfDownload.content, "base64")), (await mcp("get_file_metadata", { fileId: F(6) })).file.md5Checksum);
  await mcpError("download_file_content", { fileId: F(1) }, "tool.NOT_EXPORTABLE");
  await mcpError("download_file_content", { fileId: F(3), exportMimeType: "application/pdf" }, "tool.INVALID_ARGUMENT");
  await mcpError("download_file_content", { fileId: GENERATED(31) }, "tool.NOT_FOUND");

  const created = await mcp("create_file", { title: "Alias note.txt", contentMimeType: "text/plain", textContent: "hello from mcp", parentId: F(1) });
  assert.equal(created.file.id, GENERATED(1));
  assert.equal(created.file.parentId, F(1));
  assert.equal(created.file.mimeType, "text/plain");
  assert.equal(created.file.fileSize, "14");
  assert.equal(created.file.contentSnippet, "hello from mcp");
  assert.equal((await mcp("list_recent_files", { orderBy: "lastModifiedByMe" })).files[0].id, created.file.id);
  const pixel = await mcp("create_file", { title: "pixel.png", contentMimeType: "image/png", base64Content: "iVBORw0KGgo=", disableConversionToGoogleType: true });
  assert.equal(pixel.file.mimeType, "image/png");
  assert.equal(pixel.file.fileSize, "8");
  assert.equal(pixel.file.parentId, F(0));
  await mcpError("create_file", { title: "both", textContent: "a", base64Content: "YQ==" }, "tool.INVALID_ARGUMENT");
  const fromText = await mcp("create_file", { title: "From text", mimeType: DOC, contentMimeType: "text/plain", textContent: "Doc body" });
  assert.equal(fromText.file.id, GENERATED(3));
  assert.equal(fromText.file.mimeType, DOC);
  assert.equal((await mcp("read_file_content", { fileId: fromText.file.id })).fileContent, "Doc body");
  await mcpError("create_file", { title: "bad import", mimeType: DOC, contentMimeType: "application/pdf", textContent: "x" }, "tool.INVALID_ARGUMENT");
  await mcpError("create_file", { title: "nowhere", parentId: F(22) }, "tool.NOT_FOUND");
  const copied = await mcp("copy_file", { fileId: F(21), title: "Alias copy", parentId: F(1) });
  assert.equal(copied.file.title, "Alias copy");
  assert.equal(copied.file.parentId, F(1));
  assert.equal(copied.file.owner, DANA);
  await mcpError("copy_file", { fileId: F(1) }, "tool.INVALID_ARGUMENT");

  const emptied = await mcp("google-drive.files.empty-trash", {});
  assert.deepEqual(emptied, { deleted: 1 });
  await mcpError("get_file_metadata", { fileId: F(9) }, "tool.NOT_FOUND");
  assert.deepEqual(await mcp("google-drive.files.empty-trash", {}), { deleted: 0 });
  const canonicalRecent = await mcp("google-drive.files.recent", {});
  assert.ok(ids(canonicalRecent.files).includes(copied.file.id));
  const startToken = await mcp("google-drive.changes.start-page-token", {});
  assert.ok(/^[0-9]+$/.test(startToken.startPageToken));
  const changes = await mcp("google-drive.changes.list", { pageToken: "1" });
  assert.ok(ids(changes.changes.map((change) => ({ id: change.fileId }))).includes(created.file.id));
  assert.equal(changes.changes.find((change) => change.fileId === F(9)).removed, true);
}

// ---------------------------------------------------------------------------------------------
// Drill: sharing-roles (colleague = Sam, baseline)
// ---------------------------------------------------------------------------------------------

async function sharingRoles() {
  assert.equal(await count("trashed = false"), 19);
  assert.equal(await count(`'${F(2)}' in parents`), 4);
  assert.equal(await count("sharedWithMe = true"), 4);
  assert.equal((await rest("GET", `/files/${F(22)}`)).json.ownedByMe, true);
  await restError("GET", `/files/${F(10)}`, 404, "notFound");
  const notes = (await rest("GET", `/files/${F(3)}`)).json;
  assert.equal(notes.ownedByMe, false);
  assert.equal(notes.capabilities.canEdit, true);
  assert.equal(notes.capabilities.canShare, true);
  assert.equal(notes.capabilities.canDelete, false);
  assert.equal(notes.capabilities.canTrash, false);
  assert.equal(notes.viewedByMe, true);
  assert.equal(notes.modifiedByMe, true);
  assert.equal(notes.sharedWithMeTime, undefined, "inherited access carries no shared-with-me stamp");
  assert.ok(!("permissions" in notes));
  const updated = (await rest("PATCH", `${UPLOAD}/files/${F(3)}?uploadType=media`, { absolute: true, body: "Updated by Sam", contentType: "text/plain" })).json;
  assert.equal(updated.lastModifyingUser.emailAddress, SAM);
  assert.equal(updated.version, "8");
  await restError("PATCH", `/files/${F(3)}`, 403, "insufficientFilePermissions", { body: { trashed: true } });
  await restError("DELETE", `/files/${F(3)}`, 403, "insufficientFilePermissions");
  const addendum = (await rest("POST", "/files", { body: { name: "Sam's addendum", mimeType: DOC, parents: [F(2)] } })).json;
  assert.equal(addendum.ownedByMe, true);
  assert.deepEqual(addendum.parents, [F(2)]);
  const shared = (await rest("POST", `/files/${F(3)}/permissions`, { body: { role: "reader", type: "user", emailAddress: RAVI } })).json;
  assert.equal(shared.id, PID.ravi);
  await restError("POST", `/files/${F(16)}/permissions`, 403, "insufficientFilePermissions", { body: { role: "reader", type: "user", emailAddress: RAVI } });
  const expense = (await rest("GET", `/files/${F(16)}`)).json;
  assert.equal(expense.capabilities.canComment, true);
  assert.equal(expense.capabilities.canEdit, false);
  assert.equal(expense.capabilities.canDownload, true);
  assert.equal(expense.sharedWithMeTime, "2026-09-03T08:05:00.000Z");
  await restError("PATCH", `/files/${F(16)}`, 403, "insufficientFilePermissions", { body: { name: "x" } });
  const copy = (await rest("POST", `/files/${F(13)}/copy`, { body: {} })).json;
  assert.deepEqual(copy.parents, [F(20)], "no writer access to Dana's root: the copy lands in Sam's root");
  assert.equal(copy.ownedByMe, true);
  assert.equal((await rest("GET", `/files/${F(25)}`)).json.capabilities.canCopy, true);
  assert.equal((await rest("GET", `/files/${F(11)}`)).json.capabilities.canEdit, false, "link access is read-only");
  assert.equal((await rest("GET", `/files/${F(12)}`)).json.capabilities.canComment, false);
  await mcpInit();
  const billing = await mcp("get_file_permissions", { fileId: F(2) });
  assert.ok(billing.permissions.some((row) => row.emailAddress === SAM && row.role === "writer" && row.permissionDetails === undefined));
  assert.ok(billing.permissions.every((row) => row.permissionDetails === undefined));
  await restError("POST", `/files/${F(3)}/permissions?transferOwnership=true`, 403, "insufficientFilePermissions", { body: { role: "owner", type: "user", emailAddress: SAM } });
  assert.equal((await rest("GET", "/about")).json.storageQuota.usage, String(715 + 262 + 1451 + 437 + 712 + 698 + 731 + 5104), "Sam's usage counts his files plus the addendum and the copy");
}

// ---------------------------------------------------------------------------------------------
// Drill: quota (intern = Ravi, baseline)
// ---------------------------------------------------------------------------------------------

async function quota() {
  const about = (await rest("GET", "/about")).json;
  assert.deepEqual(about.storageQuota, { usage: "0", usageInDrive: "0", usageInTrash: "0", limit: "4096" });
  assert.deepEqual(ids((await list({ orderBy: "name" })).files), [F(25), F(12), F(11)]);
  assert.equal(await count("'root' in parents"), 0);
  const inventory = (await rest("GET", `/files/${F(25)}`)).json;
  assert.equal(inventory.capabilities.canCopy, false, "copyRequiresWriterPermission blocks a reader");
  assert.equal(inventory.capabilities.canDownload, false);
  assert.equal(inventory.sharedWithMeTime, "2026-09-02T09:00:00.000Z");
  await restError("POST", `/files/${F(25)}/copy`, 403, "insufficientFilePermissions", { body: {} });
  await mcpInit();
  assert.ok((await mcp("read_file_content", { fileId: F(25) })).fileContent.startsWith("component,status"));
  await mcpError("download_file_content", { fileId: F(25) }, "tool.FORBIDDEN");
  const body = "x".repeat(3000);
  const first = (await rest("POST", `${UPLOAD}/files?uploadType=media`, { absolute: true, body, contentType: "text/plain" })).json;
  assert.equal(first.size, "3000");
  assert.deepEqual(first.parents, [F(30)]);
  assert.equal((await rest("GET", "/about")).json.storageQuota.usage, "3000");
  await restError("POST", `${UPLOAD}/files?uploadType=media`, 403, "storageQuotaExceeded", { absolute: true, body: "y".repeat(2000), contentType: "text/plain" });
  assert.equal((await rest("PATCH", `${UPLOAD}/files/${first.id}?uploadType=media`, { absolute: true, body: "z".repeat(4000), contentType: "text/plain" })).json.size, "4000");
  await restError("PATCH", `${UPLOAD}/files/${first.id}?uploadType=media`, 403, "storageQuotaExceeded", { absolute: true, body: "z".repeat(4200), contentType: "text/plain" });
  await restError("POST", `/files/${first.id}/copy`, 403, "storageQuotaExceeded", { body: {} });
  await rest("DELETE", `/files/${first.id}`, { status: 204 });
  assert.equal((await rest("GET", "/about")).json.storageQuota.usage, "0");
}

// ---------------------------------------------------------------------------------------------
// Drill: fresh-install (local-dev: no identity attributes, every grant; baseline)
// ---------------------------------------------------------------------------------------------

async function freshInstall() {
  // Without an `email` attribute the actor acts as the primary seeded user: the lowest `users` row id (Dana).
  const about = (await rest("GET", "/about")).json;
  assert.equal(about.user.emailAddress, DANA);
  assert.equal(about.user.me, true);
  assert.equal(about.user.displayName, "Dana Reyes");
  assert.equal(await count("'root' in parents and trashed = false"), 10, "the seeded Drive is visible");
  assert.equal((await op("about.get", {})).serverTime, NOW);
  const folder = (await rest("POST", "/files", { body: { name: "Created without attributes", mimeType: FOLDER } })).json;
  assert.equal(folder.owners[0].emailAddress, DANA);
  assert.equal(folder.owners[0].displayName, "Dana Reyes");
  await restError("GET", `/files/${F(22)}`, 404, "notFound", {});
  await rest("DELETE", `/files/${folder.id}`, { status: 204 });
}

// ---------------------------------------------------------------------------------------------
// Drill: denied (auditor, baseline)
// ---------------------------------------------------------------------------------------------

async function denied() {
  const about = await rest("GET", "/about", { status: 403 });
  assert.equal(about.json.error.errors[0].reason, "insufficientPermissions");
  assert.equal(about.json.error.message, "Insufficient Permission");
  await rest("GET", "/files", { status: 403 });
  await mcpInit();
  const result = await rpc("tools/call", { name: "search_files", arguments: { query: "trashed = false" } });
  assert.ok(result.isError);
  assert.equal(result.structuredContent.status, "denied");
}

// ---------------------------------------------------------------------------------------------
// Drill: user-rate-limited (owner, scenario user-rate-limited)
// ---------------------------------------------------------------------------------------------

async function userRateLimited() {
  const limited = await restError("POST", "/files", 403, "userRateLimitExceeded", { body: { name: "Refused", mimeType: FOLDER } });
  assert.equal(limited.headers.get("retry-after"), "30");
  assert.equal(limited.json.error.errors[0].domain, "usageLimits");
  assert.equal(limited.json.error.message, "User Rate Limit Exceeded");
  await restError("PATCH", `/files/${F(7)}`, 403, "userRateLimitExceeded", { body: { name: "Refused" } });
  await restError("DELETE", `/files/${F(9)}`, 403, "userRateLimitExceeded");
  assert.equal((await rest("GET", `/files/${F(9)}`)).json.trashed, true, "nothing was deleted");
  await restError("POST", `/files/${F(21)}/copy`, 403, "userRateLimitExceeded", { body: {} });
  await restError("POST", `/files/${F(7)}/permissions`, 403, "userRateLimitExceeded", { body: { role: "reader", type: "user", emailAddress: RAVI } });
  await restError("PATCH", `/files/${F(2)}/permissions/${PID.sam}`, 403, "userRateLimitExceeded", { body: { role: "reader" } });
  await restError("DELETE", `/files/${F(2)}/permissions/${PID.sam}`, 403, "userRateLimitExceeded");
  assert.equal(await count("trashed = false"), 25);
  assert.equal((await rest("GET", `/files/${F(3)}`)).json.name, "Billing v2 - design notes");
  await rest("GET", `/files/${F(3)}/export?mimeType=text/plain`);
  assert.equal((await rest("GET", `/files/${F(3)}/permissions`)).json.permissions.length, 3);
  await mcpInit();
  await mcpError("create_file", { title: "Refused" }, "tool.RATE_LIMITED");
  await mcpError("google-drive.files.empty-trash", {}, "tool.RATE_LIMITED");
  assert.equal((await mcp("read_file_content", { fileId: F(3) })).fileContent.length > 0, true);
}

// ---------------------------------------------------------------------------------------------
// Drill: sharing-rate-limited (owner, scenario sharing-rate-limited)
// ---------------------------------------------------------------------------------------------

async function sharingRateLimited() {
  const limited = await restError("POST", `/files/${F(7)}/permissions`, 403, "sharingRateLimitExceeded", { body: { role: "reader", type: "user", emailAddress: RAVI } });
  assert.ok(limited.json.error.message.includes("sharing quota"));
  assert.equal((await rest("PATCH", `/files/${F(2)}/permissions/${PID.sam}`, { body: { role: "reader" } })).json.role, "reader", "other sharing writes still work");
  const folder = (await rest("POST", "/files", { body: { name: "Still allowed", mimeType: FOLDER } })).json;
  await rest("DELETE", `/files/${folder.id}`, { status: 204 });
  assert.equal((await rest("GET", `/files/${F(7)}/permissions`)).json.permissions.length, 2);
}

// ---------------------------------------------------------------------------------------------
// Drill: backend-error (owner, scenario backend-error)
// ---------------------------------------------------------------------------------------------

async function backendError() {
  const failed = await restError("GET", "/files", 500, "backendError");
  assert.equal(failed.json.error.message, "Backend Error");
  await restError("GET", `/files/${F(3)}`, 500, "backendError");
  await restError("POST", "/files", 500, "backendError", { body: { name: "Lost", mimeType: FOLDER } });
  await restError("POST", `/files/${F(21)}/copy`, 500, "backendError", { body: {} });
  await mcpInit();
  await mcpError("search_files", { query: "trashed = false" }, "tool.BACKEND_ERROR");
  await mcpError("get_file_metadata", { fileId: F(3) }, "tool.BACKEND_ERROR");
  assert.equal((await rest("PATCH", `/files/${F(7)}`, { body: { name: "Renamed during the outage" } })).json.version, "7", "the fault is scoped to reads and creates");
  assert.equal((await rest("GET", `/files/${F(3)}/permissions`)).json.permissions.length, 3);
  assert.ok((await mcp("read_file_content", { fileId: F(3) })).fileContent.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Drill: storage-quota-fault (owner, scenario storage-quota-exceeded)
// ---------------------------------------------------------------------------------------------

async function storageQuotaFault() {
  const refused = await restError("POST", `${UPLOAD}/files?uploadType=media`, 403, "storageQuotaExceeded", { absolute: true, body: "ten bytes!", contentType: "text/plain" });
  assert.equal(refused.json.error.message, "The user's Drive storage quota has been exceeded.");
  await restError("PATCH", `${UPLOAD}/files/${F(7)}?uploadType=media`, 403, "storageQuotaExceeded", { absolute: true, body: "x", contentType: "text/markdown" });
  await restError("POST", `/files/${F(21)}/copy`, 403, "storageQuotaExceeded", { body: {} });
  await restError("POST", "/files", 403, "storageQuotaExceeded", { body: { name: "Folder", mimeType: FOLDER } });
  assert.equal(await count("trashed = false"), 25);
  assert.equal((await rest("GET", `/files/${F(7)}`)).json.version, "6");
}

// ---------------------------------------------------------------------------------------------
// Drill: over-bound (owner, scenario over-bound: meta.limits far below the data)
// ---------------------------------------------------------------------------------------------
// Drill: large-pages (owner = Dana, baseline): byte-bounded pages, bounded opaque tokens, export size limit
// ---------------------------------------------------------------------------------------------

const MIB = 1024 * 1024;
const LARGE_COUNT = 70;
const RECENT_COUNT = 35;
const utf8 = (text) => Buffer.byteLength(text, "utf8");

/** Walks a REST list to the end; asserts every body < 1 MiB and every token <= 4096 characters. */
async function walkRest(path, field, pageSize, extra = {}) {
  const seen = new Map();
  let token;
  let pages = 0;
  do {
    const params = { pageSize: String(pageSize), ...extra, ...(token ? { pageToken: token } : {}) };
    const result = await rest("GET", `${path}${path.includes("?") ? "&" : "?"}${q(params)}`);
    assert.ok(utf8(result.text) < MIB, `${path} page ${pages} is ${utf8(result.text)} bytes`);
    for (const item of result.json[field]) {
      const id = item.id ?? `${item.fileId}:${item.time}:${item.removed}`;
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    token = result.json.nextPageToken;
    if (token !== undefined) assert.ok(token.length <= 4096, `token of ${token.length} characters`);
    pages += 1;
    assert.ok(pages < 500, "paging terminates");
  } while (token !== undefined);
  return { seen, pages };
}

async function largePages() {
  const parent = (await rest("POST", "/files", { body: { name: "Large names", mimeType: FOLDER } })).json.id;
  const expected = [];
  for (let index = 0; index < LARGE_COUNT; index += 1) {
    const name = String(index).padStart(4, "0") + "漢".repeat(1020);
    // Half are documents so the same maximal rows also exercise `files.recent`, which never lists folders.
    const created = await op("files.create", {
      name,
      description: "字".repeat(4096),
      mimeType: index % 2 === 0 ? FOLDER : DOC,
      parentId: parent,
    });
    expected.push(created.file?.id ?? created.id);
  }
  const inParent = `'${parent}' in parents`;
  // pageSize 1000: the byte budget splits the list; every folder exactly once.
  const big = await walkRest("/files", "files", 1000, { q: inParent });
  assert.ok(big.pages >= 2, `byte-bounded pages (${big.pages})`);
  assert.deepEqual([...big.seen.keys()].sort(), [...expected].sort());
  assert.ok([...big.seen.values()].every((n) => n === 1));
  // A narrow fields mask only narrows the REST body: /v1/operations and the MCP aliases still send the full entry, so
  // pages are filled against that widest rendering and a masked walk pages exactly like an unmasked one.
  const narrow = await walkRest("/files", "files", 1000, { q: inParent, fields: "files(id),nextPageToken" });
  assert.equal(narrow.pages, big.pages, `masked pages ${narrow.pages} vs full pages ${big.pages}`);
  assert.equal(narrow.seen.size, LARGE_COUNT);
  assert.ok([...narrow.seen.values()].every((n) => n === 1));
  // The same page over the canonical endpoint and over MCP (which carries the value twice) stays under 1 MiB.
  const masked = await op("files.list", { query: inParent, pageSize: 1000, fields: "files(id)" });
  const maskedText = JSON.stringify(masked);
  assert.ok(utf8(maskedText) < MIB, `canonical masked page is ${utf8(maskedText)} bytes`);
  assert.ok(utf8(maskedText) + utf8(JSON.stringify(maskedText)) < MIB, "MCP framing of the masked page exceeds 1 MiB");
  await mcpInit();
  const mcpPage = await mcp("search_files", { query: inParent, pageSize: 1000, fields: "files(id)" });
  assert.ok(utf8(JSON.stringify(mcpPage)) < MIB, "MCP search_files page exceeds 1 MiB");
  assert.equal(mcpPage.files.length, masked.files.length);
  // Malformed percent-encoding in `q` reaches the Tool as U+FFFD: a mangled query is refused, never run empty.
  const mangled = `name contains '漢\uFFFD'`;
  await restError("GET", `/files?${q({ q: mangled })}`, 400, "invalid");
  await restError("GET", `/files?${q({ q: `fullText contains '\uFFFD'` })}`, 400, "invalid");
  await op("files.list", { query: mangled }, "INVALID_ARGUMENT");
  // `%ZZ` stays literal, so it is ordinary text that simply does not match.
  assert.equal((await list({ q: `name contains 'Large names%ZZ'` })).files.length, 0);
  // Correctly encoded accented, CJK and emoji terms still search normally.
  const unicodeId = (await rest("POST", "/files", { body: { name: "Café 漢字 🔥 telemetry", mimeType: DOC } })).json.id;
  for (const term of ["café", "Café", "漢字", "🔥", "telemetry"]) {
    const found = (await list({ q: `name contains '${term}'` })).files;
    assert.deepEqual(ids(found), [unicodeId], `name contains '${term}'`);
  }
  assert.deepEqual(ids((await list({ q: `fullText contains '漢字'` })).files), [unicodeId]);
  // A JSON body nested past the codec's depth guard is refused before argument validation, never a 5xx.
  const deep = "[".repeat(2000) + "]".repeat(2000);
  const nested = await raw("POST", `${V3}/files`, { body: `{"name":"deep","mimeType":"${FOLDER}","appProperties":{"a":${deep}}}` });
  assert.equal(nested.status, 400, `deep body -> ${nested.status} ${nested.text.slice(0, 200)}`);
  assert.ok(!/RangeError|stack/i.test(nested.text), nested.text.slice(0, 200));
  for (const size of [10, 100]) {
    const walk = await walkRest("/files", "files", size, { q: inParent, orderBy: "name desc" });
    assert.equal(walk.seen.size, LARGE_COUNT);
    assert.ok([...walk.seen.values()].every((n) => n === 1));
  }
  // Canonical pages carry the same bounded tokens (never INVALID_TOOL_OUTPUT).
  let token;
  const canonicalSeen = new Set();
  do {
    const page = await op("files.list", { query: inParent, pageSize: 25, orderBy: "name_natural", ...(token ? { pageToken: token } : {}) });
    assert.ok(utf8(JSON.stringify(page)) < MIB);
    for (const file of page.files) canonicalSeen.add(file.id);
    token = page.nextPageToken;
    if (token) assert.ok(token.length <= 4096);
  } while (token);
  assert.equal(canonicalSeen.size, LARGE_COUNT);
  // Live pagination: renaming the page anchor between pages never skips unchanged files whose long names share the
  // anchor's clipped prefix (they may be re-sent, never dropped); ids are created in reverse name order on purpose.
  const shared = (await rest("POST", "/files", { body: { name: "Shared prefix", mimeType: FOLDER } })).json.id;
  const prefix = "Quarterly planning notes 2026 ";
  for (const suffix of ["d", "c", "b"]) await rest("POST", "/files", { body: { name: prefix + suffix, mimeType: FOLDER, parents: [shared] } });
  const inShared = { q: `'${shared}' in parents and trashed = false`, orderBy: "name", pageSize: "1", fields: "files(id,name),nextPageToken" };
  const head = await list(inShared);
  assert.equal(head.files[0].name, prefix + "b");
  await rest("PATCH", `/files/${head.files[0].id}`, { body: { name: "zzz renamed" } });
  const names = new Set();
  for (let token = head.nextPageToken, guard = 0; token !== undefined && guard < 10; guard += 1) {
    const page = await list({ ...inShared, pageToken: token });
    for (const file of page.files) names.add(file.name);
    token = page.nextPageToken;
  }
  assert.deepEqual([...names].sort(), [prefix + "c", prefix + "d", "zzz renamed"]);
  // Forged and tampered tokens answer the invalid page token error.
  const first = await list({ q: inParent, pageSize: 10 });
  const good = first.nextPageToken;
  const flip = good.slice(0, 12) + (good[12] === "A" ? "B" : "A") + good.slice(13);
  const wrongSum = Buffer.from(JSON.stringify({ p: { i: expected[3], d: "00000000", k: [0, "x", "x"] }, c: "00000000" })).toString("base64url");
  for (const forged of [`${good}x`, good.slice(0, -1), flip, wrongSum, "AAAA", `${good}=`]) {
    await restError("GET", `/files?${q({ q: inParent, pageSize: 10, pageToken: forged })}`, 400, "badRequest");
  }
  await op("files.list", { query: inParent, pageSize: 10, pageToken: flip }, "INVALID_PAGE_TOKEN");
  await restError("GET", `/files/${F(7)}/permissions?${q({ pageSize: 2, pageToken: good })}`, 400, "badRequest");
  // The change journal is byte-bounded too.
  const journal = await walkRest("/changes", "changes", 1000, { pageToken: "1" });
  assert.ok(journal.pages >= 2, `byte-bounded change pages (${journal.pages})`);
  // `files.recent` has no REST route: it is served only on the canonical endpoint and the `list_recent_files` alias,
  // so its pages are filled against the MCP-framed entry too. The maximal documents above force a byte split.
  const recent = { seen: new Map(), pages: 0 };
  for (let token; ; ) {
    const page = await op("files.recent", { orderBy: "recency", pageSize: 1000, ...(token ? { pageToken: token } : {}) });
    const text = JSON.stringify(page);
    assert.ok(utf8(text) < MIB, `canonical files.recent page is ${utf8(text)} bytes`);
    assert.ok(utf8(text) + utf8(JSON.stringify(text)) < MIB, `MCP framing of the files.recent page is too large`);
    for (const file of page.files) recent.seen.set(file.id, (recent.seen.get(file.id) ?? 0) + 1);
    recent.pages += 1;
    token = page.nextPageToken;
    if (token === undefined) break;
    assert.ok(token.length <= 4096, `recent token of ${token.length} characters`);
    assert.ok(recent.pages < 100, "files.recent paging terminates");
  }
  assert.ok(recent.pages >= 2, `byte-bounded files.recent pages (${recent.pages})`);
  assert.ok([...recent.seen.values()].every((n) => n === 1), "files.recent repeated a file across pages");
  assert.ok(recent.seen.size >= RECENT_COUNT, `files.recent returned ${recent.seen.size} files`);
  const mcpRecent = await mcp("list_recent_files", { orderBy: "recency", pageSize: 1000 });
  assert.ok(utf8(JSON.stringify(mcpRecent)) < MIB, "MCP list_recent_files page exceeds 1 MiB");
  // An export larger than the inline limit answers Drive's export size error; the plain text export still works.
  // Bounds follow the declared output schemas: files.export data <= 400,000 characters; files.download content is base64
  // <= 400,000 characters, so the exported body may hold at most 300,000 bytes. Just inside and just outside each bound.
  const doc = await op("files.create", { name: "Quotes", mimeType: "application/vnd.google-apps.document", textContent: '"'.repeat(262_144) });
  const docId = doc.file?.id ?? doc.id;
  await restError("GET", `/files/${docId}/export?mimeType=text/html`, 403, "exportSizeLimitExceeded");
  assert.equal(utf8((await rest("GET", `/files/${docId}/export?mimeType=text/plain`)).text), 262_144);
  await op("files.download", { fileId: docId, exportMimeType: "text/html" }, "NOT_EXPORTABLE");
  const WRAP = '<html><head><meta charset="utf-8"></head><body><pre></pre></body></html>'.length;
  const makeDoc = async (name, textContent, mimeType = "application/vnd.google-apps.document") => {
    const made = await op("files.create", { name, mimeType, textContent });
    return made.file?.id ?? made.id;
  };
  const exportInside = Math.floor((400_000 - WRAP) / 4);
  const downloadInside = Math.floor((300_000 - WRAP) / 4);
  const atExport = await makeDoc("Export edge", "<".repeat(exportInside));
  assert.equal((await rest("GET", `/files/${atExport}/export?mimeType=text/html`)).text.length, 400_000 - ((400_000 - WRAP) % 4));
  assert.equal((await op("files.export", { fileId: atExport, mimeType: "text/html" })).data.length, WRAP + 4 * exportInside);
  await op("files.download", { fileId: atExport, exportMimeType: "text/html" }, "NOT_EXPORTABLE");
  const pastExport = await makeDoc("Export past edge", "<".repeat(exportInside + 1));
  await restError("GET", `/files/${pastExport}/export?mimeType=text/html`, 403, "exportSizeLimitExceeded");
  await op("files.export", { fileId: pastExport, mimeType: "text/html" }, "NOT_EXPORTABLE");
  assert.equal((await op("files.export", { fileId: pastExport, mimeType: "text/markdown" })).data.length, exportInside + 1);
  const atDownload = await makeDoc("Download edge", "<".repeat(downloadInside));
  const downloaded = await op("files.download", { fileId: atDownload, exportMimeType: "text/html" });
  assert.ok(downloaded.content.length <= 400_000 && downloaded.content.length > 399_990, `download edge ${downloaded.content.length}`);
  const pastDownload = await makeDoc("Download past edge", "<".repeat(downloadInside + 1));
  await op("files.download", { fileId: pastDownload, exportMimeType: "text/html" }, "NOT_EXPORTABLE");
  assert.ok((await rest("GET", `/files/${pastDownload}/export?mimeType=text/html`)).text.length > 300_000);
  await mcpInit();
  await mcpError("download_file_content", { fileId: pastDownload, exportMimeType: "text/html" }, "tool.NOT_EXPORTABLE");
  // Formats that never grow past the 256 KiB content limit always export and download at full size.
  const sheet = await makeDoc("Wide sheet", 'a,"b""c"\n'.repeat(26_214) + "abcd", "application/vnd.google-apps.spreadsheet");
  for (const format of ["text/csv", "text/tab-separated-values"]) {
    const body = (await rest("GET", `/files/${sheet}/export?mimeType=${encodeURIComponent(format)}`)).text;
    const content = (await op("files.download", { fileId: sheet, exportMimeType: format })).content;
    assert.equal(Buffer.from(content, "base64").toString("utf8"), body);
  }
  const markdown = await makeDoc("Long markdown", "*".repeat(262_144));
  assert.equal((await op("files.download", { fileId: markdown, exportMimeType: "text/markdown" })).content.length, 349_528);
}

// ---------------------------------------------------------------------------------------------

async function overBound() {
  const refused = await restError("GET", "/about", 400, "badRequest");
  assert.ok(refused.json.error.message.includes("bound of 10 files"), refused.json.error.message);
  await restError("GET", "/files", 400, "badRequest");
  await mcpInit();
  await mcpError("list_recent_files", {}, "tool.FAILED_PRECONDITION");
  await restError("POST", "/files", 400, "badRequest", { body: { name: "Too many", mimeType: FOLDER } });
  const deep = await restError("POST", "/files", 400, "badRequest", { body: { name: "Too deep", mimeType: FOLDER, parents: [F(2)] } });
  assert.ok(deep.json.error.message.includes("depth"), deep.json.error.message);
  await restError("PATCH", `/files/${F(2)}`, 400, "badRequest", { body: { trashed: true } });
  await restError("POST", `/files/${F(21)}/copy`, 400, "badRequest", { body: {} });
  await restError("DELETE", `/files/${F(1)}`, 400, "badRequest");
  await mcpError("google-drive.files.empty-trash", {}, "tool.FAILED_PRECONDITION");
  const full = await restError("POST", `/files/${F(3)}/permissions`, 400, "badRequest", { body: { role: "reader", type: "user", emailAddress: "guest@example.org" } });
  assert.ok(full.json.error.message.includes("2 permissions"), full.json.error.message);
  // Point reads and point writes keep working: nothing is served truncated, nothing is blocked needlessly.
  assert.equal((await rest("GET", `/files/${F(3)}`)).json.name, "Billing v2 - design notes");
  assert.equal((await rest("GET", `/files/${F(3)}/permissions`)).json.permissions.length, 3);
  await rest("GET", `/files/${F(3)}/export?mimeType=text/plain`);
  assert.equal((await rest("PATCH", `/files/${F(7)}`, { body: { name: "Renamed within bounds" } })).json.version, "7");
  await rest("DELETE", `/files/${F(9)}`, { status: 204 });
  await restError("GET", `/files/${F(9)}`, 404, "notFound");
}

// ---------------------------------------------------------------------------------------------
// Drill: cyclic-parents (colleague, scenario cyclic-parents: Projects -> Archive -> Projects)
// Sam is not the owner of the files in the cycle, so every access check walks the ancestor chain. A cycle can never
// be produced through the API, so this scenario is the only way to reach the
// ancestor-chain bound. Every such read must answer the declared FAILED_PRECONDITION rather
// than loop or throw a raw runtime error; files outside the cycle keep working.

async function cyclicParents() {
  const cyclic = (result) => {
    assert.ok(result.json.error.message.includes("cyclic or deeper"), result.json.error.message);
    return result;
  };
  // Point reads inside the cycle: metadata, media, export, and the permission reads that share the access path.
  cyclic(await restError("GET", `/files/${F(3)}`, 400, "badRequest"));
  cyclic(await restError("GET", `/files/${F(6)}?alt=media`, 400, "badRequest"));
  cyclic(await restError("GET", `/files/${F(3)}/export?mimeType=text/plain`, 400, "badRequest"));
  cyclic(await restError("GET", `/files/${F(3)}/permissions`, 400, "badRequest"));
  cyclic(await restError("GET", `/files/${F(3)}/permissions/06000000000000000001`, 400, "badRequest"));
  cyclic(await restError("GET", "/changes?pageToken=1", 400, "badRequest"));
  // The canonical operations that have no route of their own answer the same declared error.
  await op("files.download", { fileId: F(6) }, "FAILED_PRECONDITION");
  await op("files.read-content", { fileId: F(7) }, "FAILED_PRECONDITION");
  // Outside the cycle nothing changes: a file Sam owns still resolves.
  assert.equal((await rest("GET", `/files/${F(21)}`)).json.id, F(21));
}

// ---------------------------------------------------------------------------------------------

const flows = {
  "rest-flow": restFlow,
  "large-pages": largePages,
  "mcp-aliases": mcpAliases,
  "sharing-roles": sharingRoles,
  "fresh-install": freshInstall,
  "user-rate-limited": userRateLimited,
  "sharing-rate-limited": sharingRateLimited,
  "backend-error": backendError,
  "storage-quota-fault": storageQuotaFault,
  "over-bound": overBound,
  "cyclic-parents": cyclicParents,
  quota,
  denied,
};
const selected = Object.keys(flows).find((name) => instruction.includes(name));
if (selected === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
