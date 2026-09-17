// Synthetic Google Docs for a few in-world Workspace users: the documents themselves through the Docs API v1 shapes,
// and the Drive API v3 endpoints a Docs agent cannot avoid (find, rename, trash, copy, export, share, comment, history)
// restricted to files whose mimeType is application/vnd.google-apps.document.
//
// Every operation computes from context.state; nothing is canned and nothing leaves the world. Handlers are
// synchronous, ids come from the `meta/counters` row, timestamps from the virtual clock, and there is no randomness.

import {
  DOCUMENT_ID,
  DOCUMENT_MIME,
  DOMAIN,
  EXPORT_MIMES,
  RFC3339,
  commentIdFor,
  commentRowId,
  compareText,
  decodePageToken,
  docsRevisionIdFor,
  documentIdFor,
  domainOf,
  driveRevisionIdFor,
  encodePageToken,
  exportLinkFor,
  headingIdFor,
  iconLinkFor,
  isEmail,
  listIdFor,
  namedRangeIdFor,
  normalizeEmail,
  permissionRowId,
  replyRowId,
  revisionRowId,
  stableJson,
  userDocRowId,
  webViewLinkFor,
} from "./lib/ids.mjs";
import {
  documentStyle,
  indexMap,
  newParagraph,
  renderBlocks,
  renderLists,
  renderNamedRanges,
  renderNamedStyles,
  textBetween,
} from "./lib/doc-model.mjs";
import { RequestError, applyRequests } from "./lib/requests.mjs";
import { QueryError, matchQuery, parseQuery } from "./lib/query.mjs";
import { FieldsError } from "./lib/fields.mjs";
import { assertJsonDepth } from "./lib/json-depth.mjs";
import { escapeHtml, jsonByteLength, renderExport, utf8ByteLength, verbalize } from "./lib/text.mjs";
import {
  maskResource,
  parseMask,
  restAbout,
  restDocument,
  restRevision,
  restRevisionList,
  docsError,
  driveError,
  withoutUndefined,
} from "./lib/wire.mjs";

const SCAN_STEP = 1000;
const HARD_SCAN_CAP = 10_000;
const DEFAULT_LIMITS = {
  maxDocuments: 200,
  maxTextLength: 120_000,
  maxBlocks: 2000,
  maxTables: 50,
  maxTableRows: 20,
  maxTableColumns: 20,
  maxNamedRanges: 100,
  maxPermissions: 100,
  maxComments: 500,
  maxReplies: 100,
  maxRevisions: 200,
  maxRequestsPerBatch: 100,
  maxScanRows: 10_000,
  maxResponseBytes: 900_000,
};
// The framework refuses any HTTP response over 1 MiB with an opaque 500 after the operation has committed. Every
// response whose size callers control is therefore budgeted in UTF-8 bytes below that: 900 KB by default, and never
// less than the floor, which keeps every single file, permission, reply and revision resource (bounded by the state
// schemas to well under 64 KB) admissible on a page of its own.
const RESPONSE_BYTE_CAP = 900_000;
const RESPONSE_BYTE_FLOOR = 65_536;
// A page envelope: kind, the list key, brackets, commas and a nextPageToken (scope-bound, so bounded by the q/orderBy
// lengths it embeds) — measured per page on top of the entries.
const PAGE_ENVELOPE_BYTES = 256;
// Comment edits can grow a thread after its replies were admitted: reserve the worst-case comment content (4096 UTF-16
// units, each at most 6 bytes as JSON \u escapes in `content` and 6 as HTML entities in `htmlContent`).
const COMMENT_EDIT_HEADROOM_BYTES = 4096 * 12;
// The document title varies with files.update renames and files.copy names; it is counted at its worst (512 units x
// 6 bytes, present twice with includeTabsContent) so a rename can never push a committed document past its budget.
const TITLE_HEADROOM_BYTES = 2 * 512 * 6;
const EMPTY_COUNTERS = {
  documentSequence: 0,
  permissionSequence: 0,
  commentSequence: 0,
  replySequence: 0,
  revisionSequence: 0,
  listSequence: 0,
  namedRangeSequence: 0,
  headingSequence: 0,
  userSequence: 0,
};
const RANK = { reader: 1, commenter: 2, writer: 3, owner: 4 };
const SHARE_ROLES = ["writer", "commenter", "reader"];
const PERMISSION_TYPES = ["user", "group", "domain", "anyone"];
const ORDER_KEYS = ["createdTime", "modifiedTime", "name", "name_natural", "starred", "viewedByMeTime", "sharedWithMeTime"];
const DEFAULT_ORDER = "modifiedTime desc";
const SUGGESTIONS_VIEW_MODES = ["DEFAULT_FOR_CURRENT_ACCESS", "PREVIEW_WITHOUT_SUGGESTIONS"];
const TAB_ID = "t.0";

// ---------------------------------------------------------------------------------------------
// Declared failures. `details` carries what each envelope needs: Drive's reason/location, Docs' field path.
// ---------------------------------------------------------------------------------------------

const invalidDrive = (s, message, reason = "invalid", location) =>
  s.context.fail({ code: "INVALID_ARGUMENT", message, details: withoutUndefined({ reason, location }) });
const invalidDocs = (s, message, field) =>
  s.context.fail({ code: "INVALID_ARGUMENT", message, details: withoutUndefined({ field }) });
/**
 * A REST query value the codec could not coerce (`pageSize=abc`, `starred=maybe`). The codec forwards it as
 * `invalidParameter` instead of throwing, so the refusal is Drive's own `400 invalid` on the parameter (not the
 * framework's request-mapping envelope). Name and value are clipped by the codec; nothing else from the caller is echoed.
 */
const rejectInvalidParameter = (s, parameter) => {
  if (parameter === undefined) return;
  const message =
    parameter.kind === "boolean"
      ? `Invalid boolean value: '${parameter.value}'.`
      : `Invalid value '${parameter.value}'. Values must match the following regular expression: '^-?[0-9]+$'`;
  invalidDrive(s, message, "invalid", parameter.name);
};
/** The Docs API variant: google.rpc INVALID_ARGUMENT naming the proto field (`Invalid value at 'include_tabs_content' (TYPE_BOOL), "x"`). */
const rejectInvalidDocsParameter = (s, parameter) => {
  if (parameter === undefined) return;
  const proto = parameter.name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  const type = parameter.kind === "boolean" ? "TYPE_BOOL" : "TYPE_INT32";
  invalidDocs(s, `Invalid value at '${proto}' (${type}), "${parameter.value}"`, parameter.name);
};
const notFoundFile = (s, id) =>
  s.context.fail({ code: "NOT_FOUND", message: `File not found: ${id}.`, details: { reason: "notFound", location: "fileId" } });
const notFoundDoc = (s) => s.context.fail({ code: "NOT_FOUND", message: "Requested entity was not found." });
const notFoundOther = (s, message, location) =>
  s.context.fail({ code: "NOT_FOUND", message, details: withoutUndefined({ reason: "notFound", location }) });
const denied = (s, message) => s.context.fail({ code: "PERMISSION_DENIED", message });
const precondition = (s, message, field) =>
  s.context.fail({ code: "FAILED_PRECONDITION", message, details: withoutUndefined({ reason: "badRequest", field }) });
const invalidPageToken = (s) => s.context.fail({ code: "INVALID_PAGE_TOKEN", message: "Invalid Value" });
const invalidSharing = (s, message) =>
  s.context.fail({ code: "INVALID_SHARING_REQUEST", message: `Bad Request. User message: "${message}"` });
const notExportable = (s, mimeType) =>
  s.context.fail({
    code: "NOT_EXPORTABLE",
    message: `Export only supports ${EXPORT_MIMES.join(", ")} for a Google Docs document; ${mimeType} is not available.`,
  });

// ---------------------------------------------------------------------------------------------
// Session: identity, virtual clock, limits, counters
// ---------------------------------------------------------------------------------------------

function isoOf(ms) {
  return new Date(ms).toISOString();
}

