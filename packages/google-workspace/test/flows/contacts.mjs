// Contact read, write and sync flows against the People API-shaped routes.
import assert from "node:assert/strict";
import {
  CONTACTS, GROUPS, PEOPLE, PERSON_FIELDS, api, base64url, call, expectGoogleError, ok, toolError,
} from "../lib.mjs";

const MASK = { personFields: PERSON_FIELDS };

async function contactsRead() {
  const me = await api("GET", `${PEOPLE}/people/me`, { query: MASK });
  assert.equal(me.status, 200);
  assert.equal(me.body.resourceName, "people/114520000000000000001");
  assert.equal(me.body.emailAddresses[0].value, "ada.okonkwo@northwind-labs.example.com");
  assert.equal(me.body.metadata.sources[0].type, "PROFILE");

  const contact = await api("GET", `${PEOPLE}/people/${CONTACTS.zoe}`, { query: MASK });
  assert.equal(contact.status, 200);
  assert.equal(contact.body.names[0].displayName, "Zoë Müller");
  assert.ok(contact.body.memberships.some((entry) => entry.contactGroupMembership.contactGroupId === GROUPS.vendors));

  const colleague = await api("GET", `${PEOPLE}/people/114520000000000000002`, { query: { personFields: "names,organizations,metadata" } });
  assert.equal(colleague.status, 200);
  assert.equal(colleague.body.metadata.sources[0].type, "DOMAIN_PROFILE");
  assert.equal(colleague.body.names[0].displayName, "Bruno Marek");

  expectGoogleError(await api("GET", `${PEOPLE}/people/${CONTACTS.missing}`, { query: MASK }), 404, "NOT_FOUND", "unknown contact");
  expectGoogleError(await api("GET", `${PEOPLE}/people/not-a-name`, { query: MASK }), 400, "INVALID_ARGUMENT", "malformed person id");
  expectGoogleError(await api("GET", `${PEOPLE}/people/me`, { query: { personFields: "nonsense" } }), 400, "INVALID_ARGUMENT", "unknown mask entry");
  expectGoogleError(await api("GET", `${PEOPLE}/people/me`, { query: { personFields: "" } }), 400, "INVALID_ARGUMENT", "empty mask");

  // Three pages of five, five and four over the fourteen seeded contacts, every contact exactly once.
  const seen = new Set();
  let pageToken;
  let pages = 0;
  let total = 0;
  do {
    const page = await api("GET", `${PEOPLE}/people/me/connections`, { query: { ...MASK, pageSize: 5, pageToken } });
    assert.equal(page.status, 200);
    assert.equal(page.body.totalPeople, 14);
    for (const person of page.body.connections) {
      assert.equal(seen.has(person.resourceName), false, `duplicate ${person.resourceName}`);
      seen.add(person.resourceName);
    }
    total += page.body.connections.length;
    pageToken = page.body.nextPageToken;
    pages += 1;
    assert.ok(pages <= 6, "connections paging did not terminate");
  } while (pageToken !== undefined);
  assert.equal(pages, 3);
  assert.equal(total, 14);

  const byFirstName = await api("GET", `${PEOPLE}/people/me/connections`, { query: { ...MASK, sortOrder: "FIRST_NAME_ASCENDING", pageSize: 3 } });
  assert.equal(byFirstName.status, 200);
  assert.equal(byFirstName.body.connections[0].names?.[0]?.givenName ?? "", "Daniel");

  expectGoogleError(
    await api("GET", `${PEOPLE}/people/me/connections`, { query: { ...MASK, pageToken: "not-a-token" } }),
    400, "INVALID_ARGUMENT", "forged page token",
  );
  expectGoogleError(
    await api("GET", `${PEOPLE}/people/me/connections`, { query: { ...MASK, pageSize: 5000 } }),
    400, "OUT_OF_RANGE", "page size out of range",
  );
  expectGoogleError(
    await api("GET", `${PEOPLE}/people/${CONTACTS.priya}/connections`, { query: MASK }),
    400, "INVALID_ARGUMENT", "connections of another person",
  );

  const search = await ok("people.search-contacts", { query: "zoe", readMask: "names,emailAddresses" });
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].person.names[0].displayName, "Zoë Müller");
  const byPhone = await ok("people.search-contacts", { query: "+1415", readMask: "names,phoneNumbers" });
  assert.equal(byPhone.results.length, 2, "both Brightloom numbers share the +1415 prefix");
  assert.deepEqual(await ok("people.search-contacts", { query: "   ", readMask: "names" }), {});
  assert.deepEqual((await ok("people.search-contacts", { query: "nothing-matches-this", readMask: "names" })).results, []);
  await toolError("people.search-contacts", { query: "zoe", readMask: "names", pageSize: 900 }, "OUT_OF_RANGE");
  await toolError("people.search-contacts", { query: "zoe", readMask: "notAField" }, "INVALID_ARGUMENT");

  const others = await api("GET", `${PEOPLE}/otherContacts`, { query: { readMask: "names,emailAddresses,metadata" } });
  assert.equal(others.status, 200);
  assert.equal(others.body.totalSize, 4);
  assert.equal(others.body.otherContacts[2].metadata.sources[0].type, "OTHER_CONTACT");
  expectGoogleError(await api("GET", `${PEOPLE}/otherContacts`, { query: { readMask: "organizations" } }), 400, "INVALID_ARGUMENT", "other-contact mask");
  expectGoogleError(await api("GET", `${PEOPLE}/otherContacts`, { query: { readMask: "names", pageSize: 0 - 3 } }), 400, "OUT_OF_RANGE", "other-contact page size");

  const firstGroups = await api("GET", `${PEOPLE}/contactGroups`, { query: { pageSize: 4 } });
  assert.equal(firstGroups.status, 200);
  assert.equal(firstGroups.body.totalItems, 7);
  assert.equal(firstGroups.body.contactGroups[0].name, "myContacts");
  assert.ok(firstGroups.body.nextPageToken !== undefined);
  const secondGroups = await api("GET", `${PEOPLE}/contactGroups`, { query: { pageToken: firstGroups.body.nextPageToken } });
  assert.equal(secondGroups.body.contactGroups.length, 3);
  expectGoogleError(await api("GET", `${PEOPLE}/contactGroups`, { query: { syncToken: "x" } }), 400, "INVALID_ARGUMENT", "group sync token");
  expectGoogleError(await api("GET", `${PEOPLE}/contactGroups`, { query: { pageSize: 99999 } }), 400, "OUT_OF_RANGE", "group page size");

  const vendors = await api("GET", `${PEOPLE}/contactGroups/${GROUPS.vendors}`, { query: { maxMembers: 3 } });
  assert.equal(vendors.status, 200);
  assert.equal(vendors.body.memberCount, 8);
  assert.equal(vendors.body.memberResourceNames.length, 3);
  const conference = await api("GET", `${PEOPLE}/contactGroups/${GROUPS.conference}`, { query: { maxMembers: 10 } });
  assert.equal(conference.body.memberCount, 0);
  assert.deepEqual(conference.body.memberResourceNames, []);
  expectGoogleError(await api("GET", `${PEOPLE}/contactGroups/00000000000000ff`), 404, "NOT_FOUND", "unknown group");
  expectGoogleError(await api("GET", `${PEOPLE}/contactGroups/${GROUPS.vendors}`, { query: { maxMembers: 9000 } }), 400, "OUT_OF_RANGE", "maxMembers");

  // A URL that is not a Google custom method is not an endpoint at all.
  expectGoogleError(await api("POST", `${PEOPLE}/people:batchGet`, { body: {} }), 404, "NOT_FOUND", "unsupported custom method");
}

