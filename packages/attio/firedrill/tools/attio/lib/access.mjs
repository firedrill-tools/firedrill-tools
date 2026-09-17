// Caller identity, token scopes and list access. Reads context.state only.
import { clip, fail, findRow, isPlainObject, isUuid, workspace } from "./common.mjs";

export const ALL_SCOPES = Object.freeze([
  "user_management:read",
  "record_permission:read-write",
  "object_configuration:read",
  "list_entry:read-write",
  "list_configuration:read",
  "note:read-write",
  "task:read-write",
]);

const LEVELS = ["read-only", "read-and-write", "full-access"];
const AUTH_MESSAGE = "The access token is invalid or has been revoked.";

/**
 * The calling workspace member. `workspaceMemberId` or `email` actor attributes select a member (unknown →
 * AUTHENTICATION_FAILED). Without either (a fresh `firedrill tool add` actor) the caller is the first admin
 * member in row-id order. Suspended members are refused with UNAUTHORIZED.
 */
export function caller(context) {
  const attributes = isPlainObject(context.actor.attributes) ? context.actor.attributes : {};
  const ws = workspace(context);
  let member = null;
  if (typeof attributes.workspaceMemberId === "string") {
    member = isUuid(attributes.workspaceMemberId) ? context.state.get("workspace-members", attributes.workspaceMemberId) : null;
  } else if (typeof attributes.email === "string") {
    const email = attributes.email.trim().toLowerCase();
    member = findRow(context, "workspace-members", (row) => row.email_address.toLowerCase() === email);
  } else {
    member = findRow(context, "workspace-members", (row) => row.access_level === "admin");
  }
  if (member === null) return fail(context, "AUTHENTICATION_FAILED", AUTH_MESSAGE);
  if (member.access_level === "suspended") return fail(context, "UNAUTHORIZED", "Workspace member is suspended.");
  const scopes = Array.isArray(attributes.scopes) ? attributes.scopes.filter((scope) => typeof scope === "string") : null;
  return { member, scopes, workspace: ws, actor: { type: "api-token", id: ws.client_id } };
}

function hasScope(scopes, scope) {
  if (scopes.includes(scope)) return true;
  return scope.endsWith(":read") && scopes.includes(`${scope.slice(0, -":read".length)}:read-write`);
}

export function requireScopes(context, who, ...required) {
  if (who.scopes === null) return;
  const missing = required.filter((scope) => !hasScope(who.scopes, scope));
  if (missing.length > 0) {
    fail(context, "UNAUTHORIZED", `The access token is missing the required scopes: ${missing.join(", ")}.`);
  }
}

export function scopeString(who) {
  return (who.scopes === null ? ALL_SCOPES : who.scopes).join(" ");
}

/** Effective list access level for the caller, or null when the list is invisible. */
export function listLevel(who, list) {
  if (who.member.access_level === "admin") return "full-access";
  let best = LEVELS.indexOf(list.workspace_access ?? "");
  for (const grant of list.workspace_member_access) {
    if (grant.workspace_member_id === who.member.workspace_member_id) best = Math.max(best, LEVELS.indexOf(grant.level));
  }
  return best < 0 ? null : LEVELS[best];
}

/** A list by slug or id that the caller can see; NOT_FOUND otherwise. */
export function visibleList(context, who, identifier) {
  let list = null;
  if (isUuid(identifier)) list = context.state.get("lists", identifier);
  else if (typeof identifier === "string" && identifier.length <= 128) list = findRow(context, "lists", (row) => row.api_slug === identifier);
  if (list === null || listLevel(who, list) === null) {
    return fail(context, "NOT_FOUND", `List with slug/ID "${clip(String(identifier))}" not found.`);
  }
  return list;
}

export function requireListWrite(context, who, list) {
  if (listLevel(who, list) === "read-only") fail(context, "UNAUTHORIZED", "You do not have permission to write to this list.");
}

/** Resolve a workspace member reference: `{ referenced_actor_type, referenced_actor_id }`, `{ workspace_member_email_address }`, id or e-mail string. */
export function findMember(context, reference) {
  if (typeof reference === "string") {
    if (isUuid(reference)) return context.state.get("workspace-members", reference);
    const email = reference.trim().toLowerCase();
    if (email.length === 0 || email.length > 320) return null;
    return findRow(context, "workspace-members", (row) => row.email_address.toLowerCase() === email);
  }
  if (!isPlainObject(reference)) return null;
  if (typeof reference.workspace_member_email_address === "string") return findMember(context, reference.workspace_member_email_address);
  if (reference.referenced_actor_type === "workspace-member" && typeof reference.referenced_actor_id === "string") {
    return isUuid(reference.referenced_actor_id) ? context.state.get("workspace-members", reference.referenced_actor_id) : null;
  }
  return null;
}
