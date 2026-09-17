// Discord Tool conformance target. A scripted Tool test, not a model-driven agent.
// Node built-ins only: fetch against the Discord-shaped /api/v10 routes (Authorization: Bot <token>) and the canonical
// /v1/operations endpoint. Every call checks the exact status and body; any mismatch throws and fails the drill.
import assert from "node:assert/strict";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const instruction = String(JSON.parse(task).instruction ?? "");
const flow = /flow:([a-z-]+)/.exec(instruction)?.[1];
assert.ok(flow, `instruction names no flow: ${instruction}`);

const HTTP = process.env.FIREDRILL_HTTP_URL;
const TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
assert.ok(HTTP && TOKEN, "the HTTP binding is required");

// Fixed ids from the authored world (firedrill/world.json == starter.json).
const U = {
  deleted: "497860529356800001",
  priya: "555668943667200002",
  maya: "735103785369600003",
  theo: "797491121356800004",
  sam: "980759976345600005",
  lee: "1073924108451840006",
  fieldnote: "1379036823552000007",
  rio: "1544391386726400008",
};
const G = { northwind: "1418959886745600009", orbit: "1434844554854400024" };
const C = {
  info: "1418960138403840010",
  announcements: "1418960390062080011",
  rules: "1418960641720320012",
  community: "1418960893378560013",
  general: "1418961900011520017",
  help: "1418962151669760018",
  modlog: "1418962403328000019",
  lounge: "1418962654986240020",
  orbitGeneral: "1434844806512640025",
  oldRelease: "1510946006630400029",
  arm64: "1548287056281600038",
  duplicate: "1548362553753600043",
  dmMaya: "1477953611366400048",
};
const R = { moderator: "1418961145036800014", maintainer: "1418961396695040015", muted: "1418961648353280016", fieldnote: "1419609165004800021" };
const E = { northwindOk: "1422915954278400022" };
const M = {
  a1: "1420802025062400026",
  a2: "1547622678528000027",
  deletedAuthor: "1427012950425600028",
  join: "1544392770846720030",
  question: "1544636753510400031",
  reply: "1544641031700480032",
  edited: "1546429818470400033",
  mentions: "1547230091673600034",
  saturated: "1547909568921600035",
  hello: "1548785339596800036",
  photos: "1549064680243200037",
  arm64Starter: "1548287056281600038",
  t1: "1548289572864000039",
  duplicateNote: "1548362805411840044",
  oldRelease: "1510947264921600047",
};
const UNKNOWN = "1";
const OPERATIONS = [
  "users.get", "users.list-my-guilds", "users.list-dm-channels", "users.create-dm", "guilds.get", "guilds.list-channels",
  "guilds.list-active-threads", "guild-members.list", "guild-members.get", "roles.list", "channels.get", "messages.list", "messages.get",
  "messages.create", "messages.edit", "messages.delete", "reactions.add", "reactions.remove", "reactions.list-users",
  "threads.create-from-message", "threads.create",
];
const MESSAGES = {
  0: null,
  10003: "Unknown Channel",
  10004: "Unknown Guild",
  10007: "Unknown Member",
  10008: "Unknown Message",
  10013: "Unknown User",
  10014: "Unknown Emoji",
  20028: "The write action you are performing on the channel has hit the write rate limit.",
  30010: "Maximum number of reactions reached (20)",
  50001: "Missing Access",
  50005: "Cannot edit a message authored by another user",
  50006: "Cannot send an empty message",
  50007: "Cannot send messages to this user",
  50013: "Missing Permissions",
  50021: "Cannot execute action on a system message",
  50024: "Cannot execute action on this channel type",
  50035: "Invalid Form Body",
  50083: "Thread is archived",
  160004: "A thread has already been created for this message",
  160005: "Thread is locked",
};

// ---------------------------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------------------------

const e = (emoji) => encodeURIComponent(emoji);

async function api(method, path, { body, status = 200, headers = {}, rawBody, contentType } = {}) {
  const init = { method, headers: { authorization: `Bot ${TOKEN}`, ...headers } };
  if (rawBody !== undefined) {
    init.headers["content-type"] = contentType;
    init.body = rawBody;
  } else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${HTTP}/api/v10${path}`, init);
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  assert.equal(response.status, status, `${method} ${path} ${body === undefined ? "" : JSON.stringify(body).slice(0, 120)} -> ${response.status} ${text.slice(0, 400)}`);
  return { json, headers: response.headers };
}
const get = async (path, options) => (await api("GET", path, options)).json;
const post = async (path, body, options = {}) => (await api("POST", path, { ...options, body })).json;
const patch = async (path, body, options = {}) => (await api("PATCH", path, { ...options, body })).json;
const put = async (path, options = {}) => (await api("PUT", path, { status: 204, ...options })).json;
const del = async (path, options = {}) => (await api("DELETE", path, { status: 204, ...options })).json;

/** Expect a Discord error body `{ message, code }` with the given HTTP status and JSON code. */
async function fails(method, path, status, code, body, errorPath) {
  const { json } = await api(method, path, { status, body });
  assert.equal(json?.code, code, `${method} ${path}: expected code ${code}, got ${JSON.stringify(json)}`);
  if (MESSAGES[code] !== null && MESSAGES[code] !== undefined) assert.equal(json.message, MESSAGES[code]);
  if (errorPath !== undefined) {
    let node = json.errors;
    for (const segment of errorPath.split(".")) node = node?.[segment];
    assert.ok(Array.isArray(node?._errors) && node._errors.length > 0, `${method} ${path}: no errors.${errorPath}._errors in ${JSON.stringify(json)}`);
    return node._errors[0];
  }
  return json;
}

async function canonical(operationId, args) {
  const response = await fetch(`${HTTP}/v1/operations/discord/${operationId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  });
  const json = await response.json();
  assert.ok(json.outcome, `canonical ${operationId}: ${JSON.stringify(json).slice(0, 300)}`);
  return json.outcome;
}

