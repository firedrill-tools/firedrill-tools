// Collaborations, comments and the event stream after the write flow (Maya Chen).
import assert from "node:assert/strict";
import { DANIEL, F, FI, JONAH, MAYA, PRIYA, del, get, post } from "../client.mjs";

const DENIED = [403, "access_denied_insufficient_permissions"];
const collab = (id, accessibleBy, role = "viewer") => ({ item: { type: "folder", id }, accessible_by: { type: "user", ...accessibleBy }, role });

export async function sharing() {
  const priya = await post("/2.0/collaborations", collab(F(7), { id: PRIYA }));
  assert.deepEqual([priya.body.status, priya.body.accessible_by.id, priya.body.item.id], ["accepted", PRIYA, F(7)]);
  const jonah = await post("/2.0/collaborations", collab(F(7), { login: "JONAH.WEISS@northwind-studio.example.com" }, "editor"));
  assert.equal(jonah.body.accessible_by.id, JONAH);
  const pending = await post("/2.0/collaborations", collab(F(7), { login: "new.contractor@example.com" }, "previewer"));
  assert.deepEqual([pending.body.status, pending.body.accessible_by, pending.body.invite_email], ["pending", null, "new.contractor@example.com"]);
  await post("/2.0/collaborations", collab(F(1), { id: DANIEL }, "editor"), [400, "user_already_collaborator"]);
  await post("/2.0/collaborations", collab(F(1), { login: "freelance.writer@example.com" }, "editor"), [400, "user_already_collaborator"]);
  await post("/2.0/collaborations", collab(F(7), { id: MAYA }), [400, "user_already_collaborator"]);
  await post("/2.0/collaborations", collab("9999", { id: PRIYA }), [404, "not_found"]);
  await post("/2.0/collaborations", collab(F(7), { id: "99999" }), [404, "not_found"]);
  await post("/2.0/collaborations", collab(F(9), { id: PRIYA }), [404, "trashed"]);
  await post("/2.0/collaborations", collab(F(10), { id: JONAH }), DENIED);
  await post("/2.0/collaborations", collab(F(7), { id: DANIEL }, "owner"), [400, "bad_request"]);
  const listed = await get(`/2.0/folders/${F(7)}/collaborations`);
  assert.equal(listed.body.entries.length, 3);
  await del("/2.0/collaborations/9999", [404, "not_found"]);
  await del("/2.0/collaborations/8800005", DENIED);
  await del(`/2.0/collaborations/${pending.body.id}`);
  assert.equal((await get(`/2.0/folders/${F(7)}/collaborations`)).body.entries.length, 2);

  await post("/2.0/comments", { item: { type: "file", id: FI(2) }, message: "gone?" }, [404, "trashed"]);
  await post("/2.0/comments", { item: { type: "file", id: "31" }, message: "x" }, [404, "not_found"]);
  await post("/2.0/comments", { item: { type: "comment", id: "5100999" }, message: "x" }, [404, "not_found"]);
  await post("/2.0/comments", { item: { type: "file", id: FI(23) }, message: "x" }, DENIED);
  await post("/2.0/comments", { item: { type: "file", id: FI(3) }, message: "a", tagged_message: "b" }, [400, "bad_request"]);
  const note = await post("/2.0/comments", { item: { type: "file", id: FI(3) }, message: "Logo clear space looks right." });
  assert.equal(note.body.is_reply_comment, false);
  const reply = await post("/2.0/comments", { item: { type: "comment", id: "5100002" }, message: "Thanks, Daniel!" });
  assert.deepEqual([reply.body.is_reply_comment, reply.body.item.id], [true, FI(1)]);
  const mention = await post("/2.0/comments?fields=message,tagged_message", { item: { type: "file", id: FI(3) }, tagged_message: "@[20002:Daniel Okafor] please review" });
  assert.deepEqual([mention.body.message, mention.body.tagged_message], ["@Daniel Okafor please review", "@[20002:Daniel Okafor] please review"]);
  assert.equal((await get(`/2.0/files/${FI(1)}/comments`)).body.total_count, 4);
  assert.equal((await get(`/2.0/files/${FI(3)}?fields=comment_count`)).body.comment_count, 2);

  const events = await get("/2.0/events?stream_position=6&limit=500");
  const types = new Set(events.body.entries.map((e) => e.event_type));
  for (const type of ["ITEM_CREATE", "ITEM_RENAME", "ITEM_MOVE", "ITEM_MODIFY", "ITEM_TRASH", "ITEM_COPY", "ITEM_UPLOAD", "ITEM_UNDELETE_VIA_TRASH",
    "COLLAB_ADD_COLLABORATOR", "COLLAB_INVITE_COLLABORATOR", "COLLAB_REMOVE_COLLABORATOR", "COMMENT_CREATE"]) {
    assert.ok(types.has(type), `event stream contains ${type}`);
  }
  const removed = events.body.entries.find((e) => e.event_type === "COLLAB_REMOVE_COLLABORATOR");
  assert.deepEqual(removed.source, { type: "collaboration", id: pending.body.id });
  const changes = await get("/2.0/events?stream_type=changes&stream_position=6&limit=500");
  assert.ok(changes.body.entries.every((e) => !e.event_type.startsWith("COLLAB_") && e.event_type !== "COMMENT_CREATE"));
}
