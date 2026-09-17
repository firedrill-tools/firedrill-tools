// Google Workspace Events subscription flows.
import assert from "node:assert/strict";
import { EVENTS, OPERATIONS, SUBSCRIPTIONS, TARGETS, TOPIC, api, expectGoogleError, ok } from "../lib.mjs";

const CHAT_CREATED = "google.workspace.chat.message.v1.created";
const CHAT_UPDATED = "google.workspace.chat.message.v1.updated";

async function eventsSubscriptions() {
  const byType = await api("GET", `${EVENTS}/subscriptions`, { query: { filter: `event_types:"${CHAT_CREATED}"` } });
  assert.equal(byType.status, 200);
  assert.equal(byType.body.subscriptions.length, 1);
  assert.equal(byType.body.subscriptions[0].name, `subscriptions/${SUBSCRIPTIONS.chatOps}`);
  assert.equal(byType.body.subscriptions[0].authority, "ada.okonkwo@northwind-labs.example.com");

  const byTarget = await api("GET", `${EVENTS}/subscriptions`, { query: { filter: `target_resource="${TARGETS.driveRunbook}"` } });
  assert.equal(byTarget.body.subscriptions.length, 1);
  assert.equal(byTarget.body.subscriptions[0].state, "SUSPENDED");
  assert.equal(byTarget.body.subscriptions[0].suspensionReason, "USER_SCOPE_REVOKED");

  const both = await api("GET", `${EVENTS}/subscriptions`, {
    query: { filter: `event_types:"${CHAT_UPDATED}" AND target_resource="${TARGETS.chatOps}"` },
  });
  assert.equal(both.body.subscriptions.length, 1);
  const none = await api("GET", `${EVENTS}/subscriptions`, { query: { filter: 'event_types:"google.workspace.chat.reaction.v1.created"' } });
  assert.deepEqual(none.body.subscriptions, []);

  expectGoogleError(await api("GET", `${EVENTS}/subscriptions`), 400, "INVALID_ARGUMENT", "missing filter");
  expectGoogleError(await api("GET", `${EVENTS}/subscriptions`, { query: { filter: 'owner="x"' } }), 400, "INVALID_ARGUMENT", "unknown filter field");
  expectGoogleError(await api("GET", `${EVENTS}/subscriptions`, { query: { filter: 'event_types:"unbalanced' } }), 400, "INVALID_ARGUMENT", "unbalanced quote");
  expectGoogleError(
    await api("GET", `${EVENTS}/subscriptions`, { query: { filter: `event_types:"${CHAT_CREATED}"`, pageSize: 400 } }),
    400, "OUT_OF_RANGE", "subscription page size",
  );

  const got = await api("GET", `${EVENTS}/subscriptions/${SUBSCRIPTIONS.chatOps}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.payloadOptions.includeResource, true);
  assert.equal(got.body.notificationEndpoint.pubsubTopic, TOPIC);
  expectGoogleError(await api("GET", `${EVENTS}/subscriptions/${SUBSCRIPTIONS.missing}`), 404, "NOT_FOUND", "unknown subscription");
  expectGoogleError(await api("GET", `${EVENTS}/subscriptions/nope`), 400, "INVALID_ARGUMENT", "malformed subscription name");
  expectGoogleError(await api("GET", `${EVENTS}/subscriptions/${SUBSCRIPTIONS.brunoVendor}`), 404, "NOT_FOUND", "another user's subscription");

  const newSubscription = {
    targetResource: TARGETS.meetStandup,
    eventTypes: ["google.workspace.meet.conference.v2.ended"],
    notificationEndpoint: { pubsubTopic: "projects/northwind-labs/topics/meet-events" },
    ttl: "3600s",
  };
  const dryRun = await api("POST", `${EVENTS}/subscriptions`, { query: { validateOnly: "true" }, body: newSubscription });
  assert.equal(dryRun.status, 200);
  assert.equal(dryRun.body.done, true);
  assert.equal(dryRun.body.response.state, "ACTIVE");
  assert.equal(dryRun.body.name, "operations/validate-only", "a dry run never borrows the next real operation id");
  expectGoogleError(await api("GET", `${EVENTS}/operations/validate-only`), 404, "NOT_FOUND", "dry-run operation is not stored");
  const listedAfterDryRun = await api("GET", `${EVENTS}/subscriptions`, { query: { filter: 'event_types:"google.workspace.meet.conference.v2.ended"' } });
  assert.deepEqual(listedAfterDryRun.body.subscriptions, [], "validateOnly must not persist");

  const created = await api("POST", `${EVENTS}/subscriptions`, { body: newSubscription, idempotencyKey: "gw-sub-1" });
  assert.equal(created.status, 200);
  assert.equal(created.body.metadata["@type"], "type.googleapis.com/google.apps.events.subscriptions.v1.CreateSubscriptionMetadata");
  assert.equal(created.body.response["@type"], "type.googleapis.com/google.apps.events.subscriptions.v1.Subscription");
  const createdName = created.body.response.name;
  const createdEtag = created.body.response.etag;
  assert.ok(typeof created.body.response.expireTime === "string");

  const duplicate = await api("POST", `${EVENTS}/subscriptions`, { body: newSubscription });
  expectGoogleError(duplicate, 409, "ALREADY_EXISTS", "duplicate subscription");

  expectGoogleError(
    await api("POST", `${EVENTS}/subscriptions`, { body: { ...newSubscription, targetResource: TARGETS.drivePrivate, eventTypes: ["google.workspace.drive.file.v3.contentUpdated"] } }),
    403, "PERMISSION_DENIED", "target the caller is not a member of",
  );
  expectGoogleError(
    await api("POST", `${EVENTS}/subscriptions`, { body: { ...newSubscription, targetResource: TARGETS.unknown, eventTypes: [CHAT_CREATED] } }),
    404, "NOT_FOUND", "unknown target resource",
  );
  expectGoogleError(
    await api("POST", `${EVENTS}/subscriptions`, { body: { ...newSubscription, eventTypes: [CHAT_CREATED] } }),
    400, "INVALID_ARGUMENT", "event type from another product",
  );
  expectGoogleError(
    await api("POST", `${EVENTS}/subscriptions`, { body: { ...newSubscription, notificationEndpoint: { pubsubTopic: "not-a-topic" } } }),
    400, "INVALID_ARGUMENT", "malformed Pub/Sub topic",
  );
  // `expireTime` is the absolute alternative to `ttl`; either may be set, never both.
  const withExpire = { ...newSubscription, eventTypes: ["google.workspace.meet.participant.v2.joined"], ttl: undefined, expireTime: "2026-09-17T09:00:00Z" };
  const expireDryRun = await api("POST", `${EVENTS}/subscriptions`, { query: { validateOnly: "true" }, body: withExpire });
  assert.equal(expireDryRun.status, 200);
  assert.equal(expireDryRun.body.response.expireTime, "2026-09-17T09:00:00.000000Z");
  expectGoogleError(
    await api("POST", `${EVENTS}/subscriptions`, { body: { ...newSubscription, expireTime: "2026-09-17T09:00:00Z" } }),
    400, "INVALID_ARGUMENT", "ttl and expireTime together",
  );
  expectGoogleError(
    await api("POST", `${EVENTS}/subscriptions`, { body: { ...withExpire, expireTime: "2026-09-17 09:00:00" } }),
    400, "INVALID_ARGUMENT", "zone-less expireTime",
  );
  expectGoogleError(
    await api("POST", `${EVENTS}/subscriptions`, { body: { ...withExpire, expireTime: "2020-01-01T00:00:00Z" } }),
    400, "INVALID_ARGUMENT", "expireTime in the past",
  );
  expectGoogleError(
    await api("POST", `${EVENTS}/subscriptions`, { body: { ...newSubscription, ttl: "999999s" } }),
    400, "INVALID_ARGUMENT", "ttl beyond seven days",
  );

  const reactivated = await api("POST", `${EVENTS}/subscriptions/${SUBSCRIPTIONS.driveSuspended}:reactivate`, { body: {} });
  assert.equal(reactivated.status, 200);
  assert.equal(reactivated.body.response.state, "ACTIVE");
  assert.equal(reactivated.body.response.suspensionReason, undefined);
  expectGoogleError(
    await api("POST", `${EVENTS}/subscriptions/${SUBSCRIPTIONS.meetDeleted}:reactivate`, { body: {} }),
    400, "FAILED_PRECONDITION", "reactivating a RESOURCE_DELETED subscription",
  );
  expectGoogleError(
    await api("POST", `${EVENTS}/subscriptions/${SUBSCRIPTIONS.missing}:reactivate`, { body: {} }),
    404, "NOT_FOUND", "reactivating an unknown subscription",
  );
  expectGoogleError(
    await api("POST", `${EVENTS}/subscriptions/${SUBSCRIPTIONS.chatOps}:suspend`, { body: {} }),
    404, "NOT_FOUND", "unsupported subscription method",
  );
  expectGoogleError(
    await api("POST", `${EVENTS}/subscriptions/bad-name:reactivate`, { body: {} }),
    400, "INVALID_ARGUMENT", "malformed name on reactivate",
  );

  const createdId = createdName.slice("subscriptions/".length);
  expectGoogleError(
    await api("DELETE", `${EVENTS}/subscriptions/${createdId}`, { query: { etag: "%bogus" } }),
    400, "FAILED_PRECONDITION", "delete with a stale etag",
  );
  const deleted = await api("DELETE", `${EVENTS}/subscriptions/${createdId}`, { query: { etag: createdEtag } });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.response["@type"], "type.googleapis.com/google.protobuf.Empty");
  expectGoogleError(await api("DELETE", `${EVENTS}/subscriptions/${createdId}`), 404, "NOT_FOUND", "delete twice");
  expectGoogleError(await api("DELETE", `${EVENTS}/subscriptions/not-a-name`), 400, "INVALID_ARGUMENT", "malformed name on delete");
  const tolerated = await api("DELETE", `${EVENTS}/subscriptions/${createdId}`, { query: { allowMissing: "true" } });
  assert.equal(tolerated.status, 200);
  assert.equal(tolerated.body.name, "operations/allow-missing");
  expectGoogleError(await api("GET", `${EVENTS}/operations/allow-missing`), 404, "NOT_FOUND", "allow-missing operation is not stored");

  const seededOperation = await api("GET", `${EVENTS}/operations/${OPERATIONS.createChat}`);
  assert.equal(seededOperation.status, 200);
  assert.equal(seededOperation.body.done, true);
  assert.equal(seededOperation.body.response.name, `subscriptions/${SUBSCRIPTIONS.chatOps}`);
  const freshOperation = await api("GET", `${EVENTS}/${created.body.name}`);
  assert.equal(freshOperation.status, 200);
  expectGoogleError(await api("GET", `${EVENTS}/operations/${OPERATIONS.missing}`), 404, "NOT_FOUND", "unknown operation");
  expectGoogleError(await api("GET", `${EVENTS}/operations/not-an-operation`), 400, "INVALID_ARGUMENT", "malformed operation name");
}

async function eventsIsolation() {
  // Bruno sees only his own subscription, and Ada's operation is not readable by him.
  const listed = await api("GET", `${EVENTS}/subscriptions`, { query: { filter: `event_types:"${CHAT_CREATED}"` } });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.subscriptions.length, 1);
  assert.equal(listed.body.subscriptions[0].name, `subscriptions/${SUBSCRIPTIONS.brunoVendor}`);

  const own = await api("GET", `${EVENTS}/subscriptions/${SUBSCRIPTIONS.brunoVendor}`);
  assert.equal(own.status, 200);
  assert.equal(own.body.authority, "bruno.marek@northwind-labs.example.com");
  expectGoogleError(await api("GET", `${EVENTS}/subscriptions/${SUBSCRIPTIONS.chatOps}`), 404, "NOT_FOUND", "Ada's subscription is invisible");
  expectGoogleError(await api("GET", `${EVENTS}/operations/${OPERATIONS.createChat}`), 403, "PERMISSION_DENIED", "Ada's operation");
  expectGoogleError(
    await api("POST", `${EVENTS}/subscriptions/${SUBSCRIPTIONS.driveSuspended}:reactivate`, { body: {} }),
    404, "NOT_FOUND", "reactivating Ada's subscription",
  );

  const created = await ok("subscriptions.create", {
    subscription: {
      targetResource: TARGETS.chatVendor,
      eventTypes: [CHAT_UPDATED],
      notificationEndpoint: { pubsubTopic: "projects/northwind-labs/topics/vendor-desk" },
      ttl: "0s",
    },
  });
  assert.equal(created.response.expireTime, undefined, "ttl 0s means the subscription never expires");
  const deleted = await ok("subscriptions.delete", { name: created.response.name });
  assert.equal(deleted.done, true);
}

export const FLOWS = { "events-subscriptions": eventsSubscriptions, "events-isolation": eventsIsolation };
