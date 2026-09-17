// Two provider error envelopes and the REST resource shapes.
//
// A Docs agent meets both Google families at once: the Docs API v1 answers the google.rpc error model
// (`{"error":{"code","message","status","details"}}`) and the Drive API v3 answers the classic envelope
// (`{"error":{"errors":[{domain,reason,message,locationType,location}],"code","message"}}`). Pure functions only,
// shared by the handlers and the HTTP codecs.

import { applyFields, parseFields } from "./fields.mjs";

const DOCS_STATUS = {
  INVALID_ARGUMENT: { status: 400, status_: "INVALID_ARGUMENT" },
  FAILED_PRECONDITION: { status: 400, status_: "FAILED_PRECONDITION" },
  NOT_FOUND: { status: 404, status_: "NOT_FOUND" },
  PERMISSION_DENIED: { status: 403, status_: "PERMISSION_DENIED" },
  RATE_LIMITED: { status: 429, status_: "RESOURCE_EXHAUSTED" },
  BACKEND_ERROR: { status: 500, status_: "INTERNAL" },
  UNAVAILABLE: { status: 503, status_: "UNAVAILABLE" },
};

const DRIVE_STATUS = {
  NOT_FOUND: { status: 404, domain: "global", reason: "notFound" },
  INVALID_ARGUMENT: { status: 400, domain: "global", reason: "invalid" },
  INVALID_PAGE_TOKEN: { status: 400, domain: "global", reason: "badRequest", locationType: "parameter", location: "pageToken" },
  INVALID_SHARING_REQUEST: { status: 400, domain: "global", reason: "invalidSharingRequest" },
  FAILED_PRECONDITION: { status: 400, domain: "global", reason: "badRequest" },
  PERMISSION_DENIED: { status: 403, domain: "global", reason: "insufficientFilePermissions" },
  NOT_EXPORTABLE: { status: 403, domain: "global", reason: "fileNotExportable" },
  EXPORT_SIZE_LIMIT_EXCEEDED: { status: 403, domain: "global", reason: "exportSizeLimitExceeded" },
  RATE_LIMITED: { status: 403, domain: "usageLimits", reason: "userRateLimitExceeded" },
  BACKEND_ERROR: { status: 500, domain: "global", reason: "backendError" },
};

function toolErrorCode(outcome) {
  const code = String(outcome.error?.code ?? "");
  return code.startsWith("tool.") ? code.slice(5) : undefined;
}

/** Google Cloud API (google.rpc) error envelope, used by every `/v1/documents…` route. */
export function docsError(outcome) {
  const error = outcome.error ?? {};
  let message = typeof error.message === "string" && error.message.length > 0 ? error.message : "Invalid request.";
  let mapping = { status: 400, status_: "INVALID_ARGUMENT" };
  let details;
  if (outcome.status === "tool_error") {
    const code = toolErrorCode(outcome);
    mapping = DOCS_STATUS[code] ?? { status: 500, status_: "INTERNAL" };
    if (mapping.status_ === "INVALID_ARGUMENT" && typeof error.details?.field === "string") {
      details = [
        {
          "@type": "type.googleapis.com/google.rpc.BadRequest",
          fieldViolations: [{ field: error.details.field, description: message }],
        },
      ];
    }
  } else if (outcome.status === "denied") {
    mapping = { status: 403, status_: "PERMISSION_DENIED" };
    message = "Request had insufficient authentication scopes.";
  } else if (outcome.status === "unsupported") {
    mapping = { status: 404, status_: "NOT_FOUND" };
    message = "Requested entity was not found.";
  }
  const body = { error: { code: mapping.status, message, status: mapping.status_ } };
  if (details !== undefined) body.error.details = details;
  return {
    headers: mapping.status_ === "RESOURCE_EXHAUSTED" ? { "retry-after": "30" } : {},
    body: { kind: "json", value: body },
  };
}

