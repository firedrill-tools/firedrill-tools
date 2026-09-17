// Identity resolution and team visibility. Reads context.state only; every decision comes from
// rows (users.active/admin/guest, teams.private/memberIds), never from naming conventions.

import { authenticationError } from "./errors.mjs";
import { isRowId } from "./state.mjs";

/** The seeded default identity used when an actor carries neither `userId` nor `email`. */
export const DEFAULT_USER_ID = "0000000a-0000-4000-8000-000000000001";

function usable(user) {
  return user !== null && user !== undefined && user.active === true;
}

/**
 * The calling Linear user: `actor.attributes.userId`, else `email` (case-insensitive), else the
 * seeded default user (or, when that row is gone, the first active user by row id). An explicit
 * claim that matches no active user fails AUTHENTICATION_ERROR.
 */
export function resolveIdentity(context, loadUsers) {
  const attributes = context.actor.attributes ?? {};
  const userId = typeof attributes.userId === "string" ? attributes.userId.trim() : "";
  if (userId.length > 0) {
    const user = isRowId(userId) ? context.state.get("users", userId) : null;
    return usable(user) ? user : authenticationError(context);
  }
  const email = typeof attributes.email === "string" ? attributes.email.trim().toLowerCase() : "";
  if (email.length > 0) {
    const user = loadUsers().find((row) => typeof row.email === "string" && row.email.toLowerCase() === email);
    return usable(user) ? user : authenticationError(context);
  }
  const seeded = context.state.get("users", DEFAULT_USER_ID);
  if (usable(seeded)) return seeded;
  const first = loadUsers().find((row) => usable(row));
  return first === undefined ? authenticationError(context) : first;
}

export function roleOf(user) {
  if (user.admin === true) return "admin";
  if (user.guest === true) return "guest";
  return "member";
}

/** Private teams are visible to listed members only (admins included); guests see only their teams. */
export function canSeeTeam(user, team) {
  if (team === null || team === undefined) return false;
  const member = Array.isArray(team.memberIds) && team.memberIds.includes(user.id);
  if (team.private === true) return member;
  if (user.guest === true) return member;
  return true;
}

export function isMember(user, team) {
  return Array.isArray(team.memberIds) && team.memberIds.includes(user.id);
}
