// Identity resolution and the project access model (team-managed access levels + three roles).
// Reads context.state only; every decision is derived from rows, never from naming conventions.

import { allRows, fail, padId, prefixRows } from "./state.mjs";

/** The seeded default identity used when an actor carries neither `accountId` nor `emailAddress`. */
export const DEFAULT_ACCOUNT_ID = "712020:0f3b4a6e-1c2d-4e5f-8a9b-000000000001";
export const UNAUTHORIZED_MESSAGE = "Client must be authenticated to access this resource.";

export function unauthorized(context) {
  return fail(context, "UNAUTHORIZED", UNAUTHORIZED_MESSAGE);
}

function usable(user) {
  return user !== null && user !== undefined && user.active === true && user.accountType === "atlassian";
}

/**
 * The calling Atlassian account: `actor.attributes.accountId`, else `emailAddress` (case-insensitive),
 * else the seeded default user (or, when that row is gone, the first active atlassian user by row id).
 * An explicit claim that matches no usable account fails UNAUTHORIZED.
 */
export function resolveIdentity(context, site) {
  const attributes = context.actor.attributes ?? {};
  const accountId = typeof attributes.accountId === "string" ? attributes.accountId.trim() : "";
  if (accountId.length > 0) {
    const user = context.state.get("users", accountId);
    return usable(user) ? user : unauthorized(context);
  }
  const email = typeof attributes.emailAddress === "string" ? attributes.emailAddress.trim().toLowerCase() : "";
  if (email.length > 0) {
    const user = allRows(context, "users", site.limits.maxUsers).find((row) => typeof row.emailAddress === "string" && row.emailAddress.toLowerCase() === email);
    return usable(user) ? user : unauthorized(context);
  }
  const seeded = context.state.get("users", DEFAULT_ACCOUNT_ID);
  if (usable(seeded)) return seeded;
  const first = allRows(context, "users", site.limits.maxUsers).find((row) => usable(row));
  return first === undefined ? unauthorized(context) : first;
}

/** accountId → role for one project (the lead is an implicit Administrator). */
export function projectRoles(context, site, project) {
  const roles = new Map();
  for (const row of prefixRows(context, "project-members", `${padId(project.id)}/`, site.limits.maxMembersPerProject)) {
    roles.set(row.accountId, row.role);
  }
  roles.set(project.leadAccountId, "Administrator");
  return roles;
}

export function roleOf(roles, accountId) {
  return roles.get(accountId) ?? null;
}

export function canBrowse(project, role) {
  return project.accessLevel === "private" ? role !== null : true;
}

export function canWrite(project, role) {
  if (project.accessLevel === "open") return true;
  return role === "Member" || role === "Administrator";
}

export function isAdministrator(role) {
  return role === "Administrator";
}

/** Whether a user may be assigned issues in the project. */
export function isAssignable(project, roles, user) {
  if (!usable(user)) return false;
  if (project.accessLevel === "open") return true;
  const role = roleOf(roles, user.accountId);
  return role === "Member" || role === "Administrator";
}
