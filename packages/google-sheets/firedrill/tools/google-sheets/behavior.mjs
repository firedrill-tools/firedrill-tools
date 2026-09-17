// Synthetic Google Sheets for a few in-world Workspace users: spreadsheets, sheets, cell values, formulas and formats
// through the Sheets API v4 shapes, plus the Drive API v3 endpoints a Sheets agent cannot avoid (find, rename, star,
// trash, copy, delete, share) restricted to files whose mimeType is application/vnd.google-apps.spreadsheet.
//
// Every operation computes from context.state; nothing is canned and nothing leaves the world. Handlers are
// synchronous, ids come from the `meta/counters` row, timestamps from the virtual clock, and there is no randomness.

import { cellA1, formatRange, gridLimitMessage, indexToColumn } from "./lib/a1.mjs";
import {
  Book,
  DATE_TIME_OPTIONS,
  RENDER_OPTIONS,
  checkGridBounds,
  guardEvaluation,
  insertDimension,
  makeEvaluator,
  patchCell,
  readValueRange,
  resolveRange,
  scanPrefix,
  sheetProperties,
  spreadsheetResource,
  uniqueTitle,
  cellAt,
  MAX_MUTATIONS,
} from "./lib/engine.mjs";
import { FieldsError, project } from "./lib/fields.mjs";
import { serialFromUtcMs } from "./lib/format.mjs";
import {
  DOMAIN,
  SPREADSHEET_ID,
  SPREADSHEET_MIME,
  compareText,
  decodePageToken,
  domainOf,
  encodePageToken,
  iconLinkFor,
  isEmail,
  namedRangeIdFor,
  normalizeEmail,
  permissionIdFor,
  permissionRowId,
  sheetIdFor,
  spreadsheetIdFor,
  stableJson,
  userFileRowId,
  webViewLinkFor,
} from "./lib/ids.mjs";
import { parseUserEntered, rawCellValue } from "./lib/input.mjs";
import { QueryError, matchQuery, parseQuery, parseQueryTime } from "./lib/query.mjs";
import { applyInsertDimension, applyRequests } from "./lib/requests.mjs";
import { RESPONSE_BYTE_LIMIT, byteBudget, jsonBytes } from "./lib/size.mjs";
import {
  all,
  booleanParam,
  compact,
  encodeDrive,
  encodeEmptyDrive,
  encodeSheets,
  encodeSheetsMasked,
  integerParam,
  jsonBody,
  maskResource,
  mutation,
  one,
  parseMask,
  pathParam,
  restAbout,
  splitMethod,
  withoutUndefined,
} from "./lib/wire.mjs";

export const DEFAULT_LIMITS = {
  maxSpreadsheets: 100,
  maxSheets: 50,
  maxRowCount: 20_000,
  maxColumnCount: 200,
  maxGridCells: 400_000,
  maxScanRows: 10_000,
  maxCellsPerWrite: 10_000,
  maxRequestsPerBatch: 100,
  maxRangesPerBatch: 100,
  maxCellCharacters: 50_000,
  maxEvaluationVisits: 20_000,
  maxPermissions: 100,
  maxNamedRanges: 50,
};
const HARD_SCAN_CAP = 10_000;
const EMPTY_COUNTERS = { spreadsheetSequence: 0, sheetSequence: 0, permissionSequence: 0, namedRangeSequence: 0 };
const RANK = { reader: 1, commenter: 2, writer: 3, owner: 4 };
const SHARE_ROLES = ["writer", "commenter", "reader"];
const PERMISSION_TYPES = ["user", "domain", "anyone"];
const ORDER_KEYS = ["createdTime", "modifiedTime", "name", "viewedByMeTime"];
const DEFAULT_ORDER = "modifiedTime desc";
const MAJOR_DIMENSIONS = ["ROWS", "COLUMNS"];
const INPUT_OPTIONS = ["RAW", "USER_ENTERED"];
const INSERT_DATA_OPTIONS = ["OVERWRITE", "INSERT_ROWS"];
const DEFAULT_TIME_ZONE = "Etc/GMT";

// ---------------------------------------------------------------------------------------------
// Session: identity, virtual clock, limits, counters, failures
// ---------------------------------------------------------------------------------------------

function isoOf(ms) {
  return new Date(ms).toISOString();
}

/**
 * The user a caller without an `email` attribute acts as: the primary seeded user, i.e. the lowest `users` row id
 * (Avery in the starter data). A world with no `users` row at all falls back to `<actorId>@example.test`.
 */
function defaultEmail(context) {
  const first = context.state.scan("users", { limit: 1 });
  return first.length > 0 ? first[0].value.emailAddress : `${context.actor.id}@example.test`;
}

function session(context, family) {
  const attributes = context.actor.attributes;
  const explicit = typeof attributes.email === "string" && isEmail(attributes.email.trim());
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
  const s = {
    context,
    family,
    email,
    domain: domainOf(email),
    displayNameOverride: displayName,
    nowMs,
    now: isoOf(nowMs),
    nowSerial: serialFromUtcMs(nowMs),
    limits,
    counters: null,
    countersDirty: false,
    users: new Map(),
    events: [],
  };
  s.invalid = (message, details) => context.fail({ code: "INVALID_ARGUMENT", message, ...(details === undefined ? {} : { details }) });
  s.precondition = (message, details) =>
    context.fail({ code: "FAILED_PRECONDITION", message, ...(details === undefined ? {} : { details }) });
  s.denied = (message = "The caller does not have permission") => context.fail({ code: "PERMISSION_DENIED", message });
  s.notFound = (message = "Requested entity was not found.", details) =>
    context.fail({ code: "NOT_FOUND", message, ...(details === undefined ? {} : { details }) });
  return s;
}

function counters(s) {
  if (s.counters === null) s.counters = { ...EMPTY_COUNTERS, ...(s.context.state.get("meta", "counters") ?? {}) };
  return s.counters;
}

function nextCounter(s, name) {
  const all_ = counters(s);
  all_[name] += 1;
  s.countersDirty = true;
  return all_[name];
}

function flushCounters(s) {
  if (s.countersDirty) {
    s.context.state.put("meta", "counters", { ...counters(s) });
    s.countersDirty = false;
  }
}

function emitAll(s) {
  for (const [eventId, payload] of s.events) s.context.events.emit(eventId, payload);
  s.events = [];
}

/** Drive-family failures carry the classic envelope's reason and location in `details`. */
function invalidDrive(s, message, reason = "invalid", location) {
  s.invalid(message, withoutUndefined({ reason, location }));
}

function notFoundFile(s, id) {
  if (s.family === "drive") s.notFound(`File not found: ${id}.`, { reason: "notFound", location: "fileId" });
  s.notFound();
}

