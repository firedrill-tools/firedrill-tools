// Gmail-shaped synthetic mailbox. Every operation computes from context.state; nothing leaves the world.
import {
  IMMUTABLE_LABEL_IDS,
  SYSTEM_LABELS,
  compareAsc,
  compareDesc,
  draftId,
  isPlainAddress,
  isSystemLabel,
  labelId,
  messageId,
  normalizeAddress,
  rowId,
  scopeHash,
} from "./lib/ids.mjs";
import { MimeError, decodeText, encodeText, estimateSize, parseRaw, rfcDate, snippetOf } from "./lib/mime.mjs";
import { QueryError, labelResolver, matchMessage, parseQuery, reachesTrashOrSpam } from "./lib/query.mjs";
import { gmailError, minimalMessage, restLabel, restMessage, summarize } from "./lib/wire.mjs";
import { RESPONSE_BUDGET_BYTES, jsonBytes } from "./lib/budget.mjs";
import { assertJsonDepth } from "./lib/json-depth.mjs";

const SCAN_STEP = 1000;
const SCAN_CAP = 10_000;
/**
 * Rows one mailbox may hold per namespace unless its `mailboxes` row carries `limits`. Whole-mailbox reads refuse a
 * mailbox beyond its bound with FAILED_PRECONDITION instead of serving it truncated; writes refuse to fill it further.
 */
const DEFAULT_LIMITS = { messages: 5000, labels: 500, drafts: 500 };
/**
 * Messages one thread may hold: the declared bound of every thread output (`messages`, `messageIds` in events) and of
 * `threads.messageIds` in state. Writes that would attach a 201st message refuse with FAILED_PRECONDITION so that no
 * later read of the thread can fall outside its schema; Gmail's own conversation view splits at 100.
 */
const THREAD_BOUND = 200;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;
// Gmail's REST labels.list is unpaged, so its codec asks for every label at once; the mailbox label bound keeps it finite.
const MAX_LABEL_PAGE = SCAN_CAP;
// Bytes reserved in a list response for everything but its entries: wrapper, nextPageToken, resultSizeEstimate.
const PAGE_OVERHEAD_BYTES = 1024;
// Page-token bounds. MAX_TOKEN_CHARS is the declared `pageToken` inputSchema bound, repeated here because the same
// helper also runs for tokens that arrive through a wire route; the payload and depth bounds are many times what the
// longest token this package issues needs (about 80 characters, two levels deep) and stop a forged token before
// JSON.parse. ANCHOR_ID covers every row-id pattern the state schemas declare, well inside the 512-character row-id cap.
const MAX_TOKEN_CHARS = 2048;
const MAX_TOKEN_JSON_CHARS = 512;
const MAX_TOKEN_DEPTH = 8;
const MAX_TOKEN_OFFSET = 1_000_000;
const ANCHOR_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Longest Message-ID, In-Reply-To or References item a stored message holds (the messages state schema bound).
const MAX_MESSAGE_ID_HEADER = 300;

