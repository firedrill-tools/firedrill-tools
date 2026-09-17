// Identity and authorisation flows: fresh install, an empty user, an unknown address, scope subsets, no grants.
import assert from "node:assert/strict";
import {
  CONTACTS, EVERY_OPERATION, GROUPS, PEOPLE, PERSON_FIELDS, SCRIPTS, call, ok, toolError,
} from "../lib.mjs";
import { api, expectGoogleError } from "../lib.mjs";

const PEOPLE_OPERATIONS = new Set([
  "people.get-contact", "people.list-connections", "people.create-contact", "people.update-contact",
  "people.delete-contact", "people.search-contacts", "other-contacts.list", "contact-groups.list",
  "contact-groups.get", "contact-groups.create", "contact-groups.delete", "contact-groups.modify-members",
]);
const EVENT_OPERATIONS = new Set([
  "subscriptions.create", "subscriptions.list", "subscriptions.get", "subscriptions.delete", "subscriptions.reactivate",
]);
const SCRIPT_OPERATIONS = new Set([
  "script-projects.create", "script-projects.get", "script-projects.get-content", "script-projects.update-content",
  "script-versions.create", "deployments.create", "deployments.list", "scripts.run", "processes.list",
]);

/** An actor with no provider attributes must see the seeded account, not an empty one. */
async function freshInstall() {
  const profile = await ok("people.get-contact", { resourceName: "people/me", personFields: PERSON_FIELDS });
  assert.equal(profile.resourceName, "people/114520000000000000001");
  assert.equal(profile.emailAddresses[0].value, "ada.okonkwo@northwind-labs.example.com");

  const connections = await ok("people.list-connections", { resourceName: "people/me", personFields: "names" });
  assert.equal(connections.totalPeople, 14, "a fresh actor sees the seeded contacts");

  const groups = await ok("contact-groups.list", {});
  assert.equal(groups.totalItems, 7);
  const subscriptions = await ok("subscriptions.list", { filter: 'event_types:"google.workspace.chat.message.v1.created"' });
  assert.equal(subscriptions.subscriptions.length, 1);
  const project = await ok("script-projects.get", { scriptId: SCRIPTS.vendorSync });
  assert.equal(project.title, "Vendor invoice sync");

  const created = await ok("people.create-contact", { person: { names: [{ givenName: "Fresh", familyName: "Actor" }] } });
  const readBack = await ok("people.get-contact", { resourceName: created.resourceName, personFields: "names" });
  assert.equal(readBack.names[0].displayName, "Fresh Actor");
}

/** Chen owns nothing: the Tool reports the real, empty state instead of inventing data. */
async function emptyUser() {
  const connections = await ok("people.list-connections", { resourceName: "people/me", personFields: "names" });
  assert.deepEqual(connections.connections, []);
  assert.equal(connections.totalPeople, 0);

  const groups = await ok("contact-groups.list", {});
  assert.deepEqual(groups.contactGroups, [], "no implicit system groups are fabricated for a user who has none");
  assert.equal(groups.totalItems, 0);

  const others = await ok("other-contacts.list", { readMask: "names" });
  assert.deepEqual(others.otherContacts, []);
  const search = await ok("people.search-contacts", { query: "priya", readMask: "names" });
  assert.deepEqual(search.results, []);
  const subscriptions = await ok("subscriptions.list", { filter: 'event_types:"google.workspace.chat.message.v1.created"' });
  assert.deepEqual(subscriptions.subscriptions, []);
  const processes = await ok("processes.list", {});
  assert.deepEqual(processes.processes, []);

  // Ada's private records are not visible, and existence is not revealed.
  await toolError("people.get-contact", { resourceName: `people/${CONTACTS.priya}`, personFields: "names" }, "NOT_FOUND");
  await toolError("contact-groups.get", { resourceName: `contactGroups/${GROUPS.vendors}` }, "NOT_FOUND");
  const profile = await ok("people.get-contact", { resourceName: "people/me", personFields: "names,emailAddresses" });
  assert.equal(profile.emailAddresses[0].value, "chen.wei@northwind-labs.example.com", "the address is matched case-insensitively");
}

