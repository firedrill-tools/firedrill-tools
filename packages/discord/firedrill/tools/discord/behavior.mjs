// Synthetic Discord HTTP API v10 subset. Synchronous, deterministic handlers over Firedrill state; the HTTP codecs at the
// bottom only map requests and responses. See README.md for the supported subset and its limits.
import { guardRoutes } from "./lib/json-depth.mjs";
import { isSnowflake, pad, compareIds, nextSnowflake, isoFromUs, isIsoWithZone } from "./lib/snowflake.mjs";
import { P, DM_PERMISSIONS, has, basePermissions, channelPermissions } from "./lib/permissions.mjs";
import { parseEmoji, emojiKey, utf8Hex } from "./lib/emoji.mjs";
import { jsonBytes, fillByBytes } from "./lib/bytes.mjs";
import { queryInt, queryBool, queryString, jsonBody, pick, defined, withIdempotency, encoder } from "./lib/wire.mjs";

const DEFAULT_SCAN_ROWS = 5000;
const MAX_SCAN_ROWS = 9999;
// The HTTP binding refuses response bodies over 1 MiB; pages stop below this many UTF-8 bytes of JSON.
const DEFAULT_RESPONSE_BYTES = 900000;
const MIN_RESPONSE_BYTES = 1024;
// Slack for the canonical wrapper object (`{"messages":…}`) around a byte-budgeted array.
const WRAPPER_SLACK_BYTES = 4096;
const NONCE_WINDOW_US = 300000000;
const MAX_DISTINCT_REACTIONS = 20;
const SUPPRESS_EMBEDS = 4;
const HAS_THREAD = 32;
const THREAD_TYPES = new Set([10, 11, 12]);
const ARCHIVE_DURATIONS = [60, 1440, 4320, 10080];
const UNSUPPORTED_CREATE_FIELDS = ["attachments", "sticker_ids", "components", "poll", "shared_client_theme"];
const UNSUPPORTED_EDIT_FIELDS = ["attachments", "components"];

// ---------------------------------------------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------------------------------------------

function fail(context, code, message) {
  return context.fail({ code, message });
}

/** Discord `50035 Invalid Form Body` with the nested `{ field: { _errors: [...] } }` detail tree. */
function formError(context, path, code, message) {
  const errors = {};
  let node = errors;
  for (const segment of path) {
    node[String(segment)] = {};
    node = node[String(segment)];
  }
  node._errors = [{ code, message }];
  return context.fail({
    code: "INVALID_FORM_BODY",
    message: `Invalid Form Body (${path.join(".")}: ${message})`,
    details: { errors },
  });
}

function preview(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
}

function snowflakeArg(context, input, field) {
  const value = input[field];
  if (!isSnowflake(value)) formError(context, [field], "NUMBER_TYPE_COERCE", `Value "${preview(value)}" is not snowflake.`);
  return value;
}

function optionalSnowflake(context, input, field) {
  return input[field] === undefined ? undefined : snowflakeArg(context, input, field);
}

function rangeArg(context, input, field, min, max, fallback) {
  const value = input[field];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min) {
    formError(context, [field], "NUMBER_TYPE_MIN", `Must be greater than or equal to ${min}.`);
  }
  if (value > max) formError(context, [field], "NUMBER_TYPE_MAX", `Must be less than or equal to ${max}.`);
  return value;
}

