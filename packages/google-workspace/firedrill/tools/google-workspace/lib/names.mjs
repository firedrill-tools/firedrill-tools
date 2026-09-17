// Resource-name parsing. Every pattern is anchored and length-checked before any value becomes part of a row id.
import { invalid } from "./errors.mjs";
import { base64urlDecode, base64urlEncode, clip } from "./util.mjs";

export const CONTACT_ID_RE = /^c[0-9]{19}$/;
export const PROFILE_ID_RE = /^[0-9]{21}$/;
export const SYSTEM_GROUPS = ["myContacts", "starred", "friends", "coworkers"];
const SYSTEM_GROUP_SET = new Set(SYSTEM_GROUPS);
export const USER_GROUP_ID_RE = /^[0-9a-f]{16}$/;
export const SUBSCRIPTION_ID_RE = /^[0-9a-f-]{36}$/;
export const OPERATION_ID_RE = /^op[0-9]{16}$/;
export const SCRIPT_ID_RE = /^1[A-Za-z0-9_-]{43}$/;
export const DEPLOYMENT_ID_RE = /^AKfycb[A-Za-z0-9_-]{30}$/;

const badName = (context, value, what) => invalid(context, `Invalid ${what} "${clip(value, 120)}".`, "INVALID_RESOURCE_NAME");

/** `people/me`, `people/c…` (a private contact) or `people/<21 digits>` (a directory profile). */
export function parsePersonName(context, value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 120) badName(context, value, "person resource name");
  if (!value.startsWith("people/")) badName(context, value, "person resource name");
  const id = value.slice("people/".length);
  if (id === "me") return { kind: "me", id: "me" };
  if (CONTACT_ID_RE.test(id)) return { kind: "contact", id };
  if (PROFILE_ID_RE.test(id)) return { kind: "profile", id };
  return badName(context, value, "person resource name");
}

export function parseContactGroupName(context, value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 120) badName(context, value, "contact group resource name");
  if (!value.startsWith("contactGroups/")) badName(context, value, "contact group resource name");
  const id = value.slice("contactGroups/".length);
  if (SYSTEM_GROUP_SET.has(id)) return { id, system: true };
  if (USER_GROUP_ID_RE.test(id)) return { id, system: false };
  return badName(context, value, "contact group resource name");
}

export function parseSubscriptionName(context, value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 120) badName(context, value, "subscription name");
  if (!value.startsWith("subscriptions/")) badName(context, value, "subscription name");
  const id = value.slice("subscriptions/".length);
  if (!SUBSCRIPTION_ID_RE.test(id)) badName(context, value, "subscription name");
  return id;
}

export function parseOperationName(context, value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 120) badName(context, value, "operation name");
  if (!value.startsWith("operations/")) badName(context, value, "operation name");
  const id = value.slice("operations/".length);
  if (!OPERATION_ID_RE.test(id)) badName(context, value, "operation name");
  return id;
}

export function checkScriptId(context, value) {
  if (typeof value !== "string" || !SCRIPT_ID_RE.test(value)) badName(context, value, "script id");
  return value;
}

export function checkDeploymentId(context, value) {
  if (typeof value !== "string" || !DEPLOYMENT_ID_RE.test(value)) badName(context, value, "deployment id");
  return value;
}

export const isSystemGroup = (id) => SYSTEM_GROUP_SET.has(id);

/** Google's opaque etag; the underlying version is what the Tool actually compares. */
export const etagFor = (kind, id, version) => `%${base64urlEncode(`${kind}:${id}:${version}`)}`;

/** Returns the version an etag encodes, or null when it is malformed or belongs to a different object. */
export function etagVersion(etag, kind, id) {
  if (typeof etag !== "string" || etag.length < 2 || etag.length > 512 || !etag.startsWith("%")) return null;
  const decoded = base64urlDecode(etag.slice(1));
  if (decoded === null) return null;
  const prefix = `${kind}:${id}:`;
  if (!decoded.startsWith(prefix)) return null;
  const tail = decoded.slice(prefix.length);
  if (!/^[1-9][0-9]{0,8}$/.test(tail)) return null;
  return Number(tail);
}
