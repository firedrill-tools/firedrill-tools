// Email validation, the synthetic delivery rule and wire rendering shared by the email operations.
import { fail } from "../lib/core.mjs";
import { addressList, boundedString, parseAddress, present, rejectPresent, safeObject, utf8Bytes } from "../lib/check.mjs";
import { parseTimestamp, US_PER_DAY, wireTime } from "../lib/time.mjs";

const TAG = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_BODY_BYTES = 512_000;
export const MAX_SCHEDULE_US = 30 * US_PER_DAY;

/** A recipient in the reserved `.invalid` TLD makes the synthetic delivery bounce. */
export function bounces(record) {
  return [...record.to, ...record.cc, ...record.bcc].some((entry) => {
    const parsed = parseAddress(entry);
    return parsed !== null && (parsed.domain === "invalid" || parsed.domain.endsWith(".invalid"));
  });
}

/** `last_event` as a reader sees it at `nowUs`: a due scheduled email renders its synthetic outcome. */
export function lastEvent(record, nowUs) {
  if (record.status === "scheduled" && record.scheduledAtUs !== null && record.scheduledAtUs <= nowUs) {
    return bounces(record) ? "bounced" : "delivered";
  }
  return record.status;
}

export function scheduleTime(context, raw, field = "scheduled_at") {
  const at = parseTimestamp(raw);
  const now = context.clock.nowUs();
  if (at === null) fail(context, "VALIDATION_ERROR", `The \`${field}\` field must be an ISO 8601 timestamp with a time zone.`);
  if (at <= now) fail(context, "VALIDATION_ERROR", `The \`${field}\` field must be in the future.`);
  if (at > now + MAX_SCHEDULE_US) fail(context, "VALIDATION_ERROR", `The \`${field}\` field must be within 30 days.`);
  return at;
}

/** Validate one send input (canonical camelCase). `where` prefixes messages inside a batch. */
export function validateSend(context, input, { batch = false, index = 0 } = {}) {
  const at = batch ? `emails[${index}]: ` : "";
  const scoped = (code, message) => fail(context, code, at + message);
  if (typeof input !== "object" || input === null || Array.isArray(input)) scoped("VALIDATION_ERROR", "Each email must be an object.");
  rejectPresent({ fail: (o) => scoped(o.code, o.message) }, input, ["attachments", "template", "topicId"], (field) => `The \`${field}\` field is not supported by this simulated service.`);
  if (batch && present(input.scheduledAt)) scoped("VALIDATION_ERROR", "`scheduled_at` is not supported in batch");
  if (!present(input.from)) scoped("MISSING_REQUIRED_FIELD", "Missing `from` field.");
  const sender = parseAddress(input.from);
  if (sender === null) scoped("VALIDATION_ERROR", "Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.");
  const wrap = { fail: (o) => scoped(o.code, o.message) };
  const to = addressList(wrap, input.to, "to", { required: true });
  const cc = addressList(wrap, input.cc, "cc");
  const bcc = addressList(wrap, input.bcc, "bcc");
  const replyTo = addressList(wrap, input.replyTo, "reply_to");
  if (!present(input.subject)) scoped("MISSING_REQUIRED_FIELD", "Missing `subject` field.");
  boundedString(wrap, input.subject, "subject", { max: 998 });
  const html = typeof input.html === "string" && input.html.length > 0 ? input.html : null;
  const text = typeof input.text === "string" && input.text.length > 0 ? input.text : null;
  if (html === null && text === null) scoped("MISSING_REQUIRED_FIELD", "Missing `html` or `text` field.");
  for (const [name, body] of [["html", html], ["text", text]]) {
    if (body !== null && utf8Bytes(body) > MAX_BODY_BYTES) scoped("VALIDATION_ERROR", `The \`${name}\` field exceeds ${MAX_BODY_BYTES} bytes.`);
  }
  const headers = {};
  if (present(input.headers)) {
    const source = safeObject(wrap, input.headers, "headers", 30);
    for (const name of Object.keys(source)) {
      if (!/^[!-9;-~]{1,256}$/.test(name) || typeof source[name] !== "string" || source[name].length > 998) {
        scoped("VALIDATION_ERROR", "The `headers` field must map header names to string values.");
      }
      headers[name] = source[name];
    }
  }
  const tags = [];
  if (present(input.tags)) {
    if (!Array.isArray(input.tags) || input.tags.length > 10) scoped("VALIDATION_ERROR", "The `tags` field must be an array of at most 10 tags.");
    for (const tag of input.tags) {
      const ok = typeof tag === "object" && tag !== null && typeof tag.name === "string" && typeof tag.value === "string" && TAG.test(tag.name) && TAG.test(tag.value);
      if (!ok) scoped("VALIDATION_ERROR", "Tags should only contain ASCII letters, numbers, underscores, or dashes.");
      tags.push({ name: tag.name, value: tag.value });
    }
  }
  const scheduledAtUs = !batch && present(input.scheduledAt) ? scheduleTime(context, input.scheduledAt) : null;
  return { from: input.from.trim(), fromDomain: sender.domain, to, cc, bcc, replyTo, subject: input.subject, html, text, headers, tags, scheduledAtUs };
}

export function renderListItem(record, nowUs) {
  return {
    object: "email",
    id: record.id,
    to: record.to,
    from: record.from,
    created_at: wireTime(record.createdAtUs),
    subject: record.subject,
    bcc: record.bcc,
    cc: record.cc,
    reply_to: record.replyTo,
    last_event: lastEvent(record, nowUs),
    scheduled_at: wireTime(record.scheduledAtUs),
  };
}

export function renderEmail(record, nowUs) {
  const base = renderListItem(record, nowUs);
  return { ...base, html: record.html, text: record.text, tags: record.tags };
}
