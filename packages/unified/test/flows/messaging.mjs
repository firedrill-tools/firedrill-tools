// Drill unified-messaging-flow (admin, baseline): channels, messages, aliases, threads, filters and author identity.
import { C, CH, MSG, NEW, NONE, apiError, assert, del, get, ids, noneHas, patch, post, walk } from "../lib.mjs";

const H = `/messaging/${C.chat}`;
const MAIL = `/messaging/${C.mail}`;

export async function messaging() {
  // Channels.
  const channels = (await get(`${H}/channel`)).json;
  assert.deepEqual(ids(channels), [CH.general, CH.sales, CH.exec, CH.emea]);
  assert.equal(channels.find((row) => row.id === CH.sales).has_subchannels, true, "has_subchannels computed from parent_id rows");
  assert.equal(channels.find((row) => row.id === CH.general).has_subchannels, false);
  assert.ok(noneHas(channels, "alias") && noneHas(channels, "connection_id"), "internal alias field is never returned");
  assert.deepEqual(ids((await get(`${H}/channel?type=PRIVATE`)).json), [CH.exec]);
  assert.deepEqual(ids((await get(`${H}/channel?parent_id=${CH.sales}`)).json), [CH.emea]);
  assert.deepEqual(ids((await get(`${H}/channel?query=exec`)).json), [CH.exec]);
  assert.deepEqual(ids((await get(`${H}/channel?sort=name&order=desc&limit=2`)).json), [CH.emea, CH.sales]);
  await apiError("GET", `${H}/channel?type=SECRET`, 400, "type must be one of");
  assert.equal((await get(`${H}/channel/${CH.exec}`)).json.is_private, true);
  assert.equal((await get(`${H}/channel/${CH.sales}`)).json.has_subchannels, true);
  await apiError("GET", `${H}/channel/${NONE}`, 404, "Channel not found");

  // Message filters.
  assert.equal((await get(`${H}/message?channel_id=${CH.general}`)).json.length, 9);
  assert.deepEqual(ids((await get(`${H}/message?channel_id=${CH.general}&parent_id=${MSG(1)}`)).json), [MSG(2), MSG(3), MSG(4)]);
  assert.deepEqual(ids((await get(`${H}/message?type=UNREAD`)).json), [MSG(6), MSG(9)]);
  assert.deepEqual(ids((await get(`${H}/message?user_id=u-opsbot`)).json), [MSG(5), MSG(13)]);
  assert.deepEqual(ids((await get(`${H}/message?user_mentioned_id=u-maya`)).json), [MSG(3)]);
  assert.deepEqual(ids((await get(`${H}/message?start_gte=2026-09-10&end_lt=2026-09-13`)).json), [MSG(7), MSG(8), MSG(16)]);
  assert.deepEqual(ids((await get(`${H}/message?query=%E5%B1%B1%E7%94%B0`)).json), [MSG(9)], "query matches CJK text");
  assert.deepEqual((await get(`${H}/message?channel_id=INBOX`)).json, [], "alias without a matching channel matches nothing");
  assert.deepEqual(ids((await get(`${MAIL}/message?channel_id=INBOX`)).json), [MSG(17), MSG(18)]);
  assert.deepEqual(ids((await get(`${MAIL}/message?channel_id=SENT`)).json), [MSG(19)]);
  assert.deepEqual(ids((await get(`${MAIL}/message?channel_id=DRAFT`)).json), [MSG(20)]);
  assert.deepEqual(ids((await get(`${MAIL}/message?type=UNREAD`)).json), [MSG(17)]);
  assert.deepEqual(ids((await get(`${MAIL}/message?sort=name&order=asc&limit=1`)).json), [MSG(18)], "sort=name orders messages by subject");
  await apiError("GET", `${H}/message?channel_id=notahexid`, 400, "channel_id must be a valid id");
  await apiError("GET", `${H}/message?start_gte=yesterday`, 400, "start_gte");
  assert.equal(ids((await get(`${H}/message?sort=created_at&order=desc`)).json)[0], MSG(9), "newest chat message first");
  assert.equal((await walk(`${H}/message`, 5, [5, 5, 5, 1])).length, 16);
  const long = (await get(`${H}/message/${MSG(8)}`)).json;
  assert.equal(long.message.length, 2982, "the seeded long-form message round-trips intact");
  assert.equal((await get(`${H}/message/${MSG(7)}`)).json.attachments[0].filename, "onboarding-deck.pdf");
  await apiError("GET", `${H}/message/${NONE}`, 404, "Message not found");

  // Create: author from the connection, reply inherits channels, parent has_children maintained.
  await apiError("POST", `${H}/message`, 400, "One of message", { body: {} });
  await apiError("POST", `${H}/message`, 400, "Unknown channel id", { body: { message: "x", channels: [{ id: NONE }] } });
  await apiError("POST", `${H}/message`, 400, "Unknown parent_id", { body: { message: "y", parent_id: NONE } });
  await apiError("POST", `${H}/message`, 400, "Invalid value for message", { body: { message: "x".repeat(20001), channels: [{ id: CH.sales }] } });
  await apiError("POST", `${H}/message`, 400, "channels[0].id or parent_id", { body: { message: "no channel" } });
  const posted = (await post(`${H}/message`, { message: "Deploy done", channels: [{ id: CH.sales }], author_member: { user_id: "spoofed", name: "Spoof" } })).json;
  assert.equal(posted.id, NEW(1));
  assert.deepEqual(posted.author_member, { user_id: "u-opsbot", email: null, name: "Ops Bot", image_url: null }, "author comes from the connection, not the body");
  assert.deepEqual(posted.channels, [{ id: CH.sales, name: "sales" }]);
  assert.equal(posted.has_children, false);
  assert.equal(posted.is_unread, false);
  assert.equal((await get(`${H}/message/${MSG(5)}`)).json.has_children, false);
  const reply = (await post(`${H}/message`, { message: "re", parent_id: MSG(5) })).json;
  assert.equal(reply.id, NEW(2));
  assert.deepEqual(reply.channels, [{ id: CH.general, name: "general" }], "reply inherits the parent's channels");
  assert.equal((await get(`${H}/message/${MSG(5)}`)).json.has_children, true);
  assert.deepEqual(ids((await get(`${H}/message?parent_id=${MSG(5)}`)).json), [NEW(2)]);

  // Update and remove.
  const edited = (await patch(`${H}/message/${NEW(1)}`, { is_unread: true, message: "edited" })).json;
  assert.equal(edited.message, "edited");
  assert.equal(edited.is_unread, true);
  await apiError("PATCH", `${H}/message/${NEW(1)}`, 400, "must remain set", { body: { message: null, message_html: null, message_markdown: null } });
  assert.equal((await get(`${H}/message/${NEW(1)}`)).json.message, "edited");
  assert.deepEqual((await del(`${H}/message/${NEW(2)}`)).json, {});
  assert.equal((await get(`${H}/message/${MSG(5)}`)).json.has_children, false, "parent recomputed after the last reply is removed");
  await apiError("GET", `${H}/message/${NEW(2)}`, 404, "Message not found");
  await apiError("DELETE", `${H}/message/${NEW(2)}`, 404, "Message not found");
  assert.equal((await get(`${H}/message`)).json.length, 17);

  // Category and absent routes.
  await apiError("GET", `/messaging/${C.main}/channel`, 501, "not supported by this integration");
  const absent = await fetch(`${process.env.FIREDRILL_HTTP_URL}${H}/channel`, { method: "POST", headers: { authorization: `Bearer ${process.env.FIREDRILL_HTTP_TOKEN}`, "content-type": "application/json" }, body: "{}" });
  await absent.text();
  assert.ok(absent.status === 404 || absent.status === 405, `POST channel -> ${absent.status}`);
}
