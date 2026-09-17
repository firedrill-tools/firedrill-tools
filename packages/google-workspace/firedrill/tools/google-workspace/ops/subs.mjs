// Google Workspace Events API v1: subscriptions create/list/get/delete/reactivate and operations.get.
import { fail, invalid, notFound, outOfRange, precondition } from "../lib/errors.mjs";
import { SCOPES, requireScope } from "../lib/identity.mjs";
import { etagVersion, parseOperationName, parseSubscriptionName } from "../lib/names.mjs";
import { fillPage, mintKeyedToken, pageSize, resumeIndex } from "../lib/page.mjs";
import { renderOperation, renderSubscription } from "../lib/render.mjs";
import { operationIdFor, releaseObjects, reserveObjects, resourceRowId, saveMeta, scanPrefix, subscriptionIdFor } from "../lib/store.mjs";
import { clip, isMangled, parseRfc3339 } from "../lib/util.mjs";
import { begin } from "./common.mjs";
import { matchesFilter, parseFilter } from "./subs-filter.mjs";

// Dry runs (validateOnly, or allowMissing on an absent subscription) never write an operations row, so they must not
// borrow the id the next real mutation will take. They answer these fixed synthetic names, which operations.get reports
// as NOT_FOUND rather than resolving to an unrelated operation later.
export const DRY_RUN_OPERATION_NAME = "operations/validate-only";
export const ALLOW_MISSING_OPERATION_NAME = "operations/allow-missing";

const EVENTS = "workspaceevents.googleapis.com";
const DEFAULT_TTL_US = 4 * 60 * 60 * 1000 * 1000;
const MAX_TTL_US = 7 * 24 * 60 * 60 * 1000 * 1000;

const PRODUCTS = new Map([
  ["//chat.googleapis.com/", { prefix: "google.workspace.chat.", scope: SCOPES.CHAT_SPACES_READONLY, label: "Chat" }],
  ["//drive.googleapis.com/", { prefix: "google.workspace.drive.", scope: SCOPES.DRIVE_READONLY, label: "Drive" }],
  ["//meet.googleapis.com/", { prefix: "google.workspace.meet.", scope: SCOPES.MEETINGS_SPACE_READONLY, label: "Meet" }],
]);

const TOPIC_RE = /^projects\/[a-z0-9-]{4,60}\/topics\/[A-Za-z0-9._~%+-]{3,120}$/;

function productOf(context, targetResource) {
  for (const [prefix, product] of PRODUCTS) {
    if (targetResource.startsWith(prefix)) return product;
  }
  return invalid(
    context,
    `Unsupported target resource "${clip(targetResource, 120)}"; it must name a Chat space, a Drive item or a Meet space.`,
    "INVALID_TARGET_RESOURCE",
  );
}