async function contactsWrite() {
  const created = await api("POST", `${PEOPLE}/people:createContact`, {
    query: MASK,
    idempotencyKey: "gw-create-1",
    body: {
      names: [{ givenName: "Iris", familyName: "Vaughn" }],
      emailAddresses: [{ value: "iris.vaughn@brightloom-supply.example.com", type: "work" }],
      phoneNumbers: [{ value: "+1 415 555 0199", type: "mobile" }],
      organizations: [{ name: "Brightloom Supply", title: "Buyer" }],
      memberships: [{ contactGroupMembership: { contactGroupId: GROUPS.vendors } }],
    },
  });
  assert.equal(created.status, 200);
  const resourceName = created.body.resourceName;
  assert.ok(resourceName.startsWith("people/c"));
  assert.equal(created.body.names[0].displayName, "Iris Vaughn");

  const readBack = await api("GET", `${PEOPLE}/${resourceName}`, { query: MASK });
  assert.equal(readBack.status, 200);
  assert.equal(readBack.body.etag, created.body.etag);
  assert.equal(readBack.body.phoneNumbers[0].canonicalForm, "+14155550199");

  const contactId = resourceName.slice("people/".length);
  const updated = await api("PATCH", `${PEOPLE}/people/${contactId}:updateContact`, {
    query: { updatePersonFields: "organizations", ...MASK },
    body: { etag: created.body.etag, organizations: [{ name: "Brightloom Supply", title: "Senior buyer" }] },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.organizations[0].title, "Senior buyer");
  assert.notEqual(updated.body.etag, created.body.etag);
  assert.equal(updated.body.names[0].displayName, "Iris Vaughn", "unmasked fields must survive the update");

  const stale = await api("PATCH", `${PEOPLE}/people/${contactId}:updateContact`, {
    query: { updatePersonFields: "organizations" },
    body: { etag: created.body.etag, organizations: [{ name: "Brightloom Supply" }] },
  });
  expectGoogleError(stale, 400, "FAILED_PRECONDITION", "stale etag");
  expectGoogleError(
    await api("PATCH", `${PEOPLE}/people/${contactId}:updateContact`, { query: { updatePersonFields: "metadata" }, body: { etag: updated.body.etag } }),
    400, "INVALID_ARGUMENT", "immutable update mask",
  );
  expectGoogleError(
    await api("PATCH", `${PEOPLE}/people/${CONTACTS.missing}:updateContact`, { query: { updatePersonFields: "names" }, body: { etag: updated.body.etag, names: [{ givenName: "X" }] } }),
    404, "NOT_FOUND", "update unknown contact",
  );

  expectGoogleError(
    await api("POST", `${PEOPLE}/people:createContact`, { body: { etag: "%spoofed", names: [{ givenName: "Read", familyName: "Only" }] } }),
    400, "INVALID_ARGUMENT", "read-only field on create",
  );
  expectGoogleError(
    await api("POST", `${PEOPLE}/people:createContact`, { body: { names: [{ givenName: "Ghost", familyName: "Group" }], memberships: [{ contactGroupMembership: { contactGroupId: "00000000000000ff" } }] } }),
    404, "NOT_FOUND", "unknown membership group",
  );

  const group = await ok("contact-groups.create", { contactGroup: { name: "Renewals 2027" } }, "gw-group-1");
  assert.equal(group.groupType, "USER_CONTACT_GROUP");
  assert.equal(group.memberCount, 0);
  await toolError("contact-groups.create", { contactGroup: { name: "renewals 2027" } }, "ALREADY_EXISTS");
  await toolError("contact-groups.create", { contactGroup: { name: "  " } }, "INVALID_ARGUMENT");

  const groupId = group.resourceName.slice("contactGroups/".length);
  const modified = await api("POST", `${PEOPLE}/contactGroups/${groupId}/members:modify`, {
    body: { resourceNamesToAdd: [`people/${CONTACTS.priya}`, `people/${CONTACTS.tomas}`, `people/${CONTACTS.missing}`] },
  });
  assert.equal(modified.status, 200);
  assert.deepEqual(modified.body.notFoundResourceNames, [`people/${CONTACTS.missing}`]);
  const afterAdd = await api("GET", `${PEOPLE}/contactGroups/${groupId}`, { query: { maxMembers: 10 } });
  assert.equal(afterAdd.body.memberCount, 2);

  const removed = await api("POST", `${PEOPLE}/contactGroups/${groupId}/members:modify`, {
    body: { resourceNamesToRemove: [`people/${CONTACTS.tomas}`] },
  });
  assert.equal(removed.status, 200);
  assert.equal((await api("GET", `${PEOPLE}/contactGroups/${groupId}`)).body.memberCount, 1);

  expectGoogleError(
    await api("POST", `${PEOPLE}/contactGroups/${groupId}/members:modify`, { body: { resourceNamesToAdd: [`people/${CONTACTS.priya}`], resourceNamesToRemove: [`people/${CONTACTS.priya}`] } }),
    400, "INVALID_ARGUMENT", "id in both lists",
  );
  expectGoogleError(
    await api("POST", `${PEOPLE}/contactGroups/00000000000000ff/members:modify`, { body: { resourceNamesToAdd: [`people/${CONTACTS.priya}`] } }),
    404, "NOT_FOUND", "modify members of unknown group",
  );
  expectGoogleError(
    await api("POST", `${PEOPLE}/contactGroups/${groupId}/members:replace`, { body: { resourceNamesToAdd: [] } }),
    404, "NOT_FOUND", "unsupported members method",
  );

  // Removing a contact from its only group is reported, not performed.
  const lastGroup = await call("contact-groups.modify-members", {
    resourceName: "contactGroups/myContacts",
    resourceNamesToRemove: [`people/${CONTACTS.noName}`],
  });
  assert.equal(lastGroup.outcome.status, "ok");
  assert.deepEqual(lastGroup.outcome.value.canNotRemoveLastContactGroupResourceNames, [`people/${CONTACTS.noName}`]);

  // Simulation bound: a contact belongs to at most 16 groups. The request that would cross it fails whole,
  // before any write, so memberships, group-members rows and memberCount never diverge.
  const capIds = [];
  for (let n = 1; n <= 20; n += 1) {
    const priya = await api("GET", `${PEOPLE}/people/${CONTACTS.priya}`, { query: { personFields: "memberships" } });
    if (priya.body.memberships.length >= 16) break;
    const capGroup = await ok("contact-groups.create", { contactGroup: { name: `Cap ${String(n).padStart(2, "0")}` } });
    const capId = capGroup.resourceName.slice("contactGroups/".length);
    capIds.push(capId);
    assert.equal((await api("POST", `${PEOPLE}/contactGroups/${capId}/members:modify`, { body: { resourceNamesToAdd: [`people/${CONTACTS.priya}`] } })).status, 200);
  }
  const full = await api("GET", `${PEOPLE}/people/${CONTACTS.priya}`, { query: { personFields: "memberships" } });
  assert.equal(full.body.memberships.length, 16);
  const overflow = await ok("contact-groups.create", { contactGroup: { name: "Cap overflow" } });
  const overflowId = overflow.resourceName.slice("contactGroups/".length);
  const refused = await api("POST", `${PEOPLE}/contactGroups/${overflowId}/members:modify`, { body: { resourceNamesToAdd: [`people/${CONTACTS.priya}`, `people/${CONTACTS.tomas}`] } });
  expectGoogleError(refused, 400, "INVALID_ARGUMENT", "17th membership");
  assert.equal(refused.body.error.details[0].reason, "MEMBERSHIP_LIMIT_EXCEEDED");
  const overflowGroup = await api("GET", `${PEOPLE}/contactGroups/${overflowId}`, { query: { maxMembers: 10 } });
  assert.equal(overflowGroup.body.memberCount, 0, "a refused modify writes nothing, not even the other contact");
  assert.deepEqual(overflowGroup.body.memberResourceNames ?? [], []);
  assert.equal((await api("GET", `${PEOPLE}/people/${CONTACTS.priya}`, { query: { personFields: "memberships" } })).body.memberships.length, 16);
  for (const capId of capIds) assert.equal((await api("DELETE", `${PEOPLE}/contactGroups/${capId}`)).status, 200);
  assert.equal((await api("DELETE", `${PEOPLE}/contactGroups/${overflowId}`)).status, 200);

  // A page token whose anchor group was deleted between pages resumes at the next surviving group.
  const allGroups = await api("GET", `${PEOPLE}/contactGroups`, { query: { pageSize: 1000 } });
  const cursorIds = [];
  for (const suffix of ["1", "2", "3"]) {
    const made = await ok("contact-groups.create", { contactGroup: { name: `Zz cursor ${suffix}` } });
    cursorIds.push(made.resourceName.slice("contactGroups/".length));
  }
  const pageOne = await api("GET", `${PEOPLE}/contactGroups`, { query: { pageSize: allGroups.body.contactGroups.length + 1 } });
  assert.equal(pageOne.body.contactGroups.at(-1).name, "Zz cursor 1");
  assert.ok(pageOne.body.nextPageToken !== undefined);
  assert.equal((await api("DELETE", `${PEOPLE}/contactGroups/${cursorIds[1]}`)).status, 200);
  const pageTwo = await api("GET", `${PEOPLE}/contactGroups`, { query: { pageToken: pageOne.body.nextPageToken } });
  assert.equal(pageTwo.status, 200);
  assert.deepEqual(pageTwo.body.contactGroups.map((entry) => entry.name), ["Zz cursor 3"], "deleted anchor resumes at the next survivor");
  assert.equal(pageTwo.body.nextPageToken, undefined);
  for (const id of [cursorIds[0], cursorIds[2]]) assert.equal((await api("DELETE", `${PEOPLE}/contactGroups/${id}`)).status, 200);

  expectGoogleError(
    await api("POST", `${PEOPLE}/people:createContact`, { body: { names: [{ givenName: "Leap", familyName: "Day" }], birthdays: [{ date: { year: 2023, month: 2, day: 31 } }] } }),
    400, "INVALID_ARGUMENT", "impossible calendar birthday",
  );
  const leap = await api("POST", `${PEOPLE}/people:createContact`, { body: { names: [{ givenName: "Leap", familyName: "Day" }], birthdays: [{ date: { month: 2, day: 29 } }] }, query: { personFields: "birthdays,metadata" } });
  assert.equal(leap.status, 200, "a year-less February 29 birthday is valid");
  assert.equal(leap.body.metadata.sources[0].id, leap.body.resourceName.slice("people/c".length), "source id is the contact's own id");
  assert.equal((await api("DELETE", `${PEOPLE}/people/${leap.body.resourceName.slice("people/".length)}:deleteContact`)).status, 200);

  const deletedGroup = await api("DELETE", `${PEOPLE}/contactGroups/${GROUPS.conference}`);
  assert.equal(deletedGroup.status, 200);
  expectGoogleError(await api("GET", `${PEOPLE}/contactGroups/${GROUPS.conference}`), 404, "NOT_FOUND", "deleted group");
  expectGoogleError(await api("DELETE", `${PEOPLE}/contactGroups/starred`), 400, "FAILED_PRECONDITION", "system group delete");
  expectGoogleError(await api("DELETE", `${PEOPLE}/contactGroups/00000000000000ff`), 404, "NOT_FOUND", "unknown group delete");
  expectGoogleError(await api("DELETE", `${PEOPLE}/contactGroups/not-a-group-id`), 400, "INVALID_ARGUMENT", "malformed group id on delete");

  const deleted = await api("DELETE", `${PEOPLE}/people/${contactId}:deleteContact`);
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, {});
  expectGoogleError(await api("GET", `${PEOPLE}/${resourceName}`, { query: MASK }), 404, "NOT_FOUND", "deleted contact");
  expectGoogleError(await api("DELETE", `${PEOPLE}/people/${CONTACTS.missing}:deleteContact`), 404, "NOT_FOUND", "delete unknown contact");
  expectGoogleError(await api("DELETE", `${PEOPLE}/people/${contactId}:purgeContact`), 404, "NOT_FOUND", "unsupported delete method");
  await toolError("people.delete-contact", { resourceName: "people/me" }, "INVALID_ARGUMENT");
}