function checkFields(s, fields, vocabulary) {
  if (fields === undefined) return;
  try {
    parseMask(fields, vocabulary);
  } catch (error) {
    if (!(error instanceof FieldsError)) throw error;
    if (s.family === "drive") invalidDrive(s, error.message, "invalidParameter", "fields");
    s.invalid(`Request contains an invalid argument: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Users, access and file resources
// ---------------------------------------------------------------------------------------------

function nameFromEmail(email) {
  return email
    .slice(0, email.indexOf("@"))
    .split(/[._-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function userRow(s, email) {
  if (!s.users.has(email)) s.users.set(email, s.context.state.get("users", email));
  return s.users.get(email);
}

function userView(s, email) {
  const normalized = normalizeEmail(email);
  const row = userRow(s, normalized);
  const me = normalized === s.email;
  const displayName = me && s.displayNameOverride !== undefined ? s.displayNameOverride : (row?.displayName ?? nameFromEmail(normalized));
  return { kind: "drive#user", displayName, emailAddress: normalized, me, permissionId: row?.permissionId ?? "00000000000000000000" };
}

/** Materialises the caller's `users` row so an attribute-less or new identity is a real account after its first write. */
function ensureCallerUser(s) {
  const existing = userRow(s, s.email);
  if (existing !== null) return existing;
  const row = {
    emailAddress: s.email,
    displayName: s.displayNameOverride ?? nameFromEmail(s.email),
    permissionId: permissionIdFor(nextCounter(s, "permissionSequence")),
    domain: s.domain,
  };
  s.context.state.put("users", s.email, row);
  s.users.set(s.email, row);
  return row;
}

function spreadsheetRow(s, id) {
  if (typeof id !== "string" || !SPREADSHEET_ID.test(id)) return null;
  return s.context.state.get("spreadsheets", id);
}

function permissionRows(s, id) {
  return scanPrefix(s, "permissions", `${id}:`).map((row) => row.value);
}

function matchesGrantee(permission, email, domain, { includeAnyone = true } = {}) {
  if (permission.type === "user") return permission.emailAddress === email;
  if (permission.type === "domain") return permission.domain === domain;
  return includeAnyone && permission.type === "anyone";
}

function rankFor(spreadsheet, permissions, email, domain, options) {
  if (spreadsheet.ownerEmail === email) return RANK.owner;
  let best = 0;
  for (const permission of permissions) {
    if (matchesGrantee(permission, email, domain, options)) best = Math.max(best, RANK[permission.role] ?? 0);
  }
  return best;
}

/**
 * Resolves a spreadsheet the caller can see, or fails NOT_FOUND exactly as Google does for an inaccessible id.
 * `minimum` is the required role rank; `content` marks a content write, refused while the file is in the trash.
 */
function openSpreadsheet(s, id, minimum, { content = false } = {}) {
  const spreadsheet = spreadsheetRow(s, id);
  if (spreadsheet === null) notFoundFile(s, String(id));
  const permissions = permissionRows(s, id);
  const rank = rankFor(spreadsheet, permissions, s.email, s.domain);
  if (rank === 0) notFoundFile(s, id);
  if (rank < minimum) {
    if (s.family === "drive") {
      s.context.fail({
        code: "PERMISSION_DENIED",
        message:
          minimum >= RANK.owner
            ? "Only the owner of this file may perform this action."
            : "The user does not have sufficient permissions for this file.",
        details: { reason: "insufficientFilePermissions" },
      });
    }
    s.denied();
  }
  if (content && spreadsheet.trashed) {
    s.precondition("This document is in the trash.", s.family === "drive" ? { reason: "failedPrecondition" } : undefined);
  }
  return { spreadsheet, permissions, rank };
}

function capabilitiesFor(spreadsheet, rank) {
  const owner = rank === RANK.owner;
  return {
    canEdit: rank >= RANK.writer && !spreadsheet.trashed,
    canComment: rank >= RANK.commenter && !spreadsheet.trashed,
    canShare: owner,
    canCopy: rank >= RANK.reader && !spreadsheet.trashed,
    canDelete: owner,
    canTrash: owner && !spreadsheet.trashed,
    canUntrash: owner && spreadsheet.trashed,
    canRename: rank >= RANK.writer,
  };
}

function userFile(s, email, id) {
  return s.context.state.get("user-files", userFileRowId(email, id));
}

function patchUserFile(s, email, id, patch) {
  const existing = userFile(s, email, id) ?? { emailAddress: email, spreadsheetId: id, starred: false };
  const value = withoutUndefined({ ...existing, ...patch });
  s.context.state.put("user-files", userFileRowId(email, id), value);
  return value;
}

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

function fileResource(s, spreadsheet, permissions, rank, mine = userFile(s, s.email, spreadsheet.spreadsheetId)) {
  return withoutUndefined({
    kind: "drive#file",
    id: spreadsheet.spreadsheetId,
    name: spreadsheet.title,
    mimeType: SPREADSHEET_MIME,
    starred: mine?.starred === true,
    trashed: spreadsheet.trashed,
    explicitlyTrashed: spreadsheet.trashed ? true : undefined,
    trashedTime: spreadsheet.trashedTime,
    createdTime: spreadsheet.createdTime,
    modifiedTime: spreadsheet.modifiedTime,
    modifiedByMe: mine?.modifiedByMeTime !== undefined,
    modifiedByMeTime: mine?.modifiedByMeTime,
    viewedByMe: mine?.viewedByMeTime !== undefined,
    viewedByMeTime: mine?.viewedByMeTime,
    sharedWithMeTime: mine?.sharedWithMeTime,
    owners: [userView(s, spreadsheet.ownerEmail)],
    lastModifyingUser: userView(s, spreadsheet.lastModifyingUser),
    shared: permissions.some((permission) => permission.role !== "owner"),
    ownedByMe: spreadsheet.ownerEmail === s.email,
    capabilities: capabilitiesFor(spreadsheet, rank),
    permissionIds: permissions.map((permission) => permission.id),
    version: String(spreadsheet.version),
    webViewLink: webViewLinkFor(spreadsheet.spreadsheetId),
    iconLink: iconLinkFor(),
    spaces: ["drive"],
  });
}

// ---------------------------------------------------------------------------------------------
// Response byte budgets (the framework refuses HTTP responses over 1 MiB)
// ---------------------------------------------------------------------------------------------

const TOO_LARGE_MESSAGE =
  `Response too large: the requested data exceeds the ${RESPONSE_BYTE_LIMIT}-byte response limit. ` +
  "Request a smaller range, fewer ranges or less grid data.";

/** A running budget charged while cell data is rendered; fails 400 INVALID_ARGUMENT once the response would be too large. */
function responseBudget(s) {
  return byteBudget((message) => s.invalid(message), TOO_LARGE_MESSAGE);
}

/**
 * Bound on the unmasked bytes one read may materialise. A `fields` mask can make the response far smaller than the data
 * rendered for it, so the response budget charges the masked shape and this separate budget bounds the work.
 */
const WORK_BYTE_LIMIT = 16 * 1024 * 1024;

function workBudget(s) {
  return byteBudget((message) => s.invalid(message), TOO_LARGE_MESSAGE, WORK_BYTE_LIMIT);
}

/** Parsed `fields` mask (validated earlier by checkFields); `null` when the whole resource is sent. */
function parsedMask(fields, vocabulary) {
  if (fields === undefined) return null;
  try {
    const parsed = parseMask(fields, vocabulary);
    return parsed.all ? null : parsed.fields;
  } catch {
    return null;
  }
}

/** Follows `path` through a parsed mask: `null` = sent whole, `false` = not sent, otherwise the sub-selection Map. */
function maskAt(tree, path) {
  let node = tree;
  for (const name of path) {
    if (node === null || node === false) return node;
    node = node.has(name) ? node.get(name) : false;
  }
  return node;
}

/** Exact check of the encoded operation output (UTF-8 bytes of its JSON) before it is returned. */
function fitResponse(s, value) {
  if (jsonBytes(value) > RESPONSE_BYTE_LIMIT) s.invalid(TOO_LARGE_MESSAGE);
  return value;
}

/** Page envelope overhead reserved for a Drive list (`kind`, `nextPageToken`, `incompleteSearch`, brackets). */
const DRIVE_PAGE_ENVELOPE_BYTES = 1024;

function pageSizeOf(s, value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    invalidDrive(s, `pageSize must be between 1 and ${maximum}.`, "invalidParameter", "pageSize");
  }
  return value;
}

/**
 * Offset pagination sized by count AND bytes: `render` builds each returned resource, and the page stops before its
 * encoded entries would pass the response budget, with `nextPageToken` pointing exactly at the first entry not
 * returned. A single entry that cannot fit on its own fails with Drive's validation error instead of being dropped.
 */
function paginate(s, items, pageSize, pageToken, scope, render, itemMask = null) {
  let start = 0;
  if (pageToken !== undefined) {
    const offset = decodePageToken(pageToken, scope);
    if (offset === null || offset > items.length) invalidDrive(s, "Invalid Value", "badRequest", "pageToken");
    start = offset;
  }
  const limit = RESPONSE_BYTE_LIMIT - DRIVE_PAGE_ENVELOPE_BYTES;
  const page = [];
  let used = 0;
  for (let index = start; index < items.length && page.length < pageSize; index += 1) {
    const resource = render(items[index]);
    // Charged as the route's `fields` mask sends it (`itemMask`: null = whole entry, false = the list is not sent).
    const bytes = itemMask === false ? 0 : jsonBytes(itemMask === null ? resource : project(resource, itemMask)) + 1;
    if (used + bytes > limit) {
      if (page.length === 0) invalidDrive(s, TOO_LARGE_MESSAGE, "responseTooLarge");
      break;
    }
    used += bytes;
    page.push(resource);
  }
  const end = start + page.length;
  const nextPageToken = end < items.length ? encodePageToken(scope, end) : undefined;
  return { page, nextPageToken };
}

// ---------------------------------------------------------------------------------------------
// Writes: bookkeeping shared by every mutation
// ---------------------------------------------------------------------------------------------

/** Marks a committed content or metadata write on the spreadsheet row held by `book`. */
function touch(s, book) {
  book.spreadsheet.version += 1;
  book.spreadsheet.modifiedTime = s.now;
  book.spreadsheet.lastModifyingUser = s.email;
  book.spreadsheet.sheetCount = book.sheets.length;
}

function markModifiedByMe(s, id) {
  patchUserFile(s, s.email, id, { modifiedByMeTime: s.now });
}

function nextSheetId(s, book) {
  for (;;) {
    const candidate = sheetIdFor(nextCounter(s, "sheetSequence"));
    if (book.sheetById(candidate) === null) return candidate;
  }
}

/** Hooks the request engine calls; they turn changes into `sheet.changed` / `values.changed` events. */
function changeHooks(s, book) {
  const valueChanges = new Map();
  return {
    nextSheetId: (target) => nextSheetId(s, target),
    nextNamedRangeId: () => namedRangeIdFor(nextCounter(s, "namedRangeSequence")),
    sheetChanged: (sheet, change) => {
      s.events.push(["sheet.changed", { spreadsheetId: book.id, sheetId: sheet.sheetId, title: sheet.title, change, actorEmail: s.email }]);
    },
    valuesChanged: (sheet, grid, cells, source) => {
      const key = `${sheet.sheetId}:${source}`;
      const entry = valueChanges.get(key) ?? { sheet, grid, cells: 0, source };
      entry.cells += cells;
      if (grid === null || entry.grid === null) entry.grid = null;
      else {
        entry.grid = {
          startRow: Math.min(entry.grid.startRow, grid.startRow),
          endRow: Math.max(entry.grid.endRow, grid.endRow),
          startColumn: Math.min(entry.grid.startColumn, grid.startColumn),
          endColumn: Math.max(entry.grid.endColumn, grid.endColumn),
        };
      }
      valueChanges.set(key, entry);
    },
    finish: () => {
      for (const entry of valueChanges.values()) {
        if (book.sheetById(entry.sheet.sheetId) === null) continue;
        valuesChangedEvent(s, book, entry.sheet, entry.grid, entry.cells, entry.source);
      }
    },
  };
}

function valuesChangedEvent(s, book, sheet, grid, cells, source) {
  const window =
    grid === null || grid.endRow <= grid.startRow || grid.endColumn <= grid.startColumn
      ? { startRow: 0, endRow: sheet.rowCount, startColumn: 0, endColumn: sheet.columnCount }
      : grid;
  s.events.push([
    "values.changed",
    {
      spreadsheetId: book.id,
      sheetId: sheet.sheetId,
      sheetTitle: sheet.title,
      updatedRange: formatRange(sheet.title, window),
      updatedCells: Math.max(0, cells),
      source,
      actorEmail: s.email,
    },
  ]);
}

// ---------------------------------------------------------------------------------------------
// Values: option parsing, write planning, application and responses
// ---------------------------------------------------------------------------------------------

function renderOptions(s, input, prefix = "") {
  const majorDimension = input.majorDimension ?? "ROWS";
  if (!MAJOR_DIMENSIONS.includes(majorDimension)) s.invalid(`Invalid value at 'major_dimension': ${majorDimension}`);
  const valueRenderOption = input[prefix === "" ? "valueRenderOption" : "responseValueRenderOption"] ?? "FORMATTED_VALUE";
  if (!RENDER_OPTIONS.includes(valueRenderOption)) s.invalid(`Invalid value at 'value_render_option': ${valueRenderOption}`);
  const dateTimeRenderOption = input[prefix === "" ? "dateTimeRenderOption" : "responseDateTimeRenderOption"] ?? "SERIAL_NUMBER";
  if (!DATE_TIME_OPTIONS.includes(dateTimeRenderOption)) s.invalid(`Invalid value at 'date_time_render_option': ${dateTimeRenderOption}`);
  return { majorDimension, valueRenderOption, dateTimeRenderOption };
}

function inputOption(s, value, fallback) {
  const option = value ?? fallback;
  if (option === undefined || option === "INPUT_VALUE_OPTION_UNSPECIFIED") s.invalid("'valueInputOption' is required but not specified");
  if (!INPUT_OPTIONS.includes(option)) s.invalid(`Invalid value at 'value_input_option': ${option}`);
  return option;
}

/**
 * Validates a `values` array against a write origin and returns the non-null placements. A multi-cell range bounds the
 * write (Google's "Requested writing within range" error); a single cell or an open side is only an origin.
 */
function planWrite(s, { sheet, origin, limits, rangeText, growRows = false }, values, majorDimension) {
  if (!Array.isArray(values)) s.invalid("Invalid values: expected a list of rows");
  const entries = [];
  let height = 0;
  let width = 0;
  values.forEach((line, i) => {
    if (!Array.isArray(line)) s.invalid(`Invalid values[${i}]: expected a list of cell values`);
    line.forEach((json, j) => {
      const [dr, dc] = majorDimension === "COLUMNS" ? [j, i] : [i, j];
      height = Math.max(height, dr + 1);
      width = Math.max(width, dc + 1);
      if (json === null) return;
      if (typeof json === "number" && !Number.isFinite(json)) s.invalid(`Invalid values[${i}][${j}]: numbers must be finite`);
      const row = origin.row + dr;
      const column = origin.column + dc;
      if (row >= limits.row) s.invalid(`Requested writing within range [${rangeText}], but tried writing to row [${row + 1}]`);
      if (column >= limits.column) s.invalid(`Requested writing within range [${rangeText}], but tried writing to column [${indexToColumn(column)}]`);
      if (column >= sheet.columnCount || (!growRows && row >= sheet.rowCount)) s.invalid(gridLimitMessage(sheet.title, cellA1(row, column), sheet));
      if (typeof json === "string" && json.length > s.limits.maxCellCharacters) {
        s.precondition(`a cell value exceeds the supported bound of ${s.limits.maxCellCharacters} characters`);
      }
      entries.push({ row, column, json });
    });
  });
  return { entries, height, width, origin, sheet };
}

function writeTarget(target, rangeText) {
  const { sheet, grid, bounded, single } = target;
  return {
    sheet,
    origin: { row: grid.startRow, column: grid.startColumn },
    limits: {
      row: single || !bounded.rows ? Number.POSITIVE_INFINITY : grid.endRow,
      column: single || !bounded.columns ? Number.POSITIVE_INFINITY : grid.endColumn,
    },
    rangeText: formatRange(sheet.title, grid) ?? rangeText,
  };
}

function applyWrite(s, book, plan, option) {
  for (const { row, column, json } of plan.entries) {
    let value;
    let suggestion;
    if (option === "RAW") value = rawCellValue(json);
    else {
      const parsed = parseUserEntered(json);
      value = parsed.value;
      suggestion = parsed.numberFormat;
    }
    if (value?.kind === "formula" && value.formula.length > 2000) {
      s.precondition("a formula exceeds the supported bound of 2000 characters");
    }
    const existing = cellAt(book.rowsOf(plan.sheet.sheetId).get(row), column);
    const patch = { value };
    if (suggestion !== undefined && existing?.format?.numberFormat === undefined) patch.format = { ...(existing?.format ?? {}), numberFormat: suggestion };
    patchCell(book, plan.sheet.sheetId, row, column, patch);
  }
}

function planGrid(plan) {
  return {
    startRow: plan.origin.row,
    endRow: plan.origin.row + Math.max(1, plan.height),
    startColumn: plan.origin.column,
    endColumn: plan.origin.column + Math.max(1, plan.width),
  };
}

function updateResponse(s, book, plan, input, budget = responseBudget(s)) {
  const grid = planGrid(plan);
  const clipped = {
    ...grid,
    endRow: Math.min(grid.endRow, plan.sheet.rowCount),
    endColumn: Math.min(grid.endColumn, plan.sheet.columnCount),
  };
  const out = { spreadsheetId: book.id, updatedRange: formatRange(plan.sheet.title, clipped) };
  if (plan.entries.length > 0) {
    out.updatedRows = new Set(plan.entries.map((entry) => entry.row)).size;
    out.updatedColumns = new Set(plan.entries.map((entry) => entry.column)).size;
    out.updatedCells = plan.entries.length;
  }
  if (input.includeValuesInResponse === true) {
    const options = renderOptions(s, { majorDimension: input.majorDimension, ...input }, "response");
    const evaluator = makeEvaluator(s, book);
    out.updatedData = guardEvaluation(s, () =>
      readValueRange(book, evaluator, { sheet: plan.sheet, grid: clipped }, options.majorDimension, options.valueRenderOption, options.dateTimeRenderOption, budget),
    );
  }
  return out;
}

function checkCellsBound(s, count) {
  if (count > s.limits.maxCellsPerWrite) {
    s.precondition(`the request writes ${count} cells, over the supported bound of ${s.limits.maxCellsPerWrite} cells per write`);
  }
}

/** values.update and values.update-formulas share this path. */
function updateValues(s, input, values, option, source) {
  const { spreadsheet } = openSpreadsheet(s, input.spreadsheetId, RANK.writer, { content: true });
  const book = new Book(s, spreadsheet);
  const target = resolveRange(s, book, input.range);
  const majorDimension = input.majorDimension ?? "ROWS";
  if (!MAJOR_DIMENSIONS.includes(majorDimension)) s.invalid(`Invalid value at 'major_dimension': ${majorDimension}`);
  const plan = planWrite(s, writeTarget(target, input.range), values, majorDimension);
  checkCellsBound(s, plan.entries.length);
  applyWrite(s, book, plan, option);
  touch(s, book);
  book.flush();
  markModifiedByMe(s, book.id);
  if (plan.entries.length > 0) valuesChangedEvent(s, book, plan.sheet, planGrid(plan), plan.entries.length, source);
  const response = updateResponse(s, book, plan, input);
  // Sent through the route's `fields` mask (values.update); the formulas operation has no mask and is measured whole.
  fitResponse(s, source === "update" ? maskResource(response, input.fields, "updateValues") : response);
  emitAll(s);
  return response;
}

function readRanges(s, input, ranges) {
  const { spreadsheet } = openSpreadsheet(s, input.spreadsheetId, RANK.reader);
  const options = renderOptions(s, input);
  if (ranges.length === 0) s.invalid("Must specify at least one range.");
  if (ranges.length > s.limits.maxRangesPerBatch) {
    s.precondition(`the request reads ${ranges.length} ranges, over the supported bound of ${s.limits.maxRangesPerBatch} ranges per batch`);
  }
  const book = new Book(s, spreadsheet);
  const targets = ranges.map((range) => resolveRange(s, book, range));
  const budget = responseBudget(s);
  const evaluator = makeEvaluator(s, book);
  return guardEvaluation(s, () =>
    targets.map((target) => readValueRange(book, evaluator, target, options.majorDimension, options.valueRenderOption, options.dateTimeRenderOption, budget)),
  );
}

// ---------------------------------------------------------------------------------------------
// Spreadsheet creation, copying and deletion
// ---------------------------------------------------------------------------------------------

function countSpreadsheets(s) {
  return scanPrefix(s, "spreadsheets", "").length;
}

function newSpreadsheetRow(s, id, title, { locale = "en_US", timeZone = DEFAULT_TIME_ZONE } = {}) {
  return {
    spreadsheetId: id,
    title,
    locale,
    timeZone,
    ownerEmail: s.email,
    trashed: false,
    createdTime: s.now,
    modifiedTime: s.now,
    lastModifyingUser: s.email,
    version: 1,
    sheetCount: 1,
  };
}

function writeOwner(s, id) {
  const user = ensureCallerUser(s);
  s.context.state.put("permissions", permissionRowId(id, user.permissionId), {
    spreadsheetId: id,
    id: user.permissionId,
    type: "user",
    role: "owner",
    emailAddress: s.email,
    displayName: user.displayName,
    createdTime: s.now,
  });
  return user;
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

const operations = {
  "about.get": (input, context) => {
    const s = session(context, "drive");
    checkFields(s, input.fields, "about");
    const view = userView(s, s.email);
    return { kind: "drive#about", user: view, serverTime: s.now, limits: { ...s.limits } };
  },

  "spreadsheets.create": (input, context) => {
    const s = session(context, "sheets");
    checkFields(s, input.fields, "spreadsheet");
    const properties = input.properties ?? {};
    const title = properties.title ?? "Untitled spreadsheet";
    if (typeof title !== "string" || title.length === 0 || title.length > 255) s.invalid("Invalid spreadsheet.properties.title: must be 1-255 characters");
    if (properties.locale !== undefined && properties.locale !== "en_US") {
      s.invalid(`Invalid spreadsheet.properties.locale: ${properties.locale} is not supported by this simulated service (en_US only)`);
    }
    const timeZone = properties.timeZone ?? DEFAULT_TIME_ZONE;
    if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(timeZone)) s.invalid(`Invalid spreadsheet.properties.timeZone: ${timeZone}`);
    const requested = input.sheets ?? [{ properties: {} }];
    if (countSpreadsheets(s) >= s.limits.maxSpreadsheets) {
      s.precondition(`the world already holds ${s.limits.maxSpreadsheets} spreadsheets, the supported bound`);
    }
    const id = spreadsheetIdFor(nextCounter(s, "spreadsheetSequence"));
    const book = new Book(s, newSpreadsheetRow(s, id, title, { timeZone }), { fresh: true });
    const hooks = changeHooks(s, book);
    const addRequests = (requested.length === 0 ? [{ properties: {} }] : requested).map((sheet, index) => {
      const props = { ...(sheet.properties ?? {}) };
      if (props.sheetId === undefined && index === 0) props.sheetId = 0;
      if (props.index === undefined) props.index = index;
      return { addSheet: { properties: props } };
    });
    if (addRequests.length > s.limits.maxSheets) {
      s.precondition(`the spreadsheet would have ${addRequests.length} sheets, over the supported bound of ${s.limits.maxSheets} sheets`);
    }
    const noEvents = { ...hooks, sheetChanged: () => {} };
    applyRequests(s, book, addRequests, noEvents);
    book.spreadsheet.sheetCount = book.sheets.length;
    book.flush();
    writeOwner(s, id);
    flushCounters(s);
    s.context.events.emit("spreadsheet.created", { spreadsheetId: id, title, ownerEmail: s.email, source: "create", sheetCount: book.sheets.length });
    return spreadsheetResource(s, book);
  },

  "spreadsheets.get": (input, context) => {
    const s = session(context, "sheets");
    checkFields(s, input.fields, "spreadsheet");
    const ranges = input.ranges ?? [];
    if (ranges.length > s.limits.maxRangesPerBatch) {
      s.precondition(`the request reads ${ranges.length} ranges, over the supported bound of ${s.limits.maxRangesPerBatch} ranges per batch`);
    }
    const { spreadsheet } = openSpreadsheet(s, input.spreadsheetId, RANK.reader);
    const book = new Book(s, spreadsheet);
    // The route sends the resource through the caller's `fields` mask, so the response budget charges that masked shape.
    const mask = parsedMask(input.fields, "spreadsheet");
    const resource = spreadsheetResource(s, book, {
      includeGridData: input.includeGridData === true,
      ranges,
      budget: responseBudget(s),
      dataMask: maskAt(mask, ["sheets", "data"]),
      work: workBudget(s),
    });
    fitResponse(s, maskResource(resource, input.fields, "spreadsheet"));
    if (input.markViewed === true) patchUserFile(s, s.email, spreadsheet.spreadsheetId, { viewedByMeTime: s.now });
    return resource;
  },

  "spreadsheets.batch-update": (input, context) => {
    const s = session(context, "sheets");
    checkFields(s, input.fields, "batchUpdateSpreadsheet");
    const { spreadsheet } = openSpreadsheet(s, input.spreadsheetId, RANK.writer, { content: true });
    const book = new Book(s, spreadsheet);
    const hooks = changeHooks(s, book);
    const replies = applyRequests(s, book, input.requests, hooks);
    const responseRanges = input.responseRanges ?? [];
    touch(s, book);
    book.flush();
    flushCounters(s);
    markModifiedByMe(s, book.id);
    hooks.finish();
    const out = { spreadsheetId: book.id, replies };
    if (input.includeSpreadsheetInResponse === true) {
      out.updatedSpreadsheet = spreadsheetResource(s, book, {
        includeGridData: input.responseIncludeGridData === true,
        ranges: responseRanges,
        budget: responseBudget(s),
      });
    }
    // A declared error discards every write of this invocation, so an oversized reply leaves the spreadsheet unchanged.
    fitResponse(s, maskResource(out, input.fields, "batchUpdateSpreadsheet"));
    emitAll(s);
    return out;
  },

  "sheets.insert-dimension": (input, context) => {
    const s = session(context, "sheets");
    const { spreadsheet } = openSpreadsheet(s, input.spreadsheetId, RANK.writer, { content: true });
    const book = new Book(s, spreadsheet);
    const hooks = changeHooks(s, book);
    const fail = (message) => s.invalid(`Invalid insert_dimension: ${message}`);
    const sheet = book.sheetById(input.sheetId);
    if (sheet === null) fail(`No grid with id: ${input.sheetId}`);
    if (input.startIndex >= input.endIndex) fail("startIndex must be less than endIndex");
    applyInsertDimension(
      s,
      book,
      { sheet, dimension: input.dimension, start: input.startIndex, end: input.endIndex, inheritFromBefore: input.inheritFromBefore },
      fail,
      hooks,
    );
    touch(s, book);
    book.flush();
    markModifiedByMe(s, book.id);
    hooks.finish();
    emitAll(s);
    return { spreadsheetId: book.id, replies: [{}] };
  },

  "sheets.copy-to": (input, context) => {
    const s = session(context, "sheets");
    checkFields(s, input.fields, "sheetProperties");
    const { spreadsheet: source } = openSpreadsheet(s, input.spreadsheetId, RANK.reader);
    const sourceBook = new Book(s, source);
    const sheet = sourceBook.sheetById(input.sheetId);
    if (sheet === null) s.notFound();
    const { spreadsheet: destination } = openSpreadsheet(s, input.destinationSpreadsheetId, RANK.writer, { content: true });
    const destBook = destination.spreadsheetId === source.spreadsheetId ? sourceBook : new Book(s, destination);
    const rows = sourceBook.rowsOf(sheet.sheetId);
    const sheetId = nextSheetId(s, destBook);
    const copy = {
      ...sheet,
      spreadsheetId: destBook.id,
      sheetId,
      title: uniqueTitle(destBook, `Copy of ${sheet.title}`),
      index: destBook.sheets.length,
      hidden: false,
    };
    destBook.sheets.push(copy);
    const target = destBook.adoptEmptySheet(sheetId);
    for (const [rowIndex, cells] of rows) target.set(rowIndex, JSON.parse(JSON.stringify(cells)));
    checkGridBounds(s, destBook);
    touch(s, destBook);
    destBook.flush();
    flushCounters(s);
    markModifiedByMe(s, destBook.id);
    s.context.events.emit("sheet.changed", { spreadsheetId: destBook.id, sheetId, title: copy.title, change: "copied", actorEmail: s.email });
    return sheetProperties(copy);
  },

  "values.get": (input, context) => {
    const s = session(context, "sheets");
    checkFields(s, input.fields, "valueRange");
    const out = readRanges(s, input, [input.range])[0];
    fitResponse(s, maskResource(out, input.fields, "valueRange"));
    return out;
  },

  "values.batch-get": (input, context) => {
    const s = session(context, "sheets");
    checkFields(s, input.fields, "batchGetValues");
    const out = { spreadsheetId: input.spreadsheetId, valueRanges: readRanges(s, input, input.ranges ?? []) };
    fitResponse(s, maskResource(out, input.fields, "batchGetValues"));
    return out;
  },

  "values.update": (input, context) => {
    const s = session(context, "sheets");
    checkFields(s, input.fields, "updateValues");
    const option = inputOption(s, input.valueInputOption, "RAW");
    return updateValues(s, input, input.values, option, "update");
  },

  "values.update-formulas": (input, context) => {
    const s = session(context, "sheets");
    return updateValues(s, input, input.formulas, "USER_ENTERED", "formulas");
  },

  "values.append": (input, context) => {
    const s = session(context, "sheets");
    checkFields(s, input.fields, "appendValues");
    const { spreadsheet } = openSpreadsheet(s, input.spreadsheetId, RANK.writer, { content: true });
    const option = inputOption(s, input.valueInputOption, undefined);
    const insertDataOption = input.insertDataOption ?? "OVERWRITE";
    if (!INSERT_DATA_OPTIONS.includes(insertDataOption)) s.invalid(`Invalid value at 'insert_data_option': ${insertDataOption}`);
    const majorDimension = input.majorDimension ?? "ROWS";
    if (!MAJOR_DIMENSIONS.includes(majorDimension)) s.invalid(`Invalid value at 'major_dimension': ${majorDimension}`);
    const book = new Book(s, spreadsheet);
    const hooks = changeHooks(s, book);
    const target = resolveRange(s, book, input.range);
    const { sheet, grid } = target;
    const rows = book.rowsOf(sheet.sheetId);
    const hasValue = (rowIndex) =>
      (rows.get(rowIndex) ?? []).some((cell) => cell.value !== undefined && cell.columnIndex >= grid.startColumn && cell.columnIndex < grid.endColumn);
    const candidates = [...rows.keys()].filter((rowIndex) => rowIndex >= grid.startRow && hasValue(rowIndex)).sort((a, b) => a - b);
    let tableStart;
    let tableEnd;
    if (candidates.length > 0) {
      tableStart = candidates[0];
      tableEnd = tableStart;
      while (hasValue(tableEnd)) tableEnd += 1;
    }
    const originRow = tableEnd ?? grid.startRow;
    const plan = planWrite(
      s,
      {
        sheet,
        origin: { row: originRow, column: grid.startColumn },
        limits: { row: Number.POSITIVE_INFINITY, column: Number.POSITIVE_INFINITY },
        rangeText: input.range,
        growRows: true,
      },
      input.values,
      majorDimension,
    );
    checkCellsBound(s, plan.entries.length);
    const height = Math.max(plan.height, plan.entries.length > 0 ? 1 : 0);
    if (height > 0) {
      if (insertDataOption === "INSERT_ROWS") {
        insertDimension(s, book, sheet, "ROWS", Math.min(originRow, sheet.rowCount), height, null);
        hooks.sheetChanged(sheet, "resized");
      } else if (originRow + height > sheet.rowCount) {
        sheet.rowCount = originRow + height;
        checkGridBounds(s, book);
        hooks.sheetChanged(sheet, "resized");
      }
    }
    applyWrite(s, book, plan, option);
    touch(s, book);
    book.flush();
    markModifiedByMe(s, book.id);
    hooks.finish();
    if (plan.entries.length > 0) valuesChangedEvent(s, book, sheet, planGrid(plan), plan.entries.length, "append");
    const out = { spreadsheetId: book.id };
    if (tableStart !== undefined) {
      let lastColumn = grid.startColumn;
      for (let rowIndex = tableStart; rowIndex < tableEnd; rowIndex += 1) {
        for (const cell of rows.get(rowIndex) ?? []) {
          if (cell.value !== undefined && cell.columnIndex < grid.endColumn) lastColumn = Math.max(lastColumn, cell.columnIndex);
        }
      }
      out.tableRange = formatRange(sheet.title, { startRow: tableStart, endRow: tableEnd, startColumn: grid.startColumn, endColumn: lastColumn + 1 });
    }
    out.updates = updateResponse(s, book, plan, input);
    fitResponse(s, maskResource(out, input.fields, "appendValues"));
    emitAll(s);
    return out;
  },

  "values.batch-update": (input, context) => {
    const s = session(context, "sheets");
    checkFields(s, input.fields, "batchUpdateValues");
    const { spreadsheet } = openSpreadsheet(s, input.spreadsheetId, RANK.writer, { content: true });
    const option = inputOption(s, input.valueInputOption, undefined);
    const data = input.data ?? [];
    if (data.length === 0) s.invalid("Must specify at least one ValueRange in data.");
    if (data.length > s.limits.maxRangesPerBatch) {
      s.precondition(`the request writes ${data.length} ranges, over the supported bound of ${s.limits.maxRangesPerBatch} ranges per batch`);
    }
    const book = new Book(s, spreadsheet);
    const plans = data.map((item, index) => {
      const majorDimension = item.majorDimension ?? "ROWS";
      if (!MAJOR_DIMENSIONS.includes(majorDimension)) s.invalid(`Invalid data[${index}].majorDimension: ${majorDimension}`);
      const target = resolveRange(s, book, item.range);
      return { plan: planWrite(s, writeTarget(target, item.range), item.values, majorDimension), majorDimension };
    });
    checkCellsBound(s, plans.reduce((total, entry) => total + entry.plan.entries.length, 0));
    for (const { plan } of plans) applyWrite(s, book, plan, option);
    touch(s, book);
    book.flush();
    markModifiedByMe(s, book.id);
    const budget = responseBudget(s);
    const responses = plans.map(({ plan, majorDimension }) => updateResponse(s, book, plan, { ...input, majorDimension }, budget));
    const touchedSheets = new Set();
    for (const { plan } of plans) {
      if (plan.entries.length === 0) continue;
      touchedSheets.add(plan.sheet.sheetId);
      valuesChangedEvent(s, book, plan.sheet, planGrid(plan), plan.entries.length, "batchUpdate");
    }
    const result = withoutUndefined({
      spreadsheetId: book.id,
      totalUpdatedRows: responses.reduce((total, response) => total + (response.updatedRows ?? 0), 0) || undefined,
      totalUpdatedColumns: responses.reduce((total, response) => total + (response.updatedColumns ?? 0), 0) || undefined,
      totalUpdatedCells: responses.reduce((total, response) => total + (response.updatedCells ?? 0), 0) || undefined,
      totalUpdatedSheets: touchedSheets.size || undefined,
      responses,
    });
    fitResponse(s, maskResource(result, input.fields, "batchUpdateValues"));
    emitAll(s);
    return result;
  },

  "values.clear": (input, context) => {
    const s = session(context, "sheets");
    const { spreadsheet } = openSpreadsheet(s, input.spreadsheetId, RANK.writer, { content: true });
    const book = new Book(s, spreadsheet);
    const { sheet, grid } = resolveRange(s, book, input.range);
    const rows = book.rowsOf(sheet.sheetId);
    let cleared = 0;
    for (const [rowIndex, cells] of [...rows]) {
      if (rowIndex < grid.startRow || rowIndex >= grid.endRow) continue;
      for (const cell of cells) {
        if (cell.value === undefined || cell.columnIndex < grid.startColumn || cell.columnIndex >= grid.endColumn) continue;
        patchCell(book, sheet.sheetId, rowIndex, cell.columnIndex, { value: null });
        cleared += 1;
      }
    }
    touch(s, book);
    book.flush();
    markModifiedByMe(s, book.id);
    if (cleared > 0) valuesChangedEvent(s, book, sheet, grid, cleared, "clear");
    emitAll(s);
    return { spreadsheetId: book.id, clearedRange: formatRange(sheet.title, grid) };
  },

  "files.list": (input, context) => {
    const s = session(context, "drive");
    checkFields(s, input.fields, "fileList");
    if (input.corpora !== undefined && input.corpora !== "user") {
      invalidDrive(s, "Only the user corpus is supported: shared drives are not part of this Tool.", "invalidParameter", "corpora");
    }
    if (input.includeItemsFromAllDrives === true || input.driveId !== undefined) {
      invalidDrive(s, "Shared drives are not part of this Tool.", "invalidParameter", input.driveId !== undefined ? "driveId" : "includeItemsFromAllDrives");
    }
    const pageSize = pageSizeOf(s, input.pageSize, 100, 1000);
    let tree;
    if (input.q !== undefined) {
      try {
        tree = parseQuery(input.q);
      } catch (error) {
        if (!(error instanceof QueryError)) throw error;
        invalidDrive(s, error.hint ?? error.message, "invalid", "q");
      }
    }
    const mentionsTrashed = (node) =>
      node !== undefined &&
      ((node.kind === "compare" && node.term === "trashed") ||
        (node.operands ?? []).some(mentionsTrashed) ||
        (node.operand !== undefined && mentionsTrashed(node.operand)));
    const orderBy = input.orderBy ?? DEFAULT_ORDER;
    const orders = orderBy.split(",").map((part) => {
      const [key, direction, extra] = part.trim().split(/\s+/);
      if (!ORDER_KEYS.includes(key) || extra !== undefined) invalidDrive(s, `Unsupported orderBy key ${key}.`, "invalidParameter", "orderBy");
      if (direction !== undefined && direction !== "asc" && direction !== "desc") {
        invalidDrive(s, "orderBy direction must be asc or desc.", "invalidParameter", "orderBy");
      }
      return { key, descending: direction === "desc" };
    });
    if (orders.length > 3) invalidDrive(s, "orderBy accepts at most 3 keys.", "invalidParameter", "orderBy");
    const spreadsheets = scanPrefix(s, "spreadsheets", "").map((row) => row.value);
    const permissionsById = new Map();
    for (const row of scanPrefix(s, "permissions", "")) {
      const list = permissionsById.get(row.value.spreadsheetId) ?? [];
      list.push(row.value);
      permissionsById.set(row.value.spreadsheetId, list);
    }
    const mine = new Map(scanPrefix(s, "user-files", `${s.email}:`).map((row) => [row.value.spreadsheetId, row.value]));
    const visible = [];
    for (const spreadsheet of spreadsheets) {
      const permissions = permissionsById.get(spreadsheet.spreadsheetId) ?? [];
      const listedRank = rankFor(spreadsheet, permissions, s.email, s.domain, { includeAnyone: false });
      if (listedRank === 0) continue;
      const rank = rankFor(spreadsheet, permissions, s.email, s.domain);
      const entry = mine.get(spreadsheet.spreadsheetId) ?? null;
      const view = {
        name: spreadsheet.title,
        mimeType: SPREADSHEET_MIME,
        trashed: spreadsheet.trashed,
        starred: entry?.starred === true,
        sharedWithMe: spreadsheet.ownerEmail !== s.email,
        modifiedTime: parseQueryTime(spreadsheet.modifiedTime),
        createdTime: parseQueryTime(spreadsheet.createdTime),
        viewedByMeTime: entry?.viewedByMeTime === undefined ? undefined : parseQueryTime(entry.viewedByMeTime),
        ownerEmail: spreadsheet.ownerEmail,
        roleRank: (email) => {
          const normalized = normalizeEmail(email);
          return rankFor(spreadsheet, permissions, normalized, domainOf(normalized));
        },
      };
      if (!mentionsTrashed(tree) && spreadsheet.trashed) continue;
      if (tree !== undefined && !matchQuery(tree, view)) continue;
      visible.push({ spreadsheet, permissions, rank, entry });
    }
    const sortValue = (item, key) => {
      if (key === "name") return item.spreadsheet.title;
      if (key === "viewedByMeTime") return item.entry?.viewedByMeTime ?? "";
      return item.spreadsheet[key] ?? "";
    };
    visible.sort((left, right) => {
      for (const order of orders) {
        let comparison = compareText(sortValue(left, order.key), sortValue(right, order.key));
        if (order.descending) comparison = -comparison;
        if (comparison !== 0) return comparison;
      }
      return compareText(left.spreadsheet.spreadsheetId, right.spreadsheet.spreadsheetId);
    });
    const scope = stableJson({ email: s.email, q: input.q, orderBy });
    const render = (item) => fileResource(s, item.spreadsheet, item.permissions, item.rank, item.entry);
    const fileMask = maskAt(parsedMask(input.fields, "fileList"), ["files"]);
    const { page, nextPageToken } = paginate(s, visible, pageSize, input.pageToken, scope, render, fileMask);
    return withoutUndefined({ kind: "drive#fileList", nextPageToken, incompleteSearch: false, files: page });
  },

  "files.get": (input, context) => {
    const s = session(context, "drive");
    checkFields(s, input.fields, "file");
    if (input.alt !== undefined && input.alt !== "json") {
      invalidDrive(s, "Only files with binary content can be downloaded. Use Export with Google Docs files.", "fileNotDownloadable", "alt");
    }
    const { spreadsheet, permissions, rank } = openSpreadsheet(s, input.fileId, RANK.reader);
    return fileResource(s, spreadsheet, permissions, rank);
  },

  "files.update": (input, context) => {
    const s = session(context, "drive");
    if (Array.isArray(input.unwritableFields) && input.unwritableFields.length > 0) {
      const name = input.unwritableFields[0];
      context.fail({
        code: "PERMISSION_DENIED",
        message: `The resource body includes fields which are not directly writable. [${name}]`,
        details: { reason: "fieldNotWritable", location: name },
      });
    }
    checkFields(s, input.fields, "file");
    const patches = ["name", "starred", "trashed"].filter((name) => input[name] !== undefined);
    if (patches.length === 0) invalidDrive(s, "At least one of name, starred or trashed must be set.", "invalid");
    const minimum = input.trashed !== undefined ? RANK.owner : input.name !== undefined ? RANK.writer : RANK.reader;
    const { spreadsheet, permissions, rank } = openSpreadsheet(s, input.fileId, minimum);
    let updated = spreadsheet;
    if (input.name !== undefined || input.trashed !== undefined) {
      const next = { ...spreadsheet };
      if (input.name !== undefined) {
        if (input.name.length === 0 || input.name.length > 255) invalidDrive(s, "name must be between 1 and 255 characters.", "invalid", "name");
        next.title = input.name;
      }
      if (input.trashed !== undefined) {
        next.trashed = input.trashed;
        if (input.trashed) next.trashedTime = s.now;
        else delete next.trashedTime;
      }
      next.version = spreadsheet.version + 1;
      next.modifiedTime = s.now;
      next.lastModifyingUser = s.email;
      s.context.state.put("spreadsheets", spreadsheet.spreadsheetId, next);
      updated = next;
    }
    let entry;
    if (input.starred !== undefined) entry = patchUserFile(s, s.email, spreadsheet.spreadsheetId, { starred: input.starred });
    return fileResource(s, updated, permissions, rank, entry ?? userFile(s, s.email, spreadsheet.spreadsheetId));
  },

  "files.copy": (input, context) => {
    const s = session(context, "drive");
    checkFields(s, input.fields, "file");
    const { spreadsheet } = openSpreadsheet(s, input.fileId, RANK.reader);
    if (spreadsheet.trashed) s.precondition("A file in the trash cannot be copied.", { reason: "failedPrecondition" });
    const name = input.name ?? `Copy of ${spreadsheet.title}`;
    if (name.length === 0 || name.length > 255) invalidDrive(s, "name must be between 1 and 255 characters.", "invalid", "name");
    if (countSpreadsheets(s) >= s.limits.maxSpreadsheets) {
      s.precondition(`the world already holds ${s.limits.maxSpreadsheets} spreadsheets, the supported bound`, { reason: "failedPrecondition" });
    }
    const source = new Book(s, spreadsheet);
    const id = spreadsheetIdFor(nextCounter(s, "spreadsheetSequence"));
    const row = newSpreadsheetRow(s, id, name, { locale: spreadsheet.locale, timeZone: spreadsheet.timeZone });
    row.sheetCount = source.sheets.length;
    const copy = new Book(s, row, { fresh: true });
    for (const sheet of source.sheets) {
      copy.sheets.push({ ...sheet, spreadsheetId: id });
      const target = copy.adoptEmptySheet(sheet.sheetId);
      for (const [rowIndex, cells] of source.rowsOf(sheet.sheetId)) target.set(rowIndex, JSON.parse(JSON.stringify(cells)));
    }
    copy.named = source.namedRanges().map((named) => ({ ...named, spreadsheetId: id }));
    copy.flush();
    writeOwner(s, id);
    flushCounters(s);
    s.context.events.emit("spreadsheet.created", { spreadsheetId: id, title: name, ownerEmail: s.email, source: "copy", sheetCount: copy.sheets.length });
    const permissions = permissionRows(s, id);
    return fileResource(s, row, permissions, RANK.owner, null);
  },

  "files.delete": (input, context) => {
    const s = session(context, "drive");
    const { spreadsheet } = openSpreadsheet(s, input.fileId, RANK.owner);
    const id = spreadsheet.spreadsheetId;
    const ops = [
      ["spreadsheets", id],
      ...scanPrefix(s, "sheets", `${id}:`).map((row) => ["sheets", row.rowId]),
      ...scanPrefix(s, "rows", `${id}:`).map((row) => ["rows", row.rowId]),
      ...scanPrefix(s, "named-ranges", `${id}:`).map((row) => ["named-ranges", row.rowId]),
      ...scanPrefix(s, "permissions", `${id}:`).map((row) => ["permissions", row.rowId]),
      ...scanPrefix(s, "user-files", "")
        .filter((row) => row.value.spreadsheetId === id)
        .map((row) => ["user-files", row.rowId]),
    ];
    if (ops.length > MAX_MUTATIONS) {
      s.precondition(`deleting this file would remove ${ops.length} rows, over the supported bound of ${MAX_MUTATIONS}`, { reason: "failedPrecondition" });
    }
    for (const [namespace, rowId] of ops) s.context.state.delete(namespace, rowId);
    return {};
  },

  "permissions.list": (input, context) => {
    const s = session(context, "drive");
    checkFields(s, input.fields, "permissionList");
    const pageSize = pageSizeOf(s, input.pageSize, 100, 100);
    const { permissions } = openSpreadsheet(s, input.fileId, RANK.reader);
    const ordered = [...permissions].sort((left, right) => {
      if (left.role === "owner" && right.role !== "owner") return -1;
      if (right.role === "owner" && left.role !== "owner") return 1;
      const byTime = compareText(left.createdTime, right.createdTime);
      return byTime === 0 ? compareText(left.id, right.id) : byTime;
    });
    const scope = stableJson({ email: s.email, fileId: input.fileId });
    const { page, nextPageToken } = paginate(s, ordered, pageSize, input.pageToken, scope, permissionResource, maskAt(parsedMask(input.fields, "permissionList"), ["permissions"]));
    return withoutUndefined({ kind: "drive#permissionList", nextPageToken, permissions: page });
  },

  "permissions.create": (input, context) => {
    const s = session(context, "drive");
    checkFields(s, input.fields, "permission");
    const { role, type } = input;
    if (input.transferOwnership === true || role === "owner") {
      invalidDrive(s, "Ownership transfer is not supported by this simulated service.", "invalidSharingRequest", "transferOwnership");
    }
    if (!SHARE_ROLES.includes(role)) invalidDrive(s, `role must be one of ${SHARE_ROLES.join(", ")}.`, "invalid", "role");
    if (!PERMISSION_TYPES.includes(type)) invalidDrive(s, `type must be one of ${PERMISSION_TYPES.join(", ")}.`, "invalid", "type");
    let emailAddress;
    let domain;
    if (type === "user") {
      emailAddress = normalizeEmail(input.emailAddress ?? "");
      if (!isEmail(emailAddress)) invalidDrive(s, "A valid emailAddress is required for user permissions.", "invalid", "emailAddress");
    } else if (type === "domain") {
      domain = String(input.domain ?? "").toLowerCase();
      if (!DOMAIN.test(domain)) invalidDrive(s, "A valid domain is required for domain permissions.", "invalid", "domain");
    }
    const { spreadsheet, permissions } = openSpreadsheet(s, input.fileId, RANK.owner);
    const id = spreadsheet.spreadsheetId;
    if (type === "user" && emailAddress === spreadsheet.ownerEmail) {
      s.precondition("The owner's permission cannot be changed; ownership transfer is out of scope.", { reason: "failedPrecondition" });
    }
    const existing = permissions.find((permission) => {
      if (permission.type !== type) return false;
      if (type === "anyone") return true;
      if (type === "domain") return permission.domain === domain;
      return permission.emailAddress === emailAddress;
    });
    if (existing === undefined && permissions.length >= s.limits.maxPermissions) {
      s.precondition(`the file already has ${permissions.length} permissions, the supported bound of ${s.limits.maxPermissions}`, {
        reason: "failedPrecondition",
      });
    }
    let permissionId = existing?.id;
    if (permissionId === undefined) {
      if (type === "anyone") permissionId = "anyoneWithLink";
      else if (type === "user" && userRow(s, emailAddress) !== null) permissionId = userRow(s, emailAddress).permissionId;
      else permissionId = permissionIdFor(nextCounter(s, "permissionSequence"));
    }
    const value = withoutUndefined({
      spreadsheetId: id,
      id: permissionId,
      type,
      role,
      emailAddress,
      domain,
      displayName: type === "user" ? (userRow(s, emailAddress)?.displayName ?? undefined) : undefined,
      allowFileDiscovery: type === "user" ? undefined : input.allowFileDiscovery === true,
      createdTime: existing?.createdTime ?? s.now,
    });
    s.context.state.put("permissions", permissionRowId(id, permissionId), value);
    if (type === "user" && userRow(s, emailAddress) !== null) patchUserFile(s, emailAddress, id, { sharedWithMeTime: s.now });
    s.context.state.put("spreadsheets", id, { ...spreadsheet, version: spreadsheet.version + 1 });
    flushCounters(s);
    return permissionResource(value);
  },

  "permissions.delete": (input, context) => {
    const s = session(context, "drive");
    const { spreadsheet } = openSpreadsheet(s, input.fileId, RANK.owner);
    const id = spreadsheet.spreadsheetId;
    const row = typeof input.permissionId === "string" ? s.context.state.get("permissions", permissionRowId(id, input.permissionId)) : null;
    if (row === null) s.notFound(`Permission not found: ${input.permissionId}.`, { reason: "notFound", location: "permissionId" });
    if (row.role === "owner") s.precondition("The owner's permission cannot be removed.", { reason: "cannotDeletePermission" });
    s.context.state.delete("permissions", permissionRowId(id, row.id));
    s.context.state.put("spreadsheets", id, { ...spreadsheet, version: spreadsheet.version + 1 });
    return {};
  },
};

// ---------------------------------------------------------------------------------------------
// HTTP codecs: pure request/response mapping, no state and no permission checks.
// ---------------------------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Forwards a value that cannot be a spreadsheet id when a colon method suffix is wrong, so the handler answers 404. */
function unroutable(id, rest) {
  return `${id}/${rest}`;
}

function valuesQuery(query) {
  return {
    majorDimension: one(query, "majorDimension"),
    valueRenderOption: one(query, "valueRenderOption"),
    dateTimeRenderOption: one(query, "dateTimeRenderOption"),
  };
}

function writeQuery(query) {
  return {
    valueInputOption: one(query, "valueInputOption") ?? "INPUT_VALUE_OPTION_UNSPECIFIED",
    includeValuesInResponse: booleanParam(query, "includeValuesInResponse"),
    responseValueRenderOption: one(query, "responseValueRenderOption"),
    responseDateTimeRenderOption: one(query, "responseDateTimeRenderOption"),
  };
}

const http = {
  "create-spreadsheet": {
    decode: (request) => {
      const body = jsonBody(request);
      // Anything that is not the declared JSON shape is forwarded unchanged, so the operation's input schema rejects it
      // and the route answers Google's 400 INVALID_ARGUMENT envelope instead of a decode failure.
      const properties = !isPlainObject(body.properties) ? body.properties : compact({
        title: body.properties.title,
        locale: body.properties.locale,
        timeZone: body.properties.timeZone,
      });
      const sheets = !Array.isArray(body.sheets)
        ? body.sheets
        : body.sheets.map((sheet) => {
            if (!isPlainObject(sheet)) return sheet;
            if (sheet.properties === undefined) return {};
            const props = sheet.properties;
            if (!isPlainObject(props)) return { properties: props };
            return {
              properties: compact({
                sheetId: props.sheetId,
                title: props.title,
                index: props.index,
                hidden: props.hidden,
                gridProperties:
                  !isPlainObject(props.gridProperties)
                    ? props.gridProperties
                    : compact({
                        rowCount: props.gridProperties.rowCount,
                        columnCount: props.gridProperties.columnCount,
                        frozenRowCount: props.gridProperties.frozenRowCount,
                        frozenColumnCount: props.gridProperties.frozenColumnCount,
                      }),
                tabColorStyle: !isPlainObject(props.tabColorStyle)
                  ? props.tabColorStyle
                  : props.tabColorStyle.rgbColor === undefined ? undefined : { rgbColor: props.tabColorStyle.rgbColor },
              }),
            };
          });
      return mutation(request, { properties, sheets, fields: one(request.query, "fields") });
    },
    encode: encodeSheetsMasked("spreadsheet"),
  },
  "get-spreadsheet": {
    decode: (request) => ({
      arguments: compact({
        spreadsheetId: pathParam(request, "spreadsheetId"),
        ranges: all(request.query, "ranges"),
        includeGridData: booleanParam(request.query, "includeGridData"),
        fields: one(request.query, "fields"),
      }),
    }),
    encode: ({ invocation, outcome }) => {
      if (outcome.status !== "ok") return encodeSheets()({ outcome });
      return { body: { kind: "json", value: maskResource(outcome.value, invocation.arguments.fields, "spreadsheet") } };
    },
  },
  "batch-update-spreadsheet": {
    decode: (request) => {
      const raw = pathParam(request, "spreadsheetId");
      const body = jsonBody(request);
      return mutation(request, {
        spreadsheetId: splitMethod(raw, "batchUpdate") ?? unroutable(raw, "batchUpdate"),
        requests: Array.isArray(body.requests) ? body.requests : [],
        includeSpreadsheetInResponse: body.includeSpreadsheetInResponse,
        responseRanges: body.responseRanges,
        responseIncludeGridData: body.responseIncludeGridData,
        fields: one(request.query, "fields"),
      });
    },
    encode: encodeSheetsMasked("batchUpdateSpreadsheet"),
  },
  "copy-sheet-to": {
    decode: (request) => {
      const id = pathParam(request, "spreadsheetId");
      const raw = pathParam(request, "sheetId");
      const sheetText = splitMethod(raw, "copyTo");
      const valid = sheetText !== undefined && /^\d{1,10}$/.test(sheetText) && Number(sheetText) <= 2_147_483_647;
      const body = jsonBody(request);
      return mutation(request, {
        spreadsheetId: valid ? id : unroutable(id, `sheets/${raw}`),
        sheetId: valid ? Number(sheetText) : 0,
        destinationSpreadsheetId: body.destinationSpreadsheetId,
        fields: one(request.query, "fields"),
      });
    },
    encode: encodeSheetsMasked("sheetProperties"),
  },
  "get-values": {
    decode: (request) => ({
      arguments: compact({
        spreadsheetId: pathParam(request, "spreadsheetId"),
        range: pathParam(request, "range"),
        ...valuesQuery(request.query),
        fields: one(request.query, "fields"),
      }),
    }),
    encode: encodeSheetsMasked("valueRange"),
  },
  "update-values": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, {
        spreadsheetId: pathParam(request, "spreadsheetId"),
        range: pathParam(request, "range"),
        values: body.values ?? [],
        majorDimension: body.majorDimension,
        ...writeQuery(request.query),
        fields: one(request.query, "fields"),
      });
    },
    encode: encodeSheetsMasked("updateValues"),
  },
  "append-values": {
    decode: (request) => {
      const id = pathParam(request, "spreadsheetId");
      const raw = pathParam(request, "range");
      const range = splitMethod(raw, "append");
      const body = jsonBody(request);
      return mutation(request, {
        spreadsheetId: range === undefined ? unroutable(id, `values/${raw}`) : id,
        range: range ?? raw,
        values: body.values ?? [],
        majorDimension: body.majorDimension,
        insertDataOption: one(request.query, "insertDataOption"),
        ...writeQuery(request.query),
        fields: one(request.query, "fields"),
      });
    },
    encode: encodeSheetsMasked("appendValues"),
  },
  "batch-get-values": {
    decode: (request) => {
      const id = pathParam(request, "spreadsheetId");
      const method = pathParam(request, "collectionMethod");
      return {
        arguments: compact({
          spreadsheetId: method === "values:batchGet" ? id : unroutable(id, method),
          ranges: all(request.query, "ranges") ?? [],
          ...valuesQuery(request.query),
          fields: one(request.query, "fields"),
        }),
      };
    },
    encode: encodeSheetsMasked("batchGetValues"),
  },
  "batch-update-values": {
    decode: (request) => {
      const id = pathParam(request, "spreadsheetId");
      const method = pathParam(request, "collectionMethod");
      const body = jsonBody(request);
      return mutation(request, {
        spreadsheetId: method === "values:batchUpdate" ? id : unroutable(id, method),
        valueInputOption: body.valueInputOption ?? "INPUT_VALUE_OPTION_UNSPECIFIED",
        data: body.data ?? [],
        includeValuesInResponse: body.includeValuesInResponse,
        responseValueRenderOption: body.responseValueRenderOption,
        responseDateTimeRenderOption: body.responseDateTimeRenderOption,
        fields: one(request.query, "fields"),
      });
    },
    encode: encodeSheetsMasked("batchUpdateValues"),
  },
  "list-files": {
    decode: (request) => ({
      arguments: compact({
        q: one(request.query, "q"),
        pageSize: integerParam(request.query, "pageSize"),
        pageToken: one(request.query, "pageToken"),
        orderBy: one(request.query, "orderBy"),
        corpora: one(request.query, "corpora"),
        driveId: one(request.query, "driveId"),
        includeItemsFromAllDrives: booleanParam(request.query, "includeItemsFromAllDrives"),
        fields: one(request.query, "fields"),
      }),
    }),
    encode: encodeDrive((value) => value, "fileList"),
  },
  "get-file": {
    decode: (request) => ({
      arguments: compact({ fileId: pathParam(request, "fileId"), fields: one(request.query, "fields"), alt: one(request.query, "alt") }),
    }),
    encode: encodeDrive((value) => value, "file"),
  },
  "update-file": {
    decode: (request) => {
      const body = jsonBody(request);
      const unwritable = Object.keys(body).filter((name) => !["name", "starred", "trashed"].includes(name));
      return mutation(request, {
        fileId: pathParam(request, "fileId"),
        unwritableFields: unwritable.length === 0 ? undefined : unwritable.slice(0, 32).map((name) => name.slice(0, 128) || "_"),
        name: body.name,
        starred: body.starred,
        trashed: body.trashed,
        fields: one(request.query, "fields"),
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
      return mutation(request, { fileId: pathParam(request, "fileId"), name: body.name, fields: one(request.query, "fields") });
    },
    encode: encodeDrive((value) => value, "file"),
  },
  "list-permissions": {
    decode: (request) => ({
      arguments: compact({
        fileId: pathParam(request, "fileId"),
        pageSize: integerParam(request.query, "pageSize"),
        pageToken: one(request.query, "pageToken"),
        fields: one(request.query, "fields"),
      }),
    }),
    encode: encodeDrive((value) => value, "permissionList"),
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
        transferOwnership: booleanParam(request.query, "transferOwnership"),
        sendNotificationEmail: booleanParam(request.query, "sendNotificationEmail"),
        fields: one(request.query, "fields"),
      });
    },
    encode: encodeDrive((value) => value, "permission"),
  },
  "delete-permission": {
    decode: (request) => mutation(request, { fileId: pathParam(request, "fileId"), permissionId: pathParam(request, "permissionId") }),
    encode: encodeEmptyDrive,
  },
  "get-about": {
    decode: (request) => ({ arguments: compact({ fields: one(request.query, "fields") }) }),
    encode: encodeDrive(restAbout, "about"),
  },
};

export default { operations, http };
