// Calling identity, scopes, bounds and counters. All state lives in `context.state`.
import { fnv32 } from "./util.mjs";

export const DEFAULT_LIMITS = Object.freeze({ entries: 10000, depth: 25, revisions: 50000, links: 5000, journal: 5000, uploadBytes: 262144 });

/** Bounds: `meta/limits` may tighten (never loosen) the defaults, so scenarios can reach bound errors cheaply. */
export function limits(context) {
  const row = context.state.get("meta", "limits");
  const out = { ...DEFAULT_LIMITS };
  if (row !== null) {
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      const value = row[key];
      if (Number.isInteger(value) && value >= 0 && value < out[key]) out[key] = value;
    }
  }
  return out;
}

const COUNTERS = { nextEntry: 1, nextRev: 1, nextLink: 1, nextJournal: 1, journalFloor: 1 };

export function counters(context) {
  const row = context.state.get("meta", "counters");
  return { ...COUNTERS, ...(row ?? {}) };
}

export function saveCounters(context, value) {
  context.state.put("meta", "counters", value);
}

function scopesOf(actor) {
  const scopes = actor.attributes?.scopes;
  if (scopes === undefined) return null;
  return Array.isArray(scopes) ? scopes.filter((s) => typeof s === "string") : [];
}

function invalidToken(context, message = "invalid_access_token") {
  context.fail({
    code: "INVALID_ACCESS_TOKEN",
    message,
    details: { error_summary: "invalid_access_token/...", error: { ".tag": "invalid_access_token" } },
  });
}

/** A world without any account row: a deterministic empty account derived from the actor id (persisted on first write). */
function derivedAccount(actorId) {
  const digest = (fnv32(actorId) + fnv32(actorId, 0x01000193) + fnv32(`x${actorId}`) + fnv32(`y${actorId}`) + fnv32(`z${actorId}`)).slice(0, 40);
  const accountId = `dbid:${digest}`;
  const local = actorId.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 60) || "user";
  return {
    accountId,
    givenName: actorId.slice(0, 100),
    surname: "",
    familiarName: actorId.slice(0, 100),
    displayName: actorId.slice(0, 100),
    abbreviatedName: actorId.slice(0, 2).toUpperCase(),
    email: `${local}@example.test`,
    emailVerified: true,
    disabled: false,
    country: "US",
    locale: "en",
    accountType: "basic",
    allocated: 2147483648,
    rootNamespaceId: String(parseInt(digest.slice(0, 8), 16)),
    referralLink: `https://www.dropbox.com/referrals/${digest.slice(0, 12)}`,
    derived: true,
  };
}

/**
 * Resolves the calling Dropbox account and checks the operation's scope.
 * `accountId` attribute → that row (missing → 401 invalid_access_token); else `email` (case-insensitive); else the
 * account with the lowest row id (fresh-install fallback); a world with no accounts gets a derived empty account.
 */
export function callerAccount(context, scope) {
  const attributes = context.actor.attributes ?? {};
  let account = null;
  if (attributes.accountId !== undefined) {
    const id = attributes.accountId;
    if (typeof id !== "string" || id.length === 0 || id.length > 512) invalidToken(context);
    account = context.state.get("accounts", id);
    if (account === null) invalidToken(context);
  } else if (attributes.email !== undefined) {
    const email = typeof attributes.email === "string" ? attributes.email.toLowerCase() : null;
    if (email === null) invalidToken(context);
    const rows = context.state.scan("accounts", { limit: 1001 });
    if (rows.length > 1000) invalidToken(context, "invalid_access_token: resolving the actor by email is bounded to 1000 accounts; set the accountId attribute");
    account = rows.find((row) => String(row.value.email).toLowerCase() === email)?.value ?? null;
    if (account === null) invalidToken(context);
  } else {
    account = context.state.scan("accounts", { limit: 1 })[0]?.value ?? derivedAccount(context.actor.id);
  }
  const scopes = scopesOf(context.actor);
  if (scopes !== null && !scopes.includes(scope)) {
    context.fail({
      code: "MISSING_SCOPE",
      message: `missing_scope: ${scope}`,
      details: { error_summary: "missing_scope/...", error: { ".tag": "missing_scope", required_scope: scope } },
    });
  }
  return account;
}

/** Persists a derived account before the first write that needs it. */
export function ensureAccount(context, account) {
  if (account.derived === true) {
    const { derived, ...row } = account;
    context.state.put("accounts", row.accountId, row);
  }
}

/** Rev prefix: "0" + 8 hex digits derived from the account's root namespace id. */
export function revPrefix(account) {
  const n = Number(account.rootNamespaceId) >>> 0;
  return `0${n.toString(16).padStart(8, "0").slice(-8)}`;
}