function codePoints(text) {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function maxLength(context, path, text, max) {
  if (codePoints(text) > max) formError(context, path, "BASE_TYPE_MAX_LENGTH", `Must be ${max} or fewer in length.`);
  return text;
}

// ---------------------------------------------------------------------------------------------------------------
// Service metadata, ids and bounded scans
// ---------------------------------------------------------------------------------------------------------------

function readMeta(context) {
  const row = context.state.get("meta", "service");
  const configured = row !== null && row.limits !== undefined ? row.limits.scan_rows : DEFAULT_SCAN_ROWS;
  const scanRows = Number.isSafeInteger(configured) ? Math.min(Math.max(configured, 1), MAX_SCAN_ROWS) : DEFAULT_SCAN_ROWS;
  return {
    default_user_id: row !== null && isSnowflake(row.default_user_id) ? row.default_user_id : null,
    last_snowflake: row !== null && isSnowflake(row.last_snowflake) ? row.last_snowflake : "0",
    limits: { scan_rows: scanRows },
  };
}

function generateId(context) {
  const meta = readMeta(context);
  const id = nextSnowflake(context.clock.nowUs(), meta.last_snowflake);
  context.state.put("meta", "service", { ...meta, last_snowflake: id });
  return id;
}

function boundExceeded(context, namespace, bound) {
  return fail(
    context,
    "STATE_BOUND_EXCEEDED",
    `The ${namespace} scan exceeds the supported bound of ${bound} rows (meta.limits.scan_rows); no partial result is returned.`,
  );
}

/** Every row whose id starts with `prefix`, in row-id order; fails instead of truncating past the bound. */
function scanPrefix(context, namespace, prefix) {
  const bound = readMeta(context).limits.scan_rows;
  const rows = context.state.scan(namespace, { afterRowId: prefix, limit: bound + 1 });
  const values = [];
  for (const record of rows) {
    if (!record.rowId.startsWith(prefix)) return values;
    values.push(record.value);
  }
  if (values.length > bound) boundExceeded(context, namespace, bound);
  return values;
}

/** Response byte budget: `meta.limits.response_bytes` when configured (1024-900000), else 900000. */
function responseBudget(context) {
  const row = context.state.get("meta", "service");
  const configured = row !== null && row.limits !== undefined ? row.limits.response_bytes : undefined;
  return Number.isSafeInteger(configured)
    ? Math.min(Math.max(configured, MIN_RESPONSE_BYTES), DEFAULT_RESPONSE_BYTES)
    : DEFAULT_RESPONSE_BYTES;
}

function responseTooLarge(context, what, budget) {
  return fail(
    context,
    "STATE_BOUND_EXCEEDED",
    `The ${what} response exceeds the supported size of ${budget} bytes (meta.limits.response_bytes); no partial result is returned.`,
  );
}

/** One page of rendered rows in admission order, bounded by `limit` and by the response byte budget. */
function pageOf(context, rows, render, limit, what) {
  const budget = responseBudget(context);
  const page = fillByBytes(rows, render, limit, budget);
  if (page.oversized) responseTooLarge(context, `${what} (a single entry)`, budget);
  return page.items;
}

/** An endpoint without pagination either fits the byte budget whole or fails; it is never cut short. */
function whole(context, value, what) {
  const budget = responseBudget(context);
  if (jsonBytes(value) > budget) responseTooLarge(context, what, budget);
  return value;
}

function* newestFirst(rows) {
  for (let index = rows.length - 1; index >= 0; index -= 1) yield rows[index];
}

function scanAll(context, namespace) {
  const bound = readMeta(context).limits.scan_rows;
  const rows = context.state.scan(namespace, { limit: bound + 1 });
  if (rows.length > bound) boundExceeded(context, namespace, bound);
  return rows.map((record) => record.value);
}

// ---------------------------------------------------------------------------------------------------------------
// Identity and access
// ---------------------------------------------------------------------------------------------------------------

/**
 * The account behind the caller's token: `actor.attributes.userId` when present (must be an existing, non-deleted user,
 * else 401), otherwise `meta.default_user_id`, otherwise the lowest-id non-deleted bot, otherwise the lowest-id user.
 */
function caller(context) {
  const attributes = context.actor.attributes ?? {};
  if (Object.prototype.hasOwnProperty.call(attributes, "userId")) {
    const claimed = attributes.userId;
    const user = isSnowflake(claimed) ? context.state.get("users", pad(claimed)) : null;
    if (user === null || user.deleted === true) {
      fail(context, "UNAUTHORIZED", "401: Unauthorized (the actor's userId does not match an account in this world)");
    }
    return user;
  }
  const meta = readMeta(context);
  if (meta.default_user_id !== null) {
    const user = context.state.get("users", pad(meta.default_user_id));
    if (user !== null && user.deleted !== true) return user;
  }
  const users = scanAll(context, "users").filter((user) => user.deleted !== true);
  const chosen = users.find((user) => user.bot === true) ?? users[0];
  if (chosen === undefined) fail(context, "UNAUTHORIZED", "401: Unauthorized (this world has no accounts)");
  return chosen;
}

function memberKey(guildId, userId) {
  return `${pad(guildId)}:${pad(userId)}`;
}

function memberContext(context, guild, userId) {
  const member = context.state.get("members", memberKey(guild.id, userId));
  if (member === null) return null;
  const everyone = context.state.get("roles", `${pad(guild.id)}:${pad(guild.id)}`);
  const roles = [];
  for (const roleId of member.roles) {
    const role = isSnowflake(roleId) ? context.state.get("roles", `${pad(guild.id)}:${pad(roleId)}`) : null;
    if (role !== null) roles.push(role);
  }
  return { member, base: basePermissions(guild, userId, everyone, roles) };
}

function requireGuild(context, input, me) {
  const guildId = snowflakeArg(context, input, "guild_id");
  const guild = context.state.get("guilds", pad(guildId));
  if (guild === null) fail(context, "UNKNOWN_GUILD", "Unknown Guild");
  const membership = memberContext(context, guild, me.id);
  if (membership === null) fail(context, "MISSING_ACCESS", "Missing Access (the caller is not a member of this guild)");
  return { guild, ...membership };
}

/** Resolve a channel the caller can see, with its computed permissions (threads use their parent's overwrites). */
function accessChannel(context, channelId, me) {
  const channel = context.state.get("channels", pad(channelId));
  if (channel === null) fail(context, "UNKNOWN_CHANNEL", "Unknown Channel");
  if (channel.type === 1) {
    const recipients = Array.isArray(channel.recipient_ids) ? channel.recipient_ids : [];
    if (!recipients.includes(me.id)) fail(context, "MISSING_ACCESS", "Missing Access (not a recipient of this DM)");
    return { channel, guild: null, member: null, permissions: DM_PERMISSIONS, parent: null };
  }
  const guild = isSnowflake(channel.guild_id) ? context.state.get("guilds", pad(channel.guild_id)) : null;
  if (guild === null) fail(context, "UNKNOWN_CHANNEL", "Unknown Channel");
  const membership = memberContext(context, guild, me.id);
  if (membership === null) fail(context, "MISSING_ACCESS", "Missing Access (the caller is not a member of this guild)");
  const isThread = THREAD_TYPES.has(channel.type);
  const parent = isThread && isSnowflake(channel.parent_id) ? context.state.get("channels", pad(channel.parent_id)) : null;
  if (isThread && parent === null) fail(context, "UNKNOWN_CHANNEL", "Unknown Channel");
  const source = isThread ? parent : channel;
  const permissions = channelPermissions(membership.base, guild.id, source.permission_overwrites, membership.member.roles, me.id);
  if (!has(permissions, P.VIEW_CHANNEL)) fail(context, "MISSING_ACCESS", "Missing Access (VIEW_CHANNEL)");
  if (
    channel.type === 12 &&
    !has(permissions, P.MANAGE_THREADS) &&
    context.state.get("thread_members", memberKey(channel.id, me.id)) === null
  ) {
    fail(context, "MISSING_ACCESS", "Missing Access (private thread)");
  }
  return { channel, guild, member: membership.member, permissions, parent };
}

function requireMessageChannel(context, channelId, me, read) {
  const access = accessChannel(context, channelId, me);
  if (access.channel.type === 2 || access.channel.type === 4) {
    fail(context, "INVALID_CHANNEL_TYPE", "Cannot execute action on this channel type");
  }
  if (read && !has(access.permissions, P.READ_MESSAGE_HISTORY)) {
    fail(context, "MISSING_ACCESS", "Missing Access (READ_MESSAGE_HISTORY)");
  }
  return access;
}

function messageRowId(channelId, messageId) {
  return `${pad(channelId)}:${pad(messageId)}`;
}

function requireMessage(context, channelId, messageId) {
  const message = context.state.get("messages", messageRowId(channelId, messageId));
  if (message === null) fail(context, "UNKNOWN_MESSAGE", "Unknown Message");
  return message;
}

function sharesGuild(context, left, right) {
  for (const guild of scanAll(context, "guilds")) {
    if (
      context.state.get("members", memberKey(guild.id, left)) !== null &&
      context.state.get("members", memberKey(guild.id, right)) !== null
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering (Discord object shapes)
// ---------------------------------------------------------------------------------------------------------------

function renderUser(user, id) {
  return {
    id,
    username: user === null ? "deleted_user" : user.username,
    global_name: user === null ? "Deleted User" : user.global_name,
    discriminator: "0",
    avatar: null,
    bot: user === null ? false : user.bot,
    system: false,
    public_flags: 0,
    flags: 0,
    banner: null,
    accent_color: user === null ? null : user.accent_color,
    avatar_decoration_data: null,
    collectibles: null,
    primary_guild: null,
  };
}

function userById(context, id) {
  return renderUser(isSnowflake(id) ? context.state.get("users", pad(id)) : null, id);
}

function renderRole(role) {
  const out = {
    id: role.id,
    name: role.name,
    color: role.color,
    colors: { primary_color: role.color, secondary_color: null, tertiary_color: null },
    hoist: role.hoist,
    icon: null,
    unicode_emoji: null,
    position: role.position,
    permissions: role.permissions,
    managed: role.managed,
    mentionable: role.mentionable,
    flags: 0,
  };
  if (role.managed && role.bot_id !== null) out.tags = { bot_id: role.bot_id };
  return out;
}

function byPositionThenId(left, right) {
  const a = left.position ?? 0;
  const b = right.position ?? 0;
  return a !== b ? a - b : compareIds(left.id, right.id);
}

function renderMember(context, member) {
  return {
    user: userById(context, member.user_id),
    nick: member.nick,
    avatar: null,
    banner: null,
    roles: [...member.roles],
    joined_at: member.joined_at,
    premium_since: null,
    deaf: false,
    mute: false,
    pending: member.pending,
    flags: 0,
    communication_disabled_until: null,
  };
}

function renderChannel(context, channel, me) {
  if (channel.type === 1) {
    const recipients = Array.isArray(channel.recipient_ids) ? channel.recipient_ids : [];
    const other = recipients.find((id) => id !== me.id) ?? recipients[0] ?? me.id;
    return { id: channel.id, type: 1, last_message_id: channel.last_message_id, flags: 0, recipients: [userById(context, other)] };
  }
  if (THREAD_TYPES.has(channel.type)) {
    const members = scanPrefix(context, "thread_members", `${pad(channel.id)}:`);
    const mine = members.find((member) => member.user_id === me.id);
    const meta = channel.thread_metadata;
    const threadMetadata = {
      archived: meta.archived,
      archive_timestamp: meta.archive_timestamp,
      auto_archive_duration: meta.auto_archive_duration,
      locked: meta.locked,
      create_timestamp: meta.create_timestamp,
    };
    if (channel.type === 12) threadMetadata.invitable = meta.invitable !== false;
    const out = {
      id: channel.id,
      type: channel.type,
      guild_id: channel.guild_id,
      parent_id: channel.parent_id,
      owner_id: channel.owner_id ?? null,
      name: channel.name,
      last_message_id: channel.last_message_id,
      rate_limit_per_user: channel.rate_limit_per_user,
      flags: 0,
      message_count: channel.message_count ?? 0,
      member_count: Math.min(members.length, 50),
      total_message_sent: channel.total_message_sent ?? 0,
      thread_metadata: threadMetadata,
    };
    if (mine !== undefined) {
      out.member = { id: channel.id, user_id: me.id, join_timestamp: mine.join_timestamp, flags: 0 };
    }
    return out;
  }
  const out = {
    id: channel.id,
    type: channel.type,
    guild_id: channel.guild_id,
    name: channel.name,
    position: channel.position ?? 0,
    parent_id: channel.parent_id,
    topic: channel.topic,
    nsfw: channel.nsfw,
    last_message_id: channel.last_message_id,
    rate_limit_per_user: channel.rate_limit_per_user,
    permission_overwrites: channel.permission_overwrites.map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow,
      deny: overwrite.deny,
    })),
    flags: 0,
  };
  if (channel.type === 2) {
    out.bitrate = channel.bitrate ?? 64000;
    out.user_limit = channel.user_limit ?? 0;
    out.rtc_region = null;
  }
  if (channel.type === 0 || channel.type === 5) {
    out.default_auto_archive_duration = channel.default_auto_archive_duration ?? 4320;
    out.last_pin_timestamp = null;
  }
  return out;
}

function renderMessage(context, message, me, nested = false) {
  const out = {
    id: message.id,
    channel_id: message.channel_id,
    author: userById(context, message.author_id),
    content: message.content,
    timestamp: message.timestamp,
    edited_timestamp: message.edited_timestamp,
    tts: message.tts,
    mention_everyone: message.mention_everyone,
    mentions: message.mention_ids.map((id) => userById(context, id)),
    mention_roles: [...message.mention_role_ids],
    attachments: [],
    embeds: message.embeds.map((embed) => JSON.parse(JSON.stringify(embed))),
    components: [],
    pinned: false,
    type: message.type,
    flags: message.flags,
  };
  if (message.position !== null) out.position = message.position;
  if (message.reaction_summary.length > 0) {
    out.reactions = message.reaction_summary.map((entry) => ({
      emoji:
        entry.emoji_id === null
          ? { id: null, name: entry.emoji_name }
          : { id: entry.emoji_id, name: entry.emoji_name, animated: entry.animated },
      count: entry.count,
      count_details: { burst: 0, normal: entry.count },
      burst_colors: [],
      me_burst: false,
      me: context.state.get("reactions", `${messageRowId(message.channel_id, message.id)}:${entry.key}:${pad(me.id)}`) !== null,
    }));
  }
  if (message.reference !== null) {
    out.message_reference = {
      type: 0,
      channel_id: message.reference.channel_id,
      message_id: message.reference.message_id,
      ...(message.reference.guild_id === undefined ? {} : { guild_id: message.reference.guild_id }),
    };
    if (!nested) {
      const referenced = context.state.get("messages", messageRowId(message.reference.channel_id, message.reference.message_id));
      out.referenced_message = referenced === null ? null : renderMessage(context, referenced, me, true);
    }
  }
  if (message.thread_id !== null) {
    const thread = context.state.get("channels", pad(message.thread_id));
    if (thread !== null) out.thread = renderChannel(context, thread, me);
  }
  return out;
}

function renderPartialGuild(context, guild, base, withCounts) {
  const out = {
    id: guild.id,
    name: guild.name,
    icon: null,
    banner: null,
    owner: false,
    permissions: base.toString(),
    features: [],
  };
  return withCounts ? { ...out, ...guildCounts(context, guild) } : out;
}

function guildCounts(context, guild) {
  return {
    approximate_member_count: scanPrefix(context, "members", `${pad(guild.id)}:`).length,
    approximate_presence_count: 0,
  };
}

function renderGuild(context, guild, withCounts) {
  const roles = scanPrefix(context, "roles", `${pad(guild.id)}:`).sort(byPositionThenId).map(renderRole);
  const out = {
    id: guild.id,
    name: guild.name,
    icon: null,
    description: guild.description,
    splash: null,
    discovery_splash: null,
    banner: null,
    home_header: null,
    features: [],
    owner_id: guild.owner_id,
    application_id: null,
    region: "deprecated",
    afk_channel_id: null,
    afk_timeout: 300,
    system_channel_id: guild.system_channel_id,
    system_channel_flags: 0,
    widget_enabled: false,
    widget_channel_id: null,
    verification_level: guild.verification_level,
    default_message_notifications: guild.default_message_notifications,
    explicit_content_filter: guild.explicit_content_filter,
    mfa_level: 0,
    roles,
    emojis: guild.emojis.map((emoji) => ({ ...emoji, roles: [...emoji.roles] })),
    stickers: [],
    max_members: 500000,
    max_presences: null,
    max_video_channel_users: 25,
    max_stage_video_channel_users: 50,
    vanity_url_code: null,
    premium_tier: 0,
    premium_subscription_count: 0,
    preferred_locale: "en-US",
    rules_channel_id: guild.rules_channel_id,
    public_updates_channel_id: guild.public_updates_channel_id,
    safety_alerts_channel_id: null,
    premium_progress_bar_enabled: false,
    nsfw: false,
    nsfw_level: 0,
    incidents_data: null,
  };
  return withCounts ? { ...out, ...guildCounts(context, guild) } : out;
}

// ---------------------------------------------------------------------------------------------------------------
// Message content: embeds, allowed mentions, mentions
// ---------------------------------------------------------------------------------------------------------------

function normalizeEmbeds(context, embeds) {
  if (embeds.length > 10) formError(context, ["embeds"], "BASE_TYPE_MAX_LENGTH", "Must be 10 or fewer in length.");
  let total = 0;
  const text = (path, value, max) => {
    maxLength(context, path, value, max);
    total += codePoints(value);
    return value;
  };
  const url = (path, value) => {
    if (value.length > 2048 || !/^https?:\/\/[^\s]+$/.test(value)) formError(context, path, "URL_TYPE_INVALID_URL", "Not a well formed URL.");
    return value;
  };
  const normalized = embeds.map((embed, index) => {
    const at = (...rest) => ["embeds", index, ...rest];
    if (embed.type !== undefined && embed.type !== "rich") {
      formError(context, at("type"), "BASE_TYPE_CHOICES", "Value must be one of ('rich',).");
    }
    const out = { type: "rich" };
    if (embed.title !== undefined) out.title = text(at("title"), embed.title, 256);
    if (embed.description !== undefined) out.description = text(at("description"), embed.description, 4096);
    if (embed.url !== undefined) out.url = url(at("url"), embed.url);
    if (embed.color !== undefined) {
      if (embed.color < 0) formError(context, at("color"), "NUMBER_TYPE_MIN", "Must be greater than or equal to 0.");
      if (embed.color > 16777215) formError(context, at("color"), "NUMBER_TYPE_MAX", "Must be less than or equal to 16777215.");
      out.color = embed.color;
    }
    if (embed.timestamp !== undefined) {
      if (!isIsoWithZone(embed.timestamp)) {
        formError(context, at("timestamp"), "DATE_TIME_TYPE_PARSE", `Could not parse ${preview(embed.timestamp)}. Should be ISO8601 with a time zone.`);
      }
      out.timestamp = embed.timestamp;
    }
    if (embed.footer !== undefined) out.footer = { text: text(at("footer", "text"), embed.footer.text, 2048) };
    if (embed.author !== undefined) {
      out.author = { name: text(at("author", "name"), embed.author.name, 256) };
      if (embed.author.url !== undefined) out.author.url = url(at("author", "url"), embed.author.url);
    }
    if (embed.fields !== undefined) {
      if (embed.fields.length > 25) formError(context, at("fields"), "BASE_TYPE_MAX_LENGTH", "Must be 25 or fewer in length.");
      out.fields = embed.fields.map((field, fieldIndex) => {
        for (const key of ["name", "value"]) {
          if (field[key].length === 0) formError(context, at("fields", fieldIndex, key), "BASE_TYPE_REQUIRED", "This field is required");
        }
        const entry = {
          name: text(at("fields", fieldIndex, "name"), field.name, 256),
          value: text(at("fields", fieldIndex, "value"), field.value, 1024),
        };
        if (field.inline !== undefined) entry.inline = field.inline;
        return entry;
      });
    }
    return out;
  });
  if (total > 6000) formError(context, ["embeds"], "MAX_EMBED_SIZE_EXCEEDED", "Embed size exceeds maximum size of 6000");
  return normalized;
}

function validateAllowedMentions(context, allowed) {
  if (allowed === undefined) return;
  const parse = allowed.parse ?? [];
  for (const kind of ["users", "roles"]) {
    const list = allowed[kind] ?? [];
    list.forEach((id, index) => {
      if (!isSnowflake(id)) formError(context, ["allowed_mentions", kind, index], "NUMBER_TYPE_COERCE", `Value "${preview(id)}" is not snowflake.`);
    });
    if (parse.includes(kind) && list.length > 0) {
      formError(context, ["allowed_mentions", kind], "SET_TYPE_ALREADY_CONTAINS_VALUE", `parse:["${kind}"] and ${kind}: [ids] are mutually exclusive.`);
    }
  }
}

/** Resolve `<@id>`, `<@!id>`, `<@&id>` and `@everyone`/`@here` against state, filtered by `allowed_mentions`. */
function computeMentions(context, content, access, allowed, repliedAuthorId) {
  const parse = allowed === undefined ? null : (allowed.parse ?? []);
  const allowUser = (id) => parse === null || parse.includes("users") || (allowed.users ?? []).includes(id);
  const allowRole = (id) => parse === null || parse.includes("roles") || (allowed.roles ?? []).includes(id);
  const mentionIds = [];
  for (const match of content.matchAll(/<@!?([0-9]{1,20})>/g)) {
    const id = match[1];
    if (mentionIds.length >= 100 || mentionIds.includes(id) || !isSnowflake(id)) continue;
    if (context.state.get("users", pad(id)) !== null && allowUser(id)) mentionIds.push(id);
  }
  const mentionRoleIds = [];
  if (access.guild !== null) {
    for (const match of content.matchAll(/<@&([0-9]{1,20})>/g)) {
      const id = match[1];
      if (mentionRoleIds.length >= 100 || mentionRoleIds.includes(id) || !isSnowflake(id) || id === access.guild.id) continue;
      if (context.state.get("roles", `${pad(access.guild.id)}:${pad(id)}`) !== null && allowRole(id)) mentionRoleIds.push(id);
    }
  }
  const mentionEveryone =
    access.guild !== null &&
    /@(everyone|here)/.test(content) &&
    has(access.permissions, P.MENTION_EVERYONE) &&
    (parse === null || parse.includes("everyone"));
  if (
    repliedAuthorId !== null &&
    !mentionIds.includes(repliedAuthorId) &&
    (allowed === undefined ? true : allowed.replied_user === true)
  ) {
    mentionIds.push(repliedAuthorId);
  }
  return { mention_ids: mentionIds, mention_role_ids: mentionRoleIds, mention_everyone: mentionEveryone };
}

function isEmptyMessage(content, embeds) {
  return content.trim().length === 0 && embeds.length === 0;
}

function joinThread(context, threadId, userId, timestamp) {
  const key = memberKey(threadId, userId);
  if (context.state.get("thread_members", key) === null) {
    context.state.put("thread_members", key, { thread_id: threadId, user_id: userId, join_timestamp: timestamp, flags: 0 });
  }
}

function threadName(context, input) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0 || codePoints(name) > 100) formError(context, ["name"], "BASE_TYPE_BAD_LENGTH", "Must be between 1 and 100 in length.");
  return name;
}

