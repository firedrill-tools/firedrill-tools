// Team-wide contacts with segment membership (pairs in `segment-members` and `contact-segments`).
import { checkIdempotencyKey, fail, newId, normalizeUuid, requireUuid, resolveKey, scanAll } from "../lib/core.mjs";
import { parseAddress, present, safeObject } from "../lib/check.mjs";
import { paginate } from "../lib/page.mjs";
import { wireTime } from "../lib/time.mjs";
import { renderSegment } from "./keys-segments.mjs";

const PROPERTY_KEY = /^[a-z][a-z0-9_]{0,49}$/;

/** A bare e-mail address (no display name), lowercased, or `null`. */
function plainAddress(value) {
  if (typeof value !== "string") return null;
  const parsed = parseAddress(value);
  return parsed === null || parsed.address !== value.trim() ? null : parsed.address.toLowerCase();
}

function nameField(context, input, field, label) {
  if (!Object.hasOwn(input, field)) return undefined;
  const value = input[field];
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 100) fail(context, "VALIDATION_ERROR", `The \`${label}\` field must be at most 100 characters.`);
  return value;
}

function mergeProperties(context, base, patch) {
  const source = safeObject(context, patch, "properties", 20);
  const merged = { ...base };
  for (const key of Object.keys(source)) {
    const value = source[key];
    const ok = PROPERTY_KEY.test(key) && (value === null || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= 500));
    if (!ok) fail(context, "VALIDATION_ERROR", "Contact properties need lowercase keys and string (≤ 500 characters), number or null values.");
    merged[key] = value;
  }
  if (Object.keys(merged).length > 20) fail(context, "VALIDATION_ERROR", "A contact can hold at most 20 properties.");
  return merged;
}

function locate(context, input, idField) {
  const hasId = present(input[idField]);
  const hasEmail = present(input.email);
  if (hasId && hasEmail) fail(context, "INVALID_PARAMETER", `Provide either \`${idField === "id" ? "id" : "contact_id"}\` or \`email\`, not both.`);
  if (!hasId && !hasEmail) fail(context, "MISSING_REQUIRED_FIELD", "Missing `id` or `email` field.");
  let id;
  if (hasId) {
    id = requireUuid(context, input[idField], idField === "id" ? "id" : "contact_id");
  } else {
    const email = plainAddress(input.email);
    if (email === null) fail(context, "INVALID_PARAMETER", "The `email` must be a valid email address.");
    const index = context.state.get("contact-emails", email);
    if (index === null) fail(context, "NOT_FOUND", "Contact not found");
    id = index.contactId;
  }
  const contact = context.state.get("contacts", id);
  if (contact === null) fail(context, "NOT_FOUND", "Contact not found");
  return contact;
}

function locateSegment(context, raw) {
  if (!present(raw)) fail(context, "MISSING_REQUIRED_FIELD", "Missing `segment_id` field.");
  const id = requireUuid(context, raw, "segment_id");
  const segment = context.state.get("segments", id);
  if (segment === null) fail(context, "NOT_FOUND", "Segment not found");
  return segment;
}

function join(context, contactId, segmentId, nowUs) {
  context.state.put("segment-members", `${segmentId}/${contactId}`, { segmentId, contactId, addedAtUs: nowUs });
  context.state.put("contact-segments", `${contactId}/${segmentId}`, { segmentId, contactId });
}

function summary(contact) {
  return { id: contact.id, email: contact.email, first_name: contact.firstName, last_name: contact.lastName, created_at: wireTime(contact.createdAtUs), unsubscribed: contact.unsubscribed };
}

export function contactsCreate(input, context) {
  resolveKey(context);
  checkIdempotencyKey(context, input);
  if (!present(input.email)) fail(context, "MISSING_REQUIRED_FIELD", "Missing `email` field.");
  const email = plainAddress(input.email);
  if (email === null) fail(context, "VALIDATION_ERROR", "Invalid `email` field. The email address needs to follow the `email@example.com` format.");
  for (const [field, label] of [["topics", "topics"], ["audienceId", "audience_id"]]) {
    if (present(input[field])) fail(context, "VALIDATION_ERROR", `The \`${label}\` field is not supported by this simulated service.`);
  }
  const firstName = nameField(context, input, "firstName", "first_name") ?? null;
  const lastName = nameField(context, input, "lastName", "last_name") ?? null;
  const properties = present(input.properties) ? mergeProperties(context, {}, input.properties) : {};
  const segmentIds = [];
  if (present(input.segmentIds)) {
    if (!Array.isArray(input.segmentIds) || input.segmentIds.length > 20) fail(context, "VALIDATION_ERROR", "The `segments` field accepts at most 20 segments.");
    for (const raw of input.segmentIds) {
      const id = normalizeUuid(raw);
      if (id === null || context.state.get("segments", id) === null) fail(context, "VALIDATION_ERROR", "Every entry of `segments` must name an existing segment.");
      if (!segmentIds.includes(id)) segmentIds.push(id);
    }
  }
  if (context.state.get("contact-emails", email) !== null) fail(context, "VALIDATION_ERROR", "Contact already exists");
  const id = newId(context, "contacts");
  const nowUs = context.clock.nowUs();
  context.state.put("contacts", id, { id, email, firstName, lastName, unsubscribed: input.unsubscribed === true, properties, createdAtUs: nowUs });
  context.state.put("contact-emails", email, { contactId: id });
  for (const segmentId of segmentIds) join(context, id, segmentId, nowUs);
  return { object: "contact", id };
}

