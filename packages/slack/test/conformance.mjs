// Slack Tool conformance target. A scripted Tool test, not a model-driven agent.
// Node built-ins only: fetch against the Slack-shaped /api/<method> routes (GET query and POST form),
// the canonical /v1/operations endpoint, and raw MCP JSON-RPC (Streamable HTTP) for the reference tool-name aliases.
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

// Fixed ids from the authored world (firedrill/world.json == starter.json).
const U = { dana: "U01DANA0001", sam: "U01SAM00002", priya: "U01PRIYA003", lee: "U01LEE00004", opsbot: "U01OPSBOT05", mira: "U01MIRA0006" };
const C = {
  general: "C01GENERAL1",
  engineering: "C01ENGINEER",
  incidents: "C01INCIDENT",
  random: "C01RANDOM01",
  launch: "C01LAUNCHQ3",
  design: "C01DESIGN01",
  leadership: "C01LEADERS1",
  im: "D01DANASAM1",
  mpdm: "C01MPDM0001",
  onboarding: "C01ONBOARD1",
};
const TS = {
  g1: "1787216400.000101",
  join: "1787561880.000119",
  e1: "1787562900.000120",
  r1: "1787564400.000121",
  r2: "1787565900.000122",
  r3: "1787667600.000123",
  r4: "1787669100.000124",
  e2: "1787828400.000125",
  e3: "1787934600.000126",
  e5: "1788430200.000128",
  e6: "1788526800.000129",
  e7: "1788773400.000130",
  e8: "1788882300.000131",
  e9: "1788952800.000132",
  e10: "1789116600.000133",
  e11: "1789375200.000134",
  l1: "1787306400.000161",
  unknown: "1700000000.000001",
};
const ALL_OPERATIONS = [
  "auth.test",
  "users.list",
  "users.info",
  "users.profile.get",
  "conversations.list",
  "conversations.info",
  "conversations.members",
  "conversations.create",
  "conversations.join",
  "conversations.invite",
  "conversations.open",
  "conversations.archive",
  "conversations.set-topic",
  "conversations.history",
  "conversations.replies",
  "chat.post-message",
  "chat.reply",
  "chat.update",
  "chat.delete",
  "reactions.add",
  "reactions.remove",
  "pins.add",
  "pins.remove",
  "pins.list",
  "search.messages",
];

// ---------------------------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------------------------

/** Call a Slack method over HTTP: GET with a query string, or POST with a form body (the SDK convention). */
async function api(verb, method, args = {}, { status = 200, headers = {}, rawBody, contentType } = {}) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(args)) query.set(name, typeof value === "string" ? value : JSON.stringify(value));
  const url = verb === "GET" ? `${HTTP}/api/${method}${query.size > 0 ? `?${query}` : ""}` : `${HTTP}/api/${method}`;
  const response = await fetch(url, {
    method: verb,
    headers: {
      authorization: `Bearer ${HTTP_TOKEN}`,
      ...(verb === "GET" ? {} : { "content-type": contentType ?? "application/x-www-form-urlencoded" }),
      ...headers,
    },
    ...(verb === "GET" ? {} : { body: rawBody ?? query.toString() }),
  });
  const text = await response.text();
  const json = text.length > 0 ? JSON.parse(text) : undefined;
  assert.equal(response.status, status, `${verb} ${method} ${JSON.stringify(args)} -> ${response.status} ${text.slice(0, 300)}`);
  return { json, headers: response.headers, status: response.status, bytes: Buffer.byteLength(text) };
}

const get = (method, args, options) => api("GET", method, args, options);
const post = (method, args, options) => api("POST", method, args, options);

/** Expect a Slack-shaped error body with the given status and `error` string. */
async function apiError(verb, method, args, status, error, options = {}) {
  const result = await api(verb, method, args, { ...options, status });
  assert.equal(result.json?.ok, false, `${method}: expected ok:false, got ${JSON.stringify(result.json).slice(0, 300)}`);
  assert.equal(result.json.error, error, `${method} ${JSON.stringify(args)}: ${JSON.stringify(result.json)}`);
  return result;
}

