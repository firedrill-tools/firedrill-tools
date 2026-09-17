// Workspace resolution. An API key belongs to one workspace; the actor attribute `unstructuredWorkspaceId` names it.
// A fresh `firedrill tool add` actor has no attributes and falls back to the seeded default workspace.
import { fail } from "./errors.mjs";

export const DEFAULT_WORKSPACE = "ws_northgate";

/** Returns the workspace row id or fails UNAUTHORIZED ("API key is invalid"). */
export function workspaceOf(context) {
  const claimed = context.actor.attributes.unstructuredWorkspaceId;
  if (claimed === undefined || claimed === null) {
    const fallback = context.state.get("workspaces", DEFAULT_WORKSPACE);
    if (fallback === null) fail(context, "UNAUTHORIZED", "API key is invalid");
    return DEFAULT_WORKSPACE;
  }
  if (typeof claimed !== "string" || claimed.length === 0 || claimed.length > 512 || context.state.get("workspaces", claimed) === null) {
    fail(context, "UNAUTHORIZED", "API key is invalid");
  }
  return claimed;
}
