// Synthetic Slack workspace. Every operation computes from context.state; ids and `ts` values come from the
// workspace counters, times from the virtual clock. Nothing leaves the world and no Slack service is contacted.
import {
  allRows,
  fail,
  isMember,
  isPublicChannel,
  limitsOf,
  prefixRows,
  requireActive,
  requireActor,
  requireMember,
  requireWithinBound,
  visibleConversation,
} from "./lib/access.mjs";
import {
  MAX_TS_SEQUENCE,
  compareTs,
  conversationId,
  decodeCursor,
  encodeCursor,
  isTs,
  isTsLike,
  membershipRowId,
  messageRowId,
  permalink,
  pinRowId,
  renderTs,
  tsNumber,
} from "./lib/ids.mjs";
import { RESPONSE_BYTES, fitCount, jsonBytes, uniformPageSize } from "./lib/budget.mjs";
import { SearchError, parseQuery, scoreMessage } from "./lib/search.mjs";
import { bool, defined, int, operationInput, params, slackError, str } from "./lib/wire.mjs";

const MAX_LIST = 1000;
const MAX_HISTORY = 999;
const MAX_SEARCH = 100;
const MAX_DISTINCT_REACTIONS = 50;
const MAX_OPEN_USERS = 8;
const CHANNEL_NAME = /^[a-z0-9._-]{1,80}$/;
const REACTION_NAME = /^[a-z0-9_+-]{1,100}$/;
const ALL_TYPES = ["public_channel", "private_channel", "mpim", "im"];

// ---------------------------------------------------------------------------------------------
// Workspace row, clock and counters
// ---------------------------------------------------------------------------------------------

function workspace(context) {
  const stored = context.state.get("workspace", "team");
  if (stored !== null) return { ...stored };
  return {
    id: "T00000000",
    name: "Workspace",
    domain: "example-team",
    url: "https://example-team.slack.com/",
    id_sequence: 0,
    message_sequence: 0,
  };
}

function saveWorkspace(context, team) {
  context.state.put("workspace", "team", team);
}

function nowSeconds(context) {
  return Math.floor(context.clock.nowUs() / 1_000_000);
}

/**
 * Allocate the next message ts: the virtual second plus a six-digit sequence that restarts every virtual second
 * (`workspace.message_second` remembers the second the sequence belongs to). A second can hold at most
 * MAX_TS_SEQUENCE timestamps; the next allocation in the same second fails with TOO_MANY_ROWS before any write.
 */
function nextTs(context, team) {
  const seconds = nowSeconds(context);
  if (team.message_second !== seconds) {
    team.message_second = seconds;
    team.message_sequence = 0;
  }
  if (team.message_sequence >= MAX_TS_SEQUENCE) {
    return fail(
      context,
      "TOO_MANY_ROWS",
      `message ts limit reached: virtual second ${seconds} already holds ${MAX_TS_SEQUENCE} message timestamps, the most a six-digit ts fraction can encode; advance the world clock`,
    );
  }
  team.message_sequence += 1;
  return renderTs(seconds, team.message_sequence);
}

function nextConversationId(team, prefix) {
  team.id_sequence += 1;
  return conversationId(prefix, team.id_sequence);
}

// ---------------------------------------------------------------------------------------------
// Argument helpers (the reference MCP server spells some arguments differently from the Web API)
// ---------------------------------------------------------------------------------------------

function invalid(context, message) {
  return fail(context, "INVALID_ARGUMENTS", message);
}

function exactlyOne(context, input, first, second, required = true) {
  const hasFirst = input[first] !== undefined;
  const hasSecond = input[second] !== undefined;
  if (hasFirst && hasSecond) return invalid(context, `exactly one of ${first} or ${second} is required`);
  if (!hasFirst && !hasSecond) {
    return required ? invalid(context, `exactly one of ${first} or ${second} is required`) : undefined;
  }
  return hasFirst ? input[first] : input[second];
}

function channelArg(context, input) {
  return exactlyOne(context, input, "channel", "channel_id");
}

function listLimit(context, input, maximum, fallback) {
  const limit = input.limit;
  if (limit === undefined) return fallback ?? maximum;
  if (limit < 1) return invalid(context, "invalid_limit");
  return Math.min(limit, maximum);
}