/** Canonical operation endpoint (also how chat.reply is reached over HTTP: it has no Slack route). */
async function op(operationId, args, expected = "ok") {
  const response = await fetch(`${HTTP}/v1/operations/slack/${operationId}`, {
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
  assert.equal(json.outcome.status, "tool_error", `${operationId} ${JSON.stringify(args)}: ${JSON.stringify(json.outcome).slice(0, 300)}`);
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
  if (code) {
    const error = result.structuredContent?.error;
    assert.ok(error, `${name}: ${JSON.stringify(result).slice(0, 400)}`);
    assert.equal(error.code, code, JSON.stringify(error));
  }
  return result.structuredContent;
}

const tsList = (messages) => messages.map((message) => message.ts);
const decodeCursor = (cursor) => Buffer.from(cursor, "base64url").toString("utf8");
const engineeringHistory = (args) => get("conversations.history", { channel: C.engineering, ...args });

// ---------------------------------------------------------------------------------------------
// Drill: web-api (member = Dana, baseline)
// ---------------------------------------------------------------------------------------------

async function webApi() {
  // Identity over both route shapes -----------------------------------------------------------
  const who = (await get("auth.test")).json;
  assert.deepEqual(who, { ok: true, url: "https://example-team.slack.com/", team: "Example Team", user: "dana.reyes", team_id: "T01EXAMPLE0", user_id: U.dana, is_enterprise_install: false });
  assert.equal((await post("auth.test")).json.user_id, U.dana);

  // Users ---------------------------------------------------------------------------------------
  const everyone = (await get("users.list")).json;
  assert.deepEqual(everyone.members.map((member) => member.id), [U.dana, U.lee, U.mira, U.opsbot, U.priya, U.sam], "sorted by id");
  assert.equal(everyone.response_metadata.next_cursor, "");
  assert.equal(everyone.cache_ts, 1789376400, "virtual now");
  assert.equal(everyone.members.find((member) => member.id === U.lee).deleted, true);
  assert.equal(everyone.members.find((member) => member.id === U.opsbot).bot_id, "B01OPSBOT01");
  assert.ok(!("bot_id" in everyone.members[0]));
  let page = (await post("users.list", { limit: "2" })).json;
  const walked = [...page.members.map((member) => member.id)];
  let pages = 1;
  while (page.response_metadata.next_cursor) {
    assert.equal(decodeCursor(page.response_metadata.next_cursor).startsWith("user:"), true);
    page = (await get("users.list", { limit: "2", cursor: page.response_metadata.next_cursor })).json;
    walked.push(...page.members.map((member) => member.id));
    pages += 1;
  }
  assert.equal(pages, 3);
  assert.deepEqual(walked, everyone.members.map((member) => member.id));
  const usersCursor = (await get("users.list", { limit: "2" })).json.response_metadata.next_cursor;
  await apiError("GET", "users.list", { cursor: "not-a-cursor" }, 400, "invalid_cursor");
  await apiError("GET", "users.list", { limit: "0" }, 400, "invalid_arguments");
  await apiError("GET", "conversations.list", { cursor: usersCursor }, 400, "invalid_cursor");
  await apiError("GET", "conversations.list", { cursor: "%%%" }, 400, "invalid_cursor");

  const mira = (await get("users.info", { user: U.mira })).json.user;
  assert.equal(mira.tz, "Asia/Singapore");
  assert.equal(mira.profile.status_emoji, ":palm_tree:");
  assert.equal((await post("users.info", { user: U.lee })).json.user.deleted, true);
  await apiError("POST", "users.info", { user: "U0NOBODY000" }, 404, "user_not_found");
  await op("users.info", { user: U.mira, user_id: U.mira }, "INVALID_ARGUMENTS");
  await op("users.info", {}, "INVALID_ARGUMENTS");
  const ownProfile = (await get("users.profile.get")).json.profile;
  assert.equal(ownProfile.title, "Engineering Manager");
  assert.equal(ownProfile.avatar_hash, "");
  assert.equal((await post("users.profile.get", { user: U.lee })).json.profile.real_name, "Lee Marsh", "deactivated profiles are still returned");
  await apiError("GET", "users.profile.get", { user: "U0NOBODY000" }, 404, "user_not_found");
  await op("users.profile.get", { user: U.mira, user_id: U.mira }, "INVALID_ARGUMENTS");

  // Conversation listing and info ---------------------------------------------------------------
  const publicChannels = (await get("conversations.list")).json;
  assert.deepEqual(publicChannels.channels.map((channel) => channel.id), [C.design, C.engineering, C.general, C.launch, C.onboarding, C.random]);
  assert.equal(publicChannels.channels.find((channel) => channel.id === C.design).is_member, false);
  assert.equal(publicChannels.channels.find((channel) => channel.id === C.general).is_member, true);
  assert.ok(!("num_members" in publicChannels.channels[0]), "num_members only on request");
  assert.equal((await post("conversations.list", { exclude_archived: "true" })).json.channels.length, 5);
  const privateOnes = (await get("conversations.list", { types: "private_channel,mpim,im" })).json.channels;
  assert.deepEqual(privateOnes.map((channel) => channel.id), [C.incidents, C.mpdm, C.im]);
  assert.equal(privateOnes.find((channel) => channel.id === C.im).user, U.sam, "IM partner is the other party");
  await apiError("GET", "conversations.list", { types: "public_channel,secret" }, 400, "invalid_arguments");
  let listPage = (await get("conversations.list", { limit: "4" })).json;
  assert.equal(listPage.channels.length, 4);
  assert.equal(decodeCursor(listPage.response_metadata.next_cursor), `team:${C.launch}`);
  listPage = (await get("conversations.list", { limit: "4", cursor: listPage.response_metadata.next_cursor })).json;
  assert.deepEqual(listPage.channels.map((channel) => channel.id), [C.onboarding, C.random]);
  assert.equal(listPage.response_metadata.next_cursor, "");

  await apiError("GET", "conversations.info", { channel: C.leadership }, 404, "channel_not_found");
  await apiError("GET", "conversations.info", { channel: "C0NOPE00000" }, 404, "channel_not_found");
  const design = (await post("conversations.info", { channel: C.design })).json.channel;
  assert.equal(design.is_member, false);
  const general = (await get("conversations.info", { channel: C.general, include_num_members: "true" })).json.channel;
  assert.equal(general.num_members, 5);
  assert.equal(general.is_general, true);
  assert.equal(general.topic.value, "Company-wide announcements");

  const members = (await get("conversations.members", { channel: C.general })).json;
  assert.deepEqual(members.members, [U.dana, U.mira, U.opsbot, U.priya, U.sam]);
  let membersPage = (await post("conversations.members", { channel: C.general, limit: "2" })).json;
  const walkedMembers = [...membersPage.members];
  let memberPages = 1;
  while (membersPage.response_metadata.next_cursor) {
    membersPage = (await get("conversations.members", { channel: C.general, limit: "2", cursor: membersPage.response_metadata.next_cursor })).json;
    walkedMembers.push(...membersPage.members);
    memberPages += 1;
  }
  assert.equal(memberPages, 3);
  assert.deepEqual(walkedMembers, members.members);
  await apiError("GET", "conversations.members", { channel: C.general, cursor: "bogus" }, 400, "invalid_cursor");
  assert.equal((await get("conversations.members", { channel: C.design })).json.members.length, 2, "public channel members are visible without membership");

  // Sweeps: channel_not_found on an invisible private channel ----------------------------------
  const hidden = { channel: C.leadership };
  await apiError("GET", "conversations.members", hidden, 404, "channel_not_found");
  await apiError("GET", "conversations.history", hidden, 404, "channel_not_found");
  await apiError("GET", "conversations.replies", { ...hidden, ts: TS.e1 }, 404, "channel_not_found");
  await apiError("GET", "pins.list", hidden, 404, "channel_not_found");
  await apiError("POST", "conversations.join", hidden, 404, "channel_not_found");
  await apiError("POST", "conversations.invite", { ...hidden, users: U.priya }, 404, "channel_not_found");
  await apiError("POST", "conversations.archive", hidden, 404, "channel_not_found");
  await apiError("POST", "conversations.setTopic", { ...hidden, topic: "x" }, 404, "channel_not_found");
  await apiError("POST", "conversations.open", hidden, 404, "channel_not_found");
  await apiError("POST", "chat.postMessage", { ...hidden, text: "x" }, 404, "channel_not_found");
  await apiError("POST", "chat.update", { ...hidden, ts: TS.e1, text: "x" }, 404, "channel_not_found");
  await apiError("POST", "chat.delete", { ...hidden, ts: TS.e1 }, 404, "channel_not_found");
  await apiError("POST", "reactions.add", { ...hidden, timestamp: TS.e1, name: "eyes" }, 404, "channel_not_found");
  await apiError("POST", "reactions.remove", { ...hidden, timestamp: TS.e1, name: "eyes" }, 404, "channel_not_found");
  await apiError("POST", "pins.add", { ...hidden, timestamp: TS.e1 }, 404, "channel_not_found");
  await apiError("POST", "pins.remove", { ...hidden, timestamp: TS.e1 }, 404, "channel_not_found");
  await op("chat.reply", { channel: C.leadership, thread_ts: TS.e1, text: "x" }, "CHANNEL_NOT_FOUND");

  // Sweeps: not_in_channel on a public channel Dana has not joined -----------------------------
  const outside = { channel: C.design };
  await apiError("GET", "conversations.history", outside, 403, "not_in_channel");
  await apiError("GET", "conversations.replies", { ...outside, ts: TS.e1 }, 403, "not_in_channel");
  await apiError("GET", "pins.list", outside, 403, "not_in_channel");
  await apiError("POST", "conversations.invite", { ...outside, users: U.priya }, 403, "not_in_channel");
  await apiError("POST", "conversations.archive", outside, 403, "not_in_channel");
  await apiError("POST", "conversations.setTopic", { ...outside, topic: "x" }, 403, "not_in_channel");
  await apiError("POST", "chat.postMessage", { ...outside, text: "x" }, 403, "not_in_channel");
  await apiError("POST", "chat.update", { ...outside, ts: TS.e1, text: "x" }, 403, "not_in_channel");
  await apiError("POST", "chat.delete", { ...outside, ts: TS.e1 }, 403, "not_in_channel");
  await apiError("POST", "reactions.add", { ...outside, timestamp: TS.e1, name: "eyes" }, 403, "not_in_channel");
  await apiError("POST", "reactions.remove", { ...outside, timestamp: TS.e1, name: "eyes" }, 403, "not_in_channel");
  await apiError("POST", "pins.add", { ...outside, timestamp: TS.e1 }, 403, "not_in_channel");
  await apiError("POST", "pins.remove", { ...outside, timestamp: TS.e1 }, 403, "not_in_channel");
  await op("chat.reply", { channel: C.design, thread_ts: TS.e1, text: "x" }, "NOT_IN_CHANNEL");

  // Sweeps: is_archived on #launch-q3 (Dana is a member) ----------------------------------------
  const archived = { channel: C.launch };
  await apiError("POST", "conversations.join", archived, 400, "is_archived");
  await apiError("POST", "conversations.invite", { ...archived, users: U.sam }, 400, "is_archived");
  await apiError("POST", "conversations.setTopic", { ...archived, topic: "x" }, 400, "is_archived");
  await apiError("POST", "chat.postMessage", { ...archived, text: "x" }, 400, "is_archived");
  await apiError("POST", "chat.update", { ...archived, ts: TS.l1, text: "x" }, 400, "is_archived");
  await apiError("POST", "chat.delete", { ...archived, ts: TS.l1 }, 400, "is_archived");
  await apiError("POST", "reactions.add", { ...archived, timestamp: TS.l1, name: "eyes" }, 400, "is_archived");
  await apiError("POST", "reactions.remove", { ...archived, timestamp: TS.l1, name: "eyes" }, 400, "is_archived");
  await apiError("POST", "pins.add", { ...archived, timestamp: TS.l1 }, 400, "is_archived");
  await apiError("POST", "pins.remove", { ...archived, timestamp: TS.l1 }, 400, "is_archived");
  await op("chat.reply", { channel: C.launch, thread_ts: TS.l1, text: "x" }, "IS_ARCHIVED");
  assert.equal((await get("conversations.history", archived)).json.messages.length, 2, "archived channels stay readable");

  // Sweeps: invalid_arguments when both argument spellings are given (canonical endpoint) -------
  const both = { channel: C.general, channel_id: C.general };
  for (const [operationId, extra] of [
    ["conversations.info", {}],
    ["conversations.members", {}],
    ["conversations.join", {}],
    ["conversations.invite", { users: U.sam }],
    ["conversations.archive", {}],
    ["conversations.set-topic", { topic: "x" }],
    ["conversations.history", {}],
    ["conversations.replies", { ts: TS.g1 }],
    ["chat.post-message", { text: "x" }],
    ["chat.reply", { thread_ts: TS.g1, text: "x" }],
    ["chat.update", { ts: TS.g1, text: "x" }],
    ["chat.delete", { ts: TS.g1 }],
    ["reactions.add", { timestamp: TS.g1, name: "eyes" }],
    ["reactions.remove", { timestamp: TS.g1, name: "eyes" }],
    ["pins.add", { timestamp: TS.g1 }],
    ["pins.remove", { timestamp: TS.g1 }],
    ["pins.list", {}],
  ]) {
    await op(operationId, { ...both, ...extra }, "INVALID_ARGUMENTS");
  }
  await op("conversations.replies", { channel: C.engineering, ts: TS.e1, thread_ts: TS.e1 }, "INVALID_ARGUMENTS");
  await op("reactions.add", { channel: C.general, timestamp: TS.g1, name: "eyes", reaction: "eyes" }, "INVALID_ARGUMENTS");
  await op("conversations.open", {}, "INVALID_ARGUMENTS");
  await op("conversations.open", { users: U.sam, channel: C.im }, "INVALID_ARGUMENTS");
  await op("conversations.open", { users: U.dana }, "INVALID_ARGUMENTS");

  // History: pagination, window, empty channel -------------------------------------------------
  let history = (await engineeringHistory({ limit: "5" })).json;
  assert.deepEqual(tsList(history.messages), [TS.e11, TS.e10, TS.e9, TS.e8, TS.e7]);
  assert.equal(history.has_more, true);
  assert.equal(history.pin_count, 0);
  assert.ok(!("channel" in history.messages[0]) && !("permalink" in history.messages[0]), "history messages omit channel and permalink");
  assert.equal(history.messages.find((message) => message.ts === TS.e7).blocks.length, 1);
  assert.equal(history.messages.find((message) => message.ts === TS.e8).reactions[0].name, "eyes");
  history = (await post("conversations.history", { channel: C.engineering, limit: "5", cursor: history.response_metadata.next_cursor })).json;
  assert.deepEqual(tsList(history.messages), [TS.e6, TS.e5, TS.e3, TS.e2, TS.r3], "the thread_broadcast reply is top-level, plain replies are not");
  assert.equal(history.messages.find((message) => message.ts === TS.e6).edited.user, U.dana);
  assert.equal(history.has_more, true);
  history = (await engineeringHistory({ limit: "5", cursor: history.response_metadata.next_cursor })).json;
  assert.deepEqual(tsList(history.messages), [TS.e1, TS.join]);
  assert.equal(history.messages[0].reply_count, 4);
  assert.deepEqual(history.messages[0].reply_users, [U.dana, U.mira, U.opsbot]);
  assert.equal(history.messages[1].subtype, "channel_join");
  assert.equal(history.has_more, false);
  assert.equal(history.response_metadata.next_cursor, "");
  assert.deepEqual(tsList((await engineeringHistory({ oldest: TS.e2, latest: TS.e6 })).json.messages), [TS.e5, TS.e3], "exclusive window");
  assert.deepEqual(tsList((await engineeringHistory({ oldest: TS.e2, latest: TS.e6, inclusive: "true" })).json.messages), [TS.e6, TS.e5, TS.e3, TS.e2]);
  assert.deepEqual(tsList((await engineeringHistory({ oldest: "1789000000" })).json.messages), [TS.e11, TS.e10], "plain epoch seconds are accepted");
  await apiError("GET", "conversations.history", { channel: C.engineering, oldest: "yesterday" }, 400, "invalid_arguments");
  await apiError("GET", "conversations.history", { channel: C.engineering, cursor: "bmV4dF90czpub3Bl" }, 400, "invalid_cursor");
  await apiError("GET", "conversations.history", { channel: C.engineering, cursor: usersCursor }, 400, "invalid_cursor");
  const onboarding = (await get("conversations.history", { channel: C.onboarding })).json;
  assert.deepEqual(onboarding, { ok: true, messages: [], has_more: false, pin_count: 0, response_metadata: { next_cursor: "" } });
  assert.equal((await get("conversations.history", { channel: C.general })).json.pin_count, 1);

  // Replies ------------------------------------------------------------------------------------
  const thread = (await get("conversations.replies", { channel: C.engineering, ts: TS.e1 })).json;
  assert.deepEqual(tsList(thread.messages), [TS.e1, TS.r1, TS.r2, TS.r3, TS.r4], "parent first, then replies oldest first");
  assert.equal(thread.has_more, false);
  let replyPage = (await post("conversations.replies", { channel: C.engineering, ts: TS.e1, limit: "2" })).json;
  assert.deepEqual(tsList(replyPage.messages), [TS.e1, TS.r1, TS.r2]);
  assert.equal(replyPage.has_more, true);
  replyPage = (await get("conversations.replies", { channel: C.engineering, ts: TS.e1, limit: "2", cursor: replyPage.response_metadata.next_cursor })).json;
  assert.deepEqual(tsList(replyPage.messages), [TS.r3, TS.r4], "later pages omit the parent");
  assert.equal(replyPage.has_more, false);
  assert.deepEqual(tsList((await get("conversations.replies", { channel: C.engineering, ts: TS.e1, oldest: TS.r2, latest: TS.r4 })).json.messages), [TS.e1, TS.r3]);
  await apiError("GET", "conversations.replies", { channel: C.engineering, ts: TS.r1 }, 404, "thread_not_found", {});
  await apiError("GET", "conversations.replies", { channel: C.engineering, ts: TS.unknown }, 404, "thread_not_found");
  await apiError("GET", "conversations.replies", { channel: C.engineering, ts: TS.e1, cursor: "nope" }, 400, "invalid_cursor");
  assert.equal((await get("conversations.replies", { channel: C.general, ts: TS.g1 })).json.messages.length, 1, "a message without replies is a one-message thread");

  // Search (before this flow adds messages, so the counts are the authored ones) -----------------
  const search = async (query, extra = {}) => (await get("search.messages", { query, ...extra })).json.messages;
  const deploy = await search("deploy");
  assert.equal(deploy.total, 4);
  assert.deepEqual(deploy.matches.map((match) => match.ts), [TS.e10, TS.e3, TS.e2, TS.r3], "score then ts desc");
  assert.equal(deploy.matches[1].username, "sam.okafor");
  assert.equal(deploy.matches[1].channel.name, "engineering");
  assert.equal(deploy.matches[1].permalink, `https://example-team.slack.com/archives/${C.engineering}/p1787934600000126`);
  assert.deepEqual(deploy.pagination, { total_count: 4, page: 1, per_page: 20, page_count: 1, first: 1, last: 4 });
  assert.deepEqual(deploy.paging, { count: 20, total: 4, page: 1, pages: 1 });
  assert.deepEqual(tsList((await search("deploy", { sort: "timestamp", sort_dir: "asc" })).matches), [TS.r3, TS.e2, TS.e3, TS.e10]);
  const secondPage = await search("deploy", { count: "2", page: "2" });
  assert.deepEqual(tsList(secondPage.matches), [TS.e2, TS.r3]);
  assert.equal(secondPage.pagination.page_count, 2);
  assert.equal((await search("deploy", { count: "2", page: "3" })).matches.length, 0, "a page past the end is empty, not an error");
  assert.deepEqual(tsList((await search("deploy in:#engineering from:@sam.okafor")).matches), [TS.e3]);
  assert.deepEqual(tsList((await search("is:thread postgres")).matches), [TS.r1]);
  assert.deepEqual(tsList((await search("has:pin")).matches).sort(), [TS.g1, "1788166800.000144"].sort());
  assert.deepEqual(tsList((await search('"rollback plan"')).matches), [TS.e6]);
  assert.equal((await search("rollback")).total, 2);
  assert.deepEqual(tsList((await search("has:reaction in:#engineering")).matches).sort(), [TS.e2, TS.e8].sort());
  assert.deepEqual(tsList((await search("has::eyes:")).matches), [TS.e8]);
  assert.deepEqual(tsList((await search("from:me in:#engineering")).matches).sort(), [TS.r1, TS.e2, TS.e6, TS.e10].sort());
  assert.equal((await search("in:@sam.okafor rota")).total, 2, "IM by handle");
  assert.equal((await search(`from:<@${U.opsbot}>`)).total, 4);
  assert.deepEqual(tsList((await search(`in:<#${C.engineering}> standup`)).matches), [TS.e11]);
  assert.equal((await search("in:#engineering before:2026-08-25")).total, 3, "channel_join messages are not searchable");
  assert.equal((await search("in:#engineering on:2026-08-24")).total, 3);
  assert.equal((await search("in:#engineering after:2026-09-10")).total, 2);
  assert.equal((await search("in:#engineering during:2026-09")).total, 7);
  assert.equal((await search("in:#engineering is:thread -flaky")).total, 5);
  assert.equal((await search("in:#nowhere deploy")).total, 0, "unknown channel gives zero matches");
  assert.equal((await post("search.messages", { query: "standup" })).json.messages.total, 1);
  await apiError("GET", "search.messages", { query: "to:@dana.reyes" }, 400, "invalid_arguments");
  await apiError("GET", "search.messages", { query: "has:link" }, 400, "invalid_arguments");
  await apiError("GET", "search.messages", { query: "before:yesterday" }, 400, "invalid_arguments");
  await apiError("GET", "search.messages", { query: "deploy", sort: "relevance" }, 400, "invalid_arguments");
  await apiError("GET", "search.messages", { query: "deploy", count: "0" }, 400, "invalid_arguments");
  await apiError("GET", "search.messages", { query: "   " }, 400, "no_query");
  // Mangled percent-encoding: the framework decodes %E0%A4%A to U+FFFD in query strings and form bodies. The search
  // must fail with invalid_arguments instead of answering an empty result; %EF%BF%BD is rejected the same way.
  const rawSearch = async (verb, encoded) => {
    const init = { method: verb, headers: { authorization: `Bearer ${HTTP_TOKEN}` } };
    if (verb === "POST") {
      init.headers["content-type"] = "application/x-www-form-urlencoded";
      init.body = `query=${encoded}`;
    }
    const response = await fetch(verb === "GET" ? `${HTTP}/api/search.messages?query=${encoded}` : `${HTTP}/api/search.messages`, init);
    return { status: response.status, json: await response.json() };
  };
  for (const verb of ["GET", "POST"]) {
    for (const encoded of ["deploy%E0%A4%A", "%E0%A4%A", "deploy%EF%BF%BD", "in%3A%23engineering%20depl%E0%A4%A"]) {
      const mangled = await rawSearch(verb, encoded);
      assert.equal(mangled.status, 400, `${verb} ${encoded}: ${JSON.stringify(mangled.json)}`);
      assert.equal(mangled.json.ok, false);
      assert.equal(mangled.json.error, "invalid_arguments", `${verb} ${encoded}`);
      assert.ok(mangled.json.response_metadata.messages[0].includes("U+FFFD"));
    }
    const literal = await rawSearch(verb, "deploy%ZZ");
    assert.equal(literal.json.ok, true, "%ZZ stays literal text");
    assert.equal(literal.json.query, "deploy%ZZ");
    assert.equal((await rawSearch(verb, "deploy")).json.messages.total > 0, true);
  }
  await op("search.messages", { query: "deploy \uFFFD" }, "INVALID_ARGUMENTS");
  // Legitimate non-ASCII searches keep working.
  const unicodeText = "Café 漢字 🔥 encoding check";
  await post("chat.postMessage", { channel: "C01ENGINEER", text: unicodeText });
  for (const term of ["café", "漢字", "🔥"]) {
    const found = await search(term);
    assert.ok(found.matches.some((match) => match.text === unicodeText), `search ${term}: ${JSON.stringify(found).slice(0, 300)}`);
  }

  // Join ----------------------------------------------------------------------------------------
  const joined = (await post("conversations.join", { channel: C.design })).json;
  assert.equal(joined.channel.is_member, true);
  assert.equal(joined.channel.num_members, 3);
  assert.ok(!("warning" in joined));
  const designHistory = (await get("conversations.history", { channel: C.design })).json;
  assert.equal(designHistory.messages.length, 3, "two authored messages plus the channel_join");
  assert.equal(designHistory.messages[0].subtype, "channel_join");
  assert.equal(designHistory.messages[0].text, `<@${U.dana}> has joined the channel`);
  const again = (await post("conversations.join", { channel: C.design })).json;
  assert.equal(again.warning, "already_in_channel");
  assert.deepEqual(again.response_metadata, { warnings: ["already_in_channel"] });
  await apiError("POST", "conversations.join", { channel: C.incidents }, 400, "method_not_supported_for_channel_type");
  await apiError("POST", "conversations.join", { channel: C.im }, 400, "method_not_supported_for_channel_type");

  // Create, invite, topic -----------------------------------------------------------------------
  const created = (await post("conversations.create", { name: "#Release-Notes" })).json.channel;
  assert.equal(created.id, "C000000001F");
  assert.equal(created.name, "release-notes");
  assert.equal(created.is_member, true);
  assert.equal(created.num_members, 1);
  assert.equal(created.creator, U.dana);
  await apiError("POST", "conversations.create", { name: "release-notes" }, 409, "name_taken");
  await apiError("POST", "conversations.create", { name: "General" }, 409, "name_taken", {});
  await apiError("POST", "conversations.create", { name: "bad name!" }, 400, "invalid_name");
  const invited = (await post("conversations.invite", { channel: created.id, users: `${U.sam},${U.mira}` })).json.channel;
  assert.equal(invited.num_members, 3);
  await apiError("POST", "conversations.invite", { channel: created.id, users: U.sam }, 409, "already_in_channel");
  await apiError("POST", "conversations.invite", { channel: created.id, users: U.lee }, 404, "user_not_found");
  await apiError("POST", "conversations.invite", { channel: created.id, users: "U0NOBODY000" }, 404, "user_not_found");
  await apiError("POST", "conversations.invite", { channel: created.id, users: U.dana }, 400, "cant_invite_self");
  await apiError("POST", "conversations.invite", { channel: created.id, users: `${U.priya},${U.lee}` }, 404, "user_not_found");
  assert.deepEqual((await get("conversations.members", { channel: created.id })).json.members, [U.dana, U.mira, U.sam], "all-or-nothing: Priya was not added");
  await apiError("POST", "conversations.invite", { channel: C.im, users: U.mira }, 400, "method_not_supported_for_channel_type");
  await apiError("POST", "conversations.invite", { channel: created.id, users: " , " }, 400, "invalid_arguments");
  assert.equal((await get("conversations.history", { channel: created.id })).json.messages.length, 2, "one channel_join per invitee");
  const topic = (await post("conversations.setTopic", { channel: created.id, topic: "Weekly release notes" })).json.channel;
  assert.equal(topic.topic.value, "Weekly release notes");
  assert.equal(topic.topic.creator, U.dana);
  assert.equal(topic.topic.last_set, 1789376400);
  assert.equal((await post("conversations.setTopic", { channel: created.id, topic: "" })).json.channel.topic.value, "");

  // Open IMs and group DMs ---------------------------------------------------------------------
  const existingIm = (await post("conversations.open", { users: U.sam })).json;
  assert.deepEqual(existingIm, { ok: true, no_op: true, already_open: true, channel: { id: C.im } });
  assert.equal((await post("conversations.open", { users: `${U.sam},${U.mira}` })).json.channel.id, C.mpdm);
  assert.equal((await post("conversations.open", { users: `${U.mira},${U.sam},${U.dana}` })).json.channel.id, C.mpdm, "self is ignored, order does not matter");
  const newIm = (await post("conversations.open", { users: U.priya, return_im: "true" })).json;
  assert.equal(newIm.already_open, false);
  assert.equal(newIm.channel.id, "D000000001G");
  assert.equal(newIm.channel.is_im, true);
  assert.equal(newIm.channel.user, U.priya);
  assert.equal(newIm.channel.num_members, 2);
  assert.equal((await post("conversations.open", { users: U.priya })).json.already_open, true);
  const newGroup = (await post("conversations.open", { users: `${U.priya},${U.mira}`, return_im: "true" })).json.channel;
  assert.equal(newGroup.is_mpim, true);
  assert.equal(newGroup.name, "mpdm-dana.reyes--mira.chen--priya.n-1");
  await apiError("POST", "conversations.open", { users: U.lee }, 404, "user_not_found");
  assert.equal((await post("conversations.open", { channel: C.im })).json.channel.id, C.im);
  const ims = (await get("conversations.list", { types: "im" })).json.channels;
  assert.deepEqual(ims.map((channel) => channel.id), [newIm.channel.id, C.im], "ids sort as strings");

  // Post messages --------------------------------------------------------------------------------
  const hello = (await post("chat.postMessage", { channel: C.general, text: "Hello from the conformance flow" })).json;
  assert.equal(hello.channel, C.general);
  assert.match(hello.ts, /^1789376400\.0000\d\d$/, "the six-digit fraction restarts in every virtual second");
  assert.equal(hello.message.text, "Hello from the conformance flow");
  assert.equal(hello.message.user, U.dana);
  assert.ok(!("subtype" in hello.message));
  const withBlocks = (await post("chat.postMessage", { channel: created.id, text: "Release 2026.37 is out", blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Release 2026.37* is out" } }] })).json;
  assert.equal(withBlocks.message.blocks.length, 1, "blocks arrive as a JSON string in the form and are stored");
  // Blocks that are not JSON answer invalid_blocks_format; JSON of the wrong shape answers invalid_blocks. Nothing is stored.
  const blocksRefused = async (method, args, error) => apiError("POST", method, args, 400, error, { rawBody: new URLSearchParams(args).toString() });
  await blocksRefused("chat.postMessage", { channel: created.id, text: "x", blocks: "{" }, "invalid_blocks_format");
  await blocksRefused("chat.postMessage", { channel: created.id, text: "x", blocks: '{"type":"section"}' }, "invalid_blocks");
  await blocksRefused("chat.postMessage", { channel: created.id, text: "x", blocks: '[{"text":"no type"}]' }, "invalid_blocks");
  await blocksRefused("chat.postMessage", { channel: created.id, text: "x", blocks: `[{"type":"section","a":${"[".repeat(40)}${"]".repeat(40)}}]` }, "invalid_blocks");
  await blocksRefused("chat.update", { channel: created.id, ts: withBlocks.ts, text: "x", blocks: "%7B" }, "invalid_blocks_format");
  await blocksRefused("chat.update", { channel: created.id, ts: withBlocks.ts, blocks: JSON.stringify([{ type: "section", text: "x".repeat(100001) }]) }, "invalid_blocks");
  await op("chat.reply", { channel: created.id, thread_ts: withBlocks.ts, text: "x", blocks: "{" }, "INVALID_BLOCKS_FORMAT");
  await op("chat.reply", { channel: created.id, thread_ts: withBlocks.ts, text: "x", blocks: [{ type: "section" }, { text: "no type" }] }, "INVALID_BLOCKS");
  assert.equal((await get("conversations.history", { channel: created.id, limit: "1" })).json.messages[0].ts, withBlocks.ts, "refused posts stored nothing");
  assert.ok(withBlocks.ts > hello.ts, "ts values are strictly increasing");
  // The same methods accept an application/json object body with the bearer token, as the Web API does; blocks travel
  // as a real array and booleans as JSON booleans. Bodies that are not a JSON object cannot be mapped to a call at all
  // and get the framework's 400 envelope, with Slack's error name in the text (README "Protocol compatibility").
  const beforeJson = (await get("conversations.history", { channel: created.id })).json.messages.length;
  const jsonPost = (method, args, options = {}) =>
    post(method, {}, { ...options, contentType: "application/json; charset=utf-8", rawBody: typeof args === "string" ? args : JSON.stringify(args) });
  const viaJson = (await jsonPost("chat.postMessage", { channel: created.id, text: "Posted as JSON", blocks: [{ type: "section", text: { type: "mrkdwn", text: "json" } }], mrkdwn: true })).json;
  assert.equal(viaJson.message.text, "Posted as JSON");
  assert.equal(viaJson.message.blocks[0].text.text, "json", "JSON blocks arrive as an array and are stored");
  assert.equal((await jsonPost("chat.update", { channel: created.id, ts: viaJson.ts, text: "Edited as JSON" })).json.text, "Edited as JSON");
  const jsonInfo = (await jsonPost("conversations.info", { channel: created.id, include_num_members: true })).json.channel;
  assert.equal(jsonInfo.is_member, true, "reads take JSON bodies on POST too");
  assert.equal(typeof jsonInfo.num_members, "number", "a JSON boolean is read as the flag");
  assert.equal((await jsonPost("chat.postMessage", { channel: created.id, text: "x", blocks: { type: "section" } }, { status: 400 })).json.error, "invalid_blocks");
  assert.equal((await jsonPost("chat.postMessage", { channel: created.id, text: "x", blocks: "{" }, { status: 400 })).json.error, "invalid_blocks_format");
  assert.equal((await jsonPost("chat.postMessage", { channel: created.id, text: "x", __proto__: { polluted: 1 }, constructor: { prototype: { polluted: 1 } } })).json.message.text, "x");
  assert.equal(({}).polluted, undefined, "caller keys never reach Object.prototype");
  for (const [rawBody, contentType, pattern] of [
    ['{"channel":', "application/json", /invalid_json/],
    ["[1]", "application/json", /json_not_object/],
    ["channel=x", "text/plain", /application\/x-www-form-urlencoded or application\/json/],
  ]) {
    const unmapped = await post("chat.postMessage", {}, { status: 400, contentType, rawBody });
    assert.equal(unmapped.json.code, "framework.HTTP_REQUEST_MAPPING_FAILED", JSON.stringify(unmapped.json));
    assert.match(unmapped.json.error, pattern);
  }
  assert.equal((await get("conversations.history", { channel: created.id })).json.messages.length, beforeJson + 2, "only viaJson and the poison probe were stored");
  const broadcast = (await post("chat.postMessage", { channel: C.engineering, text: "Broadcast reply from the conformance flow", thread_ts: TS.e1, reply_broadcast: "true" })).json;
  assert.equal(broadcast.message.thread_ts, TS.e1);
  assert.equal(broadcast.message.subtype, "thread_broadcast");
  const grown = (await get("conversations.replies", { channel: C.engineering, ts: TS.e1 })).json.messages;
  assert.equal(grown.length, 6);
  assert.equal(grown[0].reply_count, 5);
  assert.equal(grown[0].latest_reply, broadcast.ts);
  assert.equal(grown[0].reply_users_count, 3, "Dana already counted among reply_users");
  assert.equal(tsList((await engineeringHistory({ limit: "1" })).json.messages)[0], broadcast.ts, "broadcast replies show in history");
  const dm = (await post("chat.postMessage", { channel: newIm.channel.id, text: "Hi Priya, this is a synthetic DM." })).json;
  assert.equal(dm.channel, newIm.channel.id);
  await apiError("POST", "chat.postMessage", { channel: C.general, text: "   " }, 400, "no_text");
  await apiError("POST", "chat.postMessage", { channel: C.general }, 400, "no_text");
  await apiError("POST", "chat.postMessage", { channel: C.engineering, text: "x", thread_ts: TS.r1 }, 404, "thread_not_found");
  await apiError("POST", "chat.postMessage", { channel: C.engineering, text: "x", thread_ts: TS.unknown }, 404, "thread_not_found");
  const tooLong = await post("chat.postMessage", { channel: C.general, text: "x".repeat(40001) }, { status: 400 });
  assert.equal(tooLong.json.error, "invalid_arguments", "framework schema failures are rendered Slack-shaped");
  await op("chat.reply", { channel: C.general, thread_ts: TS.g1, text: "" }, "NO_TEXT");
  await op("chat.reply", { channel: C.general, thread_ts: TS.unknown, text: "x" }, "THREAD_NOT_FOUND");

  // Update ------------------------------------------------------------------------------------------
  const edited = (await post("chat.update", { channel: C.general, ts: hello.ts, text: "Hello from the conformance flow (edited)" })).json;
  assert.equal(edited.text, "Hello from the conformance flow (edited)");
  assert.equal(edited.message.edited.user, U.dana);
  assert.equal(edited.message.edited.ts, "1789376400.000000");
  const generalNow = (await get("conversations.history", { channel: C.general })).json.messages;
  assert.equal(generalNow.find((message) => message.ts === hello.ts).text, "Hello from the conformance flow (edited)", "reads reflect the write");
  await apiError("POST", "chat.update", { channel: C.engineering, ts: TS.e3, text: "not mine" }, 403, "cant_update_message");
  await apiError("POST", "chat.update", { channel: C.engineering, ts: TS.join, text: "system" }, 403, "cant_update_message");
  await apiError("POST", "chat.update", { channel: C.general, ts: TS.unknown, text: "x" }, 404, "message_not_found");
  await apiError("POST", "chat.update", { channel: C.general, ts: hello.ts, text: "" }, 400, "no_text");
  await apiError("POST", "chat.update", { channel: C.general, ts: hello.ts }, 400, "no_text");

  // Reactions -------------------------------------------------------------------------------------
  await post("reactions.add", { channel: C.general, timestamp: hello.ts, name: ":rocket:" });
  let reacted = (await get("conversations.history", { channel: C.general })).json.messages.find((message) => message.ts === hello.ts);
  assert.deepEqual(reacted.reactions, [{ name: "rocket", users: [U.dana], count: 1 }]);
  await apiError("POST", "reactions.add", { channel: C.general, timestamp: hello.ts, name: "rocket" }, 409, "already_reacted");
  await apiError("POST", "reactions.add", { channel: C.general, timestamp: hello.ts, name: "Rocket!" }, 400, "invalid_name");
  await apiError("POST", "reactions.add", { channel: C.general, timestamp: TS.unknown, name: "rocket" }, 404, "message_not_found");
  await post("reactions.remove", { channel: C.general, timestamp: hello.ts, name: "rocket" });
  reacted = (await get("conversations.history", { channel: C.general })).json.messages.find((message) => message.ts === hello.ts);
  assert.ok(!("reactions" in reacted), "an empty reaction list is omitted, as in Slack");
  await apiError("POST", "reactions.remove", { channel: C.general, timestamp: hello.ts, name: "rocket" }, 404, "no_reaction");
  await apiError("POST", "reactions.remove", { channel: C.general, timestamp: hello.ts, name: "Rocket!" }, 400, "invalid_name");
  await apiError("POST", "reactions.remove", { channel: C.general, timestamp: TS.unknown, name: "rocket" }, 404, "message_not_found");
  await apiError("POST", "reactions.remove", { channel: C.engineering, timestamp: TS.e2, name: "+1" }, 404, "no_reaction", {});
  await post("reactions.remove", { channel: C.engineering, timestamp: TS.e8, name: "eyes" });
  for (let index = 0; index < 50; index += 1) await post("reactions.add", { channel: C.general, timestamp: hello.ts, name: `conf_${String(index).padStart(2, "0")}` });
  await apiError("POST", "reactions.add", { channel: C.general, timestamp: hello.ts, name: "one_too_many" }, 400, "too_many_reactions");
  await post("reactions.add", { channel: C.general, timestamp: hello.ts, name: "conf_00" }, { status: 409 });

  // Pins ---------------------------------------------------------------------------------------------
  await post("pins.add", { channel: C.general, timestamp: hello.ts });
  await apiError("POST", "pins.add", { channel: C.general, timestamp: hello.ts }, 409, "already_pinned");
  await apiError("POST", "pins.add", { channel: C.general, timestamp: TS.unknown }, 404, "message_not_found");
  const pins = (await get("pins.list", { channel: C.general })).json.items;
  assert.deepEqual(pins.map((item) => item.message.ts), [hello.ts, TS.g1], "newest pin first");
  assert.equal(pins[0].created_by, U.dana);
  assert.equal(pins[0].message.channel, C.general);
  assert.deepEqual(pins[0].message.pinned_to, [C.general]);
  assert.ok(pins[1].message.permalink.endsWith("/p1787216400000101"));
  assert.equal((await get("conversations.history", { channel: C.general })).json.pin_count, 2);
  await post("pins.remove", { channel: C.general, timestamp: hello.ts });
  await apiError("POST", "pins.remove", { channel: C.general, timestamp: hello.ts }, 404, "not_pinned");
  assert.equal((await post("pins.list", { channel: C.general })).json.items.length, 1);

  // Delete -----------------------------------------------------------------------------------------
  await post("chat.delete", { channel: C.engineering, ts: broadcast.ts });
  const shrunk = (await get("conversations.replies", { channel: C.engineering, ts: TS.e1 })).json.messages;
  assert.equal(shrunk.length, 5);
  assert.equal(shrunk[0].reply_count, 4);
  assert.equal(shrunk[0].latest_reply, TS.r4, "parent counters recomputed");
  await post("chat.delete", { channel: C.engineering, ts: TS.e3 }, {});
  assert.ok(!tsList((await engineeringHistory({})).json.messages).includes(TS.e3), "admins can delete other members' messages");
  await post("chat.delete", { channel: C.engineering, ts: TS.e1 });
  const tombstone = (await engineeringHistory({})).json.messages.find((message) => message.ts === TS.e1);
  assert.equal(tombstone.subtype, "tombstone");
  assert.equal(tombstone.text, "This message was deleted.");
  assert.equal(tombstone.reply_count, 4);
  assert.equal((await get("conversations.replies", { channel: C.engineering, ts: TS.e1 })).json.messages.length, 5, "replies survive the tombstone");
  await apiError("POST", "chat.delete", { channel: C.engineering, ts: TS.e1 }, 404, "message_not_found");
  await apiError("POST", "chat.delete", { channel: C.general, ts: TS.unknown }, 404, "message_not_found");
  await apiError("POST", "chat.postMessage", { channel: C.engineering, text: "x", thread_ts: TS.e1 }, 404, "thread_not_found", {});

  // Archive -----------------------------------------------------------------------------------------
  assert.deepEqual((await post("conversations.archive", { channel: created.id })).json, { ok: true });
  await apiError("POST", "conversations.archive", { channel: created.id }, 400, "already_archived");
  await apiError("POST", "conversations.archive", { channel: C.general }, 400, "method_not_supported_for_channel_type");
  await apiError("POST", "conversations.archive", { channel: C.im }, 400, "method_not_supported_for_channel_type");
  assert.equal((await get("conversations.info", { channel: created.id })).json.channel.is_archived, true);
  assert.equal((await get("conversations.list", { exclude_archived: "true" })).json.channels.some((channel) => channel.id === created.id), false);

  // Framework-owned edges rendered Slack-shaped or as framework errors ------------------------------
  const multipart = await post("chat.postMessage", {}, { status: 400, contentType: "multipart/form-data; boundary=x", rawBody: "--x--" });
  assert.equal(multipart.json.code, "framework.HTTP_REQUEST_MAPPING_FAILED", "unsupported body encodings are refused by the codec, not stored");
  assert.equal((await api("POST", "chat.meMessage", { channel: C.general, text: "x" }, { status: 404 })).json.code, "framework.HTTP_ROUTE_NOT_FOUND");
  assert.equal((await api("GET", "chat.postMessage", { channel: C.general, text: "x" }, { status: 405 })).json.code, "framework.HTTP_METHOD_NOT_ALLOWED");
  const missingToken = await fetch(`${HTTP}/api/auth.test`);
  assert.equal(missingToken.status, 401);
  return { created: created.id, posted: hello.ts };
}

// ---------------------------------------------------------------------------------------------
// Drill: mcp-aliases (member, baseline)
// ---------------------------------------------------------------------------------------------

async function mcpAliases() {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "slack-conformance", version: "0.1.0" } });
  const tools = (await rpc("tools/list", {})).tools.map((tool) => tool.name);
  const aliases = ["slack_list_channels", "slack_post_message", "slack_reply_to_thread", "slack_add_reaction", "slack_get_channel_history", "slack_get_thread_replies", "slack_get_users", "slack_get_user_profile"];
  for (const alias of aliases) assert.ok(tools.includes(alias), `alias ${alias} missing`);
  for (const operationId of ALL_OPERATIONS) assert.ok(tools.includes(`slack.${operationId}`), `canonical slack.${operationId} missing`);

  const users = await mcp("slack_get_users", { limit: 2 });
  assert.equal(users.members.length, 2);
  assert.ok(users.response_metadata.next_cursor);
  const profile = await mcp("slack_get_user_profile", { user_id: U.mira });
  assert.equal(profile.profile.status_emoji, ":palm_tree:");
  assert.equal(profile.profile.real_name, "Mira Chen");
  const first = await mcp("slack_list_channels", { limit: 3 });
  assert.deepEqual(first.channels.map((channel) => channel.id), [C.design, C.engineering, C.general]);
  const second = await mcp("slack_list_channels", { limit: 3, cursor: first.response_metadata.next_cursor });
  assert.deepEqual(second.channels.map((channel) => channel.id), [C.launch, C.onboarding, C.random]);
  assert.equal(second.response_metadata.next_cursor, "");
  const history = await mcp("slack_get_channel_history", { channel_id: C.engineering, limit: 5 });
  assert.equal(history.messages.length, 5);
  assert.equal(history.has_more, true);
  const thread = await mcp("slack_get_thread_replies", { channel_id: C.engineering, thread_ts: TS.e1 });
  assert.equal(thread.messages.length, 5);
  const posted = await mcp("slack_post_message", { channel_id: C.general, text: "Posted through the reference MCP alias" });
  assert.equal(posted.ok, true);
  assert.equal(posted.channel, C.general);
  const reply = await mcp("slack_reply_to_thread", { channel_id: C.engineering, thread_ts: TS.e1, text: "Replying through the reference MCP alias" });
  assert.equal(reply.message.thread_ts, TS.e1);
  assert.equal((await mcp("slack_get_thread_replies", { channel_id: C.engineering, thread_ts: TS.e1 })).messages[0].reply_count, 5);
  assert.deepEqual(await mcp("slack_add_reaction", { channel_id: C.general, timestamp: posted.ts, reaction: "white_check_mark" }), { ok: true });

  await mcpError("slack_post_message", { channel_id: C.general, channel: C.general, text: "x" }, "tool.INVALID_ARGUMENTS");
  await mcpError("slack_post_message", { channel_id: C.general }, "tool.NO_TEXT");
  await mcpError("slack_add_reaction", { channel_id: C.general, timestamp: posted.ts, reaction: "white_check_mark" }, "tool.ALREADY_REACTED");
  await mcpError("slack_get_thread_replies", { channel_id: C.engineering, thread_ts: TS.unknown }, "tool.THREAD_NOT_FOUND");
  await mcpError("slack_reply_to_thread", { channel_id: C.engineering, thread_ts: TS.e1 });
  await mcpError("slack_get_channel_history", { channel_id: C.leadership }, "tool.CHANNEL_NOT_FOUND");

  const confirm = (await get("conversations.history", { channel: C.general, limit: "1" })).json.messages[0];
  assert.equal(confirm.ts, posted.ts, "the MCP write is visible over HTTP");
  assert.deepEqual(confirm.reactions, [{ name: "white_check_mark", users: [U.dana], count: 1 }]);
}

// ---------------------------------------------------------------------------------------------
// Drill: visibility (contractor = Priya, baseline)
// ---------------------------------------------------------------------------------------------

async function visibility() {
  assert.equal((await get("auth.test")).json.user_id, U.priya);
  const visible = (await get("conversations.list", { types: "public_channel,private_channel,mpim,im" })).json.channels;
  assert.deepEqual(visible.map((channel) => channel.id), [C.design, C.engineering, C.general, C.launch, C.onboarding, C.random]);
  assert.ok(visible.every((channel) => channel.is_private === false), "no private conversation leaks");
  assert.deepEqual(visible.filter((channel) => channel.is_member).map((channel) => channel.id), [C.general, C.random]);
  await apiError("GET", "conversations.info", { channel: C.incidents }, 404, "channel_not_found");
  await apiError("GET", "conversations.info", { channel: C.im }, 404, "channel_not_found");
  await apiError("GET", "conversations.history", { channel: C.engineering }, 403, "not_in_channel");
  assert.equal((await get("search.messages", { query: "deploy" })).json.messages.total, 0, "search covers only the member's conversations");
  await post("conversations.join", { channel: C.engineering });
  assert.ok((await get("conversations.history", { channel: C.engineering })).json.messages.length > 0);
  assert.equal((await get("search.messages", { query: "deploy" })).json.messages.total, 4);
  await apiError("POST", "chat.update", { channel: C.general, ts: TS.g1, text: "hijack" }, 403, "cant_update_message");
  await apiError("POST", "chat.delete", { channel: C.general, ts: TS.g1 }, 403, "cant_delete_message");
  await apiError("POST", "conversations.archive", { channel: C.general }, 400, "method_not_supported_for_channel_type");
  const im = (await post("conversations.open", { users: U.dana, return_im: "true" })).json;
  assert.equal(im.already_open, false, "Priya has no IM with Dana yet");
  assert.equal(im.channel.user, U.dana);
  const posted = (await post("chat.postMessage", { channel: im.channel.id, text: "Hi Dana, quick question about the contract." })).json;
  assert.equal((await get("conversations.history", { channel: im.channel.id })).json.messages[0].ts, posted.ts);
  assert.equal((await get("conversations.history", { channel: C.general })).json.messages.find((message) => message.ts === TS.g1).text.startsWith("Welcome to Example Team!"), true);
}

// ---------------------------------------------------------------------------------------------
// Drill: denied (auditor, baseline)
// ---------------------------------------------------------------------------------------------

async function denied() {
  const auth = await get("auth.test", {}, { status: 403 });
  assert.deepEqual(auth.json, { ok: false, error: "missing_scope", needed: "slack.auth.test", provided: "" });
  const posted = await post("chat.postMessage", { channel: C.general, text: "nope" }, { status: 403 });
  assert.equal(posted.json.error, "missing_scope");
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "slack-conformance", version: "0.1.0" } });
  const result = await rpc("tools/call", { name: "slack_list_channels", arguments: {} });
  assert.ok(result.isError);
  assert.equal(result.structuredContent.status, "denied");
}