export function contactsList(input, context) {
  resolveKey(context);
  let query = null;
  if (present(input.query)) {
    if (input.query.length > 200 || input.query.includes("�")) fail(context, "VALIDATION_ERROR", "The `query` parameter is invalid.");
    query = input.query.trim().toLowerCase();
  }
  let rows;
  if (present(input.segmentId)) {
    const segment = locateSegment(context, input.segmentId);
    rows = scanAll(context, "segment-members", `${segment.id}/`).map((member) => context.state.get("contacts", member.value.contactId)).filter((contact) => contact !== null);
  } else {
    rows = scanAll(context, "contacts").map((record) => record.value);
  }
  if (query !== null) {
    rows = rows.filter((contact) => [contact.email, contact.firstName ?? "", contact.lastName ?? ""].some((text) => text.toLowerCase().includes(query)));
  }
  return paginate(context, input, rows, summary);
}

export function contactsGet(input, context) {
  resolveKey(context);
  const contact = locate(context, input, "id");
  return { object: "contact", ...summary(contact), properties: contact.properties };
}

export function contactsUpdate(input, context) {
  resolveKey(context);
  checkIdempotencyKey(context, input);
  const contact = locate(context, input, "id");
  const next = { ...contact };
  const firstName = nameField(context, input, "firstName", "first_name");
  const lastName = nameField(context, input, "lastName", "last_name");
  if (firstName !== undefined) next.firstName = firstName;
  if (lastName !== undefined) next.lastName = lastName;
  if (Object.hasOwn(input, "unsubscribed") && input.unsubscribed !== null) next.unsubscribed = input.unsubscribed === true;
  if (present(input.properties)) next.properties = mergeProperties(context, contact.properties, input.properties);
  if (present(input.newEmail)) {
    const email = plainAddress(input.newEmail);
    if (email === null) fail(context, "VALIDATION_ERROR", "Invalid `email` field. The email address needs to follow the `email@example.com` format.");
    if (email !== contact.email) {
      if (context.state.get("contact-emails", email) !== null) fail(context, "VALIDATION_ERROR", "Contact already exists");
      context.state.delete("contact-emails", contact.email);
      context.state.put("contact-emails", email, { contactId: contact.id });
      next.email = email;
    }
  }
  context.state.put("contacts", contact.id, next);
  return { object: "contact", id: contact.id };
}

export function contactsRemove(input, context) {
  resolveKey(context);
  checkIdempotencyKey(context, input);
  const contact = locate(context, input, "id");
  for (const link of scanAll(context, "contact-segments", `${contact.id}/`)) {
    context.state.delete("contact-segments", link.rowId);
    context.state.delete("segment-members", `${link.value.segmentId}/${contact.id}`);
  }
  context.state.delete("contact-emails", contact.email);
  context.state.delete("contacts", contact.id);
  return { object: "contact", id: contact.id, deleted: true };
}

export function contactsAddSegment(input, context) {
  resolveKey(context);
  checkIdempotencyKey(context, input);
  const contact = locate(context, input, "contactId");
  const segment = locateSegment(context, input.segmentId);
  if (context.state.get("contact-segments", `${contact.id}/${segment.id}`) === null) {
    join(context, contact.id, segment.id, context.clock.nowUs());
  }
  return { object: "contact_segment", contact_id: contact.id, segment_id: segment.id };
}

export function contactsRemoveSegment(input, context) {
  resolveKey(context);
  checkIdempotencyKey(context, input);
  const contact = locate(context, input, "contactId");
  const segment = locateSegment(context, input.segmentId);
  if (!context.state.delete("contact-segments", `${contact.id}/${segment.id}`)) {
    fail(context, "NOT_FOUND", "Contact is not a member of this segment");
  }
  context.state.delete("segment-members", `${segment.id}/${contact.id}`);
  return { object: "contact_segment", contact_id: contact.id, segment_id: segment.id, deleted: true };
}

export function contactsListSegments(input, context) {
  resolveKey(context);
  const contact = locate(context, input, "contactId");
  const rows = scanAll(context, "contact-segments", `${contact.id}/`)
    .map((link) => context.state.get("segments", link.value.segmentId))
    .filter((segment) => segment !== null);
  return paginate(context, input, rows, renderSegment);
}
