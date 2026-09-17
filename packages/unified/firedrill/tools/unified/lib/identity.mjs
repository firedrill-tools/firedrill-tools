// Identity and per-connection access rules, applied by every handler in this order:
// 1 workspace (actor attribute `workspaceId`, falling back to the first seeded workspace), 2 connection resolution
// (incl. the `connectionIds` scope), 3 connection health, 4 category, 5 permission.
import { badRequest, forbidden, notFound, notImplemented, unauthorized } from "./errors.mjs";
import { scanAll } from "./store.mjs";
import { clip, isHex24 } from "./util.mjs";

/** Resolves the caller's workspace row or fails UNAUTHORIZED; also refuses a codec refusal carried in the input. */
export function resolveWorkspace(input, context) {
  if (typeof input.__request_error === "string") badRequest(context, input.__request_error);
  const claimed = context.actor?.attributes?.workspaceId;
  if (claimed !== undefined && claimed !== null) {
    if (typeof claimed !== "string" || claimed.length === 0 || claimed.length > 64) unauthorized(context);
    const row = context.state.get("workspaces", claimed);
    if (row === null) unauthorized(context);
    return row;
  }
  const rows = scanAll(context, "workspaces", 100);
  if (rows.length === 0) unauthorized(context);
  return rows[0];
}

/** The connection ids a connection-scoped key may see, or null for a workspace-wide key. */
export function connectionScope(context) {
  const scope = context.actor?.attributes?.connectionIds;
  if (!Array.isArray(scope)) return null;
  const set = new Set();
  for (const id of scope.slice(0, 256)) if (typeof id === "string") set.add(id);
  return set;
}

export const inScope = (scope, connectionId) => scope === null || scope.has(connectionId);

/** Loads a connection of the workspace within the caller's scope, or fails NOT_FOUND (a scoped key learns nothing). */
export function loadConnection(context, workspace, connectionId) {
  if (!isHex24(connectionId)) badRequest(context, `Invalid connection_id: ${clip(connectionId, 60)}`);
  const connection = context.state.get("connections", connectionId);
  if (connection === null || connection.workspace_id !== workspace.id || !inScope(connectionScope(context), connectionId)) {
    notFound(context, "Connection not found");
  }
  return connection;
}

/**
 * Resolves the connection for a data operation and applies health, category and permission checks.
 * `category` is "crm" or "messaging"; `permission` is the exact Unified.to permission slug.
 */
export function requireConnection(context, workspace, connectionId, category, permission) {
  const connection = loadConnection(context, workspace, connectionId);
  if (connection.last_unhealthy_code !== null && connection.last_unhealthy_code !== undefined) {
    unauthorized(context, "The connection is likely broken and requires recreation");
  }
  if (connection.is_paused === true) forbidden(context, "Connection is paused; monthly plan limit exceeded");
  if (!connection.categories.includes(category)) notImplemented(context);
  if (!connection.permissions.includes(permission)) {
    forbidden(context, `The connection lacks the required permissions or scopes: ${permission}`);
  }
  return connection;
}