/** Minimal valid arguments for each operation (used by the all-operations identity and bound checks). */
const MINIMAL = {
  "users.get": { user_id: "@me" },
  "users.list-my-guilds": {},
  "users.list-dm-channels": {},
  "users.create-dm": { recipient_id: U.maya },
  "guilds.get": { guild_id: G.northwind },
  "guilds.list-channels": { guild_id: G.northwind },
  "guilds.list-active-threads": { guild_id: G.northwind },
  "guild-members.list": { guild_id: G.northwind },
  "guild-members.get": { guild_id: G.northwind, user_id: U.theo },
  "roles.list": { guild_id: G.northwind },
  "channels.get": { channel_id: C.general },
  "messages.list": { channel_id: C.general },
  "messages.get": { channel_id: C.general, message_id: M.edited },
  "messages.create": { channel_id: C.general, content: "probe" },
  "messages.edit": { channel_id: C.general, message_id: M.edited, content: "probe" },
  "messages.delete": { channel_id: C.general, message_id: M.edited },
  "reactions.add": { channel_id: C.general, message_id: M.photos, emoji_name: "👍" },
  "reactions.remove": { channel_id: C.general, message_id: M.question, emoji_name: "👍" },
  "reactions.list-users": { channel_id: C.general, message_id: M.question, emoji_name: "👍" },
  "threads.create-from-message": { channel_id: C.general, message_id: M.hello, name: "probe" },
  "threads.create": { channel_id: C.general, name: "probe", type: 11 },
};