export function createSubscription(input, context) {
  const { caller, meta } = begin(context, input);
  const body = input.subscription ?? {};
  const targetResource = body.targetResource;
  if (typeof targetResource !== "string" || targetResource.length === 0) invalid(context, "subscription.targetResource is required.");
  if (isMangled(targetResource)) invalid(context, "subscription.targetResource contains characters that could not be decoded.");
  if (targetResource.length > 300) invalid(context, "subscription.targetResource accepts at most 300 characters.");
  const product = productOf(context, targetResource);
  requireScope(context, caller, [product.scope], EVENTS, "google.apps.events.subscriptions.v1.SubscriptionsService.CreateSubscription");

  const eventTypes = body.eventTypes;
  if (!Array.isArray(eventTypes) || eventTypes.length === 0) invalid(context, "subscription.eventTypes must list at least one event type.");
  if (eventTypes.length > 8) invalid(context, "subscription.eventTypes accepts at most 8 entries.");
  const types = [];
  for (const entry of eventTypes) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 120) invalid(context, "Each event type must be a non-empty string.");
    if (!entry.startsWith(product.prefix)) {
      invalid(context, `Event type "${clip(entry, 120)}" does not belong to ${product.label}; it must start with "${product.prefix}".`, "INVALID_EVENT_TYPE");
    }
    if (!types.includes(entry)) types.push(entry);
  }

  const endpoint = body.notificationEndpoint;
  if (endpoint === null || endpoint === undefined || typeof endpoint !== "object" || Array.isArray(endpoint)) {
    invalid(context, "subscription.notificationEndpoint is required.");
  }
  const topic = endpoint.pubsubTopic;
  if (typeof topic !== "string" || !TOPIC_RE.test(topic)) {
    invalid(context, `Invalid Pub/Sub topic "${clip(String(topic ?? ""), 120)}"; it must be "projects/<project>/topics/<topic>".`, "INVALID_PUBSUB_TOPIC");
  }

  let payloadOptions = null;
  if (body.payloadOptions !== undefined && body.payloadOptions !== null) {
    const options = body.payloadOptions;
    if (typeof options !== "object" || Array.isArray(options)) invalid(context, "subscription.payloadOptions must be an object.");
    const includeResource = options.includeResource === true;
    const fieldMask = options.fieldMask;
    if (fieldMask !== undefined && fieldMask !== null) {
      if (typeof fieldMask !== "string" || fieldMask.length > 300) invalid(context, "subscription.payloadOptions.fieldMask must be a string of at most 300 characters.");
      if (!includeResource && fieldMask.length > 0) invalid(context, "subscription.payloadOptions.fieldMask requires includeResource to be true.");
    }
    payloadOptions = { includeResource, fieldMask: typeof fieldMask === "string" ? fieldMask : "" };
  }

  const now = context.clock.nowUs();
  const { ttlUs, expireTimeUs } = parseExpiry(context, body, now);
  const resource = context.state.get("resource-members", resourceRowId(targetResource));
  if (resource === null || resource.exists !== true) notFound(context, `Target resource "${clip(targetResource, 120)}" was not found.`);
  if (!resource.memberUserIds.includes(caller.user.id)) {
    fail(context, "PERMISSION_DENIED", `The caller is not a member of "${clip(targetResource, 120)}".`, "IAM_PERMISSION_DENIED");
  }

  const existing = scanPrefix(context, "user-subscriptions", `${caller.user.id}:`);
  const wanted = [...types].sort().join(",");
  for (const row of existing) {
    if (row.value.targetResource !== targetResource) continue;
    const other = context.state.get("subscriptions", row.rowId.slice(row.rowId.indexOf(":") + 1));
    if (other === null) continue;
    if ([...other.eventTypes].sort().join(",") === wanted) {
      fail(
        context,
        "ALREADY_EXISTS",
        `A subscription for this target resource and these event types already exists: subscriptions/${other.subscriptionId}.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
  }

  const subscriptionId = subscriptionIdFor(meta.nextSubscriptionId);
  const row = {
    subscriptionId,
    uid: `${meta.nextSubscriptionId}`.padStart(12, "0"),
    ownerUserId: caller.user.id,
    authority: caller.user.primaryEmail,
    targetResource,
    eventTypes: types,
    payloadOptions,
    notificationEndpoint: { pubsubTopic: topic },
    state: "ACTIVE",
    suspensionReason: null,
    etagVersion: 1,
    reconciling: false,
    createTimeUs: now,
    updateTimeUs: now,
    expireTimeUs,
    ttlUs,
  };

  if (input.validateOnly === true) {
    return {
      name: DRY_RUN_OPERATION_NAME,
      metadata: { "@type": "type.googleapis.com/google.apps.events.subscriptions.v1.CreateSubscriptionMetadata" },
      done: true,
      response: { "@type": "type.googleapis.com/google.apps.events.subscriptions.v1.Subscription", ...renderSubscription(row) },
    };
  }

  reserveObjects(context, meta, 1);
  meta.nextSubscriptionId += 1;
  const operationId = operationIdFor(meta.nextOperationId);
  meta.nextOperationId += 1;
  context.state.put("subscriptions", subscriptionId, row);
  context.state.put("user-subscriptions", `${caller.user.id}:${subscriptionId}`, { targetResource, state: "ACTIVE" });
  context.state.put("operations", operationId, {
    operationId,
    ownerUserId: caller.user.id,
    done: true,
    metadataType: "type.googleapis.com/google.apps.events.subscriptions.v1.CreateSubscriptionMetadata",
    resultKind: "subscription",
    subscriptionId,
    errorCode: null,
    errorMessage: null,
    createTimeUs: now,
  });
  saveMeta(context, meta);
  emitState(context, row, "ACTIVE", null);
  return renderOperation(context.state.get("operations", operationId), row);
}

/**
 * The API takes either `ttl` (a duration from now) or `expireTime` (an absolute instant); both is an error.
 * Neither means the default ttl. Returns the stored duration and absolute expiry (null = never expires).
 */
function parseExpiry(context, body, now) {
  const hasTtl = body.ttl !== undefined && body.ttl !== null;
  const hasExpire = body.expireTime !== undefined && body.expireTime !== null;
  if (hasTtl && hasExpire) invalid(context, "Set either subscription.ttl or subscription.expireTime, not both.", "INVALID_TTL");
  if (!hasExpire) {
    const ttlUs = parseTtl(context, body.ttl);
    return { ttlUs, expireTimeUs: ttlUs === 0 ? null : now + ttlUs };
  }
  if (typeof body.expireTime !== "string") invalid(context, "subscription.expireTime must be an RFC 3339 timestamp.", "INVALID_EXPIRE_TIME");
  const at = parseRfc3339(body.expireTime);
  if (at === null) {
    invalid(
      context,
      `subscription.expireTime must be an RFC 3339 timestamp with an explicit UTC offset, for example 2026-09-17T09:00:00Z; got "${clip(body.expireTime, 60)}".`,
      "INVALID_EXPIRE_TIME",
    );
  }
  if (at <= now) invalid(context, "subscription.expireTime must be in the future.", "INVALID_EXPIRE_TIME");
  if (at - now > MAX_TTL_US) invalid(context, "subscription.expireTime must be at most 7 days from now.", "INVALID_EXPIRE_TIME");
  return { ttlUs: at - now, expireTimeUs: at };
}

function parseTtl(context, raw) {
  if (raw === undefined || raw === null) return DEFAULT_TTL_US;
  if (typeof raw !== "string" || !/^[0-9]{1,10}(\.[0-9]{1,9})?s$/.test(raw)) {
    invalid(context, `Invalid ttl "${clip(String(raw), 40)}"; it must be a duration such as "3600s".`, "INVALID_TTL");
  }
  const seconds = Number(raw.slice(0, -1));
  if (!Number.isFinite(seconds) || seconds < 0) invalid(context, "The ttl must not be negative.", "INVALID_TTL");
  if (seconds === 0) return 0; // Google's "never expires"
  const us = Math.round(seconds * 1000 * 1000);
  if (us > MAX_TTL_US) invalid(context, "The ttl must be at most 7 days (604800s), or 0 for a subscription that never expires.", "INVALID_TTL");
  return us;
}

function emitState(context, row, state, previousState) {
  context.events.emit("subscription.state-changed", {
    subscriptionName: `subscriptions/${row.subscriptionId}`,
    uid: row.uid,
    ownerUserId: row.ownerUserId,
    authority: row.authority,
    targetResource: row.targetResource,
    eventTypes: [...row.eventTypes],
    state,
    previousState,
    suspensionReason: row.suspensionReason ?? null,
    changedAtUs: context.clock.nowUs(),
  });
}

export function listSubscriptions(input, context) {
  const { caller } = begin(context, input);
  requireScope(
    context,
    caller,
    [SCOPES.CHAT_SPACES_READONLY, SCOPES.DRIVE_READONLY, SCOPES.MEETINGS_SPACE_READONLY],
    EVENTS,
    "google.apps.events.subscriptions.v1.SubscriptionsService.ListSubscriptions",
  );
  const clauses = parseFilter(context, input.filter);
  const limit = pageSize(context, input.pageSize, 1, 100, 50);

  const owned = scanPrefix(context, "user-subscriptions", `${caller.user.id}:`);
  const rows = [];
  for (const entry of owned) {
    const row = context.state.get("subscriptions", entry.rowId.slice(entry.rowId.indexOf(":") + 1));
    if (row !== null && matchesFilter(row, clauses)) rows.push(row);
  }
  rows.sort((a, b) => a.createTimeUs - b.createTimeUs || (a.subscriptionId < b.subscriptionId ? -1 : 1));

  const scope = `subscriptions:${caller.user.id}`;
  const subKey = (row) => [row.createTimeUs, row.subscriptionId];
  const start = resumeIndex(context, input.pageToken, scope, rows, (row) => row.subscriptionId, subKey);
  const { entries, nextIndex } = fillPage(
    rows,
    start,
    limit,
    renderSubscription,
    () => outOfRange(context, "A single subscription is larger than the maximum response size for this simulation."),
  );
  const out = { subscriptions: entries };
  if (nextIndex < rows.length) out.nextPageToken = mintKeyedToken(scope, rows[nextIndex].subscriptionId, subKey(rows[nextIndex]));
  return out;
}

function loadOwned(context, caller, name) {
  const subscriptionId = parseSubscriptionName(context, name);
  const row = context.state.get("subscriptions", subscriptionId);
  // Another user's subscription is invisible: 404, never 403, so existence is not revealed.
  if (row === null || row.ownerUserId !== caller.user.id) return { subscriptionId, row: null };
  return { subscriptionId, row };
}

export function getSubscription(input, context) {
  const { caller } = begin(context, input);
  requireScope(
    context,
    caller,
    [SCOPES.CHAT_SPACES_READONLY, SCOPES.DRIVE_READONLY, SCOPES.MEETINGS_SPACE_READONLY],
    EVENTS,
    "google.apps.events.subscriptions.v1.SubscriptionsService.GetSubscription",
  );
  const { row } = loadOwned(context, caller, input.name);
  if (row === null) notFound(context);
  return renderSubscription(row);
}

export function deleteSubscription(input, context) {
  const { caller, meta } = begin(context, input);
  const { subscriptionId, row } = loadOwned(context, caller, input.name);
  if (row === null) {
    if (input.allowMissing === true) {
      return {
        name: ALLOW_MISSING_OPERATION_NAME,
        metadata: { "@type": "type.googleapis.com/google.apps.events.subscriptions.v1.DeleteSubscriptionMetadata" },
        done: true,
        response: { "@type": "type.googleapis.com/google.protobuf.Empty" },
      };
    }
    notFound(context);
  }
  const product = productOf(context, row.targetResource);
  requireScope(context, caller, [product.scope], EVENTS, "google.apps.events.subscriptions.v1.SubscriptionsService.DeleteSubscription");

  if (input.etag !== undefined && input.etag !== null && String(input.etag).length > 0) {
    const version = etagVersion(String(input.etag), "subscription", subscriptionId);
    if (version === null || version !== row.etagVersion) {
      precondition(context, "The supplied etag does not match the current subscription etag.", "ETAG_MISMATCH");
    }
  }

  if (input.validateOnly === true) {
    return {
      name: DRY_RUN_OPERATION_NAME,
      metadata: { "@type": "type.googleapis.com/google.apps.events.subscriptions.v1.DeleteSubscriptionMetadata" },
      done: true,
      response: { "@type": "type.googleapis.com/google.protobuf.Empty" },
    };
  }

  const now = context.clock.nowUs();
  const operationId = operationIdFor(meta.nextOperationId);
  meta.nextOperationId += 1;
  context.state.delete("subscriptions", subscriptionId);
  context.state.delete("user-subscriptions", `${caller.user.id}:${subscriptionId}`);
  releaseObjects(meta, 1);
  context.state.put("operations", operationId, {
    operationId,
    ownerUserId: caller.user.id,
    done: true,
    metadataType: "type.googleapis.com/google.apps.events.subscriptions.v1.DeleteSubscriptionMetadata",
    resultKind: "empty",
    subscriptionId: null,
    errorCode: null,
    errorMessage: null,
    createTimeUs: now,
  });
  saveMeta(context, meta);
  emitState(context, row, "DELETED", row.state);
  return renderOperation(context.state.get("operations", operationId), null);
}

export function reactivateSubscription(input, context) {
  const { caller, meta } = begin(context, input);
  const { subscriptionId, row } = loadOwned(context, caller, input.name);
  if (row === null) notFound(context);
  const product = productOf(context, row.targetResource);
  requireScope(context, caller, [product.scope], EVENTS, "google.apps.events.subscriptions.v1.SubscriptionsService.ReactivateSubscription");

  if (row.state !== "SUSPENDED") {
    precondition(context, `Only a SUSPENDED subscription can be reactivated; this one is ${row.state}.`, "SUBSCRIPTION_NOT_SUSPENDED");
  }
  if (row.suspensionReason === "RESOURCE_DELETED") {
    precondition(
      context,
      "A subscription suspended because its target resource was deleted cannot be reactivated.",
      "SUBSCRIPTION_NOT_REACTIVATABLE",
    );
  }

  const now = context.clock.nowUs();
  const ttlUs = typeof row.ttlUs === "number" ? row.ttlUs : DEFAULT_TTL_US;
  const next = {
    ...row,
    state: "ACTIVE",
    suspensionReason: null,
    etagVersion: row.etagVersion + 1,
    updateTimeUs: now,
    expireTimeUs: ttlUs === 0 ? null : now + ttlUs,
  };
  const operationId = operationIdFor(meta.nextOperationId);
  meta.nextOperationId += 1;
  context.state.put("subscriptions", subscriptionId, next);
  context.state.put("user-subscriptions", `${caller.user.id}:${subscriptionId}`, { targetResource: row.targetResource, state: "ACTIVE" });
  context.state.put("operations", operationId, {
    operationId,
    ownerUserId: caller.user.id,
    done: true,
    metadataType: "type.googleapis.com/google.apps.events.subscriptions.v1.ReactivateSubscriptionMetadata",
    resultKind: "subscription",
    subscriptionId,
    errorCode: null,
    errorMessage: null,
    createTimeUs: now,
  });
  saveMeta(context, meta);
  emitState(context, next, "ACTIVE", "SUSPENDED");
  return renderOperation(context.state.get("operations", operationId), next);
}

export function getOperation(input, context) {
  const { caller } = begin(context, input);
  if (input.name === DRY_RUN_OPERATION_NAME || input.name === ALLOW_MISSING_OPERATION_NAME) {
    notFound(context, "Dry-run operations are not stored and cannot be retrieved.");
  }
  const operationId = parseOperationName(context, input.name);
  const row = context.state.get("operations", operationId);
  if (row === null) notFound(context);
  if (row.ownerUserId !== caller.user.id) {
    fail(context, "PERMISSION_DENIED", "The caller does not have permission to read this operation.", "IAM_PERMISSION_DENIED");
  }
  const subscription = row.subscriptionId === null || row.subscriptionId === undefined ? null : context.state.get("subscriptions", row.subscriptionId);
  return renderOperation(row, subscription);
}
