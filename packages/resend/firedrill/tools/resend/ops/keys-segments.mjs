// API keys (token revealed once, never stored), segments, and the app's workspace context.
import { checkIdempotencyKey, fail, newId, normalizeUuid, randomChars, requireUuid, resolveKey, scanAll } from "../lib/core.mjs";
import { present } from "../lib/check.mjs";
import { paginate } from "../lib/page.mjs";
import { isoTime, utcDay, wireTime } from "../lib/time.mjs";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function apiKeysCreate(input, context) {
  resolveKey(context);
  checkIdempotencyKey(context, input);
  if (!present(input.name)) fail(context, "MISSING_REQUIRED_FIELD", "Missing `name` field.");
  if (input.name.length > 50) fail(context, "VALIDATION_ERROR", "The `name` field must be at most 50 characters.");
  const permission = input.permission ?? "full_access";
  if (permission !== "full_access" && permission !== "sending_access") {
    fail(context, "VALIDATION_ERROR", "The `permission` field must be `full_access` or `sending_access`.");
  }
  let domainId = null;
  if (present(input.domainId)) {
    if (permission !== "sending_access") fail(context, "VALIDATION_ERROR", "The `domain_id` field requires `sending_access` permission.");
    domainId = normalizeUuid(input.domainId);
    if (domainId === null || context.state.get("domains", domainId) === null) fail(context, "VALIDATION_ERROR", "The `domain_id` field must name an existing domain.");
  }
  const id = newId(context, "apiKeys");
  const secret = randomChars(context, BASE62, 32);
  context.state.put("api-keys", id, {
    id, name: input.name, permission, domainId, tokenPreview: `re_${secret.slice(0, 6)}`, createdAtUs: context.clock.nowUs(), lastUsedAtUs: null,
  });
  return { id, token: `re_${secret}` };
}

export function apiKeysList(input, context) {
  resolveKey(context);
  const rows = scanAll(context, "api-keys").map((record) => record.value);
  return paginate(context, input, rows, (key) => ({ id: key.id, name: key.name, created_at: wireTime(key.createdAtUs), last_used_at: wireTime(key.lastUsedAtUs) }));
}

export function apiKeysRemove(input, context) {
  const { team } = resolveKey(context);
  checkIdempotencyKey(context, input);
  const id = requireUuid(context, input.id);
  if (context.state.get("api-keys", id) === null) fail(context, "NOT_FOUND", "API key not found");
  // The team's default key is the identity of actors without `resendApiKeyId`; removing it would lock them out.
  if (id === team.defaultApiKeyId) fail(context, "VALIDATION_ERROR", "The team's default API key cannot be removed in this simulated service.");
  context.state.delete("api-keys", id);
  return { object: "api_key", id, deleted: true };
}

export function segmentsCreate(input, context) {
  resolveKey(context);
  checkIdempotencyKey(context, input);
  if (!present(input.name)) fail(context, "MISSING_REQUIRED_FIELD", "Missing `name` field.");
  if (input.name.length > 100) fail(context, "VALIDATION_ERROR", "The `name` field must be at most 100 characters.");
  for (const field of ["filter", "audienceId"]) {
    if (present(input[field])) fail(context, "VALIDATION_ERROR", `The \`${field === "filter" ? "filter" : "audience_id"}\` field is not supported by this simulated service.`);
  }
  const id = newId(context, "segments");
  context.state.put("segments", id, { id, name: input.name, createdAtUs: context.clock.nowUs() });
  return { object: "segment", id, name: input.name };
}

export function renderSegment(segment) {
  return { id: segment.id, name: segment.name, created_at: wireTime(segment.createdAtUs) };
}

export function segmentsList(input, context) {
  resolveKey(context);
  const rows = scanAll(context, "segments").map((record) => record.value);
  return paginate(context, input, rows, renderSegment);
}

export function segmentsRemove(input, context) {
  resolveKey(context);
  checkIdempotencyKey(context, input);
  const id = requireUuid(context, input.id);
  if (context.state.get("segments", id) === null) fail(context, "NOT_FOUND", "Segment not found");
  for (const member of scanAll(context, "segment-members", `${id}/`)) {
    context.state.delete("segment-members", member.rowId);
    context.state.delete("contact-segments", `${member.value.contactId}/${id}`);
  }
  context.state.delete("segments", id);
  return { object: "segment", id, deleted: true };
}

export function workspaceContext(input, context) {
  const { key, team } = resolveKey(context, { send: true });
  const now = context.clock.nowUs();
  const usage = context.state.get("meta", "usage");
  const today = utcDay(now);
  const sentToday = usage !== null && usage.day === today ? usage.sent : 0;
  return {
    now: isoTime(now),
    today,
    team: { name: team.name, plan: team.plan, dailyQuota: team.dailyQuota, sentToday },
    apiKey: { id: key.id, name: key.name, permission: key.permission, domainId: key.domainId },
  };
}
