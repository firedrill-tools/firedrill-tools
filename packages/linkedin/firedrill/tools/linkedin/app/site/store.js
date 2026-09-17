// Session facts (viewer from feed.list) and name lookups for person/organization URNs, cached per revision.
import { call } from "./ui.js";

export const session = { viewer: null, revision: null, feedPaging: null };
const people = new Map(); // personId -> {name, headline, vanityName}
const orgs = new Map(); // orgId -> {name, vanityName}
const pending = new Map();

export function resetCaches() { people.clear(); orgs.clear(); pending.clear(); }

export function parseEntityUrn(urn) {
  const match = /^urn:li:(person|organization):([A-Za-z0-9_-]{1,64})$/.exec(String(urn ?? ""));
  return match ? { kind: match[1], id: match[2] } : null;
}

export function rememberActor(actor) {
  const parsed = parseEntityUrn(actor?.urn);
  if (!parsed) return;
  const record = { name: actor.name, headline: actor.headline ?? null, vanityName: actor.vanityName };
  (parsed.kind === "person" ? people : orgs).set(parsed.id, record);
}
export function rememberOrganization(org) {
  if (org && org.id !== undefined) orgs.set(String(org.id), { name: org.localizedName ?? "", vanityName: org.vanityName ?? "" });
}
export function rememberPerson(person) {
  if (person?.id) people.set(person.id, { name: `${person.localizedFirstName} ${person.localizedLastName}`.trim(), headline: person.localizedHeadline ?? null, vanityName: person.vanityName });
}

export function isViewer(urn) { return Boolean(session.viewer) && urn === session.viewer.personUrn; }
/** Pages the viewer can act as (post/comment/react for). */
export function actingPages() {
  const allowed = new Set(["ADMINISTRATOR", "CONTENT_ADMINISTRATOR", "DIRECT_SPONSORED_CONTENT_POSTER"]);
  return (session.viewer?.pages ?? []).filter((p) => p.roles.some((r) => allowed.has(r)));
}

export function hrefForUrn(urn) {
  const parsed = parseEntityUrn(urn);
  if (!parsed) return "#/feed";
  if (parsed.kind === "person") return `#/in/${encodeURIComponent(parsed.id)}`;
  const org = orgs.get(parsed.id);
  return org?.vanityName ? `#/company/${encodeURIComponent(org.vanityName)}` : "#/feed";
}

/** Resolve display facts for a URN; unknown members use people.get, unknown organizations fall back to a label. */
export async function resolveEntity(urn) {
  const parsed = parseEntityUrn(urn);
  if (!parsed) return { name: "LinkedIn Member", headline: null, kind: "person", id: "" };
  const cache = parsed.kind === "person" ? people : orgs;
  if (cache.has(parsed.id)) return { ...cache.get(parsed.id), kind: parsed.kind, id: parsed.id };
  const pendingKey = urn;
  if (!pending.has(pendingKey)) {
    const lookup = parsed.kind === "person"
      ? call("people.get", { personId: parsed.id }).then(rememberPerson)
      : call("organizations.get", { organizationId: parsed.id }).then(rememberOrganization);
    pending.set(pendingKey, lookup.catch(() => undefined));
  }
  await pending.get(pendingKey);
  const found = cache.get(parsed.id);
  return found
    ? { ...found, kind: parsed.kind, id: parsed.id }
    : { name: parsed.kind === "person" ? "LinkedIn Member" : "Organization", headline: null, kind: parsed.kind, id: parsed.id };
}