// ---------------------------------------------------------------------------------------------
// Drill: invalid-auth (ghost, baseline)
// ---------------------------------------------------------------------------------------------

async function invalidAuth() {
  await apiError("GET", "auth.test", {}, 401, "invalid_auth");
  await apiError("POST", "conversations.list", {}, 401, "invalid_auth");
  const minimal = {
    "users.list": {},
    "users.info": { user: U.dana },
    "users.profile.get": {},
    "conversations.info": { channel: C.general },
    "conversations.members": { channel: C.general },
    "conversations.create": { name: "ghost-channel" },
    "conversations.join": { channel: C.design },
    "conversations.invite": { channel: C.general, users: U.sam },
    "conversations.open": { users: U.sam },
    "conversations.archive": { channel: C.random },
    "conversations.set-topic": { channel: C.general, topic: "x" },
    "conversations.history": { channel: C.general },
    "conversations.replies": { channel: C.general, ts: TS.g1 },
    "chat.post-message": { channel: C.general, text: "x" },
    "chat.reply": { channel: C.general, thread_ts: TS.g1, text: "x" },
    "chat.update": { channel: C.general, ts: TS.g1, text: "x" },
    "chat.delete": { channel: C.general, ts: TS.g1 },
    "reactions.add": { channel: C.general, timestamp: TS.g1, name: "eyes" },
    "reactions.remove": { channel: C.general, timestamp: TS.g1, name: "eyes" },
    "pins.add": { channel: C.general, timestamp: TS.g1 },
    "pins.remove": { channel: C.general, timestamp: TS.g1 },
    "pins.list": { channel: C.general },
    "search.messages": { query: "deploy" },
  };
  for (const operationId of ALL_OPERATIONS) {
    if (operationId === "auth.test" || operationId === "conversations.list") continue;
    assert.ok(operationId in minimal, `no minimal arguments for ${operationId}`);
    await op(operationId, minimal[operationId], "INVALID_AUTH");
  }
}