function archiveDuration(context, input, channel) {
  if (input.auto_archive_duration === undefined) return channel.default_auto_archive_duration ?? 4320;
  if (!ARCHIVE_DURATIONS.includes(input.auto_archive_duration)) {
    formError(context, ["auto_archive_duration"], "BASE_TYPE_CHOICES", "Value must be one of (60, 1440, 4320, 10080).");
  }
  return input.auto_archive_duration;
}

function reactionContext(context, input, me) {
  const channelId = snowflakeArg(context, input, "channel_id");
  const messageId = snowflakeArg(context, input, "message_id");
  const access = requireMessageChannel(context, channelId, me, true);
  const message = requireMessage(context, channelId, messageId);
  const emoji = parseEmoji(input.emoji_name);
  if (emoji === null) fail(context, "UNKNOWN_EMOJI", "Unknown Emoji");
  return { access, message, emoji, key: emojiKey(emoji) };
}

function requireUnarchived(context, access) {
  if (THREAD_TYPES.has(access.channel.type) && access.channel.thread_metadata.archived) {
    fail(context, "THREAD_ARCHIVED", "Thread is archived");
  }
}

function withSummary(message, key, emoji, delta) {
  const summary = message.reaction_summary.map((entry) => ({ ...entry }));
  const index = summary.findIndex((entry) => entry.key === key);
  if (index === -1) {
    summary.push({ key, emoji_id: emoji.id, emoji_name: emoji.name, animated: emoji.animated === true, count: 1 });
  } else {
    summary[index].count += delta;
    if (summary[index].count <= 0) summary.splice(index, 1);
  }
  return { ...message, reaction_summary: summary };
}

