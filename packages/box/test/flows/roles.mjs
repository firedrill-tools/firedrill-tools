// Collaboration roles seen from other users: Priya (uploader + viewer), Daniel (editor, login identity), Jonah (quota).
import assert from "node:assert/strict";
import { DANIEL, F, FI, JONAH, MAYA, PRIYA, del, get, names, post, put, upload, uploadVersion } from "../client.mjs";

const DENIED = [403, "access_denied_insufficient_permissions"];
export const FLOWS = {};

FLOWS["uploader-viewer"] = async () => {
  assert.equal((await get("/2.0/users/me")).body.id, PRIYA);
  assert.deepEqual(names((await get("/2.0/folders/0/items")).body.entries), ["Design Reviews", "Finance", "Q3 Launch"]);
  // Uploader on Q3 Launch: may drop files in, cannot look inside.
  await get(`/2.0/folders/${F(3)}`, DENIED);
  await get(`/2.0/folders/${F(3)}/items`, DENIED);
  await get(`/2.0/folders/${F(3)}/collaborations`, DENIED);
  await get(`/2.0/files/${FI(1)}`, [404, "not_found"]);
  const dropped = await upload({ name: "moodboard-notes.md", parent: { id: F(3) } }, "# Moodboard\nWarm neutrals.\n");
  assert.equal(dropped.body.entries[0].owned_by.id, MAYA, "items are owned by the folder owner");
  assert.equal(dropped.body.entries[0].created_by.id, PRIYA);
  await get(`/2.0/files/${dropped.body.entries[0].id}`, [404, "not_found"]);
  // Viewer on Finance: read, download, comment and copy out; no changes inside.
  assert.deepEqual(names((await get(`/2.0/folders/${F(5)}/items`)).body.entries), ["Invoices", "Weekly Reports"]);
  await get(`/2.0/files/${FI(7)}/content`, 200, { raw: true });
  await put(`/2.0/files/${FI(7)}`, { name: "renamed.txt" }, DENIED);
  await del(`/2.0/files/${FI(7)}`, DENIED);
  await uploadVersion(FI(7), {}, "changed", DENIED);
  await post("/2.0/folders", { name: "Priya drafts", parent: { id: F(5) } }, DENIED);
  await put(`/2.0/folders/${F(5)}`, { description: "mine now" }, DENIED);
  await del(`/2.0/folders/${F(6)}?recursive=true`, DENIED);
  await post(`/2.0/files/${FI(7)}/copy`, { parent: { id: F(6) } }, DENIED);
  await post(`/2.0/folders/${F(6)}/copy`, { parent: { id: F(5) }, name: "Invoices copy" }, DENIED);
  await upload({ name: "x.txt", parent: { id: F(6) } }, "x", DENIED);
  await post("/2.0/collaborations", { item: { type: "folder", id: F(5) }, accessible_by: { type: "user", id: JONAH }, role: "viewer" }, DENIED);
  const copy = await post(`/2.0/files/${FI(7)}/copy`, { parent: { id: "0" } });
  assert.equal(copy.body.owned_by.id, PRIYA);
  const comment = await post("/2.0/comments", { item: { type: "file", id: FI(7) }, message: "Paid on 2026-08-29." });
  assert.equal(comment.body.created_by.id, PRIYA);
  await del("/2.0/collaborations/8800001", [404, "not_found"]);
  await del("/2.0/collaborations/8800003");
  await get(`/2.0/folders/${F(5)}`, [404, "not_found"]);
  await get(`/2.0/files/${FI(7)}`, [404, "not_found"]);
};

FLOWS["editor-login"] = async () => {
  assert.equal((await get("/2.0/users/me")).body.id, DANIEL, "login attribute resolves case-insensitively");
  assert.deepEqual(names((await get("/2.0/folders/0/items")).body.entries), ["Design Reviews", "Marketing", "Vendor Contracts"]);
  await get(`/2.0/folders/${F(5)}`, [404, "not_found"]);
  const renamed = await put(`/2.0/files/${FI(3)}`, { name: "brand-guidelines-2026.md" }, 200, { headers: { "if-match": "0" } });
  assert.equal(renamed.body.etag, "1");
  assert.equal(renamed.body.modified_by.id, DANIEL);
  const invite = await post("/2.0/collaborations", { item: { type: "folder", id: F(4) }, accessible_by: { type: "user", id: PRIYA }, role: "viewer" });
  assert.equal(invite.body.status, "accepted");
  await post("/2.0/collaborations", { item: { type: "folder", id: F(5) }, accessible_by: { type: "user", id: PRIYA }, role: "viewer" }, [404, "not_found"]);
  await del(`/2.0/files/${FI(5)}`);
  await post(`/2.0/files/${FI(5)}`, { parent: { id: "0" } }, DENIED);
  const restored = await post(`/2.0/files/${FI(5)}`, {});
  assert.equal(restored.body.item_status, "active");
  await del("/2.0/collaborations/8800005");
  await get(`/2.0/folders/${F(10)}`, [404, "not_found"]);
  const trash = await get("/2.0/folders/trash/items");
  assert.equal(trash.body.total_count, 0, "Daniel's trash holds only items he owns");
};

FLOWS.quota = async () => {
  const me = await get("/2.0/users/me");
  assert.deepEqual([me.body.id, me.body.space_used, me.body.space_amount, me.body.max_upload_size], [JONAH, 7800, 8192, 4096]);
  await upload({ name: "sketch.txt", parent: { id: "0" } }, "s".repeat(500), [403, "storage_limit_exceeded"]);
  await upload({ name: "poster.txt", parent: { id: "0" } }, "p".repeat(5000), [403, "file_size_limit_exceeded"]);
  await uploadVersion(FI(24), {}, "n".repeat(5000), [403, "file_size_limit_exceeded"]);
  await uploadVersion(FI(24), {}, "n".repeat(400), [403, "storage_limit_exceeded"]);
  const sketches = await post("/2.0/folders", { name: "Sketches", parent: { id: "0" } });
  await post(`/2.0/files/${FI(24)}/copy`, { parent: { id: sketches.body.id } }, [403, "storage_limit_exceeded"]);
  const moved = await put(`/2.0/files/${FI(24)}`, { parent: { id: sketches.body.id } });
  assert.equal(moved.body.parent.id, sketches.body.id);
  await post(`/2.0/folders/${sketches.body.id}/copy`, { parent: { id: "0" }, name: "Sketches copy" }, [403, "storage_limit_exceeded"]);
  const small = await upload({ name: "todo.txt", parent: { id: sketches.body.id } }, "t".repeat(100));
  assert.equal(small.body.entries[0].size, 100);
  assert.equal((await get("/2.0/users/me")).body.space_used, 7900);
  assert.equal((await get("/2.0/search?query=Marketing")).body.total_count, 0);
  await get(`/2.0/files/${FI(1)}`, [404, "not_found"]);
};
