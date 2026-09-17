// People API writes: createContact, updateContact, deleteContact.
import { invalid, notFound, precondition } from "../lib/errors.mjs";
import { SCOPES, requireScope } from "../lib/identity.mjs";
import { parsePersonFields, parseUpdateMask } from "../lib/mask.mjs";
import { etagVersion, parsePersonName } from "../lib/names.mjs";
import { renderContact } from "../lib/render.mjs";
import { contactIdFor, contactRowId, groupRowId, memberRowId, releaseObjects, reserveObjects, saveMeta, scanPrefix } from "../lib/store.mjs";
import { begin, loadGroups } from "./common.mjs";
import {
  buildAddresses, buildBiography, buildBirthday, buildEmails, buildMemberships, buildNames, buildNicknames,
  buildOrganizations, buildPhones, buildUrls, buildUserDefined, deriveIndexes, rejectReadOnly, checkMembershipBound,
} from "./contact-fields.mjs";

const PEOPLE = "people.googleapis.com";
const WRITE_SCOPE = [SCOPES.CONTACTS];
const TOMBSTONE_CAP = 200;

const DEFAULT_MASK = "names,emailAddresses,phoneNumbers,organizations,memberships,metadata";

function readMask(context, raw) {
  return parsePersonFields(context, typeof raw === "string" && raw.trim().length > 0 ? raw : DEFAULT_MASK);
}

/** Emits the domain event a drill asserts on. */
function emitChanged(context, contact, change, display) {
  context.events.emit("contact.changed", {
    resourceName: `people/${contact.contactId}`,
    contactId: contact.contactId,
    ownerUserId: contact.ownerUserId,
    change,
    displayName: display ?? null,
    primaryEmail: contact.emailAddresses?.[0]?.value ?? null,
    groupIds: [...(contact.memberships ?? [])],
    changedAtUs: context.clock.nowUs(),
  });
}

/**
 * Builds the stored contact. `mask` null means "every field" (create); otherwise only the masked fields are
 * replaced and every other field keeps its stored value, which is exactly the API's update-mask semantics.
 */
function assemble(context, person, base, mask) {
  const next = { ...base };
  const apply = (maskField, storedField, build) => {
    if (mask !== null && !mask.has(maskField)) return;
    next[storedField] = build();
  };
  apply("names", "names", () => buildNames(context, person.names));
  apply("nicknames", "nicknames", () => buildNicknames(context, person.nicknames));
  apply("emailAddresses", "emailAddresses", () => buildEmails(context, person.emailAddresses));
  apply("phoneNumbers", "phoneNumbers", () => buildPhones(context, person.phoneNumbers));
  apply("organizations", "organizations", () => buildOrganizations(context, person.organizations));
  apply("addresses", "addresses", () => buildAddresses(context, person.addresses));
  apply("biographies", "biography", () => buildBiography(context, person.biographies));
  apply("birthdays", "birthday", () => buildBirthday(context, person.birthdays));
  apply("urls", "urls", () => buildUrls(context, person.urls));
  apply("userDefined", "userDefined", () => buildUserDefined(context, person.userDefined));
  return next;
}

/** Checks that every requested membership names a group the caller owns. */
function resolveMemberships(context, groups, requested) {
  const out = [];
  for (const id of requested) {
    if (!groups.has(id)) notFound(context, `Contact group "contactGroups/${id}" was not found.`);
    if (id !== "myContacts") out.push(id);
  }
  return out;
}

export function createContact(input, context) {
  const { caller, meta } = begin(context, input);
  requireScope(context, caller, WRITE_SCOPE, PEOPLE, "google.people.v1.PeopleService.CreateContact");
  const person = input.person ?? {};
  rejectReadOnly(context, person);
  const wanted = readMask(context, input.personFields);

  const requested = buildMemberships(context, person.memberships);
  const groups = loadGroups(context, caller.user.id);
  const memberships = resolveMemberships(context, groups, requested);
  checkMembershipBound(context, ["myContacts", ...memberships]);

  const now = context.clock.nowUs();
  const contactId = contactIdFor(meta.nextContactId);
  const base = {
    contactId,
    ownerUserId: caller.user.id,
    etagVersion: 1,
    createTimeUs: now,
    updateTimeUs: now,
    photoUrl: `https://lh3.googleusercontent.com/contacts/${contactId}`,
    memberships: ["myContacts", ...memberships],
  };
  const contact = assemble(context, person, base, null);
  if (contact.names.length === 0 && contact.emailAddresses.length === 0 && contact.phoneNumbers.length === 0) {
    invalid(context, "A contact needs at least one of names, emailAddresses or phoneNumbers.");
  }
  const derived = deriveIndexes(context, contact);
  contact.sortName = derived.sortName;
  contact.searchText = derived.searchText;

  reserveObjects(context, meta, 1);
  meta.nextContactId += 1;
  context.state.put("contacts", contactRowId(caller.user.id, contactId), contact);
  for (const groupId of contact.memberships) {
    context.state.put("group-members", memberRowId(caller.user.id, groupId, contactId), { addTimeUs: now });
    const group = groups.get(groupId);
    if (group !== undefined) {
      context.state.put("contact-groups", groupRowId(caller.user.id, groupId), { ...group, memberCount: group.memberCount + 1, updateTimeUs: now });
    }
  }
  saveMeta(context, meta);
  emitChanged(context, contact, "created", derived.displayName);
  return renderContact(contact, wanted);
}

