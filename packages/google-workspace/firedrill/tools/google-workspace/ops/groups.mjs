// contactGroups: list, get, create, delete and members:modify.
import { fail, invalid, notFound, outOfRange, precondition } from "../lib/errors.mjs";
import { SCOPES, requireScope } from "../lib/identity.mjs";
import { parseGroupFields } from "../lib/mask.mjs";
import { SYSTEM_GROUPS, isSystemGroup, parseContactGroupName, parsePersonName } from "../lib/names.mjs";
import { fillPage, mintKeyedToken, pageSize, resumeIndex } from "../lib/page.mjs";
import { renderGroup } from "../lib/render.mjs";
import { contactRowId, groupIdFor, groupRowId, memberRowId, reserveObjects, saveMeta, scanPrefix } from "../lib/store.mjs";
import { clip, fold, isMangled } from "../lib/util.mjs";
import { begin, loadContacts, loadGroups } from "./common.mjs";
import { MAX_MEMBERSHIPS, checkMembershipBound } from "./contact-fields.mjs";
import { removeContactRows } from "./contacts-write.mjs";

const PEOPLE = "people.googleapis.com";
const READ = [SCOPES.CONTACTS, SCOPES.CONTACTS_READONLY];
const WRITE = [SCOPES.CONTACTS];
const MAX_MODIFY = 1000;
const MAX_EVENTS = 50;

const orderGroups = (groups) => {
  const system = [];
  const user = [];
  for (const group of groups) (group.groupType === "SYSTEM_CONTACT_GROUP" ? system : user).push(group);
  system.sort((a, b) => SYSTEM_GROUPS.indexOf(a.groupId) - SYSTEM_GROUPS.indexOf(b.groupId));
  user.sort((a, b) => cmp(fold(a.name), fold(b.name)) || cmp(a.groupId, b.groupId));
  return [...system, ...user];
};
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** The sort key `orderGroups` orders by, carried in page tokens so a deleted anchor resumes at the next row. */
const groupSortKey = (group) =>
  group.groupType === "SYSTEM_CONTACT_GROUP"
    ? ["0", String(SYSTEM_GROUPS.indexOf(group.groupId)).padStart(2, "0"), group.groupId]
    : ["1", fold(group.name), group.groupId];

export function listGroups(input, context) {
  const { caller } = begin(context, input);
  requireScope(context, caller, READ, PEOPLE, "google.people.v1.ContactGroupsService.ListContactGroups");
  if (input.syncToken !== undefined) {
    invalid(context, "Sync tokens are not supported for contact groups by this Tool.", "UNSUPPORTED_PARAMETER");
  }
  const wanted = parseGroupFields(context, input.groupFields);
  const limit = pageSize(context, input.pageSize, 1, 1000, 30);
  const groups = orderGroups([...loadGroups(context, caller.user.id).values()]);

  const scope = `groups:${caller.user.id}`;
  const start = resumeIndex(context, input.pageToken, scope, groups, (group) => group.groupId, groupSortKey);

  const { entries, nextIndex } = fillPage(
    groups,
    start,
    limit,
    (group) => renderGroup(group, wanted),
    () => outOfRange(context, "A single contact group is larger than the maximum response size for this simulation."),
  );
  const out = { contactGroups: entries, totalItems: groups.length };
  if (nextIndex < groups.length) {
    out.nextPageToken = mintKeyedToken(scope, groups[nextIndex].groupId, groupSortKey(groups[nextIndex]));
  }
  return out;
}

export function getGroup(input, context) {
  const { caller } = begin(context, input);
  requireScope(context, caller, READ, PEOPLE, "google.people.v1.ContactGroupsService.GetContactGroup");
  const name = parseContactGroupName(context, input.resourceName);
  const wanted = parseGroupFields(context, input.groupFields);
  const maxMembers = input.maxMembers ?? 0;
  if (!Number.isInteger(maxMembers)) invalid(context, "maxMembers must be an integer.");
  if (maxMembers < 0 || maxMembers > 1000) outOfRange(context, "maxMembers must be between 0 and 1000.");

  const group = context.state.get("contact-groups", groupRowId(caller.user.id, name.id));
  if (group === null) notFound(context);
  let members;
  if (maxMembers > 0) {
    const rows = scanPrefix(context, "group-members", `${caller.user.id}:${name.id}:`);
    members = rows.slice(0, maxMembers).map((row) => `people/${row.rowId.slice(row.rowId.lastIndexOf(":") + 1)}`);
  }
  return renderGroup(group, wanted, members);
}

