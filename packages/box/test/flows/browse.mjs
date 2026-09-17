// Read-side flow for Maya Chen on the baseline: users, folders, pagination, files, versions, comments, search, events.
import assert from "node:assert/strict";
import { DANIEL, F, FI, MAYA, everyOperation, get, names, sha1 } from "../client.mjs";

const q = (params) => new URLSearchParams(params).toString();

async function folders() {
  const me = await get("/2.0/users/me");
  assert.equal(me.body.id, MAYA);
  assert.equal(me.body.space_used, 2647);
  const root = await get("/2.0/folders/0/items?limit=20");
  assert.equal(root.body.total_count, 7);
  assert.deepEqual(names(root.body.entries), ["Design Reviews", "Finance", "Marketing", "Personal", "Vendor Contracts", "meeting-notes-2026-09-10.md", "Präsentation Übersicht.md"]);
  const q3 = await get(`/2.0/folders/${F(3)}`);
  assert.deepEqual(names(q3.body.path_collection.entries), ["All Files", "Marketing", "Campaigns 2026"]);
  assert.equal(q3.body.size, 546);
  assert.deepEqual(names(q3.body.item_collection.entries), ["launch-plan.md", "press-release-draft.txt"]);
  assert.equal(q3.body.owned_by.id, MAYA);
  const slim = await get(`/2.0/folders/${F(1)}?fields=name,tags,can_non_owners_invite`);
  assert.deepEqual(Object.keys(slim.body).sort(), ["can_non_owners_invite", "etag", "id", "name", "tags", "type"]);
  const allFiles = await get("/2.0/folders/0");
  assert.equal(allFiles.body.name, "All Files");
  assert.equal(allFiles.body.item_collection.total_count, 7);
  await get(`/2.0/folders/${F(9)}`, [404, "trashed"]);
  await get("/2.0/folders/999999", [404, "not_found"]);
  await get(`/2.0/folders/${F(9)}/items`, [404, "trashed"]);
  await get("/2.0/folders/abc/items", [404, "not_found"]);
  await get(`/2.0/folders/${F(11)}?sort=bogus`, [400, "bad_request"]);

  // Offset pages of Weekly Reports (8 files): 3 + 3 + 2, stable order.
  const seen = [];
  for (const [offset, size] of [[0, 3], [3, 3], [6, 2]]) {
    const pageBody = (await get(`/2.0/folders/${F(11)}/items?limit=3&offset=${offset}`)).body;
    assert.equal(pageBody.total_count, 8);
    assert.equal(pageBody.entries.length, size);
    seen.push(...names(pageBody.entries));
  }
  assert.equal(new Set(seen).size, 8);
  assert.equal(seen[0], "weekly-report-2026-06-08.csv");
  const byDate = await get(`/2.0/folders/${F(11)}/items?limit=1&sort=date&direction=DESC`);
  assert.equal(byDate.body.entries[0].name, "weekly-report-2026-09-14.csv");
  // Marker pages give the same rows exactly once.
  const marked = [];
  let marker;
  let pages = 0;
  do {
    const pageBody = (await get(`/2.0/folders/${F(11)}/items?${q({ usemarker: "true", limit: "3", ...(marker ? { marker } : {}) })}`)).body;
    marked.push(...names(pageBody.entries));
    marker = pageBody.next_marker;
    pages += 1;
  } while (marker !== null && pages < 10);
  assert.deepEqual(marked, seen);
  assert.equal(pages, 3);
  await get(`/2.0/folders/${F(11)}/items?usemarker=true&marker=not-a-marker`, [400, "bad_request"]);
  const other = (await get(`/2.0/folders/${F(1)}/items?usemarker=true&limit=1`)).body.next_marker;
  await get(`/2.0/folders/${F(11)}/items?usemarker=true&marker=${other}`, [400, "bad_request"]);
  const empty = await get(`/2.0/folders/${F(7)}/items`);
  assert.equal(empty.body.total_count, 0);
  assert.deepEqual(empty.body.entries, []);
  const trash = await get("/2.0/folders/trash/items");
  assert.deepEqual(names(trash.body.entries), ["obsolete-budget.csv", "Old Drafts"]);
  assert.equal(trash.body.entries[0].item_status, "trashed");
}