export function updateContact(input, context) {
  const { caller, meta } = begin(context, input);
  requireScope(context, caller, WRITE_SCOPE, PEOPLE, "google.people.v1.PeopleService.UpdateContact");
  const name = parsePersonName(context, input.resourceName);
  if (name.kind !== "contact") invalid(context, "Only a private contact (people/c…) can be updated.");
  const mask = parseUpdateMask(context, input.updatePersonFields);
  const wanted = readMask(context, input.personFields);
  const person = input.person ?? {};

  const rowId = contactRowId(caller.user.id, name.id);
  const existing = context.state.get("contacts", rowId);
  if (existing === null) notFound(context);

  const supplied = person.etag;
  if (typeof supplied !== "string" || supplied.length === 0) {
    precondition(context, "Request must set person.etag to the etag of the person being updated.", "ETAG_MISSING");
  }
  const version = etagVersion(supplied, "contact", name.id);
  if (version === null || version !== existing.etagVersion) {
    precondition(context, "Request person.etag is different than the current person etag.", "ETAG_MISMATCH");
  }

  const groups = loadGroups(context, caller.user.id);
  const now = context.clock.nowUs();
  let memberships = existing.memberships;
  if (mask.has("memberships")) {
    const requested = buildMemberships(context, person.memberships);
    memberships = ["myContacts", ...resolveMemberships(context, groups, requested)];
    checkMembershipBound(context, memberships, [`people/${existing.contactId}`]);
  }

  const updated = assemble(context, person, { ...existing }, mask);
  updated.memberships = memberships;
  updated.etagVersion = existing.etagVersion + 1;
  updated.updateTimeUs = now;
  const derived = deriveIndexes(context, updated);
  updated.sortName = derived.sortName;
  updated.searchText = derived.searchText;

  if (mask.has("memberships")) {
    const before = new Set(existing.memberships);
    const after = new Set(memberships);
    for (const groupId of before) {
      if (after.has(groupId)) continue;
      context.state.delete("group-members", memberRowId(caller.user.id, groupId, name.id));
      adjustCount(context, groups, caller.user.id, groupId, -1, now);
    }
    for (const groupId of after) {
      if (before.has(groupId)) continue;
      context.state.put("group-members", memberRowId(caller.user.id, groupId, name.id), { addTimeUs: now });
      adjustCount(context, groups, caller.user.id, groupId, 1, now);
    }
  }

  context.state.put("contacts", rowId, updated);
  saveMeta(context, meta);
  emitChanged(context, updated, "updated", derived.displayName);
  return renderContact(updated, wanted);
}

function adjustCount(context, groups, ownerUserId, groupId, delta, now) {
  const group = groups.get(groupId);
  if (group === undefined) return;
  const next = { ...group, memberCount: Math.max(0, group.memberCount + delta), updateTimeUs: now };
  groups.set(groupId, next);
  context.state.put("contact-groups", groupRowId(ownerUserId, groupId), next);
}

export function deleteContact(input, context) {
  const { caller, meta } = begin(context, input);
  requireScope(context, caller, WRITE_SCOPE, PEOPLE, "google.people.v1.PeopleService.DeleteContact");
  const name = parsePersonName(context, input.resourceName);
  if (name.kind !== "contact") invalid(context, "Only a private contact (people/c…) can be deleted.");
  const rowId = contactRowId(caller.user.id, name.id);
  const existing = context.state.get("contacts", rowId);
  if (existing === null) notFound(context);

  const groups = loadGroups(context, caller.user.id);
  removeContactRows(context, caller.user.id, existing, groups, meta);
  saveMeta(context, meta);
  emitChanged(context, existing, "deleted", existing.names?.[0]?.displayName ?? null);
  return {};
}

/** Deletes a contact and its membership rows, writes the tombstone and keeps the retention floor honest. */
export function removeContactRows(context, ownerUserId, contact, groups, meta) {
  const now = context.clock.nowUs();
  for (const groupId of contact.memberships ?? []) {
    context.state.delete("group-members", memberRowId(ownerUserId, groupId, contact.contactId));
    adjustCount(context, groups, ownerUserId, groupId, -1, now);
  }
  context.state.delete("contacts", contactRowId(ownerUserId, contact.contactId));
  context.state.put("contact-tombstones", contactRowId(ownerUserId, contact.contactId), {
    contactId: contact.contactId,
    ownerUserId,
    deleteTimeUs: now,
  });
  releaseObjects(meta, 1);
  pruneTombstones(context, ownerUserId);
}

function pruneTombstones(context, ownerUserId) {
  const rows = scanPrefix(context, "contact-tombstones", `${ownerUserId}:`);
  if (rows.length <= TOMBSTONE_CAP) return;
  const sorted = [...rows].sort((a, b) => a.value.deleteTimeUs - b.value.deleteTimeUs);
  const drop = sorted.slice(0, rows.length - TOMBSTONE_CAP);
  let floor = 0;
  for (const row of drop) {
    context.state.delete("contact-tombstones", row.rowId);
    floor = Math.max(floor, row.value.deleteTimeUs);
  }
  const user = context.state.get("users", ownerUserId);
  if (user !== null && floor > (user.syncFloorUs ?? 0)) {
    context.state.put("users", ownerUserId, { ...user, syncFloorUs: floor });
  }
}
