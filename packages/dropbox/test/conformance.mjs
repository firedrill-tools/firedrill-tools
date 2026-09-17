// Dropbox Tool conformance target: a scripted Tool test, not a model-driven agent. Node built-ins only.
// Calls the Dropbox API v2-shaped routes (JSON RPC bodies, Dropbox-API-Arg for content routes, Bearer token) at
// FIREDRILL_HTTP_URL. Each drill instruction names one flow ("Run the <flow> flow ..."); every flow throws on any
// unexpected status, header or body.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const instruction = String(JSON.parse(task).instruction ?? "");
const flow = /Run the ([a-z-]+) flow/.exec(instruction)?.[1];
const BASE = process.env.FIREDRILL_HTTP_URL;
const TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
assert.ok(BASE && TOKEN, "the HTTP binding is required");

// Seeded facts (see starter.json).
const MAYA = `dbid:AAAmaya${"0".repeat(32)}1`;
const JONAS = `dbid:AABjonas${"0".repeat(31)}2`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const dropboxHash = (bytes) => {
  const blocks = [];
  for (let i = 0; i < bytes.length; i += 4 * 1024 * 1024) blocks.push(sha256(bytes.subarray(i, i + 4 * 1024 * 1024)));
  return createHash("sha256").update(Buffer.concat(blocks)).digest("hex");
};

function parse(text) {
  try {
    return text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
}

/** Checks a Dropbox error body: 400/500 text, 401/403/409/429 JSON with error_summary starting with `summary`. */
function checkError(label, status, text, json, summary) {
  if (status === 400) {
    assert.match(text, /^Error in call to API function "[a-z_/0-9]+": /, `${label}: 400 text body: ${text.slice(0, 200)}`);
    if (summary !== undefined) assert.ok(text.includes(summary), `${label}: 400 text should mention ${summary}: ${text.slice(0, 300)}`);
    return;
  }
  if (status === 500) return assert.equal(text, "Internal Server Error", label);
  assert.equal(typeof json?.error_summary, "string", `${label}: error_summary in ${text.slice(0, 300)}`);
  assert.ok(json.error_summary.endsWith("/..."), `${label}: summary padding ${json.error_summary}`);
  if (summary !== undefined) assert.ok(json.error_summary.startsWith(summary), `${label}: expected ${summary}, got ${json.error_summary}`);
}

/** RPC call: POST /2/<fn> with a JSON body. `expect` is a status or [status, summary]. */
async function rpc(fn, body, expect = 200, headers = {}) {
  const [status, summary] = Array.isArray(expect) ? expect : [expect];
  const init = { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, ...headers } };
  if (body !== undefined) {
    init.headers["content-type"] ??= "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const response = await fetch(`${BASE}/2/${fn}`, init);
  const text = await response.text();
  const json = parse(text);
  assert.equal(response.status, status, `${fn} ${JSON.stringify(body)?.slice(0, 200)} → ${response.status} ${text.slice(0, 400)}`);
  if (status >= 400) checkError(fn, status, text, json, summary);
  return { body: json, text, headers: response.headers };
}

/** JSON for an HTTP header: every non-ASCII UTF-16 unit escaped, as Dropbox requires. */
function asciiArg(value) {
  const text = JSON.stringify(value);
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out += code >= 0x7f ? `${String.fromCharCode(92)}u${code.toString(16).padStart(4, "0")}` : text[i];
  }
  return out;
}

/** Content upload: arguments in Dropbox-API-Arg, text content in the body. */
async function upload(args, content, expect = 200, { query = false, headers = {} } = {}) {
  const [status, summary] = Array.isArray(expect) ? expect : [expect];
  const arg = asciiArg(args);
  const url = query ? `${BASE}/2/files/upload?arg=${encodeURIComponent(arg)}` : `${BASE}/2/files/upload`;
  const init = { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream", ...(query ? {} : { "dropbox-api-arg": arg }), ...headers }, body: content };
  const response = await fetch(url, init);
  const text = await response.text();
  const json = parse(text);
  assert.equal(response.status, status, `upload ${arg.slice(0, 200)} → ${response.status} ${text.slice(0, 400)}`);
  if (status >= 400) checkError("upload", status, text, json, summary);
  return { body: json, headers: response.headers };
}

/** Content download: returns { bytes, metadata } on 200. */
async function download(args, expect = 200) {
  const [status, summary] = Array.isArray(expect) ? expect : [expect];
  const arg = asciiArg(args);
  const response = await fetch(`${BASE}/2/files/download`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "dropbox-api-arg": arg } });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, status, `download ${arg} → ${response.status} ${bytes.toString("utf8").slice(0, 300)}`);
  if (status !== 200) {
    const text = bytes.toString("utf8");
    checkError("download", status, text, parse(text), summary);
    return {};
  }
  const header = response.headers.get("dropbox-api-result");
  assert.ok(header && /^[\x20-\x7e]+$/.test(header), "Dropbox-API-Result is ASCII JSON");
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  const metadata = JSON.parse(header);
  assert.equal(metadata.size, bytes.length, "size matches the body");
  assert.equal(metadata.content_hash, dropboxHash(bytes), "content_hash matches the body");
  return { bytes, metadata, headers: response.headers };
}

