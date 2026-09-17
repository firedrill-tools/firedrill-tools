// Bot-token shaped visibility, membership and archive rules. Every rule reads context.state; nothing is cached.
import { SCAN_CAP, SCAN_STEP, membershipRowId } from "./ids.mjs";

export function fail(context, code, message = code.toLowerCase()) {
  return context.fail({ code, message });
}

/**
 * Rows this synthetic workspace serves per namespace (users and conversations per workspace; members, messages and
 * pins per conversation) unless the workspace row carries `limits`. A read that finds more rows than its bound fails
 * with TOO_MANY_ROWS instead of returning the first N rows; pins.add refuses to exceed the pin bound (Slack's own limit
 * is 100 pins per conversation).
 */
export const DEFAULT_LIMITS = { users: 1000, conversations: 1000, members: 1000, messages: 10000, pins: 100 };
const LIMIT_OF_NAMESPACE = { users: "users", conversations: "conversations", memberships: "members", messages: "messages", pins: "pins" };

export function limitsOf(context) {
  const team = context.state.get("workspace", "team");
  return { ...DEFAULT_LIMITS, ...(team !== null && team.limits !== undefined ? team.limits : {}) };
}

function boundOf(context, namespace) {
  return Math.min(SCAN_CAP, limitsOf(context)[LIMIT_OF_NAMESPACE[namespace]] ?? SCAN_CAP);
}

/**
 * Refuse, before anything is allocated or written, a set that would exceed its bound once stored (e.g. the memberships
 * of a conversation conversations.open is about to create). A declared error rolls back every write of the operation,
 * id counters included, so the message names the requested count and the workspace limit only, never an id the
 * operation would have allocated.
 */
export function requireWithinBound(context, namespace, count, subject) {
  const bound = boundOf(context, namespace);
  if (count > bound) {
    return fail(context, "TOO_MANY_ROWS", `${subject} (${count}) exceed the supported bound of ${bound} rows (workspace.limits.${LIMIT_OF_NAMESPACE[namespace]})`);
  }
  return count;
}

function tooManyRows(context, namespace, prefix, bound) {
  const where = prefix === undefined ? namespace : `${namespace} in ${prefix.slice(0, -1)}`;
  return fail(context, "TOO_MANY_ROWS", `${where} exceed the supported bound of ${bound} rows (workspace.limits.${LIMIT_OF_NAMESPACE[namespace]})`);
}

/**
 * Every row of one namespace whose row id starts with `prefix` (or the whole namespace when no prefix is given), via
 * bounded scans that read one row past the bound: more rows than the bound is an explicit TOO_MANY_ROWS, never a
 * silently shortened list.
 */
export function prefixRows(context, namespace, prefix) {
  const bound = boundOf(context, namespace);
  const rows = [];
  let after = prefix;
  while (rows.length <= bound) {
    const limit = Math.min(SCAN_STEP, bound + 1 - rows.length);
    const batch = context.state.scan(namespace, { ...(after === undefined ? {} : { afterRowId: after }), limit });
    for (const record of batch) {
      if (prefix !== undefined && !record.rowId.startsWith(prefix)) return rows;
      after = record.rowId;
      rows.push(record.value);
    }
    if (batch.length < limit) break;
  }
  if (rows.length > bound) return tooManyRows(context, namespace, prefix, bound);
  return rows;
}

/** Every row of a workspace-wide namespace (users, conversations), bounded like prefixRows. */
export function allRows(context, namespace) {
  return prefixRows(context, namespace, undefined);
}

/**
 * The member a caller without a `userId` attribute acts as: the first active human member in `users` row-id order
 * (deactivated and bot users skipped), so a fresh `firedrill tool add` actor is a member of the seeded workspace. The
 * scan stops at the first match; a workspace without such a member yields null.
 */
function defaultMember(context) {
  let after;
  for (let scanned = 0; scanned < SCAN_CAP; scanned += SCAN_STEP) {
    const batch = context.state.scan("users", { ...(after === undefined ? {} : { afterRowId: after }), limit: SCAN_STEP });
    for (const record of batch) {
      after = record.rowId;
      const user = record.value;
      if (user.deleted !== true && user.is_bot !== true) return user;
    }
    if (batch.length < SCAN_STEP) break;
  }
  return null;
}

/**
 * The workspace member this actor acts as: `attributes.userId` when present (a token that resolves to no member is
 * `invalid_auth`), otherwise the workspace's default member (see defaultMember).
 */
export function requireActor(context) {
  const userId = context.actor.attributes.userId;
  let user;
  if (typeof userId === "string" && userId.length > 0) {
    user = context.state.get("users", userId);
    if (user === null || user.id !== userId) return fail(context, "INVALID_AUTH");
  } else {
    user = defaultMember(context);
    if (user === null) return fail(context, "INVALID_AUTH", "invalid_auth: this workspace has no active human member to act as; set the actor attribute userId");
  }
  const teamId = context.actor.attributes.teamId;
  if (typeof teamId === "string" && teamId.length > 0 && teamId !== user.team_id) return fail(context, "INVALID_AUTH");
  return user;
}

export function isPublicChannel(conversation) {
  return conversation.is_channel === true && conversation.is_private !== true;
}

export function isMember(context, channelId, userId) {
  return context.state.get("memberships", membershipRowId(channelId, userId)) !== null;
}

/**
 * A conversation the actor may know about: public channels always, private channels, IMs and group DMs
 * only through membership. Anything else is indistinguishable from missing.
 */
export function visibleConversation(context, actorId, channelId) {
  const conversation = typeof channelId === "string" && channelId.length > 0 ? context.state.get("conversations", channelId) : null;
  if (conversation === null) return fail(context, "CHANNEL_NOT_FOUND");
  if (isPublicChannel(conversation) || isMember(context, channelId, actorId)) return conversation;
  return fail(context, "CHANNEL_NOT_FOUND");
}

export function requireMember(context, conversation, actorId) {
  if (!isMember(context, conversation.id, actorId)) return fail(context, "NOT_IN_CHANNEL");
  return conversation;
}

export function requireActive(context, conversation) {
  if (conversation.is_archived === true) return fail(context, "IS_ARCHIVED");
  return conversation;
}