async function everyOperationFails(code) {
  for (const operationId of OPERATIONS) {
    const outcome = await canonical(operationId, MINIMAL[operationId]);
    assert.equal(outcome.status, "tool_error", `${operationId}: ${JSON.stringify(outcome).slice(0, 300)}`);
    assert.equal(outcome.error.code, `tool.${code}`, `${operationId}: ${JSON.stringify(outcome.error)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------------------------------------------

async function restFlow() {
  // Users
  const me = await get("/users/@me");
  assert.equal(me.id, U.fieldnote);
  assert.equal(me.bot, true);
  assert.equal(me.verified, true);
  assert.equal(me.email, null);
  const theo = await get(`/users/${U.theo}`);
  assert.equal(theo.username, "theo.lind");
  assert.equal("email" in theo, false);
  const deleted = await get(`/users/${U.deleted}`);
  assert.equal(deleted.global_name, "Deleted User");
  await fails("GET", `/users/${UNKNOWN}`, 404, 10013);
  // Bodies nested past 512 levels answer 400 before argument validation (including the framework's 3,000-level window).
  const nest = (key, depth, shape) => `{"${key}":${(shape === "array" ? "[" : '{"a":').repeat(depth)}1${(shape === "array" ? "]" : "}").repeat(depth)}}`;
  for (const [method, path, key] of [
    ["POST", "/users/@me/channels", "recipient_id"], ["POST", `/channels/${C.general}/messages`, "message_reference"],
    ["POST", `/channels/${C.general}/threads`, "name"], ["PATCH", `/channels/${C.general}/messages/${UNKNOWN}`, "allowed_mentions"],
  ]) {
    for (const depth of [513, 2998, 3152]) {
      for (const shape of ["array", "object"]) {
        await api(method, path, { rawBody: nest(key, depth, shape), contentType: "application/json", status: 400 });
      }
    }
  }
  const shallow = await api("POST", "/users/@me/channels", { rawBody: nest("recipient_id", 510, "array"), contentType: "application/json", status: 400 });
  assert.equal(shallow.json.code, 50035, "510 levels reach Discord's own validation");
  const coerce = await fails("GET", "/users/abc", 400, 50035, undefined, "user_id");
  assert.equal(coerce.code, "NUMBER_TYPE_COERCE");

  const guilds = await get("/users/@me/guilds?with_counts=true");
  assert.deepEqual(guilds.map((guild) => guild.id), [G.northwind]);
  assert.equal(guilds[0].approximate_member_count, 6);
  assert.equal(guilds[0].owner, false);
  assert.equal(typeof guilds[0].permissions, "string");
  assert.equal("server_time" in guilds, false);
  await fails("GET", "/users/@me/guilds?limit=0", 400, 50035, undefined, "limit");
  await fails("GET", "/users/@me/guilds?limit=abc", 400, 50035);
  await fails("GET", `/users/${U.theo}/guilds`, 400, 50035);
  assert.deepEqual(await get(`/users/@me/guilds?after=${G.northwind}`), []);

  // DMs
  const dms = await get("/users/@me/channels");
  assert.equal(dms.length, 1);
  assert.equal(dms[0].recipients[0].id, U.maya);
  assert.equal((await post("/users/@me/channels", { recipient_id: U.maya })).id, C.dmMaya);
  const leeDm = await post("/users/@me/channels", { recipient_id: U.lee });
  assert.equal(leeDm.type, 1);
  assert.notEqual(leeDm.id, C.dmMaya);
  assert.equal((await post("/users/@me/channels", { recipient_id: U.lee })).id, leeDm.id);
  await fails("POST", "/users/@me/channels", 400, 50035, { recipient_id: U.fieldnote }, "recipient_id");
  await fails("POST", "/users/@me/channels", 404, 10013, { recipient_id: UNKNOWN });
  await fails("POST", "/users/@me/channels", 404, 10013, { recipient_id: U.deleted });
  assert.equal((await get("/users/@me/channels")).length, 2);

  // Guilds
  const guild = await get(`/guilds/${G.northwind}?with_counts=true`);
  assert.equal(guild.name, "Northwind Makers");
  assert.deepEqual(guild.roles.map((role) => role.position), [0, 1, 2, 3, 4]);
  assert.equal(guild.roles.find((role) => role.id === R.fieldnote).tags.bot_id, U.fieldnote);
  assert.equal(guild.emojis.length, 2);
  assert.equal(guild.approximate_member_count, 6);
  for (const suffix of ["", "/channels", "/threads/active", "/members", "/roles"]) {
    await fails("GET", `/guilds/${G.orbit}${suffix}`, 403, 50001);
    await fails("GET", `/guilds/${UNKNOWN}${suffix}`, 404, 10004);
    await fails("GET", `/guilds/abc${suffix}`, 400, 50035, undefined, "guild_id");
  }
  const channels = await get(`/guilds/${G.northwind}/channels`);
  assert.equal(channels.length, 8);
  assert.ok(channels.some((channel) => channel.id === C.modlog));
  assert.ok(channels.every((channel) => [0, 2, 4, 5].includes(channel.type)));
  const active = await get(`/guilds/${G.northwind}/threads/active`);
  assert.deepEqual(active.threads.map((thread) => thread.id), [C.duplicate, C.arm64]);
  assert.deepEqual(active.members.map((member) => member.id), [C.arm64]);

  assert.equal((await get(`/guilds/${G.northwind}/members`)).length, 1);
  const walked = [];
  let after = "0";
  for (let page = 0; page < 5; page += 1) {
    const batch = await get(`/guilds/${G.northwind}/members?limit=2&after=${after}`);
    if (batch.length === 0) break;
    walked.push(...batch);
    after = batch.at(-1).user.id;
  }
  assert.equal(walked.length, 6);
  await fails("GET", `/guilds/${G.northwind}/members?limit=1001`, 400, 50035, undefined, "limit");
  const theoMember = await get(`/guilds/${G.northwind}/members/${U.theo}`);
  assert.equal(theoMember.nick, "theo");
  assert.deepEqual(theoMember.roles, [R.maintainer]);
  await fails("GET", `/guilds/${G.northwind}/members/${U.deleted}`, 404, 10007);
  await fails("GET", `/guilds/${G.orbit}/members/${U.lee}`, 403, 50001);
  await fails("GET", `/guilds/${UNKNOWN}/members/${U.lee}`, 404, 10004);
  await fails("GET", `/guilds/${G.northwind}/members/abc`, 400, 50035, undefined, "user_id");
  assert.equal((await get(`/guilds/${G.northwind}/roles`)).length, 5);

  // Channels
  assert.equal((await get(`/channels/${C.general}`)).name, "general");
  const thread = await get(`/channels/${C.arm64}`);
  assert.equal(thread.type, 11);
  assert.equal(thread.member_count, 3);
  assert.equal(thread.member.user_id, U.fieldnote);
  assert.equal((await get(`/channels/${C.dmMaya}`)).type, 1);
  assert.equal((await get(`/channels/${C.lounge}`)).bitrate, 64000);
  await fails("GET", `/channels/${C.modlog}`, 403, 50001);
  await fails("GET", `/channels/${C.orbitGeneral}`, 403, 50001);
  await fails("GET", `/channels/${UNKNOWN}`, 404, 10003);
  await fails("GET", "/channels/abc", 400, 50035, undefined, "channel_id");

  // Message history
  const page1 = await get(`/channels/${C.general}/messages?limit=4`);
  assert.deepEqual(page1.map((message) => message.id), [M.photos, M.hello, M.saturated, M.mentions]);
  const page2 = await get(`/channels/${C.general}/messages?limit=4&before=${page1.at(-1).id}`);
  assert.deepEqual(page2.map((message) => message.id), [M.edited, M.reply, M.question, M.join]);
  const page3 = await get(`/channels/${C.general}/messages?limit=4&before=${page2.at(-1).id}`);
  assert.deepEqual(page3.map((message) => message.id), [M.deletedAuthor]);
  assert.equal(page3[0].author.global_name, "Deleted User");
  assert.deepEqual(await get(`/channels/${C.general}/messages?limit=4&before=${M.deletedAuthor}`), []);
  const reply = page2[1];
  assert.equal(reply.type, 19);
  assert.equal(reply.referenced_message.id, M.question);
  assert.equal(page2[3].type, 7);
  assert.equal(page1[2].reactions.length, 20);
  assert.ok(page1[2].reactions.every((reaction) => reaction.me === true && reaction.count === 1));
  assert.deepEqual(page1[3].mention_roles, [R.maintainer]);
  assert.deepEqual(
    (await get(`/channels/${C.general}/messages?after=${M.deletedAuthor}&limit=2`)).map((message) => message.id),
    [M.question, M.join],
  );
  assert.deepEqual(
    (await get(`/channels/${C.general}/messages?around=${M.reply}&limit=3`)).map((message) => message.id),
    [M.edited, M.reply, M.question],
  );
  await fails("GET", `/channels/${C.general}/messages?before=${M.reply}&after=${M.join}`, 400, 50035);
  await fails("GET", `/channels/${C.general}/messages?limit=101`, 400, 50035, undefined, "limit");
  await fails("GET", `/channels/${C.general}/messages?before=abc`, 400, 50035, undefined, "before");
  assert.deepEqual(await get(`/channels/${C.rules}/messages`), []);
  await fails("GET", `/channels/${C.info}/messages`, 400, 50024);
  await fails("GET", `/channels/${C.lounge}/messages`, 400, 50024);
  await fails("GET", `/channels/${C.modlog}/messages`, 403, 50001);
  await fails("GET", `/channels/${UNKNOWN}/messages`, 404, 10003);
  await fails("GET", "/channels/abc/messages", 400, 50035);
  const edited = await get(`/channels/${C.general}/messages/${M.edited}`);
  assert.equal(edited.edited_timestamp, "2026-09-07T08:05:00.000000+00:00");
  const starter = await get(`/channels/${C.help}/messages/${M.arm64Starter}`);
  assert.equal(starter.thread.id, C.arm64);
  assert.equal(starter.flags, 32);
  await fails("GET", `/channels/${C.general}/messages/${UNKNOWN}`, 404, 10008);
  await fails("GET", `/channels/${UNKNOWN}/messages/${UNKNOWN}`, 404, 10003);
  await fails("GET", `/channels/${C.modlog}/messages/${UNKNOWN}`, 403, 50001);
  await fails("GET", `/channels/${C.info}/messages/${UNKNOWN}`, 400, 50024);
  await fails("GET", `/channels/${C.general}/messages/abc`, 400, 50035, undefined, "message_id");

  // Create (7 successful creates emit message.created)
  const thanks = await post(`/channels/${C.general}/messages`, {
    content: `Thanks <@${U.theo}>, <@&${R.maintainer}> and @everyone`,
    allowed_mentions: { parse: ["users"] },
  });
  assert.equal(thanks.author.id, U.fieldnote);
  assert.deepEqual(thanks.mentions.map((user) => user.id), [U.theo]);
  assert.deepEqual(thanks.mention_roles, []);
  assert.equal(thanks.mention_everyone, false);
  assert.match(thanks.timestamp, /^2026-09-14T16:[0-9]{2}:[0-9]{2}\.[0-9]{6}\+00:00$/);
  assert.ok((BigInt(thanks.id) >> 22n) + 1420070400000n >= 1789401600000n, `snowflake time of ${thanks.id}`);
  const followUp = await post(`/channels/${C.general}/messages`, { content: "Following up on this.", message_reference: { message_id: M.question } });
  assert.equal(followUp.type, 19);
  assert.equal(followUp.referenced_message.id, M.question);
  assert.deepEqual(followUp.mentions.map((user) => user.id), [U.maya]);
  assert.ok(BigInt(followUp.id) > BigInt(thanks.id));
  const plain = await post(`/channels/${C.general}/messages`, {
    content: "Posting anyway.",
    message_reference: { message_id: UNKNOWN, fail_if_not_exists: false },
  });
  assert.equal(plain.type, 0);
  assert.equal("message_reference" in plain, false);
  const unknownRef = await fails("POST", `/channels/${C.general}/messages`, 400, 50035, { content: "x", message_reference: { message_id: UNKNOWN } }, "message_reference");
  assert.equal(unknownRef.code, "MESSAGE_REFERENCE_UNKNOWN_MESSAGE");
  const tooLong = await fails("POST", `/channels/${C.general}/messages`, 400, 50035, { content: "x".repeat(2001) }, "content");
  assert.equal(tooLong.code, "BASE_TYPE_MAX_LENGTH");
  await fails("POST", `/channels/${C.general}/messages`, 400, 50006, {});
  await fails("POST", `/channels/${C.general}/messages`, 400, 50006, { content: "   " });
  await fails("POST", `/channels/${C.general}/messages`, 400, 50035, { content: "x", attachments: [] }, "attachments");
  await fails("POST", `/channels/${C.general}/messages`, 400, 50035, { content: "x", embeds: [{ title: "t", timestamp: "2026-09-14T16:00:00" }] }, "embeds.0.timestamp");
  await fails("POST", `/channels/${C.general}/messages`, 400, 50035, { content: 5 });
  await fails("POST", `/channels/${C.announcements}/messages`, 403, 50013, { content: "x" });
  await fails("POST", `/channels/${C.duplicate}/messages`, 403, 160005, { content: "x" });
  await fails("POST", `/channels/${C.modlog}/messages`, 403, 50001, { content: "x" });
  await fails("POST", `/channels/${C.info}/messages`, 400, 50024, { content: "x" });
  await fails("POST", `/channels/${UNKNOWN}/messages`, 404, 10003, { content: "x" });
  const embed = await post(`/channels/${C.general}/messages`, {
    embeds: [{ title: "Build digest", description: "3 builds", color: 5793266, timestamp: "2026-09-14T16:00:00Z", fields: [{ name: "arm64", value: "fixed", inline: true }] }],
  });
  assert.equal(embed.embeds[0].type, "rich");
  assert.equal(embed.content, "");
  const nonceBody = { content: "Digest posted.", nonce: "digest-0914", enforce_nonce: true };
  const first = await post(`/channels/${C.general}/messages`, nonceBody);
  const second = await post(`/channels/${C.general}/messages`, nonceBody);
  assert.equal(second.id, first.id);
  assert.equal(second.nonce, "digest-0914");
  const dm = await post(`/channels/${C.dmMaya}/messages`, { content: "On it." });
  assert.equal(dm.channel_id, C.dmMaya);
  await fails("POST", `/channels/${leeDm.id}/messages`, 403, 50007, { content: "Hello from the bot." });
  const inThread = await post(`/channels/${C.arm64}/messages`, { content: "Confirmed fixed on main." });
  assert.equal(inThread.position, 4);
  const threadAfter = await get(`/channels/${C.arm64}`);
  assert.equal(threadAfter.message_count, 4);
  assert.equal(threadAfter.last_message_id, inThread.id);
  assert.equal((await get(`/channels/${C.general}`)).last_message_id, first.id);

  // Edit
  const edit = await patch(`/channels/${C.general}/messages/${thanks.id}`, { content: `Thanks <@${U.theo}>!` });
  assert.equal(edit.content, `Thanks <@${U.theo}>!`);
  assert.match(edit.edited_timestamp, /^2026-09-14T16:/);
  assert.deepEqual(edit.mentions.map((user) => user.id), [U.theo]);
  assert.equal((await patch(`/channels/${C.general}/messages/${thanks.id}`, { flags: 4 })).flags, 4);
  await fails("PATCH", `/channels/${C.general}/messages/${M.reply}`, 403, 50005, { content: "x" });
  await fails("PATCH", `/channels/${C.general}/messages/${M.join}`, 400, 50021, { content: "x" });
  await fails("PATCH", `/channels/${C.general}/messages/${thanks.id}`, 400, 50006, { content: "" });
  await fails("PATCH", `/channels/${C.oldRelease}/messages/${M.oldRelease}`, 400, 50083, { content: "x" });
  await fails("PATCH", `/channels/${C.general}/messages/${thanks.id}`, 400, 50035, { content: "x".repeat(2001) }, "content");
  await fails("PATCH", `/channels/${UNKNOWN}/messages/${UNKNOWN}`, 404, 10003, { content: "x" });
  await fails("PATCH", `/channels/${C.general}/messages/${UNKNOWN}`, 404, 10008, { content: "x" });
  await fails("PATCH", `/channels/${C.modlog}/messages/${UNKNOWN}`, 403, 50001, { content: "x" });
  await fails("PATCH", `/channels/${C.info}/messages/${UNKNOWN}`, 400, 50024, { content: "x" });
  assert.equal((await get(`/channels/${C.general}/messages/${thanks.id}`)).content, `Thanks <@${U.theo}>!`);

  // Reactions (3 reaction.added events)
  await put(`/channels/${C.general}/messages/${M.photos}/reactions/${e("👍")}/@me`);
  await put(`/channels/${C.general}/messages/${M.photos}/reactions/${e("👍")}/@me`);
  await put(`/channels/${C.general}/messages/${M.photos}/reactions/${e(`northwind_ok:${E.northwindOk}`)}/@me`);
  const photos = await get(`/channels/${C.general}/messages/${M.photos}`);
  assert.deepEqual(photos.reactions.map((reaction) => [reaction.emoji.name, reaction.count, reaction.me]), [["👍", 1, true], ["northwind_ok", 1, true]]);
  await fails("PUT", `/channels/${C.general}/messages/${M.photos}/reactions/${e(`missing:${UNKNOWN}`)}/@me`, 400, 10014);
  await fails("PUT", `/channels/${C.general}/messages/${M.photos}/reactions/abc/@me`, 400, 10014);
  await fails("PUT", `/channels/${C.dmMaya}/messages/${dm.id}/reactions/${e(`northwind_ok:${E.northwindOk}`)}/@me`, 400, 10014);
  await fails("PUT", `/channels/${C.general}/messages/${M.saturated}/reactions/${e("🤩")}/@me`, 400, 30010);
  await put(`/channels/${C.general}/messages/${M.saturated}/reactions/${e("😀")}/@me`);
  await fails("PUT", `/channels/${C.oldRelease}/messages/${M.oldRelease}/reactions/${e("✅")}/@me`, 400, 50083);
  await fails("PUT", `/channels/${C.announcements}/messages/${M.a2}/reactions/${e("👍")}/@me`, 403, 50013);
  await put(`/channels/${C.announcements}/messages/${M.a1}/reactions/${e("🎉")}/@me`);
  await fails("PUT", `/channels/${UNKNOWN}/messages/${UNKNOWN}/reactions/${e("👍")}/@me`, 404, 10003);
  await fails("PUT", `/channels/${C.general}/messages/${UNKNOWN}/reactions/${e("👍")}/@me`, 404, 10008);
  await fails("PUT", `/channels/${C.modlog}/messages/${UNKNOWN}/reactions/${e("👍")}/@me`, 403, 50001);
  await fails("PUT", `/channels/${C.info}/messages/${UNKNOWN}/reactions/${e("👍")}/@me`, 400, 50024);
  await fails("PUT", `/channels/${C.general}/messages/abc/reactions/${e("👍")}/@me`, 400, 50035, undefined, "message_id");
  await fails("PUT", `/channels/${C.general}/messages/${M.photos}/reactions/${e("👍")}/${U.theo}`, 400, 50035);

  const reactors = await get(`/channels/${C.general}/messages/${M.question}/reactions/${e("👍")}`);
  assert.deepEqual(reactors.map((user) => user.id), [U.maya, U.theo, U.fieldnote]);
  assert.deepEqual((await get(`/channels/${C.general}/messages/${M.question}/reactions/${e("👍")}?limit=1&after=${U.maya}`)).map((user) => user.id), [U.theo]);
  assert.deepEqual(await get(`/channels/${C.general}/messages/${M.question}/reactions/${e("👍")}?type=1`), []);
  await fails("GET", `/channels/${C.general}/messages/${M.photos}/reactions/${e("🎉")}`, 400, 10014);
  await fails("GET", `/channels/${C.general}/messages/${M.question}/reactions/abc`, 400, 10014);
  await fails("GET", `/channels/${UNKNOWN}/messages/${UNKNOWN}/reactions/${e("👍")}`, 404, 10003);
  await fails("GET", `/channels/${C.general}/messages/${UNKNOWN}/reactions/${e("👍")}`, 404, 10008);
  await fails("GET", `/channels/${C.modlog}/messages/${UNKNOWN}/reactions/${e("👍")}`, 403, 50001);
  await fails("GET", `/channels/${C.info}/messages/${UNKNOWN}/reactions/${e("👍")}`, 400, 50024);
  await fails("GET", `/channels/${C.general}/messages/${M.question}/reactions/${e("👍")}?limit=0`, 400, 50035, undefined, "limit");

  await del(`/channels/${C.general}/messages/${M.photos}/reactions/${e("👍")}/@me`);
  await del(`/channels/${C.general}/messages/${M.photos}/reactions/${e("👍")}/@me`);
  assert.deepEqual((await get(`/channels/${C.general}/messages/${M.photos}`)).reactions.map((reaction) => reaction.emoji.name), ["northwind_ok"]);
  await fails("DELETE", `/channels/${C.general}/messages/${M.question}/reactions/${e("👍")}/${U.theo}`, 403, 50013);
  await fails("DELETE", `/channels/${UNKNOWN}/messages/${UNKNOWN}/reactions/${e("👍")}/@me`, 404, 10003);
  await fails("DELETE", `/channels/${C.general}/messages/${UNKNOWN}/reactions/${e("👍")}/@me`, 404, 10008);
  await fails("DELETE", `/channels/${C.modlog}/messages/${UNKNOWN}/reactions/${e("👍")}/@me`, 403, 50001);
  await fails("DELETE", `/channels/${C.info}/messages/${UNKNOWN}/reactions/${e("👍")}/@me`, 400, 50024);
  await fails("DELETE", `/channels/${C.general}/messages/${M.question}/reactions/${e("👍")}/abc`, 400, 50035, undefined, "user_id");
  await fails("DELETE", `/channels/${C.general}/messages/${M.question}/reactions/abc/@me`, 400, 10014);
  await fails("DELETE", `/channels/${C.oldRelease}/messages/${M.oldRelease}/reactions/${e("✅")}/@me`, 400, 50083);

  // Threads
  const fromMessage = await post(`/channels/${C.general}/messages/${M.question}/threads`, { name: "Reflow profile v2" }, { status: 201 });
  assert.equal(fromMessage.id, M.question);
  assert.equal(fromMessage.type, 11);
  assert.equal(fromMessage.thread_metadata.auto_archive_duration, 1440);
  assert.equal(fromMessage.member.user_id, U.fieldnote);
  assert.equal((await get(`/channels/${C.general}/messages/${M.question}`)).thread.id, M.question);
  await fails("POST", `/channels/${C.general}/messages/${M.question}/threads`, 400, 160004, { name: "again" });
  await fails("POST", `/channels/${C.help}/messages/${M.arm64Starter}/threads`, 400, 160004, { name: "again" });
  await fails("POST", `/channels/${C.announcements}/messages/${M.a1}/threads`, 403, 50013, { name: "Welcome thread" });
  await fails("POST", `/channels/${C.arm64}/messages/${M.t1}/threads`, 400, 50024, { name: "nested" });
  await fails("POST", `/channels/${C.general}/messages/${M.hello}/threads`, 400, 50035, { name: "" }, "name");
  await fails("POST", `/channels/${UNKNOWN}/messages/${UNKNOWN}/threads`, 404, 10003, { name: "x" });
  await fails("POST", `/channels/${C.general}/messages/${UNKNOWN}/threads`, 404, 10008, { name: "x" });
  await fails("POST", `/channels/${C.modlog}/messages/${UNKNOWN}/threads`, 403, 50001, { name: "x" });

  await fails("POST", `/channels/${C.general}/threads`, 403, 50013, { name: "Private planning" });
  const publicThread = await post(`/channels/${C.general}/threads`, { name: "Meetup logistics", type: 11 }, { status: 201 });
  assert.equal(publicThread.type, 11);
  assert.equal(publicThread.owner_id, U.fieldnote);
  const systemMessage = (await get(`/channels/${C.general}/messages?limit=1`))[0];
  assert.equal(systemMessage.type, 18);
  assert.equal(systemMessage.content, "Meetup logistics");
  await fails("POST", `/channels/${C.arm64}/threads`, 400, 50024, { name: "x", type: 11 });
  await fails("POST", `/channels/${C.general}/threads`, 400, 50035, { name: "x", type: 9 }, "type");
  await fails("POST", `/channels/${UNKNOWN}/threads`, 404, 10003, { name: "x" });
  await fails("POST", `/channels/${C.modlog}/threads`, 403, 50001, { name: "x" });

  // Delete (1 message.deleted event)
  await del(`/channels/${C.general}/messages/${followUp.id}`);
  await fails("GET", `/channels/${C.general}/messages/${followUp.id}`, 404, 10008);
  await fails("DELETE", `/channels/${C.general}/messages/${M.question}`, 403, 50013);
  await fails("DELETE", `/channels/${C.general}/messages/${UNKNOWN}`, 404, 10008);
  await fails("DELETE", `/channels/${UNKNOWN}/messages/${UNKNOWN}`, 404, 10003);
  await fails("DELETE", `/channels/${C.modlog}/messages/${UNKNOWN}`, 403, 50001);
  await fails("DELETE", `/channels/${C.info}/messages/${UNKNOWN}`, 400, 50024);
  await fails("DELETE", `/channels/${C.oldRelease}/messages/${M.oldRelease}`, 400, 50083);
  await fails("DELETE", `/channels/${C.general}/messages/abc`, 400, 50035, undefined, "message_id");

  // Framework edges: non-JSON bodies and routes outside the subset
  await api("POST", `/channels/${C.general}/messages`, { status: 415, rawBody: "--x\r\n", contentType: "multipart/form-data; boundary=x" });
  const pins = await api("GET", `/channels/${C.general}/pins`, { status: 404 });
  assert.notEqual(pins.json?.code, 50001);
  const outcome = await canonical("users.get", { user_id: "@me" });
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.value.id, U.fieldnote);
}

async function memberPermissionsFlow() {
  await fails("GET", `/channels/${C.modlog}`, 403, 50001);
  const privateThread = await post(`/channels/${C.general}/threads`, { name: "Maintainers sync" }, { status: 201 });
  assert.equal(privateThread.type, 12);
  assert.equal(privateThread.thread_metadata.invitable, true);
  const reopened = await post(`/channels/${C.oldRelease}/messages`, { content: "Reopening for v1.5 planning." });
  assert.equal(reopened.position, 2);
  assert.equal((await get(`/channels/${C.oldRelease}`)).thread_metadata.archived, false);
  await fails("POST", `/channels/${C.duplicate}/messages`, 403, 160005, { content: "x" });
  await fails("PATCH", `/channels/${C.duplicate}/messages/${M.duplicateNote}`, 403, 160005, { content: "x" });
  await fails("DELETE", `/channels/${C.general}/messages/${M.question}`, 403, 50013);
  const everyone = await post(`/channels/${C.general}/messages`, { content: "@everyone release candidate is up" });
  assert.equal(everyone.mention_everyone, true);
  assert.deepEqual((await get("/users/@me/guilds")).map((guild) => guild.id), [G.northwind]);
}

async function moderatorFlow() {
  assert.equal((await get(`/channels/${C.modlog}`)).name, "mod-log");
  await del(`/channels/${C.general}/messages/${M.saturated}`);
  await del(`/channels/${C.general}/messages/${M.question}/reactions/${e("👍")}/${U.theo}`);
  const question = await get(`/channels/${C.general}/messages/${M.question}`);
  assert.deepEqual(question.reactions.map((reaction) => [reaction.count, reaction.me]), [[2, true]]);
  const locked = await post(`/channels/${C.duplicate}/messages`, { content: "Keeping this locked; follow the main thread." });
  assert.equal(locked.channel_id, C.duplicate);
  await put(`/channels/${C.general}/messages/${M.photos}/reactions/${e("🎉")}/@me`);
}

async function mutedFlow() {
  await fails("POST", `/channels/${C.general}/messages`, 403, 50013, { content: "Is this thing on?" });
  const inThread = await post(`/channels/${C.arm64}/messages`, { content: "Same linker error on my board." });
  assert.equal(inThread.author.id, U.sam);
  assert.equal((await get(`/channels/${C.general}/messages?limit=2`)).length, 2);
  await put(`/channels/${C.general}/messages/${M.photos}/reactions/${e("👍")}/@me`);
}

async function outsiderFlow() {
  assert.deepEqual((await get("/users/@me/guilds")).map((guild) => guild.id), [G.orbit]);
  await fails("GET", `/guilds/${G.northwind}`, 403, 50001);
  await fails("GET", `/channels/${C.general}`, 403, 50001);
  const history = await get(`/channels/${C.orbitGeneral}/messages`);
  assert.equal(history.length, 1);
  assert.equal(history[0].author.id, U.lee);
}

async function freshInstallFlow() {
  assert.equal((await get("/users/@me")).id, U.fieldnote);
  assert.ok((await get("/users/@me/guilds")).length > 0);
  const posted = await post(`/channels/${C.general}/messages`, { content: "Hello from a fresh install." });
  assert.equal(posted.author.id, U.fieldnote);
}

async function unauthorizedFlow() {
  const body = await fails("GET", "/users/@me", 401, 0);
  assert.equal(body.message, "401: Unauthorized");
  await fails("POST", `/channels/${C.general}/messages`, 401, 0, { content: "x" });
  await everyOperationFails("UNAUTHORIZED");
}

async function deniedFlow() {
  await fails("GET", "/users/@me", 403, 50013);
  await fails("POST", `/channels/${C.general}/messages`, 403, 50013, { content: "x" });
}

async function rateLimitedFlow() {
  const { json, headers } = await api("POST", `/channels/${C.general}/messages`, { status: 429, body: { content: "x" } });
  assert.deepEqual(json, { message: MESSAGES[20028], retry_after: 1.5, global: false, code: 20028 });
  assert.equal(headers.get("retry-after"), "2");
  assert.equal(headers.get("x-ratelimit-remaining"), "0");
  assert.equal(headers.get("x-ratelimit-bucket"), "firedrill-channel-write");
  await fails("PATCH", `/channels/${C.general}/messages/${M.edited}`, 429, 20028, { content: "x" });
  await fails("PUT", `/channels/${C.general}/messages/${M.photos}/reactions/${e("👍")}/@me`, 429, 20028);
  assert.equal((await get(`/channels/${C.general}/messages?limit=100`)).length, 9);
  await del(`/channels/${C.general}/messages/${M.question}/reactions/${e("👍")}/@me`);
}

async function lostResponseFlow() {
  const body = { content: "Lost response probe", nonce: "n-1", enforce_nonce: true };
  const lost = await fails("POST", `/channels/${C.general}/messages`, 503, 0, body);
  assert.equal(lost.message, "503: Service Unavailable");
  await fails("POST", `/channels/${C.general}/messages`, 503, 0, body);
  const history = await get(`/channels/${C.general}/messages?limit=100`);
  assert.equal(history.filter((message) => message.content === "Lost response probe").length, 1);
  await fails("POST", `/channels/${C.general}/messages`, 503, 0, { content: "No nonce probe" });
  await fails("POST", `/channels/${C.general}/messages`, 503, 0, { content: "No nonce probe" });
  const after = await get(`/channels/${C.general}/messages?limit=100`);
  assert.equal(after.filter((message) => message.content === "No nonce probe").length, 2);
}

async function boundsFlow() {
  const body = await fails("GET", `/channels/${C.general}/messages`, 500, 0);
  assert.equal(body.message, "500: Internal Server Error");
  assert.equal((await get(`/channels/${C.general}/messages/${M.edited}`)).id, M.edited);
}

async function boundsFallbackFlow() {
  await fails("GET", "/users/@me", 500, 0);
  await everyOperationFails("STATE_BOUND_EXCEEDED");
}

/** Page a message list to its end with `before` (newest first) and with `after`; every message exactly once, every body under `cap`. */
async function pageBothWays(channelId, cap) {
  const utf8 = (value) => Buffer.byteLength(JSON.stringify(value));
  const backward = [];
  let before;
  for (;;) {
    const page = await get(`/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ""}`);
    assert.ok(utf8(page) <= cap, `page of ${utf8(page)} bytes exceeds ${cap}`);
    if (page.length === 0) break;
    backward.push(...page.map((message) => message.id));
    before = page.at(-1).id;
  }
  assert.equal(new Set(backward).size, backward.length, "backward paging repeated a message");
  const oldest = backward.at(-1);
  const forward = [oldest];
  let after = oldest;
  for (;;) {
    const page = await get(`/channels/${channelId}/messages?limit=100&after=${after}`);
    assert.ok(utf8(page) <= cap, `page of ${utf8(page)} bytes exceeds ${cap}`);
    if (page.length === 0) break;
    forward.push(...page.map((message) => message.id).reverse());
    after = page[0].id;
  }
  assert.deepEqual(forward, [...backward].reverse(), "forward and backward paging disagree");
  return backward;
}

async function bytePagesFlow() {
  const small = await get(`/channels/${C.help}/messages?limit=100`);
  assert.deepEqual(await pageBothWays(C.help, 1048576), small.map((message) => message.id));
  const created = [];
  // Emoji first, so the newest messages are the control-character ones (six JSON bytes per character).
  for (const content of ["\u{1F525}".repeat(2000), "\u0001".repeat(2000)]) {
    for (let index = 0; index < 100; index += 1) created.push((await post(`/channels/${C.general}/messages`, { content })).id);
  }
  const ids = await pageBothWays(C.general, 900000);
  for (const id of created) assert.ok(ids.includes(id), `message ${id} missing from the pages`);
  const first = await get(`/channels/${C.general}/messages?limit=100`);
  assert.ok(first.length > 0 && first.length < 100, `byte cap ended the first page at ${first.length}`);
  const around = await get(`/channels/${C.general}/messages?limit=100&around=${created[150]}`);
  assert.ok(around.some((message) => message.id === created[150]));
}

async function byteBudgetFlow() {
  const help = await pageBothWays(C.help, 1500);
  assert.equal(help.length, 4);
  const members = [];
  let after = "0";
  let pages = 0;
  for (;;) {
    const page = await get(`/guilds/${G.northwind}/members?limit=1000&after=${after}`);
    pages += 1;
    if (page.length === 0) break;
    members.push(...page.map((member) => member.user.id));
    after = page.at(-1).user.id;
  }
  assert.ok(pages > 2, "members should need several byte-capped pages");
  assert.equal(new Set(members).size, members.length);
  assert.equal(members.length, 6);
  const tooLarge = await fails("GET", `/guilds/${G.northwind}/channels`, 500, 0);
  assert.equal(tooLarge.message, "500: Internal Server Error");
  const outcome = await canonical("guilds.list-channels", { guild_id: G.northwind });
  assert.equal(outcome.status, "tool_error", JSON.stringify(outcome));
  assert.match(outcome.error.message, /exceeds the supported size of 1500 bytes \(meta\.limits\.response_bytes\)/);
  await fails("GET", `/channels/${C.general}/messages?around=${M.saturated}&limit=1`, 500, 0);
  assert.equal((await get(`/channels/${C.general}/messages/${M.saturated}`)).id, M.saturated);
  assert.ok((await get(`/guilds/${G.northwind}/roles`)).length > 0);
}

const FLOWS = {
  "rest-flow": restFlow,
  "member-permissions": memberPermissionsFlow,
  moderator: moderatorFlow,
  muted: mutedFlow,
  outsider: outsiderFlow,
  "fresh-install": freshInstallFlow,
  unauthorized: unauthorizedFlow,
  denied: deniedFlow,
  "rate-limited": rateLimitedFlow,
  "lost-response": lostResponseFlow,
  bounds: boundsFlow,
  "bounds-fallback": boundsFallbackFlow,
  "byte-pages": bytePagesFlow,
  "byte-budget": byteBudgetFlow,
};
assert.ok(FLOWS[flow], `unknown flow ${flow}`);
await FLOWS[flow]();
process.stdout.write(JSON.stringify({ completed: true, flow }));