const names = (entries) => entries.map((entry) => entry.name);
const FLOWS = {};

FLOWS.browse = async () => {
  const account = await rpc("users/get_current_account", "null");
  assert.equal(account.body.account_id, MAYA);
  assert.equal(account.body.email, "maya.chen@example.test");
  assert.equal(account.body.server_time, undefined, "server_time is canonical-only");
  assert.deepEqual((await rpc("users/get_space_usage")).body, { used: 12853, allocation: { ".tag": "individual", allocated: 2147483648 } });

  const root = await rpc("files/list_folder", { path: "" });
  assert.deepEqual(names(root.body.entries), ["Contracts", "Invoices", "Personal", "Photos", "Projects", "README.txt", "Team Notes"]);
  assert.equal(root.body.has_more, false);
  const withDeleted = await rpc("files/list_folder", { path: "", include_deleted: true });
  assert.equal(withDeleted.body.entries.find((e) => e.name === "Old draft.txt")[".tag"], "deleted");
  const recursive = await rpc("files/list_folder", { path: "", recursive: true });
  assert.equal(recursive.body.entries.length, 31);
  const sub = await rpc("files/list_folder", { path: "/Projects/Atlas Launch", recursive: true });
  assert.equal(sub.body.entries[0].path_lower, "/projects/atlas launch", "a recursive non-root listing includes the folder itself");

  let page = await rpc("files/list_folder", { path: "/invoices", limit: 3 });
  const seen = [...names(page.body.entries)];
  while (page.body.has_more) {
    page = await rpc("files/list_folder/continue", { cursor: page.body.cursor });
    seen.push(...names(page.body.entries));
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7].map((m) => `invoice-2026-0${m}.txt`));
  const idle = await rpc("files/list_folder/continue", { cursor: page.body.cursor });
  assert.deepEqual(idle.body.entries, []);
  await rpc("files/list_folder/continue", { cursor: `${page.body.cursor.slice(0, -1)}${page.body.cursor.endsWith("0") ? "1" : "0"}` }, [400, 'Invalid "cursor"']);
  await rpc("files/list_folder/continue", { cursor: "not-a-cursor-at-all-xx" }, [400]);
  assert.deepEqual((await rpc("files/list_folder", { path: "/Projects/Archive" })).body.entries, []);
  await rpc("files/list_folder", { path: "/README.txt" }, [409, "path/not_folder"]);
  await rpc("files/list_folder", { path: "/nope" }, [409, "path/not_found"]);
  await rpc("files/list_folder", { path: "Projects" }, [409, "path/malformed_path"]);
  await rpc("files/list_folder", { path: "" }, [400, "Content-Type"], { "content-type": "text/html" });
  await rpc("files/list_folder", { path: "", shared_link: { url: "x" } }, [400]);

  const latest = await rpc("files/list_folder/get_latest_cursor", { path: "/Personal", recursive: true });
  assert.deepEqual((await rpc("files/list_folder/continue", { cursor: latest.body.cursor })).body, { entries: [], cursor: (await rpc("files/list_folder/continue", { cursor: latest.body.cursor })).body.cursor, has_more: false });
  await rpc("files/list_folder/get_latest_cursor", { path: "/README.txt" }, [409, "path/not_folder"]);
  await rpc("files/list_folder/get_latest_cursor", { path: "/nope" }, [409, "path/not_found"]);
  await rpc("files/list_folder/get_latest_cursor", { path: "nope" }, [409, "path/malformed_path"]);

  const brief = await rpc("files/get_metadata", { path: "/projects/ATLAS LAUNCH/Brief.md" });
  assert.equal(brief.body.path_display, "/Projects/Atlas Launch/brief.md");
  assert.equal((await rpc("files/get_metadata", { path: brief.body.id })).body.rev, brief.body.rev);
  assert.equal((await rpc("files/get_metadata", { path: "rev:0015f8a3c00000001" })).body.size, 128);
  await rpc("files/get_metadata", { path: "/Old draft.txt" }, [409, "path/not_found"]);
  assert.equal((await rpc("files/get_metadata", { path: "/Old draft.txt", include_deleted: true })).body[".tag"], "deleted");
  await rpc("files/get_metadata", { path: "" }, [409, "path/malformed_path"]);

  const current = await download({ path: "/Projects/Atlas Launch/brief.md" });
  assert.ok(current.bytes.toString("utf8").includes("60% weekly retention"));
  assert.equal(current.metadata.rev, brief.body.rev);
  const first = await download({ path: "/Projects/Atlas Launch/brief.md", rev: "0015f8a3c00000001" });
  assert.ok(first.bytes.toString("utf8").startsWith("# Atlas Launch brief (draft)"));
  const hero = await download({ path: "/Projects/Atlas Launch/assets/hero.png" });
  assert.deepEqual([...hero.bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pdf = await download({ path: "/Personal/Tax 2025.pdf" });
  assert.equal(pdf.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  const pate = await download({ path: "/Personal/Recipes/Pâté en croûte.txt" });
  assert.ok(pate.headers.get("dropbox-api-result").includes("P\\u00e2t\\u00e9"));
  assert.equal(pate.metadata.name, "Pâté en croûte.txt");
  await download({ path: "/Projects" }, [409, "path/not_file"]);
  await download({ path: "/Projects/Atlas Launch/brief.md", rev: "0015f8a3cffffffff" }, [409, "path/not_found"]);
  await download({ path: "no-slash" }, [409, "path/malformed_path"]);

  const retention = await rpc("files/search_v2", { query: "retention" });
  assert.deepEqual(retention.body.matches.map((m) => [m.metadata.metadata.name, m.match_type[".tag"]]), [["brief.md", "file_content"]]);
  assert.equal((await rpc("files/search_v2", { query: "PATE" })).body.matches[0].metadata.metadata.name, "Pâté en croûte.txt");
  const invoices = await rpc("files/search_v2", { query: "invoice", options: { path: "/Invoices", max_results: 5 } });
  assert.equal(invoices.body.matches.length, 5);
  assert.equal(invoices.body.has_more, true);
  const more = await rpc("files/search/continue_v2", { cursor: invoices.body.cursor });
  assert.equal(more.body.matches.length, 2);
  assert.equal(more.body.has_more, false);
  assert.deepEqual((await rpc("files/search_v2", { query: "tax", options: { file_categories: [{ ".tag": "pdf" }] } })).body.matches.map((m) => m.metadata.metadata.name), ["Tax 2025.pdf"]);
  const photos = await rpc("files/search_v2", { query: "img", options: { file_extensions: ["jpg"], order_by: "last_modified_time" } });
  assert.deepEqual(photos.body.matches.map((m) => m.metadata.metadata.name), ["IMG_0403.jpg", "IMG_0402.jpg", "IMG_0401.jpg"]);
  assert.deepEqual((await rpc("files/search_v2", { query: "draft", options: { file_status: "deleted" } })).body.matches.map((m) => m.metadata.metadata[".tag"]), ["deleted"]);
  assert.equal((await rpc("files/search_v2", { query: "termination", options: { filename_only: true } })).body.matches.length, 0);
  assert.equal((await rpc("files/search_v2", { query: "termination" })).body.matches[0].metadata.metadata.name, "Vendor agreement v2.txt");
  await rpc("files/search_v2", { query: " ... " }, [409, "invalid_argument"]);
  await rpc("files/search_v2", { query: "x", options: { path: "/nope" } }, [409, "path/not_found"]);
  await rpc("files/search_v2", { query: "x", options: { path: "/README.txt" } }, [409, "path/not_folder"]);
  await rpc("files/search_v2", { query: "x", options: { path: "nope" } }, [409, "path/malformed_path"]);
  await rpc("files/search/continue_v2", { cursor: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, [400]);

  const revisions = await rpc("files/list_revisions", { path: "/Projects/Atlas Launch/brief.md" });
  assert.deepEqual(revisions.body.entries.map((e) => e.rev), ["0015f8a3c00000003", "0015f8a3c00000002", "0015f8a3c00000001"]);
  assert.equal(revisions.body.is_deleted, false);
  const oldDraft = await rpc("files/list_revisions", { path: "/Old draft.txt", limit: 1 });
  assert.equal(oldDraft.body.is_deleted, true);
  assert.equal(oldDraft.body.server_deleted, "2026-09-02T10:00:00Z");
  assert.equal(oldDraft.body.entries.length, 1);
  await rpc("files/list_revisions", { path: "/Projects" }, [409, "path/not_file"]);
  await rpc("files/list_revisions", { path: "/nope.txt" }, [409, "path/not_found"]);
  await rpc("files/list_revisions", { path: "nope" }, [409, "path/malformed_path"]);

  const links = await rpc("sharing/list_shared_links", {});
  assert.equal(links.body.links.length, 4);
  assert.equal(links.body.links.find((l) => l.name === "Vendor agreement v2.txt").expires, "2026-09-01T00:00:00Z");
  assert.equal(links.body.links.find((l) => l.name === "2026-08 Offsite").link_permissions.require_password, true);
  const direct = await rpc("sharing/list_shared_links", { path: "/Projects/Atlas Launch/Launch notes (Q3).txt", direct_only: true });
  assert.deepEqual(direct.body.links.map((l) => l.name), ["Launch notes (Q3).txt"]);
  const inherited = await rpc("sharing/list_shared_links", { path: "/Projects/Atlas Launch/brief.md" });
  assert.deepEqual(inherited.body.links.map((l) => [l[".tag"], l.name]), [["folder", "Atlas Launch"]]);
  await rpc("sharing/list_shared_links", { cursor: "bm90LWEtY3Vyc29yLWF0LWFsbA" }, [400]);
  await rpc("sharing/list_shared_links", { path: "/nope" }, [409, "path/not_found"]);
  await rpc("sharing/list_shared_links", { path: "nope" }, [409, "path/malformed_path"]);
};

/** Calls every operation once (schema-valid arguments) and expects the same error on each. */
async function everyCall(status, summary) {
  const expect = [status, summary];
  const calls = [
    () => rpc("users/get_current_account", undefined, expect),
    () => rpc("users/get_space_usage", undefined, expect),
    () => rpc("files/list_folder", { path: "" }, expect),
    () => rpc("files/list_folder/continue", { cursor: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, expect),
    () => rpc("files/list_folder/get_latest_cursor", { path: "" }, expect),
    () => rpc("files/get_metadata", { path: "/README.txt" }, expect),
    () => rpc("files/create_folder_v2", { path: "/Denied" }, expect),
    () => upload({ path: "/Denied.txt" }, "denied", expect),
    () => download({ path: "/README.txt" }, expect),
    () => rpc("files/delete_v2", { path: "/README.txt" }, expect),
    () => rpc("files/move_v2", { from_path: "/README.txt", to_path: "/README2.txt" }, expect),
    () => rpc("files/copy_v2", { from_path: "/README.txt", to_path: "/README2.txt" }, expect),
    () => rpc("files/search_v2", { query: "readme" }, expect),
    () => rpc("files/search/continue_v2", { cursor: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, expect),
    () => rpc("files/list_revisions", { path: "/README.txt" }, expect),
    () => rpc("files/restore", { path: "/README.txt", rev: "0015f8a3c00000011" }, expect),
    () => rpc("sharing/create_shared_link_with_settings", { path: "/README.txt" }, expect),
    () => rpc("sharing/list_shared_links", {}, expect),
    () => rpc("sharing/revoke_shared_link", { url: "https://www.dropbox.com/scl/fi/000000000000000/x?dl=0" }, expect),
  ];
  assert.equal(calls.length, 19, "one call per operation");
  for (const call of calls) await call();
}

FLOWS["fresh-install"] = async () => {
  assert.equal((await rpc("users/get_current_account")).body.account_id, MAYA, "an actor without identity attributes acts as the first seeded account");
  assert.equal((await rpc("files/list_folder", { path: "" })).body.entries.length, 7);
};

FLOWS["no-scopes"] = async () => {
  await everyCall(401, "missing_scope");
  const response = await fetch(`${BASE}/2/files/upload`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream", "dropbox-api-arg": '{"path":"/x.txt"}' }, body: "x" });
  assert.deepEqual(await response.json(), { error_summary: "missing_scope/...", error: { ".tag": "missing_scope", required_scope: "files.content.write" } });
};

FLOWS.ghost = async () => {
  await everyCall(401, "invalid_access_token");
};

FLOWS.denied = async () => {
  await rpc("users/get_current_account", undefined, [403, "no_permission"]);
  await rpc("files/list_folder", { path: "" }, [403, "no_permission"]);
  await upload({ path: "/Denied.txt" }, "denied", [403, "no_permission"]);
};

FLOWS.quota = async () => {
  assert.equal((await rpc("users/get_current_account")).body.account_id, JONAS);
  const usage = (await rpc("users/get_space_usage")).body;
  assert.equal(usage.allocation.allocated, 65536);
  assert.equal(usage.used, 60690);
  assert.deepEqual(names((await rpc("files/list_folder", { path: "" })).body.entries), ["Designs", "Private notes.txt", "Projects"]);
  assert.deepEqual((await rpc("files/list_folder", { path: "/Projects" })).body.entries, [], "the same folder name in another account is a different, empty folder");
  await upload({ path: "/Big.txt" }, "x".repeat(8192), [409, "path/insufficient_space"]);
  await rpc("files/copy_v2", { from_path: "/Designs/moodboard.png", to_path: "/Designs/moodboard copy.png" }, [409, "insufficient_quota"]);
  const notes = await rpc("files/list_revisions", { path: "/Private notes.txt" });
  assert.equal(notes.body.entries.length, 2);
  await rpc("files/restore", { path: "/Private notes.txt", rev: notes.body.entries[1].rev }, [409, "path_write/insufficient_space"]);
  await rpc("files/get_metadata", { path: "id:AAAAAAAAAAAAAAAAAAAAAw" }, [409, "path/not_found"]);
  await rpc("files/list_folder", { path: "/Invoices" }, [409, "path/not_found"]);
  const mayaLink = "https://www.dropbox.com/scl/fi/27cafc000000001/Launch%20notes%20(Q3).txt?rlkey=dd9be554a2ae08e0&dl=0";
  await rpc("sharing/revoke_shared_link", { url: mayaLink }, [409, "shared_link_not_found"]);
  assert.equal((await upload({ path: "/Small.txt" }, "fits")).body.size, 4, "an upload that fits the quota still works");
  assert.equal((await rpc("users/get_space_usage")).body.used, 60694);
};

const localHash = (text) => dropboxHash(Buffer.from(text, "utf8"));
const names0 = (body) => body.entries.map((e) => e.path_lower);

// files.changed events emitted by this flow: counted in comments (E1..E15); the drill asserts the total.
FLOWS["write-flow"] = async () => {
  const latest = (await rpc("files/list_folder/get_latest_cursor", { path: "", recursive: true })).body.cursor;
  const created = await rpc("files/create_folder_v2", { path: "/Clients/Northwind" }); // E1
  assert.equal(created.body.metadata.path_display, "/Clients/Northwind");
  assert.equal((await rpc("files/get_metadata", { path: "/clients" })).body[".tag"], "folder", "implicit parent created");
  await rpc("files/create_folder_v2", { path: "/Clients/Northwind" }, [409, "path/conflict/folder"]);
  await rpc("files/create_folder_v2", { path: "/team notes" }, [409, "path/conflict/folder"]);
  assert.equal((await rpc("files/create_folder_v2", { path: "/team notes", autorename: true })).body.metadata.name, "team notes (1)"); // E2
  await rpc("files/create_folder_v2", { path: "/README.txt/x" }, [409, "path/conflict/file_ancestor"]);
  await rpc("files/create_folder_v2", { path: "/Clients/Bad name." }, [409, "path/disallowed_name"]);
  await rpc("files/create_folder_v2", { path: "Clients" }, [409, "path/malformed_path"]);

  const plan = "Kickoff plan for Northwind\n";
  const first = await upload({ path: "/Clients/Northwind/plan.txt", content_hash: localHash(plan) }, plan); // E3
  assert.equal(first.body.content_hash, localHash(plan));
  assert.equal(first.body.size, Buffer.byteLength(plan));
  assert.equal((await upload({ path: "/clients/northwind/PLAN.txt", mode: "add" }, plan)).body.rev, first.body.rev, "identical content is a no-op");
  await upload({ path: "/Clients/Northwind/plan.txt", mode: "add" }, "Different plan\n", [409, "path/conflict/file"]);
  assert.equal((await upload({ path: "/Clients/Northwind/plan.txt", autorename: true }, "Different plan\n")).body.name, "plan (1).txt"); // E4
  const overwritten = await upload({ path: "/Clients/Northwind/plan.txt", mode: { ".tag": "overwrite" } }, "Plan v2\n"); // E5
  assert.notEqual(overwritten.body.rev, first.body.rev);
  assert.equal(overwritten.body.id, first.body.id);
  await upload({ path: "/Clients/Northwind/plan.txt", mode: { ".tag": "update", update: first.body.rev } }, "Plan v3\n", [409, "path/conflict/file"]);
  const updated = await upload({ path: "/Clients/Northwind/plan.txt", mode: { ".tag": "update", update: overwritten.body.rev }, client_modified: "2026-09-13T08:00:00Z" }, "Plan v3\n"); // E6
  assert.equal(updated.body.client_modified, "2026-09-13T08:00:00Z");
  await upload({ path: "/Clients/Northwind/other.txt", content_hash: "0".repeat(64) }, "x", [400, "content_hash_mismatch"]);
  await upload({ path: "/Clients/Northwind/other.txt", client_modified: "2026-02-31T00:00:00Z" }, "x", [400, "client_modified"]);
  await upload({ path: "/Clients/Northwind/other.txt" }, "x", [400, "not both"], { query: true, headers: { "dropbox-api-arg": '{"path":"/a.txt"}' } });
  await upload({ path: "Clients/other.txt" }, "x", [409, "path/malformed_path"]);
  await upload({ path: "/Clients/desktop.ini" }, "x", [409, "path/disallowed_name"]);
  assert.equal((await upload({ path: "/Clients/Northwind/query.txt" }, "via arg\n", 200, { query: true })).body.size, 8); // E7
  assert.equal((await download({ path: "/Clients/Northwind/plan.txt" })).bytes.toString("utf8"), "Plan v3\n");
  const deep = `/Clients/${Array.from({ length: 6 }, () => String.fromCharCode(0x6bb5).repeat(250)).join("/")}/f.txt`;
  assert.equal((await upload({ path: deep }, "deep\n")).body.path_display, deep); // E15
  assert.equal((await rpc("files/get_metadata", { path: deep })).body.size, 5);
  await download({ path: deep }, [400, "Dropbox-API-Result"]);
  await rpc("sharing/create_shared_link_with_settings", { path: "/Clients/\ud800" }, [409, "path/malformed_path"]);

  const changes = await rpc("files/list_folder/continue", { cursor: latest });
  for (const path of ["/clients", "/clients/northwind", "/clients/northwind/plan.txt", "/clients/northwind/plan (1).txt", "/clients/northwind/query.txt", "/team notes (1)"]) {
    assert.ok(names0(changes.body).includes(path), `change feed lists ${path}: ${names0(changes.body)}`);
  }

  const vendor = await rpc("files/get_metadata", { path: "/Contracts/Vendor agreement v2.txt" });
  const moved = await rpc("files/move_v2", { from_path: "/Contracts/Vendor agreement v2.txt", to_path: "/Projects/Atlas Launch/Vendor agreement v2.txt" }); // E8
  assert.equal(moved.body.metadata.id, vendor.body.id);
  assert.equal(moved.body.metadata.rev, vendor.body.rev);
  const followed = await rpc("sharing/list_shared_links", { path: "/Projects/Atlas Launch/Vendor agreement v2.txt", direct_only: true });
  assert.equal(followed.body.links[0].path_lower, "/projects/atlas launch/vendor agreement v2.txt", "the link follows the moved file");
  await rpc("files/move_v2", { from_path: "/Projects/Atlas Launch", to_path: "/Projects/Atlas Launch/assets/inner" }, [409, "cant_move_folder_into_itself"]);
  await rpc("files/move_v2", { from_path: "/README.txt", to_path: "/Team Notes" }, [409, "to/conflict/folder"]);
  await rpc("files/move_v2", { from_path: "/README.txt", to_path: "/README.txt" }, [409, "duplicated_or_nested_paths"]);
  await rpc("files/move_v2", { from_path: "README.txt", to_path: "/x.txt" }, [409, "from_lookup/malformed_path"]);
  await rpc("files/move_v2", { from_path: "/nope.txt", to_path: "/x.txt" }, [409, "from_lookup/not_found"]);
  await rpc("files/move_v2", { from_path: "/README.txt", to_path: "/Clients/bad." }, [409, "to/disallowed_name"]);
  assert.equal((await rpc("files/move_v2", { from_path: "/Team Notes/Weekly sync.TXT", to_path: "/Team Notes/weekly sync.txt" })).body.metadata.path_display, "/Team Notes/weekly sync.txt"); // E9

  const copied = await rpc("files/copy_v2", { from_path: "/Invoices", to_path: "/Invoices 2025" }); // E10
  const copies = await rpc("files/list_folder", { path: "/Invoices 2025" });
  assert.equal(copies.body.entries.length, 7);
  const originals = await rpc("files/list_folder", { path: "/Invoices" });
  assert.notEqual(copies.body.entries[0].id, originals.body.entries[0].id, "copies get new ids");
  assert.equal(copies.body.entries[0].content_hash, originals.body.entries[0].content_hash);
  assert.notEqual(copied.body.metadata.id, undefined);
  await rpc("files/copy_v2", { from_path: "nope", to_path: "/x" }, [409, "from_lookup/malformed_path"]);
  await rpc("files/copy_v2", { from_path: "/nope", to_path: "/x" }, [409, "from_lookup/not_found"]);
  await rpc("files/copy_v2", { from_path: "/Invoices", to_path: "/Personal" }, [409, "to/conflict/folder"]);
  await rpc("files/copy_v2", { from_path: "/Invoices", to_path: "/Invoices/inner" }, [409, "cant_move_folder_into_itself"]);
  await rpc("files/copy_v2", { from_path: "/Invoices", to_path: "/Invoices" }, [409, "duplicated_or_nested_paths"]);
  await rpc("files/copy_v2", { from_path: "/Invoices", to_path: "/thumbs.db" }, [409, "to/disallowed_name"]);

  const searchCursor = (await rpc("files/search_v2", { query: "invoice", options: { path: "/Invoices 2025", max_results: 2 } })).body.cursor;
  const listCursor = (await rpc("files/list_folder", { path: "/Invoices 2025", limit: 2 })).body.cursor;
  await rpc("files/delete_v2", { path: "/Invoices 2025" }); // E11
  await rpc("files/search/continue_v2", { cursor: searchCursor }, [409, "path/not_found"]);
  await rpc("files/list_folder/continue", { cursor: listCursor }, [409, "path/not_found"]);
  await rpc("files/delete_v2", { path: "/Invoices 2025" }, [409, "path_lookup/not_found"]);
  await rpc("files/delete_v2", { path: "/README.txt", parent_rev: "0015f8a3c00000001" }, [409, "path_write/conflict/file"]);
  await rpc("files/delete_v2", { path: "README.txt" }, [409, "path_lookup/malformed_path"]);
  assert.equal((await rpc("files/list_folder", { path: "/Invoices 2025/invoice-2026-01.txt".slice(0, 14), include_deleted: true }, [409, "path/not_found"])).body.error[".tag"], "path");

  const restored = await rpc("files/restore", { path: "/Old draft.txt", rev: "0015f8a3c00000012" }); // E12
  assert.equal((await download({ path: "/Old draft.txt" })).metadata.rev, restored.body.rev);
  assert.equal(restored.body.size, Buffer.byteLength("Old draft\n\nFirst attempt at the Atlas announcement post.\n"));
  await rpc("files/restore", { path: "/Old draft.txt", rev: "0015f8a3c00000001" }, [409, "invalid_revision"]);
  await rpc("files/restore", { path: "/never-existed.txt", rev: "0015f8a3c00000001" }, [409, "path_lookup/not_found"]);
  await rpc("files/restore", { path: "Old draft.txt", rev: "0015f8a3c00000001" }, [409, "path_lookup/malformed_path"]);
  await rpc("files/delete_v2", { path: "/Old draft.txt" }); // E13
  await rpc("files/create_folder_v2", { path: "/Old draft.txt" }); // E14
  await rpc("files/restore", { path: "/Old draft.txt", rev: "0015f8a3c00000012" }, [409, "path_write/conflict/folder"]);

  const feed = await rpc("files/list_folder/continue", { cursor: changes.body.cursor });
  assert.equal(feed.body.entries.find((e) => e.path_lower === "/invoices 2025")?.[".tag"], "deleted", "the change feed reports the deleted copy");
  await FLOWS.sharing();
};

FLOWS.sharing = async () => {
  const plan = await rpc("files/get_metadata", { path: "/Clients/Northwind/plan.txt" });
  const link = await rpc("sharing/create_shared_link_with_settings", { path: "/Clients/Northwind/plan.txt" });
  assert.match(link.body.url, /^https:\/\/www\.dropbox\.com\/scl\/fi\/[0-9a-z]{15}\/plan\.txt\?rlkey=[0-9a-f]{16}&dl=0$/);
  assert.equal(link.body.rev, plan.body.rev);
  assert.equal(link.body.link_permissions.resolved_visibility[".tag"], "public");
  const exists = await rpc("sharing/create_shared_link_with_settings", { path: plan.body.id }, [409, "shared_link_already_exists"]);
  assert.equal(exists.body.error.shared_link_already_exists.metadata.url, link.body.url);
  await rpc("sharing/create_shared_link_with_settings", { path: "/README.txt", settings: { requested_visibility: "password" } }, [409, "settings_error/invalid_settings"]);
  await rpc("sharing/create_shared_link_with_settings", { path: "/README.txt", settings: { requested_visibility: { ".tag": "team_only" } } }, [409, "settings_error/not_authorized"]);
  await rpc("sharing/create_shared_link_with_settings", { path: "/README.txt", settings: { expires: "2026-01-01T00:00:00Z" } }, [409, "settings_error/invalid_settings"]);
  await rpc("sharing/create_shared_link_with_settings", { path: "/nope" }, [409, "path/not_found"]);
  await rpc("sharing/create_shared_link_with_settings", { path: "nope" }, [409, "path/malformed_path"]);
  const protectedLink = await rpc("sharing/create_shared_link_with_settings", {
    path: "/Team Notes", settings: { requested_visibility: { ".tag": "password" }, link_password: "synthetic-only", expires: "2026-12-01T00:00:00Z" },
  });
  assert.equal(protectedLink.body[".tag"], "folder");
  assert.equal(protectedLink.body.link_permissions.require_password, true);
  assert.equal(protectedLink.body.expires, "2026-12-01T00:00:00Z");
  assert.equal((await rpc("sharing/list_shared_links", {})).body.links.length, 6);
  const revoked = await rpc("sharing/revoke_shared_link", { url: link.body.url });
  assert.equal(revoked.body, null);
  await rpc("sharing/revoke_shared_link", { url: link.body.url }, [409, "shared_link_not_found"]);
  await rpc("sharing/revoke_shared_link", { url: "https://example.test/x" }, [409, "shared_link_malformed"]);
  assert.equal((await rpc("sharing/list_shared_links", {})).body.links.length, 5);
};

async function rateLimited(call, reason) {
  const { body, headers } = await call();
  assert.equal(headers.get("retry-after"), "1");
  assert.deepEqual(body, { error_summary: `${reason}/...`, error: { reason: { ".tag": reason }, retry_after: 1 } });
}

FLOWS["rate-limited"] = async () => {
  const e = [429, "too_many_requests"];
  await rateLimited(() => upload({ path: "/Limited.txt" }, "x", e), "too_many_requests");
  await rateLimited(() => rpc("files/create_folder_v2", { path: "/Limited" }, e), "too_many_requests");
  await rateLimited(() => rpc("files/delete_v2", { path: "/README.txt" }, e), "too_many_requests");
  await rateLimited(() => rpc("files/move_v2", { from_path: "/README.txt", to_path: "/R.txt" }, e), "too_many_requests");
  await rateLimited(() => rpc("files/copy_v2", { from_path: "/README.txt", to_path: "/R.txt" }, e), "too_many_requests");
  await rateLimited(() => rpc("files/restore", { path: "/Old draft.txt", rev: "0015f8a3c00000012" }, e), "too_many_requests");
  await rateLimited(() => rpc("sharing/create_shared_link_with_settings", { path: "/README.txt" }, e), "too_many_requests");
  assert.equal((await rpc("files/list_folder", { path: "" })).body.entries.length, 7, "reads are not rate limited and nothing was written");
};

FLOWS["write-contention"] = async () => {
  const e = [429, "too_many_write_operations"];
  await rateLimited(() => upload({ path: "/Busy.txt" }, "x", e), "too_many_write_operations");
  await rateLimited(() => rpc("files/create_folder_v2", { path: "/Busy" }, e), "too_many_write_operations");
  await rateLimited(() => rpc("files/delete_v2", { path: "/README.txt" }, e), "too_many_write_operations");
  await rateLimited(() => rpc("files/move_v2", { from_path: "/README.txt", to_path: "/R.txt" }, e), "too_many_write_operations");
  await rateLimited(() => rpc("files/restore", { path: "/Old draft.txt", rev: "0015f8a3c00000012" }, e), "too_many_write_operations");
  assert.equal((await rpc("files/list_folder", { path: "" })).body.entries.length, 7);
};

FLOWS["upload-outage"] = async () => {
  const text = "Written during an outage\n";
  await upload({ path: "/Outage test.txt" }, text, [500]);
  const landed = await rpc("files/get_metadata", { path: "/Outage test.txt" });
  assert.equal(landed.body.content_hash, localHash(text), "the upload committed although the caller saw a 500");
  await upload({ path: "/Outage test.txt", mode: "add" }, text, [500]);
  assert.equal((await rpc("files/get_metadata", { path: "/Outage test.txt" })).body.rev, landed.body.rev, "a retried identical upload does not create a new revision");
};

const fnv32 = (text, seed = 0x811c9dc5) => {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
};
const cursorFor = (value) => {
  const body = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${body}${fnv32(body)}${fnv32(body, 0x2545f491)}`;
};

FLOWS["over-bound"] = async () => {
  assert.equal((await rpc("users/get_current_account")).body.account_id, MAYA);
  const e = [409, "too_many_files"];
  await rpc("users/get_space_usage", undefined, e);
  await rpc("files/list_folder", { path: "" }, e);
  await rpc("files/list_folder/continue", { cursor: cursorFor({ v: 1, k: "lf", a: MAYA, p: "", r: false, d: false, j: 0, o: null, l: 500, s: 1 }) }, e);
  await rpc("files/list_folder/get_latest_cursor", { path: "" }, e);
  await rpc("files/get_metadata", { path: "/README.txt" }, e);
  await rpc("files/create_folder_v2", { path: "/More" }, e);
  await upload({ path: "/More.txt" }, "more", e);
  await download({ path: "/README.txt" }, e);
  await rpc("files/delete_v2", { path: "/README.txt" }, e);
  await rpc("files/move_v2", { from_path: "/README.txt", to_path: "/R.txt" }, e);
  await rpc("files/copy_v2", { from_path: "/README.txt", to_path: "/R.txt" }, e);
  await rpc("files/search_v2", { query: "readme" }, e);
  await rpc("files/search/continue_v2", { cursor: cursorFor({ v: 1, k: "sr", a: MAYA, q: "readme", p: "", m: 100, ob: "relevance", fs: "active", fo: false, ex: [], ca: [], last: [0, 0, "/a"] }) }, e);
  await rpc("files/list_revisions", { path: "/README.txt" }, e);
  await rpc("files/restore", { path: "/README.txt", rev: "0015f8a3c00000011" }, e);
  await rpc("sharing/create_shared_link_with_settings", { path: "/README.txt" }, e);
  await rpc("sharing/list_shared_links", {}, e);
};

FLOWS["tight-limits"] = async () => {
  await upload({ path: "/Too big.txt" }, "x".repeat(65), [400, "at most 64 bytes"]);
  assert.equal((await upload({ path: "/Small.txt" }, "x".repeat(64))).body.size, 64);
  const cursor = (await rpc("files/list_folder/get_latest_cursor", { path: "", recursive: true })).body.cursor;
  await rpc("files/create_folder_v2", { path: "/A/B/C/D" });
  await rpc("files/list_folder/continue", { cursor }, [409, "reset"]);
};

const run = FLOWS[flow];
assert.ok(run, `unknown flow in instruction: ${instruction}`);
await run();
console.log(JSON.stringify({ flow, status: "passed" }));
