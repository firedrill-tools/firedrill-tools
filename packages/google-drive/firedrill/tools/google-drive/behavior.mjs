// Google Drive-shaped synthetic "My Drive" for a few users. Every operation computes from context.state; nothing leaves
// the world (no notification e-mail, no Google service). Handlers are synchronous; ids come from the `meta/counters` row,
// timestamps from the virtual clock, and there is no randomness.
import {
  DOCUMENT_MIME,
  DOMAIN,
  EMAIL,
  FILE_ID,
  FOLDER_COLOR,
  FOLDER_MIME,
  RFC3339,
  SHORTCUT_MIME,
  SPREADSHEET_MIME,
  changeIdFor,
  compareNatural,
  compareText,
  decodePageToken,
  domainOf,
  encodePageToken,
  exportLinkFor,
  FILE_ID as FILE_ID_PATTERN,
  fileIdFor,
  hashText,
  iconLinkFor,
  isEmail,
  normalizeEmail,
  permissionIdFor,
  permissionRowId,
  revisionIdFor,
  stableJson,
  userFileRowId,
  userPermissionIdFor,
  webContentLinkFor,
  webViewLinkFor,
} from "./lib/ids.mjs";
import {
  EXPORT_FORMATS,
  IMPORT_FORMATS,
  MAX_CONTENT_BYTES,
  canImportTo,
  contentBase64,
  decodeBase64,
  defaultExportMime,
  encodeBase64,
  isFolder,
  isGoogleTextType,
  isGoogleType,
  isShortcut,
  isTextMime,
  isValidMime,
  md5OfContent,
  renderExport,
  snippetOf,
  textToBase64,
  utf8Length,
} from "./lib/content.mjs";
import { FieldsError } from "./lib/fields.mjs";
import { assertJsonDepth } from "./lib/json-depth.mjs";
import { downloadExportFits, exportFits, jsonSize, mcpSize, pageFiller } from "./lib/budget.mjs";
import { QueryError, matchQuery, parseQuery } from "./lib/query.mjs";
import { driveError, maskResource, parseMask, restAbout, restChangeList, restFile, restFileList, restPermissionList } from "./lib/wire.mjs";

const SCAN_STEP = 1000;
const HARD_SCAN_CAP = 10_000;
const HARD_DEPTH_CAP = 200;
const DEFAULT_LIMITS = { files: 5000, children: 500, permissions: 100, depth: 100, changes: 20_000, users: 200 };
const DEFAULT_PAGE = 100;
const MAX_PAGE = 1000;
const RANK = { reader: 1, commenter: 2, writer: 3, owner: 4 };
const ROLES = ["owner", "writer", "commenter", "reader"];
const PERMISSION_TYPES = ["user", "group", "domain", "anyone"];
const ORDER_KEYS = [
  "createdTime", "folder", "modifiedByMeTime", "modifiedTime", "name", "name_natural", "quotaBytesUsed", "recency",
  "sharedWithMeTime", "starred", "viewedByMeTime",
];
const RECENT_ORDERS = ["recency", "lastModified", "lastModifiedByMe"];
const DEFAULT_ORDER = "folder,modifiedTime desc,name";
const MAX_PROPERTIES = 30;
const FOLDER_COLOR_PALETTE = [
  "#ac725e", "#d06b64", "#f83a22", "#fa573c", "#ff7537", "#ffad46", "#42d692", "#16a765", "#7bd148", "#b3dc6c", "#fbe983",
  "#fad165", "#92e1c0", "#9fe1e7", "#9fc6e7", "#4986e7", "#9a9cff", "#b99aff", "#c2c2c2", "#cabdbf", "#cca6ac", "#f691b2",
  "#cd74e6", "#a47ae2",
];

// ---------------------------------------------------------------------------------------------
// Failures (details carry the Drive `reason`/`location` the wire codec renders)
// ---------------------------------------------------------------------------------------------

const invalid = (s, message, details) => s.context.fail({ code: "INVALID_ARGUMENT", message, ...(details ? { details } : {}) });
const invalidQuery = (s) => invalid(s, "Invalid Value", { reason: "invalid", location: "q" });

/**
 * The framework decodes query strings leniently, so malformed percent-encoding (`%E0%A4%A`) reaches a handler as
 * U+FFFD. In Drive's `q` search language a replacement character is a mangled request, not a searchable term, so the
 * query is refused with Drive's own invalid-parameter error instead of silently matching nothing. A correctly encoded
 * U+FFFD (`%EF%BF%BD`) is refused the same way; `%ZZ` stays literal and is ordinary text that simply does not match.
 */
const hasReplacement = (value) => typeof value === "string" && value.includes("\uFFFD");
const invalidFields = (s) => invalid(s, "Invalid field selection", { reason: "invalidParameter", location: "fields" });
const notFound = (s, id, kind = "File") =>
  s.context.fail({ code: "NOT_FOUND", message: `${kind} not found: ${id}.`, details: { location: kind === "File" ? "fileId" : "permissionId" } });
const forbidden = (s, message = "The user does not have sufficient permissions for this file.") => s.context.fail({ code: "FORBIDDEN", message });
const precondition = (s, message) => s.context.fail({ code: "FAILED_PRECONDITION", message });
const notExportable = (s, message = "Export only supports Google Docs.") => s.context.fail({ code: "NOT_EXPORTABLE", message });
const quotaExceeded = (s) =>
  s.context.fail({ code: "STORAGE_QUOTA_EXCEEDED", message: "The user's Drive storage quota has been exceeded." });
const exportTooLarge = (s) =>
  s.context.fail({ code: "NOT_EXPORTABLE", message: "This file is too large to be exported.", details: { reason: "exportSizeLimitExceeded" } });
const invalidPageToken = (s) => s.context.fail({ code: "INVALID_PAGE_TOKEN", message: "Invalid Value" });
const invalidSharing = (s, message) => s.context.fail({ code: "INVALID_SHARING_REQUEST", message: `Bad Request. User message: "${message}"` });

// ---------------------------------------------------------------------------------------------
// Session: identity, clock, counters, limits and per-call caches
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
 * (Dana in the starter data). A world without any `users` row falls back to `<actorId>@example.test`.
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
  if (limitsRow !== null) for (const key of Object.keys(DEFAULT_LIMITS)) if (typeof limitsRow[key] === "number") limits[key] = limitsRow[key];
  return {
    context,
    email,
    domain: domainOf(email),
    displayName,
    nowMs,
    now: isoOf(nowMs),
    limits,
    counters: null,
    countersDirty: false,
    cache: { files: new Map(), permissions: new Map(), roles: new Map(), users: new Map(), userFiles: new Map(), contents: new Map(), allFiles: null },
  };
}

function counters(s) {
  if (s.counters === null) {
    const row = s.context.state.get("meta", "counters");
    s.counters = { fileSequence: 0, permissionSequence: 0, changeSequence: 0, userSequence: 0, revisionSequence: 0 };
    if (row !== null) for (const key of Object.keys(s.counters)) if (typeof row[key] === "number") s.counters[key] = row[key];
  }
  return s.counters;
}

function next(s, name) {
  const current = counters(s);
  current[name] += 1;
  s.countersDirty = true;
  return current[name];
}