export function createGroup(input, context) {
  const { caller, meta } = begin(context, input);
  requireScope(context, caller, WRITE, PEOPLE, "google.people.v1.ContactGroupsService.CreateContactGroup");
  const body = input.contactGroup ?? {};
  const name = body.name;
  if (typeof name !== "string" || name.trim().length === 0) invalid(context, "A contact group needs a non-empty name.");
  if (isMangled(name)) invalid(context, "The contact group name contains characters that could not be decoded.");
  if (name.length > 120) invalid(context, "A contact group name accepts at most 120 characters.");
  if (isSystemGroup(name)) invalid(context, `"${clip(name, 60)}" is a reserved system group name.`);
  const wanted = parseGroupFields(context, input.readGroupFields);

  const groups = loadGroups(context, caller.user.id);
  const folded = fold(name.trim());
  for (const group of groups.values()) {
    if (group.groupType === "USER_CONTACT_GROUP" && fold(group.name) === folded) {
      fail(context, "ALREADY_EXISTS", `A contact group named "${clip(name, 60)}" already exists.`, "RESOURCE_ALREADY_EXISTS");
    }
  }

  let groupId = groupIdFor(meta.nextGroupId);
  let attempts = 0;
  while (groups.has(groupId) && attempts < 64) {
    meta.nextGroupId += 1;
    groupId = groupIdFor(meta.nextGroupId);
    attempts += 1;
  }
  const now = context.clock.nowUs();
  const row = {
    groupId,
    ownerUserId: caller.user.id,
    name: name.trim(),
    formattedName: name.trim(),
    groupType: "USER_CONTACT_GROUP",
    etagVersion: 1,
    createTimeUs: now,
    updateTimeUs: now,
    memberCount: 0,
  };
  reserveObjects(context, meta, 1);
  meta.nextGroupId += 1;
  context.state.put("contact-groups", groupRowId(caller.user.id, groupId), row);
  saveMeta(context, meta);
  return renderGroup(row, wanted);
}

export function deleteGroup(input, context) {
  const { caller, meta } = begin(context, input);
  requireScope(context, caller, WRITE, PEOPLE, "google.people.v1.ContactGroupsService.DeleteContactGroup");
  const name = parseContactGroupName(context, input.resourceName);
  if (name.system) precondition(context, "A system contact group cannot be deleted.", "SYSTEM_GROUP_IMMUTABLE");
  const rowId = groupRowId(caller.user.id, name.id);
  const group = context.state.get("contact-groups", rowId);
  if (group === null) notFound(context);

  const memberRows = scanPrefix(context, "group-members", `${caller.user.id}:${name.id}:`);
  const memberIds = memberRows.map((row) => row.rowId.slice(row.rowId.lastIndexOf(":") + 1));
  const contacts = loadContacts(context, caller.user.id);
  const groups = loadGroups(context, caller.user.id);
  const deleteContacts = input.deleteContacts === true;
  const now = context.clock.nowUs();
  let emitted = 0;

  for (const contactId of memberIds) {
    context.state.delete("group-members", memberRowId(caller.user.id, name.id, contactId));
    const contact = contacts.get(contactId);
    if (contact === undefined) continue;
    const remaining = contact.memberships.filter((id) => id !== name.id);
    const onlyGroup = remaining.length === 0 || (remaining.length === 1 && remaining[0] === "myContacts");
    if (deleteContacts && onlyGroup) {
      removeContactRows(context, caller.user.id, { ...contact, memberships: remaining }, groups, meta);
      if (emitted < MAX_EVENTS) {
        emitChanged(context, contact, "deleted", remaining);
        emitted += 1;
      }
    } else {
      context.state.put("contacts", contactRowId(caller.user.id, contactId), {
        ...contact,
        memberships: remaining,
        etagVersion: contact.etagVersion + 1,
        updateTimeUs: now,
      });
      if (emitted < MAX_EVENTS) {
        emitChanged(context, contact, "updated", remaining);
        emitted += 1;
      }
    }
  }

  context.state.delete("contact-groups", rowId);
  meta.objectCount = Math.max(0, meta.objectCount - 1);
  saveMeta(context, meta);
  if (memberIds.length > emitted) emitBulk(context, caller.user.id, memberIds.length);
  return {};
}

function emitChanged(context, contact, change, memberships) {
  context.events.emit("contact.changed", {
    resourceName: `people/${contact.contactId}`,
    contactId: contact.contactId,
    ownerUserId: contact.ownerUserId,
    change,
    displayName: contact.names?.[0]?.displayName ?? null,
    primaryEmail: contact.emailAddresses?.[0]?.value ?? null,
    groupIds: [...(memberships ?? contact.memberships ?? [])],
    changedAtUs: context.clock.nowUs(),
  });
}

