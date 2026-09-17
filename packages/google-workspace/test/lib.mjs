// Shared HTTP helpers and seeded identifiers for the conformance flows. Node built-ins only.
import assert from "node:assert/strict";

const BASE = process.env.FIREDRILL_HTTP_URL ?? "";
const TOKEN = process.env.FIREDRILL_HTTP_TOKEN ?? "";
assert.ok(BASE.length > 0, "FIREDRILL_HTTP_URL is required");
assert.ok(TOKEN.length > 0, "FIREDRILL_HTTP_TOKEN is required");

export const PEOPLE = "/people/v1";
export const EVENTS = "/workspaceevents/v1";
export const SCRIPT = "/script/v1";

const headers = (extra = {}) => ({ authorization: `Bearer ${TOKEN}`, ...extra });

/** Calls a provider-shaped route and returns { status, body, headers }. */
export async function api(method, path, { body, query, rawQuery, idempotencyKey } = {}) {
  // `rawQuery` is appended verbatim so a test can send broken percent-encoding, which the framework decodes
  // leniently into U+FFFD; URLSearchParams would escape it away.
  const url = new URL(`${BASE}${path}${rawQuery === undefined ? "" : `?${rawQuery}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const entry of value) url.searchParams.append(key, String(entry));
    else url.searchParams.set(key, String(value));
  }
  const init = { method, headers: headers(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }) };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let parsed = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { __raw: text.slice(0, 400) };
    }
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

/** Calls the canonical operation endpoint and returns the framework outcome envelope. */
export async function call(operationId, args, idempotencyKey) {
  const response = await fetch(`${BASE}/v1/operations/google-workspace/${operationId}`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ arguments: args, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }),
  });
  const text = await response.text();
  const parsed = text.length > 0 ? JSON.parse(text) : {};
  return { status: response.status, outcome: parsed.outcome ?? {}, body: parsed };
}

/** Calls an operation and requires it to succeed, returning the value. */
export async function ok(operationId, args, idempotencyKey) {
  const result = await call(operationId, args, idempotencyKey);
  assert.equal(result.outcome.status, "ok", `${operationId} should succeed: ${JSON.stringify(result.outcome).slice(0, 400)}`);
  return result.outcome.value;
}

/** Calls an operation and requires the named declared Tool error. */
export async function toolError(operationId, args, code) {
  const result = await call(operationId, args);
  assert.equal(result.outcome.status, "tool_error", `${operationId} should fail ${code}: ${JSON.stringify(result.outcome).slice(0, 400)}`);
  assert.equal(result.outcome.error?.code, `tool.${code}`, `${operationId} should fail with ${code}`);
  return result.outcome.error;
}