// ---------------------------------------------------------------------------------------------
// Drill: post-rate-limited (member, scenario post-rate-limited)
// ---------------------------------------------------------------------------------------------

async function postRateLimited() {
  const before = (await get("conversations.history", { channel: C.general })).json.messages.length;
  const limited = await apiError("POST", "chat.postMessage", { channel: C.general, text: "x" }, 429, "ratelimited");
  assert.equal(limited.headers.get("retry-after"), "30");
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "slack-conformance", version: "0.1.0" } });
  await mcpError("slack_reply_to_thread", { channel_id: C.engineering, thread_ts: TS.e1, text: "x" }, "tool.RATELIMITED");
  const update = await apiError("POST", "chat.update", { channel: C.engineering, ts: TS.e2, text: "x" }, 429, "ratelimited");
  assert.equal(update.headers.get("retry-after"), "30");
  assert.equal((await get("conversations.history", { channel: C.general })).json.messages.length, before, "no message was stored");
  assert.deepEqual((await post("reactions.add", { channel: C.general, timestamp: TS.g1, name: "eyes" })).json, { ok: true }, "the fault is scoped to posting");
}

// ---------------------------------------------------------------------------------------------
// Drill: history-unavailable (member, scenario history-unavailable)
// ---------------------------------------------------------------------------------------------

