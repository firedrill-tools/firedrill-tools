// Who is calling: API-key identity from actor attributes (documensoUserId / documensoTeamId, falling back to the
// organisation's default user and that user's first team), team roles and document/template visibility.
import { bad, notFound, unauthorized } from "./errors.mjs";
import { firstWithPrefix, recipientsOf } from "./store.mjs";
import { lower, pad10, toInt } from "./util.mjs";

export const ROLE_RANK = new Map([["MEMBER", 0], ["MANAGER", 1], ["ADMIN", 2]]);
export const VIS_RANK = new Map([["EVERYONE", 0], ["MANAGER_AND_ABOVE", 1], ["ADMIN", 2]]);

export function resolveCaller(context) {
  const attributes = context.actor.attributes ?? {};
  let userId;
  if (Object.hasOwn(attributes, "documensoUserId")) {
    userId = toInt(attributes.documensoUserId);
    if (userId === null) unauthorized(context);
  } else {
    userId = toInt(context.state.get("meta", "org")?.defaultUserId) ?? 1;
  }
  const user = context.state.get("users", pad10(userId));
  if (user === null) unauthorized(context);
  let membership = null;
  if (Object.hasOwn(attributes, "documensoTeamId")) {
    const teamId = toInt(attributes.documensoTeamId);
    if (teamId === null) unauthorized(context);
    membership = context.state.get("team-members", `${pad10(teamId)}/${pad10(userId)}`);
  } else {
    const first = firstWithPrefix(context, "user-teams", `${pad10(userId)}/`);
    if (first !== null) membership = context.state.get("team-members", `${pad10(first.value.teamId)}/${pad10(userId)}`);
  }
  if (membership === null) unauthorized(context);
  const team = context.state.get("teams", pad10(membership.teamId));
  if (team === null) unauthorized(context);
  return { userId, user, teamId: team.id, team, role: membership.role };
}

export const rank = (caller) => ROLE_RANK.get(caller.role) ?? 0;
export const roleAllows = (caller, visibility) => (VIS_RANK.get(visibility) ?? 2) <= rank(caller);
export const canManage = (caller, record) => record.userId === caller.userId || rank(caller) >= 1;
export const who = (caller) => ({ name: caller.user.name, email: caller.user.email, userId: caller.userId });

export function documentVisible(context, caller, doc, recipients) {
  if (doc.teamId !== caller.teamId || doc.deletedAtUs !== null) return false;
  if (roleAllows(caller, doc.visibility) || doc.userId === caller.userId) return true;
  const email = lower(caller.user.email);
  return (recipients ?? recipientsOf(context, "document", doc.id)).some((r) => r.email === email);
}

export function parseId(context, value, name) {
  const id = toInt(value);
  if (id === null) bad(context, `Invalid ${name}: expected a positive integer id`);
  return id;
}

/** A document the caller may see, or NOT_FOUND (other teams, hidden visibility and deleted documents alike). */
export function loadDocument(context, caller, rawId, name = "documentId") {
  const doc = context.state.get("documents", pad10(parseId(context, rawId, name)));
  if (doc === null || !documentVisible(context, caller, doc)) notFound(context, "Document");
  return doc;
}

export const templateVisible = (caller, t) => t.teamId === caller.teamId && (roleAllows(caller, t.visibility) || t.userId === caller.userId);

export function loadTemplate(context, caller, rawId) {
  const t = context.state.get("templates", pad10(parseId(context, rawId, "templateId")));
  if (t === null || !templateVisible(caller, t)) notFound(context, "Template");
  return t;
}

const ENVELOPE_RE = /^envelope_[a-z0-9]{16}$/;

/** Resolves a document envelope id the caller may see, or NOT_FOUND. */
export function loadEnvelopeDocument(context, caller, envelopeId) {
  if (typeof envelopeId !== "string" || !ENVELOPE_RE.test(envelopeId)) notFound(context, "Envelope");
  const ref = context.state.get("envelope-ids", envelopeId);
  if (ref === null || ref.kind !== "document") notFound(context, "Envelope");
  const doc = context.state.get("documents", pad10(ref.id));
  if (doc === null || !documentVisible(context, caller, doc)) notFound(context, "Envelope");
  return doc;
}
