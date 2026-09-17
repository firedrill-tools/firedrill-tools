// Resolves the calling Workspace user from actor attributes and checks OAuth scopes.
import { denied, unauthenticated } from "./errors.mjs";
import { scanAll } from "./store.mjs";
import { clip } from "./util.mjs";

/** The seeded user a fresh actor (no attributes at all) resolves to. */
export const DEFAULT_USER_ID = "114520000000000000001";

const SCOPE_PREFIX = "https://www.googleapis.com/auth/";

export const SCOPES = {
  CONTACTS: `${SCOPE_PREFIX}contacts`,
  CONTACTS_READONLY: `${SCOPE_PREFIX}contacts.readonly`,
  CONTACTS_OTHER_READONLY: `${SCOPE_PREFIX}contacts.other.readonly`,
  DIRECTORY_READONLY: `${SCOPE_PREFIX}directory.readonly`,
  CHAT_SPACES_READONLY: `${SCOPE_PREFIX}chat.spaces.readonly`,
  DRIVE_READONLY: `${SCOPE_PREFIX}drive.readonly`,
  MEETINGS_SPACE_READONLY: `${SCOPE_PREFIX}meetings.space.readonly`,
  SCRIPT_PROJECTS: `${SCOPE_PREFIX}script.projects`,
  SCRIPT_PROJECTS_READONLY: `${SCOPE_PREFIX}script.projects.readonly`,
  SCRIPT_PROCESSES: `${SCOPE_PREFIX}script.processes`,
  SCRIPT_DEPLOYMENTS: `${SCOPE_PREFIX}script.deployments`,
  SCRIPT_DEPLOYMENTS_READONLY: `${SCOPE_PREFIX}script.deployments.readonly`,
};

const KNOWN_SCOPES = new Set(Object.values(SCOPES));

const USER_ID_RE = /^[0-9]{21}$/;

/**
 * Resolves the caller.
 * - no `userId` and no `email` attribute -> the default seeded user, so a fresh install is never empty;
 * - `userId` wins over `email`; both are matched against the `users` namespace;
 * - an unknown or suspended identity fails UNAUTHENTICATED, exactly as an expired token would.
 */
export function resolveCaller(context) {
  const attributes = context.actor.attributes ?? {};
  const rawUserId = typeof attributes.userId === "string" ? attributes.userId.trim() : "";
  const rawEmail = typeof attributes.email === "string" ? attributes.email.trim() : "";
  const users = new Map(scanAll(context, "users").map((row) => [row.rowId, row.value]));

  let user = null;
  if (rawUserId.length > 0) {
    if (!USER_ID_RE.test(rawUserId)) unauthenticated(context);
    user = users.get(rawUserId) ?? null;
  } else if (rawEmail.length > 0) {
    if (rawEmail.length > 254) unauthenticated(context);
    const wanted = rawEmail.toLowerCase();
    for (const value of users.values()) {
      if (typeof value.primaryEmail === "string" && value.primaryEmail.toLowerCase() === wanted) {
        user = value;
        break;
      }
    }
  } else {
    user = users.get(DEFAULT_USER_ID) ?? null;
    if (user === null) {
      // A world with no users at all: report it honestly rather than inventing an account.
      unauthenticated(context, "This world has no seeded Workspace users; add a `users` row before calling the Tool.");
    }
  }

  if (user === null) unauthenticated(context);
  if (user.suspended === true) unauthenticated(context, "Request had invalid authentication credentials. The account is suspended.");

  const scopes = readScopes(context, attributes);
  return { user, users, scopes };
}

function readScopes(context, attributes) {
  const raw = attributes.scopes;
  if (raw === undefined || raw === null) return null; // null means "every scope this Tool understands"
  if (typeof raw !== "string") unauthenticated(context, "The `scopes` actor attribute must be a space-separated string.");
  const granted = new Set();
  for (const entry of raw.split(/\s+/).slice(0, 64)) {
    if (KNOWN_SCOPES.has(entry)) granted.add(entry);
  }
  return granted;
}

/**
 * Enforces one of `accepted` scopes. `service` and `method` name the RPC in the ErrorInfo metadata, as Google does.
 */
export function requireScope(context, caller, accepted, service, method) {
  if (caller.scopes === null) return;
  for (const scope of accepted) {
    if (caller.scopes.has(scope)) return;
  }
  denied(
    context,
    `Request had insufficient authentication scopes. Method ${clip(method, 120)} requires one of: ${accepted.join(", ")}.`,
    "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
    { service, method: clip(method, 120) },
  );
}