async function historyUnavailable() {
  await apiError("GET", "conversations.history", { channel: C.general }, 503, "service_unavailable");
  await apiError("GET", "search.messages", { query: "deploy" }, 503, "service_unavailable");
  assert.equal((await get("conversations.replies", { channel: C.engineering, ts: TS.e1 })).json.messages.length, 5, "replies keep working");
  assert.equal((await get("conversations.info", { channel: C.general })).json.channel.id, C.general);
  assert.equal((await get("pins.list", { channel: C.general })).json.items.length, 1);
}

// ---------------------------------------------------------------------------------------------
// Drill: fresh-install (newcomer: no identity attributes, every grant; baseline)
// ---------------------------------------------------------------------------------------------

async function freshInstall() {
  // Without a userId attribute the actor acts as the first active human member in users row-id order (Dana).
  const who = (await get("auth.test")).json;
  assert.equal(who.user_id, U.dana);
  assert.equal(who.user, "dana.reyes");
  assert.equal((await get("users.profile.get")).json.profile.real_name, "Dana Reyes", "the default member's own profile");
  assert.deepEqual((await get("conversations.list")).json.channels.map((channel) => channel.id), [C.design, C.engineering, C.general, C.launch, C.onboarding, C.random]);
  assert.equal((await get("conversations.history", { channel: C.incidents })).json.messages.length, 3, "private membership follows the resolved member (3 top-level messages; the two thread replies are not)");
  assert.equal((await get("users.list")).json.members.length, 6);
  const posted = (await post("chat.postMessage", { channel: C.general, text: "Posted with no actor attributes" })).json;
  assert.equal(posted.message.user, U.dana);
  assert.equal(posted.ts, "1789376400.000001", "no message_second yet: the first allocation restarts the sequence");
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "slack-conformance", version: "0.1.0" } });
  assert.equal((await mcp("slack_get_users", { limit: 1 })).members[0].id, U.dana);
}