async function files() {
  const plan = await get(`/2.0/files/${FI(1)}?fields=name,sha1,version_number,comment_count`);
  assert.equal(plan.body.version_number, "3");
  assert.equal(plan.body.comment_count, 3);
  const content = await get(`/2.0/files/${FI(1)}/content`, 200, { raw: true });
  assert.equal(sha1(content.bytes), plan.body.sha1);
  assert.match(content.headers.get("content-disposition"), /filename\*=UTF-8''launch-plan\.md/);
  const versions = await get(`/2.0/files/${FI(1)}/versions`);
  assert.equal(versions.body.total_count, 2);
  assert.deepEqual(versions.body.entries.map((v) => v.version_number), ["2", "1"]);
  const old = await get(`/2.0/files/${FI(1)}/content?version=${versions.body.entries[1].id}`, 200, { raw: true });
  assert.equal(sha1(old.bytes), versions.body.entries[1].sha1);
  assert.ok(old.bytes.toString("utf8").startsWith("# Q3 Launch plan (draft)"));
  const german = await get(`/2.0/files/${FI(18)}/content`, 200, { raw: true });
  assert.ok(german.bytes.toString("utf8").includes("Größe"));
  await get(`/2.0/files/${FI(1)}/content?version=121000000005`, [404, "not_found"], { raw: true });
  await get(`/2.0/files/${FI(1)}/content?version=abc`, [404, "not_found"], { raw: true });
  await get(`/2.0/files/${FI(19)}`, [404, "trashed"]);
  await get("/2.0/files/12", [404, "not_found"]);
  await get(`/2.0/files/${FI(19)}/content`, [404, "trashed"]);
  await get(`/2.0/files/${FI(23)}/content`, [403, "access_denied_insufficient_permissions"]);
  await get(`/2.0/files/${FI(23)}/versions`, [403, "access_denied_insufficient_permissions"]);
  await get(`/2.0/files/${FI(19)}/versions`, [404, "trashed"]);
  await get("/2.0/files/77/versions", [404, "not_found"]);
  const comments = await get(`/2.0/files/${FI(1)}/comments`);
  assert.equal(comments.body.total_count, 3);
  assert.equal(comments.body.entries[1].message, "@Maya Chen confirmed with the product team: September 29.");
  assert.equal(comments.body.entries[2].is_reply_comment, true);
  const reviewComments = await get(`/2.0/files/${FI(23)}/comments`);
  assert.equal(reviewComments.body.entries[0].created_by.id, DANIEL);
  await get(`/2.0/files/${FI(19)}/comments`, [404, "trashed"]);
  await get("/2.0/files/5/comments", [404, "not_found"]);
  const collabs = await get(`/2.0/folders/${F(1)}/collaborations?limit=1`);
  assert.equal(collabs.body.entries.length, 1);
  const rest = await get(`/2.0/folders/${F(1)}/collaborations?limit=1&marker=${collabs.body.next_marker}`);
  assert.equal(rest.body.entries[0].status, "pending");
  assert.equal(rest.body.entries[0].invite_email, "freelance.writer@example.com");
  assert.equal(rest.body.next_marker, null);
  await get(`/2.0/folders/${F(1)}/collaborations?marker=%3D%3D`, [400, "bad_request"]);
  await get(`/2.0/folders/${F(9)}/collaborations`, [404, "trashed"]);
  await get("/2.0/folders/31/collaborations", [404, "not_found"]);
}

export const FLOWS = {};
FLOWS.browse = async () => {
  await folders();
  await files();
  const { searchAndEvents } = await import("./browse-search.mjs");
  await searchAndEvents();
  // Box's As-User impersonation is not simulated: every operation answers 400 instead of acting as the caller.
  assert.equal(await everyOperation(() => [400, "bad_request"], { "as-user": DANIEL }), 23);
};