/** Drive API v3 classic error envelope, used by every `/drive/v3/…` route. */
export function driveError(outcome) {
  const error = outcome.error ?? {};
  let message = typeof error.message === "string" && error.message.length > 0 ? error.message : "Bad Request";
  let mapping;
  if (outcome.status === "tool_error") {
    mapping = { ...(DRIVE_STATUS[toolErrorCode(outcome)] ?? { status: 500, domain: "global", reason: "backendError" }) };
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

// ---------------------------------------------------------------------------------------------
// `fields` vocabularies
// ---------------------------------------------------------------------------------------------

export const FILE_FIELDS = [
  "kind", "id", "name", "mimeType", "description", "starred", "trashed", "explicitlyTrashed", "trashedTime", "createdTime",
  "modifiedTime", "modifiedByMe", "modifiedByMeTime", "viewedByMe", "viewedByMeTime", "sharedWithMeTime", "sharingUser",
  "owners", "lastModifyingUser", "shared", "ownedByMe", "capabilities", "permissions", "permissionIds", "version",
  "webViewLink", "iconLink", "exportLinks", "quotaBytesUsed", "size", "isAppAuthorized", "hasThumbnail", "spaces",
];
export const FILE_LIST_FIELDS = ["kind", "nextPageToken", "incompleteSearch", "files"];
export const PERMISSION_FIELDS = [
  "kind", "id", "type", "emailAddress", "domain", "role", "allowFileDiscovery", "displayName", "deleted", "pendingOwner",
];
export const PERMISSION_LIST_FIELDS = ["kind", "nextPageToken", "permissions"];
export const COMMENT_FIELDS = [
  "kind", "id", "createdTime", "modifiedTime", "author", "htmlContent", "content", "deleted", "resolved", "quotedFileContent",
  "anchor", "replies",
];
export const COMMENT_LIST_FIELDS = ["kind", "nextPageToken", "comments"];
export const REPLY_FIELDS = ["kind", "id", "createdTime", "modifiedTime", "author", "htmlContent", "content", "deleted", "action"];
export const REPLY_LIST_FIELDS = ["kind", "nextPageToken", "replies"];
export const REVISION_FIELDS = [
  "kind", "id", "mimeType", "modifiedTime", "lastModifyingUser", "keepForever", "published", "publishAuto",
  "publishedOutsideDomain", "exportLinks",
];
export const REVISION_LIST_FIELDS = ["kind", "nextPageToken", "revisions"];
export const ABOUT_FIELDS = [
  "kind", "user", "storageQuota", "importFormats", "exportFormats", "maxImportSizes", "maxUploadSize", "appInstalled",
  "canCreateDrives",
];

export const USER_FIELDS = ["kind", "displayName", "emailAddress", "me", "permissionId", "photoLink"];
export const STORAGE_QUOTA_FIELDS = ["limit", "usage", "usageInDrive", "usageInTrash"];
export const QUOTED_CONTENT_FIELDS = ["mimeType", "value"];
/** Drive capability names follow `canXxx`; a name this Tool does not compute is accepted and simply absent. */
export const CAPABILITY_NAME = /^can[A-Z][A-Za-z]*$/;

/** Each resource's names, and for object-valued fields the vocabulary a nested sub-selection is checked against. */
export const FIELD_VOCABULARY = {
  user: { known: USER_FIELDS, sub: {} },
  capabilities: { known: CAPABILITY_NAME, sub: {} },
  storageQuota: { known: STORAGE_QUOTA_FIELDS, sub: {} },
  quotedFileContent: { known: QUOTED_CONTENT_FIELDS, sub: {} },
  file: {
    known: FILE_FIELDS,
    sub: {
      capabilities: "capabilities",
      owners: "user",
      sharingUser: "user",
      lastModifyingUser: "user",
      permissions: "permission",
    },
  },
  fileList: { known: FILE_LIST_FIELDS, sub: { files: "file" } },
  permission: { known: PERMISSION_FIELDS, sub: {} },
  permissionList: { known: PERMISSION_LIST_FIELDS, sub: { permissions: "permission" } },
  comment: { known: COMMENT_FIELDS, sub: { author: "user", quotedFileContent: "quotedFileContent", replies: "reply" } },
  commentList: { known: COMMENT_LIST_FIELDS, sub: { comments: "comment" } },
  reply: { known: REPLY_FIELDS, sub: { author: "user" } },
  replyList: { known: REPLY_LIST_FIELDS, sub: { replies: "reply" } },
  revision: { known: REVISION_FIELDS, sub: { lastModifyingUser: "user" } },
  revisionList: { known: REVISION_LIST_FIELDS, sub: { revisions: "revision" } },
  about: { known: ABOUT_FIELDS, sub: { user: "user", storageQuota: "storageQuota" } },
};

/** Parses a `fields` mask against one resource vocabulary; throws FieldsError on unknown names. */
export function parseMask(text, resource) {
  return parseFields(text, FIELD_VOCABULARY[resource], (key) => FIELD_VOCABULARY[key]);
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

export function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** Canonical Document → REST Document: drops the verbalized `content` convenience Google's MCP tool returns. */
export function restDocument(document) {
  const { content, ...rest } = document;
  return rest;
}

/** Canonical About → REST About: drops `serverTime` and `limits`, which exist for the browser app and drills. */
export function restAbout(about) {
  const { serverTime, limits, ...rest } = about;
  return rest;
}

/** Canonical Revision → REST Revision: drops the Docs-side extras. */
export function restRevision(revision) {
  const { docsRevisionId, requestTypes, textLength, ...rest } = revision;
  return rest;
}

export function restRevisionList(value) {
  return withoutUndefined({
    kind: "drive#revisionList",
    nextPageToken: value.nextPageToken,
    revisions: value.revisions.map(restRevision),
  });
}