function commaList(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Rows and views
// ---------------------------------------------------------------------------------------------

function usersById(context) {
  const map = new Map();
  for (const user of allRows(context, "users")) map.set(user.id, user);
  return map;
}

function memberIds(context, channelId) {
  return prefixRows(context, "memberships", `${channelId}:`)
    .map((row) => row.user)
    .sort();
}

/** Conversations the actor belongs to, in id order (bounded: ≤ 1,000 conversations, one probe each). */
function conversationsOf(context, actorId) {
  return allRows(context, "conversations")
    .filter((conversation) => isMember(context, conversation.id, actorId))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function channelMessages(context, channelId) {
  return prefixRows(context, "messages", `${channelId}:`).sort((left, right) => compareTs(left.ts, right.ts));
}

function isTopLevel(message) {
  return message.thread_ts === undefined || message.thread_ts === message.ts || message.subtype === "thread_broadcast";
}

function isParent(message) {
  return message.thread_ts === undefined || message.thread_ts === message.ts;
}

function userView(user) {
  return {
    id: user.id,
    team_id: user.team_id,
    name: user.name,
    deleted: user.deleted,
    real_name: user.real_name,
    tz: user.tz,
    tz_label: user.tz_label,
    tz_offset: user.tz_offset,
    profile: { ...user.profile },
    is_admin: user.is_admin,
    is_owner: user.is_owner,
    is_bot: user.is_bot,
    is_app_user: false,
    is_email_confirmed: true,
    updated: user.updated,
    ...(user.bot_id === undefined ? {} : { bot_id: user.bot_id }),
  };
}

function conversationView(context, conversation, actorId, withCount) {
  const view = { ...conversation, is_member: isMember(context, conversation.id, actorId) };
  if (conversation.is_im === true) {
    const partner = memberIds(context, conversation.id).find((id) => id !== actorId);
    view.user = partner ?? conversation.user;
  }
  if (withCount) view.num_members = memberIds(context, conversation.id).length;
  return view;
}

/**
 * The view of a conversation this operation has just created, built from the rows it wrote (the actor is a member and
 * `memberCount` memberships were stored). No state scan runs after an id has been allocated, so no failure raised after
 * the allocation can name that id: the failure would roll the conversation back and the id would be reassigned.
 */
const MAX_CONVERSATION_NAME = 80;

// Group DM names follow Slack's `mpdm-<handle>--<handle>-1`. Handles may be 21 characters and a group DM may hold nine
// members, so the plain form can exceed the 80-character conversation name. Longer names keep a prefix of the plain
// form and end with an 8-hex FNV-1a digest of the full handle list, so the name stays within 80 characters, remains a
// valid channel name, and different member sets keep distinct names.
function groupDmName(sortedHandles) {
  const joined = sortedHandles.join("--");
  const plain = `mpdm-${joined}-1`;
  if (plain.length <= MAX_CONVERSATION_NAME) return plain;
  let hash = 0x811c9dc5;
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const digest = hash.toString(16).padStart(8, "0");
  const prefix = plain.slice(0, MAX_CONVERSATION_NAME - digest.length - 3).replace(/[-.]+$/, "");
  return `${prefix}-${digest}-1`;
}

function createdConversationView(conversation, memberCount) {
  return { ...conversation, is_member: true, num_members: memberCount };
}

function messageView(message, withChannel) {
  const view = { ...message };
  if (!withChannel) {
    delete view.channel;
    delete view.permalink;
  }
  if (Array.isArray(view.reactions) && view.reactions.length === 0) delete view.reactions;
  return view;
}

function findMessage(context, channelId, ts) {
  if (typeof ts !== "string" || !isTs(ts)) return null;
  const row = context.state.get("messages", messageRowId(channelId, ts));
  return row !== null && row.channel === channelId ? row : null;
}

function requireMessage(context, channelId, ts) {
  return findMessage(context, channelId, ts) ?? fail(context, "MESSAGE_NOT_FOUND");
}

/** Open a conversation for the actor with the checks a bot token needs: visible, then member, then not archived. */
function openConversation(context, actor, channelId, options = {}) {
  const conversation = visibleConversation(context, actor.id, channelId);
  if (options.member) requireMember(context, conversation, actor.id);
  if (options.active) requireActive(context, conversation);
  return conversation;
}

// ---------------------------------------------------------------------------------------------
// Writes shared by several operations
// ---------------------------------------------------------------------------------------------

function newMessage(context, team, conversation, fields) {
  // Authored rows may already occupy a ts in the current second; skip past them so a ts is never reused.
  let ts = nextTs(context, team);
  while (context.state.get("messages", messageRowId(conversation.id, ts)) !== null) ts = nextTs(context, team);
  const message = {
    channel: conversation.id,
    ts,
    type: "message",
    ...fields,
    reactions: [],
    permalink: permalink(team.url, conversation.id, ts),
    team: team.id,
  };
  context.state.put("messages", messageRowId(conversation.id, ts), message);
  return message;
}

function joinMessage(context, team, conversation, user, invitedBy) {
  return newMessage(context, team, conversation, {
    subtype: "channel_join",
    user: user.id,
    text: invitedBy === undefined ? `<@${user.id}> has joined the channel` : `<@${user.id}> has joined the channel by invitation from <@${invitedBy}>`,
  });
}

function addMembership(context, conversation, userId, invitedBy) {
  context.state.put(
    "memberships",
    membershipRowId(conversation.id, userId),
    defined({ channel: conversation.id, user: userId, joined: nowSeconds(context), invited_by: invitedBy }),
  );
}

/** reply_users keeps at most this many distinct repliers (the messages schema bound); reply_users_count counts all. */
const MAX_REPLY_USERS = 50;

/** Block Kit bounds this workspace accepts: Slack's 50 blocks, plus a nesting depth and encoded-size cap per message. */
const MAX_BLOCKS = 50;
const MAX_BLOCK_DEPTH = 32;
const MAX_BLOCKS_BYTES = 100000;

/**
 * `blocks` arrive as a JSON string on the Web API (the form field the SDKs send) or as an array on canonical and MCP
 * calls. A string that is not JSON fails with invalid_blocks_format; JSON that is not an array of at most 50 objects each
 * carrying a string `type`, nests deeper than 32 levels or encodes to more than 100 KB fails with invalid_blocks.
 * Nesting is measured with an explicit stack, never recursion.
 */
function blocksArg(context, value) {
  if (value === undefined) return undefined;
  let blocks = value;
  if (typeof value === "string") {
    try {
      blocks = JSON.parse(value);
    } catch {
      return fail(context, "INVALID_BLOCKS_FORMAT", "blocks must be a JSON-encoded array of layout blocks");
    }
  }
  const invalidBlocks = (reason) => fail(context, "INVALID_BLOCKS", reason);
  if (!Array.isArray(blocks)) return invalidBlocks("blocks must be an array");
  if (blocks.length > MAX_BLOCKS) return invalidBlocks(`no more than ${MAX_BLOCKS} blocks are allowed`);
  for (const block of blocks) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) return invalidBlocks("every block must be an object");
    if (typeof block.type !== "string" || block.type.length === 0 || block.type.length > 255) return invalidBlocks("every block needs a string type");
  }
  const stack = [[blocks, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth > MAX_BLOCK_DEPTH) return invalidBlocks(`blocks nest deeper than ${MAX_BLOCK_DEPTH} levels`);
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
  if (jsonBytes(blocks) > MAX_BLOCKS_BYTES) return invalidBlocks(`blocks encode to more than ${MAX_BLOCKS_BYTES} bytes`);
  return blocks;
}

function postMessage(context, actor, input, threadRequired) {
  const channelId = channelArg(context, input);
  const conversation = openConversation(context, actor, channelId, { member: true, active: true });
  const text = typeof input.text === "string" ? input.text : "";
  const blocks = blocksArg(context, input.blocks);
  if (text.trim().length === 0 && (blocks === undefined || blocks.length === 0)) return fail(context, "NO_TEXT");
  const threadTs = input.thread_ts;
  if (threadRequired && threadTs === undefined) return invalid(context, "thread_ts is required");
  let parent;
  if (threadTs !== undefined) {
    parent = findMessage(context, conversation.id, threadTs);
    if (parent === null || !isParent(parent) || parent.subtype === "tombstone") {
      return fail(context, "THREAD_NOT_FOUND", "cannot_reply_to_message");
    }
  }
  let threadRepliers;
  if (parent !== undefined) {
    // Keep the first MAX_REPLY_USERS distinct repliers in reply_users (the stored schema's bound) while
    // reply_users_count keeps counting every distinct replier. Decide whether this actor is new before any id is
    // allocated: when the list is already full and does not name the actor, look for an earlier reply of theirs.
    const listed = Array.isArray(parent.reply_users) ? [...parent.reply_users] : [];
    const count = Math.max(parent.reply_users_count ?? 0, listed.length);
    let repeat = listed.includes(actor.id);
    if (!repeat && listed.length >= MAX_REPLY_USERS) {
      repeat = channelMessages(context, conversation.id).some(
        (row) => row.thread_ts === parent.ts && row.ts !== parent.ts && row.user === actor.id,
      );
    }
    threadRepliers = {
      reply_users: repeat || listed.length >= MAX_REPLY_USERS ? listed : [...listed, actor.id],
      reply_users_count: repeat ? count : count + 1,
    };
  }
  const team = workspace(context);
  const fields = defined({
    user: actor.id,
    text,
    blocks,
    ...(actor.is_bot === true ? { subtype: "bot_message", bot_id: actor.bot_id } : {}),
  });
  if (parent !== undefined) {
    fields.thread_ts = parent.ts;
    if (input.reply_broadcast === true) fields.subtype = "thread_broadcast";
  }
  const message = newMessage(context, team, conversation, fields);
  if (parent !== undefined) {
    context.state.put(
      "messages",
      messageRowId(conversation.id, parent.ts),
      {
        ...parent,
        thread_ts: parent.ts,
        reply_count: (parent.reply_count ?? 0) + 1,
        ...threadRepliers,
        latest_reply: message.ts,
      },
    );
  }
  saveWorkspace(context, team);
  context.events.emit(
    "message.posted",
    defined({ channel: conversation.id, ts: message.ts, user: actor.id, thread_ts: message.thread_ts, subtype: message.subtype, text }),
  );
  return { ok: true, channel: conversation.id, ts: message.ts, message: messageView(message, false) };
}

/** Recompute a parent's thread counters after one of its replies was deleted. */
function refreshParent(context, channelId, parentTs) {
  const parent = findMessage(context, channelId, parentTs);
  if (parent === null) return;
  const replies = channelMessages(context, channelId).filter((row) => row.thread_ts === parentTs && row.ts !== parentTs);
  if (replies.length === 0) {
    if (parent.subtype === "tombstone") {
      context.state.delete("messages", messageRowId(channelId, parentTs));
      return;
    }
    const cleared = { ...parent };
    delete cleared.thread_ts;
    delete cleared.reply_count;
    delete cleared.reply_users;
    delete cleared.reply_users_count;
    delete cleared.latest_reply;
    context.state.put("messages", messageRowId(channelId, parentTs), cleared);
    return;
  }
  const replyUsers = [];
  for (const reply of replies) if (!replyUsers.includes(reply.user)) replyUsers.push(reply.user);
  context.state.put("messages", messageRowId(channelId, parentTs), {
    ...parent,
    thread_ts: parentTs,
    reply_count: replies.length,
    reply_users: replyUsers.slice(0, MAX_REPLY_USERS),
    reply_users_count: replyUsers.length,
    latest_reply: replies[replies.length - 1].ts,
  });
}

function unpin(context, channelId, ts) {
  context.state.delete("pins", pinRowId(channelId, ts));
  const message = findMessage(context, channelId, ts);
  if (message !== null && Array.isArray(message.pinned_to)) {
    const rest = { ...message };
    delete rest.pinned_to;
    context.state.put("messages", messageRowId(channelId, ts), rest);
  }
}

// ---------------------------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------------------------

/** Bytes reserved in an envelope for a next_cursor not yet known when the page is sized. */
const CURSOR_RESERVE = 256;

/** The response byte budget: 900 KB, or workspace.limits.response_bytes when the workspace row sets a lower one. */
function responseBudget(context) {
  const configured = limitsOf(context).response_bytes;
  return Number.isInteger(configured) ? Math.min(configured, RESPONSE_BYTES) : RESPONSE_BYTES;
}

/**
 * How many leading `candidates` (already views) fit the response budget next to `envelope` (the body with an empty
 * list). A first candidate that alone exceeds the budget fails with `code` and a message naming the budget, never an
 * empty or oversized page.
 */
function fitPage(context, candidates, envelope, code, subject) {
  const budget = responseBudget(context);
  const count = fitCount(candidates, candidates.length, jsonBytes(envelope) + CURSOR_RESERVE, budget, jsonBytes);
  if (count === 0 && candidates.length > 0) {
    return fail(context, code, `${subject} exceeds the response budget of ${budget} bytes (workspace.limits.response_bytes)`);
  }
  return count;
}

function paginateIds(context, items, cursor, kind, limit, idOf, fit) {
  let start = 0;
  if (cursor !== undefined) {
    const anchor = decodeCursor(cursor, kind);
    const index = anchor === null ? -1 : items.findIndex((item) => idOf(item) === anchor);
    if (index < 0) return fail(context, "INVALID_CURSOR");
    start = index + 1;
  }
  const candidates = items.slice(start, start + limit);
  const page = fit === undefined ? candidates : candidates.slice(0, fit(candidates));
  const last = page[page.length - 1];
  const nextCursor = start + page.length < items.length && last !== undefined ? encodeCursor(kind, idOf(last)) : "";
  return { page, nextCursor };
}

function tsWindow(context, messages, input) {
  let rows = messages;
  const inclusive = input.inclusive === true;
  if (input.oldest !== undefined) {
    if (!isTsLike(input.oldest)) return invalid(context, "invalid_ts_oldest");
    const oldest = tsNumber(input.oldest);
    rows = rows.filter((row) => (inclusive ? tsNumber(row.ts) >= oldest : tsNumber(row.ts) > oldest));
  }
  if (input.latest !== undefined) {
    if (!isTsLike(input.latest)) return invalid(context, "invalid_ts_latest");
    const latest = tsNumber(input.latest);
    rows = rows.filter((row) => (inclusive ? tsNumber(row.ts) <= latest : tsNumber(row.ts) < latest));
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

const operations = {
  "auth.test": (input, context) => {
    const actor = requireActor(context);
    const team = workspace(context);
    return defined({
      ok: true,
      url: team.url,
      team: team.name,
      user: actor.name,
      team_id: team.id,
      user_id: actor.id,
      bot_id: actor.bot_id,
      is_enterprise_install: false,
    });
  },

  "users.list": (input, context) => {
    requireActor(context);
    const limit = listLimit(context, input, MAX_LIST);
    const users = allRows(context, "users").sort((left, right) => (left.id < right.id ? -1 : 1));
    const envelope = { ok: true, members: [], cache_ts: nowSeconds(context), response_metadata: { next_cursor: "" } };
    const fit = (candidates) => fitPage(context, candidates.map(userView), envelope, "TOO_MANY_ROWS", "one user");
    const { page, nextCursor } = paginateIds(context, users, input.cursor, "user", limit, (user) => user.id, fit);
    return { ...envelope, members: page.map(userView), response_metadata: { next_cursor: nextCursor } };
  },

  "users.info": (input, context) => {
    requireActor(context);
    const userId = exactlyOne(context, input, "user", "user_id");
    const user = context.state.get("users", userId);
    if (user === null) return fail(context, "USER_NOT_FOUND");
    return { ok: true, user: userView(user) };
  },

  "users.profile.get": (input, context) => {
    const actor = requireActor(context);
    const userId = exactlyOne(context, input, "user", "user_id", false) ?? actor.id;
    const user = context.state.get("users", userId);
    if (user === null) return fail(context, "USER_NOT_FOUND");
    return { ok: true, profile: { ...user.profile, avatar_hash: "" } };
  },

  "conversations.list": (input, context) => {
    const actor = requireActor(context);
    const types = input.types === undefined ? ["public_channel"] : commaList(input.types);
    for (const type of types) if (!ALL_TYPES.includes(type)) return invalid(context, `invalid type ${type}`);
    const limit = listLimit(context, input, MAX_LIST, 100);
    const rows = allRows(context, "conversations")
      .filter((conversation) => {
        if (input.exclude_archived === true && conversation.is_archived === true) return false;
        if (isPublicChannel(conversation)) return types.includes("public_channel");
        if (!isMember(context, conversation.id, actor.id)) return false;
        if (conversation.is_im === true) return types.includes("im");
        if (conversation.is_mpim === true) return types.includes("mpim");
        return types.includes("private_channel");
      })
      .sort((left, right) => (left.id < right.id ? -1 : 1));
    const views = new Map();
    const viewOf = (conversation) => {
      if (!views.has(conversation.id)) views.set(conversation.id, conversationView(context, conversation, actor.id, false));
      return views.get(conversation.id);
    };
    const envelope = { ok: true, channels: [], response_metadata: { next_cursor: "" } };
    const fit = (candidates) => fitPage(context, candidates.map(viewOf), envelope, "TOO_MANY_ROWS", "one conversation");
    const { page, nextCursor } = paginateIds(context, rows, input.cursor, "team", limit, (row) => row.id, fit);
    return { ok: true, channels: page.map(viewOf), response_metadata: { next_cursor: nextCursor } };
  },

  "conversations.info": (input, context) => {
    const actor = requireActor(context);
    const conversation = openConversation(context, actor, channelArg(context, input));
    return { ok: true, channel: conversationView(context, conversation, actor.id, input.include_num_members === true) };
  },

  "conversations.members": (input, context) => {
    const actor = requireActor(context);
    const conversation = openConversation(context, actor, channelArg(context, input));
    const limit = listLimit(context, input, MAX_LIST, 100);
    const members = memberIds(context, conversation.id);
    const envelope = { ok: true, members: [], response_metadata: { next_cursor: "" } };
    const fit = (candidates) => fitPage(context, candidates, envelope, "TOO_MANY_ROWS", "one member id");
    const { page, nextCursor } = paginateIds(context, members, input.cursor, "user", limit, (id) => id, fit);
    return { ok: true, members: page, response_metadata: { next_cursor: nextCursor } };
  },

  "conversations.create": (input, context) => {
    const actor = requireActor(context);
    const name = String(input.name).replace(/^#/, "").toLowerCase();
    if (!CHANNEL_NAME.test(name)) return fail(context, "INVALID_NAME");
    if (allRows(context, "conversations").some((row) => row.name === name)) return fail(context, "NAME_TAKEN");
    const team = workspace(context);
    const created = nowSeconds(context);
    const isPrivate = input.is_private === true;
    const conversation = {
      id: nextConversationId(team, "C"),
      name,
      is_channel: true,
      is_group: false,
      is_im: false,
      is_mpim: false,
      is_private: isPrivate,
      is_archived: false,
      is_general: false,
      created,
      creator: actor.id,
      topic: { value: "", creator: "", last_set: 0 },
      purpose: { value: "", creator: "", last_set: 0 },
      name_normalized: name,
      updated: created * 1000,
    };
    context.state.put("conversations", conversation.id, conversation);
    addMembership(context, conversation, actor.id);
    saveWorkspace(context, team);
    context.events.emit("channel.created", { channel: conversation.id, name, creator: actor.id, is_private: isPrivate });
    return { ok: true, channel: createdConversationView(conversation, 1) };
  },

  "conversations.join": (input, context) => {
    const actor = requireActor(context);
    const conversation = openConversation(context, actor, channelArg(context, input));
    if (!isPublicChannel(conversation)) return fail(context, "METHOD_NOT_SUPPORTED_FOR_CHANNEL_TYPE");
    requireActive(context, conversation);
    if (isMember(context, conversation.id, actor.id)) {
      return {
        ok: true,
        channel: conversationView(context, conversation, actor.id, true),
        warning: "already_in_channel",
        response_metadata: { warnings: ["already_in_channel"] },
      };
    }
    const team = workspace(context);
    addMembership(context, conversation, actor.id);
    joinMessage(context, team, conversation, actor);
    saveWorkspace(context, team);
    return { ok: true, channel: conversationView(context, conversation, actor.id, true) };
  },

  "conversations.invite": (input, context) => {
    const actor = requireActor(context);
    const conversation = openConversation(context, actor, channelArg(context, input));
    if (conversation.is_im === true) return fail(context, "METHOD_NOT_SUPPORTED_FOR_CHANNEL_TYPE");
    requireMember(context, conversation, actor.id);
    requireActive(context, conversation);
    const userIds = [...new Set(commaList(input.users))];
    if (userIds.length === 0) return invalid(context, "users must list at least one user id");
    const invited = [];
    for (const userId of userIds) {
      if (userId === actor.id) return fail(context, "CANT_INVITE_SELF");
      const user = context.state.get("users", userId);
      if (user === null || user.deleted === true) return fail(context, "USER_NOT_FOUND");
      if (isMember(context, conversation.id, userId)) return fail(context, "ALREADY_IN_CHANNEL");
      invited.push(user);
    }
    const team = workspace(context);
    for (const user of invited) {
      addMembership(context, conversation, user.id, actor.id);
      joinMessage(context, team, conversation, user, actor.id);
    }
    saveWorkspace(context, team);
    return { ok: true, channel: conversationView(context, conversation, actor.id, true) };
  },

  "conversations.open": (input, context) => {
    const actor = requireActor(context);
    const hasUsers = input.users !== undefined;
    const hasChannel = input.channel !== undefined;
    if (hasUsers === hasChannel) return invalid(context, "exactly one of users or channel is required");
    const returnIm = input.return_im === true;
    if (hasChannel) {
      const conversation = visibleConversation(context, actor.id, input.channel);
      return {
        ok: true,
        no_op: true,
        already_open: true,
        channel: returnIm ? conversationView(context, conversation, actor.id, true) : { id: conversation.id },
      };
    }
    const userIds = [...new Set(commaList(input.users))].filter((id) => id !== actor.id);
    if (userIds.length === 0) return invalid(context, "users must name at least one other member");
    if (userIds.length > MAX_OPEN_USERS) return invalid(context, `users may name at most ${MAX_OPEN_USERS} members`);
    const users = [];
    for (const userId of userIds) {
      const user = context.state.get("users", userId);
      if (user === null || user.deleted === true) return fail(context, "USER_NOT_FOUND");
      users.push(user);
    }
    const wanted = [actor.id, ...userIds].sort();
    // The conversation's member count is known before any id is allocated: refuse here, naming only the workspace
    // limit, instead of failing a post-write membership scan that would name the rolled-back id.
    requireWithinBound(context, "memberships", wanted.length, "members of the requested conversation");
    const existing = allRows(context, "conversations").find((conversation) => {
      if (userIds.length === 1 ? conversation.is_im !== true : conversation.is_mpim !== true) return false;
      const members = memberIds(context, conversation.id);
      return members.length === wanted.length && members.every((id, index) => id === wanted[index]);
    });
    if (existing !== undefined) {
      return {
        ok: true,
        no_op: true,
        already_open: true,
        channel: returnIm ? conversationView(context, existing, actor.id, true) : { id: existing.id },
      };
    }
    const team = workspace(context);
    const created = nowSeconds(context);
    const isIm = userIds.length === 1;
    const groupName = isIm ? "" : groupDmName([actor, ...users].map((user) => user.name).sort());
    const conversation = defined({
      id: nextConversationId(team, isIm ? "D" : "C"),
      name: groupName,
      is_channel: false,
      is_group: false,
      is_im: isIm,
      is_mpim: !isIm,
      is_private: true,
      is_archived: false,
      is_general: false,
      created,
      creator: isIm ? "" : actor.id,
      user: isIm ? userIds[0] : undefined,
      topic: { value: "", creator: "", last_set: 0 },
      purpose: { value: "", creator: "", last_set: 0 },
      name_normalized: groupName,
      updated: created * 1000,
    });
    context.state.put("conversations", conversation.id, conversation);
    for (const id of wanted) addMembership(context, conversation, id);
    saveWorkspace(context, team);
    return {
      ok: true,
      no_op: false,
      already_open: false,
      channel: returnIm ? createdConversationView(conversation, wanted.length) : { id: conversation.id },
    };
  },

  "conversations.archive": (input, context) => {
    const actor = requireActor(context);
    const conversation = openConversation(context, actor, channelArg(context, input), { member: true });
    if (conversation.is_general === true || conversation.is_im === true) return fail(context, "METHOD_NOT_SUPPORTED_FOR_CHANNEL_TYPE");
    if (conversation.is_archived === true) return fail(context, "ALREADY_ARCHIVED");
    context.state.put("conversations", conversation.id, { ...conversation, is_archived: true, updated: nowSeconds(context) * 1000 });
    return { ok: true };
  },

  "conversations.set-topic": (input, context) => {
    const actor = requireActor(context);
    const conversation = openConversation(context, actor, channelArg(context, input), { member: true, active: true });
    const now = nowSeconds(context);
    const updated = { ...conversation, topic: { value: input.topic, creator: actor.id, last_set: now }, updated: now * 1000 };
    context.state.put("conversations", conversation.id, updated);
    return { ok: true, channel: conversationView(context, updated, actor.id, false) };
  },

  "conversations.history": (input, context) => {
    const actor = requireActor(context);
    const conversation = openConversation(context, actor, channelArg(context, input), { member: true });
    const limit = listLimit(context, input, MAX_HISTORY, 100);
    let rows = channelMessages(context, conversation.id).filter(isTopLevel).reverse();
    rows = tsWindow(context, rows, input);
    if (input.cursor !== undefined) {
      const anchor = decodeCursor(input.cursor, "next_ts");
      if (anchor === null || !isTs(anchor)) return fail(context, "INVALID_CURSOR");
      rows = rows.filter((row) => compareTs(row.ts, anchor) < 0);
    }
    const pinCount = prefixRows(context, "pins", `${conversation.id}:`).length;
    const candidates = rows.slice(0, limit).map((row) => messageView(row, false));
    const envelope = { ok: true, messages: [], has_more: true, pin_count: pinCount, response_metadata: { next_cursor: "" } };
    const count = fitPage(context, candidates, envelope, "RESPONSE_TOO_LARGE", `message ${candidates[0]?.ts}`);
    const page = candidates.slice(0, count);
    const hasMore = rows.length > page.length;
    return {
      ok: true,
      messages: page,
      has_more: hasMore,
      pin_count: pinCount,
      response_metadata: { next_cursor: hasMore ? encodeCursor("next_ts", page[page.length - 1].ts) : "" },
    };
  },

  "conversations.replies": (input, context) => {
    const actor = requireActor(context);
    const conversation = openConversation(context, actor, channelArg(context, input), { member: true });
    const threadTs = exactlyOne(context, input, "ts", "thread_ts");
    const parent = findMessage(context, conversation.id, threadTs);
    if (parent === null || !isParent(parent)) return fail(context, "THREAD_NOT_FOUND");
    const limit = listLimit(context, input, MAX_HISTORY, 100);
    let replies = channelMessages(context, conversation.id).filter((row) => row.thread_ts === parent.ts && row.ts !== parent.ts);
    replies = tsWindow(context, replies, input);
    let first = true;
    if (input.cursor !== undefined) {
      const anchor = decodeCursor(input.cursor, "next_ts");
      if (anchor === null || !isTs(anchor)) return fail(context, "INVALID_CURSOR");
      replies = replies.filter((row) => compareTs(row.ts, anchor) > 0);
      first = false;
    }
    // The parent leads the first page and counts toward its budget. When only the parent fits, the page ends at the
    // parent and its ts is the cursor: every reply is newer, so the next page starts at the first reply.
    const lead = first ? [messageView(parent, false)] : [];
    const candidates = [...lead, ...replies.slice(0, limit).map((row) => messageView(row, false))];
    const envelope = { ok: true, messages: [], has_more: true, response_metadata: { next_cursor: "" } };
    const count = fitPage(context, candidates, envelope, "RESPONSE_TOO_LARGE", `message ${candidates[0]?.ts}`);
    const messages = candidates.slice(0, count);
    const pageReplies = messages.length - lead.length;
    const hasMore = replies.length > pageReplies;
    return {
      ok: true,
      messages,
      has_more: hasMore,
      response_metadata: { next_cursor: hasMore ? encodeCursor("next_ts", messages[messages.length - 1].ts) : "" },
    };
  },

  "chat.post-message": (input, context) => postMessage(context, requireActor(context), input, false),

  "chat.reply": (input, context) => postMessage(context, requireActor(context), input, true),

  "chat.update": (input, context) => {
    const actor = requireActor(context);
    const conversation = openConversation(context, actor, channelArg(context, input), { member: true, active: true });
    const message = requireMessage(context, conversation.id, input.ts);
    if (message.user !== actor.id || message.subtype === "tombstone" || message.subtype === "channel_join") {
      return fail(context, "CANT_UPDATE_MESSAGE");
    }
    const text = typeof input.text === "string" ? input.text : undefined;
    const blocks = blocksArg(context, input.blocks);
    if ((text === undefined || text.trim().length === 0) && (blocks === undefined || blocks.length === 0)) return fail(context, "NO_TEXT");
    const updated = { ...message };
    if (text !== undefined) updated.text = text;
    if (blocks !== undefined) updated.blocks = blocks;
    else if (text !== undefined) delete updated.blocks;
    updated.edited = { user: actor.id, ts: renderTs(nowSeconds(context), 0) };
    context.state.put("messages", messageRowId(conversation.id, message.ts), updated);
    return { ok: true, channel: conversation.id, ts: message.ts, text: updated.text, message: messageView(updated, false) };
  },

  "chat.delete": (input, context) => {
    const actor = requireActor(context);
    const conversation = openConversation(context, actor, channelArg(context, input), { member: true, active: true });
    const message = requireMessage(context, conversation.id, input.ts);
    if (message.subtype === "tombstone") return fail(context, "MESSAGE_NOT_FOUND");
    if (message.user !== actor.id && actor.is_admin !== true) return fail(context, "CANT_DELETE_MESSAGE");
    unpin(context, conversation.id, message.ts);
    const hasReplies = isParent(message) && (message.reply_count ?? 0) > 0;
    if (hasReplies) {
      const tombstone = {
        channel: message.channel,
        ts: message.ts,
        type: "message",
        subtype: "tombstone",
        user: message.user,
        text: "This message was deleted.",
        thread_ts: message.ts,
        reply_count: message.reply_count,
        reply_users: message.reply_users,
        reply_users_count: message.reply_users_count,
        latest_reply: message.latest_reply,
        reactions: [],
        permalink: message.permalink,
        team: message.team,
      };
      context.state.put("messages", messageRowId(conversation.id, message.ts), defined(tombstone));
    } else {
      context.state.delete("messages", messageRowId(conversation.id, message.ts));
      if (!isParent(message)) refreshParent(context, conversation.id, message.thread_ts);
    }
    context.events.emit("message.deleted", { channel: conversation.id, ts: message.ts, user: actor.id, tombstoned: hasReplies });
    return { ok: true, channel: conversation.id, ts: message.ts };
  },

  "reactions.add": (input, context) => {
    const actor = requireActor(context);
    const name = String(exactlyOne(context, input, "name", "reaction")).replace(/^:|:$/g, "");
    if (!REACTION_NAME.test(name)) return fail(context, "INVALID_NAME");
    const conversation = openConversation(context, actor, channelArg(context, input), { member: true, active: true });
    const message = requireMessage(context, conversation.id, input.timestamp);
    const reactions = Array.isArray(message.reactions) ? message.reactions.map((reaction) => ({ ...reaction, users: [...reaction.users] })) : [];
    const existing = reactions.find((reaction) => reaction.name === name);
    if (existing !== undefined && existing.users.includes(actor.id)) return fail(context, "ALREADY_REACTED");
    if (existing === undefined && reactions.length >= MAX_DISTINCT_REACTIONS) return fail(context, "TOO_MANY_REACTIONS");
    if (existing === undefined) reactions.push({ name, users: [actor.id], count: 1 });
    else {
      existing.users.push(actor.id);
      existing.count = existing.users.length;
    }
    context.state.put("messages", messageRowId(conversation.id, message.ts), { ...message, reactions });
    context.events.emit("reaction.added", { channel: conversation.id, ts: message.ts, user: actor.id, reaction: name });
    return { ok: true };
  },

  "reactions.remove": (input, context) => {
    const actor = requireActor(context);
    const name = String(exactlyOne(context, input, "name", "reaction")).replace(/^:|:$/g, "");
    if (!REACTION_NAME.test(name)) return fail(context, "INVALID_NAME");
    const conversation = openConversation(context, actor, channelArg(context, input), { member: true, active: true });
    const message = requireMessage(context, conversation.id, input.timestamp);
    const reactions = Array.isArray(message.reactions) ? message.reactions.map((reaction) => ({ ...reaction, users: [...reaction.users] })) : [];
    const existing = reactions.find((reaction) => reaction.name === name);
    if (existing === undefined || !existing.users.includes(actor.id)) return fail(context, "NO_REACTION");
    existing.users = existing.users.filter((id) => id !== actor.id);
    existing.count = existing.users.length;
    const remaining = reactions.filter((reaction) => reaction.count > 0);
    context.state.put("messages", messageRowId(conversation.id, message.ts), { ...message, reactions: remaining });
    return { ok: true };
  },

  "pins.add": (input, context) => {
    const actor = requireActor(context);
    const conversation = openConversation(context, actor, channelArg(context, input), { member: true, active: true });
    const message = requireMessage(context, conversation.id, input.timestamp);
    if (context.state.get("pins", pinRowId(conversation.id, message.ts)) !== null) return fail(context, "ALREADY_PINNED");
    const pinned = prefixRows(context, "pins", `${conversation.id}:`);
    const pinBound = limitsOf(context).pins;
    if (pinned.length >= pinBound) {
      return fail(context, "TOO_MANY_ROWS", `pin limit reached: ${conversation.id} already holds ${pinned.length} pins, the most this workspace supports (workspace.limits.pins)`);
    }
    context.state.put("pins", pinRowId(conversation.id, message.ts), {
      channel: conversation.id,
      message_ts: message.ts,
      created: nowSeconds(context),
      created_by: actor.id,
    });
    context.state.put("messages", messageRowId(conversation.id, message.ts), { ...message, pinned_to: [conversation.id] });
    return { ok: true };
  },

  "pins.remove": (input, context) => {
    const actor = requireActor(context);
    const conversation = openConversation(context, actor, channelArg(context, input), { member: true, active: true });
    const ts = input.timestamp;
    if (!isTs(ts) || context.state.get("pins", pinRowId(conversation.id, ts)) === null) return fail(context, "NOT_PINNED");
    unpin(context, conversation.id, ts);
    return { ok: true };
  },

  "pins.list": (input, context) => {
    const actor = requireActor(context);
    const conversation = openConversation(context, actor, channelArg(context, input), { member: true });
    const items = prefixRows(context, "pins", `${conversation.id}:`)
      .map((pin) => ({ pin, message: findMessage(context, conversation.id, pin.message_ts) }))
      .filter((entry) => entry.message !== null)
      .sort((left, right) => right.pin.created - left.pin.created || compareTs(right.pin.message_ts, left.pin.message_ts))
      .map(({ pin, message }) => ({
        type: "message",
        channel: conversation.id,
        created: pin.created,
        created_by: pin.created_by,
        message: messageView(message, true),
      }));
    // pins.list has no pagination in the Web API: a pin set whose encoded body exceeds the budget is refused explicitly.
    const budget = responseBudget(context);
    const bytes = jsonBytes({ ok: true, items });
    if (bytes > budget) {
      return fail(context, "RESPONSE_TOO_LARGE", `the ${items.length} pinned messages of ${conversation.id} encode to ${bytes} bytes, over the response budget of ${budget} bytes (workspace.limits.response_bytes)`);
    }
    return { ok: true, items };
  },

  "search.messages": (input, context) => {
    const actor = requireActor(context);
    const query = String(input.query ?? "").trim();
    if (query.length === 0) return fail(context, "NO_QUERY");
    // The framework decodes query strings and form bodies leniently: malformed percent-encoding (`%E0%A4%A`) arrives
    // as U+FFFD. A query holding U+FFFD is a mangled request, so it fails instead of silently matching nothing. A
    // correctly encoded U+FFFD (`%EF%BF%BD`) is rejected the same way.
    if (query.includes("\uFFFD")) return invalid(context, "query contains an invalid character (U+FFFD); check the percent-encoding");
    const count = input.count === undefined ? 20 : input.count;
    if (count < 1) return invalid(context, "invalid_count");
    const perPage = Math.min(count, MAX_SEARCH);
    const page = input.page === undefined ? 1 : input.page;
    if (page < 1) return invalid(context, "invalid_page");
    const sort = input.sort ?? "score";
    if (sort !== "score" && sort !== "timestamp") return invalid(context, "sort must be score or timestamp");
    const direction = input.sort_dir ?? "desc";
    if (direction !== "asc" && direction !== "desc") return invalid(context, "sort_dir must be asc or desc");
    let parsed;
    try {
      parsed = parseQuery(query);
    } catch (error) {
      if (error instanceof SearchError) return invalid(context, error.message);
      throw error;
    }
    const users = usersById(context);
    const team = workspace(context);
    const matches = [];
    for (const conversation of conversationsOf(context, actor.id)) {
      const pinned = new Set(prefixRows(context, "pins", `${conversation.id}:`).map((pin) => pin.message_ts));
      const env = {
        conversation,
        actorId: actor.id,
        authorHandle: (userId) => users.get(userId)?.name ?? null,
        partnerHandle: (im) => {
          const partner = memberIds(context, im.id).find((id) => id !== actor.id);
          return partner === undefined ? null : (users.get(partner)?.name ?? null);
        },
        isPinned: (message) => pinned.has(message.ts),
      };
      for (const message of channelMessages(context, conversation.id)) {
        if (message.subtype === "tombstone" || message.subtype === "channel_join") continue;
        const score = scoreMessage(parsed, message, env);
        if (score === null) continue;
        matches.push({ score, message, conversation });
      }
    }
    matches.sort((left, right) => {
      const primary = sort === "score" ? left.score - right.score : compareTs(left.message.ts, right.message.ts);
      const ordered = direction === "asc" ? primary : -primary;
      return ordered !== 0 ? ordered : compareTs(right.message.ts, left.message.ts);
    });
    const matchView = ({ message, conversation }) => ({
          type: "message",
          iid: `${conversation.id}:${message.ts}`,
          channel: {
            id: conversation.id,
            name: conversation.name,
            is_channel: conversation.is_channel,
            is_private: conversation.is_private,
            is_im: conversation.is_im,
            is_mpim: conversation.is_mpim,
          },
          user: message.user,
          username: users.get(message.user)?.name ?? message.user,
          text: message.text,
          ts: message.ts,
          team: team.id,
          permalink: message.permalink,
        });
    // Page arithmetic stays uniform: per_page is the requested count, lowered only as far as needed for every page of
    // the result set to fit the response budget, so page N+1 always starts where page N ended and no match is skipped.
    const total = matches.length;
    const budget = responseBudget(context);
    const pagingOf = (size, pageNumber, sliceLength) => {
      const pages = Math.max(1, Math.ceil(total / size));
      const first = (pageNumber - 1) * size;
      return {
        pagination: {
          total_count: total,
          page: pageNumber,
          per_page: size,
          page_count: pages,
          first: total === 0 ? 0 : Math.min(first + 1, total + 1),
          last: Math.min(first + sliceLength, total),
        },
        paging: { count: size, total, page: pageNumber, pages },
        total,
      };
    };
    const envelopeBytes = jsonBytes({ ok: true, query, messages: { matches: [], ...pagingOf(perPage, page, perPage) } }) + CURSOR_RESERVE;
    const sizes = matches.map((match) => jsonBytes(matchView(match)));
    const size = uniformPageSize(sizes, perPage, envelopeBytes, budget);
    if (size === 0) {
      return fail(context, "RESPONSE_TOO_LARGE", `a matching message exceeds the response budget of ${budget} bytes (workspace.limits.response_bytes)`);
    }
    const start = (page - 1) * size;
    const slice = matches.slice(start, start + size);
    const paging = pagingOf(size, page, slice.length);
    return {
      ok: true,
      query,
      messages: {
        matches: slice.map(matchView),
        ...paging,
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// HTTP codecs (pure): Slack Web API query/form spelling ⇄ canonical arguments
// ---------------------------------------------------------------------------------------------

const S = "string";
const I = "integer";
const B = "boolean";

/** Which parameters each Slack method accepts and how they are typed on the wire. */
const METHODS = {
  "auth.test": { operationId: "auth.test", fields: {} },
  "users.list": { operationId: "users.list", fields: { cursor: S, limit: I, include_locale: B } },
  "users.info": { operationId: "users.info", fields: { user: S, include_locale: B } },
  "users.profile.get": { operationId: "users.profile.get", fields: { user: S, include_labels: B } },
  "conversations.list": {
    operationId: "conversations.list",
    fields: { types: S, exclude_archived: B, limit: I, cursor: S, team_id: S },
  },
  "conversations.info": { operationId: "conversations.info", fields: { channel: S, include_num_members: B, include_locale: B } },
  "conversations.members": { operationId: "conversations.members", fields: { channel: S, limit: I, cursor: S } },
  "conversations.history": {
    operationId: "conversations.history",
    fields: { channel: S, limit: I, cursor: S, oldest: S, latest: S, inclusive: B, include_all_metadata: B },
  },
  "conversations.replies": {
    operationId: "conversations.replies",
    fields: { channel: S, ts: S, limit: I, cursor: S, oldest: S, latest: S, inclusive: B },
  },
  "pins.list": { operationId: "pins.list", fields: { channel: S } },
  "search.messages": {
    operationId: "search.messages",
    fields: { query: S, count: I, page: I, sort: S, sort_dir: S, highlight: B, team_id: S },
  },
  "conversations.create": { operationId: "conversations.create", fields: { name: S, is_private: B, team_id: S }, mutation: true },
  "conversations.join": { operationId: "conversations.join", fields: { channel: S }, mutation: true },
  "conversations.invite": { operationId: "conversations.invite", fields: { channel: S, users: S, force: B }, mutation: true },
  "conversations.open": { operationId: "conversations.open", fields: { users: S, channel: S, return_im: B }, mutation: true },
  "conversations.archive": { operationId: "conversations.archive", fields: { channel: S }, mutation: true },
  "conversations.setTopic": { operationId: "conversations.set-topic", fields: { channel: S, topic: S }, mutation: true },
  "chat.postMessage": {
    operationId: "chat.post-message",
    fields: {
      channel: S,
      text: S,
      blocks: S,
      thread_ts: S,
      reply_broadcast: B,
      mrkdwn: B,
      unfurl_links: B,
      unfurl_media: B,
      link_names: B,
      parse: S,
      username: S,
      icon_emoji: S,
    },
    mutation: true,
  },
  "chat.update": { operationId: "chat.update", fields: { channel: S, ts: S, text: S, blocks: S, as_user: B }, mutation: true },
  "chat.delete": { operationId: "chat.delete", fields: { channel: S, ts: S, as_user: B }, mutation: true },
  "reactions.add": { operationId: "reactions.add", fields: { channel: S, timestamp: S, name: S }, mutation: true },
  "reactions.remove": { operationId: "reactions.remove", fields: { channel: S, timestamp: S, name: S }, mutation: true },
  "pins.add": { operationId: "pins.add", fields: { channel: S, timestamp: S }, mutation: true },
  "pins.remove": { operationId: "pins.remove", fields: { channel: S, timestamp: S }, mutation: true },
};

function decodeArguments(request, fields) {
  const source = params(request);
  const args = {};
  for (const [name, kind] of Object.entries(fields)) {
    const value = kind === S ? str(source, name) : kind === I ? int(source, name) : bool(source, name);
    if (value !== undefined) args[name] = value;
  }
  return args;
}

function encodeSlack({ invocation, outcome }) {
  if (outcome.status !== "ok") return slackError(invocation, outcome);
  return { body: { kind: "json", value: outcome.value } };
}

function routeId(prefix, method) {
  return `${prefix}-${method.replace(/\./g, "-").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`;
}

const http = {};
for (const [method, spec] of Object.entries(METHODS)) {
  const codec = {
    decode: (request) => {
      const args = decodeArguments(request, spec.fields);
      return spec.mutation ? operationInput(request, args) : { arguments: args };
    },
    encode: encodeSlack,
  };
  if (spec.mutation) http[routeId("post", method)] = codec;
  else {
    http[routeId("get", method)] = codec;
    http[routeId("post", method)] = codec;
  }
}

export default { operations, http };