function commit(s) {
  if (s.countersDirty) {
    const row = s.context.state.get("meta", "counters");
    s.context.state.put("meta", "counters", { ...(row ?? {}), ...s.counters });
    s.countersDirty = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Bounded state access
// ---------------------------------------------------------------------------------------------

/** Every row of a namespace; refuses a namespace beyond `bound` rows with FAILED_PRECONDITION instead of truncating. */
function scanAll(s, namespace, bound) {
  const cap = Math.min(HARD_SCAN_CAP, bound);
  const rows = [];
  let after;
  for (;;) {
    const batch = s.context.state.scan(namespace, { ...(after === undefined ? {} : { afterRowId: after }), limit: Math.min(SCAN_STEP, cap + 1 - rows.length) });
    for (const record of batch) {
      rows.push(record.value);
      after = record.rowId;
    }
    if (rows.length > cap) {
      precondition(s, `State exceeds the supported bound of ${cap} ${namespace} rows (meta.limits.${namespace}); the synthetic service refuses to serve it truncated.`);
    }
    if (batch.length === 0 || rows.length > cap) break;
  }
  return rows;
}

/** Rows whose id starts with `prefix` (row ids are `<parent>:<child>`); a run beyond the hard cap fails with FAILED_PRECONDITION. */
function scanPrefix(s, namespace, prefix) {
  const rows = [];
  let after = prefix;
  for (;;) {
    const batch = s.context.state.scan(namespace, { afterRowId: after, limit: SCAN_STEP });
    for (const record of batch) {
      if (!record.rowId.startsWith(prefix)) return rows;
      rows.push(record.value);
      after = record.rowId;
      if (rows.length > HARD_SCAN_CAP) {
        precondition(s, `State exceeds the supported bound of ${HARD_SCAN_CAP} ${namespace} rows for one file; the synthetic service refuses to serve it truncated.`);
      }
    }
    if (batch.length < SCAN_STEP) return rows;
  }
}

function allFiles(s) {
  if (s.cache.allFiles === null) {
    s.cache.allFiles = scanAll(s, "files", s.limits.files);
    for (const file of s.cache.allFiles) s.cache.files.set(file.id, file);
  }
  return s.cache.allFiles;
}

function getFile(s, id) {
  if (!s.cache.files.has(id)) s.cache.files.set(id, s.context.state.get("files", id));
  return s.cache.files.get(id);
}

function putFile(s, file) {
  s.context.state.put("files", file.id, file);
  s.cache.files.set(file.id, file);
  s.cache.roles.clear();
  if (s.cache.allFiles !== null) {
    const index = s.cache.allFiles.findIndex((item) => item.id === file.id);
    if (index >= 0) s.cache.allFiles[index] = file;
    else s.cache.allFiles.push(file);
  }
}

function removeFile(s, id) {
  s.context.state.delete("files", id);
  s.cache.files.set(id, null);
  s.cache.roles.clear();
  if (s.cache.allFiles !== null) s.cache.allFiles = s.cache.allFiles.filter((item) => item.id !== id);
}

function getUser(s, email) {
  if (!s.cache.users.has(email)) s.cache.users.set(email, s.context.state.get("users", email));
  return s.cache.users.get(email);
}

function getContent(s, fileId) {
  if (!s.cache.contents.has(fileId)) s.cache.contents.set(fileId, s.context.state.get("contents", fileId));
  return s.cache.contents.get(fileId);
}

function putContent(s, content) {
  s.context.state.put("contents", content.fileId, content);
  s.cache.contents.set(content.fileId, content);
}

function permissionsOf(s, fileId) {
  if (!s.cache.permissions.has(fileId)) {
    const rows = scanPrefix(s, "permissions", `${fileId}:`);
    rows.sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    s.cache.permissions.set(fileId, rows);
  }
  return s.cache.permissions.get(fileId);
}

function putPermission(s, row) {
  s.context.state.put("permissions", permissionRowId(row.fileId, row.id), row);
  s.cache.permissions.delete(row.fileId);
  s.cache.roles.clear();
}

function removePermission(s, fileId, permissionId) {
  s.context.state.delete("permissions", permissionRowId(fileId, permissionId));
  s.cache.permissions.delete(fileId);
  s.cache.roles.clear();
}

function userFile(s, email, fileId) {
  const rowId = userFileRowId(email, fileId);
  if (!s.cache.userFiles.has(rowId)) s.cache.userFiles.set(rowId, s.context.state.get("user-files", rowId));
  return s.cache.userFiles.get(rowId);
}

function patchUserFile(s, email, fileId, patch) {
  const existing = userFile(s, email, fileId) ?? { emailAddress: email, fileId, starred: false };
  const updated = { ...existing, ...patch };
  for (const key of Object.keys(updated)) if (updated[key] === undefined) delete updated[key];
  s.context.state.put("user-files", userFileRowId(email, fileId), updated);
  s.cache.userFiles.set(userFileRowId(email, fileId), updated);
  return updated;
}

function appendChange(s, fileId, removed, removedFor) {
  const changeId = changeIdFor(next(s, "changeSequence"));
  const row = { changeId, fileId, time: s.now, removed, changeType: "file", actorEmail: s.email };
  if (removed) row.removedFor = removedFor;
  s.context.state.put("changes", changeId, row);
}

/** The caller's `users` row and root folder, materialised on first contact (fresh installs, unknown explicit addresses). */
function ensureUser(s) {
  const existing = getUser(s, s.email);
  if (existing !== null) return existing;
  const rootId = fileIdFor(next(s, "fileSequence"));
  const user = {
    emailAddress: s.email,
    displayName: s.displayName ?? s.email.slice(0, s.email.indexOf("@")),
    permissionId: userPermissionIdFor(next(s, "userSequence")),
    rootFolderId: rootId,
    storageQuotaLimit: 16_106_127_360,
    domain: s.domain,
  };
  s.context.state.put("users", s.email, user);
  s.cache.users.set(s.email, user);
  putFile(s, {
    id: rootId,
    name: "My Drive",
    mimeType: FOLDER_MIME,
    ownerEmail: s.email,
    parents: [],
    trashed: false,
    explicitlyTrashed: false,
    createdTime: s.now,
    modifiedTime: s.now,
    lastModifyingUser: s.email,
    version: 1,
    contentKind: "none",
    writersCanShare: true,
    copyRequiresWriterPermission: false,
    root: true,
  });
  putPermission(s, { fileId: rootId, id: user.permissionId, type: "user", role: "owner", emailAddress: s.email, createdTime: s.now, version: 1 });
  commit(s);
  return user;
}

// ---------------------------------------------------------------------------------------------
// Access: ancestors, effective roles, capabilities
// ---------------------------------------------------------------------------------------------

/** Ancestor chain nearest-first; authored cycles or chains deeper than the bound fail with the declared FAILED_PRECONDITION. */
function ancestorsOf(s, file) {
  const chain = [];
  let current = file;
  const seen = new Set([file.id]);
  while (current.parents.length > 0) {
    const parent = getFile(s, current.parents[0]);
    if (parent === null) break;
    if (seen.has(parent.id) || chain.length >= HARD_DEPTH_CAP)
      precondition(s, `The folder chain of ${file.id} is cyclic or deeper than the supported bound of ${HARD_DEPTH_CAP} levels; the synthetic service refuses to resolve it.`);
    seen.add(parent.id);
    chain.push(parent);
    current = parent;
  }
  return chain;
}

function rowGrants(s, row, email, domain) {
  if (row.expirationTime !== undefined && (parseTime(row.expirationTime) ?? 0) <= s.nowMs) return false;
  if (row.type === "user") return typeof row.emailAddress === "string" && normalizeEmail(row.emailAddress) === email;
  if (row.type === "domain") return row.domain === domain;
  return row.type === "anyone";
}

/** Effective rank of an address on a file: owner 4 > writer 3 > commenter 2 > reader 1 > none 0. */
function rankFor(s, email, file) {
  const key = `${email}\u0000${file.id}`;
  if (s.cache.roles.has(key)) return s.cache.roles.get(key);
  let rank = 0;
  if (file.ownerEmail === email) rank = 4;
  else {
    const domain = domainOf(email);
    for (const node of [file, ...ancestorsOf(s, file)]) {
      for (const row of permissionsOf(s, node.id)) {
        if (!rowGrants(s, row, email, domain)) continue;
        // An ancestor folder's owner edits items others created inside it; ownership itself does not inherit.
        const value = row.role === "owner" && node.id !== file.id ? 3 : RANK[row.role] ?? 0;
        if (value > rank) rank = value;
      }
    }
  }
  s.cache.roles.set(key, rank);
  return rank;
}

function isShared(s, file) {
  return [file, ...ancestorsOf(s, file)].some((node) => permissionsOf(s, node.id).some((row) => row.role !== "owner"));
}

/** `writersCanShare` is effective only when the file and every ancestor folder allow it (Google applies the flag down a tree). */
function writersCanShare(s, file) {
  return file.writersCanShare !== false && ancestorsOf(s, file).every((node) => node.writersCanShare !== false);
}

function capabilitiesFor(s, file, rank) {
  const folder = isFolder(file.mimeType);
  const root = file.root === true;
  const owner = rank === 4;
  const writer = rank >= 3;
  const restricted = file.copyRequiresWriterPermission === true && !writer;
  return {
    canAddChildren: folder && writer,
    canChangeCopyRequiresWriterPermission: owner && !root,
    canChangeViewersCanCopyContent: owner && !root,
    canComment: rank >= 2 && !folder,
    canCopy: !folder && !restricted,
    canDelete: owner && !root,
    canDownload: !folder && !restricted,
    canEdit: writer,
    canListChildren: folder,
    canModifyContent: writer && !folder,
    canMoveItemWithinDrive: writer && !root,
    canReadRevisions: writer && !folder,
    canRemoveChildren: folder && writer,
    canRename: writer && !root,
    canShare: !root && (owner || (writer && writersCanShare(s, file))),
    canTrash: owner && !root,
    canUntrash: owner && !root,
  };
}

/** Resolves a file id (or the `root` alias) the caller can see; anything else is 404, as Google answers. */
function visibleFile(s, fileId) {
  const id = fileId === "root" ? ensureUser(s).rootFolderId : fileId;
  const file = typeof id === "string" ? getFile(s, id) : null;
  if (file === null || rankFor(s, s.email, file) === 0) notFound(s, fileId);
  return file;
}

// ---------------------------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------------------------

function userResource(s, email) {
  const user = getUser(s, email);
  const displayName = email === s.email && s.displayName !== undefined ? s.displayName : (user?.displayName ?? email.slice(0, email.indexOf("@")));
  const resource = { kind: "drive#user", displayName, emailAddress: email, me: email === s.email };
  if (user !== null) resource.permissionId = user.permissionId;
  return resource;
}

function permissionResource(s, row, details) {
  const resource = { kind: "drive#permission", id: row.id, type: row.type, role: row.role };
  if (row.emailAddress !== undefined) {
    resource.emailAddress = row.emailAddress;
    const user = row.type === "user" ? getUser(s, normalizeEmail(row.emailAddress)) : null;
    if (user !== null) resource.displayName = user.emailAddress === s.email && s.displayName !== undefined ? s.displayName : user.displayName;
    else if (row.displayName !== undefined) resource.displayName = row.displayName;
  }
  if (row.domain !== undefined) resource.domain = row.domain;
  if (row.displayName !== undefined && resource.displayName === undefined) resource.displayName = row.displayName;
  if (row.allowFileDiscovery !== undefined) resource.allowFileDiscovery = row.allowFileDiscovery;
  if (row.expirationTime !== undefined) resource.expirationTime = row.expirationTime;
  resource.deleted = false;
  if (row.pendingOwner !== undefined) resource.pendingOwner = row.pendingOwner;
  if (details !== undefined) resource.permissionDetails = details;
  return resource;
}

function textOf(s, file) {
  if (file.contentKind !== "text") return "";
  const content = getContent(s, file.id);
  return content === null ? "" : content.data;
}

function extensionsOf(name) {
  const index = name.indexOf(".");
  if (index <= 0 || index === name.length - 1) return {};
  const full = name.slice(index + 1);
  const last = name.slice(name.lastIndexOf(".") + 1);
  return { fullFileExtension: full, fileExtension: last };
}

function fileResource(s, file, { snippets = true } = {}) {
  const rank = rankFor(s, s.email, file);
  const uf = userFile(s, s.email, file.id);
  const folder = isFolder(file.mimeType);
  const shortcut = isShortcut(file.mimeType);
  const blob = !folder && !shortcut && !isGoogleType(file.mimeType);
  const capabilities = capabilitiesFor(s, file, rank);
  const resource = {
    kind: "drive#file",
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
  };
  if (file.description !== undefined) resource.description = file.description;
  resource.starred = uf?.starred === true;
  resource.trashed = file.trashed;
  resource.explicitlyTrashed = file.explicitlyTrashed;
  if (file.trashedTime !== undefined) resource.trashedTime = file.trashedTime;
  if (file.trashingUser !== undefined) resource.trashingUser = userResource(s, file.trashingUser);
  if (file.parents.length > 0) resource.parents = [...file.parents];
  if (file.properties !== undefined) resource.properties = { ...file.properties };
  if (file.appProperties !== undefined) resource.appProperties = { ...file.appProperties };
  resource.spaces = ["drive"];
  resource.version = String(file.version);
  if (blob) resource.webContentLink = webContentLinkFor(file.id);
  resource.webViewLink = webViewLinkFor(file.id, file.mimeType);
  resource.iconLink = iconLinkFor(file.mimeType);
  resource.hasThumbnail = false;
  resource.viewedByMe = uf?.viewedByMeTime !== undefined;
  if (uf?.viewedByMeTime !== undefined) resource.viewedByMeTime = uf.viewedByMeTime;
  resource.createdTime = file.createdTime;
  resource.modifiedTime = file.modifiedTime;
  resource.modifiedByMe = uf?.modifiedByMeTime !== undefined;
  if (uf?.modifiedByMeTime !== undefined) resource.modifiedByMeTime = uf.modifiedByMeTime;
  if (uf?.sharedWithMeTime !== undefined && file.ownerEmail !== s.email) resource.sharedWithMeTime = uf.sharedWithMeTime;
  if (uf?.sharingUser !== undefined && file.ownerEmail !== s.email) resource.sharingUser = userResource(s, uf.sharingUser);
  resource.owners = [userResource(s, file.ownerEmail)];
  resource.lastModifyingUser = userResource(s, file.lastModifyingUser);
  resource.shared = isShared(s, file);
  resource.ownedByMe = file.ownerEmail === s.email;
  resource.capabilities = capabilities;
  resource.viewersCanCopyContent = file.copyRequiresWriterPermission !== true;
  resource.copyRequiresWriterPermission = file.copyRequiresWriterPermission === true;
  resource.writersCanShare = file.writersCanShare === true;
  if (rank === 4) {
    const rows = permissionsOf(s, file.id);
    resource.permissions = rows.map((row) => permissionResource(s, row));
    resource.permissionIds = rows.map((row) => row.id);
  }
  if (file.folderColorRgb !== undefined) resource.folderColorRgb = file.folderColorRgb;
  if (blob) {
    if (file.originalFilename !== undefined) resource.originalFilename = file.originalFilename;
    Object.assign(resource, extensionsOf(file.name));
    if (file.md5Checksum !== undefined) resource.md5Checksum = file.md5Checksum;
  }
  if (file.size !== undefined) resource.size = String(file.size);
  resource.quotaBytesUsed = String(file.size ?? 0);
  if (file.headRevisionId !== undefined) resource.headRevisionId = file.headRevisionId;
  if (file.shortcutDetails !== undefined) resource.shortcutDetails = { ...file.shortcutDetails };
  if (isGoogleTextType(file.mimeType)) {
    resource.exportLinks = Object.fromEntries(EXPORT_FORMATS[file.mimeType].map((mime) => [mime, exportLinkFor(file.id, mime)]));
  }
  resource.isAppAuthorized = false;
  // MCP conveniences (stripped by the REST codec).
  resource.title = file.name;
  if (file.parents.length > 0) resource.parentId = file.parents[0];
  if (file.size !== undefined) resource.fileSize = String(file.size);
  resource.viewUrl = resource.webViewLink;
  resource.owner = file.ownerEmail;
  if (snippets && file.contentKind === "text") {
    const text = textOf(s, file);
    if (text.length > 0) resource.contentSnippet = snippetOf(text);
  }
  resource.canAddChildren = capabilities.canAddChildren;
  return resource;
}

// ---------------------------------------------------------------------------------------------
// Listing: visibility, query views, ordering, pagination
// ---------------------------------------------------------------------------------------------

function visibleFiles(s) {
  return allFiles(s).filter((file) => file.root !== true && rankFor(s, s.email, file) > 0);
}

function visibilityOf(s, file) {
  const rows = permissionsOf(s, file.id);
  const anyone = rows.find((row) => row.type === "anyone");
  if (anyone !== undefined) return anyone.allowFileDiscovery === true ? "anyoneCanFind" : "anyoneWithLink";
  const domain = rows.find((row) => row.type === "domain");
  if (domain !== undefined) return domain.allowFileDiscovery === true ? "domainCanFind" : "domainWithLink";
  return "limited";
}

function queryView(s, file) {
  const uf = userFile(s, s.email, file.id);
  const parent = file.parents.length > 0 ? getFile(s, file.parents[0]) : null;
  let text;
  return {
    name: file.name,
    description: file.description,
    mimeType: file.mimeType,
    trashed: file.trashed,
    starred: uf?.starred === true,
    sharedWithMe: uf?.sharedWithMeTime !== undefined && file.ownerEmail !== s.email,
    modifiedTime: parseTime(file.modifiedTime),
    createdTime: parseTime(file.createdTime),
    viewedByMeTime: uf?.viewedByMeTime === undefined ? undefined : parseTime(uf.viewedByMeTime),
    parentId: file.parents[0],
    parentIsRoot: parent?.root === true && parent.ownerEmail === s.email,
    ownerEmail: file.ownerEmail,
    visibility: visibilityOf(s, file),
    shortcutTargetId: file.shortcutDetails?.targetId,
    properties: file.properties,
    appProperties: file.appProperties,
    text: () => {
      if (text === undefined) text = textOf(s, file);
      return text;
    },
    roleOf: (email) => (isEmail(email) ? rankFor(s, email, file) : 0),
  };
}

function parseOrderBy(s, text, allowed = ORDER_KEYS) {
  const specs = [];
  for (const part of String(text).split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) invalid(s, "Invalid Value", { reason: "invalid", location: "orderBy" });
    const match = /^([A-Za-z_]+)(?:\s+(asc|desc))?$/i.exec(trimmed);
    if (match === null || !allowed.includes(match[1])) invalid(s, "Invalid Value", { reason: "invalid", location: "orderBy" });
    // A repeated key can never break a tie, so later repetitions are dropped (the order is unchanged).
    if (!specs.some((spec) => spec.key === match[1])) specs.push({ key: match[1], desc: (match[2] ?? "asc").toLowerCase() === "desc" });
  }
  return specs;
}

function recencyOf(file, uf) {
  const candidates = [file.modifiedTime, uf?.viewedByMeTime, uf?.modifiedByMeTime, uf?.sharedWithMeTime].filter((value) => value !== undefined);
  return candidates.sort().at(-1) ?? "";
}

function sortValue(s, key, file) {
  const uf = userFile(s, s.email, file.id);
  switch (key) {
    case "createdTime":
      return file.createdTime;
    case "folder":
      return isFolder(file.mimeType) ? 0 : 1;
    case "modifiedByMeTime":
      return uf?.modifiedByMeTime ?? "";
    case "modifiedTime":
      return file.modifiedTime;
    case "name":
    case "name_natural":
      return file.name;
    case "quotaBytesUsed":
      return file.size ?? 0;
    case "recency":
      return recencyOf(file, uf);
    case "sharedWithMeTime":
      return file.ownerEmail === s.email ? "" : (uf?.sharedWithMeTime ?? "");
    case "starred":
      return uf?.starred === true ? 1 : 0;
    case "viewedByMeTime":
      return uf?.viewedByMeTime ?? "";
    default:
      return "";
  }
}

function compareBy(key, left, right) {
  if (key === "name") return compareText(left, right);
  if (key === "name_natural") return compareNatural(left, right);
  return left < right ? -1 : left > right ? 1 : 0;
}

function keyTuple(s, specs, file) {
  return [...specs.map((spec) => sortValue(s, spec.key, file)), file.id];
}

function compareTuples(specs, a, b) {
  for (let index = 0; index < specs.length; index += 1) {
    const result = compareBy(specs[index].key, a[index], b[index]) * (specs[index].desc ? -1 : 1);
    if (result !== 0) return result;
  }
  const x = a[specs.length];
  const y = b[specs.length];
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Longest prefix (code points) of a text sort value kept in a page token; the full value is covered by the digest. */
const TOKEN_TEXT_CLIP = 24;

function codePointPrefix(value, limit) {
  let out = "";
  let count = 0;
  for (const character of value) {
    if (count === limit) return { text: out, clipped: true };
    out += character;
    count += 1;
  }
  return { text: out, clipped: false };
}

/**
 * Token form of one sort value. A text value of at most TOKEN_TEXT_CLIP code points is kept verbatim (exact). A longer one
 * is replaced by a prefix of the comparator's own view of it: the lower-cased value for `name`/`name_natural` (whose
 * comparators lower-case first), with trailing ASCII digits removed for `name_natural` so the prefix never splits a digit
 * run; its bit is set in the token's clipped mask.
 */
function tokenKeyValue(key, value) {
  if (typeof value !== "string") return { value, clipped: false };
  if (!codePointPrefix(value, TOKEN_TEXT_CLIP).clipped) return { value, clipped: false };
  const view = key === "name" || key === "name_natural" ? value.toLowerCase() : value;
  let text = codePointPrefix(view, TOKEN_TEXT_CLIP).text;
  if (key === "name_natural") {
    let end = text.length;
    while (end > 0 && text.charCodeAt(end - 1) >= 48 && text.charCodeAt(end - 1) <= 57) end -= 1;
    text = text.slice(0, end);
  }
  return { value: text, clipped: true };
}

function tokenPosition(specs, item) {
  const k = [];
  let c = 0;
  specs.forEach((spec, index) => {
    const entry = tokenKeyValue(spec.key, item.key[index]);
    k.push(entry.value);
    if (entry.clipped) c += 2 ** index;
  });
  return { i: item.file.id, d: hashText(stableJson(item.key)), k, c };
}

function validTokenKey(value, sample, clipped) {
  if (typeof sample === "number") return !clipped && typeof value === "number" && Number.isFinite(value);
  return typeof value === "string" && value.length <= TOKEN_TEXT_CLIP * 2 && !codePointPrefix(value, TOKEN_TEXT_CLIP).clipped;
}

/**
 * Sign of a row's full sort value against the anchor's former full value when the token holds only a prefix of it
 * (`prefix`), or 0 when the prefix cannot decide. A row whose comparator view starts with the prefix is undecidable;
 * otherwise the rows differ inside the prefix (or the row is a proper prefix of it), which fixes the order against every
 * value that starts with the prefix, so the sign is exact.
 */
function compareToClippedKey(key, value, prefix) {
  const view = key === "name" || key === "name_natural" ? String(value).toLowerCase() : String(value);
  if (view.startsWith(prefix)) return 0;
  if (key === "name_natural") return compareNatural(view, prefix);
  return view < prefix ? -1 : 1;
}

/**
 * Whether a row may come after the anchor's former position (live pagination when the anchor was renamed, moved or
 * trashed). Sound by construction: a row is placed before the resume point only when its full key is provably below the
 * anchor's former key, so an unchanged row is never skipped; rows tied with a clipped prefix are re-sent instead.
 */
function resumesAfter(specs, item, after) {
  for (let index = 0; index < specs.length; index += 1) {
    const direction = specs[index].desc ? -1 : 1;
    const clipped = Math.floor(after.c / 2 ** index) % 2 === 1;
    const sign = clipped
      ? compareToClippedKey(specs[index].key, item.key[index], after.k[index])
      : compareBy(specs[index].key, item.key[index], after.k[index]);
    if (clipped && sign === 0) return true;
    if (sign !== 0) return sign * direction > 0;
  }
  return item.file.id > after.i;
}

/**
 * Sorts files by the order specs and returns one page of rendered resources after the token's position. A page holds at
 * most `pageSize` entries and at most the byte budget of the entries as they are sent (`sizeOf(resource)`); the token is
 * a bounded position: the last file id, a digest of its full sort key and the key with long text reduced to a prefix.
 * When the anchor file still sorts with the same key the page resumes right after it; otherwise (it was renamed, moved or
 * trashed between pages) the page resumes at the first row that is not provably before the anchor's former key, so no
 * unchanged file is skipped (rows sharing a clipped prefix may be sent again).
 */
function paginateFiles(s, files, specs, pageSize, pageToken, scope, render, sizeOf) {
  const keyed = files.map((file) => ({ file, key: keyTuple(s, specs, file) }));
  keyed.sort((a, b) => compareTuples(specs, a.key, b.key));
  let start = 0;
  if (pageToken !== undefined) {
    const after = decodePageToken(pageToken, scope);
    if (
      after === null ||
      typeof after !== "object" ||
      Array.isArray(after) ||
      Object.keys(after).length !== 4 ||
      typeof after.i !== "string" ||
      !FILE_ID_PATTERN.test(after.i) ||
      typeof after.d !== "string" ||
      !/^[0-9a-f]{8}$/.test(after.d) ||
      !Number.isSafeInteger(after.c) ||
      after.c < 0 ||
      after.c >= 2 ** specs.length ||
      !Array.isArray(after.k) ||
      after.k.length !== specs.length ||
      !after.k.every((value, index) =>
        validTokenKey(value, sortValueSample(specs[index].key), Math.floor(after.c / 2 ** index) % 2 === 1),
      )
    ) {
      invalidPageToken(s);
    }
    const anchor = keyed.findIndex((item) => item.file.id === after.i);
    if (anchor >= 0 && hashText(stableJson(keyed[anchor].key)) === after.d) start = anchor + 1;
    else {
      start = keyed.findIndex((item) => resumesAfter(specs, item, after));
      if (start < 0) start = keyed.length;
    }
  }
  const filler = pageFiller(pageSize);
  const resources = [];
  let index = start;
  for (; index < keyed.length; index += 1) {
    const resource = render(keyed[index].file);
    const size = sizeOf(resource);
    if (filler.oversized(size)) precondition(s, "The file resource is too large to be listed by this synthetic service.");
    if (!filler.admit(size)) break;
    resources.push(resource);
  }
  let nextPageToken;
  if (index < keyed.length && resources.length > 0) {
    const last = keyed[index - 1];
    nextPageToken = encodePageToken(scope, tokenPosition(specs, last));
  }
  return { resources, nextPageToken };
}

/** Type sample of a sort key (numbers for the numeric keys, strings for the rest), used to validate empty-list tokens. */
function sortValueSample(key) {
  return key === "folder" || key === "quotaBytesUsed" || key === "starred" ? 0 : "";
}

/**
 * Cost of one list entry on the widest surface that returns it. A `fields` mask only narrows the Drive-shaped REST
 * rendering: the canonical `/v1/operations` endpoint and the MCP aliases return the full operation value and ignore
 * the mask, and MCP carries that value twice. Sizing by the mask alone let a masked REST page of full entries reach
 * several megabytes on those surfaces and answer an opaque 500 after the read had already run, so every entry is
 * measured as the larger of the masked REST rendering and the MCP-framed canonical entry.
 */
function listEntrySizer(fields, vocabulary, restList, listField) {
  if (fields === undefined) return (resource) => mcpSize(resource);
  const empty = jsonSize(maskResource(restList({ [listField]: [] }), fields, vocabulary));
  return (resource) =>
    Math.max(
      Math.max(0, jsonSize(maskResource(restList({ [listField]: [resource] }), fields, vocabulary)) - empty),
      mcpSize(resource),
    );
}

function pageSizeOf(s, value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE) invalid(s, "Invalid Value", { reason: "invalid", location: "pageSize" });
  return value;
}

function validateFields(s, text, vocabulary) {
  if (text === undefined) return;
  try {
    parseMask(text, vocabulary);
  } catch (error) {
    if (error instanceof FieldsError) invalidFields(s);
    throw error;
  }
}

function checkSpaces(s, spaces) {
  if (spaces === undefined) return;
  for (const space of String(spaces).split(",")) {
    if (space.trim() !== "drive") invalid(s, "Invalid Value", { reason: "invalid", location: "spaces" });
  }
}

// ---------------------------------------------------------------------------------------------
// Mutation helpers
// ---------------------------------------------------------------------------------------------

function usageOf(s, email) {
  let usage = 0;
  let inTrash = 0;
  for (const file of allFiles(s)) {
    if (file.ownerEmail !== email || file.size === undefined) continue;
    usage += file.size;
    if (file.trashed) inTrash += file.size;
  }
  return { usage, inTrash };
}

function checkQuota(s, email, additionalBytes) {
  if (additionalBytes <= 0) return;
  const user = getUser(s, email);
  const limit = user?.storageQuotaLimit ?? 0;
  if (limit > 0 && usageOf(s, email).usage + additionalBytes > limit) quotaExceeded(s);
}

function childrenCount(s, folderId) {
  return allFiles(s).filter((file) => file.parents[0] === folderId).length;
}

/** Validates a destination folder for create/copy/move and returns its row. */
function destinationFolder(s, parentId, { requireWriter = true } = {}) {
  const parent = visibleFile(s, parentId);
  if (!isFolder(parent.mimeType)) precondition(s, "The specified parent is not a folder.");
  if (parent.trashed) precondition(s, "The specified parent is in the trash.");
  if (requireWriter && rankFor(s, s.email, parent) < 3) forbidden(s);
  if (ancestorsOf(s, parent).length + 1 > s.limits.depth) {
    precondition(s, `My Drive hierarchy depth limit of ${s.limits.depth} levels exceeded (meta.limits.depth).`);
  }
  if (childrenCount(s, parent.id) >= s.limits.children) {
    precondition(s, `The folder already holds ${s.limits.children} children, the most this synthetic service supports (meta.limits.children).`);
  }
  return parent;
}

function checkFileBound(s) {
  if (allFiles(s).length >= s.limits.files) {
    precondition(s, `The world already holds ${s.limits.files} files, the most this synthetic service supports (meta.limits.files).`);
  }
}

function validateProperties(s, value, name, existing) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(s, `${name} must be an object of string values.`);
  const merged = { ...(existing ?? {}) };
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0 || key.length > 124) invalid(s, `${name} keys must be 1-124 characters.`);
    if (entry === null) delete merged[key];
    else if (typeof entry !== "string" || entry.length > 124) invalid(s, `${name} values must be strings of at most 124 characters.`);
    else merged[key] = entry;
  }
  if (Object.keys(merged).length > MAX_PROPERTIES) invalid(s, `${name} may hold at most ${MAX_PROPERTIES} entries.`);
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function validateName(s, name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 1024) invalid(s, "The name must be 1-1024 characters.");
  return name;
}

