// Identity, project visibility and access levels (GitLab roles: 10 Guest, 15 Planner, 20 Reporter, 30 Developer,
// 40 Maintainer, 50 Owner). Invisible projects answer 404 exactly like GitLab hides them. All rules read context.state
// per call.
import { allRows, fail, fitsRowId, memberRowId, projectRowId, todayUtc, userRowId } from "./ids.mjs";

export const GUEST = 10;
export const PLANNER = 15;
export const REPORTER = 20;
export const DEVELOPER = 30;
export const MAINTAINER = 40;
export const OWNER = 50;

const MAX_ATTRIBUTE = 255;

function unauthorized(context) {
  return fail(context, "UNAUTHORIZED", "401 Unauthorized");
}

/**
 * The `users` row the caller acts as.
 * - `username` attribute: must name an active user (case-insensitive).
 * - `userId` attribute (integer or numeric string): must name an active user; must agree with `username` if both are set.
 * - neither attribute (the actor `firedrill tool add` creates): the primary seeded user, i.e. the active, non-bot user
 *   with the lowest id. Only a world without such a user fails.
 * Unknown, blocked, empty or malformed identities fail UNAUTHORIZED (`401 Unauthorized`), like a revoked token.
 */
export function requireUser(context) {
  const attributes = context.actor.attributes ?? {};
  const hasUsername = Object.prototype.hasOwnProperty.call(attributes, "username") && attributes.username !== undefined;
  const hasUserId = Object.prototype.hasOwnProperty.call(attributes, "userId") && attributes.userId !== undefined;
  if (!hasUsername && !hasUserId) {
    const fallback = defaultUser(context);
    return fallback === null ? unauthorized(context) : fallback;
  }
  let user = null;
  if (hasUsername) {
    const username = attributes.username;
    if (typeof username !== "string" || username.length === 0 || username.length > MAX_ATTRIBUTE) return unauthorized(context);
    user = findUserByUsername(context, username);
    if (user === null) return unauthorized(context);
  }
  if (hasUserId) {
    const raw = attributes.userId;
    const id = typeof raw === "number" ? raw : typeof raw === "string" && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(id) || id < 1) return unauthorized(context);
    const byId = findUserById(context, id);
    if (byId === null || (user !== null && user.id !== byId.id)) return unauthorized(context);
    user = byId;
  }
  if (user.state !== "active") return unauthorized(context);
  return user;
}

export function defaultUser(context) {
  let best = null;
  for (const user of allRows(context, "users", "users")) {
    if (user.state !== "active" || user.bot) continue;
    if (best === null || user.id < best.id) best = user;
  }
  return best;
}

export function findUserById(context, id) {
  if (!Number.isSafeInteger(id) || id < 1 || id > 9_999_999_999) return null;
  return context.state.get("users", userRowId(id));
}

export function findUserByUsername(context, username) {
  if (typeof username !== "string" || username.length === 0 || username.length > MAX_ATTRIBUTE) return null;
  const lower = username.toLowerCase();
  return allRows(context, "users", "users").find((user) => user.username.toLowerCase() === lower) ?? null;
}

/** Direct membership level of `user` on `project` (expired memberships count as none), or null. */
export function accessLevel(context, project, user) {
  const row = context.state.get("members", memberRowId(project.id, user.id));
  if (row !== null && (row.expires_at === null || row.expires_at >= todayUtc(context))) return row.access_level;
  if (project.namespace.kind === "user" && project.creator_id === user.id) return OWNER;
  return null;
}

export function canSee(project, user, level) {
  if (project.visibility === "public") return true;
  if (project.visibility === "internal") return user.external !== true || level !== null;
  return level !== null;
}

/** Project lookup by numeric id or full path (case-insensitive); invisible or unknown → 404 Project Not Found. */
export function resolveProject(context, user, reference) {
  const project = findProject(context, reference);
  if (project === null) return fail(context, "NOT_FOUND", "404 Project Not Found");
  const level = accessLevel(context, project, user);
  if (!canSee(project, user, level)) return fail(context, "NOT_FOUND", "404 Project Not Found");
  return { project, level };
}

export function findProject(context, reference) {
  if (typeof reference === "number") {
    return Number.isSafeInteger(reference) && reference >= 1 && reference <= 999_999 ? context.state.get("projects", projectRowId(reference)) : null;
  }
  if (typeof reference !== "string" || reference.length === 0 || reference.length > 255) return null;
  if (/^[1-9][0-9]{0,5}$/.test(reference)) return context.state.get("projects", projectRowId(Number(reference)));
  const lower = reference.toLowerCase();
  return allRows(context, "projects", "projects").find((project) => project.path_with_namespace.toLowerCase() === lower) ?? null;
}

export function atLeast(level, required) {
  return typeof level === "number" && level >= required;
}

/** Archived projects are read-only. */
export function requireWritable(context, project) {
  if (project.archived === true) return fail(context, "FORBIDDEN", "403 Forbidden");
  return project;
}

export function requireLevel(context, level, required, message = "403 Forbidden") {
  if (!atLeast(level, required)) return fail(context, "FORBIDDEN", message);
}

/** Minimum level to push to a branch row (protected branches follow their push level). */
export function pushLevel(branch) {
  if (branch === null || !branch.protected) return DEVELOPER;
  if (branch.developers_can_push) return DEVELOPER;
  return branch.push_access_level === 0 ? Number.POSITIVE_INFINITY : branch.push_access_level;
}

/** Minimum level to merge into a branch row. */
export function mergeLevel(branch) {
  if (branch === null || !branch.protected) return DEVELOPER;
  if (branch.developers_can_merge) return DEVELOPER;
  return branch.merge_access_level;
}

/** Whether `userId` may be assigned/requested for review on `project` (any membership, or the namespace owner). */
export function isAssignable(context, project, userId) {
  const user = typeof userId === "number" && fitsRowId(userRowId(userId)) ? context.state.get("users", userRowId(userId)) : null;
  return user !== null && accessLevel(context, project, user) !== null;
}
