// Drive API v3 wire shapes: the classic error envelope, REST resources from canonical values (the MCP conveniences are
// stripped), the field vocabularies used by `fields` masks. Pure functions only, shared by the handlers and the HTTP codecs.
import { applyFields, parseFields } from "./fields.mjs";

const ERROR_MAP = {
  NOT_FOUND: { status: 404, domain: "global", reason: "notFound" },
  INVALID_ARGUMENT: { status: 400, domain: "global", reason: "badRequest" },
  INVALID_PAGE_TOKEN: { status: 400, domain: "global", reason: "badRequest", locationType: "parameter", location: "pageToken" },
  INVALID_SHARING_REQUEST: { status: 400, domain: "global", reason: "invalidSharingRequest" },
  FAILED_PRECONDITION: { status: 400, domain: "global", reason: "badRequest" },
  FORBIDDEN: { status: 403, domain: "global", reason: "insufficientFilePermissions" },
  NOT_EXPORTABLE: { status: 403, domain: "global", reason: "fileNotExportable" },
  RATE_LIMITED: { status: 403, domain: "usageLimits", reason: "userRateLimitExceeded" },
  SHARING_RATE_LIMITED: { status: 403, domain: "global", reason: "sharingRateLimitExceeded" },
  STORAGE_QUOTA_EXCEEDED: { status: 403, domain: "global", reason: "storageQuotaExceeded" },
  BACKEND_ERROR: { status: 500, domain: "global", reason: "backendError" },
};

/** Drive-shaped error envelope for any non-ok outcome (framework outcomes included). */
export function driveError(outcome) {
  const error = outcome.error ?? {};
  let mapping;
  let message = typeof error.message === "string" && error.message.length > 0 ? error.message : "Bad Request";
  if (outcome.status === "tool_error") {
    const code = String(error.code ?? "").replace(/^tool\./, "");
    mapping = { ...(ERROR_MAP[code] ?? { status: 500, domain: "global", reason: "backendError" }) };
    const details = error.details;
    if (details !== null && typeof details === "object") {
      if (typeof details.reason === "string") mapping.reason = details.reason;
      if (typeof details.location === "string") {
        mapping.location = details.location;
        mapping.locationType = typeof details.locationType === "string" ? details.locationType : "parameter";
      }
    }
  } else if (outcome.status === "denied") {
    mapping = { status: 403, domain: "global", reason: "insufficientPermissions" };
    message = "Insufficient Permission";
  } else if (outcome.status === "unsupported") {
    mapping = { status: 404, domain: "global", reason: "notFound" };
    message = "Not Found";
  } else {
    mapping = { status: 400, domain: "global", reason: "badRequest" };
  }
  const detail = { domain: mapping.domain, reason: mapping.reason, message };
  if (mapping.locationType !== undefined) {
    detail.locationType = mapping.locationType;
    detail.location = mapping.location;
  }
  return {
    headers: mapping.reason === "userRateLimitExceeded" ? { "retry-after": "30" } : {},
    body: { kind: "json", value: { error: { errors: [detail], code: mapping.status, message } } },
  };
}

/** MCP-only conveniences carried by the canonical File; the REST codec drops them. */
export const MCP_FILE_FIELDS = ["title", "parentId", "fileSize", "viewUrl", "owner", "contentSnippet", "canAddChildren"];

