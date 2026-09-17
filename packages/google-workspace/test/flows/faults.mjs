// Fault and capacity flows: rate limiting, a write outage, a committed-but-lost create, and the object cap.
import assert from "node:assert/strict";
import {
  CONTACTS, EVENTS, EVERY_OPERATION, GROUPS, PEOPLE, PERSON_FIELDS, SCRIPT, SCRIPTS, TARGETS, TOPIC,
  api, call, expectGoogleError, ok, toolError,
} from "../lib.mjs";

const NEW_SUBSCRIPTION = {
  targetResource: TARGETS.meetStandup,
  eventTypes: ["google.workspace.meet.conference.v2.ended"],
  notificationEndpoint: { pubsubTopic: TOPIC },
  ttl: "3600s",
};

async function rateLimited() {
  const affected = [
    ["GET", `${PEOPLE}/people/me/connections`, { personFields: "names" }],
    ["GET", `${PEOPLE}/otherContacts`, { readMask: "names" }],
    ["GET", `${PEOPLE}/contactGroups`, {}],
    ["GET", `${EVENTS}/subscriptions`, { filter: 'event_types:"google.workspace.chat.message.v1.created"' }],
    ["GET", `${SCRIPT}/processes`, {}],
  ];
  for (const [method, path, query] of affected) {
    const result = await api(method, path, { query });
    const detail = expectGoogleError(result, 429, "RESOURCE_EXHAUSTED", `${path} under the rate-limit fault`);
    assert.equal(detail.reason, "RATE_LIMIT_EXCEEDED");
    assert.equal(result.headers.get("retry-after"), "30");
  }
  const searchError = await toolError("people.search-contacts", { query: "priya", readMask: "names" }, "RESOURCE_EXHAUSTED");
  assert.match(searchError.message, /Quota exceeded/);

  // Reads that are not rate limited still work, and nothing was written.
  const profile = await api("GET", `${PEOPLE}/people/me`, { query: { personFields: PERSON_FIELDS } });
  assert.equal(profile.status, 200);
  const contact = await api("GET", `${PEOPLE}/people/${CONTACTS.priya}`, { query: { personFields: "names" } });
  assert.equal(contact.status, 200);
}

async function writesUnavailable() {
  const beforeContact = await api("GET", `${PEOPLE}/people/${CONTACTS.priya}`, { query: { personFields: PERSON_FIELDS } });
  assert.equal(beforeContact.status, 200);
  const beforeContent = await api("GET", `${SCRIPT}/projects/${SCRIPTS.vendorSync}/content`);
  assert.equal(beforeContent.status, 200);

  const create = await api("POST", `${PEOPLE}/people:createContact`, { body: { names: [{ givenName: "Outage", familyName: "Probe" }] } });
  const detail = expectGoogleError(create, 503, "UNAVAILABLE", "create under the write outage");
  assert.equal(detail.reason, "BACKEND_UNAVAILABLE");
  assert.equal(create.headers.get("retry-after"), "5");

  expectGoogleError(
    await api("PATCH", `${PEOPLE}/people/${CONTACTS.priya}:updateContact`, {
      query: { updatePersonFields: "names" },
      body: { etag: beforeContact.body.etag, names: [{ givenName: "Outage" }] },
    }),
    503, "UNAVAILABLE", "update under the write outage",
  );
  expectGoogleError(await api("DELETE", `${PEOPLE}/people/${CONTACTS.priya}:deleteContact`), 503, "UNAVAILABLE", "delete under the write outage");
  expectGoogleError(
    await api("PUT", `${SCRIPT}/projects/${SCRIPTS.vendorSync}/content`, {
      body: { files: [{ name: "appsscript", type: "JSON", source: "{}" }] },
    }),
    503, "UNAVAILABLE", "content update under the write outage",
  );

  const afterContact = await api("GET", `${PEOPLE}/people/${CONTACTS.priya}`, { query: { personFields: PERSON_FIELDS } });
  assert.deepEqual(afterContact.body, beforeContact.body, "a failed write changes nothing");
  const afterContent = await api("GET", `${SCRIPT}/projects/${SCRIPTS.vendorSync}/content`);
  assert.deepEqual(afterContent.body, beforeContent.body, "a failed content update changes nothing");

  // Reads and other writes are unaffected by this fault.
  const group = await ok("contact-groups.create", { contactGroup: { name: "Outage day" } });
  assert.equal(group.memberCount, 0);
}