/** An address with no `users` row fails UNAUTHENTICATED on every operation. */
async function unknownUser() {
  for (const [operationId, args] of EVERY_OPERATION) {
    await toolError(operationId, args, "UNAUTHENTICATED");
  }
  const overHttp = await api("GET", `${PEOPLE}/people/me`, { query: { personFields: "names" } });
  const detail = expectGoogleError(overHttp, 401, "UNAUTHENTICATED", "unknown address over HTTP");
  assert.equal(detail.metadata.service, "people.googleapis.com");
}

/** Read-only scopes: reads succeed, every write is refused with Google's scope reason. */
async function readonlyScopes() {
  const connections = await ok("people.list-connections", { resourceName: "people/me", personFields: "names" });
  assert.equal(connections.totalPeople, 14);
  const project = await ok("script-projects.get", { scriptId: SCRIPTS.vendorSync });
  assert.equal(project.title, "Vendor invoice sync");

  for (const [operationId, args] of [
    ["people.create-contact", { person: { names: [{ givenName: "No", familyName: "Scope" }] } }],
    ["people.update-contact", { resourceName: `people/${CONTACTS.priya}`, updatePersonFields: "names", person: { etag: "%x", names: [{ givenName: "No" }] } }],
    ["people.delete-contact", { resourceName: `people/${CONTACTS.priya}` }],
    ["contact-groups.create", { contactGroup: { name: "Blocked" } }],
    ["contact-groups.delete", { resourceName: `contactGroups/${GROUPS.conference}` }],
    ["contact-groups.modify-members", { resourceName: `contactGroups/${GROUPS.vendors}`, resourceNamesToAdd: [`people/${CONTACTS.kofi}`] }],
    ["script-projects.create", { title: "Blocked" }],
    ["script-projects.update-content", { scriptId: SCRIPTS.vendorSync, files: [{ name: "appsscript", type: "JSON", source: "{}" }] }],
  ]) {
    const error = await toolError(operationId, args, "PERMISSION_DENIED");
    assert.equal(error.details?.reason, "ACCESS_TOKEN_SCOPE_INSUFFICIENT", `${operationId} should name the missing scope`);
    assert.ok(typeof error.details?.metadata?.method === "string", `${operationId} should name the RPC method`);
  }

  // A colleague's directory profile needs the directory scope this token does not carry.
  const denied = await toolError("people.get-contact", { resourceName: "people/114520000000000000002", personFields: "names" }, "PERMISSION_DENIED");
  assert.equal(denied.details.metadata.service, "people.googleapis.com");
}

/** Apps Script scopes only: every People and Workspace Events operation is refused. */
async function scopedScript() {
  for (const [operationId, args] of EVERY_OPERATION) {
    if (!PEOPLE_OPERATIONS.has(operationId) && !EVENT_OPERATIONS.has(operationId)) continue;
    await toolError(operationId, args, "PERMISSION_DENIED");
  }
  const project = await ok("script-projects.get", { scriptId: SCRIPTS.vendorSync });
  assert.equal(project.scriptId, SCRIPTS.vendorSync);
  const processes = await ok("processes.list", {});
  assert.ok(Array.isArray(processes.processes));
}

/** The contacts scope only: every Workspace Events and Apps Script operation is refused. */
async function scopedContacts() {
  for (const [operationId, args] of EVERY_OPERATION) {
    if (!EVENT_OPERATIONS.has(operationId) && !SCRIPT_OPERATIONS.has(operationId)) continue;
    await toolError(operationId, args, "PERMISSION_DENIED");
  }
  const connections = await ok("people.list-connections", { resourceName: "people/me", personFields: "names" });
  assert.equal(connections.totalPeople, 14);
  const created = await ok("people.create-contact", { person: { names: [{ givenName: "Scoped", familyName: "Contacts" }] } });
  assert.ok(created.resourceName.startsWith("people/c"));
}

/** No operation grants: the framework refuses before behavior runs. */
async function denied() {
  for (const [operationId, args] of EVERY_OPERATION) {
    const result = await call(operationId, args);
    assert.equal(result.outcome.status, "denied", `${operationId} should be denied without a grant`);
  }
  const overHttp = await api("GET", `${PEOPLE}/people/me`, { query: { personFields: "names" } });
  expectGoogleError(overHttp, 403, "PERMISSION_DENIED", "ungranted operation over HTTP");
}

export const FLOWS = {
  "fresh-install": freshInstall,
  "empty-user": emptyUser,
  "unknown-user": unknownUser,
  "readonly-scopes": readonlyScopes,
  "scoped-script": scopedScript,
  "scoped-contacts": scopedContacts,
  denied,
};