// ---------------------------------------------------------------------------------------------
// Drill: bounds (member, scenario bounds)
// ---------------------------------------------------------------------------------------------

async function bounds() {
  // workspace.limits { users: 5, conversations: 8, members: 1, messages: 2, pins: 1 } sit below the authored rows
  // (6 users, 10 conversations, 2–5 members per conversation, 4 messages in #general including the scenario's thread with
  // 50 distinct repliers, 15 in #engineering, and two pins in #general with the scenario's extra pin). Every bounded read must refuse explicitly and store nothing.
  const tooMany = (verb, method, args) => apiError(verb, method, args, 400, "too_many_rows");
  const users = await tooMany("GET", "users.list", {});
  assert.match(users.json.response_metadata.messages[0], /^users exceed the supported bound of 5 rows/);
  await tooMany("GET", "conversations.list", {});
  await tooMany("GET", "conversations.info", { channel: C.general, include_num_members: "true" });
  await tooMany("GET", "conversations.members", { channel: C.general });
  await tooMany("POST", "conversations.create", { name: "bounds-test" });
  await tooMany("POST", "conversations.join", { channel: C.general });
  await tooMany("POST", "conversations.invite", { channel: C.engineering, users: U.priya });
  await tooMany("POST", "conversations.open", { users: U.sam });
  await tooMany("POST", "conversations.setTopic", { channel: C.im, topic: "x" });
  const history = await tooMany("GET", "conversations.history", { channel: C.general });
  assert.match(history.json.response_metadata.messages[0], /^messages in C01GENERAL1 exceed the supported bound of 2 rows/);
  await tooMany("GET", "conversations.replies", { channel: C.engineering, ts: TS.e1 });
  await tooMany("POST", "chat.delete", { channel: C.engineering, ts: TS.r1 });
  // A reply to a thread whose reply_users list is already full looks for an earlier reply by the caller before any ts is
  // allocated; with #general over its message bound that lookup refuses, naming only the existing channel.
  const fullThread = "1789290000.000199";
  const reply = await tooMany("POST", "chat.postMessage", { channel: C.general, thread_ts: fullThread, text: "one more" });
  assert.match(reply.json.response_metadata.messages[0], /^messages in C01GENERAL1 exceed the supported bound of 2 rows/);
  assert.equal(/\d{10}\.\d{6}/.test(reply.json.response_metadata.messages[0]), false, "the refusal names no ts");
  await op("chat.reply", { channel: C.general, thread_ts: fullThread, text: "one more" }, "TOO_MANY_ROWS");
  const pin = await tooMany("POST", "pins.add", { channel: C.general, timestamp: "1789036200.000103" });
  assert.match(pin.json.response_metadata.messages[0], /^pins in C01GENERAL1 exceed the supported bound of 1 rows/);
  await tooMany("GET", "pins.list", { channel: C.general });
  await tooMany("GET", "search.messages", { query: "deploy" });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "slack-conformance", version: "0.1.0" } });
  await mcpError("slack_get_channel_history", { channel_id: C.general }, "tool.TOO_MANY_ROWS");

  // Reads and writes by id never scan and keep working.
  assert.equal((await get("auth.test")).json.user_id, U.dana);
  assert.equal((await get("users.info", { user: U.mira })).json.user.tz, "Asia/Singapore");
  assert.equal((await get("conversations.info", { channel: C.general })).json.channel.is_member, true, "no member count requested, no membership scan");
  const posted = (await post("chat.postMessage", { channel: C.general, text: "Bounded, but posting by id works" })).json;
  assert.equal(posted.message.user, U.dana);
  assert.equal((await post("chat.update", { channel: C.general, ts: posted.ts, text: "edited" })).json.text, "edited");
  assert.deepEqual((await post("reactions.add", { channel: C.general, timestamp: posted.ts, name: "eyes" })).json, { ok: true });
  assert.deepEqual((await post("pins.remove", { channel: C.general, timestamp: TS.g1 })).json, { ok: true });
}