/** Asserts a provider-shaped response carries Google's error envelope with the expected status and canonical code. */
export function expectGoogleError(result, status, canonical, where) {
  assert.equal(result.status, status, `${where}: expected HTTP ${status}, got ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
  assert.ok(result.body?.error !== undefined, `${where}: response has no error member`);
  assert.equal(result.body.error.status, canonical, `${where}: expected status ${canonical}`);
  assert.equal(result.body.error.code, status, `${where}: error.code should mirror the HTTP status`);
  const detail = result.body.error.details?.[0];
  assert.equal(detail?.["@type"], "type.googleapis.com/google.rpc.ErrorInfo", `${where}: missing ErrorInfo detail`);
  assert.equal(detail.domain, "googleapis.com", `${where}: ErrorInfo domain`);
  assert.ok(typeof detail.reason === "string" && detail.reason.length > 0, `${where}: ErrorInfo reason`);
  return detail;
}

export const base64url = (value) => Buffer.from(value, "utf8").toString("base64url");

export const DOMAIN = "northwind-labs.example.com";
export const ADA = "114520000000000000001";
export const BRUNO = "114520000000000000002";
export const CHEN = "114520000000000000003";

export const GROUPS = {
  vendors: "0273af7970ed9ac1",
  prospects: "7e8f3ff584ed520a",
  conference: "fb9cc071a8fc1a33",
};

export const CONTACTS = {
  priya: "c3100000000000000001",
  tomas: "c3100000000000000002",
  ines: "c3100000000000000003",
  marcus: "c3100000000000000004",
  zoe: "c3100000000000000005",
  noName: "c3100000000000000013",
  kofi: "c3100000000000000014",
  brunoFirst: "c3100000000000000015",
  missing: "c3100000000000009999",
};

export const SUBSCRIPTIONS = {
  chatOps: "0a1b2c3d-0001-4d5e-8f60-000000000001",
  driveSuspended: "0a1b2c3d-0002-4d5e-8f60-000000000002",
  meetDeleted: "0a1b2c3d-0003-4d5e-8f60-000000000003",
  brunoVendor: "0a1b2c3d-0004-4d5e-8f60-000000000004",
  missing: "0a1b2c3d-9999-4d5e-8f60-000000009999",
};

export const OPERATIONS = { createChat: "op0000000000000001", createDrive: "op0000000000000002", missing: "op0000000000009999" };

export const SCRIPTS = {
  vendorSync: "1AIfMr8cmcD43lqyHRWD4lEbEcLf7oYxJ3xntqyRCfR3",
  onboarding: "1f6i_P_9WjS60VKBrZTwjb0ge-Kg2fL3cPDlZbYiQHId",
  legacy: "1_smwzBfFph9xFqPPhRdOSll5iJgwV99voVkGM_zeu-D",
  missing: "1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
};

export const DEPLOYMENT = "AKfycbmA_pk6UuUfnogsW54JDsVEdy2TXolW";

export const TARGETS = {
  chatOps: "//chat.googleapis.com/spaces/AAQA-northwind-ops",
  chatVendor: "//chat.googleapis.com/spaces/AAQA-vendor-desk",
  driveRunbook: "//drive.googleapis.com/files/1nwl-runbook",
  drivePrivate: "//drive.googleapis.com/files/1nwl-private",
  meetStandup: "//meet.googleapis.com/spaces/nwl-standup",
  unknown: "//chat.googleapis.com/spaces/AAQA-does-not-exist",
};

export const TOPIC = "projects/northwind-labs/topics/workspace-events";
export const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,memberships,metadata";

/** Every operation with a minimal argument set that passes input validation. */
export const EVERY_OPERATION = [
  ["people.get-contact", { resourceName: "people/me", personFields: "names" }],
  ["people.list-connections", { resourceName: "people/me", personFields: "names" }],
  ["people.create-contact", { person: { names: [{ givenName: "Probe", familyName: "Case" }] } }],
  ["people.update-contact", { resourceName: `people/${CONTACTS.priya}`, updatePersonFields: "names", person: { etag: "%x", names: [{ givenName: "Probe", familyName: "Case" }] } }],
  ["people.delete-contact", { resourceName: `people/${CONTACTS.priya}` }],
  ["people.search-contacts", { query: "priya", readMask: "names" }],
  ["other-contacts.list", { readMask: "names" }],
  ["contact-groups.list", {}],
  ["contact-groups.get", { resourceName: `contactGroups/${GROUPS.vendors}` }],
  ["contact-groups.create", { contactGroup: { name: "Probe group" } }],
  ["contact-groups.delete", { resourceName: `contactGroups/${GROUPS.conference}` }],
  ["contact-groups.modify-members", { resourceName: `contactGroups/${GROUPS.vendors}`, resourceNamesToAdd: [`people/${CONTACTS.kofi}`] }],
  ["subscriptions.create", { subscription: { targetResource: TARGETS.chatOps, eventTypes: ["google.workspace.chat.message.v1.created"], notificationEndpoint: { pubsubTopic: TOPIC } } }],
  ["subscriptions.list", { filter: 'event_types:"google.workspace.chat.message.v1.created"' }],
  ["subscriptions.get", { name: `subscriptions/${SUBSCRIPTIONS.chatOps}` }],
  ["subscriptions.delete", { name: `subscriptions/${SUBSCRIPTIONS.chatOps}` }],
  ["subscriptions.reactivate", { name: `subscriptions/${SUBSCRIPTIONS.driveSuspended}` }],
  ["operations.get", { name: `operations/${OPERATIONS.createChat}` }],
  ["script-projects.create", { title: "Probe project" }],
  ["script-projects.get", { scriptId: SCRIPTS.vendorSync }],
  ["script-projects.get-content", { scriptId: SCRIPTS.vendorSync }],
  ["script-projects.update-content", { scriptId: SCRIPTS.vendorSync, files: [{ name: "appsscript", type: "JSON", source: "{}" }] }],
  ["script-versions.create", { scriptId: SCRIPTS.vendorSync, description: "probe" }],
  ["deployments.create", { scriptId: SCRIPTS.vendorSync, deploymentConfig: { versionNumber: 2 } }],
  ["deployments.list", { scriptId: SCRIPTS.vendorSync }],
  ["scripts.run", { scriptId: SCRIPTS.vendorSync, function: "countContacts" }],
  ["processes.list", {}],
];