function validateDescription(s, value) {
  if (typeof value !== "string" || value.length > 4096) invalid(s, "The description must be at most 4096 characters.");
  return value;
}

/** Turns a content payload into a `contents` row shape (`{ kind, data, byteLength }`), enforcing the 256 KiB bound. */
function contentFrom(s, { textContent, base64Content }, mimeType) {
  if (textContent !== undefined) {
    const bytes = utf8Length(textContent);
    if (bytes > MAX_CONTENT_BYTES) invalid(s, `Content exceeds the ${MAX_CONTENT_BYTES}-byte limit of this synthetic service.`);
    if (isTextMime(mimeType) || isGoogleType(mimeType)) return { kind: "text", data: textContent, byteLength: bytes };
    return { kind: "base64", data: textToBase64(textContent), byteLength: bytes };
  }
  const bytes = decodeBase64(base64Content);
  if (bytes === undefined) invalid(s, "base64Content is not valid base64.");
  if (bytes.length > MAX_CONTENT_BYTES) invalid(s, `Content exceeds the ${MAX_CONTENT_BYTES}-byte limit of this synthetic service.`);
  return { kind: "base64", data: encodeBase64(bytes), byteLength: bytes.length };
}

function blobExtras(s, content) {
  const extras = { size: content.byteLength, headRevisionId: revisionIdFor(next(s, "revisionSequence")) };
  extras.md5Checksum = md5OfContent(content);
  return extras;
}