// ---------------------------------------------------------------------------------------------
// Drill: open-member-bound (member, scenario open-member-bound)
// ---------------------------------------------------------------------------------------------

async function openMemberBound() {
  // workspace.limits.members is 2. A three-person group DM exceeds it: the refusal happens before an id is allocated,
  // so the error names the count and the limit only, and the ids the open would have used stay free.
  const conversationIdPattern = /\b[CD][0-9A-Z]{10}\b/;
  const refused = await apiError("POST", "conversations.open", { users: `${U.priya},${U.mira}`, return_im: "true" }, 400, "too_many_rows");
  const message = refused.json.response_metadata.messages[0];
  assert.equal(message, "members of the requested conversation (3) exceed the supported bound of 2 rows (workspace.limits.members)");
  assert.doesNotMatch(JSON.stringify(refused.json), conversationIdPattern, "the error body names no conversation id");
  const refusedPlain = await apiError("POST", "conversations.open", { users: `${U.priya},${U.mira}` }, 400, "too_many_rows");
  assert.doesNotMatch(JSON.stringify(refusedPlain.json), conversationIdPattern, "without return_im the bound holds too");

  // Nothing was stored: the id the open would have allocated does not exist and Dana's group DMs are unchanged.
  await apiError("GET", "conversations.info", { channel: "C000000001F" }, 404, "channel_not_found");
  assert.deepEqual((await get("conversations.list", { types: "mpim" })).json.channels.map((channel) => channel.id), [C.mpdm]);

  // Within the bound, opening works and takes the first free id; its view is built from the rows just written.
  const im = (await post("conversations.open", { users: U.priya, return_im: "true" })).json;
  assert.equal(im.already_open, false);
  assert.equal(im.channel.id, "D000000001F", "the refused opens consumed no id");
  assert.equal(im.channel.is_im, true);
  assert.equal(im.channel.user, U.priya);
  assert.equal(im.channel.is_member, true);
  assert.equal(im.channel.num_members, 2);
  assert.deepEqual((await get("conversations.members", { channel: im.channel.id })).json.members, [U.dana, U.priya]);

  // A later conversations.create succeeds with the next id, which never appeared in an error.
  const created = (await post("conversations.create", { name: "after-refused-open" })).json.channel;
  assert.equal(created.id, "C000000001G");
  assert.equal(created.num_members, 1);
  assert.equal(created.is_member, true);
  const info = (await get("conversations.info", { channel: created.id, include_num_members: "true" })).json.channel;
  assert.equal(info.name, "after-refused-open");
  assert.equal(info.num_members, 1);
  for (const id of [im.channel.id, created.id]) {
    assert.ok(!JSON.stringify(refused.json).includes(id) && !JSON.stringify(refusedPlain.json).includes(id), `${id} appeared in an error`);
  }
}

// ---------------------------------------------------------------------------------------------
// Drill: open-long-handles (member, scenario open-long-handles)
// ---------------------------------------------------------------------------------------------

async function openLongHandles() {
  // Eight extra members have 21-character handles. A group DM's plain name `mpdm-<handles joined by -->-1` would pass the
  // 80-character conversation name for five or more such members; those names keep a prefix and end in a digest.
  const L = [1, 2, 3, 4, 5, 6, 7, 8].map((index) => ({ id: `U01LONG000${index}`, handle: `longhandle${index}xxxxxxxxxx` }));
  const ids = (members) => members.map((member) => member.id).join(",");
  const NAME = /^[a-z0-9._-]{1,80}$/;

  const short = (await post("conversations.open", { users: ids(L.slice(0, 2)), return_im: "true" })).json.channel;
  assert.equal(short.name, `mpdm-dana.reyes--${L[0].handle}--${L[1].handle}-1`, "names that fit keep the plain form");

  const five = (await post("conversations.open", { users: ids(L.slice(0, 4)), return_im: "true" })).json;
  assert.equal(five.already_open, false);
  assert.equal(five.channel.is_mpim, true);
  assert.equal(five.channel.num_members, 5);
  assert.equal(five.channel.name, "mpdm-dana.reyes--longhandle1xxxxxxxxxx--longhandle2xxxxxxxxxx--longha-9c7e80ed-1");
  assert.equal(five.channel.name_normalized, five.channel.name);

  const nine = (await post("conversations.open", { users: ids(L), return_im: "true" })).json.channel;
  assert.equal(nine.num_members, 9);
  assert.equal(nine.name, "mpdm-dana.reyes--longhandle1xxxxxxxxxx--longhandle2xxxxxxxxxx--longha-98de6b61-1");
  const four = (await post("conversations.open", { users: ids(L.slice(0, 3)) })).json.channel;

  for (const channel of [short, five.channel, nine]) {
    assert.ok(channel.name.length <= 80, `${channel.name} is longer than 80 characters`);
    assert.match(channel.name, NAME);
  }
  const names = new Set([short.name, five.channel.name, nine.name, (await get("conversations.info", { channel: four.id })).json.channel.name]);
  assert.equal(names.size, 4, "different member sets keep distinct names even when the prefix is shared");

  // The group DMs were stored: reopening finds them (in any order), info and members read them back.
  assert.equal((await post("conversations.open", { users: ids([...L].reverse()) })).json.channel.id, nine.id);
  assert.equal((await post("conversations.open", { users: ids(L.slice(0, 4)) })).json.already_open, true);
  const info = (await get("conversations.info", { channel: nine.id, include_num_members: "true" })).json.channel;
  assert.equal(info.name, nine.name);
  assert.equal(info.num_members, 9);
  assert.equal((await get("conversations.members", { channel: nine.id })).json.members.length, 9);
  const mpims = (await get("conversations.list", { types: "mpim" })).json.channels.map((channel) => channel.id);
  for (const id of [short.id, five.channel.id, nine.id, four.id]) assert.ok(mpims.includes(id), `${id} missing from mpim list`);
  const message = (await post("chat.postMessage", { channel: nine.id, text: "Hello, long handles" })).json;
  assert.equal(message.channel, nine.id);
}

// ---------------------------------------------------------------------------------------------
// Drill: thread-many-repliers (member, scenario thread-many-repliers)
// ---------------------------------------------------------------------------------------------