function emitBulk(context, ownerUserId, count) {
  context.events.emit("contact.changed", {
    resourceName: "",
    contactId: "",
    ownerUserId,
    change: "bulk",
    displayName: null,
    primaryEmail: null,
    groupIds: [],
    changedAtUs: context.clock.nowUs(),
    affectedCount: count,
  });
}

export function modifyMembers(input, context) {
  const { caller, meta } = begin(context, input);
  requireScope(context, caller, WRITE, PEOPLE, "google.people.v1.ContactGroupsService.ModifyContactGroupMembers");
  const name = parseContactGroupName(context, input.resourceName);
  const toAdd = readIdList(context, input.resourceNamesToAdd, "resourceNamesToAdd");
  const toRemove = readIdList(context, input.resourceNamesToRemove, "resourceNamesToRemove");
  if (toAdd.length === 0 && toRemove.length === 0) {
    invalid(context, "At least one of resourceNamesToAdd or resourceNamesToRemove must be set.");
  }
  const removeSet = new Set(toRemove);
  for (const id of toAdd) {
    if (removeSet.has(id)) invalid(context, `Contact "people/${id}" appears in both resourceNamesToAdd and resourceNamesToRemove.`);
  }

  const group = context.state.get("contact-groups", groupRowId(caller.user.id, name.id));
  if (group === null) notFound(context);

  const contacts = loadContacts(context, caller.user.id);
  // Simulation bound, checked before any write so a request that would cross it fails whole and nothing is dropped.
  const overfull = toAdd.filter((contactId) => {
    const contact = contacts.get(contactId);
    return contact !== undefined && !contact.memberships.includes(name.id) && contact.memberships.length >= MAX_MEMBERSHIPS;
  });
  if (overfull.length > 0) checkMembershipBound(context, new Array(MAX_MEMBERSHIPS + 1), overfull.map((id) => `people/${id}`));
  const now = context.clock.nowUs();
  const notFoundNames = [];
  const cannotRemove = [];
  let delta = 0;
  let emitted = 0;
  let touched = 0;

  for (const contactId of toAdd) {
    const contact = contacts.get(contactId);
    if (contact === undefined) {
      notFoundNames.push(`people/${contactId}`);
      continue;
    }
    if (contact.memberships.includes(name.id)) continue;
    const memberships = [...contact.memberships, name.id];
    context.state.put("group-members", memberRowId(caller.user.id, name.id, contactId), { addTimeUs: now });
    writeMembership(context, caller.user.id, contact, memberships, now, contacts);
    delta += 1;
    touched += 1;
    if (emitted < MAX_EVENTS) {
      emitChanged(context, contact, "updated", memberships);
      emitted += 1;
    }
  }

  for (const contactId of toRemove) {
    const contact = contacts.get(contactId);
    if (contact === undefined) {
      notFoundNames.push(`people/${contactId}`);
      continue;
    }
    if (!contact.memberships.includes(name.id)) continue;
    const memberships = contact.memberships.filter((id) => id !== name.id);
    if (memberships.length === 0) {
      cannotRemove.push(`people/${contactId}`);
      continue;
    }
    context.state.delete("group-members", memberRowId(caller.user.id, name.id, contactId));
    writeMembership(context, caller.user.id, contact, memberships, now, contacts);
    delta -= 1;
    touched += 1;
    if (emitted < MAX_EVENTS) {
      emitChanged(context, contact, "updated", memberships);
      emitted += 1;
    }
  }

  if (delta !== 0) {
    context.state.put("contact-groups", groupRowId(caller.user.id, name.id), {
      ...group,
      memberCount: Math.max(0, group.memberCount + delta),
      etagVersion: group.etagVersion + 1,
      updateTimeUs: now,
    });
  }
  saveMeta(context, meta);
  if (touched > emitted) emitBulk(context, caller.user.id, touched);
  return { notFoundResourceNames: notFoundNames, canNotRemoveLastContactGroupResourceNames: cannotRemove };
}

function writeMembership(context, ownerUserId, contact, memberships, now, contacts) {
  const next = { ...contact, memberships, etagVersion: contact.etagVersion + 1, updateTimeUs: now };
  contacts.set(contact.contactId, next);
  context.state.put("contacts", contactRowId(ownerUserId, contact.contactId), next);
}

function readIdList(context, raw, field) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) invalid(context, `Field "${field}" must be an array.`);
  if (raw.length > MAX_MODIFY) invalid(context, `Field "${field}" accepts at most ${MAX_MODIFY} entries, got ${raw.length}.`);
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const parsed = parsePersonName(context, entry);
    if (parsed.kind !== "contact") invalid(context, `Field "${field}" accepts only private contacts (people/c…).`);
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    out.push(parsed.id);
  }
  return out;
}
