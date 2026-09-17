// Messaging messages: list filters (channel aliases, threads, unread, date window, author, mentions), create (post or
// threaded reply with the author taken from the connection's authorised identity), update of text fields and
// is_unread, remove with the parent's has_children recomputed.
import { badRequest } from "../lib/errors.mjs";
import { enumFilter, idFilter, textFilter } from "../lib/query.mjs";
import { getRow, putRow, scanBound, scanConnection } from "../lib/store.mjs";
import { parseIsoUs } from "../lib/time.mjs";
import { bool, shape, str } from "../lib/validate.mjs";
import { clip, isHex24 } from "../lib/util.mjs";
import { makeResource, rowsOf } from "./resource.mjs";

const ALIASES = new Set(["INBOX", "SENT", "DRAFT"]);
const TEXT_FIELDS = ["message", "message_html", "message_markdown"];

const MESSAGE_SPECS = {
  channels: shape("channelRefs"),
  parent_id: str(24, { pattern: /^[0-9a-f]{24}$/ }),
  message_thread_identifier: str(256),
  author_member: shape("member"),
  destination_members: shape("members"),
  hidden_members: shape("members"),
  mentioned_members: shape("members"),
  reactions: shape("reactions"),
  subject: str(1000),
  message: str(20000),
  message_html: str(20000),
  message_markdown: str(20000),
  attachments: shape("attachments"),
  web_url: str(2048),
  reference: str(256),
  has_children: bool(),
  is_unread: bool(),
  buttons: shape("buttons"),
  raw: shape("raw"),
};

const defaults = () => ({
  channels: [], parent_id: null, message_thread_identifier: null, author_member: { user_id: null, email: null, name: null, image_url: null },
  destination_members: [], hidden_members: [], mentioned_members: [], reactions: [], subject: null, message: null, message_html: null,
  message_markdown: null, attachments: [], web_url: null, reference: null, has_children: false, is_unread: false, buttons: [], raw: {},
});

const hasText = (row) => TEXT_FIELDS.some((field) => typeof row[field] === "string" && row[field].trim().length > 0);

function dateBound(input, context, name) {
  const value = input[name];
  if (value === undefined || value === null) return null;
  const us = typeof value === "string" ? parseIsoUs(value) : null;
  if (us === null) badRequest(context, `${name} must be an ISO-8601 date or date-time`);
  return us;
}

/** Resolves INBOX/SENT/DRAFT to the connection's channel carrying that alias; a connection without one matches nothing. */
function resolveChannel(context, workspace, connectionId, value) {
  if (!ALIASES.has(value)) return value;
  const channel = scanConnection(context, "channels", connectionId, scanBound(workspace)).find((row) => row.alias === value);
  return channel === undefined ? "" : channel.id;
}

export const messages = makeResource({
  namespace: "messages",
  label: "Message",
  category: "messaging",
  permission: "messaging_message",
  objectType: "messaging_message",
  searchFields: ["subject", "message", "author_member"],
  nameField: "subject",
  bodySpecs: MESSAGE_SPECS,
  defaults,
  filter(input, context, connection, workspace) {
    const channelParam = idFilter(input, context, "channel_id", ALIASES);
    const channelId = channelParam === null ? null : resolveChannel(context, workspace, connection.id, channelParam);
    const parentId = idFilter(input, context, "parent_id");
    const type = enumFilter(input, context, "type", ["READ", "UNREAD"]);
    const startUs = dateBound(input, context, "start_gte");
    const endUs = dateBound(input, context, "end_lt");
    const userId = textFilter(input, context, "user_id");
    const mentioned = textFilter(input, context, "user_mentioned_id");
    if (input.expand !== undefined && input.expand !== null && typeof input.expand !== "string") badRequest(context, "expand must be a string");
    return (row) => {
      if (channelId !== null && !row.channels.some((channel) => channel.id === channelId)) return false;
      if (parentId !== null && row.parent_id !== parentId) return false;
      if (type !== null && row.is_unread !== (type === "UNREAD")) return false;
      const createdUs = parseIsoUs(row.created_at) ?? 0;
      if (startUs !== null && createdUs < startUs) return false;
      if (endUs !== null && createdUs >= endUs) return false;
      if (userId !== null && row.author_member?.user_id !== userId) return false;
      if (mentioned !== null && !row.mentioned_members.some((member) => member.user_id === mentioned)) return false;
      return true;
    };
  },
  prepareCreate(context, connection, fields) {
    const row = { ...defaults(), ...fields };
    if (!hasText(row)) badRequest(context, "One of message, message_html or message_markdown is required");
    if (row.parent_id !== null) {
      const parent = getRow(context, "messages", connection.id, row.parent_id);
      if (parent === null) badRequest(context, `Unknown parent_id ${clip(row.parent_id, 40)}`);
      if (row.channels.length === 0) row.channels = parent.channels.map((channel) => ({ ...channel }));
    }
    if (row.channels.length === 0) badRequest(context, "channels[0].id or parent_id is required");
    row.channels = row.channels.map((ref) => {
      const channel = getRow(context, "channels", connection.id, ref.id);
      if (channel === null) badRequest(context, `Unknown channel id ${clip(ref.id, 40)}`);
      return { id: channel.id, name: channel.name };
    });
    const auth = connection.auth ?? {};
    row.author_member = { user_id: auth.user_id ?? null, email: Array.isArray(auth.emails) && auth.emails.length > 0 ? auth.emails[0] : null, name: auth.name ?? null, image_url: null };
    row.has_children = false;
    row.reactions = [];
    return row;
  },
  afterCreate(context, connection, row) {
    if (row.parent_id === null) return;
    const parent = getRow(context, "messages", connection.id, row.parent_id);
    if (parent !== null && parent.has_children !== true) putRow(context, "messages", { ...parent, has_children: true });
  },
  prepareUpdate(context, connection, existing, fields) {
    const merged = { ...existing };
    for (const field of [...TEXT_FIELDS, "subject", "is_unread"]) {
      if (Object.hasOwn(fields, field) && fields[field] !== null) merged[field] = fields[field];
      else if (Object.hasOwn(fields, field) && field !== "is_unread") merged[field] = null;
    }
    if (!hasText(merged)) badRequest(context, "One of message, message_html or message_markdown must remain set");
    return merged;
  },
  beforeRemove(context, connection, existing, workspace) {
    if (existing.parent_id === null || !isHex24(existing.parent_id)) return;
    const parent = getRow(context, "messages", connection.id, existing.parent_id);
    if (parent === null) return;
    const siblings = rowsOf(context, workspace, { namespace: "messages" }, connection.id).filter((row) => row.parent_id === parent.id && row.id !== existing.id);
    if (parent.has_children !== siblings.length > 0) putRow(context, "messages", { ...parent, has_children: siblings.length > 0 });
  },
});