function parseTime(value) {
  if (typeof value !== "string" || !RFC3339.test(value)) return undefined;
  let text = value;
  if (text.length === 10) text = `${text}T00:00:00Z`;
  else if (!/(Z|[+-]\d{2}:\d{2})$/.test(text)) text = `${text}Z`;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * The user a caller without an `email` attribute acts as: the primary seeded user, i.e. the lowest `users` row id
 * (Dana in the starter data). A world with no `users` row at all falls back to `<actorId>@example.test`.
 */
function defaultEmail(context) {
  const first = context.state.scan("users", { limit: 1 });
  return first.length > 0 ? first[0].value.emailAddress : `${context.actor.id}@example.test`;
}

function session(context) {
  const attributes = context.actor.attributes;
  const explicit = typeof attributes.email === "string" && attributes.email.includes("@");
  const email = normalizeEmail(explicit ? attributes.email : defaultEmail(context));
  const displayName =
    typeof attributes.displayName === "string" && attributes.displayName.length > 0 ? attributes.displayName.slice(0, 100) : undefined;
  const nowMs = Math.floor(context.clock.nowUs() / 1000);
  const limitsRow = context.state.get("meta", "limits");
  const limits = { ...DEFAULT_LIMITS };
  if (limitsRow !== null) {
    for (const key of Object.keys(DEFAULT_LIMITS)) if (typeof limitsRow[key] === "number") limits[key] = limitsRow[key];
  }
  limits.maxScanRows = Math.min(limits.maxScanRows, HARD_SCAN_CAP);
  limits.maxResponseBytes = Math.min(Math.max(limits.maxResponseBytes, RESPONSE_BYTE_FLOOR), RESPONSE_BYTE_CAP);
  return {
    context,
    email,
    domain: domainOf(email),
    displayNameOverride: displayName,
    nowMs,
    now: isoOf(nowMs),
    limits,
    counters: null,
    countersDirty: false,
    users: new Map(),
  };
}

function counters(s) {
  if (s.counters === null) {
    const row = s.context.state.get("meta", "counters");
    s.counters = { ...EMPTY_COUNTERS, ...(row ?? {}) };
  }
  return s.counters;
}

function nextCounter(s, name) {
  const all = counters(s);
  all[name] += 1;
  s.countersDirty = true;
  return all[name];
}

function flushCounters(s) {
  if (s.countersDirty) {
    s.context.state.put("meta", "counters", { ...counters(s) });
    s.countersDirty = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Bounded scans
// ---------------------------------------------------------------------------------------------

function scanBounded(s, namespace, prefix) {
  const rows = [];
  let after = prefix ?? "";
  for (;;) {
    const batch = s.context.state.scan(namespace, after.length === 0 ? { limit: SCAN_STEP } : { afterRowId: after, limit: SCAN_STEP });
    if (batch.length === 0) return rows;
    for (const row of batch) {
      if (prefix !== undefined && !row.rowId.startsWith(prefix)) return rows;
      rows.push(row);
      if (rows.length > s.limits.maxScanRows) {
        precondition(s, `state exceeds the supported bound of ${s.limits.maxScanRows} rows for a single read`);
      }
    }
    if (batch.length < SCAN_STEP) return rows;
    after = batch[batch.length - 1].rowId;
  }
}

// ---------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------

function nameFromEmail(email) {
  const local = email.slice(0, email.indexOf("@"));
  return local
    .split(/[._-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function userRow(s, email) {
  if (s.users.has(email)) return s.users.get(email);
  const row = s.context.state.get("users", email);
  s.users.set(email, row);
  return row;
}

/** A `drive#user` view of an address, whether or not it has a `users` row. */
function userView(s, email, { me = undefined } = {}) {
  const normalized = normalizeEmail(email);
  const row = userRow(s, normalized);
  const isMe = me ?? normalized === s.email;
  const displayName =
    isMe && s.displayNameOverride !== undefined ? s.displayNameOverride : (row?.displayName ?? nameFromEmail(normalized));
  return {
    kind: "drive#user",
    displayName,
    emailAddress: normalized,
    me: isMe,
    permissionId: row?.permissionId ?? `00${"0".repeat(18)}`,
  };
}

/** Materialises the caller's `users` row on a fresh install so a grant-only actor is a real account. */
function ensureCallerUser(s) {
  const existing = userRow(s, s.email);
  if (existing !== null && existing !== undefined) return existing;
  const row = {
    emailAddress: s.email,
    displayName: s.displayNameOverride ?? nameFromEmail(s.email),
    permissionId: `06${String(nextCounter(s, "userSequence")).padStart(18, "0")}`,
    domain: s.domain,
    storageQuotaLimit: 16_106_127_360,
  };
  s.context.state.put("users", s.email, row);
  s.users.set(s.email, row);
  flushCounters(s);
  return row;
}

function permissionIdForGrantee(s, type, emailAddress, domain) {
  if (type === "anyone") return "anyoneWithLink";
  if (type === "domain") return `07${String(nextCounter(s, "permissionSequence")).padStart(18, "0")}`;
  const row = userRow(s, emailAddress);
  if (row !== null && row !== undefined) return row.permissionId;
  return `07${String(nextCounter(s, "permissionSequence")).padStart(18, "0")}`;
}

// ---------------------------------------------------------------------------------------------
// Documents, permissions and access
// ---------------------------------------------------------------------------------------------

function documentRow(s, documentId) {
  if (typeof documentId !== "string" || documentId.length === 0 || documentId.length > 128) return null;
  return s.context.state.get("documents", documentId);
}

function permissionRows(s, documentId) {
  return scanBounded(s, "permissions", `${documentId}:`).map((row) => row.value);
}

function rankFor(document, permissions, email, domain) {
  if (document.ownerEmail === email) return RANK.owner;
  let best = 0;
  for (const permission of permissions) {
    let matches = false;
    if ((permission.type === "user" || permission.type === "group") && permission.emailAddress === email) matches = true;
    else if (permission.type === "domain" && permission.domain === domain) matches = true;
    else if (permission.type === "anyone") matches = true;
    if (matches) best = Math.max(best, RANK[permission.role] ?? 0);
  }
  return best;
}

/** Resolves a document the caller can see, or fails NOT_FOUND exactly as Google does for an inaccessible id. */
function openDocument(s, documentId, minimumRank, { docsEnvelope = false } = {}) {
  const document = documentRow(s, documentId);
  if (document === null) {
    if (docsEnvelope) notFoundDoc(s);
    notFoundFile(s, String(documentId));
  }
  const permissions = permissionRows(s, documentId);
  const rank = rankFor(document, permissions, s.email, s.domain);
  if (rank === 0) {
    if (docsEnvelope) notFoundDoc(s);
    notFoundFile(s, documentId);
  }
  if (rank < minimumRank) {
    denied(
      s,
      minimumRank >= RANK.owner
        ? "Only the owner of this document may perform this action."
        : "The user does not have sufficient permissions for this file.",
    );
  }
  return { document, permissions, rank };
}

function capabilitiesFor(document, rank) {
  const owner = rank === RANK.owner;
  return {
    canEdit: rank >= RANK.writer && !document.trashed,
    canComment: rank >= RANK.commenter && !document.trashed,
    canShare: owner,
    canCopy: rank >= RANK.reader && !document.trashed,
    canDelete: owner,
    canTrash: owner && !document.trashed,
    canUntrash: owner && document.trashed,
    canRename: rank >= RANK.writer,
    canReadRevisions: rank >= RANK.reader,
    canModifyContent: rank >= RANK.writer && !document.trashed,
  };
}

function userDoc(s, email, documentId) {
  return s.context.state.get("user-docs", userDocRowId(email, documentId));
}

function patchUserDoc(s, email, documentId, patch) {
  const existing = userDoc(s, email, documentId) ?? { emailAddress: email, documentId, starred: false };
  const value = { ...existing, ...patch };
  s.context.state.put("user-docs", userDocRowId(email, documentId), value);
  return value;
}

function bodyRow(s, documentId) {
  const row = s.context.state.get("bodies", documentId);
  return row === null ? { documentId, blocks: [{ kind: "sectionBreak" }, newParagraph({ namedStyleType: "NORMAL_TEXT" })], namedRanges: [], lists: [] } : row;
}

function workingCopy(row) {
  return JSON.parse(JSON.stringify({ blocks: row.blocks, namedRanges: row.namedRanges ?? [], lists: row.lists ?? [] }));
}

// ---------------------------------------------------------------------------------------------
// REST resource rendering
// ---------------------------------------------------------------------------------------------

function permissionResource(permission) {
  return withoutUndefined({
    kind: "drive#permission",
    id: permission.id,
    type: permission.type,
    role: permission.role,
    emailAddress: permission.emailAddress,
    domain: permission.domain,
    displayName: permission.displayName,
    allowFileDiscovery: permission.allowFileDiscovery,
    deleted: false,
    pendingOwner: false,
  });
}

function fileResource(s, document, permissions, rank, { includePermissions = true } = {}) {
  const mine = userDoc(s, s.email, document.documentId);
  const shared = permissions.some((permission) => permission.role !== "owner");
  return withoutUndefined({
    kind: "drive#file",
    id: document.documentId,
    name: document.title,
    mimeType: DOCUMENT_MIME,
    description: document.description,
    starred: mine?.starred === true,
    trashed: document.trashed,
    explicitlyTrashed: document.explicitlyTrashed,
    trashedTime: document.trashedTime,
    createdTime: document.createdTime,
    modifiedTime: document.modifiedTime,
    modifiedByMe: mine?.modifiedByMeTime !== undefined,
    modifiedByMeTime: mine?.modifiedByMeTime,
    viewedByMe: mine?.viewedByMeTime !== undefined,
    viewedByMeTime: mine?.viewedByMeTime,
    sharedWithMeTime: mine?.sharedWithMeTime,
    sharingUser: mine?.sharingUserEmail === undefined ? undefined : userView(s, mine.sharingUserEmail),
    owners: [userView(s, document.ownerEmail)],
    lastModifyingUser: userView(s, document.lastModifyingUser),
    shared,
    ownedByMe: document.ownerEmail === s.email,
    capabilities: capabilitiesFor(document, rank),
    permissions: includePermissions && rank >= RANK.writer ? permissions.map(permissionResource) : undefined,
    permissionIds: permissions.map((permission) => permission.id),
    version: String(document.version),
    webViewLink: webViewLinkFor(document.documentId),
    iconLink: iconLinkFor(),
    exportLinks: Object.fromEntries(EXPORT_MIMES.map((mimeType) => [mimeType, exportLinkFor(document.documentId, mimeType)])),
    quotaBytesUsed: "0",
    size: String(document.textLength),
    isAppAuthorized: false,
    hasThumbnail: false,
    spaces: ["drive"],
  });
}

function commentResource(s, comment, replies) {
  return withoutUndefined({
    kind: "drive#comment",
    id: comment.id,
    createdTime: comment.createdTime,
    modifiedTime: comment.modifiedTime,
    author: userView(s, comment.authorEmail),
    htmlContent: escapeHtml(comment.content),
    content: comment.content,
    deleted: comment.deleted,
    resolved: comment.resolved,
    anchor: comment.anchor,
    quotedFileContent: comment.quotedText === undefined ? undefined : { mimeType: "text/html", value: comment.quotedText },
    replies: replies.map((reply) => replyResource(s, reply)),
  });
}

function replyResource(s, reply) {
  return withoutUndefined({
    kind: "drive#reply",
    id: reply.id,
    createdTime: reply.createdTime,
    modifiedTime: reply.modifiedTime,
    author: userView(s, reply.authorEmail),
    htmlContent: escapeHtml(reply.content),
    content: reply.content,
    deleted: reply.deleted,
    action: reply.action,
  });
}

function revisionResource(s, revision) {
  return {
    kind: "drive#revision",
    id: revision.id,
    mimeType: DOCUMENT_MIME,
    modifiedTime: revision.modifiedTime,
    lastModifyingUser: userView(s, revision.lastModifyingUser),
    keepForever: revision.keepForever,
    published: revision.published,
    publishAuto: false,
    publishedOutsideDomain: false,
    exportLinks: Object.fromEntries(EXPORT_MIMES.map((mimeType) => [mimeType, exportLinkFor(revision.documentId, mimeType)])),
    docsRevisionId: revision.docsRevisionId,
    requestTypes: revision.requestTypes,
    textLength: revision.textLength,
  };
}

function documentResource(s, document, body, { includeTabsContent = false, suggestionsViewMode } = {}) {
  const tabContent = {
    body: { content: renderBlocks(body.blocks, 0) },
    documentStyle: documentStyle(),
    namedStyles: renderNamedStyles(),
    namedRanges: renderNamedRanges(body.namedRanges ?? []),
    lists: renderLists(body.lists ?? []),
    inlineObjects: {},
    positionedObjects: {},
    headers: {},
    footers: {},
    footnotes: {},
  };
  const resource = {
    documentId: document.documentId,
    title: document.title,
    revisionId: document.revisionId,
    suggestionsViewMode: suggestionsViewMode ?? "DEFAULT_FOR_CURRENT_ACCESS",
    ...tabContent,
    content: verbalize(body.blocks),
  };
  if (includeTabsContent) {
    resource.tabs = [
      {
        tabProperties: { tabId: TAB_ID, title: document.title, index: 0, nestingLevel: 0 },
        documentTab: tabContent,
      },
    ];
  }
  return resource;
}

// ---------------------------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------------------------

function checkFields(s, fields, vocabulary, envelope = "drive") {
  if (fields === undefined) return;
  try {
    parseMask(fields, vocabulary);
  } catch (error) {
    if (error instanceof FieldsError) {
      if (envelope === "docs") invalidDocs(s, error.message, "fields");
      invalidDrive(s, error.message, "invalidParameter", "fields");
    }
    throw error;
  }
}

function pageSizeOf(s, value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    invalidDrive(s, `pageSize must be between 1 and ${maximum}.`, "invalidParameter", "pageSize");
  }
  return value;
}

/** Compares two sort tuples position by position (numbers numerically, text by compareText), each position in its direction. */
function compareTuples(left, right, descending) {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    let comparison = typeof a === "number" && typeof b === "number" ? (a < b ? -1 : a > b ? 1 : 0) : compareText(a, b);
    if (descending[index] === true) comparison = -comparison;
    if (comparison !== 0) return comparison;
  }
  return 0;
}

/** A list order: `tupleOf(item)` is the full sort tuple ending in the unique id, `descending` the direction of each position. */
function listOrder(tupleOf, descending) {
  return { tupleOf, descending, compare: (left, right) => compareTuples(tupleOf(left), tupleOf(right), descending) };
}

const MAX_TOKEN_TEXT = 4096;
const COMMENT_ORDER = listOrder((comment) => [comment.modifiedTime, comment.id], [true, false]);
const REPLY_ORDER = listOrder((reply) => [reply.id], [false]);
const REVISION_ORDER = listOrder((revision) => [Number(revision.id)], [false]);

function validTuple(value, length) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((part) => (typeof part === "string" && part.length <= MAX_TOKEN_TEXT) || (typeof part === "number" && Number.isFinite(part)))
  );
}

/**
 * One page of `items` (already filtered and sorted with `order.compare`), rendered with `render` and bounded by count and
 * by the UTF-8 size of the encoded page. The token carries the full sort tuple of the last entry returned (order values
 * plus the id tiebreak), and the next page starts at the first entry that sorts strictly after it — so the continuation
 * survives that entry being renamed, re-sorted or deleted between pages, exactly like a cursor over live data. A page that
 * fills its byte budget ends early. An entry too large for a page of its own fails with FAILED_PRECONDITION when
 * `refuseOversized`; the other lists hold only entries the schema floor always admits.
 */
function paginate(s, items, order, pageSize, pageToken, scope, render, { refuseOversized = false } = {}) {
  let start = 0;
  if (pageToken !== undefined) {
    const after = decodePageToken(pageToken, scope);
    if (after === null || !validTuple(after, order.descending.length)) invalidPageToken(s);
    start = items.findIndex((item) => compareTuples(order.tupleOf(item), after, order.descending) > 0);
    if (start < 0) start = items.length;
  }
  const budget = s.limits.maxResponseBytes;
  // The token is written once in the page and may be echoed once more by a caller-side envelope: counted twice.
  const tokenBytes = (item) => 2 * jsonByteLength(encodePageToken(scope, order.tupleOf(item)));
  let used = PAGE_ENVELOPE_BYTES;
  const page = [];
  let next = start;
  while (next < items.length && page.length < pageSize) {
    const resource = render(items[next]);
    const bytes = jsonByteLength(resource) + 1;
    const withToken = next + 1 < items.length ? tokenBytes(items[next]) : 0;
    if (used + bytes + withToken > budget && (page.length > 0 || refuseOversized)) {
      if (page.length === 0) {
        precondition(s, `state exceeds the supported bound of ${budget} bytes for one response: a single entry is too large to return`);
      }
      break;
    }
    used += bytes;
    page.push(resource);
    next += 1;
  }
  const nextPageToken = next < items.length && page.length > 0 ? encodePageToken(scope, order.tupleOf(items[next - 1])) : undefined;
  return { page, nextPageToken };
}

/** UTF-8 size of the largest documents.get response for this body (canonical, includeTabsContent), title at its worst. */
function documentGetBytes(s, document, body) {
  const probe = documentResource(s, { ...document, title: "" }, body, {
    includeTabsContent: true,
    suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS",
  });
  return jsonByteLength(probe) + TITLE_HEADROOM_BYTES;
}

function documentBytesMessage(s) {
  return `state exceeds the supported bound of ${s.limits.maxResponseBytes} bytes for the documents.get response of one document`;
}

function requireDocsId(s, documentId) {
  if (typeof documentId !== "string" || !DOCUMENT_ID.test(documentId)) notFoundDoc(s);
}

// ---------------------------------------------------------------------------------------------
// Document creation helpers
// ---------------------------------------------------------------------------------------------

function countDocuments(s) {
  return scanBounded(s, "documents").length;
}

function appendRevision(s, document, requestTypes, textLength) {
  const number = document.headRevisionNumber;
  if (number > s.limits.maxRevisions) {
    precondition(s, `state exceeds the supported bound of ${s.limits.maxRevisions} revisions per document`);
  }
  s.context.state.put("revisions", revisionRowId(document.documentId, number), {
    documentId: document.documentId,
    id: driveRevisionIdFor(number),
    docsRevisionId: document.revisionId,
    modifiedTime: document.modifiedTime,
    lastModifyingUser: document.lastModifyingUser,
    requestTypes,
    textLength,
    keepForever: false,
    published: false,
  });
}

function createDocument(s, { title, blocks, namedRanges, lists, source, sourceDocumentId, description, starred }) {
  if (countDocuments(s) >= s.limits.maxDocuments) {
    precondition(s, `state exceeds the supported bound of ${s.limits.maxDocuments} documents per world`);
  }
  ensureCallerUser(s);
  const documentId = documentIdFor(nextCounter(s, "documentSequence"));
  const revisionId = docsRevisionIdFor(nextCounter(s, "revisionSequence"));
  const text = verbalize(blocks);
  const document = withoutUndefined({
    documentId,
    title,
    ownerEmail: s.email,
    description,
    trashed: false,
    explicitlyTrashed: false,
    createdTime: s.now,
    modifiedTime: s.now,
    lastModifyingUser: s.email,
    revisionId,
    headRevisionNumber: 1,
    version: 1,
    textLength: text.length,
    commentCount: 0,
    openCommentCount: 0,
  });
  s.context.state.put("documents", documentId, document);
  s.context.state.put("bodies", documentId, { documentId, blocks, namedRanges, lists });
  const ownerUser = userRow(s, s.email);
  s.context.state.put("permissions", permissionRowId(documentId, ownerUser.permissionId), {
    documentId,
    id: ownerUser.permissionId,
    type: "user",
    role: "owner",
    emailAddress: s.email,
    displayName: ownerUser.displayName,
    createdTime: s.now,
  });
  appendRevision(s, document, source === "copy" ? ["copy"] : ["create"], text.length);
  patchUserDoc(s, s.email, documentId, {
    starred: starred === true,
    viewedByMeTime: s.now,
    modifiedByMeTime: s.now,
  });
  flushCounters(s);
  s.context.events.emit(
    "document.created",
    withoutUndefined({ documentId, title, ownerEmail: s.email, actorEmail: s.email, source, sourceDocumentId }),
  );
  return document;
}

function deleteDocumentRows(s, documentId) {
  s.context.state.delete("documents", documentId);
  s.context.state.delete("bodies", documentId);
  for (const row of scanBounded(s, "permissions", `${documentId}:`)) s.context.state.delete("permissions", row.rowId);
  for (const row of scanBounded(s, "comments", `${documentId}:`)) s.context.state.delete("comments", row.rowId);
  for (const row of scanBounded(s, "replies", `${documentId}:`)) s.context.state.delete("replies", row.rowId);
  for (const row of scanBounded(s, "revisions", `${documentId}:`)) s.context.state.delete("revisions", row.rowId);
  for (const row of scanBounded(s, "user-docs")) {
    if (row.value.documentId === documentId) s.context.state.delete("user-docs", row.rowId);
  }
}

// ---------------------------------------------------------------------------------------------
// Comments and replies
// ---------------------------------------------------------------------------------------------

function commentRows(s, documentId) {
  return scanBounded(s, "comments", `${documentId}:`).map((row) => row.value);
}

function replyRows(s, documentId, commentId) {
  return scanBounded(s, "replies", `${documentId}:${commentId}:`).map((row) => row.value);
}

function openComment(s, documentId, commentId, includeDeleted) {
  const comment = s.context.state.get("comments", commentRowId(documentId, commentId));
  if (comment === null || (comment.deleted && includeDeleted !== true)) {
    notFoundOther(s, `Comment not found: ${commentId}.`, "commentId");
  }
  return comment;
}

function recountComments(s, documentId) {
  const comments = commentRows(s, documentId).filter((comment) => !comment.deleted);
  return { commentCount: comments.length, openCommentCount: comments.filter((comment) => !comment.resolved).length };
}

function saveCommentCounts(s, document) {
  const counts = recountComments(s, document.documentId);
  s.context.state.put("documents", document.documentId, { ...document, ...counts });
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

const operations = {
  "about.get": (input, context) => {
    const s = session(context);
    checkFields(s, input.fields, "about");
    const user = ensureCallerUser(s);
    const documents = scanBounded(s, "documents");
    let usage = 0;
    let trash = 0;
    for (const row of documents) {
      if (row.value.ownerEmail !== s.email) continue;
      usage += row.value.textLength;
      if (row.value.trashed) trash += row.value.textLength;
    }
    return {
      kind: "drive#about",
      user: userView(s, s.email, { me: true }),
      storageQuota: {
        limit: String(user.storageQuotaLimit),
        usage: String(usage),
        usageInDrive: String(usage),
        usageInTrash: String(trash),
      },
      importFormats: {},
      exportFormats: { [DOCUMENT_MIME]: [...EXPORT_MIMES] },
      maxImportSizes: {},
      maxUploadSize: "0",
      appInstalled: false,
      canCreateDrives: false,
      serverTime: s.now,
      limits: { ...s.limits },
    };
  },

  "documents.get": (input, context) => {
    const s = session(context);
    rejectInvalidDocsParameter(s, input.invalidParameter);
    if (input.suggestionsViewMode !== undefined && !SUGGESTIONS_VIEW_MODES.includes(input.suggestionsViewMode)) {
      invalidDocs(s, `Suggestions view mode ${input.suggestionsViewMode} is not supported.`, "suggestionsViewMode");
    }
    if (input.tabId !== undefined && input.tabId !== TAB_ID) {
      invalidDocs(s, `This document has a single tab (${TAB_ID}); unknown tabId ${input.tabId}.`, "tabId");
    }
    requireDocsId(s, input.documentId);
    const { document } = openDocument(s, input.documentId, RANK.reader, { docsEnvelope: true });
    const body = bodyRow(s, document.documentId);
    if (documentGetBytes(s, document, body) > s.limits.maxResponseBytes) precondition(s, documentBytesMessage(s), "documentId");
    // A read is not the user opening the file: `viewedByMeTime` moves only through files.update (the app's explicit
    // open) and the caller's own create, copy and batch-update writes.
    return documentResource(s, document, body, {
      includeTabsContent: input.includeTabsContent === true,
      suggestionsViewMode: input.suggestionsViewMode,
    });
  },

  "documents.create": (input, context) => {
    const s = session(context);
    const title = input.title === undefined ? "Untitled document" : input.title;
    if (typeof title !== "string" || title.length === 0 || title.length > 512) {
      invalidDocs(s, "title must be between 1 and 512 characters.", "title");
    }
    const document = createDocument(s, {
      title,
      blocks: [{ kind: "sectionBreak" }, newParagraph({ namedStyleType: "NORMAL_TEXT" })],
      namedRanges: [],
      lists: [],
      source: "create",
    });
    return documentResource(s, document, bodyRow(s, document.documentId));
  },

  "documents.batch-update": (input, context) => {
    const s = session(context);
    const requests = input.requests ?? [];
    if (!Array.isArray(requests) || requests.length === 0) {
      invalidDocs(s, "At least one request is required.", "requests");
    }
    if (requests.length > s.limits.maxRequestsPerBatch) {
      precondition(s, `state exceeds the supported bound of ${s.limits.maxRequestsPerBatch} requests per batch`, "requests");
    }
    requireDocsId(s, input.documentId);
    const { document } = openDocument(s, input.documentId, RANK.writer, { docsEnvelope: true });
    if (document.trashed) {
      precondition(s, "This document is in the trash and cannot be edited.", "documentId");
    }
    const writeControl = input.writeControl;
    if (writeControl !== undefined) {
      if (writeControl.requiredRevisionId !== undefined && writeControl.targetRevisionId !== undefined) {
        invalidDocs(s, "Only one of requiredRevisionId and targetRevisionId may be set.", "writeControl");
      }
      const expected = writeControl.requiredRevisionId ?? writeControl.targetRevisionId;
      if (expected !== undefined && expected !== document.revisionId) {
        precondition(
          s,
          `The document has been changed since it was read: revision ${expected} is no longer current.`,
          "writeControl.requiredRevisionId",
        );
      }
    }
    const before = bodyRow(s, document.documentId);
    const working = workingCopy(before);
    const ctx = {
      limits: s.limits,
      nextListId: () => listIdFor(nextCounter(s, "listSequence")),
      nextNamedRangeId: () => namedRangeIdFor(nextCounter(s, "namedRangeSequence")),
      nextHeadingId: () => headingIdFor(nextCounter(s, "headingSequence")),
    };
    let applied;
    try {
      applied = applyRequests(working, requests, ctx);
    } catch (error) {
      if (error instanceof RequestError) {
        if (error.code === "FAILED_PRECONDITION") precondition(s, error.message, error.field);
        if (error.code === "NOT_FOUND") s.context.fail({ code: "NOT_FOUND", message: error.message });
        invalidDocs(s, error.message, error.field);
      }
      throw error;
    }
    const textBefore = document.textLength;
    const text = verbalize(working.blocks);
    const revisionId = docsRevisionIdFor(nextCounter(s, "revisionSequence"));
    const updated = {
      ...document,
      revisionId,
      headRevisionNumber: document.headRevisionNumber + 1,
      version: document.version + 1,
      modifiedTime: s.now,
      lastModifyingUser: s.email,
      textLength: text.length,
    };
    if (documentGetBytes(s, updated, working) > s.limits.maxResponseBytes) precondition(s, documentBytesMessage(s), "requests");
    s.context.state.put("documents", document.documentId, updated);
    s.context.state.put("bodies", document.documentId, {
      documentId: document.documentId,
      blocks: working.blocks,
      namedRanges: working.namedRanges,
      lists: working.lists,
    });
    appendRevision(s, updated, applied.kinds, text.length);
    patchUserDoc(s, s.email, document.documentId, { modifiedByMeTime: s.now, viewedByMeTime: s.now });
    flushCounters(s);
    s.context.events.emit("document.updated", {
      documentId: document.documentId,
      actorEmail: s.email,
      revisionId,
      revisionNumber: updated.headRevisionNumber,
      requestTypes: applied.kinds,
      textLengthBefore: textBefore,
      textLengthAfter: text.length,
    });
    return {
      documentId: document.documentId,
      replies: applied.replies,
      writeControl: { requiredRevisionId: revisionId },
    };
  },

  "files.list": (input, context) => {
    const s = session(context);
    rejectInvalidParameter(s, input.invalidParameter);
    checkFields(s, input.fields, "fileList");
    if (input.spaces !== undefined && input.spaces !== "drive") {
      invalidDrive(s, "Only the drive space is supported.", "invalidParameter", "spaces");
    }
    if (input.corpora !== undefined && input.corpora !== "user") {
      invalidDrive(s, "Only the user corpus is supported: shared drives are not part of this Tool.", "invalidParameter", "corpora");
    }
    const pageSize = pageSizeOf(s, input.pageSize, 100, 1000);
    let tree;
    if (input.q !== undefined) {
      try {
        tree = parseQuery(input.q);
      } catch (error) {
        if (error instanceof QueryError) invalidDrive(s, error.hint ?? error.message, "invalid", "q");
        throw error;
      }
    }
    const orderBy = input.orderBy ?? DEFAULT_ORDER;
    const orders = orderBy.split(",").map((part) => {
      const [key, direction] = part.trim().split(/\s+/);
      if (!ORDER_KEYS.includes(key)) invalidDrive(s, `Unsupported orderBy key ${key}.`, "invalidParameter", "orderBy");
      if (direction !== undefined && direction !== "asc" && direction !== "desc") {
        invalidDrive(s, "orderBy direction must be asc or desc.", "invalidParameter", "orderBy");
      }
      return { key, descending: direction === "desc" };
    });
    const rows = scanBounded(s, "documents");
    const visible = [];
    for (const row of rows) {
      const document = row.value;
      const permissions = permissionRows(s, document.documentId);
      const rank = rankFor(document, permissions, s.email, s.domain);
      if (rank === 0) continue;
      const mine = userDoc(s, s.email, document.documentId);
      if (tree !== undefined) {
        const view = {
          name: document.title,
          description: document.description,
          mimeType: DOCUMENT_MIME,
          trashed: document.trashed,
          starred: mine?.starred === true,
          sharedWithMe: mine?.sharedWithMeTime !== undefined,
          modifiedTime: parseTime(document.modifiedTime),
          createdTime: parseTime(document.createdTime),
          viewedByMeTime: parseTime(mine?.viewedByMeTime ?? ""),
          ownerEmail: document.ownerEmail,
          roleRank: (email) => rankFor(document, permissions, normalizeEmail(email), domainOf(normalizeEmail(email))),
          text: () => verbalize(bodyRow(s, document.documentId).blocks),
        };
        if (!matchQuery(tree, view)) continue;
      }
      visible.push({ document, permissions, rank, mine });
    }
    const sortValue = (entry, key) => {
      if (key === "name" || key === "name_natural") return entry.document.title;
      if (key === "starred") return entry.mine?.starred === true ? 1 : 0;
      if (key === "viewedByMeTime") return entry.mine?.viewedByMeTime ?? "";
      if (key === "sharedWithMeTime") return entry.mine?.sharedWithMeTime ?? "";
      return entry.document[key] ?? "";
    };
    const fileOrder = listOrder(
      (entry) => [...orders.map((order) => sortValue(entry, order.key)), entry.document.documentId],
      [...orders.map((order) => order.descending), false],
    );
    visible.sort(fileOrder.compare);
    const scope = stableJson({ email: s.email, q: input.q, orderBy });
    const { page, nextPageToken } = paginate(
      s,
      visible,
      fileOrder,
      pageSize,
      input.pageToken,
      scope,
      (entry) => fileResource(s, entry.document, entry.permissions, entry.rank, { includePermissions: false }),
      { refuseOversized: true },
    );
    return withoutUndefined({
      kind: "drive#fileList",
      files: page,
      nextPageToken,
      incompleteSearch: false,
    });
  },

  "files.get": (input, context) => {
    const s = session(context);
    rejectInvalidParameter(s, input.invalidParameter);
    checkFields(s, input.fields, "file");
    if (input.alt !== undefined && input.alt !== "json") {
      invalidDrive(
        s,
        "Only Google Docs exports are supported for this file type; use files.export.",
        "fileNotDownloadable",
        "alt",
      );
    }
    const { document, permissions, rank } = openDocument(s, input.fileId, RANK.reader);
    return fileResource(s, document, permissions, rank);
  },

  "files.update": (input, context) => {
    const s = session(context);
    if (Array.isArray(input.unwritableFields) && input.unwritableFields.length > 0) {
      // Drive answers 403 fieldNotWritable, before any other validation, when the body carries a read-only field.
      s.context.fail({
        code: "PERMISSION_DENIED",
        message: "The resource body includes fields which are not directly writable.",
        details: { reason: "fieldNotWritable" },
      });
    }
    checkFields(s, input.fields, "file");
    const patches = ["name", "description", "starred", "trashed", "viewedByMeTime"].filter((name) => input[name] !== undefined);
    if (patches.length === 0) invalidDrive(s, "At least one writable field must be set.", "invalid");
    const metadata = patches.some((name) => name === "name" || name === "description");
    const trashing = input.trashed !== undefined;
    const { document, permissions, rank } = openDocument(
      s,
      input.fileId,
      trashing ? RANK.owner : metadata ? RANK.writer : RANK.reader,
    );
    let viewedByMeTime;
    if (input.viewedByMeTime !== undefined) {
      const viewedMs = parseTime(input.viewedByMeTime);
      if (viewedMs === undefined || input.viewedByMeTime.length <= 10) {
        invalidDrive(s, "viewedByMeTime must be an RFC 3339 date-time.", "invalid", "viewedByMeTime");
      }
      viewedByMeTime = isoOf(viewedMs);
    }
    let updated = document;
    if (metadata || trashing) {
      const next = { ...document };
      if (input.name !== undefined) {
        if (typeof input.name !== "string" || input.name.length === 0 || input.name.length > 512) {
          invalidDrive(s, "name must be between 1 and 512 characters.", "invalid", "name");
        }
        next.title = input.name;
      }
      if (input.description !== undefined) {
        if (typeof input.description !== "string" || input.description.length > 2048) {
          invalidDrive(s, "description is limited to 2048 characters.", "invalid", "description");
        }
        if (input.description.length === 0) delete next.description;
        else next.description = input.description;
      }
      if (trashing) {
        next.trashed = input.trashed === true;
        next.explicitlyTrashed = input.trashed === true;
        if (input.trashed === true) next.trashedTime = s.now;
        else delete next.trashedTime;
      }
      next.modifiedTime = s.now;
      next.lastModifyingUser = s.email;
      next.version = document.version + 1;
      s.context.state.put("documents", document.documentId, next);
      updated = next;
    }
    if (input.starred !== undefined) {
      if (typeof input.starred !== "boolean") invalidDrive(s, "starred must be a boolean.", "invalid", "starred");
      patchUserDoc(s, s.email, document.documentId, { starred: input.starred });
    }
    // Per user, like starred: recording that the caller viewed the file never moves modifiedTime or the version.
    if (viewedByMeTime !== undefined) patchUserDoc(s, s.email, document.documentId, { viewedByMeTime });
    return fileResource(s, updated, permissions, rank);
  },

  "files.copy": (input, context) => {
    const s = session(context);
    checkFields(s, input.fields, "file");
    const { document } = openDocument(s, input.fileId, RANK.reader);
    if (document.trashed) precondition(s, "A document in the trash cannot be copied.");
    const name = input.name === undefined ? `Copy of ${document.title}` : input.name;
    if (typeof name !== "string" || name.length === 0 || name.length > 512) {
      invalidDrive(s, "name must be between 1 and 512 characters.", "invalid", "name");
    }
    if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 2048)) {
      invalidDrive(s, "description is limited to 2048 characters.", "invalid", "description");
    }
    const source = workingCopy(bodyRow(s, document.documentId));
    const copy = createDocument(s, {
      title: name,
      blocks: source.blocks,
      namedRanges: source.namedRanges,
      lists: source.lists,
      description: input.description,
      starred: input.starred === true,
      source: "copy",
      sourceDocumentId: document.documentId,
    });
    return fileResource(s, copy, permissionRows(s, copy.documentId), RANK.owner);
  },

  "files.delete": (input, context) => {
    const s = session(context);
    const { document } = openDocument(s, input.fileId, RANK.owner);
    deleteDocumentRows(s, document.documentId);
    return {};
  },

  "files.export": (input, context) => {
    const s = session(context);
    const mimeType = input.mimeType;
    if (typeof mimeType !== "string" || mimeType.length === 0) {
      invalidDrive(s, "mimeType is required.", "invalid", "mimeType");
    }
    const { document } = openDocument(s, input.fileId, RANK.reader);
    if (!EXPORT_MIMES.includes(mimeType)) notExportable(s, mimeType);
    const body = bodyRow(s, document.documentId);
    const content = renderExport(mimeType, document.title, body.blocks, body.lists ?? []);
    const byteLength = utf8ByteLength(content);
    if (byteLength > s.limits.maxResponseBytes) {
      s.context.fail({
        code: "EXPORT_SIZE_LIMIT_EXCEEDED",
        message: "This file is too large to be exported.",
        details: { limitBytes: s.limits.maxResponseBytes, mimeType },
      });
    }
    return { mimeType, content, byteLength };
  },

  "permissions.list": (input, context) => {
    const s = session(context);
    rejectInvalidParameter(s, input.invalidParameter);
    checkFields(s, input.fields, "permissionList");
    const pageSize = pageSizeOf(s, input.pageSize, 100, 100);
    const { permissions } = openDocument(s, input.fileId, RANK.reader);
    const permissionOrder = listOrder(
      (permission) => [permission.role === "owner" ? 0 : 1, permission.createdTime, permission.id],
      [false, false, false],
    );
    const ordered = [...permissions].sort(permissionOrder.compare);
    const scope = stableJson({ email: s.email, fileId: input.fileId });
    const { page, nextPageToken } = paginate(s, ordered, permissionOrder, pageSize, input.pageToken, scope, permissionResource);
    return withoutUndefined({
      kind: "drive#permissionList",
      permissions: page,
      nextPageToken,
    });
  },

  "permissions.create": (input, context) => {
    const s = session(context);
    rejectInvalidParameter(s, input.invalidParameter);
    checkFields(s, input.fields, "permission");
    const { role, type } = input;
    if (role === "owner" || input.transferOwnership === true) {
      invalidSharing(s, "Ownership transfer is not supported by this Tool.");
    }
    if (!SHARE_ROLES.includes(role)) invalidDrive(s, `role must be one of ${SHARE_ROLES.join(", ")}.`, "invalid", "role");
    if (!PERMISSION_TYPES.includes(type)) invalidDrive(s, `type must be one of ${PERMISSION_TYPES.join(", ")}.`, "invalid", "type");
    if (type === "anyone" && role === "writer") {
      invalidSharing(s, "Link sharing with edit access is not supported by this Tool.");
    }
    if (input.emailMessage !== undefined && input.sendNotificationEmail !== true) {
      invalidDrive(s, "emailMessage requires sendNotificationEmail.", "invalid", "emailMessage");
    }
    let emailAddress;
    let domain;
    if (type === "user" || type === "group") {
      emailAddress = normalizeEmail(input.emailAddress ?? "");
      if (!isEmail(emailAddress)) invalidDrive(s, "A valid emailAddress is required for user and group permissions.", "invalid", "emailAddress");
      if (input.allowFileDiscovery !== undefined) {
        invalidDrive(s, "allowFileDiscovery applies to domain and anyone permissions only.", "invalid", "allowFileDiscovery");
      }
    } else if (type === "domain") {
      domain = String(input.domain ?? "").toLowerCase();
      if (!DOMAIN.test(domain)) invalidDrive(s, "A valid domain is required for domain permissions.", "invalid", "domain");
    }
    const { document, permissions } = openDocument(s, input.fileId, RANK.owner);
    const existing = permissions.find((permission) => {
      if (permission.type !== type) return false;
      if (type === "anyone") return true;
      if (type === "domain") return permission.domain === domain;
      return permission.emailAddress === emailAddress;
    });
    if (existing !== undefined && existing.role === "owner") {
      precondition(s, "The owner's permission cannot be changed; ownership transfer is out of scope.");
    }
    if (existing === undefined && permissions.length >= s.limits.maxPermissions) {
      precondition(s, `state exceeds the supported bound of ${s.limits.maxPermissions} permissions per document`);
    }
    const id = existing?.id ?? permissionIdForGrantee(s, type, emailAddress, domain);
    const value = withoutUndefined({
      documentId: document.documentId,
      id,
      type,
      role,
      emailAddress,
      domain,
      displayName: type === "user" || type === "group" ? (userRow(s, emailAddress)?.displayName ?? undefined) : undefined,
      allowFileDiscovery: type === "domain" || type === "anyone" ? input.allowFileDiscovery === true : undefined,
      createdTime: existing?.createdTime ?? s.now,
    });
    s.context.state.put("permissions", permissionRowId(document.documentId, id), value);
    if (emailAddress !== undefined && userRow(s, emailAddress) !== null && userRow(s, emailAddress) !== undefined) {
      patchUserDoc(s, emailAddress, document.documentId, { sharedWithMeTime: s.now, sharingUserEmail: s.email });
    }
    flushCounters(s);
    s.context.events.emit(
      "document.shared",
      withoutUndefined({
        documentId: document.documentId,
        actorEmail: s.email,
        granteeType: type,
        granteeEmail: emailAddress,
        granteeDomain: domain,
        role,
        removed: false,
      }),
    );
    return { permission: permissionResource(value) };
  },

  "permissions.delete": (input, context) => {
    const s = session(context);
    const { document } = openDocument(s, input.fileId, RANK.owner);
    const row = s.context.state.get("permissions", permissionRowId(document.documentId, input.permissionId));
    if (row === null) notFoundOther(s, `Permission not found: ${input.permissionId}.`, "permissionId");
    if (row.role === "owner") precondition(s, "The owner's permission cannot be removed.");
    s.context.state.delete("permissions", permissionRowId(document.documentId, row.id));
    if (row.emailAddress !== undefined) {
      const mine = userDoc(s, row.emailAddress, document.documentId);
      if (mine !== null) {
        const { sharedWithMeTime, sharingUserEmail, ...rest } = mine;
        s.context.state.put("user-docs", userDocRowId(row.emailAddress, document.documentId), rest);
      }
    }
    s.context.events.emit(
      "document.shared",
      withoutUndefined({
        documentId: document.documentId,
        actorEmail: s.email,
        granteeType: row.type,
        granteeEmail: row.emailAddress,
        granteeDomain: row.domain,
        role: row.role,
        removed: true,
      }),
    );
    return {};
  },

  "comments.list": (input, context) => {
    const s = session(context);
    rejectInvalidParameter(s, input.invalidParameter);
    checkFields(s, input.fields, "commentList");
    const pageSize = pageSizeOf(s, input.pageSize, 20, 100);
    let since;
    if (input.startModifiedTime !== undefined) {
      since = parseTime(input.startModifiedTime);
      if (since === undefined) invalidDrive(s, "startModifiedTime must be an RFC 3339 timestamp.", "invalid", "startModifiedTime");
    }
    const { document } = openDocument(s, input.fileId, RANK.reader);
    const comments = commentRows(s, document.documentId)
      .filter((comment) => (input.includeDeleted === true ? true : !comment.deleted))
      .filter((comment) => (since === undefined ? true : (parseTime(comment.modifiedTime) ?? 0) >= since))
      .sort(COMMENT_ORDER.compare);
    const scope = stableJson({
      email: s.email,
      fileId: document.documentId,
      includeDeleted: input.includeDeleted === true,
      startModifiedTime: input.startModifiedTime,
    });
    const { page, nextPageToken } = paginate(
      s,
      comments,
      COMMENT_ORDER,
      pageSize,
      input.pageToken,
      scope,
      (comment) => commentResource(s, comment, replyRows(s, document.documentId, comment.id)),
      { refuseOversized: true },
    );
    return withoutUndefined({
      kind: "drive#commentList",
      comments: page,
      nextPageToken,
    });
  },

  "comments.get": (input, context) => {
    const s = session(context);
    rejectInvalidParameter(s, input.invalidParameter);
    const { document } = openDocument(s, input.fileId, RANK.reader);
    const comment = openComment(s, document.documentId, input.commentId, input.includeDeleted);
    return commentResource(s, comment, replyRows(s, document.documentId, comment.id));
  },

  "comments.create": (input, context) => {
    const s = session(context);
    const content = input.content;
    if (typeof content !== "string" || content.trim().length === 0 || content.length > 4096) {
      invalidDrive(s, "content must be between 1 and 4096 characters.", "invalid", "content");
    }
    const { document } = openDocument(s, input.fileId, RANK.commenter);
    const existing = commentRows(s, document.documentId);
    if (existing.length >= s.limits.maxComments) {
      precondition(s, `state exceeds the supported bound of ${s.limits.maxComments} comments per document`);
    }
    const body = bodyRow(s, document.documentId);
    let anchor = input.anchor;
    let quotedText = input.quotedFileContent?.value;
    if (input.range !== undefined) {
      const { startIndex, endIndex } = input.range;
      if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex >= endIndex || startIndex < 1) {
        invalidDrive(s, "range.startIndex must be at least 1 and less than range.endIndex.", "invalid", "range");
      }
      const map = indexMap(body.blocks);
      if (endIndex > map.end) invalidDrive(s, `range.endIndex is beyond the end of the document (${map.end}).`, "invalid", "range");
      anchor = JSON.stringify({ r: document.revisionId, a: [{ txt: { o: startIndex, l: endIndex - startIndex } }] });
      quotedText = textBetween(body.blocks, startIndex, endIndex).slice(0, 1024);
    } else if (anchor !== undefined) {
      // The stored anchor is bounded at 2048 characters: a longer (even well-formed) anchor would break the state schema.
      if (typeof anchor !== "string" || anchor.length > 2048) {
        invalidDrive(s, "anchor must be a Drive anchor JSON string of at most 2048 characters.", "invalid", "anchor");
      }
      let parsed;
      try {
        parsed = JSON.parse(anchor);
      } catch {
        parsed = null;
      }
      if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.a)) {
        invalidDrive(s, "anchor must be a Drive anchor JSON string.", "invalid", "anchor");
      }
    }
    const id = commentIdFor(nextCounter(s, "commentSequence"));
    const comment = withoutUndefined({
      documentId: document.documentId,
      id,
      authorEmail: s.email,
      content,
      createdTime: s.now,
      modifiedTime: s.now,
      deleted: false,
      resolved: false,
      anchor,
      quotedText,
      replyCount: 0,
    });
    s.context.state.put("comments", commentRowId(document.documentId, id), comment);
    saveCommentCounts(s, document);
    flushCounters(s);
    return commentResource(s, comment, []);
  },

  "comments.update": (input, context) => {
    const s = session(context);
    const content = input.content;
    if (typeof content !== "string" || content.trim().length === 0 || content.length > 4096) {
      invalidDrive(s, "content must be between 1 and 4096 characters.", "invalid", "content");
    }
    const { document } = openDocument(s, input.fileId, RANK.reader);
    const comment = openComment(s, document.documentId, input.commentId);
    if (comment.deleted) invalidDrive(s, "A deleted comment cannot be edited.", "invalid", "commentId");
    if (comment.authorEmail !== s.email) denied(s, "Only the author of a comment may edit it.");
    const updated = { ...comment, content, modifiedTime: s.now };
    s.context.state.put("comments", commentRowId(document.documentId, comment.id), updated);
    return commentResource(s, updated, replyRows(s, document.documentId, comment.id));
  },

  "comments.delete": (input, context) => {
    const s = session(context);
    const { document } = openDocument(s, input.fileId, RANK.reader);
    const comment = openComment(s, document.documentId, input.commentId);
    if (comment.authorEmail !== s.email && document.ownerEmail !== s.email) {
      denied(s, "Only the author of a comment or the owner of the document may delete it.");
    }
    const updated = { ...comment, content: "", deleted: true, modifiedTime: s.now };
    delete updated.quotedText;
    s.context.state.put("comments", commentRowId(document.documentId, comment.id), updated);
    saveCommentCounts(s, document);
    return {};
  },

  "replies.list": (input, context) => {
    const s = session(context);
    rejectInvalidParameter(s, input.invalidParameter);
    checkFields(s, input.fields, "replyList");
    const pageSize = pageSizeOf(s, input.pageSize, 20, 100);
    const { document } = openDocument(s, input.fileId, RANK.reader);
    const comment = openComment(s, document.documentId, input.commentId, true);
    const replies = replyRows(s, document.documentId, comment.id)
      .filter((reply) => (input.includeDeleted === true ? true : !reply.deleted))
      .sort(REPLY_ORDER.compare);
    const scope = stableJson({
      email: s.email,
      fileId: document.documentId,
      commentId: comment.id,
      includeDeleted: input.includeDeleted === true,
    });
    const { page, nextPageToken } = paginate(s, replies, REPLY_ORDER, pageSize, input.pageToken, scope, (reply) =>
      replyResource(s, reply),
    );
    return withoutUndefined({
      kind: "drive#replyList",
      replies: page,
      nextPageToken,
    });
  },

  "replies.create": (input, context) => {
    const s = session(context);
    const action = input.action;
    const content = input.content ?? "";
    if (action !== undefined && action !== "resolve" && action !== "reopen") {
      invalidDrive(s, "action must be resolve or reopen.", "invalid", "action");
    }
    if (action === undefined && content.trim().length === 0) {
      invalidDrive(s, "A reply needs content, an action, or both.", "invalid", "content");
    }
    if (typeof content !== "string" || content.length > 4096) {
      invalidDrive(s, "content is limited to 4096 characters.", "invalid", "content");
    }
    const { document } = openDocument(s, input.fileId, RANK.commenter);
    const comment = openComment(s, document.documentId, input.commentId);
    if (comment.deleted) invalidDrive(s, "A deleted comment cannot be replied to.", "invalid", "commentId");
    const replies = replyRows(s, document.documentId, comment.id);
    if (replies.length >= s.limits.maxReplies) {
      precondition(s, `state exceeds the supported bound of ${s.limits.maxReplies} replies per comment`);
    }
    if (action === "resolve" && comment.resolved) precondition(s, "This comment is already resolved.");
    if (action === "reopen" && !comment.resolved) precondition(s, "This comment is not resolved.");
    const id = commentIdFor(nextCounter(s, "replySequence"));
    const reply = withoutUndefined({
      documentId: document.documentId,
      commentId: comment.id,
      id,
      authorEmail: s.email,
      content,
      action,
      createdTime: s.now,
      modifiedTime: s.now,
      deleted: false,
    });
    const threadBytes = jsonByteLength(commentResource(s, comment, [...replies, reply])) + COMMENT_EDIT_HEADROOM_BYTES;
    if (threadBytes + PAGE_ENVELOPE_BYTES > s.limits.maxResponseBytes) {
      precondition(
        s,
        `state exceeds the supported bound of ${s.limits.maxResponseBytes} bytes for one comment thread with its replies`,
        "content",
      );
    }
    s.context.state.put("replies", replyRowId(document.documentId, comment.id, id), reply);
    const updatedComment = {
      ...comment,
      replyCount: replies.length + 1,
      modifiedTime: s.now,
      resolved: action === undefined ? comment.resolved : action === "resolve",
    };
    s.context.state.put("comments", commentRowId(document.documentId, comment.id), updatedComment);
    saveCommentCounts(s, document);
    flushCounters(s);
    return replyResource(s, reply);
  },

  "revisions.list": (input, context) => {
    const s = session(context);
    rejectInvalidParameter(s, input.invalidParameter);
    checkFields(s, input.fields, "revisionList");
    const pageSize = pageSizeOf(s, input.pageSize, 100, 100);
    const { document } = openDocument(s, input.fileId, RANK.reader);
    const revisions = scanBounded(s, "revisions", `${document.documentId}:`)
      .map((row) => row.value)
      .sort(REVISION_ORDER.compare);
    const scope = stableJson({ email: s.email, fileId: document.documentId });
    const { page, nextPageToken } = paginate(s, revisions, REVISION_ORDER, pageSize, input.pageToken, scope, (revision) =>
      revisionResource(s, revision),
    );
    return withoutUndefined({
      kind: "drive#revisionList",
      revisions: page,
      nextPageToken,
    });
  },

  "revisions.get": (input, context) => {
    const s = session(context);
    const { document } = openDocument(s, input.fileId, RANK.reader);
    const number = Number.parseInt(String(input.revisionId), 10);
    const revision =
      Number.isInteger(number) && number > 0
        ? s.context.state.get("revisions", revisionRowId(document.documentId, number))
        : null;
    if (revision === null) notFoundOther(s, `Revision not found: ${input.revisionId}.`, "revisionId");
    return revisionResource(s, revision);
  },
};