async function threadManyRepliers() {
  // The scenario seeds a #general parent whose reply_users already lists 50 distinct repliers (the stored bound).
  const parentTs = "1789290000.000199";
  const first = (await post("chat.postMessage", { channel: C.general, thread_ts: parentTs, text: "51st participant here" })).json;
  assert.equal(first.ok, true);
  assert.equal(first.message.thread_ts, parentTs);
  let parent = (await get("conversations.replies", { channel: C.general, ts: parentTs })).json.messages[0];
  assert.equal(parent.reply_count, 51);
  assert.equal(parent.reply_users_count, 51);
  assert.equal(parent.reply_users.length, 50);
  assert.equal(parent.reply_users.includes(U.dana), false, "reply_users keeps the first 50 repliers");
  assert.equal(parent.latest_reply, first.ts);
  // The same participant replying again is not counted twice even though reply_users does not list them.
  const second = (await post("chat.postMessage", { channel: C.general, thread_ts: parentTs, text: "and a follow-up" })).json;
  parent = (await get("conversations.replies", { channel: C.general, ts: parentTs })).json.messages[0];
  assert.equal(parent.reply_count, 52);
  assert.equal(parent.reply_users_count, 51);
  assert.equal(parent.reply_users.length, 50);
  assert.equal(parent.latest_reply, second.ts);
}

// ---------------------------------------------------------------------------------------------
// Drill: response-budget (member, scenario response-budget)
// ---------------------------------------------------------------------------------------------

async function responseBudget() {
  // workspace.limits.response_bytes is 4,000: every list and read sizes its page by the UTF-8 bytes of the encoded body.
  const BUDGET = 4000;
  const call = async (verb, method, args) => {
    const query = new URLSearchParams(args).toString();
    const response = await fetch(verb === "GET" ? `${HTTP}/api/${method}?${query}` : `${HTTP}/api/${method}`, {
      method: verb,
      headers: { authorization: `Bearer ${HTTP_TOKEN}`, ...(verb === "GET" ? {} : { "content-type": "application/x-www-form-urlencoded" }) },
      ...(verb === "GET" ? {} : { body: query }),
    });
    const text = await response.text();
    return { status: response.status, bytes: Buffer.byteLength(text), json: JSON.parse(text) };
  };
  const pages = async (method, args, listOf) => {
    const items = [];
    let cursor = "";
    let count = 0;
    do {
      const result = await call("GET", method, { ...args, ...(cursor ? { cursor } : {}) });
      assert.equal(result.status, 200, `${method}: ${JSON.stringify(result.json).slice(0, 300)}`);
      assert.ok(result.bytes <= BUDGET, `${method} page of ${result.bytes} bytes exceeds ${BUDGET}`);
      items.push(...listOf(result.json));
      cursor = result.json.response_metadata.next_cursor;
      count += 1;
      assert.ok(count < 100, `${method} never finished paging`);
    } while (cursor);
    return { items, count };
  };
  const users = await pages("users.list", { limit: "100" }, (json) => json.members.map((member) => member.id));
  assert.deepEqual(users.items, Object.values(U).sort(), "every user exactly once, in id order");
  assert.ok(users.count >= 1);
  const channels = await pages("conversations.list", { types: "public_channel,private_channel,mpim,im", limit: "100" }, (json) => json.channels.map((channel) => channel.id));
  assert.equal(new Set(channels.items).size, channels.items.length);
  assert.ok(channels.items.includes(C.general) && channels.items.includes(C.im));
  assert.deepEqual(channels.items, [...channels.items].sort(), "conversations in id order across pages");

  // Messages with multi-byte text (ü is 2 bytes, 1 UTF-16 unit): pages hold fewer messages, none is skipped or repeated.
  const wide = "ü".repeat(600);
  const posted = [];
  for (let index = 0; index < 5; index += 1) posted.push((await post("chat.postMessage", { channel: C.general, text: `budgetprobe ${index} ${wide}` })).json.ts);
  const history = await pages("conversations.history", { channel: C.general, limit: "100" }, (json) => json.messages.map((message) => message.ts));
  assert.equal(new Set(history.items).size, history.items.length, "no message repeats across pages");
  for (const ts of posted) assert.ok(history.items.includes(ts), `${ts} missing from history`);
  assert.deepEqual(history.items, [...history.items].sort().reverse(), "newest first across pages");
  assert.ok(history.count >= 3, `history took ${history.count} pages`);
  const replies = [];
  for (let index = 0; index < 4; index += 1) replies.push((await post("chat.postMessage", { channel: C.general, thread_ts: posted[0], text: `budgetprobe reply ${index} ${wide}` })).json.ts);
  const thread = await pages("conversations.replies", { channel: C.general, ts: posted[0], limit: "100" }, (json) => json.messages.map((message) => message.ts));
  assert.deepEqual(thread.items, [posted[0], ...replies], "parent once, then every reply once");

  // search.messages keeps page arithmetic uniform: per_page drops until every page fits.
  const found = [];
  let pageCount = 1;
  for (let page = 1; page <= pageCount; page += 1) {
    const result = await call("GET", "search.messages", { query: "budgetprobe", count: "100", page: String(page) });
    assert.equal(result.status, 200);
    assert.ok(result.bytes <= BUDGET, `search page ${page} is ${result.bytes} bytes`);
    assert.ok(result.json.messages.paging.count < 100 && result.json.messages.pagination.per_page === result.json.messages.paging.count);
    found.push(...result.json.messages.matches.map((match) => match.ts));
    pageCount = result.json.messages.paging.pages;
  }
  assert.deepEqual([...found].sort(), [...posted, ...replies].sort(), "every match exactly once");

  // One message over the budget answers response_too_large, never an oversized or empty page.
  const huge = (await post("chat.postMessage", { channel: C.general, text: `budgethuge ${"ü".repeat(2000)}` })).json.ts;
  const tooLarge = async (method, args) => {
    const result = await call("GET", method, args);
    assert.equal(result.status, 400, `${method}: ${JSON.stringify(result.json).slice(0, 300)}`);
    assert.equal(result.json.error, "response_too_large");
    assert.match(result.json.response_metadata.messages[0], /response budget of 4000 bytes/);
  };
  await tooLarge("conversations.history", { channel: C.general });
  await tooLarge("search.messages", { query: "budgethuge" });
  assert.deepEqual((await post("pins.add", { channel: C.general, timestamp: huge })).json, { ok: true });
  await tooLarge("pins.list", { channel: C.general });
  await post("chat.postMessage", { channel: C.general, thread_ts: posted[0], text: `budgethuge reply ${"ü".repeat(2000)}` });
  let cursor = "";
  for (let step = 0; ; step += 1) {
    assert.ok(step < 20, "replies never reached the oversized reply");
    const result = await call("GET", "conversations.replies", { channel: C.general, ts: posted[0], ...(cursor ? { cursor } : {}) });
    if (result.status === 400) {
      assert.equal(result.json.error, "response_too_large");
      break;
    }
    assert.equal(result.status, 200);
    assert.equal(result.json.has_more, true, "the oversized reply is still ahead");
    cursor = result.json.response_metadata.next_cursor;
  }
  // Older history stays reachable past the oversized message with the ts window.
  const older = await call("GET", "conversations.history", { channel: C.general, latest: huge, limit: "1" });
  assert.equal(older.status, 200);
  assert.equal(older.json.messages[0].ts, posted[4]);
}

// ---------------------------------------------------------------------------------------------
// Drill: ts-sequence-full (member, scenario ts-sequence-full)
// ---------------------------------------------------------------------------------------------

async function tsSequenceFull() {
  // workspace.message_second is the frozen virtual second (1789376400) with message_sequence 999997, and an authored
  // message already occupies 1789376400.999998 in #incidents. The first post skips the occupied fraction and takes the
  // last one, .999999; every further allocation in this second refuses with too_many_rows before anything is written.
  const first = (await post("chat.postMessage", { channel: C.incidents, text: "the last ts of this second" })).json;
  assert.equal(first.ts, "1789376400.999999");
  const full = await apiError("POST", "chat.postMessage", { channel: C.incidents, text: "one too many" }, 400, "too_many_rows");
  assert.match(full.json.response_metadata.messages[0], /^message ts limit reached: virtual second 1789376400 already holds 999999 message timestamps/);
  assert.equal(/\d{10}\.\d{6}/.test(full.json.response_metadata.messages[0]), false, "the refusal names no ts");
  await apiError("POST", "chat.postMessage", { channel: C.incidents, text: "reply", thread_ts: first.ts }, 400, "too_many_rows");
  await op("chat.reply", { channel: C.incidents, thread_ts: first.ts, text: "reply" }, "TOO_MANY_ROWS");
  await apiError("POST", "conversations.join", { channel: C.design }, 400, "too_many_rows");
  await apiError("POST", "conversations.invite", { channel: C.incidents, users: U.priya }, 400, "too_many_rows");
  // Nothing was written: no reply, no join, no membership.
  const history = (await get("conversations.history", { channel: C.incidents, limit: "2" })).json.messages;
  assert.deepEqual(history.map((message) => message.ts), ["1789376400.999999", "1789376400.999998"]);
  assert.ok(!("reply_count" in history[0]));
  assert.equal((await get("conversations.info", { channel: C.design })).json.channel.is_member, false);
  assert.deepEqual((await get("conversations.members", { channel: C.incidents })).json.members.sort(), [U.dana, U.opsbot, U.sam].sort());
  // Calls that allocate no ts keep working.
  assert.equal((await post("chat.update", { channel: C.incidents, ts: first.ts, text: "edited" })).json.text, "edited");
  assert.deepEqual((await post("reactions.add", { channel: C.incidents, timestamp: first.ts, name: "eyes" })).json, { ok: true });
}

// ---------------------------------------------------------------------------------------------

const flows = {
  "web-api": webApi,
  "mcp-aliases": mcpAliases,
  visibility,
  denied,
  "invalid-auth": invalidAuth,
  "post-rate-limited": postRateLimited,
  "history-unavailable": historyUnavailable,
  "fresh-install": freshInstall,
  bounds,
  "open-member-bound": openMemberBound,
  "open-long-handles": openLongHandles,
  "thread-many-repliers": threadManyRepliers,
  "response-budget": responseBudget,
  "ts-sequence-full": tsSequenceFull,
};
const selected = Object.keys(flows).find((name) => instruction.includes(name));
if (selected === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
const result = await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected, ...(result ?? {}) }));
