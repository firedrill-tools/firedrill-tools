// Identity, repository visibility and permission rules. GitHub hides private repositories with 404, rejects
// writes to archived repositories with 403, and ranks collaborator permissions admin > maintain > write >
// triage > read. All rules read context.state per call.
import { PERMISSION_RANK, allRows, collaboratorRowId, fail, fitsRowId, ownValue, repoKey } from "./ids.mjs";

/**
 * The `users` row the caller acts as.
 * - `context.actor.attributes.login` present: it must name a `users` row of `type: "User"`; anything else (unknown
 *   login, organisation login, empty or non-string value) is a bad token → UNAUTHORIZED `Bad credentials` (401).
 * - attribute absent (e.g. the actor `firedrill tool add` creates): the primary seeded user, i.e. the `type: "User"`
 *   row with the lowest numeric `id` (ties by login). Only a world without any user row fails UNAUTHORIZED.
 */
export function requireUser(context) {
  const attributes = context.actor.attributes ?? {};
  if (!Object.prototype.hasOwnProperty.call(attributes, "login") || attributes.login === undefined) {
    const fallback = defaultUser(context);
    return fallback === null ? fail(context, "UNAUTHORIZED", "Bad credentials") : fallback;
  }
  const login = attributes.login;
  if (typeof login !== "string" || login.length === 0) return fail(context, "UNAUTHORIZED", "Bad credentials");
  const user = fitsRowId(login) ? context.state.get("users", login.toLowerCase()) : null;
  if (user === null || user.type !== "User") return fail(context, "UNAUTHORIZED", "Bad credentials");
  return user;
}

/** Deterministic default identity: the `type: "User"` row with the lowest `id` (bounded scan; fails at the cap). */
export function defaultUser(context) {
  let best = null;
  for (const user of allRows(context, "users")) {
    if (user.type !== "User") continue;
    if (best === null || user.id < best.id || (user.id === best.id && user.login.toLowerCase() < best.login.toLowerCase())) best = user;
  }
  return best;
}

export function findUser(context, login) {
  if (typeof login !== "string" || !fitsRowId(login)) return null;
  return context.state.get("users", login.toLowerCase());
}

/** Explicit permission of `login` on `repo` (owner => admin), or null when not a collaborator. */
export function permissionOf(context, repo, login) {
  const lower = String(login).toLowerCase();
  if (repo.owner.toLowerCase() === lower) return "admin";
  const rowId = collaboratorRowId(repo.key, lower);
  const row = fitsRowId(rowId) ? context.state.get("collaborators", rowId) : null;
  return row === null ? null : row.permission;
}

export function atLeast(permission, required) {
  const have = ownValue(PERMISSION_RANK, permission);
  const need = ownValue(PERMISSION_RANK, required);
  return have !== undefined && need !== undefined && have >= need;
}

/** Whether `login` can be assigned issues (collaborator or repository owner). */
export function isAssignable(context, repo, login) {
  return findUser(context, login) !== null && permissionOf(context, repo, login) !== null;
}

/** author_association as GitHub renders it for this login on this repository (simplified). */
export function association(context, repo, login) {
  const permission = permissionOf(context, repo, login);
  if (repo.owner.toLowerCase() === String(login).toLowerCase()) return "OWNER";
  if (permission === null) return "NONE";
  const owner = context.state.get("users", repo.owner.toLowerCase());
  return owner !== null && owner.type === "Organization" ? "MEMBER" : "COLLABORATOR";
}

/**
 * Resolve a repository the caller may see. Returns the stored row plus `key` and the caller's permission
 * (null for a public repository the caller does not collaborate on).
 */
export function visibleRepo(context, user, owner, repo) {
  const key = repoKey(owner, repo);
  const row = typeof owner === "string" && typeof repo === "string" && fitsRowId(key) ? context.state.get("repos", key) : null;
  if (row === null) return fail(context, "NOT_FOUND", "Not Found");
  const resolved = { ...row, key };
  const permission = permissionOf(context, resolved, user.login);
  if (row.private === true && permission === null) return fail(context, "NOT_FOUND", "Not Found");
  return { repo: resolved, permission };
}

/** Writes need an unarchived repository; the message is GitHub's. */
export function requireWritable(context, repo) {
  if (repo.archived === true) return fail(context, "FORBIDDEN", "Repository was archived so is read-only.");
  return repo;
}

export function requirePush(context, permission) {
  if (!atLeast(permission, "write")) return fail(context, "FORBIDDEN", "Must have push access to the repository.");
}

export function requireTriage(context, permission) {
  if (!atLeast(permission, "triage")) {
    return fail(context, "FORBIDDEN", "Resource not accessible by personal access token");
  }
}

/** Repositories the caller can see: every public one plus private ones they collaborate on. */
export function visibleRepos(context, user, allRepos) {
  return allRepos
    .map((row) => ({ ...row, key: repoKey(row.owner, row.name) }))
    .map((row) => ({ repo: row, permission: permissionOf(context, row, user.login) }))
    .filter((entry) => entry.repo.private !== true || entry.permission !== null);
}
