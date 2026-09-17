// Record ⇄ canonical summary ⇄ Gmail REST resource conversions and the Gmail error envelope.
// Pure functions: no state access, so the HTTP codecs can use them.
import { byteLength, encodeText, isoDay } from "./mime.mjs";

/** Canonical message summary (Google MCP `Message` shape plus REST-oriented extras). */
export function summarize(record, full) {
  const headers = record.headers;
  const summary = {
    id: record.id,
    threadId: record.threadId,
    labelIds: [...record.labelIds],
    snippet: record.snippet,
    historyId: String(record.historyId),
    internalDate: record.internalDate,
    sizeEstimate: record.sizeEstimate,
    date: isoDay(record.internalDate),
    rfc2822Date: headers.date,
    subject: headers.subject,
    sender: headers.from,
    ...(headers.fromName !== undefined ? { senderName: headers.fromName } : {}),
    toRecipients: [...headers.to],
    ccRecipients: [...headers.cc],
    bccRecipients: [...headers.bcc],
    messageIdHeader: headers.messageId,
    ...(headers.inReplyTo !== undefined ? { inReplyTo: headers.inReplyTo } : {}),
    references: [...headers.references],
    hasHtml: record.body.html !== undefined,
    attachmentCount: record.attachments.length,
  };
  if (full) {
    summary.plaintextBody = record.body.text;
    if (record.body.html !== undefined) summary.htmlBody = record.body.html;
    summary.attachmentIds = record.attachments.map((attachment) => attachment.attachmentId);
    summary.attachments = record.attachments.map((attachment) => ({
      id: attachment.attachmentId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
    }));
  }
  return summary;
}

/** REST `Message` with `format=minimal`, straight from a stored record. */
export function minimalMessage(record) {
  return {
    id: record.id,
    threadId: record.threadId,
    labelIds: [...record.labelIds],
    snippet: record.snippet,
    historyId: String(record.historyId),
    internalDate: record.internalDate,
    sizeEstimate: record.sizeEstimate,
  };
}

function fromHeader(summary) {
  return summary.senderName ? `${summary.senderName} <${summary.sender}>` : summary.sender;
}

function structureType(summary) {
  if (summary.attachmentCount > 0) return "multipart/mixed";
  if (summary.hasHtml) return "multipart/alternative";
  return "text/plain";
}

function headerList(summary, wanted) {
  const type = structureType(summary);
  const headers = [
    { name: "From", value: fromHeader(summary) },
    { name: "To", value: summary.toRecipients.join(", ") },
  ];
  if (summary.ccRecipients.length > 0) headers.push({ name: "Cc", value: summary.ccRecipients.join(", ") });
  if (summary.bccRecipients.length > 0) headers.push({ name: "Bcc", value: summary.bccRecipients.join(", ") });
  headers.push(
    { name: "Subject", value: summary.subject },
    { name: "Date", value: summary.rfc2822Date },
    { name: "Message-ID", value: summary.messageIdHeader },
  );
  if (summary.inReplyTo !== undefined) headers.push({ name: "In-Reply-To", value: summary.inReplyTo });
  if (summary.references.length > 0) headers.push({ name: "References", value: summary.references.join(" ") });
  headers.push({ name: "MIME-Version", value: "1.0" });
  headers.push({
    name: "Content-Type",
    value: type === "text/plain" ? 'text/plain; charset="UTF-8"' : `${type}; boundary="firedrill_${summary.id}"`,
  });
  if (wanted === undefined || wanted.length === 0) return headers;
  const lower = wanted.map((name) => name.toLowerCase());
  return headers.filter((header) => lower.includes(header.name.toLowerCase()));
}

function textPart(partId, mimeType, text) {
  return {
    partId,
    mimeType,
    filename: "",
    headers: [
      { name: "Content-Type", value: `${mimeType}; charset="UTF-8"` },
      { name: "Content-Transfer-Encoding", value: "base64" },
    ],
    body: { size: byteLength(text), data: encodeText(text) },
  };
}

function contentParts(summary, prefix) {
  const text = summary.plaintextBody ?? "";
  if (!summary.hasHtml) return [textPart(`${prefix}0`, "text/plain", text)];
  return [textPart(`${prefix}0`, "text/plain", text), textPart(`${prefix}1`, "text/html", summary.htmlBody ?? "")];
}