// ---------------------------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------------------------

const operations = {
  "users.get": (input, context) => {
    const me = caller(context);
    if (input.user_id === "@me") {
      return { ...renderUser(me, me.id), mfa_enabled: false, locale: "en-US", verified: true, email: null };
    }
    const userId = snowflakeArg(context, input, "user_id");
    const user = context.state.get("users", pad(userId));
    if (user === null) fail(context, "UNKNOWN_USER", "Unknown User");
    return renderUser(user, user.id);
  },

  "users.list-my-guilds": (input, context) => {
    const me = caller(context);
    const before = optionalSnowflake(context, input, "before");
    const after = optionalSnowflake(context, input, "after");
    const limit = rangeArg(context, input, "limit", 1, 200, 200);
    const mine = [];
    for (const guild of scanAll(context, "guilds")) {
      if (before !== undefined && compareIds(guild.id, before) >= 0) continue;
      if (after !== undefined && compareIds(guild.id, after) <= 0) continue;
      const membership = memberContext(context, guild, me.id);
      if (membership !== null) mine.push({ guild, base: membership.base });
    }
    const render = ({ guild, base }) => ({
      ...renderPartialGuild(context, guild, base, input.with_counts === true),
      owner: guild.owner_id === me.id,
    });
    // `before` pages fill from the cursor outward so a byte-capped page still ends right next to it.
    const guilds =
      before !== undefined && after === undefined
        ? pageOf(context, newestFirst(mine), render, limit, "guilds").reverse()
        : pageOf(context, mine, render, limit, "guilds");
    return { guilds, server_time: isoFromUs(context.clock.nowUs()) };
  },

  "users.list-dm-channels": (_input, context) => {
    const me = caller(context);
    const dms = scanAll(context, "channels").filter(
      (channel) => channel.type === 1 && Array.isArray(channel.recipient_ids) && channel.recipient_ids.includes(me.id),
    );
    dms.sort((left, right) => {
      if (left.last_message_id !== right.last_message_id) {
        if (left.last_message_id === null) return 1;
        if (right.last_message_id === null) return -1;
        return compareIds(right.last_message_id, left.last_message_id);
      }
      return compareIds(left.id, right.id);
    });
    return whole(context, { channels: dms.map((channel) => renderChannel(context, channel, me)) }, "DM channels");
  },

  "users.create-dm": (input, context) => {
    const me = caller(context);
    const recipientId = snowflakeArg(context, input, "recipient_id");
    if (recipientId === me.id) formError(context, ["recipient_id"], "BASE_TYPE_INVALID", "Cannot open a DM with yourself.");
    const recipient = context.state.get("users", pad(recipientId));
    if (recipient === null || recipient.deleted === true) fail(context, "UNKNOWN_USER", "Unknown User");
    const pair = [me.id, recipientId].sort(compareIds);
    const existing = scanAll(context, "channels").find(
      (channel) =>
        channel.type === 1 &&
        Array.isArray(channel.recipient_ids) &&
        channel.recipient_ids.length === 2 &&
        channel.recipient_ids[0] === pair[0] &&
        channel.recipient_ids[1] === pair[1],
    );
    if (existing !== undefined) return renderChannel(context, existing, me);
    const id = generateId(context);
    const channel = {
      id,
      type: 1,
      guild_id: null,
      name: null,
      position: null,
      parent_id: null,
      topic: null,
      nsfw: false,
      rate_limit_per_user: 0,
      permission_overwrites: [],
      last_message_id: null,
      recipient_ids: pair,
    };
    context.state.put("channels", pad(id), channel);
    return renderChannel(context, channel, me);
  },

  "guilds.get": (input, context) => {
    const me = caller(context);
    const { guild } = requireGuild(context, input, me);
    return renderGuild(context, guild, input.with_counts === true);
  },

  "guilds.list-channels": (input, context) => {
    const me = caller(context);
    const { guild } = requireGuild(context, input, me);
    const channels = scanAll(context, "channels")
      .filter((channel) => channel.guild_id === guild.id && !THREAD_TYPES.has(channel.type) && channel.type !== 1)
      .sort(byPositionThenId);
    return whole(context, { channels: channels.map((channel) => renderChannel(context, channel, me)) }, "guild channels");
  },

  "guilds.list-active-threads": (input, context) => {
    const me = caller(context);
    const { guild, member, base } = requireGuild(context, input, me);
    const all = scanAll(context, "channels");
    const threads = [];
    for (const channel of all) {
      if (channel.guild_id !== guild.id || !THREAD_TYPES.has(channel.type) || channel.thread_metadata.archived) continue;
      const parent = all.find((candidate) => candidate.id === channel.parent_id);
      if (parent === undefined) continue;
      const permissions = channelPermissions(base, guild.id, parent.permission_overwrites, member.roles, me.id);
      if (!has(permissions, P.VIEW_CHANNEL)) continue;
      if (
        channel.type === 12 &&
        !has(permissions, P.MANAGE_THREADS) &&
        context.state.get("thread_members", memberKey(channel.id, me.id)) === null
      ) {
        continue;
      }
      threads.push(channel);
    }
    threads.sort((left, right) => compareIds(right.id, left.id));
    const rendered = threads.map((thread) => renderChannel(context, thread, me));
    const value = {
      threads: rendered.map(({ member: _member, ...thread }) => thread),
      members: rendered.filter((thread) => thread.member !== undefined).map((thread) => thread.member),
    };
    return whole(context, value, "active threads");
  },

  "guild-members.list": (input, context) => {
    const me = caller(context);
    const { guild } = requireGuild(context, input, me);
    const limit = rangeArg(context, input, "limit", 1, 1000, 1);
    const after = optionalSnowflake(context, input, "after") ?? "0";
    const candidates = scanPrefix(context, "members", `${pad(guild.id)}:`).filter((member) => compareIds(member.user_id, after) > 0);
    return { members: pageOf(context, candidates, (member) => renderMember(context, member), limit, "guild members") };
  },

  "guild-members.get": (input, context) => {
    const me = caller(context);
    const { guild } = requireGuild(context, input, me);
    const userId = snowflakeArg(context, input, "user_id");
    const member = context.state.get("members", memberKey(guild.id, userId));
    if (member === null) fail(context, "UNKNOWN_MEMBER", "Unknown Member");
    return renderMember(context, member);
  },

  "roles.list": (input, context) => {
    const me = caller(context);
    const { guild } = requireGuild(context, input, me);
    return whole(context, { roles: scanPrefix(context, "roles", `${pad(guild.id)}:`).sort(byPositionThenId).map(renderRole) }, "roles");
  },

  "channels.get": (input, context) => {
    const me = caller(context);
    const channelId = snowflakeArg(context, input, "channel_id");
    const { channel } = accessChannel(context, channelId, me);
    return renderChannel(context, channel, me);
  },

  "messages.list": (input, context) => {
    const me = caller(context);
    const channelId = snowflakeArg(context, input, "channel_id");
    const anchors = ["around", "before", "after"].filter((name) => input[name] !== undefined);
    if (anchors.length > 1) {
      formError(context, [anchors[1]], "BASE_TYPE_BAD_COMBINATION", "Only one of around, before or after may be provided.");
    }
    const around = optionalSnowflake(context, input, "around");
    const before = optionalSnowflake(context, input, "before");
    const after = optionalSnowflake(context, input, "after");
    const limit = rangeArg(context, input, "limit", 1, 100, 50);
    requireMessageChannel(context, channelId, me, true);
    const ascending = scanPrefix(context, "messages", `${pad(channelId)}:`);
    const render = (message) => renderMessage(context, message, me);
    // Pages are bounded by `limit` and by response bytes, and always fill from the cursor outward, so the next
    // `before`/`after` cursor (the last id returned) resumes at exactly the first message not returned.
    if (before !== undefined) {
      const older = ascending.filter((message) => compareIds(message.id, before) < 0);
      return { messages: pageOf(context, newestFirst(older), render, limit, "messages") };
    }
    if (after !== undefined) {
      const newer = ascending.filter((message) => compareIds(message.id, after) > 0);
      return { messages: pageOf(context, newer, render, limit, "messages").reverse() };
    }
    if (around !== undefined) {
      const older = ascending.filter((message) => compareIds(message.id, around) < 0);
      const self = ascending.filter((message) => message.id === around);
      const newer = ascending.filter((message) => compareIds(message.id, around) > 0);
      const olderCount = Math.min(older.length, Math.floor(limit / 2));
      const selfCount = Math.min(self.length, limit - olderCount);
      const newerCount = Math.min(newer.length, limit - olderCount - selfCount);
      const order = self.slice(0, selfCount);
      for (let step = 0; step < Math.max(olderCount, newerCount); step += 1) {
        if (step < olderCount) order.push(older[older.length - 1 - step]);
        if (step < newerCount) order.push(newer[step]);
      }
      const page = pageOf(context, order, render, limit, "messages");
      return { messages: page.sort((left, right) => compareIds(right.id, left.id)) };
    }
    return { messages: pageOf(context, newestFirst(ascending), render, limit, "messages") };
  },

  "messages.get": (input, context) => {
    const me = caller(context);
    const channelId = snowflakeArg(context, input, "channel_id");
    const messageId = snowflakeArg(context, input, "message_id");
    requireMessageChannel(context, channelId, me, true);
    return renderMessage(context, requireMessage(context, channelId, messageId), me);
  },

  "messages.create": (input, context) => {
    const me = caller(context);
    const channelId = snowflakeArg(context, input, "channel_id");
    const access = requireMessageChannel(context, channelId, me, false);
    const { channel } = access;
    for (const field of UNSUPPORTED_CREATE_FIELDS) {
      if (input[field] !== undefined) formError(context, [field], "UNSUPPORTED_FIELD", `${field} is not supported by this Tool.`);
    }
    const content = maxLength(context, ["content"], input.content ?? "", 2000);
    const embeds = normalizeEmbeds(context, input.embeds ?? []);
    const flags = input.flags ?? 0;
    if (flags !== 0 && flags !== SUPPRESS_EMBEDS) formError(context, ["flags"], "BASE_TYPE_CHOICES", "Only SUPPRESS_EMBEDS (4) may be set.");
    let nonceHex = null;
    if (input.nonce !== undefined) {
      if (typeof input.nonce === "string") maxLength(context, ["nonce"], input.nonce, 25);
      nonceHex = utf8Hex(String(input.nonce));
      if (nonceHex === null) formError(context, ["nonce"], "BASE_TYPE_INVALID", "Nonce must be valid text.");
    }
    validateAllowedMentions(context, input.allowed_mentions);
    const reference = input.message_reference;
    if (reference !== undefined) {
      if (reference.type !== undefined && reference.type !== 0) {
        formError(context, ["message_reference", "type"], "BASE_TYPE_CHOICES", "Only replies (type 0) are supported by this Tool.");
      }
      if (!isSnowflake(reference.message_id)) {
        formError(context, ["message_reference", "message_id"], "NUMBER_TYPE_COERCE", `Value "${preview(reference.message_id)}" is not snowflake.`);
      }
    }
    if (isEmptyMessage(content, embeds)) fail(context, "CANNOT_SEND_EMPTY_MESSAGE", "Cannot send an empty message");

    const isThread = THREAD_TYPES.has(channel.type);
    if (channel.type === 1) {
      const otherId = channel.recipient_ids.find((id) => id !== me.id);
      const other = otherId === undefined ? null : context.state.get("users", pad(otherId));
      if (other === null || other.deleted || other.bot || other.dm_blocked || (me.bot && !sharesGuild(context, me.id, other.id))) {
        fail(context, "CANNOT_SEND_TO_USER", "Cannot send messages to this user");
      }
    } else if (isThread) {
      if (!has(access.permissions, P.SEND_MESSAGES_IN_THREADS)) fail(context, "MISSING_PERMISSIONS", "Missing Permissions (SEND_MESSAGES_IN_THREADS)");
      if (channel.thread_metadata.locked && !has(access.permissions, P.MANAGE_THREADS)) fail(context, "THREAD_LOCKED", "Thread is locked");
    } else if (!has(access.permissions, P.SEND_MESSAGES)) {
      fail(context, "MISSING_PERMISSIONS", "Missing Permissions (SEND_MESSAGES)");
    }

    const now = context.clock.nowUs();
    const nonceRowId = nonceHex !== null && input.enforce_nonce === true ? `${pad(channel.id)}:${nonceHex}` : null;
    if (nonceRowId !== null) {
      const stored = context.state.get("nonces", nonceRowId);
      if (stored !== null && stored.author_id === me.id && stored.created_us >= now - NONCE_WINDOW_US) {
        const existing = context.state.get("messages", messageRowId(channel.id, stored.message_id));
        if (existing !== null) return { ...renderMessage(context, existing, me), nonce: input.nonce };
      }
    }

    let storedReference = null;
    let repliedAuthorId = null;
    if (reference !== undefined) {
      const sameChannel = reference.channel_id === undefined || reference.channel_id === channel.id;
      const referenced = sameChannel ? context.state.get("messages", messageRowId(channel.id, reference.message_id)) : null;
      if (referenced === null) {
        if (reference.fail_if_not_exists !== false) {
          formError(context, ["message_reference"], "MESSAGE_REFERENCE_UNKNOWN_MESSAGE", "Unknown message");
        }
      } else {
        storedReference = { channel_id: channel.id, message_id: referenced.id };
        if (channel.guild_id !== null) storedReference.guild_id = channel.guild_id;
        repliedAuthorId = referenced.author_id;
      }
    }
    const mentions = computeMentions(context, content, access, input.allowed_mentions, repliedAuthorId);

    const id = generateId(context);
    const timestamp = isoFromUs(now);
    let position = null;
    if (isThread) {
      const total = (channel.total_message_sent ?? 0) + 1;
      position = total;
      const meta = channel.thread_metadata;
      context.state.put("channels", pad(channel.id), {
        ...channel,
        last_message_id: id,
        message_count: (channel.message_count ?? 0) + 1,
        total_message_sent: total,
        thread_metadata: meta.archived ? { ...meta, archived: false, archive_timestamp: timestamp } : meta,
      });
      joinThread(context, channel.id, me.id, timestamp);
    } else {
      context.state.put("channels", pad(channel.id), { ...channel, last_message_id: id });
    }
    const row = {
      id,
      channel_id: channel.id,
      author_id: me.id,
      type: storedReference === null ? 0 : 19,
      content,
      timestamp,
      edited_timestamp: null,
      tts: input.tts === true,
      flags,
      embeds,
      ...mentions,
      reference: storedReference,
      thread_id: null,
      position,
      reaction_summary: [],
    };
    context.state.put("messages", messageRowId(channel.id, id), row);
    if (nonceRowId !== null) {
      context.state.put("nonces", nonceRowId, {
        channel_id: channel.id,
        nonce: String(input.nonce),
        message_id: id,
        author_id: me.id,
        created_us: now,
      });
    }
    context.events.emit("message.created", {
      guild_id: channel.guild_id,
      channel_id: channel.id,
      message_id: id,
      author_id: me.id,
      type: row.type,
      content,
      referenced_message_id: storedReference === null ? null : storedReference.message_id,
    });
    const rendered = renderMessage(context, row, me);
    return input.nonce === undefined ? rendered : { ...rendered, nonce: input.nonce };
  },

  "messages.edit": (input, context) => {
    const me = caller(context);
    const channelId = snowflakeArg(context, input, "channel_id");
    const messageId = snowflakeArg(context, input, "message_id");
    const access = requireMessageChannel(context, channelId, me, false);
    for (const field of UNSUPPORTED_EDIT_FIELDS) {
      if (input[field] !== undefined) formError(context, [field], "UNSUPPORTED_FIELD", `${field} is not supported by this Tool.`);
    }
    const message = requireMessage(context, channelId, messageId);
    if (message.type !== 0 && message.type !== 19) fail(context, "SYSTEM_MESSAGE_ACTION", "Cannot execute action on a system message");
    if (message.author_id !== me.id) fail(context, "CANNOT_EDIT_OTHERS_MESSAGE", "Cannot edit a message authored by another user");
    if (THREAD_TYPES.has(access.channel.type)) {
      if (access.channel.thread_metadata.locked && !has(access.permissions, P.MANAGE_THREADS)) fail(context, "THREAD_LOCKED", "Thread is locked");
      requireUnarchived(context, access);
    }
    const content = input.content === undefined ? message.content : maxLength(context, ["content"], input.content ?? "", 2000);
    const embeds = input.embeds === undefined ? message.embeds : normalizeEmbeds(context, input.embeds ?? []);
    let flags = message.flags;
    if (input.flags !== undefined) {
      if (input.flags !== 0 && input.flags !== SUPPRESS_EMBEDS) formError(context, ["flags"], "BASE_TYPE_CHOICES", "Only SUPPRESS_EMBEDS (4) may be set.");
      flags = (message.flags & ~SUPPRESS_EMBEDS) | input.flags;
    }
    validateAllowedMentions(context, input.allowed_mentions);
    if (isEmptyMessage(content, embeds)) fail(context, "CANNOT_SEND_EMPTY_MESSAGE", "Cannot send an empty message");
    let mentions = {
      mention_ids: message.mention_ids,
      mention_role_ids: message.mention_role_ids,
      mention_everyone: message.mention_everyone,
    };
    if (input.content !== undefined) {
      const referenced =
        message.reference === null
          ? null
          : context.state.get("messages", messageRowId(message.reference.channel_id, message.reference.message_id));
      const repliedAuthorId = referenced === null || !message.mention_ids.includes(referenced.author_id) ? null : referenced.author_id;
      mentions = computeMentions(context, content, access, input.allowed_mentions, repliedAuthorId);
    }
    const row = { ...message, content, embeds, flags, ...mentions, edited_timestamp: isoFromUs(context.clock.nowUs()) };
    context.state.put("messages", messageRowId(channelId, messageId), row);
    return renderMessage(context, row, me);
  },

  "messages.delete": (input, context) => {
    const me = caller(context);
    const channelId = snowflakeArg(context, input, "channel_id");
    const messageId = snowflakeArg(context, input, "message_id");
    const access = requireMessageChannel(context, channelId, me, false);
    const message = requireMessage(context, channelId, messageId);
    requireUnarchived(context, access);
    if (message.author_id !== me.id && (access.guild === null || !has(access.permissions, P.MANAGE_MESSAGES))) {
      fail(context, "MISSING_PERMISSIONS", "Missing Permissions (MANAGE_MESSAGES)");
    }
    const prefix = `${messageRowId(channelId, messageId)}:`;
    for (const reaction of scanPrefix(context, "reactions", prefix)) {
      context.state.delete("reactions", `${prefix}${reaction.emoji_key}:${pad(reaction.user_id)}`);
    }
    context.state.delete("messages", messageRowId(channelId, messageId));
    if (THREAD_TYPES.has(access.channel.type)) {
      context.state.put("channels", pad(channelId), {
        ...access.channel,
        message_count: Math.max(0, (access.channel.message_count ?? 0) - 1),
      });
    }
    context.events.emit("message.deleted", {
      guild_id: access.channel.guild_id,
      channel_id: channelId,
      message_id: messageId,
      deleted_by: me.id,
    });
    return { id: messageId, deleted: true };
  },

  "reactions.add": (input, context) => {
    const me = caller(context);
    const { access, message, emoji, key } = reactionContext(context, input, me);
    let resolved = emoji;
    if (emoji.kind === "custom") {
      const known = access.guild === null ? undefined : access.guild.emojis.find((candidate) => candidate.id === emoji.id);
      if (known === undefined) fail(context, "UNKNOWN_EMOJI", "Unknown Emoji");
      resolved = { kind: "custom", id: known.id, name: known.name, animated: known.animated };
    }
    requireUnarchived(context, access);
    const rowId = `${messageRowId(message.channel_id, message.id)}:${key}:${pad(me.id)}`;
    if (context.state.get("reactions", rowId) !== null) return { changed: false };
    if (!message.reaction_summary.some((entry) => entry.key === key)) {
      if (!has(access.permissions, P.ADD_REACTIONS)) fail(context, "MISSING_PERMISSIONS", "Missing Permissions (ADD_REACTIONS)");
      if (message.reaction_summary.length >= MAX_DISTINCT_REACTIONS) {
        fail(context, "MAX_REACTIONS", "Maximum number of reactions reached (20)");
      }
    }
    context.state.put("reactions", rowId, {
      channel_id: message.channel_id,
      message_id: message.id,
      emoji_key: key,
      user_id: me.id,
      created_us: context.clock.nowUs(),
    });
    context.state.put("messages", messageRowId(message.channel_id, message.id), withSummary(message, key, resolved, 1));
    context.events.emit("reaction.added", {
      guild_id: access.channel.guild_id,
      channel_id: message.channel_id,
      message_id: message.id,
      user_id: me.id,
      emoji: { id: resolved.id, name: resolved.name },
    });
    return { changed: true };
  },

  "reactions.remove": (input, context) => {
    const me = caller(context);
    const { access, message, emoji, key } = reactionContext(context, input, me);
    requireUnarchived(context, access);
    const targetId = input.user_id === undefined || input.user_id === "@me" ? me.id : snowflakeArg(context, input, "user_id");
    if (targetId !== me.id && (access.guild === null || !has(access.permissions, P.MANAGE_MESSAGES))) {
      fail(context, "MISSING_PERMISSIONS", "Missing Permissions (MANAGE_MESSAGES)");
    }
    const rowId = `${messageRowId(message.channel_id, message.id)}:${key}:${pad(targetId)}`;
    if (!context.state.delete("reactions", rowId)) return { changed: false };
    context.state.put("messages", messageRowId(message.channel_id, message.id), withSummary(message, key, emoji, -1));
    return { changed: true };
  },

  "reactions.list-users": (input, context) => {
    const me = caller(context);
    const after = optionalSnowflake(context, input, "after") ?? "0";
    const limit = rangeArg(context, input, "limit", 1, 100, 25);
    const type = input.type ?? 0;
    if (type !== 0 && type !== 1) formError(context, ["type"], "BASE_TYPE_CHOICES", "Value must be one of (0, 1).");
    const { message, key } = reactionContext(context, input, me);
    if (!message.reaction_summary.some((entry) => entry.key === key)) fail(context, "UNKNOWN_EMOJI", "Unknown Emoji");
    if (type === 1) return { users: [] };
    const reactions = scanPrefix(context, "reactions", `${messageRowId(message.channel_id, message.id)}:${key}:`).filter(
      (reaction) => compareIds(reaction.user_id, after) > 0,
    );
    return { users: pageOf(context, reactions, (reaction) => userById(context, reaction.user_id), limit, "reaction users") };
  },

  "threads.create-from-message": (input, context) => {
    const me = caller(context);
    const channelId = snowflakeArg(context, input, "channel_id");
    const messageId = snowflakeArg(context, input, "message_id");
    const access = accessChannel(context, channelId, me);
    const { channel } = access;
    if (channel.type !== 0 && channel.type !== 5) fail(context, "INVALID_CHANNEL_TYPE", "Cannot execute action on this channel type");
    const message = requireMessage(context, channelId, messageId);
    const name = threadName(context, input);
    const duration = archiveDuration(context, input, channel);
    const slowmode = rangeArg(context, input, "rate_limit_per_user", 0, 21600, 0);
    if (message.thread_id !== null || context.state.get("channels", pad(message.id)) !== null) {
      fail(context, "THREAD_ALREADY_CREATED", "A thread has already been created for this message");
    }
    if (!has(access.permissions, P.CREATE_PUBLIC_THREADS)) fail(context, "MISSING_PERMISSIONS", "Missing Permissions (CREATE_PUBLIC_THREADS)");
    const timestamp = isoFromUs(context.clock.nowUs());
    const thread = {
      id: message.id,
      type: channel.type === 5 ? 10 : 11,
      guild_id: channel.guild_id,
      name,
      position: null,
      parent_id: channel.id,
      topic: null,
      nsfw: false,
      rate_limit_per_user: slowmode,
      permission_overwrites: [],
      last_message_id: null,
      owner_id: me.id,
      message_count: 0,
      total_message_sent: 0,
      thread_metadata: {
        archived: false,
        archive_timestamp: timestamp,
        auto_archive_duration: duration,
        locked: false,
        create_timestamp: timestamp,
      },
    };
    context.state.put("channels", pad(thread.id), thread);
    context.state.put("messages", messageRowId(channelId, messageId), { ...message, thread_id: thread.id, flags: message.flags | HAS_THREAD });
    joinThread(context, thread.id, me.id, timestamp);
    return renderChannel(context, thread, me);
  },

  "threads.create": (input, context) => {
    const me = caller(context);
    const channelId = snowflakeArg(context, input, "channel_id");
    const access = accessChannel(context, channelId, me);
    const { channel } = access;
    if (channel.type !== 0 && channel.type !== 5) fail(context, "INVALID_CHANNEL_TYPE", "Cannot execute action on this channel type");
    const type = input.type ?? 12;
    if (type !== 10 && type !== 11 && type !== 12) formError(context, ["type"], "BASE_TYPE_CHOICES", "Value must be one of (10, 11, 12).");
    if ((channel.type === 0 && type === 10) || (channel.type === 5 && type !== 10)) {
      fail(context, "INVALID_CHANNEL_TYPE", "Cannot execute action on this channel type");
    }
    const name = threadName(context, input);
    const duration = archiveDuration(context, input, channel);
    const slowmode = rangeArg(context, input, "rate_limit_per_user", 0, 21600, 0);
    const needed = type === 12 ? P.CREATE_PRIVATE_THREADS : P.CREATE_PUBLIC_THREADS;
    if (!has(access.permissions, needed)) {
      fail(context, "MISSING_PERMISSIONS", `Missing Permissions (${type === 12 ? "CREATE_PRIVATE_THREADS" : "CREATE_PUBLIC_THREADS"})`);
    }
    const timestamp = isoFromUs(context.clock.nowUs());
    const id = generateId(context);
    const metadata = {
      archived: false,
      archive_timestamp: timestamp,
      auto_archive_duration: duration,
      locked: false,
      create_timestamp: timestamp,
    };
    if (type === 12) metadata.invitable = input.invitable !== false;
    const thread = {
      id,
      type,
      guild_id: channel.guild_id,
      name,
      position: null,
      parent_id: channel.id,
      topic: null,
      nsfw: false,
      rate_limit_per_user: slowmode,
      permission_overwrites: [],
      last_message_id: null,
      owner_id: me.id,
      message_count: 0,
      total_message_sent: 0,
      thread_metadata: metadata,
    };
    context.state.put("channels", pad(id), thread);
    joinThread(context, id, me.id, timestamp);
    if (type !== 12) {
      const systemId = generateId(context);
      context.state.put("messages", messageRowId(channel.id, systemId), {
        id: systemId,
        channel_id: channel.id,
        author_id: me.id,
        type: 18,
        content: name,
        timestamp,
        edited_timestamp: null,
        tts: false,
        flags: 0,
        embeds: [],
        mention_ids: [],
        mention_role_ids: [],
        mention_everyone: false,
        reference: null,
        thread_id: null,
        position: null,
        reaction_summary: [],
      });
      context.state.put("channels", pad(channel.id), { ...channel, last_message_id: systemId });
    }
    return renderChannel(context, thread, me);
  },
};

