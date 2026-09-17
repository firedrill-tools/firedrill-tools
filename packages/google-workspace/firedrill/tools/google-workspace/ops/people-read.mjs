// People API reads: people.get, people.connections.list.
import { invalid, notFound, outOfRange, precondition } from "../lib/errors.mjs";
import { SCOPES, requireScope } from "../lib/identity.mjs";
import { parsePersonFields } from "../lib/mask.mjs";
import { parsePersonName } from "../lib/names.mjs";
import { fillPage, mintKeyedToken, mintSyncToken, pageSize, readSyncToken, resumeIndex } from "../lib/page.mjs";
import { renderContact, renderProfile } from "../lib/render.mjs";
import { scanPrefix } from "../lib/store.mjs";
import { fold } from "../lib/util.mjs";
import { begin, loadContacts } from "./common.mjs";

const READ_SCOPES = [SCOPES.CONTACTS, SCOPES.CONTACTS_READONLY];
const PEOPLE = "people.googleapis.com";

const SOURCE_TYPES = new Set(["READ_SOURCE_TYPE_CONTACT", "READ_SOURCE_TYPE_PROFILE", "READ_SOURCE_TYPE_DOMAIN_CONTACT", "READ_SOURCE_TYPE_UNSPECIFIED"]);

export function getContact(input, context) {
  const { caller } = begin(context, input);
  const name = parsePersonName(context, input.resourceName);
  const wanted = parsePersonFields(context, input.personFields);
  if (input.sources !== undefined) {
    for (const source of input.sources) {
      if (!SOURCE_TYPES.has(source)) invalid(context, `Invalid sources value "${source}".`);
    }
  }

  if (name.kind === "me" || (name.kind === "profile" && name.id === caller.user.id)) {
    requireScope(context, caller, [...READ_SCOPES, SCOPES.DIRECTORY_READONLY], PEOPLE, "google.people.v1.PeopleService.GetPerson");
    return renderProfile(caller.user, wanted, true);
  }
  if (name.kind === "profile") {
    requireScope(context, caller, [SCOPES.DIRECTORY_READONLY], PEOPLE, "google.people.v1.PeopleService.GetPerson");
    const user = caller.users.get(name.id);
    if (user === undefined || user.suspended === true || user.domain !== caller.user.domain) notFound(context);
    return renderProfile(user, wanted, false);
  }

  requireScope(context, caller, READ_SCOPES, PEOPLE, "google.people.v1.PeopleService.GetPerson");
  const row = context.state.get("contacts", `${caller.user.id}:${name.id}`);
  if (row === null) notFound(context);
  return renderContact(row, wanted);
}

const SORT_ORDERS = new Set(["LAST_MODIFIED_ASCENDING", "LAST_MODIFIED_DESCENDING", "FIRST_NAME_ASCENDING", "LAST_NAME_ASCENDING"]);