async function subscriptionCreateLost() {
  const before = await api("GET", `${EVENTS}/subscriptions`, { query: { filter: 'event_types:"google.workspace.meet.conference.v2.ended"' } });
  assert.deepEqual(before.body.subscriptions, []);

  const lost = await api("POST", `${EVENTS}/subscriptions`, { body: NEW_SUBSCRIPTION });
  const detail = expectGoogleError(lost, 500, "INTERNAL", "committed-but-lost create");
  assert.equal(detail.reason, "BACKEND_ERROR");

  // The subscription did land, which is exactly what makes the naive retry dangerous.
  const after = await api("GET", `${EVENTS}/subscriptions`, { query: { filter: 'event_types:"google.workspace.meet.conference.v2.ended"' } });
  assert.equal(after.body.subscriptions.length, 1, "the write committed before the caller saw the failure");
  const landed = after.body.subscriptions[0];
  assert.equal(landed.state, "ACTIVE");

  const retry = await api("POST", `${EVENTS}/subscriptions`, { body: NEW_SUBSCRIPTION });
  expectGoogleError(retry, 409, "ALREADY_EXISTS", "naive retry after a lost response");
  assert.match(retry.body.error.message, new RegExp(landed.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const stillOne = await api("GET", `${EVENTS}/subscriptions`, { query: { filter: 'event_types:"google.workspace.meet.conference.v2.ended"' } });
  assert.equal(stillOne.body.subscriptions.length, 1, "the retry did not create a second subscription");
}

async function objectCap() {
  // Reads keep working at the cap.
  const connections = await api("GET", `${PEOPLE}/people/me/connections`, { query: { personFields: "names" } });
  assert.equal(connections.status, 200);
  assert.equal(connections.body.totalPeople, 14);

  for (const [operationId, args] of [
    ["people.create-contact", { person: { names: [{ givenName: "Over", familyName: "Cap" }] } }],
    ["contact-groups.create", { contactGroup: { name: "Over cap" } }],
    ["subscriptions.create", { subscription: NEW_SUBSCRIPTION }],
    ["script-projects.create", { title: "Over cap" }],
    ["script-versions.create", { scriptId: SCRIPTS.vendorSync }],
    ["deployments.create", { scriptId: SCRIPTS.vendorSync, deploymentConfig: { versionNumber: 2 } }],
  ]) {
    const error = await toolError(operationId, args, "RESOURCE_EXHAUSTED");
    assert.equal(error.details?.reason, "SIMULATION_OBJECT_LIMIT", `${operationId} should name the simulation cap`);
  }

  const overHttp = await api("POST", `${SCRIPT}/projects`, { body: { title: "Over cap" } });
  const detail = expectGoogleError(overHttp, 429, "RESOURCE_EXHAUSTED", "create at the cap over HTTP");
  assert.equal(detail.reason, "SIMULATION_OBJECT_LIMIT");
  assert.equal(overHttp.headers.get("retry-after"), "30");
}

/** Past the cap every operation refuses before touching state, rather than answering a short result. */
async function overCapacity() {
  for (const [operationId, args] of EVERY_OPERATION) {
    const error = await toolError(operationId, args, "RESOURCE_EXHAUSTED");
    assert.equal(error.details?.reason, "SIMULATION_OBJECT_LIMIT", `${operationId} should refuse before scanning`);
  }
  const listed = await call("contact-groups.list", { pageSize: 5 });
  assert.equal(listed.outcome.status, "tool_error");
  assert.equal(listed.outcome.error.code, "tool.RESOURCE_EXHAUSTED");
  void GROUPS;
}

export const FLOWS = {
  "rate-limited": rateLimited,
  "writes-unavailable": writesUnavailable,
  "subscription-create-lost": subscriptionCreateLost,
  "object-cap": objectCap,
  "over-capacity": overCapacity,
};
