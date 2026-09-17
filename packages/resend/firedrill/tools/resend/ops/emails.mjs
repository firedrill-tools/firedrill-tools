// Emails: synthetic send and batch send, list, get, reschedule and cancel.
import { checkIdempotencyKey, fail, newId, randomChars, requireUuid, resolveKey, scanAll } from "../lib/core.mjs";
import { present } from "../lib/check.mjs";
import { paginate } from "../lib/page.mjs";
import { utcDay, wireTime } from "../lib/time.mjs";
import { bounces, lastEvent, renderEmail, renderListItem, scheduleTime, validateSend } from "./email-model.mjs";

const STATUSES = ["delivered", "bounced", "scheduled", "canceled", "sent"];

function sendingDomain(context, key, fromDomain) {
  if (key.permission === "sending_access" && key.domainId !== null) {
    const allowed = context.state.get("domains", key.domainId);
    if (allowed === null || allowed.name !== fromDomain) {
      const label = allowed === null ? "its configured domain" : allowed.name;
      fail(context, "DOMAIN_NOT_VERIFIED", `This API key is restricted to send emails from ${label} only`);
    }
  }
  const index = context.state.get("domain-names", fromDomain);
  const domain = index === null ? null : context.state.get("domains", index.domainId);
  if (domain === null || domain.status !== "verified" || domain.capabilities.sending !== "enabled") {
    fail(context, "DOMAIN_NOT_VERIFIED", `The ${fromDomain} domain is not verified. Please, add and verify your domain.`);
  }
}

function reserveQuota(context, team, count) {
  const now = context.clock.nowUs();
  const today = utcDay(now);
  const usage = context.state.get("meta", "usage");
  const sent = usage !== null && usage.day === today ? usage.sent : 0;
  if (sent + count > team.dailyQuota) fail(context, "DAILY_QUOTA_EXCEEDED", "You have reached your daily email sending quota.");
  context.state.put("meta", "usage", { day: today, sent: sent + count });
}

function accept(context, key, email, batchId) {
  const id = newId(context, "emails");
  const nowUs = context.clock.nowUs();
  const { fromDomain, ...fields } = email;
  const immediate = email.scheduledAtUs === null;
  const status = immediate ? (bounces(email) ? "bounced" : "delivered") : "scheduled";
  const record = { id, ...fields, createdAtUs: nowUs, status, apiKeyId: key.id, batchId };
  context.state.put("emails", id, record);
  if (immediate) {
    const createdAt = wireTime(nowUs);
    context.events.emit("email.sent", { email_id: id, from: email.from, to: email.to, subject: email.subject, created_at: createdAt, batch_id: batchId });
    if (status === "bounced") {
      context.events.emit("email.bounced", { email_id: id, to: email.to, created_at: createdAt, bounce: { type: "Permanent", message: "Recipient address does not exist" } });
    } else {
      context.events.emit("email.delivered", { email_id: id, to: email.to, created_at: createdAt });
    }
  }
  return id;
}

function touchKey(context, key) {
  context.state.put("api-keys", key.id, { ...key, lastUsedAtUs: context.clock.nowUs() });
}

export function emailsSend(input, context) {
  const { key, team } = resolveKey(context, { send: true });
  checkIdempotencyKey(context, input);
  const email = validateSend(context, input);
  sendingDomain(context, key, email.fromDomain);
  reserveQuota(context, team, 1);
  const id = accept(context, key, email, null);
  touchKey(context, key);
  return { id };
}

export function emailsSendBatch(input, context) {
  const { key, team } = resolveKey(context, { send: true });
  checkIdempotencyKey(context, input);
  if (present(input.batchValidation)) fail(context, "VALIDATION_ERROR", "The `x-batch-validation: permissive` mode is not supported by this simulated service.");
  if (!Array.isArray(input.emails)) fail(context, "VALIDATION_ERROR", "The request body must be an array of emails.");
  if (input.emails.length === 0 || input.emails.length > 100) fail(context, "VALIDATION_ERROR", "A batch must contain between 1 and 100 emails.");
  const emails = input.emails.map((entry, index) => validateSend(context, entry, { batch: true, index }));
  for (const email of emails) sendingDomain(context, key, email.fromDomain);
  reserveQuota(context, team, emails.length);
  const hex = randomChars(context, "0123456789abcdef", 32);
  const batchId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const data = emails.map((email) => ({ id: accept(context, key, email, batchId) }));
  touchKey(context, key);
  return { data };
}

export function emailsList(input, context) {
  resolveKey(context);
  const nowUs = context.clock.nowUs();
  let query = null;
  if (present(input.query)) {
    if (input.query.length > 200 || input.query.includes("�")) fail(context, "VALIDATION_ERROR", "The `query` parameter is invalid.");
    query = input.query.trim().toLowerCase();
  }
  if (present(input.status) && !STATUSES.includes(input.status)) {
    fail(context, "VALIDATION_ERROR", `The \`status\` parameter must be one of: ${STATUSES.join(", ")}.`);
  }
  const rows = scanAll(context, "emails")
    .map((record) => record.value)
    .filter((email) => !present(input.status) || lastEvent(email, nowUs) === input.status)
    .filter((email) => query === null || email.subject.toLowerCase().includes(query) || email.to.some((to) => to.toLowerCase().includes(query)));
  return paginate(context, input, rows, (email) => renderListItem(email, nowUs));
}

function getEmail(context, rawId) {
  const id = requireUuid(context, rawId);
  const email = context.state.get("emails", id);
  if (email === null) fail(context, "NOT_FOUND", "Email not found");
  return email;
}

export function emailsGet(input, context) {
  resolveKey(context);
  return renderEmail(getEmail(context, input.id), context.clock.nowUs());
}

function pendingScheduled(context, email, verb) {
  if (lastEvent(email, context.clock.nowUs()) !== "scheduled") {
    fail(context, "VALIDATION_ERROR", `Email cannot be ${verb} because it is not scheduled`);
  }
}

export function emailsUpdate(input, context) {
  resolveKey(context);
  checkIdempotencyKey(context, input);
  const email = getEmail(context, input.id);
  if (!present(input.scheduledAt)) fail(context, "MISSING_REQUIRED_FIELD", "Missing `scheduled_at` field.");
  pendingScheduled(context, email, "updated");
  const scheduledAtUs = scheduleTime(context, input.scheduledAt);
  context.state.put("emails", email.id, { ...email, scheduledAtUs });
  return { object: "email", id: email.id };
}

export function emailsCancel(input, context) {
  resolveKey(context);
  checkIdempotencyKey(context, input);
  const email = getEmail(context, input.id);
  pendingScheduled(context, email, "canceled");
  context.state.put("emails", email.id, { ...email, status: "canceled" });
  return { object: "email", id: email.id };
}