function sortContacts(contacts, order) {
  const list = [...contacts];
  if (order === "LAST_MODIFIED_ASCENDING") list.sort((a, b) => a.updateTimeUs - b.updateTimeUs || cmp(a.contactId, b.contactId));
  else if (order === "FIRST_NAME_ASCENDING") list.sort((a, b) => cmp(firstName(a), firstName(b)) || cmp(a.contactId, b.contactId));
  else if (order === "LAST_NAME_ASCENDING") list.sort((a, b) => cmp(a.sortName, b.sortName) || cmp(a.contactId, b.contactId));
  else list.sort((a, b) => b.updateTimeUs - a.updateTimeUs || cmp(a.contactId, b.contactId));
  return list;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const firstName = (contact) => {
  const name = contact.names[0];
  if (name === undefined) return fold(contact.emailAddresses[0]?.value ?? "");
  return fold(name.givenName ?? name.displayName ?? name.unstructuredName ?? "");
};

export function listConnections(input, context) {
  const { caller } = begin(context, input);
  requireScope(context, caller, READ_SCOPES, PEOPLE, "google.people.v1.PeopleService.ListConnections");
  if (input.resourceName !== "people/me") {
    invalid(context, 'The resource name must be "people/me"; listing another person\'s connections is not supported.');
  }
  const wanted = parsePersonFields(context, input.personFields);
  const limit = pageSize(context, input.pageSize, 1, 1000, 100);
  if (input.syncToken !== undefined && input.sortOrder !== undefined) {
    invalid(context, "A sync token cannot be combined with a sort order.");
  }
  const order = input.sortOrder ?? "LAST_MODIFIED_DESCENDING";
  if (!SORT_ORDERS.has(order)) invalid(context, `Invalid sortOrder "${String(input.sortOrder)}".`);

  const contacts = [...loadContacts(context, caller.user.id).values()];
  const totalPeople = contacts.length;
  const now = context.clock.nowUs();

  if (input.syncToken !== undefined) {
    return syncPage(input, context, caller, wanted, limit, contacts, now);
  }

  const sorted = sortContacts(contacts, order);
  const scope = `connections:${caller.user.id}:${order}`;
  const keyOf = connectionKey(order);
  const start = resumeIndex(context, input.pageToken, scope, sorted, (contact) => contact.contactId, keyOf, SORT_DIRS[order]);
  const { entries, nextIndex } = fillPage(
    sorted,
    start,
    limit,
    (contact) => renderContact(contact, wanted),
    () => outOfRange(context, "A single contact is larger than the maximum response size for this simulation."),
  );
  const out = { connections: entries, totalPeople, totalItems: totalPeople };
  if (nextIndex < sorted.length) out.nextPageToken = mintKeyedToken(scope, sorted[nextIndex].contactId, keyOf(sorted[nextIndex]));
  else if (input.requestSyncToken === true) out.nextSyncToken = mintSyncToken(caller.user.id, now);
  return out;
}

/** Sort keys mirroring `sortContacts`, carried in page tokens so a deleted anchor resumes at the next row. */
const SORT_DIRS = {
  LAST_MODIFIED_ASCENDING: [1, 1],
  FIRST_NAME_ASCENDING: [1, 1],
  LAST_NAME_ASCENDING: [1, 1],
  LAST_MODIFIED_DESCENDING: [-1, 1],
};
function connectionKey(order) {
  if (order === "FIRST_NAME_ASCENDING") return (contact) => [firstName(contact), contact.contactId];
  if (order === "LAST_NAME_ASCENDING") return (contact) => [contact.sortName, contact.contactId];
  return (contact) => [contact.updateTimeUs, contact.contactId];
}

function syncPage(input, context, caller, wanted, limit, contacts, now) {
  const since = readSyncToken(context, input.syncToken, caller.user.id);
  // `syncFloorUs` is the watermark below which deletions are no longer retained: it rises whenever the oldest
  // tombstone is dropped at the 200-row cap. A token minted before it cannot produce a complete delta.
  const floor = typeof caller.user.syncFloorUs === "number" ? caller.user.syncFloorUs : 0;
  if (since < floor) {
    precondition(context, "Sync token is expired. Clear local cache and retry call without the sync token.", "EXPIRED_SYNC_TOKEN");
  }
  const tombstones = scanPrefix(context, "contact-tombstones", `${caller.user.id}:`).map((row) => row.value);

  // The watermark is inclusive, so a change made in the same virtual microsecond as the token is delivered
  // again rather than lost: People sync is at-least-once, never at-most-once.
  const changed = contacts.filter((contact) => contact.updateTimeUs >= since);
  changed.sort((a, b) => a.updateTimeUs - b.updateTimeUs || cmp(a.contactId, b.contactId));
  const deleted = tombstones.filter((row) => row.deleteTimeUs >= since);
  deleted.sort((a, b) => a.deleteTimeUs - b.deleteTimeUs || cmp(a.contactId, b.contactId));

  const combined = [
    ...changed.map((contact) => ({ kind: "contact", key: contact.contactId, value: contact })),
    ...deleted.map((row) => ({ kind: "deleted", key: row.contactId, value: row })),
  ];
  const scope = `sync:${caller.user.id}`;
  const syncKey = (entry) =>
    entry.kind === "contact" ? [0, entry.value.updateTimeUs, entry.key] : [1, entry.value.deleteTimeUs, entry.key];
  const syncId = (entry) => `${entry.kind}:${entry.key}`;
  const start = resumeIndex(context, input.pageToken, scope, combined, syncId, syncKey);

  const { entries, nextIndex } = fillPage(
    combined,
    start,
    limit,
    (entry) =>
      entry.kind === "contact"
        ? renderContact(entry.value, wanted)
        : { resourceName: `people/${entry.value.contactId}`, etag: "%deleted", metadata: { deleted: true, objectType: "PERSON" } },
    () => outOfRange(context, "A single contact is larger than the maximum response size for this simulation."),
  );
  const out = { connections: entries, totalPeople: contacts.length, totalItems: contacts.length };
  if (nextIndex < combined.length) {
    out.nextPageToken = mintKeyedToken(scope, syncId(combined[nextIndex]), syncKey(combined[nextIndex]));
  } else if (input.requestSyncToken === true) {
    out.nextSyncToken = mintSyncToken(caller.user.id, now);
  }
  return out;
}