/** The declared refusal for a response that cannot fit the byte budget even as a single object. */
function tooLarge(context, what, advice) {
  return precondition(
    context,
    `Response too large for this Tool: ${what} encodes to more than ${RESPONSE_BUDGET_BYTES} bytes of UTF-8 JSON, the most one response of this synthetic mailbox carries. ${advice}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------------------------

/** Caller text quoted into an error: at most about 200 characters, with an ellipsis when clipped. */
function clip(value) {
  const text = String(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
function invalid(context, message) {
  return context.fail({ code: "INVALID_ARGUMENT", message });
}
function notFound(context, message = "Requested entity was not found.") {
  return context.fail({ code: "NOT_FOUND", message });
}
function precondition(context, message) {
  return context.fail({ code: "FAILED_PRECONDITION", message });
}

// ---------------------------------------------------------------------------------------------
// Mailbox resolution and rows
// ---------------------------------------------------------------------------------------------

/**
 * The mailbox a caller without an `email` attribute acts as: the world's primary seeded account, i.e. the `mailboxes`
 * row with the lowest row id (addresses are the row ids, so this is the alphabetically first account). A world without
 * any mailbox row falls back to `<actorId>@example.test`, an empty account that is materialised on its first write.
 */
function defaultMailbox(context) {
  const first = context.state.scan("mailboxes", { limit: 1 });
  return first.length > 0 ? first[0].value.emailAddress : `${context.actor.id}@example.test`;
}

/** The mailbox this call acts on: the actor's `email` attribute when present, otherwise the documented default. */
function mailboxFor(context, input) {
  const email = context.actor.attributes.email;
  const mailbox = normalizeAddress(typeof email === "string" && email.includes("@") ? email : defaultMailbox(context));
  const userId = input.userId;
  if (userId !== undefined && userId !== "me" && normalizeAddress(userId) !== mailbox) {
    context.fail({ code: "FORBIDDEN", message: `Delegation denied for ${clip(userId)}` });
  }
  return mailbox;
}

function loadMailbox(context, mailbox) {
  const stored = context.state.get("mailboxes", mailbox);
  if (stored !== null) return { ...stored };
  const displayName = context.actor.attributes.displayName;
  return {
    emailAddress: mailbox,
    displayName: typeof displayName === "string" ? displayName.slice(0, 200) : "",
    historyId: 1,
    messagesTotal: 0,
    threadsTotal: 0,
    sequence: 0,
  };
}

function saveMailbox(context, box) {
  context.state.put("mailboxes", box.emailAddress, box);
}

function bump(box) {
  box.historyId += 1;
  return box.historyId;
}

function nextSequence(box) {
  box.sequence += 1;
  return box.sequence;
}

/** Per-namespace row bounds of one mailbox: `mailboxes.limits` where authored, the package defaults otherwise. */
function limitsFor(context, mailbox) {
  const stored = context.state.get("mailboxes", mailbox);
  return { ...DEFAULT_LIMITS, ...(stored !== null && stored.limits !== undefined ? stored.limits : {}) };
}

/**
 * Every row of one mailbox in one namespace, via bounded prefix scans (row ids are "<mailbox>:<id>"). The scan reads
 * one row past the mailbox's bound: a mailbox holding more rows than that is refused with FAILED_PRECONDITION rather
 * than served incomplete, so a listing can never quietly omit rows.
 */
function rowsFor(context, namespace, mailbox) {
  const bound = Math.min(SCAN_CAP, limitsFor(context, mailbox)[namespace] ?? SCAN_CAP);
  const prefix = `${mailbox}:`;
  const rows = [];
  let after = prefix;
  while (rows.length <= bound) {
    const limit = Math.min(SCAN_STEP, bound + 1 - rows.length);
    const batch = context.state.scan(namespace, { afterRowId: after, limit });
    for (const record of batch) {
      if (!record.rowId.startsWith(prefix)) return rows;
      after = record.rowId;
      rows.push(record.value);
    }
    if (batch.length < limit) break;
  }
  if (rows.length > bound) {
    precondition(
      context,
      `Mailbox ${mailbox} holds more than ${bound} ${namespace} rows; this synthetic mailbox serves at most ${bound} (mailboxes.limits.${namespace}).`,
    );
  }
  return rows;
}

/** Refuse a write that would push one namespace of the mailbox past its bound: the synthetic "mailbox is full". */
function requireRoom(context, mailbox, namespace) {
  const bound = Math.min(SCAN_CAP, limitsFor(context, mailbox)[namespace] ?? SCAN_CAP);
  if (rowsFor(context, namespace, mailbox).length >= bound) {
    precondition(
      context,
      `Mailbox ${mailbox} is full: it already holds ${bound} ${namespace} rows, the most this synthetic mailbox supports (mailboxes.limits.${namespace}).`,
    );
  }
}

/** Refuse a write that would attach a message to a thread already holding THREAD_BOUND messages. */
function requireThreadRoom(context, mailbox, threadId) {
  const existing = context.state.get("threads", rowId(mailbox, threadId));
  if (existing !== null && existing.messageIds.length >= THREAD_BOUND) {
    precondition(
      context,
      `Thread ${threadId} in mailbox ${clip(mailbox)} is full: it already holds ${THREAD_BOUND} messages, the most one thread of this synthetic mailbox supports.`,
    );
  }
}

/** A user label row of this mailbox, by id, without scanning the mailbox. */
function userLabelExists(context, mailbox, id) {
  const label = context.state.get("labels", rowId(mailbox, id));
  return label !== null && label.mailbox === mailbox;
}

function getMessage(context, mailbox, id) {
  const record = context.state.get("messages", rowId(mailbox, id));
  return record !== null && record.mailbox === mailbox ? record : null;
}

function requireMessage(context, mailbox, id) {
  const record = getMessage(context, mailbox, id);
  return record ?? notFound(context);
}

function requireThread(context, mailbox, id) {
  const thread = context.state.get("threads", rowId(mailbox, id));
  return thread !== null && thread.mailbox === mailbox ? thread : notFound(context);
}

function requireDraft(context, mailbox, id) {
  const draft = context.state.get("drafts", rowId(mailbox, id));
  return draft !== null && draft.mailbox === mailbox ? draft : notFound(context);
}

function userLabels(context, mailbox) {
  return rowsFor(context, "labels", mailbox).sort((left, right) => Number(left.id.slice(6)) - Number(right.id.slice(6)));
}

// ---------------------------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------------------------

function threadMessages(context, mailbox, thread) {
  return thread.messageIds
    .map((id) => getMessage(context, mailbox, id))
    .filter((record) => record !== null)
    .sort(compareAsc);
}

/** Recompute one thread from its messages; deletes it when empty. */
function rebuildThread(context, mailbox, threadId, box) {
  const key = rowId(mailbox, threadId);
  const existing = context.state.get("threads", key);
  const messages = existing === null ? [] : threadMessages(context, mailbox, existing);
  if (messages.length === 0) {
    if (existing !== null) {
      context.state.delete("threads", key);
      box.threadsTotal = Math.max(0, box.threadsTotal - 1);
    }
    return null;
  }
  const last = messages[messages.length - 1];
  const labelIds = [];
  for (const message of messages) for (const id of message.labelIds) if (!labelIds.includes(id)) labelIds.push(id);
  const thread = {
    mailbox,
    id: threadId,
    messageIds: messages.map((message) => message.id),
    snippet: last.snippet,
    historyId: box.historyId,
    lastInternalDate: last.internalDate,
    labelIds,
  };
  context.state.put("threads", key, thread);
  return thread;
}

function attachToThread(context, mailbox, threadId, id, box) {
  const key = rowId(mailbox, threadId);
  const existing = context.state.get("threads", key);
  if (existing === null) {
    box.threadsTotal += 1;
    context.state.put("threads", key, {
      mailbox,
      id: threadId,
      messageIds: [id],
      snippet: "",
      historyId: box.historyId,
      lastInternalDate: "0",
      labelIds: [],
    });
  } else if (!existing.messageIds.includes(id)) {
    context.state.put("threads", key, { ...existing, messageIds: [...existing.messageIds, id] });
  }
  return rebuildThread(context, mailbox, threadId, box);
}

/** Take one message out of a thread; the thread row disappears when nothing is left. */
function detachFromThread(context, mailbox, threadId, id, box) {
  const key = rowId(mailbox, threadId);
  const existing = context.state.get("threads", key);
  if (existing === null) return;
  context.state.put("threads", key, { ...existing, messageIds: existing.messageIds.filter((item) => item !== id) });
  rebuildThread(context, mailbox, threadId, box);
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

function validateLabelIds(context, mailbox, ids, purpose) {
  const result = [];
  for (const id of ids) {
    if (IMMUTABLE_LABEL_IDS.includes(id)) invalid(context, `Invalid label: ${clip(id)} cannot be ${purpose}`);
    if (!isSystemLabel(id) && !userLabelExists(context, mailbox, id)) invalid(context, `Invalid label: ${clip(id)}`);
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

function applyLabels(context, mailbox, record, addLabelIds, removeLabelIds, box) {
  const labelIds = record.labelIds.filter((id) => !removeLabelIds.includes(id));
  for (const id of addLabelIds) if (!labelIds.includes(id)) labelIds.push(id);
  const updated = { ...record, labelIds, historyId: bump(box), version: record.version + 1 };
  context.state.put("messages", rowId(mailbox, record.id), updated);
  return updated;
}

/**
 * Per-label thread counts the way Gmail reports them: threadsTotal counts threads holding the label;
 * threadsUnread counts threads with at least one unread message that itself carries the label
 * (message-label intersection), so an unread INBOX reply never marks the thread's SENT label unread.
 */
function labelCounts(context, mailbox) {
  const perThread = new Map();
  for (const record of rowsFor(context, "messages", mailbox)) {
    let entry = perThread.get(record.threadId);
    if (entry === undefined) {
      entry = { labels: new Set(), unread: new Set() };
      perThread.set(record.threadId, entry);
    }
    const unread = record.labelIds.includes("UNREAD");
    for (const id of record.labelIds) {
      entry.labels.add(id);
      if (unread) entry.unread.add(id);
    }
  }
  const counts = new Map();
  for (const entry of perThread.values()) {
    for (const id of entry.labels) {
      const count = counts.get(id) ?? { total: 0, unread: 0 };
      count.total += 1;
      if (entry.unread.has(id)) count.unread += 1;
      counts.set(id, count);
    }
  }
  return counts;
}

function labelView(label, counts) {
  const entry = counts.get(label.id) ?? { total: 0, unread: 0 };
  return {
    labelId: label.id,
    name: label.name,
    type: label.type,
    messageListVisibility: label.messageListVisibility,
    labelListVisibility: label.labelListVisibility,
    ...(label.color !== undefined ? { color: label.color } : {}),
    threadsTotal: entry.total,
    threadsUnread: entry.unread,
  };
}

function systemLabelRecord(definition) {
  return { id: definition.id, name: definition.id, type: "system", ...definition };
}

function validateLabelName(context, mailbox, name, excludeId, labels = userLabels(context, mailbox)) {
  const trimmed = String(name).trim();
  if (trimmed.length === 0 || trimmed.length > 225) invalid(context, "Label name must be 1 to 225 characters.");
  if (trimmed.startsWith("/") || trimmed.endsWith("/") || trimmed.includes("//")) {
    invalid(context, "Label name cannot start or end with a slash.");
  }
  if (isSystemLabel(trimmed.toUpperCase())) invalid(context, `Invalid label name: "${clip(trimmed)}" is a system label.`);
  const lower = trimmed.toLowerCase();
  for (const label of labels) {
    if (label.id !== excludeId && label.name.toLowerCase() === lower) {
      context.fail({ code: "ALREADY_EXISTS", message: "Label name exists or conflicts" });
    }
  }
  return trimmed;
}

function validateColor(context, color) {
  if (color === undefined) return undefined;
  const text = String(color.textColor ?? "").toLowerCase();
  const background = String(color.backgroundColor ?? "").toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(text) || !/^#[0-9a-f]{6}$/.test(background)) {
    invalid(context, "Label color requires textColor and backgroundColor as #rrggbb hex values.");
  }
  return { textColor: text, backgroundColor: background };
}

// ---------------------------------------------------------------------------------------------
// Pagination and search
// ---------------------------------------------------------------------------------------------

function pageSizeOf(input, field, maximum = MAX_PAGE) {
  const value = input[field];
  if (value === undefined) return DEFAULT_PAGE;
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
}

/** Every page token is refused the same way, whatever layer rejected it: Gmail's invalid-cursor error, no detail. */
function invalidPageToken(context) {
  return context.fail({ code: "INVALID_PAGE_TOKEN", message: "Invalid pageToken" });
}

/**
 * Nesting depth of JSON text, counted with a scanner rather than recursion so measuring a forged token can never
 * overflow the stack itself. Returns true while the text stays within `max` levels of `[`/`{`.
 */
function jsonDepthWithin(text, max) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[" || character === "{") {
      depth += 1;
      if (depth > max) return false;
    } else if (character === "]" || character === "}") depth -= 1;
  }
  return true;
}

/**
 * Decode an opaque page token into its payload. Tokens come back from callers and can be forged, so every layer is
 * validated before anything is used: type and length, the base64url alphabet and length class encodeText writes (no
 * padding, no whitespace, none of the standard alphabet's `+/`), strict UTF-8 (lib/mime.mjs rejects overlong forms,
 * surrogates and code points above U+10FFFF), a bounded payload length, a bounded nesting depth measured iteratively,
 * and only then JSON.parse. Callers check the parsed value's shape; nothing here coerces it.
 */
function decodeTokenPayload(context, token) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) return invalidPageToken(context);
  if (token.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(token)) return invalidPageToken(context);
  let text;
  try {
    text = decodeText(token);
  } catch {
    return invalidPageToken(context);
  }
  if (text.length === 0 || text.length > MAX_TOKEN_JSON_CHARS) return invalidPageToken(context);
  if (!jsonDepthWithin(text, MAX_TOKEN_DEPTH)) return invalidPageToken(context);
  try {
    return JSON.parse(text);
  } catch {
    return invalidPageToken(context);
  }
}

function decodeToken(context, token, scope) {
  if (token === undefined || token === "") return undefined;
  const parsed = decodeTokenPayload(context, token);
  // Accept only the exact shape encodeToken writes: { s: <scope hash>, a: [internalDate, id] }. The two anchor bounds
  // are the declared state schemas (`internalDate` is `^[0-9]{1,16}$`; row ids are 16-hex messages and threads,
  // `r<digits>` drafts, `Label_<digits>` labels), so no token this package issues is ever refused, and no forged
  // value — a deeply nested array whose Array.prototype.toString would recurse, a number, an object, a 2 KB string —
  // ever reaches String(), a comparison or a row-id lookup (the framework caps row ids at 512 characters).
  const valid = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    && Object.keys(parsed).length === 2
    && typeof parsed.s === "string" && parsed.s === scope
    && Array.isArray(parsed.a) && parsed.a.length === 2
    && typeof parsed.a[0] === "string" && /^[0-9]{1,16}$/.test(parsed.a[0])
    && typeof parsed.a[1] === "string" && ANCHOR_ID.test(parsed.a[1]);
  if (!valid) return invalidPageToken(context);
  return { internalDate: parsed.a[0], id: parsed.a[1] };
}

function encodeToken(scope, anchor) {
  return encodeText(JSON.stringify({ s: scope, a: [anchor.internalDate, anchor.id] }));
}

/**
 * Slice a desc-sorted list after the anchor; returns { items, views, nextPageToken? }. `viewOf` renders one entry as it
 * appears in the response. The page stops at `pageSize` entries or before its rendered entries would pass the response
 * byte budget, whichever comes first, and a stopped page always carries a real nextPageToken. A page always holds at
 * least one entry, so paging can never stall; an entry that alone would pass the budget calls `oversized(entry)`, which
 * must raise the declared too-large refusal (a page is never handed back above the budget).
 */
function paginate(sorted, anchor, pageSize, scope, keyOf, viewOf, oversized) {
  let start = 0;
  if (anchor !== undefined) {
    const anchorRecord = { internalDate: anchor.internalDate, id: anchor.id };
    while (start < sorted.length && compareDesc(keyOf(sorted[start]), anchorRecord) <= 0) start += 1;
  }
  const items = [];
  const views = [];
  let bytes = PAGE_OVERHEAD_BYTES;
  for (let index = start; index < sorted.length && items.length < pageSize; index += 1) {
    const view = viewOf(sorted[index]);
    const size = jsonBytes(view) + 1;
    if (bytes + size > RESPONSE_BUDGET_BYTES) {
      if (items.length > 0) break;
      oversized(sorted[index]);
    }
    bytes += size;
    items.push(sorted[index]);
    views.push(view);
  }
  const more = start + items.length < sorted.length;
  return {
    items,
    views,
    ...(more && items.length > 0 ? { nextPageToken: encodeToken(scope, keyOf(items[items.length - 1])) } : {}),
  };
}

function parseSearch(context, query) {
  try {
    return parseQuery(query);
  } catch (error) {
    if (error instanceof QueryError) return invalid(context, error.message);
    throw error;
  }
}

function matcher(context, mailbox) {
  const labels = userLabels(context, mailbox);
  return { nowMs: Math.floor(context.clock.nowUs() / 1000), resolveLabel: labelResolver(labels), labels };
}

/** Messages of a mailbox matching a query and label filter, honouring the TRASH/SPAM default exclusion. */
function searchMessages(context, mailbox, { query, labelIds, includeSpamTrash }) {
  const ast = parseSearch(context, query);
  const search = matcher(context, mailbox);
  const filters = labelIds ?? [];
  const known = new Set(search.labels.map((label) => label.id));
  for (const id of filters) if (!isSystemLabel(id) && !known.has(id)) invalid(context, `Invalid label: ${clip(id)}`);
  const include =
    includeSpamTrash === true || reachesTrashOrSpam(ast) || filters.includes("TRASH") || filters.includes("SPAM");
  return rowsFor(context, "messages", mailbox).filter(
    (record) =>
      (include || !(record.labelIds.includes("TRASH") || record.labelIds.includes("SPAM"))) &&
      filters.every((id) => record.labelIds.includes(id)) &&
      matchMessage(ast, record, search),
  );
}

// ---------------------------------------------------------------------------------------------
// Message creation, sending and delivery
// ---------------------------------------------------------------------------------------------

function validateRecipients(context, input) {
  const lists = {};
  let total = 0;
  for (const field of ["to", "cc", "bcc"]) {
    const values = input[field] ?? [];
    const cleaned = [];
    for (const value of values) {
      const address = normalizeAddress(value);
      if (!isPlainAddress(address)) invalid(context, `Invalid ${field} address: "${clip(value)}"`);
      if (!cleaned.includes(address)) cleaned.push(address);
    }
    lists[field] = cleaned;
    total += cleaned.length;
  }
  if (total > 50) invalid(context, "A message may address at most 50 recipients.");
  return lists;
}

/** Normalize structured or raw input into { to, cc, bcc, subject, body, inReplyTo, references }. */
function composeInput(context, mailbox, input) {
  if (input.attachments !== undefined && input.attachments.length > 0) {
    invalid(context, "Attachments are not supported by this synthetic mailbox.");
  }
  let content;
  if (input.raw !== undefined) {
    if (input.to !== undefined || input.body !== undefined || input.htmlBody !== undefined || input.subject !== undefined) {
      invalid(context, "Provide either raw or structured fields, not both.");
    }
    try {
      content = parseRaw(input.raw);
    } catch (error) {
      if (error instanceof MimeError) return invalid(context, error.message);
      throw error;
    }
  } else {
    content = {
      to: input.to ?? [],
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      subject: input.subject ?? "",
      references: [],
      body: { text: input.body ?? "", ...(input.htmlBody !== undefined ? { html: input.htmlBody } : {}) },
    };
  }
  if (input.replyToMessageId !== undefined && content.to.length + content.cc.length + content.bcc.length === 0) {
    // Replying without explicit recipients addresses the original sender, as a mail client would.
    content.to = [requireMessage(context, mailbox, input.replyToMessageId).headers.from];
  }
  const recipients = validateRecipients(context, content);
  // Stored threading headers are bounded (messages.headers.inReplyTo and each references item hold at most 300
  // characters, as a Message-ID does); a longer raw header is refused instead of failing the state write.
  if (content.inReplyTo !== undefined && content.inReplyTo.length > MAX_MESSAGE_ID_HEADER) {
    invalid(context, `Invalid In-Reply-To header: longer than ${MAX_MESSAGE_ID_HEADER} characters.`);
  }
  for (const reference of content.references) {
    if (reference.length > MAX_MESSAGE_ID_HEADER) {
      invalid(context, `Invalid References header: a message id is longer than ${MAX_MESSAGE_ID_HEADER} characters.`);
    }
  }
  if (content.body.text.length > 65_536 || (content.body.html ?? "").length > 131_072) {
    invalid(context, "Message body exceeds the supported size.");
  }
  let threadId;
  let inReplyTo = content.inReplyTo;
  let references = [...content.references];
  let subject = String(content.subject).slice(0, 998);
  if (input.replyToMessageId !== undefined) {
    const original = requireMessage(context, mailbox, input.replyToMessageId);
    threadId = original.threadId;
    inReplyTo = original.headers.messageId;
    references = [...original.headers.references, original.headers.messageId];
    if (subject === "") subject = /^re:/i.test(original.headers.subject) ? original.headers.subject : `Re: ${original.headers.subject}`;
  }
  if (input.threadId !== undefined) {
    const thread = requireThread(context, mailbox, input.threadId);
    if (threadId !== undefined && threadId !== thread.id) invalid(context, "threadId does not match replyToMessageId.");
    threadId = thread.id;
    if (inReplyTo === undefined) {
      const last = getMessage(context, mailbox, thread.messageIds[thread.messageIds.length - 1]);
      if (last !== null) {
        inReplyTo = last.headers.messageId;
        references = [...last.headers.references, last.headers.messageId];
      }
    }
  }
  // A stored message keeps the latest 20 References ids (messages.headers.references), for sends, drafts and edits alike.
  return { ...recipients, subject, body: content.body, inReplyTo, references: references.slice(-20), threadId };
}

function newMessageRecord(context, mailbox, box, composed, labelIds, threadIdOverride) {
  const id = messageId(nextSequence(box));
  const threadId = threadIdOverride ?? composed.threadId ?? id;
  requireThreadRoom(context, mailbox, threadId);
  const nowMs = Math.floor(context.clock.nowUs() / 1000);
  const domain = mailbox.slice(mailbox.indexOf("@") + 1);
  const headers = {
    from: mailbox,
    ...(box.displayName ? { fromName: box.displayName } : {}),
    to: composed.to,
    cc: composed.cc,
    bcc: composed.bcc,
    subject: composed.subject,
    date: rfcDate(nowMs),
    messageId: `<${id}@${domain}>`,
    ...(composed.inReplyTo !== undefined ? { inReplyTo: composed.inReplyTo } : {}),
    references: composed.references.slice(-20),
  };
  const record = {
    mailbox,
    id,
    threadId,
    labelIds,
    snippet: snippetOf(composed.body.text || composed.body.html || ""),
    historyId: bump(box),
    internalDate: String(nowMs),
    sizeEstimate: estimateSize(headers, composed.body, []),
    headers,
    body: composed.body,
    attachments: [],
    version: 1,
  };
  context.state.put("messages", rowId(mailbox, id), record);
  box.messagesTotal += 1;
  attachToThread(context, mailbox, threadId, id, box);
  return record;
}

/** Deliver INBOX copies to recipient mailboxes that exist in this world. Never leaves the world. */
function deliver(context, sender, record) {
  const deliveredTo = [];
  const recipients = [...record.headers.to, ...record.headers.cc, ...record.headers.bcc];
  const seen = new Set();
  for (const address of recipients) {
    if (seen.has(address)) continue;
    seen.add(address);
    if (address === sender.emailAddress) {
      const own = { ...record, labelIds: [...record.labelIds] };
      for (const id of ["INBOX", "UNREAD"]) if (!own.labelIds.includes(id)) own.labelIds.push(id);
      context.state.put("messages", rowId(sender.emailAddress, record.id), own);
      rebuildThread(context, sender.emailAddress, record.threadId, sender);
      deliveredTo.push(address);
      continue;
    }
    const stored = context.state.get("mailboxes", address);
    if (stored === null) continue;
    // A recipient at its message bound cannot take a copy: the send fails loudly (real Gmail would accept it and
    // bounce later; bounces are not modelled). Over the bound the bounded read itself refuses the mailbox.
    const existing = rowsFor(context, "messages", address);
    if (existing.length >= Math.min(SCAN_CAP, limitsFor(context, address).messages ?? SCAN_CAP)) {
      precondition(
        context,
        `Recipient mailbox ${clip(address)} is full: it holds ${existing.length} messages, the most this synthetic mailbox supports (mailboxes.limits.messages).`,
      );
    }
    const box = { ...stored };
    const id = messageId(nextSequence(box));
    let threadId = id;
    if (record.headers.inReplyTo !== undefined) {
      const parent = existing.find((message) => message.headers.messageId === record.headers.inReplyTo);
      if (parent !== undefined) threadId = parent.threadId;
    }
    // The recipient's copy joins the parent's thread; a thread at its bound refuses the copy the way a full mailbox does.
    requireThreadRoom(context, address, threadId);
    const headers = { ...record.headers, bcc: [] };
    const copy = {
      mailbox: address,
      id,
      threadId,
      labelIds: ["INBOX", "UNREAD"],
      snippet: record.snippet,
      historyId: bump(box),
      internalDate: record.internalDate,
      sizeEstimate: estimateSize(headers, record.body, []),
      headers,
      body: record.body,
      attachments: [],
      version: 1,
    };
    context.state.put("messages", rowId(address, id), copy);
    box.messagesTotal += 1;
    attachToThread(context, address, threadId, id, box);
    saveMailbox(context, box);
    deliveredTo.push(address);
  }
  return deliveredTo;
}

function sendRecord(context, mailbox, box, composed, threadId) {
  if (composed.to.length + composed.cc.length + composed.bcc.length === 0) {
    invalid(context, "Recipient address required");
  }
  const record = newMessageRecord(context, mailbox, box, composed, ["SENT"], threadId);
  const deliveredTo = deliver(context, box, record);
  saveMailbox(context, box);
  const stored = getMessage(context, mailbox, record.id) ?? record;
  context.events.emit("message.sent", {
    mailbox,
    messageId: record.id,
    threadId: record.threadId,
    to: record.headers.to,
    cc: record.headers.cc,
    subject: record.headers.subject,
    deliveredTo,
  });
  return { id: stored.id, threadId: stored.threadId, labelIds: [...stored.labelIds] };
}

// ---------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------

function draftView(draft, record) {
  return {
    id: draft.id,
    messageId: record.id,
    threadId: record.threadId,
    subject: record.headers.subject,
    toRecipients: [...record.headers.to],
    ccRecipients: [...record.headers.cc],
    bccRecipients: [...record.headers.bcc],
    plaintextBody: record.body.text,
    ...(record.body.html !== undefined ? { htmlBody: record.body.html } : {}),
    date: summarize(record, false).date,
    internalDate: record.internalDate,
    historyId: String(record.historyId),
  };
}

function draftWithMessage(context, mailbox, id) {
  const draft = requireDraft(context, mailbox, id);
  const record = getMessage(context, mailbox, draft.messageId);
  if (record === null) notFound(context);
  return { draft, record };
}

function removeMessage(context, mailbox, record, box) {
  context.state.delete("messages", rowId(mailbox, record.id));
  box.messagesTotal = Math.max(0, box.messagesTotal - 1);
  rebuildThread(context, mailbox, record.threadId, box);
}

// ---------------------------------------------------------------------------------------------
// Shared label mutations with events
// ---------------------------------------------------------------------------------------------

function modifyMessages(context, mailbox, records, addLabelIds, removeLabelIds, box) {
  const add = validateLabelIds(context, mailbox, addLabelIds ?? [], "added");
  const remove = validateLabelIds(context, mailbox, removeLabelIds ?? [], "removed");
  if (add.length === 0 && remove.length === 0) invalid(context, "Specify at least one label to add or remove.");
  const updated = records.map((record) => applyLabels(context, mailbox, record, add, remove, box));
  const threads = new Set(updated.map((record) => record.threadId));
  for (const threadId of threads) rebuildThread(context, mailbox, threadId, box);
  saveMailbox(context, box);
  context.events.emit("message.labels-changed", {
    mailbox,
    messageIds: updated.map((record) => record.id),
    addLabelIds: add,
    removeLabelIds: remove,
  });
  return updated;
}

function trashMessages(context, mailbox, records, box) {
  const targets = records.filter((record) => !record.labelIds.includes("TRASH"));
  if (targets.length === 0) precondition(context, "Message is already in the trash.");
  const updated = targets.map((record) => applyLabels(context, mailbox, record, ["TRASH"], ["INBOX"], box));
  const threads = new Set(updated.map((record) => record.threadId));
  for (const threadId of threads) rebuildThread(context, mailbox, threadId, box);
  saveMailbox(context, box);
  context.events.emit("message.trashed", { mailbox, messageIds: updated.map((record) => record.id), threadId: updated[0].threadId });
  return updated;
}

function threadResult(context, mailbox, threadId) {
  const thread = requireThread(context, mailbox, threadId);
  return {
    id: thread.id,
    historyId: String(thread.historyId),
    messages: threadMessages(context, mailbox, thread).map(minimalMessage),
  };
}

/**
 * One threads.get message entry exactly as the operation returns it, and its measured size. The operation's return
 * value is what every surface receives (MCP and app callers get it as is), so it is always measured; with restFormat
 * the get-thread route re-renders it as REST Message resources, so that rendering is measured too and the larger size
 * counts. restFormat "minimal" returns only the REST minimal fields (no headers are read into the result), so a
 * caller that asks for it gets the small shape that was measured, never the full summaries.
 */
function threadEntry(record, restFormat, full) {
  if (restFormat === "minimal") {
    const entry = minimalMessage(record);
    return { entry, bytes: jsonBytes(entry) };
  }
  const entry = summarize(record, full);
  const bytes = jsonBytes(entry);
  return { entry, bytes: restFormat === undefined ? bytes : Math.max(bytes, jsonBytes(restMessage(entry, restFormat, undefined))) };
}

/** Whether a whole thread fits the budget in one rendering (restFormat or canonical MINIMAL/FULL_CONTENT). */
function threadFits(records, restFormat, full) {
  let bytes = PAGE_OVERHEAD_BYTES;
  for (const record of records) {
    bytes += threadEntry(record, restFormat, full).bytes + 1;
    if (bytes > RESPONSE_BUDGET_BYTES) return false;
  }
  return true;
}

/** Accurate advice for a thread refused by threads.get: which lighter renderings of it fit the budget, if any. */
function threadAdvice(records, restFormat, full) {
  const oneByOne = "read its messages one at a time with messages.get";
  const lighter =
    restFormat === "full" ? ["metadata", "minimal"] : restFormat === "metadata" ? ["minimal"] : restFormat === undefined ? (full ? [undefined, "minimal"] : ["minimal"]) : [];
  const fitting = lighter.filter((format) => threadFits(records, format, false));
  const named = (format) =>
    restFormat === undefined ? (format === undefined ? "messageFormat MINIMAL (no bodies)" : "restFormat minimal (ids, labels and snippets only)") : `format=${format}`;
  if (fitting.length > 0) return `The same thread fits with ${fitting.map(named).join(" and with ")}; or ${oneByOne}.`;
  return `Take its message ids from messages.list (each entry names its threadId) and ${oneByOne}.`;
}

function summaryFormat(input) {
  return input.messageFormat === "MINIMAL" ? false : true;
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

const operations = {
  "profile.get": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const box = loadMailbox(context, mailbox);
    return {
      emailAddress: mailbox,
      messagesTotal: box.messagesTotal,
      threadsTotal: box.threadsTotal,
      historyId: String(box.historyId),
      // The world's virtual now (RFC 3339, UTC): what the browser app treats as "today". Canonical/MCP only; the
      // REST codec strips it because Gmail's Profile resource has no such field.
      serverTime: new Date(Math.floor(context.clock.nowUs() / 1000)).toISOString(),
    };
  },

  "labels.list": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const type = input.type ?? "user";
    const counts = labelCounts(context, mailbox);
    const all = [];
    if (type !== "user") for (const definition of SYSTEM_LABELS) all.push(labelView(systemLabelRecord(definition), counts));
    if (type !== "system") for (const label of userLabels(context, mailbox)) all.push(labelView(label, counts));
    const scope = scopeHash(["labels", mailbox, type]);
    const pageSize = pageSizeOf(input, "pageSize", MAX_LABEL_PAGE);
    let start = 0;
    if (input.pageToken !== undefined && input.pageToken !== "") {
      // The labels cursor is an offset, not an anchor, but it is caller input just the same: accept only the exact
      // shape this route writes ({ s: <scope hash>, o: <offset> }) with a finite, in-range integer offset.
      const parsed = decodeTokenPayload(context, input.pageToken);
      const valid = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        && Object.keys(parsed).length === 2
        && typeof parsed.s === "string" && parsed.s === scope
        && typeof parsed.o === "number" && Number.isSafeInteger(parsed.o) && parsed.o >= 0 && parsed.o <= MAX_TOKEN_OFFSET;
      if (!valid) return invalidPageToken(context);
      start = parsed.o;
    }
    const labels = [];
    let bytes = PAGE_OVERHEAD_BYTES;
    let next = start;
    for (; next < all.length && labels.length < pageSize; next += 1) {
      const size = jsonBytes(all[next]) + 1;
      if (labels.length > 0 && bytes + size > RESPONSE_BUDGET_BYTES) break;
      bytes += size;
      labels.push(all[next]);
    }
    const more = next < all.length;
    // pageSize 10000 asks for the whole list in one response (the unpaged REST route); never hand back part of it.
    if (more && labels.length < pageSize && pageSize === MAX_LABEL_PAGE) {
      tooLarge(context, `the list of ${all.length} labels`, "Page the canonical labels.list with a smaller pageSize.");
    }
    return { labels, ...(more ? { nextPageToken: encodeText(JSON.stringify({ s: scope, o: next })) } : {}) };
  },

  "labels.create": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const existing = userLabels(context, mailbox);
    const bound = Math.min(SCAN_CAP, limitsFor(context, mailbox).labels ?? SCAN_CAP);
    if (existing.length >= bound) {
      precondition(context, `Label limit reached: this mailbox holds ${existing.length} user labels and supports at most ${bound} (mailboxes.limits.labels).`);
    }
    const name = validateLabelName(context, mailbox, input.displayName, undefined, existing);
    const color = validateColor(context, input.color);
    const box = loadMailbox(context, mailbox);
    const label = {
      mailbox,
      id: labelId(nextSequence(box)),
      name,
      type: "user",
      messageListVisibility: input.messageListVisibility ?? "show",
      labelListVisibility: input.labelListVisibility ?? "labelShow",
      ...(color !== undefined ? { color } : {}),
    };
    bump(box);
    context.state.put("labels", rowId(mailbox, label.id), label);
    saveMailbox(context, box);
    return labelView(label, labelCounts(context, mailbox));
  },

  "labels.update": (input, context) => {
    const mailbox = mailboxFor(context, input);
    if (isSystemLabel(input.labelId)) precondition(context, "System labels cannot be modified.");
    const existing = context.state.get("labels", rowId(mailbox, input.labelId));
    if (existing === null || existing.mailbox !== mailbox) notFound(context);
    const name = input.displayName === undefined ? existing.name : validateLabelName(context, mailbox, input.displayName, existing.id);
    const color = input.color === undefined ? existing.color : validateColor(context, input.color);
    const box = loadMailbox(context, mailbox);
    const label = {
      ...existing,
      name,
      messageListVisibility: input.messageListVisibility ?? existing.messageListVisibility,
      labelListVisibility: input.labelListVisibility ?? existing.labelListVisibility,
    };
    delete label.color;
    if (color !== undefined) label.color = color;
    bump(box);
    context.state.put("labels", rowId(mailbox, label.id), label);
    saveMailbox(context, box);
    return labelView(label, labelCounts(context, mailbox));
  },

  "labels.delete": (input, context) => {
    const mailbox = mailboxFor(context, input);
    if (isSystemLabel(input.labelId)) precondition(context, "System labels cannot be deleted.");
    const existing = context.state.get("labels", rowId(mailbox, input.labelId));
    if (existing === null || existing.mailbox !== mailbox) notFound(context);
    const box = loadMailbox(context, mailbox);
    bump(box);
    let messagesUpdated = 0;
    const threads = new Set();
    for (const record of rowsFor(context, "messages", mailbox)) {
      if (!record.labelIds.includes(existing.id)) continue;
      context.state.put("messages", rowId(mailbox, record.id), {
        ...record,
        labelIds: record.labelIds.filter((id) => id !== existing.id),
        historyId: box.historyId,
        version: record.version + 1,
      });
      threads.add(record.threadId);
      messagesUpdated += 1;
    }
    for (const threadId of threads) rebuildThread(context, mailbox, threadId, box);
    context.state.delete("labels", rowId(mailbox, existing.id));
    saveMailbox(context, box);
    return { labelId: existing.id, deleted: true, messagesUpdated };
  },

  "messages.list": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const matches = searchMessages(context, mailbox, {
      query: input.q,
      labelIds: input.labelIds,
      includeSpamTrash: input.includeSpamTrash,
    }).sort(compareDesc);
    const scope = scopeHash(["messages", mailbox, input.q ?? "", input.labelIds ?? [], input.includeSpamTrash === true]);
    const anchor = decodeToken(context, input.pageToken, scope);
    const page = paginate(matches, anchor, pageSizeOf(input, "maxResults"), scope, (record) => record, (record) => ({
      id: record.id,
      threadId: record.threadId,
    }), (record) => tooLarge(context, `the list entry for message ${record.id}`, "Request a smaller page."));
    return {
      messages: page.views,
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      resultSizeEstimate: matches.length,
    };
  },

  "messages.get": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const format = input.format ?? "full";
    if (format === "raw") invalid(context, "format=raw is not supported by this synthetic mailbox.");
    // A header name carrying U+FFFD is a mangled request (malformed percent-encoding), not a header that is absent.
    if ((input.metadataHeaders ?? []).some((name) => name.includes("\uFFFD"))) {
      invalid(context, "Invalid metadataHeaders: contains U+FFFD (malformed percent-encoding or invalid UTF-8)");
    }
    const record = requireMessage(context, mailbox, input.id);
    return restMessage(summarize(record, format === "full"), format, input.metadataHeaders);
  },

  "messages.modify": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const record = requireMessage(context, mailbox, input.id);
    const box = loadMailbox(context, mailbox);
    return minimalMessage(modifyMessages(context, mailbox, [record], input.addLabelIds, input.removeLabelIds, box)[0]);
  },

  "messages.batch-modify": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const records = [];
    for (const id of input.ids) {
      const record = requireMessage(context, mailbox, id);
      if (!records.some((item) => item.id === record.id)) records.push(record);
    }
    const box = loadMailbox(context, mailbox);
    return { modified: modifyMessages(context, mailbox, records, input.addLabelIds, input.removeLabelIds, box).length };
  },

  "messages.label": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const record = requireMessage(context, mailbox, input.messageId);
    const box = loadMailbox(context, mailbox);
    const updated = modifyMessages(context, mailbox, [record], input.labelIds, [], box)[0];
    return { messageId: updated.id, threadId: updated.threadId, labelIds: updated.labelIds };
  },

  "messages.unlabel": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const record = requireMessage(context, mailbox, input.messageId);
    const box = loadMailbox(context, mailbox);
    const updated = modifyMessages(context, mailbox, [record], [], input.labelIds, box)[0];
    return { messageId: updated.id, threadId: updated.threadId, labelIds: updated.labelIds };
  },

  "messages.trash": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const record = requireMessage(context, mailbox, input.id);
    const box = loadMailbox(context, mailbox);
    return minimalMessage(trashMessages(context, mailbox, [record], box)[0]);
  },

  "messages.untrash": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const record = requireMessage(context, mailbox, input.id);
    if (!record.labelIds.includes("TRASH")) precondition(context, "Message is not in the trash.");
    const box = loadMailbox(context, mailbox);
    const updated = applyLabels(context, mailbox, record, ["INBOX"], ["TRASH"], box);
    rebuildThread(context, mailbox, updated.threadId, box);
    saveMailbox(context, box);
    return minimalMessage(updated);
  },

  "messages.send": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const composed = composeInput(context, mailbox, input);
    requireRoom(context, mailbox, "messages");
    const box = loadMailbox(context, mailbox);
    return sendRecord(context, mailbox, box, composed, composed.threadId);
  },

  "attachments.get": (input, context) => {
    const mailbox = mailboxFor(context, input);
    requireMessage(context, mailbox, input.messageId);
    const attachment = context.state.get("attachments", rowId(mailbox, input.id));
    if (attachment === null || attachment.mailbox !== mailbox || attachment.messageId !== input.messageId) notFound(context);
    return { attachmentId: attachment.attachmentId, size: attachment.size, data: attachment.data };
  },

  "threads.list": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const includeTrash = input.includeTrash === true;
    const ast = parseSearch(context, input.query);
    const matches = searchMessages(context, mailbox, { query: input.query, labelIds: input.labelIds, includeSpamTrash: includeTrash });
    const include = includeTrash || reachesTrashOrSpam(ast) || (input.labelIds ?? []).some((id) => id === "TRASH" || id === "SPAM");
    const threadIds = [...new Set(matches.map((record) => record.threadId))];
    const threads = [];
    for (const threadId of threadIds) {
      const thread = context.state.get("threads", rowId(mailbox, threadId));
      if (thread === null) continue;
      const messages = threadMessages(context, mailbox, thread).filter(
        (record) => include || !(record.labelIds.includes("TRASH") || record.labelIds.includes("SPAM")),
      );
      if (messages.length === 0) continue;
      const last = messages[messages.length - 1];
      threads.push({ thread, messages, key: { internalDate: last.internalDate, id: thread.id } });
    }
    threads.sort((left, right) => compareDesc(left.key, right.key));
    const scope = scopeHash(["threads", mailbox, input.query ?? "", input.labelIds ?? [], includeTrash]);
    const anchor = decodeToken(context, input.pageToken, scope);
    // Entries are measured exactly as they are returned: with message summaries, or (withoutMessages, the shape the
    // Gmail REST route renders) as id, snippet and historyId only.
    const withoutMessages = input.withoutMessages === true;
    const page = paginate(threads, anchor, pageSizeOf(input, "pageSize"), scope, (entry) => entry.key, (entry) => ({
      id: entry.thread.id,
      snippet: entry.messages[entry.messages.length - 1].snippet,
      historyId: String(entry.thread.historyId),
      ...(withoutMessages ? {} : { messages: entry.messages.map((record) => summarize(record, false)) }),
    }), (entry) =>
      tooLarge(
        context,
        `the list entry for thread ${entry.thread.id} (${entry.messages.length} message summaries)`,
        "List with withoutMessages: true (id, snippet and historyId per thread, as Gmail's REST threads.list returns) and read that thread's messages one at a time with messages.get.",
      ),
    );
    return {
      threads: page.views,
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      resultSizeEstimate: threads.length,
    };
  },

  "threads.get": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const thread = requireThread(context, mailbox, input.threadId);
    // Gmail's threads.get is unpaged, so the whole thread must fit one response. The byte budget is measured on the
    // shape actually returned: the REST Message rendering when the get-thread route names it (restFormat), otherwise
    // the canonical summaries. A thread that cannot fit is refused before any body is built.
    const restFormat = input.restFormat;
    const full = restFormat !== undefined ? restFormat === "full" : summaryFormat(input);
    const records = threadMessages(context, mailbox, thread);
    const messages = [];
    let bytes = PAGE_OVERHEAD_BYTES + jsonBytes(thread.snippet);
    for (const record of records) {
      const { entry, bytes: size } = threadEntry(record, restFormat, full);
      bytes += size + 1;
      if (bytes > RESPONSE_BUDGET_BYTES) {
        const format = restFormat !== undefined ? `format=${restFormat}` : `messageFormat ${full ? "FULL_CONTENT" : "MINIMAL"}`;
        tooLarge(context, `thread ${thread.id} (${records.length} messages) in ${format}`, threadAdvice(records, restFormat, full));
      }
      messages.push(entry);
    }
    return { id: thread.id, historyId: String(thread.historyId), snippet: thread.snippet, messages };
  },

  "threads.modify": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const thread = requireThread(context, mailbox, input.id);
    const box = loadMailbox(context, mailbox);
    modifyMessages(context, mailbox, threadMessages(context, mailbox, thread), input.addLabelIds, input.removeLabelIds, box);
    return threadResult(context, mailbox, thread.id);
  },

  "threads.label": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const thread = requireThread(context, mailbox, input.threadId);
    const box = loadMailbox(context, mailbox);
    modifyMessages(context, mailbox, threadMessages(context, mailbox, thread), input.labelIds, [], box);
    return { threadId: thread.id, labelIds: requireThread(context, mailbox, thread.id).labelIds };
  },

  "threads.unlabel": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const thread = requireThread(context, mailbox, input.threadId);
    const box = loadMailbox(context, mailbox);
    modifyMessages(context, mailbox, threadMessages(context, mailbox, thread), [], input.labelIds, box);
    return { threadId: thread.id, labelIds: requireThread(context, mailbox, thread.id).labelIds };
  },

  "threads.trash": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const thread = requireThread(context, mailbox, input.id);
    const box = loadMailbox(context, mailbox);
    trashMessages(context, mailbox, threadMessages(context, mailbox, thread), box);
    return threadResult(context, mailbox, thread.id);
  },

  "drafts.list": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const ast = parseSearch(context, input.query);
    const search = matcher(context, mailbox);
    const drafts = [];
    for (const draft of rowsFor(context, "drafts", mailbox)) {
      const record = getMessage(context, mailbox, draft.messageId);
      if (record !== null && matchMessage(ast, record, search)) drafts.push({ draft, record });
    }
    drafts.sort((left, right) => compareDesc(left.record, right.record));
    const scope = scopeHash(["drafts", mailbox, input.query ?? ""]);
    const anchor = decodeToken(context, input.pageToken, scope);
    const page = paginate(drafts, anchor, pageSizeOf(input, "pageSize"), scope, (entry) => entry.record, (entry) =>
      draftView(entry.draft, entry.record),
    (entry) => tooLarge(context, `the list entry for draft ${entry.draft.id}`, "Read the draft with drafts.get."),
    );
    return {
      drafts: page.views,
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      resultSizeEstimate: drafts.length,
    };
  },

  "drafts.get": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const { draft, record } = draftWithMessage(context, mailbox, input.id);
    const format = input.format ?? "full";
    return { id: draft.id, message: restMessage(summarize(record, format === "full"), format, undefined) };
  },

  "drafts.create": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const composed = composeInput(context, mailbox, input);
    requireRoom(context, mailbox, "drafts");
    requireRoom(context, mailbox, "messages");
    const box = loadMailbox(context, mailbox);
    const record = newMessageRecord(context, mailbox, box, composed, ["DRAFT"], composed.threadId);
    const draft = { mailbox, id: draftId(nextSequence(box)), messageId: record.id };
    context.state.put("drafts", rowId(mailbox, draft.id), draft);
    saveMailbox(context, box);
    return draftView(draft, record);
  },

  "drafts.update": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const { draft, record } = draftWithMessage(context, mailbox, input.id);
    const composed = composeInput(context, mailbox, { ...input, id: undefined });
    const box = loadMailbox(context, mailbox);
    // A threadId (or replyToMessageId) on PUT moves the draft into that existing thread, as Gmail does when the
    // request carries threadId plus In-Reply-To/References; the draft's own message can never be its parent.
    const moved = composed.threadId !== undefined && composed.threadId !== record.threadId;
    const threaded = composed.inReplyTo !== undefined && composed.inReplyTo !== record.headers.messageId;
    if (moved) requireThreadRoom(context, mailbox, composed.threadId);
    const headers = {
      ...record.headers,
      to: composed.to,
      cc: composed.cc,
      bcc: composed.bcc,
      subject: composed.subject,
      ...(threaded ? { inReplyTo: composed.inReplyTo, references: composed.references } : {}),
    };
    const updated = {
      ...record,
      threadId: moved ? composed.threadId : record.threadId,
      headers,
      body: composed.body,
      snippet: snippetOf(composed.body.text || composed.body.html || ""),
      sizeEstimate: estimateSize(headers, composed.body, []),
      historyId: bump(box),
      version: record.version + 1,
    };
    context.state.put("messages", rowId(mailbox, record.id), updated);
    if (moved) {
      detachFromThread(context, mailbox, record.threadId, record.id, box);
      attachToThread(context, mailbox, updated.threadId, record.id, box);
    } else {
      rebuildThread(context, mailbox, updated.threadId, box);
    }
    saveMailbox(context, box);
    return draftView(draft, updated);
  },

  "drafts.send": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const { draft, record } = draftWithMessage(context, mailbox, input.id);
    const composed = {
      to: record.headers.to,
      cc: record.headers.cc,
      bcc: record.headers.bcc,
      subject: record.headers.subject,
      body: record.body,
      inReplyTo: record.headers.inReplyTo,
      references: record.headers.references,
    };
    if (composed.to.length + composed.cc.length + composed.bcc.length === 0) invalid(context, "Recipient address required");
    const box = loadMailbox(context, mailbox);
    const threadId = record.threadId;
    const threadHadOthers = requireThread(context, mailbox, threadId).messageIds.length > 1;
    context.state.delete("drafts", rowId(mailbox, draft.id));
    removeMessage(context, mailbox, record, box);
    return sendRecord(context, mailbox, box, composed, threadHadOthers ? threadId : undefined);
  },

  "drafts.delete": (input, context) => {
    const mailbox = mailboxFor(context, input);
    const { draft, record } = draftWithMessage(context, mailbox, input.id);
    const box = loadMailbox(context, mailbox);
    bump(box);
    context.state.delete("drafts", rowId(mailbox, draft.id));
    removeMessage(context, mailbox, record, box);
    saveMailbox(context, box);
    return { id: draft.id, deleted: true };
  },
};

// ---------------------------------------------------------------------------------------------
// HTTP codecs (pure): Gmail REST spelling ⇄ canonical arguments
// ---------------------------------------------------------------------------------------------

function one(query, name) {
  const values = query[name];
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new TypeError(`${name} must be supplied once`);
  return values[0];
}

function integer(query, name, maximum) {
  const value = one(query, name);
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,6}$/.test(value)) throw new TypeError(`${name} must be a positive integer`);
  return Math.min(Number(value), maximum);
}

function boolean(query, name) {
  const value = one(query, name);
  if (value === undefined) return undefined;
  if (value !== "true" && value !== "false") throw new TypeError(`${name} must be true or false`);
  return value === "true";
}

function jsonBody(request) {
  if (request.body.kind === "json") assertJsonDepth(request.body.value);
  if (request.body.kind !== "json" || request.body.value === null || typeof request.body.value !== "object" || Array.isArray(request.body.value)) {
    throw new TypeError("JSON object body required");
  }
  return request.body.value;
}

function optionalJsonBody(request) {
  return request.body.kind === "json" ? jsonBody(request) : {};
}

function userArguments(request) {
  const userId = request.path.userId;
  if (userId === undefined || userId === "") throw new TypeError("userId is required");
  return { userId };
}

function mutation(request, args) {
  const key = one(request.headers, "idempotency-key");
  return key ? { arguments: args, idempotencyKey: key } : { arguments: args };
}

function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function stringList(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError(`${name} must be an array of strings`);
  return value;
}

function labelFields(body) {
  return defined({
    displayName: body.name,
    color: body.color,
    messageListVisibility: body.messageListVisibility,
    labelListVisibility: body.labelListVisibility,
  });
}

function composeFields(body) {
  return defined({
    raw: body.raw,
    threadId: body.threadId,
    to: stringList(body.to, "to"),
    cc: stringList(body.cc, "cc"),
    bcc: stringList(body.bcc, "bcc"),
    subject: body.subject,
    body: body.body,
    htmlBody: body.htmlBody,
    replyToMessageId: body.replyToMessageId,
  });
}

function draftBody(request) {
  const body = jsonBody(request);
  const message = body.message !== undefined && body.message !== null && typeof body.message === "object" ? body.message : body;
  return composeFields(message);
}

function encodeWith(render, emptyOnSuccess = false) {
  return ({ outcome }) => {
    if (outcome.status !== "ok") return gmailError(outcome);
    if (emptyOnSuccess) return { body: { kind: "empty" } };
    return { body: { kind: "json", value: render(outcome.value) } };
  };
}

const passThrough = encodeWith((value) => value);

const formatValue = (query) => {
  const format = one(query, "format");
  if (format === undefined) return undefined;
  if (!["minimal", "metadata", "full", "raw"].includes(format)) throw new TypeError("format must be minimal, metadata, full or raw");
  return format;
};

const http = {
  "get-profile": {
    decode: (request) => ({ arguments: userArguments(request) }),
    // Gmail's Profile resource has no server time: the REST body keeps the four Gmail fields only.
    encode: encodeWith(({ serverTime, ...profile }) => profile),
  },
  "list-labels": {
    // Gmail's users.labels.list is unpaged: ask the operation for every label (system + user) in one page.
    decode: (request) => ({ arguments: { ...userArguments(request), type: "all", pageSize: MAX_LABEL_PAGE } }),
    encode: encodeWith((value) => ({ labels: value.labels.map(restLabel) })),
  },
  "create-label": {
    decode: (request) => mutation(request, { ...userArguments(request), ...labelFields(jsonBody(request)) }),
    encode: encodeWith(restLabel),
  },
  "patch-label": {
    decode: (request) => mutation(request, { ...userArguments(request), labelId: request.path.id ?? "", ...labelFields(jsonBody(request)) }),
    encode: encodeWith(restLabel),
  },
  "update-label": {
    decode: (request) => {
      const body = jsonBody(request);
      if (typeof body.name !== "string") throw new TypeError("name is required for PUT");
      return mutation(request, { ...userArguments(request), labelId: request.path.id ?? "", ...labelFields(body) });
    },
    encode: encodeWith(restLabel),
  },
  "delete-label": {
    decode: (request) => mutation(request, { ...userArguments(request), labelId: request.path.id ?? "" }),
    encode: encodeWith(() => null, true),
  },
  "list-messages": {
    decode: (request) => ({
      arguments: defined({
        ...userArguments(request),
        q: one(request.query, "q"),
        labelIds: request.query.labelIds,
        maxResults: integer(request.query, "maxResults", MAX_PAGE),
        pageToken: one(request.query, "pageToken"),
        includeSpamTrash: boolean(request.query, "includeSpamTrash"),
      }),
    }),
    encode: passThrough,
  },
  "get-message": {
    decode: (request) => ({
      arguments: defined({
        ...userArguments(request),
        id: request.path.id ?? "",
        format: formatValue(request.query),
        metadataHeaders: request.query.metadataHeaders,
      }),
    }),
    encode: passThrough,
  },
  "modify-message": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, defined({
        ...userArguments(request),
        id: request.path.id ?? "",
        addLabelIds: stringList(body.addLabelIds, "addLabelIds"),
        removeLabelIds: stringList(body.removeLabelIds, "removeLabelIds"),
      }));
    },
    encode: passThrough,
  },
  "batch-modify-messages": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, defined({
        ...userArguments(request),
        ids: stringList(body.ids, "ids") ?? [],
        addLabelIds: stringList(body.addLabelIds, "addLabelIds"),
        removeLabelIds: stringList(body.removeLabelIds, "removeLabelIds"),
      }));
    },
    encode: encodeWith(() => null, true),
  },
  "trash-message": {
    decode: (request) => mutation(request, { ...userArguments(request), id: request.path.id ?? "" }),
    encode: passThrough,
  },
  "untrash-message": {
    decode: (request) => mutation(request, { ...userArguments(request), id: request.path.id ?? "" }),
    encode: passThrough,
  },
  "send-message": {
    decode: (request) => mutation(request, { ...userArguments(request), ...composeFields(jsonBody(request)) }),
    encode: passThrough,
  },
  "get-attachment": {
    decode: (request) => ({
      arguments: { ...userArguments(request), messageId: request.path.messageId ?? "", id: request.path.id ?? "" },
    }),
    encode: passThrough,
  },
  "list-threads": {
    decode: (request) => ({
      arguments: defined({
        ...userArguments(request),
        query: one(request.query, "q"),
        labelIds: request.query.labelIds,
        pageSize: integer(request.query, "maxResults", MAX_PAGE),
        pageToken: one(request.query, "pageToken"),
        includeTrash: boolean(request.query, "includeSpamTrash"),
        // Gmail's REST threads.list returns id, snippet and historyId only; page on that shape.
        withoutMessages: true,
      }),
    }),
    encode: encodeWith((value) => ({
      threads: value.threads.map((thread) => ({ id: thread.id, snippet: thread.snippet, historyId: thread.historyId })),
      ...(value.nextPageToken !== undefined ? { nextPageToken: value.nextPageToken } : {}),
      resultSizeEstimate: value.resultSizeEstimate,
    })),
  },
  "get-thread": {
    decode: (request) => {
      const format = formatValue(request.query) ?? "full";
      if (format === "raw") throw new TypeError("format=raw is not supported");
      return {
        arguments: {
          ...userArguments(request),
          threadId: request.path.id ?? "",
          messageFormat: format === "full" ? "FULL_CONTENT" : "MINIMAL",
          ...(format === "metadata" ? { metadataOnly: true } : {}),
          // The operation measures its byte budget on this REST rendering.
          restFormat: format,
        },
      };
    },
    encode: ({ invocation, outcome }) => {
      if (outcome.status !== "ok") return gmailError(outcome);
      const format = invocation.arguments.restFormat ?? "full";
      return {
        body: {
          kind: "json",
          value: {
            id: outcome.value.id,
            historyId: outcome.value.historyId,
            messages: outcome.value.messages.map((summary) => restMessage(summary, format, undefined)),
          },
        },
      };
    },
  },
  "modify-thread": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, defined({
        ...userArguments(request),
        id: request.path.id ?? "",
        addLabelIds: stringList(body.addLabelIds, "addLabelIds"),
        removeLabelIds: stringList(body.removeLabelIds, "removeLabelIds"),
      }));
    },
    encode: passThrough,
  },
  "trash-thread": {
    decode: (request) => mutation(request, { ...userArguments(request), id: request.path.id ?? "" }),
    encode: passThrough,
  },
  "list-drafts": {
    decode: (request) => ({
      arguments: defined({
        ...userArguments(request),
        query: one(request.query, "q"),
        pageSize: integer(request.query, "maxResults", MAX_PAGE),
        pageToken: one(request.query, "pageToken"),
      }),
    }),
    encode: encodeWith((value) => ({
      drafts: value.drafts.map((draft) => ({ id: draft.id, message: { id: draft.messageId, threadId: draft.threadId } })),
      ...(value.nextPageToken !== undefined ? { nextPageToken: value.nextPageToken } : {}),
      resultSizeEstimate: value.resultSizeEstimate,
    })),
  },
  "get-draft": {
    decode: (request) => ({
      arguments: defined({ ...userArguments(request), id: request.path.id ?? "", format: formatValue(request.query) }),
    }),
    encode: passThrough,
  },
  "create-draft": {
    decode: (request) => mutation(request, { ...userArguments(request), ...draftBody(request) }),
    encode: encodeWith((draft) => ({ id: draft.id, message: { id: draft.messageId, threadId: draft.threadId, labelIds: ["DRAFT"] } })),
  },
  "update-draft": {
    decode: (request) => mutation(request, { ...userArguments(request), id: request.path.id ?? "", ...draftBody(request) }),
    encode: encodeWith((draft) => ({ id: draft.id, message: { id: draft.messageId, threadId: draft.threadId, labelIds: ["DRAFT"] } })),
  },
  "send-draft": {
    decode: (request) => {
      const body = jsonBody(request);
      if (typeof body.id !== "string") throw new TypeError("id is required");
      return mutation(request, { ...userArguments(request), id: body.id });
    },
    encode: passThrough,
  },
  "delete-draft": {
    decode: (request) => mutation(request, { ...userArguments(request), id: request.path.id ?? "" }),
    encode: encodeWith(() => null, true),
  },
};

export default { operations, http };