// ---------------------------------------------------------------------------------------------------------------
// HTTP codecs (/api/v10/...)
// ---------------------------------------------------------------------------------------------------------------

const CREATE_MESSAGE_FIELDS = [
  "content",
  "embeds",
  "tts",
  "flags",
  "message_reference",
  "nonce",
  "enforce_nonce",
  "allowed_mentions",
  ...UNSUPPORTED_CREATE_FIELDS,
];
const EDIT_MESSAGE_FIELDS = ["content", "embeds", "flags", "allowed_mentions", ...UNSUPPORTED_EDIT_FIELDS];

const pathArgs = (request, names) => Object.fromEntries(names.map((name) => [name, request.path[name]]));

const read = (names, query, shape) => ({
  decode: (request) => ({ arguments: defined({ ...pathArgs(request, names), ...query(request) }) }),
  encode: encoder(shape),
});

const write = (names, bodyFields, shape) => ({
  decode: (request) =>
    withIdempotency(request, { ...(bodyFields.length > 0 ? pick(jsonBody(request), bodyFields) : {}), ...pathArgs(request, names) }),
  encode: encoder(shape),
});

const none = () => ({});

const http = {
  "get-user": read(["user_id"], none, "object"),
  "list-my-guilds": read(
    ["user_id"],
    (request) => ({
      before: queryString(request, "before"),
      after: queryString(request, "after"),
      limit: queryInt(request, "limit"),
      with_counts: queryBool(request, "with_counts"),
    }),
    { unwrap: "guilds" },
  ),
  "list-dm-channels": read(["user_id"], none, { unwrap: "channels" }),
  "create-dm": write(["user_id"], ["recipient_id"], "object"),
  "get-guild": read(["guild_id"], (request) => ({ with_counts: queryBool(request, "with_counts") }), "object"),
  "list-guild-channels": read(["guild_id"], none, { unwrap: "channels" }),
  "list-active-threads": read(["guild_id"], none, "object"),
  "list-guild-members": read(
    ["guild_id"],
    (request) => ({ limit: queryInt(request, "limit"), after: queryString(request, "after") }),
    { unwrap: "members" },
  ),
  "get-guild-member": read(["guild_id", "user_id"], none, "object"),
  "list-guild-roles": read(["guild_id"], none, { unwrap: "roles" }),
  "get-channel": read(["channel_id"], none, "object"),
  "list-messages": read(
    ["channel_id"],
    (request) => ({
      around: queryString(request, "around"),
      before: queryString(request, "before"),
      after: queryString(request, "after"),
      limit: queryInt(request, "limit"),
    }),
    { unwrap: "messages" },
  ),
  "create-message": write(["channel_id"], CREATE_MESSAGE_FIELDS, "object"),
  "get-message": read(["channel_id", "message_id"], none, "object"),
  "edit-message": write(["channel_id", "message_id"], EDIT_MESSAGE_FIELDS, "object"),
  "delete-message": write(["channel_id", "message_id"], [], "empty"),
  "add-reaction": write(["channel_id", "message_id", "emoji_name", "user_id"], [], "empty"),
  "remove-reaction": write(["channel_id", "message_id", "emoji_name", "user_id"], [], "empty"),
  "list-reaction-users": read(
    ["channel_id", "message_id", "emoji_name"],
    (request) => ({ after: queryString(request, "after"), limit: queryInt(request, "limit"), type: queryInt(request, "type") }),
    { unwrap: "users" },
  ),
  "create-thread-from-message": write(
    ["channel_id", "message_id"],
    ["name", "auto_archive_duration", "rate_limit_per_user"],
    "object",
  ),
  "create-thread": write(["channel_id"], ["name", "auto_archive_duration", "type", "invitable", "rate_limit_per_user"], "object"),
};

// Every response, including single objects (guilds.get with many roles, a message with a large reply), stays under the
// byte budget or answers a declared error; the per-list budgets above leave room for the canonical wrapper.
for (const [operationId, handler] of Object.entries(operations)) {
  operations[operationId] = (input, context) => {
    const value = handler(input, context);
    const budget = responseBudget(context) + WRAPPER_SLACK_BYTES;
    if (jsonBytes(value) > budget) responseTooLarge(context, operationId, budget);
    return value;
  };
}

export default { operations, http: guardRoutes(http) };