async function contactsSync() {
  let pageToken;
  let syncToken;
  for (let page = 0; page < 6; page += 1) {
    const result = await api("GET", `${PEOPLE}/people/me/connections`, {
      query: { ...MASK, pageSize: 10, pageToken, requestSyncToken: "true" },
    });
    assert.equal(result.status, 200);
    pageToken = result.body.nextPageToken;
    syncToken = result.body.nextSyncToken;
    if (pageToken === undefined) break;
  }
  assert.ok(typeof syncToken === "string" && syncToken.length > 0, "a sync token is returned on the last page");

  const before = await api("GET", `${PEOPLE}/people/me/connections`, { query: { ...MASK, syncToken } });
  assert.equal(before.status, 200);
  assert.equal(before.body.connections.length, 0, "nothing has changed since the token was minted");

  const created = await api("POST", `${PEOPLE}/people:createContact`, {
    body: { names: [{ givenName: "Sync", familyName: "Probe" }], emailAddresses: [{ value: "sync.probe@harborline.example.com" }] },
  });
  assert.equal(created.status, 200);

  const delta = await api("GET", `${PEOPLE}/people/me/connections`, { query: { ...MASK, syncToken } });
  assert.equal(delta.status, 200);
  assert.equal(delta.body.connections.length, 1);
  assert.equal(delta.body.connections[0].resourceName, created.body.resourceName);

  // A token minted before the retention floor cannot produce a complete delta.
  const expired = base64url(JSON.stringify({ v: 1, s: "sync", o: "114520000000000000001", t: 1740000000000000 }));
  const detail = expectGoogleError(
    await api("GET", `${PEOPLE}/people/me/connections`, { query: { ...MASK, syncToken: expired } }),
    400, "FAILED_PRECONDITION", "expired sync token",
  );
  assert.equal(detail.reason, "EXPIRED_SYNC_TOKEN");

  // A token that still covers the retained tombstone reports the seeded deletion.
  const retained = base64url(JSON.stringify({ v: 1, s: "sync", o: "114520000000000000001", t: 1789000000000000 }));
  const withDeleted = await api("GET", `${PEOPLE}/people/me/connections`, { query: { ...MASK, syncToken: retained } });
  assert.equal(withDeleted.status, 200);
  const tombstone = withDeleted.body.connections.find((entry) => entry.metadata?.deleted === true);
  assert.ok(tombstone !== undefined, "the retained tombstone is reported as deleted");
  assert.equal(tombstone.resourceName, "people/c3100000000000000099");

  expectGoogleError(
    await api("GET", `${PEOPLE}/people/me/connections`, { query: { ...MASK, syncToken, sortOrder: "LAST_NAME_ASCENDING" } }),
    400, "INVALID_ARGUMENT", "sync token with sort order",
  );
  expectGoogleError(
    await api("GET", `${PEOPLE}/people/me/connections`, { query: { ...MASK, syncToken: "%%%" } }),
    400, "INVALID_ARGUMENT", "malformed sync token",
  );
}

export const FLOWS = { "contacts-read": contactsRead, "contacts-write": contactsWrite, "contacts-sync": contactsSync };