/** REST `File` field names (the `fields` vocabulary). */
export const FILE_FIELDS = [
  "kind", "id", "name", "mimeType", "description", "starred", "trashed", "explicitlyTrashed", "trashedTime", "trashingUser",
  "parents", "properties", "appProperties", "spaces", "version", "webContentLink", "webViewLink", "iconLink", "hasThumbnail",
  "viewedByMe", "viewedByMeTime", "createdTime", "modifiedTime", "modifiedByMe", "modifiedByMeTime", "sharedWithMeTime",
  "sharingUser", "owners", "lastModifyingUser", "shared", "ownedByMe", "capabilities", "viewersCanCopyContent",
  "copyRequiresWriterPermission", "writersCanShare", "permissions", "permissionIds", "folderColorRgb", "originalFilename",
  "fullFileExtension", "fileExtension", "md5Checksum", "size", "quotaBytesUsed", "headRevisionId", "shortcutDetails",
  "exportLinks", "isAppAuthorized", "driveId", "thumbnailLink",
];
export const FILE_LIST_FIELDS = ["kind", "nextPageToken", "incompleteSearch", "files"];
export const PERMISSION_FIELDS = [
  "kind", "id", "type", "emailAddress", "domain", "role", "allowFileDiscovery", "displayName", "photoLink", "expirationTime",
  "deleted", "pendingOwner", "permissionDetails", "view",
];
export const PERMISSION_LIST_FIELDS = ["kind", "nextPageToken", "permissions"];
export const ABOUT_FIELDS = [
  "kind", "user", "storageQuota", "importFormats", "exportFormats", "maxImportSizes", "maxUploadSize", "appInstalled",
  "folderColorPalette", "canCreateDrives", "canCreateTeamDrives", "driveThemes",
];
export const CHANGE_FIELDS = ["kind", "changeType", "time", "removed", "fileId", "file", "driveId", "drive", "type"];
export const CHANGE_LIST_FIELDS = ["kind", "nextPageToken", "newStartPageToken", "changes"];
export const START_PAGE_TOKEN_FIELDS = ["kind", "startPageToken"];

export const FIELD_VOCABULARY = {
  file: { known: FILE_FIELDS, sub: { capabilities: null } },
  fileList: { known: FILE_LIST_FIELDS, sub: { files: FILE_FIELDS } },
  permission: { known: PERMISSION_FIELDS, sub: {} },
  permissionList: { known: PERMISSION_LIST_FIELDS, sub: { permissions: PERMISSION_FIELDS } },
  about: { known: ABOUT_FIELDS, sub: {} },
  changeList: { known: CHANGE_LIST_FIELDS, sub: { changes: CHANGE_FIELDS } },
  startPageToken: { known: START_PAGE_TOKEN_FIELDS, sub: {} },
};

/** Parses a `fields` mask against one resource vocabulary; throws FieldsError on unknown names. */
export function parseMask(text, resource) {
  const vocabulary = FIELD_VOCABULARY[resource];
  const sub = Object.fromEntries(Object.entries(vocabulary.sub).filter(([, value]) => value !== null));
  return parseFields(text, vocabulary.known, sub);
}

export function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** Canonical File → REST File: drops the MCP conveniences. */
export function restFile(file) {
  const out = { ...file };
  for (const name of MCP_FILE_FIELDS) delete out[name];
  return out;
}

export function restFileList(value) {
  return withoutUndefined({
    kind: "drive#fileList",
    nextPageToken: value.nextPageToken,
    incompleteSearch: value.incompleteSearch ?? false,
    files: value.files.map(restFile),
  });
}

export function restPermissionList(value) {
  return withoutUndefined({ kind: "drive#permissionList", nextPageToken: value.nextPageToken, permissions: value.permissions });
}

export function restAbout(value) {
  const { serverTime, ...rest } = value;
  return rest;
}

export function restChangeList(value) {
  return withoutUndefined({
    kind: "drive#changeList",
    nextPageToken: value.nextPageToken,
    newStartPageToken: value.newStartPageToken,
    changes: value.changes.map((change) => withoutUndefined({ ...change, file: change.file === undefined ? undefined : restFile(change.file) })),
  });
}

/** Applies an already-validated `fields` mask (from the invocation arguments) to a REST resource. */
export function maskResource(resource, fieldsText, vocabulary) {
  if (fieldsText === undefined) return resource;
  let parsed;
  try {
    parsed = parseMask(fieldsText, vocabulary);
  } catch {
    return resource;
  }
  return applyFields(resource, parsed);
}