function descendantsOf(s, folderId) {
  const byParent = new Map();
  for (const file of allFiles(s)) {
    if (file.parents.length === 0) continue;
    const list = byParent.get(file.parents[0]) ?? [];
    list.push(file);
    byParent.set(file.parents[0], list);
  }
  const result = [];
  const queue = [folderId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const child of byParent.get(current) ?? []) {
      result.push(child);
      if (isFolder(child.mimeType)) queue.push(child.id);
    }
  }
  return result;
}

function removedForOf(s, file) {
  const addresses = new Set([file.ownerEmail, s.email]);
  for (const node of [file, ...ancestorsOf(s, file)]) {
    for (const row of permissionsOf(s, node.id)) if (row.type === "user" && typeof row.emailAddress === "string") addresses.add(normalizeEmail(row.emailAddress));
  }
  return [...addresses].slice(0, 100);
}

/**
 * Deletes a subtree: items the caller owns are erased; items owned by others are re-parented to their owner's root
 * (Google keeps them for their owner). Returns the number of erased files.
 */
function deleteSubtree(s, roots) {
  const users = scanAll(s, "users", s.limits.users);
  const toErase = new Map();
  const toOrphan = new Map();
  for (const file of roots) {
    toErase.set(file.id, file);
    if (isFolder(file.mimeType)) {
      for (const descendant of descendantsOf(s, file.id)) {
        if (descendant.ownerEmail === s.email) toErase.set(descendant.id, descendant);
        else toOrphan.set(descendant.id, descendant);
      }
    }
  }
  for (const orphan of toOrphan.values()) {
    if (toErase.has(orphan.parents[0]) || toOrphan.has(orphan.parents[0])) {
      const ownerRoot = getUser(s, orphan.ownerEmail)?.rootFolderId;
      if (ownerRoot === undefined) continue;
      // Only the top of an orphaned subtree moves; its own children keep following it.
      const parentOrphaned = toOrphan.has(orphan.parents[0]);
      if (!parentOrphaned) {
        putFile(s, { ...orphan, parents: [ownerRoot], version: orphan.version + 1 });
        appendChange(s, orphan.id, false);
      }
    }
  }
  // Erase in a deterministic order (row-id order) after computing removedFor for every file.
  const ordered = [...toErase.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const removedFor = new Map(ordered.map((file) => [file.id, removedForOf(s, file)]));
  for (const file of ordered) {
    for (const row of permissionsOf(s, file.id)) removePermission(s, file.id, row.id);
    if (getContent(s, file.id) !== null) {
      s.context.state.delete("contents", file.id);
      s.cache.contents.set(file.id, null);
    }
    for (const user of users) {
      const rowId = userFileRowId(user.emailAddress, file.id);
      if (s.context.state.delete("user-files", rowId)) s.cache.userFiles.set(rowId, null);
    }
    removeFile(s, file.id);
    appendChange(s, file.id, true, removedFor.get(file.id));
  }
  return ordered.length;
}

function recordView(s, file) {
  patchUserFile(s, s.email, file.id, { viewedByMeTime: s.now });
}

function touchModified(s, file) {
  return { ...file, modifiedTime: s.now, lastModifyingUser: s.email };
}

function resolveContentTarget(s, input) {
  const wantsText = input.textContent !== undefined || input.content !== undefined;
  const wantsBase64 = input.base64Content !== undefined;
  if (input.textContent !== undefined && input.content !== undefined && input.textContent !== input.content) {
    invalid(s, "content and textContent must not differ; content is a deprecated alias of textContent.");
  }
  if (wantsText && wantsBase64) invalid(s, "Provide either textContent or base64Content, not both.");
  return { textContent: input.textContent ?? input.content, base64Content: input.base64Content, hasContent: wantsText || wantsBase64 };
}

function validateOptionalMime(s, value, name) {
  if (value === undefined) return undefined;
  if (!isValidMime(value)) invalid(s, `${name} is not a valid MIME type.`);
  return value;
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

const operations = {
  "about.get": (input, context) => {
    const s = session(context);
    validateFields(s, input.fields, "about");
    const user = ensureUser(s);
    const { usage, inTrash } = usageOf(s, s.email);
    const quota = { usage: String(usage), usageInDrive: String(usage), usageInTrash: String(inTrash) };
    if (user.storageQuotaLimit > 0) quota.limit = String(user.storageQuotaLimit);
    return {
      kind: "drive#about",
      user: userResource(s, s.email),
      storageQuota: quota,
      importFormats: Object.fromEntries(Object.entries(IMPORT_FORMATS).map(([key, value]) => [key, [...value]])),
      exportFormats: Object.fromEntries(Object.entries(EXPORT_FORMATS).map(([key, value]) => [key, [...value]])),
      maxImportSizes: Object.fromEntries(Object.keys(EXPORT_FORMATS).map((key) => [key, String(MAX_CONTENT_BYTES)])),
      maxUploadSize: String(MAX_CONTENT_BYTES),
      appInstalled: false,
      canCreateDrives: false,
      folderColorPalette: [...FOLDER_COLOR_PALETTE],
      serverTime: s.now,
    };
  },

  "files.list": (input, context) => {
    const s = session(context);
    ensureUser(s);
    validateFields(s, input.fields, "fileList");
    checkSpaces(s, input.spaces);
    if (input.corpora !== undefined && input.corpora !== "user") invalid(s, "Invalid Value", { reason: "invalid", location: "corpora" });
    const pageSize = pageSizeOf(s, input.pageSize, DEFAULT_PAGE);
    const specs = parseOrderBy(s, input.orderBy ?? DEFAULT_ORDER);
    let tree = null;
    if (hasReplacement(input.query)) invalidQuery(s);
    if (input.query !== undefined && String(input.query).trim().length > 0) {
      try {
        tree = parseQuery(String(input.query));
      } catch (error) {
        if (error instanceof QueryError) invalidQuery(s);
        throw error;
      }
    }
    const matching = visibleFiles(s).filter((file) => tree === null || matchQuery(tree, queryView(s, file)));
    const scope = stableJson({ kind: "list", user: s.email, query: input.query ?? "", orderBy: specs, spaces: input.spaces ?? "drive" });
    const render = (file) => fileResource(s, file, { snippets: input.excludeContentSnippets !== true });
    const sizeOf = listEntrySizer(input.fields, "fileList", restFileList, "files");
    const page = paginateFiles(s, matching, specs, pageSize, input.pageToken, scope, render, sizeOf);
    const result = { kind: "drive#fileList", files: page.resources, incompleteSearch: false };
    if (page.nextPageToken !== undefined) result.nextPageToken = page.nextPageToken;
    return result;
  },

  "files.recent": (input, context) => {
    const s = session(context);
    ensureUser(s);
    const orderBy = input.orderBy ?? "recency";
    if (!RECENT_ORDERS.includes(orderBy)) invalid(s, "Invalid Value", { reason: "invalid", location: "orderBy" });
    const pageSize = pageSizeOf(s, input.pageSize, 10);
    const key = orderBy === "recency" ? "recency" : orderBy === "lastModified" ? "modifiedTime" : "modifiedByMeTime";
    const specs = [{ key, desc: true }];
    const candidates = visibleFiles(s).filter(
      (file) => !file.trashed && !isFolder(file.mimeType) && (key !== "modifiedByMeTime" || userFile(s, s.email, file.id)?.modifiedByMeTime !== undefined),
    );
    const scope = stableJson({ kind: "recent", user: s.email, orderBy });
    const render = (file) => fileResource(s, file, { snippets: input.excludeContentSnippets !== true });
    // files.recent has no Drive-shaped REST route and takes no `fields` mask: it is served on the canonical
    // `/v1/operations` endpoint and the MCP alias, so entries are sized by the MCP-framed canonical value.
    const recentSizeOf = listEntrySizer(undefined, "fileList", restFileList, "files");
    const page = paginateFiles(s, candidates, specs, pageSize, input.pageToken, scope, render, recentSizeOf);
    const result = { files: page.resources };
    if (page.nextPageToken !== undefined) result.nextPageToken = page.nextPageToken;
    return result;
  },

  "files.get": (input, context) => {
    const s = session(context);
    ensureUser(s);
    validateFields(s, input.fields, "file");
    if (input.alt !== undefined && input.alt !== "json" && input.alt !== "media") invalid(s, "Invalid Value", { reason: "invalid", location: "alt" });
    const file = visibleFile(s, input.fileId);
    if (input.alt !== "media") return { file: fileResource(s, file, { snippets: input.excludeContentSnippets !== true }) };
    if (isFolder(file.mimeType) || isShortcut(file.mimeType) || isGoogleType(file.mimeType)) {
      notExportable(s, "Only files with binary content can be downloaded. Use Export with Docs Editors files.");
    }
    const content = getContent(s, file.id) ?? { fileId: file.id, kind: "text", data: "", byteLength: 0 };
    recordView(s, file);
    return { media: { mimeType: file.mimeType, kind: content.kind, data: content.data, byteLength: content.byteLength } };
  },

  "files.create": (input, context) => {
    const s = session(context);
    const user = ensureUser(s);
    validateFields(s, input.fields, "file");
    if (input.uploadType !== undefined && input.uploadType !== "media") {
      invalid(s, `Unsupported upload type ${input.uploadType} in this synthetic service; use uploadType=media with a text body.`, { location: "uploadType" });
    }
    if (input.title !== undefined && input.name !== undefined && input.title !== input.name) invalid(s, "title and name must not differ; title is the MCP spelling of name.");
    const name = validateName(s, input.title ?? input.name ?? "Untitled");
    const description = input.description === undefined ? undefined : validateDescription(s, input.description);
    const target = validateOptionalMime(s, input.mimeType, "mimeType");
    const contentMime = validateOptionalMime(s, input.contentMimeType, "contentMimeType");
    const payload = resolveContentTarget(s, input);
    if (input.parents !== undefined && input.parents.length > 1) invalid(s, "A file can have only one parent.");
    const parentId = input.parentId ?? input.parents?.[0] ?? "root";

    let mimeType;
    let content;
    if (target === FOLDER_MIME) {
      if (payload.hasContent) invalid(s, "Folders cannot have content.");
      if (input.shortcutDetails !== undefined) invalid(s, "Folders cannot carry shortcutDetails.");
      mimeType = FOLDER_MIME;
    } else if (target === SHORTCUT_MIME) {
      if (payload.hasContent) invalid(s, "Shortcuts cannot have content.");
      if (typeof input.shortcutDetails?.targetId !== "string") invalid(s, "shortcutDetails.targetId is required for a shortcut.");
      mimeType = SHORTCUT_MIME;
    } else if (isGoogleType(target)) {
      if (!isGoogleTextType(target)) invalid(s, `Unsupported Google Workspace type ${target}; this synthetic service models documents, spreadsheets and presentations.`);
      if (payload.base64Content !== undefined) invalid(s, "Google Workspace files accept textContent only.");
      if (input.disableConversionToGoogleType === true && payload.hasContent) {
        mimeType = contentMime ?? "text/plain";
        content = contentFrom(s, payload, mimeType);
      } else {
        if (contentMime !== undefined && !canImportTo(contentMime, target)) invalid(s, `Cannot import ${contentMime} as ${target}.`);
        mimeType = target;
        content = contentFrom(s, { textContent: payload.textContent ?? "" }, mimeType);
      }
    } else if (target !== undefined) {
      if (input.shortcutDetails !== undefined) invalid(s, "shortcutDetails is only valid for shortcuts.");
      mimeType = target;
      content = payload.hasContent ? contentFrom(s, payload, mimeType) : { kind: isTextMime(mimeType) ? "text" : "base64", data: "", byteLength: 0 };
    } else {
      if (input.shortcutDetails !== undefined) invalid(s, "shortcutDetails is only valid for shortcuts.");
      mimeType = contentMime ?? (payload.base64Content !== undefined ? "application/octet-stream" : payload.hasContent ? "text/plain" : "application/octet-stream");
      content = payload.hasContent ? contentFrom(s, payload, mimeType) : { kind: isTextMime(mimeType) ? "text" : "base64", data: "", byteLength: 0 };
    }
    if (input.folderColorRgb !== undefined) {
      if (mimeType !== FOLDER_MIME) invalid(s, "folderColorRgb is only valid for folders.");
      if (!FOLDER_COLOR.test(input.folderColorRgb)) invalid(s, "Invalid folderColorRgb.");
    }
    const properties = input.properties === undefined ? undefined : validateProperties(s, input.properties, "properties");
    const appProperties = input.appProperties === undefined ? undefined : validateProperties(s, input.appProperties, "appProperties");
    let shortcutDetails;
    if (mimeType === SHORTCUT_MIME) {
      const targetFile = visibleFile(s, input.shortcutDetails.targetId);
      if (isShortcut(targetFile.mimeType)) invalid(s, "A shortcut cannot point at another shortcut.");
      shortcutDetails = { targetId: targetFile.id, targetMimeType: targetFile.mimeType };
    }

    const parent = destinationFolder(s, parentId);
    checkFileBound(s);
    if (content !== undefined) checkQuota(s, s.email, content.byteLength);

    const id = fileIdFor(next(s, "fileSequence"));
    const file = {
      id,
      name,
      mimeType,
      ownerEmail: s.email,
      parents: [parent.id],
      trashed: false,
      explicitlyTrashed: false,
      createdTime: s.now,
      modifiedTime: s.now,
      lastModifyingUser: s.email,
      version: 1,
      contentKind: content === undefined ? "none" : content.kind,
      writersCanShare: input.writersCanShare !== false,
      copyRequiresWriterPermission: input.copyRequiresWriterPermission === true,
      root: false,
    };
    if (description !== undefined && description.length > 0) file.description = description;
    if (properties !== undefined) file.properties = properties;
    if (appProperties !== undefined) file.appProperties = appProperties;
    if (input.folderColorRgb !== undefined) file.folderColorRgb = input.folderColorRgb.toLowerCase();
    if (shortcutDetails !== undefined) file.shortcutDetails = shortcutDetails;
    if (content !== undefined) {
      file.size = content.byteLength;
      if (!isGoogleType(mimeType)) {
        Object.assign(file, blobExtras(s, content));
        file.originalFilename = name;
      }
      putContent(s, { fileId: id, ...content });
    }
    putFile(s, file);
    putPermission(s, { fileId: id, id: user.permissionId, type: "user", role: "owner", emailAddress: s.email, createdTime: s.now, version: 1 });
    patchUserFile(s, s.email, id, { modifiedByMeTime: s.now, ...(input.starred === true ? { starred: true } : {}) });
    appendChange(s, id, false);
    commit(s);
    context.events.emit("file.created", {
      fileId: id,
      name,
      mimeType,
      parentId: parent.id,
      ownerEmail: s.email,
      actorEmail: s.email,
      source: input.uploadType === "media" ? "upload" : "create",
    });
    return { file: fileResource(s, file) };
  },

  "files.update": (input, context) => {
    const s = session(context);
    ensureUser(s);
    validateFields(s, input.fields, "file");
    if (input.uploadType !== undefined && input.uploadType !== "media") {
      invalid(s, `Unsupported upload type ${input.uploadType} in this synthetic service; use uploadType=media with a text body.`, { location: "uploadType" });
    }
    const file = visibleFile(s, input.fileId);
    const rank = rankFor(s, s.email, file);
    const capabilities = capabilitiesFor(s, file, rank);
    const folder = isFolder(file.mimeType);
    const payload = resolveContentTarget(s, input);
    const metadataKeys = ["name", "description", "mimeType", "folderColorRgb", "properties", "appProperties"].filter((key) => input[key] !== undefined);
    const ownerKeys = ["writersCanShare", "copyRequiresWriterPermission"].filter((key) => input[key] !== undefined);
    const wantsTrash = input.trashed !== undefined;
    const wantsMove = input.addParents !== undefined || input.removeParents !== undefined;
    const perUser = { starred: input.starred, viewedByMeTime: input.viewedByMeTime };
    const wantsPerUser = perUser.starred !== undefined || perUser.viewedByMeTime !== undefined;
    if (metadataKeys.length === 0 && ownerKeys.length === 0 && !wantsTrash && !wantsMove && !wantsPerUser && !payload.hasContent && input.contentMimeType === undefined) {
      invalid(s, "The request carries no fields to update.");
    }

    // Validate every field before touching state.
    const changed = [];
    let updated = { ...file };
    let bump = false;
    let modified = false;
    if (input.name !== undefined) validateName(s, input.name);
    if (input.description !== undefined) validateDescription(s, input.description);
    if (input.mimeType !== undefined) {
      if (!isValidMime(input.mimeType)) invalid(s, "mimeType is not a valid MIME type.");
      if (isGoogleType(file.mimeType) || folder || isShortcut(file.mimeType) || isGoogleType(input.mimeType)) invalid(s, "The mimeType of this file cannot be changed.");
    }
    if (input.folderColorRgb !== undefined) {
      if (!folder) invalid(s, "folderColorRgb is only valid for folders.");
      if (!FOLDER_COLOR.test(input.folderColorRgb)) invalid(s, "Invalid folderColorRgb.");
    }
    const properties = input.properties === undefined ? undefined : validateProperties(s, input.properties, "properties", file.properties);
    const appProperties = input.appProperties === undefined ? undefined : validateProperties(s, input.appProperties, "appProperties", file.appProperties);
    if (input.viewedByMeTime !== undefined && parseTime(input.viewedByMeTime) === undefined) invalid(s, "viewedByMeTime must be an RFC 3339 timestamp.");
    let content;
    let contentMime;
    if (payload.hasContent) {
      if (folder || isShortcut(file.mimeType)) invalid(s, "Folders and shortcuts cannot have content.");
      if (isGoogleType(file.mimeType) && payload.base64Content !== undefined) invalid(s, "Google Workspace files accept textContent only.");
      contentMime = validateOptionalMime(s, input.contentMimeType, "contentMimeType");
      if (isGoogleType(file.mimeType) && contentMime !== undefined && !canImportTo(contentMime, file.mimeType)) invalid(s, `Cannot import ${contentMime} as ${file.mimeType}.`);
      const newMime = isGoogleType(file.mimeType) ? file.mimeType : (input.mimeType ?? contentMime ?? file.mimeType);
      content = contentFrom(s, payload, newMime);
      if (!isGoogleType(file.mimeType) && newMime !== file.mimeType) {
        updated.mimeType = newMime;
        if (!changed.includes("mimeType")) changed.push("mimeType");
      }
    }
    let destination;
    if (wantsMove) {
      if (input.addParents !== undefined) {
        const targets = String(input.addParents).split(",").map((value) => value.trim()).filter((value) => value.length > 0);
        if (targets.length !== 1) invalid(s, "A file can have only one parent.");
        destination = targets[0];
      }
      if (input.removeParents !== undefined) {
        const removals = String(input.removeParents).split(",").map((value) => value.trim()).filter((value) => value.length > 0);
        const currentParent = file.parents[0];
        const rootId = getUser(s, s.email)?.rootFolderId;
        for (const removal of removals) {
          if (removal !== currentParent && !(removal === "root" && currentParent === rootId)) invalid(s, "removeParents must name the file's current parent.");
        }
        if (destination === undefined) invalid(s, "A file must keep exactly one parent; pass addParents with removeParents.");
      }
    }

    // Permissions.
    if (metadataKeys.length > 0 && !(metadataKeys.every((key) => key === "name") ? capabilities.canRename : capabilities.canEdit)) forbidden(s);
    if (metadataKeys.includes("name") && !capabilities.canRename) forbidden(s);
    if (ownerKeys.length > 0 && rank < 4) forbidden(s);
    if (wantsTrash && !(input.trashed ? capabilities.canTrash : capabilities.canUntrash)) forbidden(s);
    if (wantsMove && !capabilities.canMoveItemWithinDrive) forbidden(s);
    if (payload.hasContent && !capabilities.canModifyContent) forbidden(s);

    // Preconditions.
    let destinationFolderRow;
    if (destination !== undefined) {
      const resolvedDestination = destination === "root" ? getUser(s, s.email).rootFolderId : destination;
      if (resolvedDestination !== file.parents[0]) {
        if (resolvedDestination === file.id) precondition(s, "Cannot move a folder into itself or one of its descendants.");
        destinationFolderRow = destinationFolder(s, destination);
        if (folder && ancestorsOf(s, destinationFolderRow).some((node) => node.id === file.id)) {
          precondition(s, "Cannot move a folder into itself or one of its descendants.");
        }
      }
    }
    if (wantsTrash && input.trashed === false && file.trashed) {
      const parent = file.parents.length > 0 ? getFile(s, file.parents[0]) : null;
      if (parent !== null && parent.trashed) precondition(s, "Cannot restore a file whose parent folder is in the trash; restore the folder first.");
    }
    if (content !== undefined) checkQuota(s, file.ownerEmail, content.byteLength - (file.size ?? 0));

    // Apply.
    if (input.name !== undefined && input.name !== file.name) {
      updated.name = input.name;
      changed.push("name");
      modified = true;
    }
    if (input.description !== undefined && (input.description || undefined) !== file.description) {
      if (input.description.length === 0) delete updated.description;
      else updated.description = input.description;
      changed.push("description");
      modified = true;
    }
    if (input.mimeType !== undefined && !payload.hasContent && input.mimeType !== file.mimeType) {
      updated.mimeType = input.mimeType;
      changed.push("mimeType");
      modified = true;
    }
    if (input.folderColorRgb !== undefined && input.folderColorRgb.toLowerCase() !== file.folderColorRgb) {
      updated.folderColorRgb = input.folderColorRgb.toLowerCase();
      changed.push("folderColorRgb");
      modified = true;
    }
    if (input.properties !== undefined && stableJson(properties ?? null) !== stableJson(file.properties ?? null)) {
      if (properties === undefined) delete updated.properties;
      else updated.properties = properties;
      changed.push("properties");
      modified = true;
    }
    if (input.appProperties !== undefined && stableJson(appProperties ?? null) !== stableJson(file.appProperties ?? null)) {
      if (appProperties === undefined) delete updated.appProperties;
      else updated.appProperties = appProperties;
      changed.push("appProperties");
      modified = true;
    }
    for (const key of ownerKeys) {
      if (input[key] !== file[key]) {
        updated[key] = input[key];
        changed.push(key);
        modified = true;
      }
    }
    if (content !== undefined) {
      updated.size = content.byteLength;
      updated.contentKind = content.kind;
      if (!isGoogleType(updated.mimeType)) Object.assign(updated, blobExtras(s, content));
      putContent(s, { fileId: file.id, ...content });
      changed.push("content");
      modified = true;
    }
    const affected = [];
    if (wantsTrash && input.trashed !== file.trashed) {
      if (input.trashed) {
        updated.trashed = true;
        updated.explicitlyTrashed = true;
        updated.trashedTime = s.now;
        updated.trashingUser = s.email;
        if (folder) for (const descendant of descendantsOf(s, file.id)) if (!descendant.trashed) affected.push({ ...descendant, trashed: true, explicitlyTrashed: false, version: descendant.version + 1 });
      } else {
        updated.trashed = false;
        updated.explicitlyTrashed = false;
        delete updated.trashedTime;
        delete updated.trashingUser;
        if (folder) {
          for (const descendant of descendantsOf(s, file.id)) {
            if (descendant.trashed && !descendant.explicitlyTrashed) affected.push({ ...descendant, trashed: false, version: descendant.version + 1 });
          }
        }
      }
      changed.push("trashed");
      bump = true;
    }
    if (destinationFolderRow !== undefined) {
      updated.parents = [destinationFolderRow.id];
      changed.push("parents");
      bump = true;
    }
    if (perUser.starred !== undefined || perUser.viewedByMeTime !== undefined) {
      const current = userFile(s, s.email, file.id);
      const patch = {};
      if (perUser.starred !== undefined && perUser.starred !== (current?.starred === true)) {
        patch.starred = perUser.starred;
        changed.push("starred");
      }
      if (perUser.viewedByMeTime !== undefined) {
        const iso = isoOf(parseTime(perUser.viewedByMeTime));
        if (iso !== current?.viewedByMeTime) {
          patch.viewedByMeTime = iso;
          changed.push("viewedByMeTime");
        }
      }
      if (Object.keys(patch).length > 0) patchUserFile(s, s.email, file.id, patch);
    }
    if (changed.length === 0) {
      commit(s);
      return { file: fileResource(s, file) };
    }
    if (modified || bump) {
      updated.version = file.version + 1;
      if (modified) {
        updated = touchModified(s, updated);
        patchUserFile(s, s.email, file.id, { modifiedByMeTime: s.now });
      }
      putFile(s, updated);
      for (const row of affected) {
        putFile(s, row);
        appendChange(s, row.id, false);
      }
    } else updated = file;
    appendChange(s, file.id, false);
    commit(s);
    context.events.emit("file.changed", {
      fileId: file.id,
      actorEmail: s.email,
      changedFields: changed,
      version: updated.version,
      trashed: updated.trashed,
      ...(updated.parents.length > 0 ? { parentId: updated.parents[0] } : {}),
    });
    return { file: fileResource(s, updated) };
  },

  "files.copy": (input, context) => {
    const s = session(context);
    const user = ensureUser(s);
    validateFields(s, input.fields, "file");
    const source = visibleFile(s, input.fileId);
    if (isFolder(source.mimeType)) invalid(s, "Folders cannot be copied.");
    if (input.title !== undefined && input.name !== undefined && input.title !== input.name) invalid(s, "title and name must not differ; title is the MCP spelling of name.");
    const name = validateName(s, input.title ?? input.name ?? `Copy of ${source.name}`);
    const description = input.description === undefined ? source.description : validateDescription(s, input.description) || undefined;
    if (input.parents !== undefined && input.parents.length > 1) invalid(s, "A file can have only one parent.");
    const rank = rankFor(s, s.email, source);
    if (!capabilitiesFor(s, source, rank).canCopy) forbidden(s, "The user does not have permission to copy this file.");
    const properties = input.properties === undefined ? source.properties : validateProperties(s, input.properties, "properties", source.properties);
    const appProperties = input.appProperties === undefined ? source.appProperties : validateProperties(s, input.appProperties, "appProperties", source.appProperties);
    let parentId = input.parentId ?? input.parents?.[0];
    if (parentId === undefined) {
      const sourceParent = source.parents.length > 0 ? getFile(s, source.parents[0]) : null;
      parentId = sourceParent !== null && !sourceParent.trashed && rankFor(s, s.email, sourceParent) >= 3 ? sourceParent.id : user.rootFolderId;
    }
    const parent = destinationFolder(s, parentId);
    checkFileBound(s);
    const content = getContent(s, source.id);
    if (content !== null) checkQuota(s, s.email, content.byteLength);

    const id = fileIdFor(next(s, "fileSequence"));
    const file = {
      id,
      name,
      mimeType: source.mimeType,
      ownerEmail: s.email,
      parents: [parent.id],
      trashed: false,
      explicitlyTrashed: false,
      createdTime: s.now,
      modifiedTime: s.now,
      lastModifyingUser: s.email,
      version: 1,
      contentKind: source.contentKind,
      writersCanShare: source.writersCanShare,
      copyRequiresWriterPermission: source.copyRequiresWriterPermission,
      root: false,
    };
    if (description !== undefined) file.description = description;
    if (properties !== undefined) file.properties = properties;
    if (appProperties !== undefined) file.appProperties = appProperties;
    if (source.shortcutDetails !== undefined) file.shortcutDetails = { ...source.shortcutDetails };
    if (content !== null) {
      file.size = content.byteLength;
      if (!isGoogleType(source.mimeType)) {
        Object.assign(file, blobExtras(s, content));
        file.originalFilename = source.originalFilename ?? source.name;
      }
      putContent(s, { fileId: id, kind: content.kind, data: content.data, byteLength: content.byteLength });
    }
    putFile(s, file);
    putPermission(s, { fileId: id, id: user.permissionId, type: "user", role: "owner", emailAddress: s.email, createdTime: s.now, version: 1 });
    patchUserFile(s, s.email, id, { modifiedByMeTime: s.now, ...(input.starred === true ? { starred: true } : {}) });
    appendChange(s, id, false);
    commit(s);
    context.events.emit("file.created", { fileId: id, name, mimeType: file.mimeType, parentId: parent.id, ownerEmail: s.email, actorEmail: s.email, source: "copy" });
    return { file: fileResource(s, file) };
  },

  "files.delete": (input, context) => {
    const s = session(context);
    ensureUser(s);
    const file = visibleFile(s, input.fileId);
    if (file.root === true) forbidden(s, "The My Drive root folder cannot be deleted.");
    if (rankFor(s, s.email, file) < 4) forbidden(s, "Only the owner can permanently delete this file.");
    const removedCount = deleteSubtree(s, [file]);
    commit(s);
    context.events.emit("file.deleted", { fileId: file.id, actorEmail: s.email, cascade: isFolder(file.mimeType), removedCount });
    return {};
  },

  "files.empty-trash": (input, context) => {
    const s = session(context);
    ensureUser(s);
    const trashed = allFiles(s).filter((file) => file.trashed && file.ownerEmail === s.email);
    // Explicitly trashed roots of trashed subtrees; their trashed descendants are erased through the cascade.
    const trashedIds = new Set(trashed.map((file) => file.id));
    const roots = trashed.filter((file) => file.parents.length === 0 || !trashedIds.has(file.parents[0]));
    const removedCount = deleteSubtree(s, roots);
    commit(s);
    context.events.emit("file.deleted", { fileId: "", actorEmail: s.email, cascade: roots.some((file) => isFolder(file.mimeType)), removedCount });
    return { deleted: removedCount };
  },

  "files.export": (input, context) => {
    const s = session(context);
    ensureUser(s);
    const file = visibleFile(s, input.fileId);
    if (input.mimeType === undefined || String(input.mimeType).length === 0) invalid(s, "The mimeType field is required.", { reason: "required", location: "mimeType" });
    if (!isGoogleTextType(file.mimeType)) notExportable(s);
    const formats = EXPORT_FORMATS[file.mimeType];
    if (!formats.includes(input.mimeType)) invalid(s, `Export of ${file.mimeType} to ${input.mimeType} is not supported; supported: ${formats.join(", ")}.`, { location: "mimeType" });
    const data = renderExport(file.mimeType, textOf(s, file), input.mimeType);
    if (!exportFits(data)) exportTooLarge(s);
    recordView(s, file);
    return { mimeType: input.mimeType, kind: "text", data, byteLength: utf8Length(data) };
  },

  "files.download": (input, context) => {
    const s = session(context);
    ensureUser(s);
    const file = visibleFile(s, input.fileId);
    if (isFolder(file.mimeType) || isShortcut(file.mimeType)) notExportable(s, "Folders and shortcuts have no downloadable content.");
    if (!capabilitiesFor(s, file, rankFor(s, s.email, file)).canDownload) forbidden(s, "The user does not have permission to download this file.");
    let mimeType = file.mimeType;
    let base64;
    if (isGoogleTextType(file.mimeType)) {
      mimeType = input.exportMimeType ?? defaultExportMime(file.mimeType);
      if (!EXPORT_FORMATS[file.mimeType].includes(mimeType)) invalid(s, `Export of ${file.mimeType} to ${mimeType} is not supported.`, { location: "exportMimeType" });
      const exported = renderExport(file.mimeType, textOf(s, file), mimeType);
      if (!downloadExportFits(exported)) exportTooLarge(s);
      base64 = textToBase64(exported);
    } else if (isGoogleType(file.mimeType)) notExportable(s);
    else {
      const content = getContent(s, file.id);
      base64 = content === null ? "" : contentBase64(content);
    }
    recordView(s, file);
    return { id: file.id, title: file.name, mimeType, content: base64 };
  },

  "files.read-content": (input, context) => {
    const s = session(context);
    ensureUser(s);
    let file = visibleFile(s, input.fileId);
    if (isShortcut(file.mimeType) && file.shortcutDetails !== undefined) file = visibleFile(s, file.shortcutDetails.targetId);
    const fileContent = file.contentKind === "text" ? textOf(s, file) : "";
    recordView(s, file);
    return { fileContent, textFormattingNotSupported: true, commentsNotSupported: true, contentAnchoredComments: [], unanchoredComments: [] };
  },

  "permissions.list": (input, context) => {
    const s = session(context);
    ensureUser(s);
    validateFields(s, input.fields, "permissionList");
    if (input.includePermissionsForView !== undefined && input.includePermissionsForView !== "published") {
      invalid(s, "Invalid Value", { reason: "invalid", location: "includePermissionsForView" });
    }
    const pageSize = pageSizeOf(s, input.pageSize, DEFAULT_PAGE);
    const file = visibleFile(s, input.fileId);
    const rows = permissionsOf(s, file.id).map((row) => permissionResource(s, row));
    const seen = new Set(permissionsOf(s, file.id).map((row) => granteeKey(row)));
    for (const ancestor of ancestorsOf(s, file)) {
      for (const row of permissionsOf(s, ancestor.id)) {
        const key = granteeKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(permissionResource(s, row, [{ permissionType: "file", role: row.role, inheritedFrom: ancestor.id, inherited: true }]));
      }
    }
    const scope = stableJson({ kind: "permissions", user: s.email, fileId: file.id });
    let start = 0;
    if (input.pageToken !== undefined) {
      const after = decodePageToken(input.pageToken, scope);
      if (after === null || typeof after !== "object" || Array.isArray(after) || Object.keys(after).length !== 1) invalidPageToken(s);
      if (!Number.isSafeInteger(after.o) || after.o < 1 || after.o > rows.length) invalidPageToken(s);
      start = after.o;
    }
    const sizeOf = listEntrySizer(input.fields, "permissionList", restPermissionList, "permissions");
    const filler = pageFiller(pageSize);
    const page = [];
    for (let index = start; index < rows.length; index += 1) {
      const size = sizeOf(rows[index]);
      if (filler.oversized(size)) invalid(s, "The permission resource is too large to be listed by this synthetic service.");
      if (!filler.admit(size)) break;
      page.push(rows[index]);
    }
    const result = { kind: "drive#permissionList", permissions: page };
    if (start + page.length < rows.length) result.nextPageToken = encodePageToken(scope, { o: start + page.length });
    return result;
  },

  "permissions.get": (input, context) => {
    const s = session(context);
    ensureUser(s);
    validateFields(s, input.fields, "permission");
    const file = visibleFile(s, input.fileId);
    const row = s.context.state.get("permissions", permissionRowId(file.id, input.permissionId));
    if (row === null) notFound(s, input.permissionId, "Permission");
    return { permission: permissionResource(s, row) };
  },

  "permissions.create": (input, context) => {
    const s = session(context);
    ensureUser(s);
    validateFields(s, input.fields, "permission");
    const file = visibleFile(s, input.fileId);
    const rank = rankFor(s, s.email, file);
    if (!ROLES.includes(input.role)) invalid(s, "Invalid Value", { reason: "invalid", location: "role" });
    if (!PERMISSION_TYPES.includes(input.type)) invalid(s, "Invalid Value", { reason: "invalid", location: "type" });
    if (input.emailMessage !== undefined && input.sendNotificationEmail !== true) invalid(s, "emailMessage requires sendNotificationEmail=true.");
    const transfer = input.transferOwnership === true;
    if (input.role === "owner" && !transfer) invalid(s, "The role owner requires transferOwnership=true.");
    if (transfer && input.role !== "owner") invalid(s, "transferOwnership requires role=owner.");
    if (input.type === "anyone" && input.role === "owner") invalidSharing(s, "Ownership cannot be transferred to anyone.");
    let email;
    let domain;
    if (input.type === "user" || input.type === "group") {
      if (!isEmail(input.emailAddress)) invalid(s, "A valid emailAddress is required for user and group permissions.", { location: "emailAddress" });
      email = normalizeEmail(input.emailAddress);
      if (input.domain !== undefined) invalid(s, "domain is only valid for domain permissions.");
      if (input.allowFileDiscovery !== undefined) invalid(s, "allowFileDiscovery is only valid for domain and anyone permissions.");
    } else if (input.type === "domain") {
      if (typeof input.domain !== "string" || !DOMAIN.test(input.domain)) invalid(s, "A valid domain is required for domain permissions.", { location: "domain" });
      domain = input.domain.toLowerCase();
      if (input.role === "owner") invalid(s, "The role owner requires a user permission.");
    } else if (input.emailAddress !== undefined || input.domain !== undefined) invalid(s, "anyone permissions carry neither emailAddress nor domain.");
    if (input.expirationTime !== undefined) {
      if (input.type !== "user" && input.type !== "group") invalid(s, "expirationTime is only valid for user and group permissions.");
      const expires = parseTime(input.expirationTime);
      if (expires === undefined) invalid(s, "expirationTime must be an RFC 3339 timestamp.");
      if (expires <= s.nowMs) invalid(s, "expirationTime must be in the future.");
      if (input.role === "owner") invalid(s, "An owner permission cannot expire.");
    }
    if (!capabilitiesFor(s, file, rank).canShare) forbidden(s, "The user does not have permission to share this file.");
    if (transfer && rank < 4) forbidden(s, "Only the owner can transfer ownership.");
    if (transfer && input.type !== "user") invalid(s, "Ownership can only be transferred to a user.");

    const rows = permissionsOf(s, file.id);
    const changed = ["permissions"];
    let row;
    if (transfer) {
      const target = getUser(s, email);
      if (target === null) invalidSharing(s, `${email} is not a user of this Drive; ownership can only be transferred to users of the same organization.`);
      if (email === s.email) invalidSharing(s, "The user is already the owner.");
      const previousOwnerRow = rows.find((item) => item.role === "owner");
      if (previousOwnerRow !== undefined) putPermission(s, { ...previousOwnerRow, role: "writer", version: previousOwnerRow.version + 1 });
      const existing = rows.find((item) => item.type === "user" && normalizeEmail(item.emailAddress ?? "") === email);
      row = { fileId: file.id, id: target.permissionId, type: "user", role: "owner", emailAddress: email, createdTime: existing?.createdTime ?? s.now, version: (existing?.version ?? 0) + 1 };
      if (existing !== undefined && existing.id !== target.permissionId) removePermission(s, file.id, existing.id);
      putPermission(s, row);
      let updated = { ...file, ownerEmail: email, version: file.version + 1 };
      changed.push("owners");
      if (input.moveToNewOwnersRoot === true && updated.parents[0] !== target.rootFolderId) {
        updated.parents = [target.rootFolderId];
        changed.push("parents");
      }
      putFile(s, updated);
      if (userFile(s, file.ownerEmail, file.id)?.sharedWithMeTime === undefined) patchUserFile(s, file.ownerEmail, file.id, { sharedWithMeTime: s.now, sharingUser: email });
      appendChange(s, file.id, false);
      commit(s);
      context.events.emit("file.changed", { fileId: file.id, actorEmail: s.email, changedFields: changed, version: updated.version, trashed: updated.trashed, parentId: updated.parents[0] });
      return { permission: permissionResource(s, row) };
    }

    const existing = rows.find((item) => granteeKey(item) === granteeKey({ type: input.type, emailAddress: email, domain }));
    if (existing !== undefined) {
      if (existing.role === "owner") invalidSharing(s, "The owner's access cannot be changed through a new permission.");
      row = { ...existing, role: input.role, version: existing.version + 1 };
      if (input.expirationTime !== undefined) row.expirationTime = isoOf(parseTime(input.expirationTime));
      if (input.allowFileDiscovery !== undefined) row.allowFileDiscovery = input.allowFileDiscovery;
      putPermission(s, row);
    } else {
      if (rows.length >= s.limits.permissions) {
        precondition(s, `The file already holds ${s.limits.permissions} permissions, the most this synthetic service supports (meta.limits.permissions).`);
      }
      let id;
      if (input.type === "anyone") id = "anyoneWithLink";
      else if (input.type === "user" && getUser(s, email) !== null) id = getUser(s, email).permissionId;
      else id = permissionIdFor(next(s, "permissionSequence"));
      row = { fileId: file.id, id, type: input.type, role: input.role, createdTime: s.now, version: 1 };
      if (email !== undefined) row.emailAddress = email;
      if (domain !== undefined) row.domain = domain;
      if (input.type === "domain" || input.type === "anyone") row.allowFileDiscovery = input.allowFileDiscovery === true;
      if (input.expirationTime !== undefined) row.expirationTime = isoOf(parseTime(input.expirationTime));
      putPermission(s, row);
    }
    if (input.type === "user" && getUser(s, email) !== null && email !== file.ownerEmail) {
      const current = userFile(s, email, file.id);
      if (current?.sharedWithMeTime === undefined) patchUserFile(s, email, file.id, { sharedWithMeTime: s.now, sharingUser: s.email });
    }
    appendChange(s, file.id, false);
    commit(s);
    context.events.emit("file.changed", { fileId: file.id, actorEmail: s.email, changedFields: changed, version: file.version, trashed: file.trashed, ...(file.parents.length > 0 ? { parentId: file.parents[0] } : {}) });
    return { permission: permissionResource(s, row) };
  },

  "permissions.update": (input, context) => {
    const s = session(context);
    ensureUser(s);
    validateFields(s, input.fields, "permission");
    const file = visibleFile(s, input.fileId);
    const rank = rankFor(s, s.email, file);
    const existing = s.context.state.get("permissions", permissionRowId(file.id, input.permissionId));
    if (existing === null) notFound(s, input.permissionId, "Permission");
    if (input.role === undefined && input.expirationTime === undefined && input.removeExpiration !== true) invalid(s, "The request carries no fields to update.");
    if (input.role !== undefined && !ROLES.includes(input.role)) invalid(s, "Invalid Value", { reason: "invalid", location: "role" });
    if (input.expirationTime !== undefined) {
      if (existing.type !== "user" && existing.type !== "group") invalid(s, "expirationTime is only valid for user and group permissions.");
      const expires = parseTime(input.expirationTime);
      if (expires === undefined) invalid(s, "expirationTime must be an RFC 3339 timestamp.");
      if (expires <= s.nowMs) invalid(s, "expirationTime must be in the future.");
      if (input.removeExpiration === true) invalid(s, "expirationTime and removeExpiration are mutually exclusive.");
    }
    if (!capabilitiesFor(s, file, rank).canShare) forbidden(s, "The user does not have permission to share this file.");
    if (input.role === "owner") {
      if (input.transferOwnership !== true) invalid(s, "The role owner requires transferOwnership=true.");
      if (rank < 4) forbidden(s, "Only the owner can transfer ownership.");
      if (existing.type !== "user") invalid(s, "Ownership can only be transferred to a user.");
      return operations["permissions.create"](
        { fileId: file.id, role: "owner", type: "user", emailAddress: existing.emailAddress, transferOwnership: true },
        context,
      );
    }
    if (existing.role === "owner") precondition(s, "The owner's permission cannot be demoted or given an expiration; transfer ownership instead.");
    const row = { ...existing, version: existing.version + 1 };
    if (input.role !== undefined) row.role = input.role;
    if (input.expirationTime !== undefined) row.expirationTime = isoOf(parseTime(input.expirationTime));
    if (input.removeExpiration === true) delete row.expirationTime;
    putPermission(s, row);
    appendChange(s, file.id, false);
    commit(s);
    context.events.emit("file.changed", { fileId: file.id, actorEmail: s.email, changedFields: ["permissions"], version: file.version, trashed: file.trashed, ...(file.parents.length > 0 ? { parentId: file.parents[0] } : {}) });
    return { permission: permissionResource(s, row) };
  },

  "permissions.delete": (input, context) => {
    const s = session(context);
    ensureUser(s);
    const file = visibleFile(s, input.fileId);
    const rank = rankFor(s, s.email, file);
    const existing = s.context.state.get("permissions", permissionRowId(file.id, input.permissionId));
    if (existing === null) notFound(s, input.permissionId, "Permission");
    if (!capabilitiesFor(s, file, rank).canShare) forbidden(s, "The user does not have permission to share this file.");
    if (existing.role === "owner") precondition(s, "The owner's permission cannot be removed; transfer ownership instead.");
    removePermission(s, file.id, existing.id);
    appendChange(s, file.id, false);
    commit(s);
    context.events.emit("file.changed", { fileId: file.id, actorEmail: s.email, changedFields: ["permissions"], version: file.version, trashed: file.trashed, ...(file.parents.length > 0 ? { parentId: file.parents[0] } : {}) });
    return {};
  },

  "changes.start-page-token": (input, context) => {
    const s = session(context);
    return { kind: "drive#startPageToken", startPageToken: String(counters(s).changeSequence + 1) };
  },

  "changes.list": (input, context) => {
    const s = session(context);
    ensureUser(s);
    validateFields(s, input.fields, "changeList");
    checkSpaces(s, input.spaces);
    if (input.pageToken === undefined || String(input.pageToken).length === 0) invalid(s, "Required parameter: pageToken", { reason: "required", location: "pageToken" });
    if (!/^[0-9]{1,12}$/.test(String(input.pageToken))) invalidPageToken(s);
    const token = Number.parseInt(String(input.pageToken), 10);
    const sequence = counters(s).changeSequence;
    if (token < 1 || token > sequence + 1) invalidPageToken(s);
    const pageSize = pageSizeOf(s, input.pageSize, DEFAULT_PAGE);
    const includeRemoved = input.includeRemoved !== false;
    const sizeOf = listEntrySizer(input.fields, "changeList", restChangeList, "changes");
    const filler = pageFiller(pageSize);
    const changes = [];
    let after = changeIdFor(token - 1);
    let examined = 0;
    let nextPageToken;
    let exhausted = false;
    while (nextPageToken === undefined && !exhausted) {
      const batch = s.context.state.scan("changes", { afterRowId: after, limit: SCAN_STEP });
      if (batch.length === 0) exhausted = true;
      for (const record of batch) {
        after = record.rowId;
        examined += 1;
        const row = record.value;
        let entry;
        if (row.removed) {
          if (includeRemoved && (row.actorEmail === s.email || (row.removedFor ?? []).includes(s.email))) entry = { kind: "drive#change", changeType: "file", time: row.time, removed: true, fileId: row.fileId };
        } else {
          const file = getFile(s, row.fileId);
          if (file !== null && rankFor(s, s.email, file) > 0) {
            entry = { kind: "drive#change", changeType: "file", time: row.time, removed: false, fileId: row.fileId, file: fileResource(s, file, { snippets: false }) };
          }
        }
        if (entry === undefined) continue;
        const size = sizeOf(entry);
        if (filler.oversized(size)) invalid(s, "The change resource is too large to be listed by this synthetic service.");
        if (!filler.admit(size)) {
          nextPageToken = String(Number.parseInt(row.changeId, 10));
          break;
        }
        changes.push(entry);
      }
      if (nextPageToken === undefined && batch.length < SCAN_STEP) exhausted = true;
      if (nextPageToken === undefined && !exhausted && examined >= HARD_SCAN_CAP) nextPageToken = String(Number.parseInt(after, 10) + 1);
    }
    const result = { kind: "drive#changeList", changes };
    if (nextPageToken !== undefined) result.nextPageToken = nextPageToken;
    else result.newStartPageToken = String(sequence + 1);
    return result;
  },
};

function granteeKey(row) {
  if (row.type === "user" || row.type === "group") return `${row.type}:${normalizeEmail(row.emailAddress ?? "")}`;
  if (row.type === "domain") return `domain:${String(row.domain ?? "").toLowerCase()}`;
  return "anyone";
}

// ---------------------------------------------------------------------------------------------
// HTTP codecs (pure): Drive API v3 spelling in, Drive-shaped bodies out
// ---------------------------------------------------------------------------------------------

function one(query, name) {
  const values = query[name];
  return values === undefined || values.length === 0 ? undefined : values[0];
}

function booleanParam(query, name) {
  const value = one(query, name);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be true or false`);
}

function integerParam(query, name) {
  const value = one(query, name);
  if (value === undefined) return undefined;
  if (!/^-?\d{1,9}$/.test(value)) throw new TypeError(`${name} must be an integer`);
  return Number.parseInt(value, 10);
}

function pathParam(request, name) {
  const value = request.path[name];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}

function jsonBody(request) {
  guardBody(request);
  if (request.body.kind !== "json") return {};
  const value = request.body.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("request body must be a JSON object");
  return value;
}

// Every route that accepts a body runs this first: a JSON body nested past MAX_JSON_DEPTH would pass the framework's
// body parser and then overflow its recursive argument validation, answering an opaque 500 after the request was
// already accepted. Depth is measured with an explicit stack (never recursion on the caller's nesting).
function guardBody(request) {
  if (request.body.kind === "json") assertJsonDepth(request.body.value);
  return request;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function mutation(request, args) {
  guardBody(request);
  const key = one(request.headers, "idempotency-key");
  return { arguments: compact(args), ...(key === undefined || key.length === 0 ? {} : { idempotencyKey: key }) };
}

function rejectSharedDriveParams(query) {
  for (const name of ["driveId", "teamDriveId", "includeTeamDriveItems", "corpus"]) {
    if (one(query, name) !== undefined) throw new TypeError(`${name} is not supported: shared drives are not part of this synthetic service`);
  }
}

function mediaType(request) {
  const header = one(request.headers, "content-type");
  const type = header?.split(";", 1)[0]?.trim().toLowerCase();
  return type === undefined || type.length === 0 ? "application/octet-stream" : type;
}

function textBody(request) {
  guardBody(request);
  return request.body.kind === "text" ? request.body.value : "";
}

function fileMetadata(body) {
  return {
    name: body.name,
    mimeType: body.mimeType,
    parents: body.parents,
    description: body.description,
    starred: body.starred,
    properties: body.properties,
    appProperties: body.appProperties,
    folderColorRgb: body.folderColorRgb,
    shortcutDetails: body.shortcutDetails,
    writersCanShare: body.writersCanShare,
    copyRequiresWriterPermission: body.copyRequiresWriterPermission,
  };
}

function encodeJson(render, vocabulary) {
  return ({ invocation, outcome }) => {
    if (outcome.status !== "ok") return driveError(outcome);
    const resource = maskResource(render(outcome.value), invocation.arguments.fields, vocabulary);
    return { body: { kind: "json", value: resource } };
  };
}

function encodeEmpty({ outcome }) {
  if (outcome.status !== "ok") return driveError(outcome);
  return { body: { kind: "empty" } };
}

function safeContentType(mimeType) {
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType) ? mimeType : "application/octet-stream";
}

const fileResponse = ({ invocation, outcome }) => {
  if (outcome.status !== "ok") return driveError(outcome);
  if (outcome.value.media !== undefined) {
    const media = outcome.value.media;
    const contentType = safeContentType(media.mimeType);
    if (media.kind === "text") return { body: { kind: "text", value: media.data, contentType: `${contentType}; charset=utf-8` } };
    return { body: { kind: "bytes", value: Uint8Array.from(decodeBase64(media.data) ?? []), contentType } };
  }
  const resource = maskResource(restFile(outcome.value.file), invocation.arguments.fields, "file");
  return { body: { kind: "json", value: resource } };
};

const permissionResponse = encodeJson((value) => value.permission, "permission");

const http = {
  "get-about": {
    decode: (request) => ({ arguments: compact({ fields: one(request.query, "fields") }) }),
    encode: encodeJson(restAbout, "about"),
  },
  "list-files": {
    decode: (request) => {
      rejectSharedDriveParams(request.query);
      return {
        arguments: compact({
          query: one(request.query, "q"),
          pageSize: integerParam(request.query, "pageSize"),
          pageToken: one(request.query, "pageToken"),
          orderBy: one(request.query, "orderBy"),
          spaces: one(request.query, "spaces"),
          corpora: one(request.query, "corpora"),
          fields: one(request.query, "fields"),
          includeItemsFromAllDrives: booleanParam(request.query, "includeItemsFromAllDrives"),
          supportsAllDrives: booleanParam(request.query, "supportsAllDrives"),
        }),
      };
    },
    encode: encodeJson(restFileList, "fileList"),
  },
  "get-file": {
    decode: (request) => ({
      arguments: compact({
        fileId: pathParam(request, "fileId"),
        fields: one(request.query, "fields"),
        alt: one(request.query, "alt"),
        acknowledgeAbuse: booleanParam(request.query, "acknowledgeAbuse"),
        supportsAllDrives: booleanParam(request.query, "supportsAllDrives"),
      }),
    }),
    encode: fileResponse,
  },
  "create-file": {
    decode: (request) => {
      const body = jsonBody(request);
      if (body.id !== undefined) throw new TypeError("client-assigned ids (files.generateIds) are not supported");
      return mutation(request, {
        ...fileMetadata(body),
        fields: one(request.query, "fields"),
        ignoreDefaultVisibility: booleanParam(request.query, "ignoreDefaultVisibility"),
        keepRevisionForever: booleanParam(request.query, "keepRevisionForever"),
        supportsAllDrives: booleanParam(request.query, "supportsAllDrives"),
      });
    },
    encode: fileResponse,
  },
  "upload-file-media": {
    decode: (request) =>
      mutation(request, {
        uploadType: one(request.query, "uploadType") ?? "",
        contentMimeType: mediaType(request),
        textContent: textBody(request),
        fields: one(request.query, "fields"),
        keepRevisionForever: booleanParam(request.query, "keepRevisionForever"),
        supportsAllDrives: booleanParam(request.query, "supportsAllDrives"),
      }),
    encode: fileResponse,
  },
  "update-file": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, {
        fileId: pathParam(request, "fileId"),
        name: body.name,
        description: body.description,
        mimeType: body.mimeType,
        starred: body.starred,
        trashed: body.trashed,
        folderColorRgb: body.folderColorRgb,
        properties: body.properties,
        appProperties: body.appProperties,
        writersCanShare: body.writersCanShare,
        copyRequiresWriterPermission: body.copyRequiresWriterPermission,
        viewedByMeTime: body.viewedByMeTime,
        addParents: one(request.query, "addParents"),
        removeParents: one(request.query, "removeParents"),
        fields: one(request.query, "fields"),
        keepRevisionForever: booleanParam(request.query, "keepRevisionForever"),
        supportsAllDrives: booleanParam(request.query, "supportsAllDrives"),
      });
    },
    encode: fileResponse,
  },
  "upload-update-file-media": {
    decode: (request) =>
      mutation(request, {
        fileId: pathParam(request, "fileId"),
        uploadType: one(request.query, "uploadType") ?? "",
        contentMimeType: mediaType(request),
        textContent: textBody(request),
        addParents: one(request.query, "addParents"),
        removeParents: one(request.query, "removeParents"),
        fields: one(request.query, "fields"),
        keepRevisionForever: booleanParam(request.query, "keepRevisionForever"),
        supportsAllDrives: booleanParam(request.query, "supportsAllDrives"),
      }),
    encode: fileResponse,
  },
  "copy-file": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, {
        fileId: pathParam(request, "fileId"),
        name: body.name,
        parents: body.parents,
        description: body.description,
        starred: body.starred,
        properties: body.properties,
        appProperties: body.appProperties,
        fields: one(request.query, "fields"),
        supportsAllDrives: booleanParam(request.query, "supportsAllDrives"),
      });
    },
    encode: fileResponse,
  },
  "delete-file": {
    decode: (request) => mutation(request, { fileId: pathParam(request, "fileId"), supportsAllDrives: booleanParam(request.query, "supportsAllDrives") }),
    encode: encodeEmpty,
  },
  "export-file": {
    decode: (request) => ({ arguments: compact({ fileId: pathParam(request, "fileId"), mimeType: one(request.query, "mimeType") }) }),
    encode: ({ outcome }) => {
      if (outcome.status !== "ok") return driveError(outcome);
      return { body: { kind: "text", value: outcome.value.data, contentType: `${safeContentType(outcome.value.mimeType)}; charset=utf-8` } };
    },
  },
  "list-permissions": {
    decode: (request) => ({
      arguments: compact({
        fileId: pathParam(request, "fileId"),
        pageSize: integerParam(request.query, "pageSize"),
        pageToken: one(request.query, "pageToken"),
        fields: one(request.query, "fields"),
        supportsAllDrives: booleanParam(request.query, "supportsAllDrives"),
        includePermissionsForView: one(request.query, "includePermissionsForView"),
      }),
    }),
    encode: encodeJson(restPermissionList, "permissionList"),
  },
  "get-permission": {
    decode: (request) => ({
      arguments: compact({ fileId: pathParam(request, "fileId"), permissionId: pathParam(request, "permissionId"), fields: one(request.query, "fields") }),
    }),
    encode: permissionResponse,
  },
  "create-permission": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, {
        fileId: pathParam(request, "fileId"),
        role: body.role,
        type: body.type,
        emailAddress: body.emailAddress,
        domain: body.domain,
        allowFileDiscovery: body.allowFileDiscovery,
        expirationTime: body.expirationTime,
        transferOwnership: booleanParam(request.query, "transferOwnership"),
        moveToNewOwnersRoot: booleanParam(request.query, "moveToNewOwnersRoot"),
        sendNotificationEmail: booleanParam(request.query, "sendNotificationEmail"),
        emailMessage: one(request.query, "emailMessage"),
        fields: one(request.query, "fields"),
        supportsAllDrives: booleanParam(request.query, "supportsAllDrives"),
      });
    },
    encode: permissionResponse,
  },
  "update-permission": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, {
        fileId: pathParam(request, "fileId"),
        permissionId: pathParam(request, "permissionId"),
        role: body.role,
        expirationTime: body.expirationTime,
        removeExpiration: booleanParam(request.query, "removeExpiration"),
        transferOwnership: booleanParam(request.query, "transferOwnership"),
        fields: one(request.query, "fields"),
      });
    },
    encode: permissionResponse,
  },
  "delete-permission": {
    decode: (request) => mutation(request, { fileId: pathParam(request, "fileId"), permissionId: pathParam(request, "permissionId") }),
    encode: encodeEmpty,
  },
  "get-start-page-token": {
    decode: () => ({ arguments: {} }),
    encode: encodeJson((value) => value, "startPageToken"),
  },
  "list-changes": {
    decode: (request) => {
      rejectSharedDriveParams(request.query);
      return {
        arguments: compact({
          pageToken: one(request.query, "pageToken"),
          pageSize: integerParam(request.query, "pageSize"),
          includeRemoved: booleanParam(request.query, "includeRemoved"),
          restrictToMyDrive: booleanParam(request.query, "restrictToMyDrive"),
          spaces: one(request.query, "spaces"),
          fields: one(request.query, "fields"),
          includeItemsFromAllDrives: booleanParam(request.query, "includeItemsFromAllDrives"),
          supportsAllDrives: booleanParam(request.query, "supportsAllDrives"),
        }),
      };
    },
    encode: encodeJson(restChangeList, "changeList"),
  },
};

export default { operations, http };