// ---------------------------------------------------------------------------------------------
// HTTP codecs: pure request/response mapping, no state and no permission checks.
// ---------------------------------------------------------------------------------------------

function one(values, name) {
  const list = values[name];
  return list === undefined || list.length === 0 ? undefined : list[0];
}

/**
 * Typed query parameters. A value that does not coerce is recorded in `bad` (clipped: the name to 64 and the value to 64
 * characters) instead of thrown, so the handler can answer the provider's own `400 invalid` on that parameter; see
 * `rejectInvalidParameter`. The first offender wins, as Google reports one parameter at a time.
 */
/**
 * Clips an echoed parameter name or value to the 64 UTF-16 units the `invalidParameter` schema allows, then drops a
 * dangling high surrogate so the clip never splits a code point (a lone surrogate would mangle the provider envelope).
 */
function clipEcho(text) {
  let out = text.slice(0, 64);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

function booleanParam(query, name, bad) {
  const value = one(query, name);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  bad.push({ name: clipEcho(name), value: clipEcho(value), kind: "boolean" });
  return undefined;
}

function integerParam(query, name, bad) {
  const value = one(query, name);
  if (value === undefined) return undefined;
  if (!/^-?\d{1,9}$/.test(value)) {
    bad.push({ name: clipEcho(name), value: clipEcho(value), kind: "integer" });
    return undefined;
  }
  return Number.parseInt(value, 10);
}

const firstInvalid = (bad) => (bad.length === 0 ? undefined : bad[0]);

function pathParam(request, name) {
  const value = request.path[name];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}

function jsonBody(request) {
  if (request.body.kind !== "json") return {};
  const value = assertJsonDepth(request.body.value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("request body must be a JSON object");
  return value;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function mutation(request, args) {
  const key = one(request.headers, "idempotency-key");
  return { arguments: compact(args), ...(key === undefined || key.length === 0 ? {} : { idempotencyKey: key }) };
}

function rejectSharedDriveParams(query) {
  for (const name of ["driveId", "teamDriveId", "includeTeamDriveItems"]) {
    if (one(query, name) !== undefined) throw new TypeError(`${name} is not supported: shared drives are not part of this Tool`);
  }
}

function encodeDrive(render, vocabulary) {
  return ({ invocation, outcome }) => {
    if (outcome.status !== "ok") return driveError(outcome);
    return { body: { kind: "json", value: maskResource(render(outcome.value), invocation.arguments.fields, vocabulary) } };
  };
}

function encodeDocs(render) {
  return ({ outcome }) => {
    if (outcome.status !== "ok") return docsError(outcome);
    return { body: { kind: "json", value: render(outcome.value) } };
  };
}

function encodeEmptyDrive({ outcome }) {
  if (outcome.status !== "ok") return driveError(outcome);
  return { body: { kind: "empty" } };
}

/**
 * Google publishes `POST /v1/documents/{documentId}:batchUpdate`, but a Firedrill route path segment is either a whole
 * `{parameter}` or a literal, so the colon method suffix cannot be declared. The route is `POST /v1/documents/{documentId}`
 * and this codec strips a recognised `:batchUpdate` suffix from the captured value. Any other value (including a bare id
 * with no method suffix) is forwarded unchanged with its separator, which is not a document id, so the handler answers
 * 404 NOT_FOUND instead of silently performing an update on a path Google does not serve.
 */
function batchUpdateDocumentId(raw) {
  const cut = raw.lastIndexOf(":");
  const method = cut < 0 ? "" : raw.slice(cut + 1);
  return method === "batchUpdate" ? raw.slice(0, cut) : `${raw}:${method}`;
}

const http = {
  "create-document": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, { title: body.title });
    },
    encode: encodeDocs(restDocument),
  },
  "get-document": {
    decode: (request) => {
      const bad = [];
      return {
        arguments: compact({
          documentId: pathParam(request, "documentId"),
          includeTabsContent: booleanParam(request.query, "includeTabsContent", bad),
          suggestionsViewMode: one(request.query, "suggestionsViewMode"),
          tabId: one(request.query, "tabId"),
          invalidParameter: firstInvalid(bad),
        }),
      };
    },
    encode: encodeDocs(restDocument),
  },
  "batch-update-document": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, {
        documentId: batchUpdateDocumentId(pathParam(request, "documentId")),
        requests: body.requests,
        writeControl: body.writeControl,
      });
    },
    encode: encodeDocs((value) => value),
  },
  "about-get": {
    decode: (request) => ({ arguments: compact({ fields: one(request.query, "fields") }) }),
    encode: encodeDrive(restAbout, "about"),
  },
  "list-files": {
    decode: (request) => {
      const bad = [];
      rejectSharedDriveParams(request.query);
      return {
        arguments: compact({
          q: one(request.query, "q"),
          pageSize: integerParam(request.query, "pageSize", bad),
          pageToken: one(request.query, "pageToken"),
          orderBy: one(request.query, "orderBy"),
          spaces: one(request.query, "spaces"),
          corpora: one(request.query, "corpora"),
          fields: one(request.query, "fields"),
          supportsAllDrives: booleanParam(request.query, "supportsAllDrives", bad),
          includeItemsFromAllDrives: booleanParam(request.query, "includeItemsFromAllDrives", bad),
          invalidParameter: firstInvalid(bad),
        }),
      };
    },
    encode: encodeDrive((value) => value, "fileList"),
  },
  "get-file": {
    decode: (request) => {
      const bad = [];
      return {
        arguments: compact({
          fileId: pathParam(request, "fileId"),
          fields: one(request.query, "fields"),
          alt: one(request.query, "alt"),
          supportsAllDrives: booleanParam(request.query, "supportsAllDrives", bad),
          invalidParameter: firstInvalid(bad),
        }),
      };
    },
    encode: encodeDrive((value) => value, "file"),
  },
  "update-file": {
    decode: (request) => {
      const body = jsonBody(request);
      // Fields this Tool does not write (`id`, `mimeType`, `owners`, ...) are forwarded by name so the handler answers
      // Drive's `403 fieldNotWritable` rather than a framework decode failure. At most 32 names, each clipped to 128.
      const unwritable = Object.keys(body).filter((name) => !["name", "description", "starred", "trashed", "viewedByMeTime"].includes(name));
      return mutation(request, {
        fileId: pathParam(request, "fileId"),
        name: body.name,
        description: body.description,
        starred: body.starred,
        trashed: body.trashed,
        viewedByMeTime: body.viewedByMeTime,
        fields: one(request.query, "fields"),
        unwritableFields: unwritable.length === 0 ? undefined : unwritable.slice(0, 32).map((name) => name.slice(0, 128) || "_"),
      });
    },
    encode: encodeDrive((value) => value, "file"),
  },
  "delete-file": {
    decode: (request) => mutation(request, { fileId: pathParam(request, "fileId") }),
    encode: encodeEmptyDrive,
  },
  "copy-file": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, {
        fileId: pathParam(request, "fileId"),
        name: body.name,
        description: body.description,
        starred: body.starred,
        fields: one(request.query, "fields"),
      });
    },
    encode: encodeDrive((value) => value, "file"),
  },
  "export-file": {
    decode: (request) => ({
      arguments: compact({ fileId: pathParam(request, "fileId"), mimeType: one(request.query, "mimeType") }),
    }),
    encode: ({ outcome }) => {
      if (outcome.status !== "ok") return driveError(outcome);
      return { body: { kind: "text", value: outcome.value.content, contentType: `${outcome.value.mimeType}; charset=utf-8` } };
    },
  },
  "list-permissions": {
    decode: (request) => {
      const bad = [];
      return {
        arguments: compact({
          fileId: pathParam(request, "fileId"),
          pageSize: integerParam(request.query, "pageSize", bad),
          pageToken: one(request.query, "pageToken"),
          fields: one(request.query, "fields"),
          invalidParameter: firstInvalid(bad),
        }),
      };
    },
    encode: encodeDrive((value) => value, "permissionList"),
  },
  "create-permission": {
    decode: (request) => {
      const bad = [];
      const body = jsonBody(request);
      return mutation(request, {
        fileId: pathParam(request, "fileId"),
        role: body.role,
        type: body.type,
        emailAddress: body.emailAddress,
        domain: body.domain,
        allowFileDiscovery: body.allowFileDiscovery,
        transferOwnership: booleanParam(request.query, "transferOwnership", bad),
        sendNotificationEmail: booleanParam(request.query, "sendNotificationEmail", bad),
        emailMessage: one(request.query, "emailMessage"),
        fields: one(request.query, "fields"),
        invalidParameter: firstInvalid(bad),
      });
    },
    encode: encodeDrive((value) => value.permission, "permission"),
  },
  "delete-permission": {
    decode: (request) => mutation(request, { fileId: pathParam(request, "fileId"), permissionId: pathParam(request, "permissionId") }),
    encode: encodeEmptyDrive,
  },
  "list-comments": {
    decode: (request) => {
      const bad = [];
      return {
        arguments: compact({
          fileId: pathParam(request, "fileId"),
          pageSize: integerParam(request.query, "pageSize", bad),
          pageToken: one(request.query, "pageToken"),
          includeDeleted: booleanParam(request.query, "includeDeleted", bad),
          startModifiedTime: one(request.query, "startModifiedTime"),
          fields: one(request.query, "fields"),
          invalidParameter: firstInvalid(bad),
        }),
      };
    },
    encode: encodeDrive((value) => value, "commentList"),
  },
  "create-comment": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, {
        fileId: pathParam(request, "fileId"),
        content: body.content,
        anchor: body.anchor,
        quotedFileContent: body.quotedFileContent,
        fields: one(request.query, "fields"),
      });
    },
    encode: encodeDrive((value) => value, "comment"),
  },
  "get-comment": {
    decode: (request) => {
      const bad = [];
      return {
        arguments: compact({
          fileId: pathParam(request, "fileId"),
          commentId: pathParam(request, "commentId"),
          includeDeleted: booleanParam(request.query, "includeDeleted", bad),
          fields: one(request.query, "fields"),
          invalidParameter: firstInvalid(bad),
        }),
      };
    },
    encode: encodeDrive((value) => value, "comment"),
  },
  "update-comment": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, {
        fileId: pathParam(request, "fileId"),
        commentId: pathParam(request, "commentId"),
        content: body.content,
        fields: one(request.query, "fields"),
      });
    },
    encode: encodeDrive((value) => value, "comment"),
  },
  "delete-comment": {
    decode: (request) => mutation(request, { fileId: pathParam(request, "fileId"), commentId: pathParam(request, "commentId") }),
    encode: encodeEmptyDrive,
  },
  "list-replies": {
    decode: (request) => {
      const bad = [];
      return {
        arguments: compact({
          fileId: pathParam(request, "fileId"),
          commentId: pathParam(request, "commentId"),
          pageSize: integerParam(request.query, "pageSize", bad),
          pageToken: one(request.query, "pageToken"),
          includeDeleted: booleanParam(request.query, "includeDeleted", bad),
          fields: one(request.query, "fields"),
          invalidParameter: firstInvalid(bad),
        }),
      };
    },
    encode: encodeDrive((value) => value, "replyList"),
  },
  "create-reply": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, {
        fileId: pathParam(request, "fileId"),
        commentId: pathParam(request, "commentId"),
        content: body.content,
        action: body.action,
        fields: one(request.query, "fields"),
      });
    },
    encode: encodeDrive((value) => value, "reply"),
  },
  "list-revisions": {
    decode: (request) => {
      const bad = [];
      return {
        arguments: compact({
          fileId: pathParam(request, "fileId"),
          pageSize: integerParam(request.query, "pageSize", bad),
          pageToken: one(request.query, "pageToken"),
          fields: one(request.query, "fields"),
          invalidParameter: firstInvalid(bad),
        }),
      };
    },
    encode: encodeDrive(restRevisionList, "revisionList"),
  },
  "get-revision": {
    decode: (request) => ({
      arguments: compact({
        fileId: pathParam(request, "fileId"),
        revisionId: pathParam(request, "revisionId"),
        fields: one(request.query, "fields"),
      }),
    }),
    encode: encodeDrive(restRevision, "revision"),
  },
};

export default { operations, http };
