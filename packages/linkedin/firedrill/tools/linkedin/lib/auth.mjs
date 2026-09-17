// Caller identity (token), OAuth scopes, Rest.li wire checks and organization roles.
import { badRequest, fail, missing, shortValue } from "./errors.mjs";
import { organizationUrn, parseUrn, personUrn, urnType } from "./urn.mjs";

export const DEFAULT_SCOPES = ["openid", "profile", "email", "w_member_social", "r_member_social", "rw_organization_admin",
  "r_organization_social", "w_organization_social", "r_1st_connections_size"];
const ACTIVE_VERSIONS = new Set(["202509", "202510", "202511", "202512", "202601", "202602", "202603", "202604", "202605", "202606",
  "202607", "202608"]);
export const POSTER_ROLES = new Set(["ADMINISTRATOR", "CONTENT_ADMINISTRATOR", "DIRECT_SPONSORED_CONTENT_POSTER"]);
export const READER_ROLES = new Set([...POSTER_ROLES, "ANALYST", "CURATOR"]);
const PERSON_ID = /^[A-Za-z0-9_-]{10}$/;

/** Resolves the member the token belongs to: `linkedinPersonId`, else the network's default member. */
export function caller(context) {
  const attributes = context.actor.attributes ?? {};
  let personId = Object.hasOwn(attributes, "linkedinPersonId") ? attributes.linkedinPersonId : undefined;
  if (personId === undefined || personId === null) personId = context.state.get("meta", "network")?.defaultPersonId;
  const person = typeof personId === "string" && PERSON_ID.test(personId) ? context.state.get("people", personId) : null;
  if (person === null) fail(context, "INVALID_ACCESS_TOKEN", "Invalid access token");
  const raw = Object.hasOwn(attributes, "linkedinScopes") ? attributes.linkedinScopes : undefined;
  const scopes = new Set(Array.isArray(raw) ? raw.filter((scope) => typeof scope === "string") : DEFAULT_SCOPES);
  return { personId, person, urn: personUrn(personId), scopes };
}

/**
 * Header and syntax checks for requests that arrived through an HTTP route (`input.wire`). Canonical, MCP and app callers
 * send no `wire` and skip them. `expected` is the Rest.li method the route implements.
 */
export function checkWire(context, input, expected, restAllowed = true) {
  const wire = input.wire;
  if (wire === undefined) return;
  if (wire.rest === true && restAllowed) {
    const version = wire.linkedinVersion;
    if (typeof version !== "string" || version.trim() === "") {
      fail(context, "VERSION_MISSING", "A version must be present. Please specify a version by adding the Linkedin-Version header.");
    }
    if (!ACTIVE_VERSIONS.has(version.trim())) fail(context, "NONEXISTENT_VERSION", `Requested version ${shortValue(version)} is not active`);
    const method = wire.restliMethod;
    if (method === null || method === undefined) {
      if (wire.requireMethod === true) badRequest(context, "Invalid X-RestLi-Method header");
    } else if (method.trim().toUpperCase() !== expected) badRequest(context, "Invalid X-RestLi-Method header");
  }
  if (typeof wire.error === "string") badRequest(context, wire.error);
}

/** Fails ACCESS_DENIED unless the token holds at least one of the scopes. */
export function requireScope(context, who, anyOf, resource) {
  if (!anyOf.some((scope) => who.scopes.has(scope))) fail(context, "ACCESS_DENIED", `Not enough permissions to access: ${resource}`);
}

const ALL_ROLES = ["ADMINISTRATOR", "DIRECT_SPONSORED_CONTENT_POSTER", "RECRUITING_POSTER", "LEAD_CAPTURE_ADMINISTRATOR",
  "LEAD_GEN_FORMS_MANAGER", "ANALYST", "CURATOR", "CONTENT_ADMINISTRATOR"];

/** Approved roles of a member on an organization (one direct read per role; no scan). */
export function rolesOn(context, organizationId, personId) {
  const roles = new Set();
  for (const role of ALL_ROLES) {
    if (context.state.get("organization-acls", `${organizationId}|${personId}|${role}`)?.state === "APPROVED") roles.add(role);
  }
  return roles;
}

export const holdsAny = (roles, wanted) => [...roles].some((role) => wanted.has(role));

/**
 * Validates a URN-valued field. `types` lists accepted URN types; `inPath` makes syntax problems Rest.li path errors.
 * Returns the parsed URN, or null when the value is absent and `required` is false.
 */
export function urnField(context, field, value, types, { required = true, inPath = false } = {}) {
  if (value === undefined || value === null) {
    if (!required) return null;
    return missing(context, field);
  }
  const parsed = parseUrn(value);
  if (inPath && (parsed === null || !types.includes(parsed.type))) return badRequest(context, "Syntax exception in path variables");
  if (parsed === null) {
    const type = urnType(value);
    if (type !== null && !types.includes(type)) {
      return fail(context, "INVALID_URN_TYPE", `${field} value ${shortValue(value)} must be a ${types.join(" or ")} URN`);
    }
    return fail(context, "INVALID_URN_ID", "The URN ID provided is invalid");
  }
  if (!types.includes(parsed.type)) {
    return fail(context, "INVALID_URN_TYPE", `${field} value ${shortValue(value)} must be a ${types.join(" or ")} URN`);
  }
  return parsed;
}

/**
 * Checks that the caller may act as `actorValue` (its own person URN, or an organization it holds a poster role on) and
 * that the token carries the matching write scope. Returns `{ urn, kind, id, agent }`.
 */
export function actingAs(context, who, field, actorValue, resource) {
  const parsed = urnField(context, field, actorValue, ["person", "organization"]);
  if (parsed.type === "person") {
    requireScope(context, who, ["w_member_social"], resource);
    if (parsed.id !== who.personId) fail(context, "ACCESS_DENIED", `Not enough permissions to act as ${parsed.urn}`);
    return { urn: parsed.urn, kind: "person", id: parsed.id, agent: null };
  }
  requireScope(context, who, ["w_organization_social"], resource);
  const organization = context.state.get("organizations", parsed.id);
  if (organization === null || !holdsAny(rolesOn(context, parsed.id, who.personId), POSTER_ROLES)) {
    fail(context, "ACCESS_DENIED", `Not enough permissions to act as ${parsed.urn}`);
  }
  return { urn: organizationUrn(parsed.id), kind: "organization", id: parsed.id, agent: who.personId };
}

/** Whether the caller may manage content authored by `authorUrn` (the author itself, or a poster of that page). */
export function managesAuthor(context, who, authorUrn) {
  if (authorUrn === who.urn) return true;
  const parsed = parseUrn(authorUrn);
  return parsed !== null && parsed.type === "organization" && holdsAny(rolesOn(context, parsed.id, who.personId), POSTER_ROLES);
}

export const connected = (context, a, b) => context.state.get("connections", `${a}|${b}`) !== null;