function fullPayload(summary) {
  const headers = headerList(summary, undefined);
  const type = structureType(summary);
  if (type === "text/plain") {
    const text = summary.plaintextBody ?? "";
    return { partId: "", mimeType: "text/plain", filename: "", headers, body: { size: byteLength(text), data: encodeText(text) } };
  }
  if (type === "multipart/alternative") {
    return { partId: "", mimeType: type, filename: "", headers, body: { size: 0 }, parts: contentParts(summary, "") };
  }
  const first = summary.hasHtml
    ? {
        partId: "0",
        mimeType: "multipart/alternative",
        filename: "",
        headers: [{ name: "Content-Type", value: `multipart/alternative; boundary="firedrill_${summary.id}_alt"` }],
        body: { size: 0 },
        parts: contentParts(summary, "0."),
      }
    : textPart("0", "text/plain", summary.plaintextBody ?? "");
  const attachments = (summary.attachments ?? []).map((attachment, index) => ({
    partId: String(index + 1),
    mimeType: attachment.mimeType,
    filename: attachment.filename,
    headers: [
      { name: "Content-Type", value: `${attachment.mimeType}; name="${attachment.filename}"` },
      { name: "Content-Disposition", value: `attachment; filename="${attachment.filename}"` },
      { name: "Content-Transfer-Encoding", value: "base64" },
    ],
    body: { attachmentId: attachment.id, size: attachment.size },
  }));
  return { partId: "", mimeType: "multipart/mixed", filename: "", headers, body: { size: 0 }, parts: [first, ...attachments] };
}

/** REST `Message` resource for `minimal`, `metadata` or `full`. */
export function restMessage(summary, format, metadataHeaders) {
  const base = {
    id: summary.id,
    threadId: summary.threadId,
    labelIds: [...summary.labelIds],
    snippet: summary.snippet,
    historyId: summary.historyId,
    internalDate: summary.internalDate,
    sizeEstimate: summary.sizeEstimate,
  };
  if (format === "minimal") return base;
  if (format === "metadata") {
    return {
      ...base,
      payload: {
        partId: "",
        mimeType: structureType(summary),
        filename: "",
        headers: headerList(summary, metadataHeaders),
        body: { size: 0 },
      },
    };
  }
  return { ...base, payload: fullPayload(summary) };
}

/** REST `Label` resource from the canonical label. */
export function restLabel(label) {
  return {
    id: label.labelId,
    name: label.name,
    type: label.type,
    messageListVisibility: label.messageListVisibility,
    labelListVisibility: label.labelListVisibility,
    ...(label.color !== undefined ? { color: label.color } : {}),
  };
}

const ERROR_MAP = {
  INVALID_ARGUMENT: { code: 400, reason: "invalidArgument", status: "INVALID_ARGUMENT", domain: "global" },
  INVALID_PAGE_TOKEN: { code: 400, reason: "invalidArgument", status: "INVALID_ARGUMENT", domain: "global" },
  FAILED_PRECONDITION: { code: 400, reason: "failedPrecondition", status: "FAILED_PRECONDITION", domain: "global" },
  FORBIDDEN: { code: 403, reason: "forbidden", status: "PERMISSION_DENIED", domain: "global" },
  NOT_FOUND: { code: 404, reason: "notFound", status: "NOT_FOUND", domain: "global" },
  ALREADY_EXISTS: { code: 409, reason: "aborted", status: "ABORTED", domain: "global" },
  RATE_LIMITED: { code: 429, reason: "rateLimitExceeded", status: "RESOURCE_EXHAUSTED", domain: "usageLimits" },
  BACKEND_ERROR: { code: 503, reason: "backendError", status: "UNAVAILABLE", domain: "global" },
};

/** Gmail-shaped error envelope for any non-ok outcome (framework outcomes included). */
export function gmailError(outcome) {
  const error = outcome.error ?? {};
  let mapping;
  let message = error.message ?? "Request failed";
  if (outcome.status === "tool_error") {
    const code = String(error.code ?? "").replace(/^tool\./, "");
    // Own-property lookup: an unexpected code such as "constructor" must not resolve to an inherited member.
    mapping = Object.hasOwn(ERROR_MAP, code)
      ? ERROR_MAP[code]
      : { code: 500, reason: "backendError", status: "INTERNAL", domain: "global" };
  } else if (outcome.status === "denied") {
    mapping = { code: 403, reason: "forbidden", status: "PERMISSION_DENIED", domain: "global" };
    message = "Request had insufficient authentication scopes.";
  } else if (outcome.status === "unsupported") {
    mapping = { code: 404, reason: "notFound", status: "NOT_FOUND", domain: "global" };
  } else {
    mapping = { code: 400, reason: "badRequest", status: "INVALID_ARGUMENT", domain: "global" };
  }
  return {
    headers: mapping.code === 429 ? { "retry-after": "60" } : {},
    body: {
      kind: "json",
      value: {
        error: {
          code: mapping.code,
          message,
          errors: [{ message, domain: mapping.domain, reason: mapping.reason }],
          status: mapping.status,
        },
      },
    },
  };
}
