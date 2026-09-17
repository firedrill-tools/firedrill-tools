// Declared Tool error codes and their Box error envelope (HTTP status + Box `code`).

export const ERRORS = new Map([
  ["BAD_REQUEST", [400, "bad_request"]],
  ["ITEM_NAME_INVALID", [400, "item_name_invalid"]],
  ["ITEM_NAME_TOO_LONG", [400, "item_name_too_long"]],
  ["FOLDER_NOT_EMPTY", [400, "folder_not_empty"]],
  ["USER_ALREADY_COLLABORATOR", [400, "user_already_collaborator"]],
  ["ITEM_LIMIT_REACHED", [400, "bad_request"]],
  ["UNAUTHORIZED", [401, "unauthorized"]],
  ["ACCESS_DENIED", [403, "access_denied_insufficient_permissions"]],
  ["STORAGE_LIMIT_EXCEEDED", [403, "storage_limit_exceeded"]],
  ["FILE_SIZE_LIMIT_EXCEEDED", [403, "file_size_limit_exceeded"]],
  ["NOT_FOUND", [404, "not_found"]],
  ["TRASHED", [404, "trashed"]],
  ["ITEM_NAME_IN_USE", [409, "item_name_in_use"]],
  ["PRECONDITION_FAILED", [412, "precondition_failed"]],
  ["RATE_LIMITED", [429, "rate_limit_exceeded"]],
  ["INTERNAL_ERROR", [500, "internal_server_error"]],
  ["UNAVAILABLE", [503, "unavailable"]],
]);

export const OBJECT_CAP = 2000;

/** Fails with a declared code; `contextInfo` becomes Box's `context_info`. */
export function fail(context, code, message, contextInfo) {
  context.fail({ code, message, ...(contextInfo === undefined ? {} : { details: { context_info: contextInfo } }) });
}

export const badParam = (context, name, message) =>
  fail(context, "BAD_REQUEST", message, { errors: [{ reason: "invalid_parameter", name, message }] });

export const notFound = (context, what = "item") => fail(context, "NOT_FOUND", `Not Found: the ${what} does not exist or you do not have access to it`);
export const trashed = (context) => fail(context, "TRASHED", "Item is trashed");
export const denied = (context) => fail(context, "ACCESS_DENIED", "Access denied - insufficient permission");
export const overCap = (context) =>
  fail(context, "ITEM_LIMIT_REACHED", `this synthetic Box account supports at most ${OBJECT_CAP} objects`);

/** Box item-name rules. */
export function checkName(context, name) {
  if (typeof name !== "string") return badParam(context, "name", "name is required");
  if ([...name].length > 255) fail(context, "ITEM_NAME_TOO_LONG", "Item name too long");
  let invalid = name.trim().length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name !== name.trim();
  for (let i = 0; !invalid && i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) invalid = true;
  }
  if (invalid) fail(context, "ITEM_NAME_INVALID", "Item name invalid");
}
