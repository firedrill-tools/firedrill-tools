// Discord's documented permission computation (base permissions, then channel overwrites) over BigInt bitfields.
// Pure: callers pass the rows they read from state.

export const P = Object.freeze({
  ADMINISTRATOR: 1n << 3n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS: 1n << 36n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
});

/** Every bit Discord currently defines (and a few spare), granted to owners and administrators. */
export const ALL = (1n << 53n) - 1n;

/** What a DM recipient can do in its DM: view, send, read history and react (no moderation). */
export const DM_PERMISSIONS = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.ADD_REACTIONS;

export function bits(value) {
  return typeof value === "string" && /^[0-9]{1,20}$/.test(value) ? BigInt(value) : 0n;
}

export function has(permissions, bit) {
  return (permissions & bit) === bit;
}

/**
 * Base guild permissions: owner → all; otherwise `@everyone` OR the member's roles; ADMINISTRATOR → all.
 * `roles` are the role rows the member holds (missing role ids are simply skipped).
 */
export function basePermissions(guild, userId, everyoneRole, roles) {
  if (guild.owner_id === userId) return ALL;
  let permissions = everyoneRole === null ? 0n : bits(everyoneRole.permissions);
  for (const role of roles) permissions |= bits(role.permissions);
  return has(permissions, P.ADMINISTRATOR) ? ALL : permissions;
}

/**
 * Apply a channel's overwrites: `@everyone` (deny then allow), all role overwrites for the member's roles combined
 * (deny then allow), then the member overwrite (deny then allow). Without VIEW_CHANNEL nothing else remains.
 */
export function channelPermissions(base, guildId, overwrites, memberRoleIds, userId) {
  if (base === ALL) return ALL;
  let permissions = base;
  const list = Array.isArray(overwrites) ? overwrites : [];
  const everyone = list.find((overwrite) => overwrite.type === 0 && overwrite.id === guildId);
  if (everyone !== undefined) {
    permissions &= ~bits(everyone.deny);
    permissions |= bits(everyone.allow);
  }
  let allow = 0n;
  let deny = 0n;
  for (const overwrite of list) {
    if (overwrite.type === 0 && overwrite.id !== guildId && memberRoleIds.includes(overwrite.id)) {
      allow |= bits(overwrite.allow);
      deny |= bits(overwrite.deny);
    }
  }
  permissions &= ~deny;
  permissions |= allow;
  const member = list.find((overwrite) => overwrite.type === 1 && overwrite.id === userId);
  if (member !== undefined) {
    permissions &= ~bits(member.deny);
    permissions |= bits(member.allow);
  }
  return has(permissions, P.VIEW_CHANNEL) ? permissions : 0n;
}
