// `spreadsheets.batchUpdate`: validation and application of the 14 supported request kinds to an in-memory book.
// Requests apply in order to the working copy; the handler flushes once, so a failing request leaves nothing applied.
// Pure with respect to storage: every read and write goes through the book.

import { parseReference } from "./a1.mjs";
import {
  NUMBER_FORMAT_TYPES,
  cellAt,
  checkGridBounds,
  colorToHex,
  deleteDimension,
  insertDimension,
  isValidSheetTitle,
  makeEvaluator,
  guardEvaluation,
  MAX_INSERT,
  normalizeCells,
  patchCell,
  renameSheet,
  resolveGridRange,
  sheetProperties,
  namedRangeResource,
  uniqueTitle,
} from "./engine.mjs";
import { formatValue } from "./format.mjs";
import { parseUserEntered } from "./input.mjs";
import { MAX_SHEET_ID } from "./ids.mjs";
import { isError } from "./formula.mjs";

export const SUPPORTED_REQUESTS = [
  "addSheet",
  "deleteSheet",
  "updateSheetProperties",
  "duplicateSheet",
  "updateSpreadsheetProperties",
  "insertDimension",
  "deleteDimension",
  "appendDimension",
  "updateCells",
  "repeatCell",
  "findReplace",
  "sortRange",
  "addNamedRange",
  "deleteNamedRange",
];

const DIMENSIONS = ["ROWS", "COLUMNS"];
const ALIGNMENTS = ["LEFT", "CENTER", "RIGHT"];
const WRAPS = ["OVERFLOW_CELL", "CLIP", "WRAP"];
const TEXT_KEYS = ["bold", "italic", "strikethrough", "underline", "fontSize", "foregroundColorRgb"];
const ALL_FORMAT_KEYS = [...TEXT_KEYS, "backgroundColorRgb", "horizontalAlignment", "wrapStrategy", "numberFormat"];
const FORMAT_PATHS = {
  userEnteredFormat: ALL_FORMAT_KEYS,
  "userEnteredFormat.numberFormat": ["numberFormat"],
  "userEnteredFormat.backgroundColor": ["backgroundColorRgb"],
  "userEnteredFormat.backgroundColorStyle": ["backgroundColorRgb"],
  "userEnteredFormat.horizontalAlignment": ["horizontalAlignment"],
  "userEnteredFormat.wrapStrategy": ["wrapStrategy"],
  "userEnteredFormat.textFormat": TEXT_KEYS,
  "userEnteredFormat.textFormat.bold": ["bold"],
  "userEnteredFormat.textFormat.italic": ["italic"],
  "userEnteredFormat.textFormat.strikethrough": ["strikethrough"],
  "userEnteredFormat.textFormat.underline": ["underline"],
  "userEnteredFormat.textFormat.fontSize": ["fontSize"],
  "userEnteredFormat.textFormat.foregroundColor": ["foregroundColorRgb"],
  "userEnteredFormat.textFormat.foregroundColorStyle": ["foregroundColorRgb"],
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fieldList(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Converts a Sheets `CellFormat` restricted to storage keys; unknown values are rejected by `fail(message)`. */
function formatFromResource(format, keys, fail) {
  const source = isObject(format) ? format : {};
  const text = isObject(source.textFormat) ? source.textFormat : {};
  const patch = {};
  for (const key of keys) {
    let value;
    switch (key) {
      case "bold":
      case "italic":
      case "strikethrough":
      case "underline":
        value = text[key];
        if (value !== undefined && typeof value !== "boolean") fail(`textFormat.${key} must be a boolean`);
        break;
      case "fontSize":
        value = text.fontSize;
        if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 400)) fail("textFormat.fontSize must be an integer between 1 and 400");
        break;
      case "foregroundColorRgb": {
        const color = text.foregroundColorStyle?.rgbColor ?? text.foregroundColor;
        if (color !== undefined) {
          value = colorToHex(color);
          if (value === undefined) fail("textFormat.foregroundColor must have red/green/blue between 0 and 1");
        }
        break;
      }
      case "backgroundColorRgb": {
        const color = source.backgroundColorStyle?.rgbColor ?? source.backgroundColor;
        if (color !== undefined) {
          value = colorToHex(color);
          if (value === undefined) fail("backgroundColor must have red/green/blue between 0 and 1");
        }
        break;
      }
      case "horizontalAlignment":
        value = source.horizontalAlignment;
        if (value !== undefined && !ALIGNMENTS.includes(value)) fail(`horizontalAlignment must be one of ${ALIGNMENTS.join(", ")}`);
        break;
      case "wrapStrategy":
        value = source.wrapStrategy;
        if (value !== undefined && !WRAPS.includes(value)) fail(`wrapStrategy must be one of ${WRAPS.join(", ")}`);
        break;
      default: {
        const numberFormat = source.numberFormat;
        if (numberFormat !== undefined) {
          if (!isObject(numberFormat) || !NUMBER_FORMAT_TYPES.includes(numberFormat.type)) {
            fail(`numberFormat.type must be one of ${NUMBER_FORMAT_TYPES.join(", ")}`);
          }
          if (numberFormat.pattern !== undefined && (typeof numberFormat.pattern !== "string" || numberFormat.pattern.length > 64)) {
            fail("numberFormat.pattern must be a string of at most 64 characters");
          }
          value = numberFormat.pattern === undefined || numberFormat.pattern === "" ? { type: numberFormat.type } : { type: numberFormat.type, pattern: numberFormat.pattern };
        }
      }
    }
    patch[key] = value;
  }
  return patch;
}

function applyFormatPatch(existing, patch) {
  const next = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

function storedValueFromExtended(value, fail, limits) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) fail("userEnteredValue must be an object");
  const keys = Object.keys(value);
  if (keys.length !== 1) fail("userEnteredValue must set exactly one of stringValue, numberValue, boolValue, formulaValue");
  const [key] = keys;
  const item = value[key];
  switch (key) {
    case "stringValue":
      if (typeof item !== "string") fail("stringValue must be a string");
      if (item.length > limits.maxCellCharacters) fail(`stringValue exceeds ${limits.maxCellCharacters} characters`);
      return { kind: "string", string: item };
    case "numberValue":
      if (typeof item !== "number" || !Number.isFinite(item)) fail("numberValue must be a finite number");
      return { kind: "number", number: item };
    case "boolValue":
      if (typeof item !== "boolean") fail("boolValue must be a boolean");
      return { kind: "bool", bool: item };
    case "formulaValue":
      if (typeof item !== "string" || !item.startsWith("=") || item.length > 2000) fail("formulaValue must start with = and be at most 2000 characters");
      return { kind: "formula", formula: item };
    default:
      return fail(`${key} cannot be written`);
  }
}

/** Parses a CellData field mask into `{ value: bool, formatKeys: string[] }`. */
function cellMask(fields, fail) {
  const paths = fieldList(fields);
  if (paths === null) fail("fields is required (for example userEnteredValue or userEnteredFormat.textFormat.bold)");
  let value = false;
  const formatKeys = new Set();
  for (const path of paths) {
    if (path === "*") {
      value = true;
      for (const key of ALL_FORMAT_KEYS) formatKeys.add(key);
    } else if (path === "userEnteredValue") value = true;
    // Own keys only: `__proto__`, `constructor` or `toString` must be "not supported", never an inherited member.
    else if (Object.hasOwn(FORMAT_PATHS, path)) for (const key of FORMAT_PATHS[path]) formatKeys.add(key);
    else if (path === "note") fail("note is read-only in this simulated service");
    else fail(`field ${path} is not supported by this Tool`);
  }
  return { value, formatKeys: [...formatKeys] };
}

function comparableSortValue(value) {
  if (value === null || value === "" || isError(value)) return { rank: 3 };
  if (typeof value === "number") return { rank: 0, value };
  if (typeof value === "string") return { rank: 1, value: value.toLowerCase() };
  return { rank: 2, value: Number(value) };
}

/** Non-overlapping, left-to-right occurrences of `needle` (the matches `split` and the replace loop below use). Linear. */
function countLiteral(text, find, matchCase) {
  let haystack = text;
  let needle = find;
  if (!matchCase) {
    const lowerText = text.toLowerCase();
    const lowerFind = find.toLowerCase();
    if (lowerText.length === text.length && lowerFind.length === find.length) {
      haystack = lowerText;
      needle = lowerFind;
    }
  }
  let count = 0;
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + needle.length)) count += 1;
  return count;
}

function replaceLiteral(text, find, replacement, matchCase) {
  if (matchCase) {
    const parts = text.split(find);
    return { text: parts.join(replacement), count: parts.length - 1 };
  }
  const lowerText = text.toLowerCase();
  const lowerFind = find.toLowerCase();
  if (lowerText.length !== text.length || lowerFind.length !== find.length) {
    const parts = text.split(find);
    return { text: parts.join(replacement), count: parts.length - 1 };
  }
  let out = "";
  let cursor = 0;
  let count = 0;
  for (;;) {
    const index = lowerText.indexOf(lowerFind, cursor);
    if (index < 0) break;
    out += text.slice(cursor, index) + replacement;
    cursor = index + find.length;
    count += 1;
  }
  return { text: out + text.slice(cursor), count };
}

/**
 * Applies `requests` to `book`. `hooks`: `nextSheetId(book)`, `nextNamedRangeId()`, `sheetChanged(sheet, change)`,
 * `valuesChanged(sheet, grid, cells, source)`. Returns the replies.
 */
export function applyRequests(s, book, requests, hooks) {
  if (!Array.isArray(requests) || requests.length === 0) s.invalid("Must specify at least one request.");
  if (requests.length > s.limits.maxRequestsPerBatch) {
    s.precondition(`the batch has ${requests.length} requests, over the supported bound of ${s.limits.maxRequestsPerBatch} requests per batch`);
  }
  const replies = [];
  requests.forEach((request, index) => {
    if (!isObject(request)) s.invalid(`Invalid requests[${index}]: request must be an object`);
    const kinds = Object.keys(request);
    if (kinds.length !== 1) s.invalid(`Invalid requests[${index}]: exactly one request kind must be set`);
    const [kind] = kinds;
    if (!SUPPORTED_REQUESTS.includes(kind)) s.invalid(`Invalid requests[${index}]: ${kind} is not supported by this Tool`);
    const body = request[kind];
    const prefix = `Invalid requests[${index}].${kind}`;
    const fail = (message) => s.invalid(`${prefix}: ${message}`);
    if (!isObject(body)) fail("request body must be an object");
    replies.push(HANDLERS[kind](s, book, body, { fail, prefix, hooks }));
  });
  return replies;
}

function dimensionRange(s, book, range, fail) {
  if (!isObject(range)) fail("range is required");
  const sheet = Number.isInteger(range.sheetId) ? book.sheetById(range.sheetId) : null;
  if (sheet === null) fail(`No grid with id: ${range.sheetId}`);
  if (!DIMENSIONS.includes(range.dimension)) fail("range.dimension must be ROWS or COLUMNS");
  if (!Number.isInteger(range.startIndex) || !Number.isInteger(range.endIndex) || range.startIndex < 0) {
    fail("range.startIndex and range.endIndex are required non-negative integers");
  }
  if (range.startIndex >= range.endIndex) fail("range.startIndex must be less than range.endIndex");
  return { sheet, dimension: range.dimension, start: range.startIndex, end: range.endIndex };
}

/** Shared by `insertDimension` requests and `sheets.insert-dimension`. */
export function applyInsertDimension(s, book, { sheet, dimension, start, end, inheritFromBefore }, fail, hooks) {
  const size = dimension === "ROWS" ? sheet.rowCount : sheet.columnCount;
  if (start > size) fail(`range.startIndex ${start} is beyond the ${dimension === "ROWS" ? "row" : "column"} count ${size}`);
  if (inheritFromBefore === true && start === 0) fail("Cannot inherit properties from before when inserting at index 0.");
  if (inheritFromBefore !== undefined && typeof inheritFromBefore !== "boolean") fail("inheritFromBefore must be a boolean");
  if (end - start > MAX_INSERT) fail(`at most ${MAX_INSERT} rows or columns can be inserted at once`);
  insertDimension(s, book, sheet, dimension, start, end - start, inheritFromBefore === true);
  hooks.sheetChanged(sheet, "resized");
}

const HANDLERS = {
  addSheet(s, book, body, { fail, hooks }) {
    const properties = body.properties ?? {};
    if (!isObject(properties)) fail("properties must be an object");
    let title = properties.title;
    if (title === undefined) {
      for (let n = book.sheets.length + 1; ; n += 1) {
        if (book.sheetByTitle(`Sheet${n}`) === null) {
          title = `Sheet${n}`;
          break;
        }
      }
    }
    if (!isValidSheetTitle(title)) fail("properties.title must be 1-100 characters");
    if (book.sheetByTitle(title) !== null) fail(`A sheet with the name "${title}" already exists. Please enter another name.`);
    let sheetId = properties.sheetId;
    if (sheetId !== undefined) {
      if (!Number.isInteger(sheetId) || sheetId < 0 || sheetId > MAX_SHEET_ID) fail("properties.sheetId must be a non-negative 32-bit integer");
      if (book.sheetById(sheetId) !== null) fail(`Sheet with id ${sheetId} already exists.`);
    } else sheetId = hooks.nextSheetId(book);
    const grid = properties.gridProperties ?? {};
    if (!isObject(grid)) fail("properties.gridProperties must be an object");
    const rowCount = grid.rowCount ?? 1000;
    const columnCount = grid.columnCount ?? 26;
    if (!Number.isInteger(rowCount) || rowCount < 1 || !Number.isInteger(columnCount) || columnCount < 1) {
      fail("gridProperties.rowCount and columnCount must be positive integers");
    }
    const frozenRowCount = grid.frozenRowCount ?? 0;
    const frozenColumnCount = grid.frozenColumnCount ?? 0;
    if (!Number.isInteger(frozenRowCount) || frozenRowCount < 0 || frozenRowCount >= rowCount) fail("gridProperties.frozenRowCount is out of range");
    if (!Number.isInteger(frozenColumnCount) || frozenColumnCount < 0 || frozenColumnCount >= columnCount) {
      fail("gridProperties.frozenColumnCount is out of range");
    }
    let tabColorRgb;
    const color = properties.tabColorStyle?.rgbColor ?? properties.tabColor;
    if (color !== undefined) {
      tabColorRgb = colorToHex(color);
      if (tabColorRgb === undefined) fail("tabColor must have red/green/blue between 0 and 1");
    }
    const index = properties.index ?? book.sheets.length;
    if (!Number.isInteger(index) || index < 0) fail("properties.index must be a non-negative integer");
    if (properties.hidden !== undefined && typeof properties.hidden !== "boolean") fail("properties.hidden must be a boolean");
    const sheet = {
      spreadsheetId: book.id,
      sheetId,
      title,
      index: 0,
      hidden: properties.hidden === true,
      rowCount,
      columnCount,
      frozenRowCount,
      frozenColumnCount,
    };
    if (tabColorRgb !== undefined) sheet.tabColorRgb = tabColorRgb;
    book.sheets.splice(Math.min(index, book.sheets.length), 0, sheet);
    book.reindex();
    book.adoptEmptySheet(sheetId);
    checkGridBounds(s, book);
    hooks.sheetChanged(sheet, "added");
    return { addSheet: { properties: sheetProperties(sheet) } };
  },

  deleteSheet(s, book, body, { fail, hooks }) {
    const sheet = Number.isInteger(body.sheetId) ? book.sheetById(body.sheetId) : null;
    if (sheet === null) fail(`No grid with id: ${body.sheetId}`);
    if (book.sheets.length === 1) fail("You can't remove all the sheets in a document.");
    if (book.sheets.every((candidate) => candidate === sheet || candidate.hidden)) fail("You can't remove all the visible sheets in a document.");
    book.rowsOf(sheet.sheetId);
    book.sheets = book.sheets.filter((candidate) => candidate !== sheet);
    book.reindex();
    book.named = book.namedRanges().filter((named) => named.sheetId !== sheet.sheetId);
    hooks.sheetChanged(sheet, "deleted");
    return {};
  },

  updateSheetProperties(s, book, body, { fail, hooks }) {
    const properties = body.properties;
    if (!isObject(properties)) fail("properties is required");
    const sheet = Number.isInteger(properties.sheetId) ? book.sheetById(properties.sheetId) : null;
    if (sheet === null) fail(`No grid with id: ${properties.sheetId}`);
    const paths = fieldList(body.fields);
    if (paths === null) fail("At least one field must be specified in 'fields'.");
    const all = paths.includes("*");
    const wants = (path) => all || paths.includes(path) || (path.startsWith("gridProperties.") && paths.includes("gridProperties"));
    const known = [
      "*",
      "title",
      "index",
      "hidden",
      "tabColor",
      "tabColorStyle",
      "gridProperties",
      "gridProperties.rowCount",
      "gridProperties.columnCount",
      "gridProperties.frozenRowCount",
      "gridProperties.frozenColumnCount",
    ];
    for (const path of paths) if (!known.includes(path)) fail(`field ${path} is not supported by this Tool`);
    const grid = isObject(properties.gridProperties) ? properties.gridProperties : {};
    if (wants("title") && (all ? properties.title !== undefined : true)) {
      const title = properties.title;
      if (!isValidSheetTitle(title)) fail("properties.title must be 1-100 characters");
      const clash = book.sheetByTitle(title);
      if (clash !== null && clash !== sheet) fail(`A sheet with the name "${title}" already exists. Please enter another name.`);
      if (title !== sheet.title) {
        renameSheet(book, sheet, title);
        hooks.sheetChanged(sheet, "renamed");
      }
    }
    if (wants("hidden") && (all ? properties.hidden !== undefined : true)) {
      const hidden = properties.hidden === true;
      if (hidden && !sheet.hidden && book.sheets.every((candidate) => candidate === sheet || candidate.hidden)) {
        fail("Cannot hide all visible sheets.");
      }
      if (hidden !== sheet.hidden) {
        sheet.hidden = hidden;
        hooks.sheetChanged(sheet, hidden ? "hidden" : "shown");
      }
    }
    if (wants("index") && (all ? properties.index !== undefined : true)) {
      const index = properties.index ?? 0;
      if (!Number.isInteger(index) || index < 0) fail("properties.index must be a non-negative integer");
      const current = book.sheets.indexOf(sheet);
      const target = Math.min(index, book.sheets.length - 1);
      if (target !== current) {
        book.sheets.splice(current, 1);
        book.sheets.splice(target, 0, sheet);
        book.reindex();
        hooks.sheetChanged(sheet, "reordered");
      }
    }
    if ((wants("tabColor") || wants("tabColorStyle")) && (all ? properties.tabColor !== undefined || properties.tabColorStyle !== undefined : true)) {
      const color = properties.tabColorStyle?.rgbColor ?? properties.tabColor;
      if (color === undefined) delete sheet.tabColorRgb;
      else {
        const hex = colorToHex(color);
        if (hex === undefined) fail("tabColor must have red/green/blue between 0 and 1");
        sheet.tabColorRgb = hex;
      }
    }
    let resized = false;
    for (const [key, field] of [
      ["rowCount", "rowCount"],
      ["columnCount", "columnCount"],
    ]) {
      if (!wants(`gridProperties.${key}`) || (all && grid[key] === undefined) || (paths.includes("gridProperties") && grid[key] === undefined)) continue;
      const value = grid[key];
      if (!Number.isInteger(value) || value < 1) fail(`gridProperties.${key} must be a positive integer`);
      if (value < sheet[field]) {
        if (key === "rowCount") {
          const rows = book.rowsOf(sheet.sheetId);
          for (const rowIndex of [...rows.keys()]) if (rowIndex >= value) rows.delete(rowIndex);
        } else {
          const rows = book.rowsOf(sheet.sheetId);
          for (const [rowIndex, cells] of [...rows]) {
            const kept = cells.filter((cell) => cell.columnIndex < value);
            if (kept.length === 0) rows.delete(rowIndex);
            else rows.set(rowIndex, kept);
          }
        }
      }
      if (value !== sheet[field]) {
        sheet[field] = value;
        resized = true;
      }
    }
    for (const key of ["frozenRowCount", "frozenColumnCount"]) {
      if (!wants(`gridProperties.${key}`) || ((all || paths.includes("gridProperties")) && grid[key] === undefined)) continue;
      const value = grid[key] ?? 0;
      const limit = key === "frozenRowCount" ? sheet.rowCount : sheet.columnCount;
      if (!Number.isInteger(value) || value < 0 || value >= limit) fail(`gridProperties.${key} is out of range`);
      sheet[key] = value;
    }
    if (sheet.frozenRowCount >= sheet.rowCount) sheet.frozenRowCount = 0;
    if (sheet.frozenColumnCount >= sheet.columnCount) sheet.frozenColumnCount = 0;
    if (resized) {
      checkGridBounds(s, book);
      hooks.sheetChanged(sheet, "resized");
    }
    return {};
  },

  duplicateSheet(s, book, body, { fail, hooks }) {
    const source = Number.isInteger(body.sourceSheetId) ? book.sheetById(body.sourceSheetId) : null;
    if (source === null) fail(`No grid with id: ${body.sourceSheetId}`);
    let sheetId = body.newSheetId;
    if (sheetId !== undefined) {
      if (!Number.isInteger(sheetId) || sheetId < 0 || sheetId > MAX_SHEET_ID) fail("newSheetId must be a non-negative 32-bit integer");
      if (book.sheetById(sheetId) !== null) fail(`Sheet with id ${sheetId} already exists.`);
    } else sheetId = hooks.nextSheetId(book);
    let title = body.newSheetName;
    if (title === undefined) title = uniqueTitle(book, `Copy of ${source.title}`);
    if (!isValidSheetTitle(title)) fail("newSheetName must be 1-100 characters");
    if (book.sheetByTitle(title) !== null) fail(`A sheet with the name "${title}" already exists. Please enter another name.`);
    const index = body.insertSheetIndex ?? source.index + 1;
    if (!Number.isInteger(index) || index < 0) fail("insertSheetIndex must be a non-negative integer");
    const sheet = { ...source, sheetId, title, hidden: false };
    const rows = book.rowsOf(source.sheetId);
    const copy = book.adoptEmptySheet(sheetId);
    for (const [rowIndex, cells] of rows) copy.set(rowIndex, JSON.parse(JSON.stringify(cells)));
    book.sheets.splice(Math.min(index, book.sheets.length), 0, sheet);
    book.reindex();
    checkGridBounds(s, book);
    hooks.sheetChanged(sheet, "duplicated");
    if (copy.size > 0) hooks.valuesChanged(sheet, null, [...copy.values()].reduce((total, cells) => total + cells.length, 0), "duplicateSheet");
    return { duplicateSheet: { properties: sheetProperties(sheet) } };
  },

  updateSpreadsheetProperties(s, book, body, { fail }) {
    const properties = body.properties;
    if (!isObject(properties)) fail("properties is required");
    const paths = fieldList(body.fields);
    if (paths === null) fail("At least one field must be specified in 'fields'.");
    for (const path of paths) if (!["*", "title", "locale", "timeZone"].includes(path)) fail(`field ${path} is not supported by this Tool`);
    const wants = (path) => paths.includes("*") || paths.includes(path);
    if (wants("title") && !(paths.includes("*") && properties.title === undefined)) {
      if (typeof properties.title !== "string" || properties.title.length === 0 || properties.title.length > 255) {
        fail("properties.title must be 1-255 characters");
      }
      book.spreadsheet.title = properties.title;
    }
    if (wants("locale") && !(paths.includes("*") && properties.locale === undefined)) {
      if (properties.locale !== "en_US") fail("only the en_US locale is supported by this simulated service");
      book.spreadsheet.locale = "en_US";
    }
    if (wants("timeZone") && !(paths.includes("*") && properties.timeZone === undefined)) {
      if (typeof properties.timeZone !== "string" || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(properties.timeZone)) {
        fail("properties.timeZone must be an IANA time zone name");
      }
      book.spreadsheet.timeZone = properties.timeZone;
    }
    return {};
  },

  insertDimension(s, book, body, { fail, hooks }) {
    const range = dimensionRange(s, book, body.range, fail);
    applyInsertDimension(s, book, { ...range, inheritFromBefore: body.inheritFromBefore }, fail, hooks);
    return {};
  },

  deleteDimension(s, book, body, { fail, hooks }) {
    const { sheet, dimension, start, end } = dimensionRange(s, book, body.range, fail);
    const size = dimension === "ROWS" ? sheet.rowCount : sheet.columnCount;
    if (end > size) fail(`range.endIndex ${end} is beyond the ${dimension === "ROWS" ? "row" : "column"} count ${size}`);
    if (start === 0 && end >= size) fail(`You can't delete all the ${dimension === "ROWS" ? "rows" : "columns"} on the sheet.`);
    deleteDimension(s, book, sheet, dimension, start, end);
    hooks.sheetChanged(sheet, "resized");
    return {};
  },

  appendDimension(s, book, body, { fail, hooks }) {
    const sheet = Number.isInteger(body.sheetId) ? book.sheetById(body.sheetId) : null;
    if (sheet === null) fail(`No grid with id: ${body.sheetId}`);
    if (!DIMENSIONS.includes(body.dimension)) fail("dimension must be ROWS or COLUMNS");
    if (!Number.isInteger(body.length) || body.length < 1) fail("length must be a positive integer");
    if (body.dimension === "ROWS") sheet.rowCount += body.length;
    else sheet.columnCount += body.length;
    checkGridBounds(s, book);
    hooks.sheetChanged(sheet, "resized");
    return {};
  },

  updateCells(s, book, body, { fail, hooks }) {
    const mask = cellMask(body.fields, fail);
    if ((body.start === undefined) === (body.range === undefined)) fail("exactly one of start or range must be set");
    const rows = body.rows ?? [];
    if (!Array.isArray(rows)) fail("rows must be an array");
    let sheet;
    let origin;
    let limit;
    if (body.start !== undefined) {
      if (!isObject(body.start)) fail("start must be a GridCoordinate");
      sheet = Number.isInteger(body.start.sheetId ?? 0) ? book.sheetById(body.start.sheetId ?? 0) : null;
      if (sheet === null) fail(`No grid with id: ${body.start.sheetId}`);
      origin = { row: body.start.rowIndex ?? 0, column: body.start.columnIndex ?? 0 };
      if (!Number.isInteger(origin.row) || !Number.isInteger(origin.column) || origin.row < 0 || origin.column < 0) fail("start indices must be non-negative integers");
    } else {
      const resolved = resolveGridRange(s, book, body.range, `Invalid requests.updateCells`);
      sheet = resolved.sheet;
      limit = resolved.grid;
      origin = { row: limit.startRow, column: limit.startColumn };
    }
    let written = 0;
    const covered = new Set();
    rows.forEach((rowData, rowOffset) => {
      if (!isObject(rowData)) fail(`rows[${rowOffset}] must be a RowData object`);
      const values = rowData.values ?? [];
      if (!Array.isArray(values)) fail(`rows[${rowOffset}].values must be an array`);
      values.forEach((cellData, columnOffset) => {
        const row = origin.row + rowOffset;
        const column = origin.column + columnOffset;
        if (limit !== undefined && (row >= limit.endRow || column >= limit.endColumn)) return;
        if (row >= sheet.rowCount || column >= sheet.columnCount) fail(`the cell at row ${row} column ${column} is outside the grid of sheet ${sheet.title}`);
        if (!isObject(cellData)) fail(`rows[${rowOffset}].values[${columnOffset}] must be a CellData object`);
        written += 1;
        covered.add(`${row}:${column}`);
        const patch = {};
        if (mask.value) patch.value = storedValueFromExtended(cellData.userEnteredValue, fail, s.limits);
        if (mask.formatKeys.length > 0) {
          const existing = cellAt(book.rowsOf(sheet.sheetId).get(row), column)?.format;
          patch.format = applyFormatPatch(existing, formatFromResource(cellData.userEnteredFormat, mask.formatKeys, fail));
        }
        patchCell(book, sheet.sheetId, row, column, patch);
      });
    });
    if (written > s.limits.maxCellsPerWrite) {
      s.precondition(`the request writes ${written} cells, over the supported bound of ${s.limits.maxCellsPerWrite} cells per write`);
    }
    if (limit !== undefined) {
      for (const [rowIndex, cells] of book.storedRows(sheet.sheetId, limit.startRow, limit.endRow)) {
        for (const cell of [...cells]) {
          if (cell.columnIndex < limit.startColumn || cell.columnIndex >= limit.endColumn || covered.has(`${rowIndex}:${cell.columnIndex}`)) continue;
          const patch = {};
          if (mask.value) patch.value = null;
          if (mask.formatKeys.length > 0) patch.format = applyFormatPatch(cell.format, Object.fromEntries(mask.formatKeys.map((key) => [key, undefined])));
          patchCell(book, sheet.sheetId, rowIndex, cell.columnIndex, patch);
          written += 1;
        }
      }
    }
    hooks.valuesChanged(sheet, limit ?? null, written, "updateCells");
    return {};
  },

  repeatCell(s, book, body, { fail, hooks }) {
    const mask = cellMask(body.fields, fail);
    if (!isObject(body.cell)) fail("cell is required");
    const { sheet, grid } = resolveGridRange(s, book, body.range, "Invalid requests.repeatCell");
    const area = (grid.endRow - grid.startRow) * (grid.endColumn - grid.startColumn);
    if (area > s.limits.maxCellsPerWrite) {
      s.precondition(`the request writes ${area} cells, over the supported bound of ${s.limits.maxCellsPerWrite} cells per write`);
    }
    const value = mask.value ? storedValueFromExtended(body.cell.userEnteredValue, fail, s.limits) : undefined;
    const formatPatch = mask.formatKeys.length > 0 ? formatFromResource(body.cell.userEnteredFormat, mask.formatKeys, fail) : undefined;
    const rows = book.rowsOf(sheet.sheetId);
    for (let row = grid.startRow; row < grid.endRow; row += 1) {
      for (let column = grid.startColumn; column < grid.endColumn; column += 1) {
        const patch = {};
        if (mask.value) patch.value = value;
        if (formatPatch !== undefined) patch.format = applyFormatPatch(cellAt(rows.get(row), column)?.format, formatPatch);
        patchCell(book, sheet.sheetId, row, column, patch);
      }
    }
    hooks.valuesChanged(sheet, grid, area, "repeatCell");
    return {};
  },

  findReplace(s, book, body, { fail, hooks }) {
    if (typeof body.find !== "string" || body.find.length === 0) fail("find must be a non-empty string");
    if (body.searchByRegex === true) fail("searchByRegex is not supported by this simulated service; use a literal find string");
    const replacement = body.replacement ?? "";
    if (typeof replacement !== "string") fail("replacement must be a string");
    const scopes = ["range", "sheetId", "allSheets"].filter((key) => body[key] !== undefined && body[key] !== false);
    if (scopes.length !== 1) fail("exactly one of range, sheetId or allSheets must be set");
    let targets;
    if (body.range !== undefined) {
      const resolved = resolveGridRange(s, book, body.range, "Invalid requests.findReplace");
      targets = [resolved];
    } else if (body.sheetId !== undefined) {
      const sheet = Number.isInteger(body.sheetId) ? book.sheetById(body.sheetId) : null;
      if (sheet === null) fail(`No grid with id: ${body.sheetId}`);
      targets = [{ sheet, grid: { startRow: 0, endRow: sheet.rowCount, startColumn: 0, endColumn: sheet.columnCount } }];
    } else {
      targets = book.sheets.map((sheet) => ({ sheet, grid: { startRow: 0, endRow: sheet.rowCount, startColumn: 0, endColumn: sheet.columnCount } }));
    }
    const matchCase = body.matchCase === true;
    const entire = body.matchEntireCell === true;
    const counts = { valuesChanged: 0, formulasChanged: 0, rowsChanged: 0, sheetsChanged: 0, occurrencesChanged: 0 };
    for (const { sheet, grid } of targets) {
      const rows = book.rowsOf(sheet.sheetId);
      let sheetCells = 0;
      for (const [rowIndex, cells] of [...rows].sort((a, b) => a[0] - b[0])) {
        if (rowIndex < grid.startRow || rowIndex >= grid.endRow) continue;
        let rowChanged = false;
        for (const cell of [...cells]) {
          if (cell.columnIndex < grid.startColumn || cell.columnIndex >= grid.endColumn || cell.value === undefined) continue;
          const isFormula = cell.value.kind === "formula";
          if (isFormula && body.includeFormulas !== true) continue;
          const text = isFormula
            ? cell.value.formula
            : cell.value.kind === "string"
              ? cell.value.string
              : formatValue(cell.value.kind === "number" ? cell.value.number : cell.value.bool, undefined);
          // Size the replaced text before building it: one short find in a long cell with a long replacement would
          // otherwise build a string of cells x occurrences x replacement length in a single request.
          const occurrences = entire
            ? Number(matchCase ? text === body.find : text.toLowerCase() === body.find.toLowerCase())
            : countLiteral(text, body.find, matchCase);
          const replacedLength = entire ? replacement.length : text.length + occurrences * (replacement.length - body.find.length);
          if (occurrences > 0 && !isFormula && replacedLength > s.limits.maxCellCharacters) {
            fail(`the replaced text of a cell exceeds ${s.limits.maxCellCharacters} characters`);
          }
          if (occurrences > 0 && isFormula && replacedLength > 2000) continue;
          let result;
          if (entire) {
            const equal = matchCase ? text === body.find : text.toLowerCase() === body.find.toLowerCase();
            result = equal ? { text: replacement, count: 1 } : { text, count: 0 };
          } else result = replaceLiteral(text, body.find, replacement, matchCase);
          if (result.count === 0 || result.text === text) continue;
          let value;
          if (isFormula) {
            if (!result.text.startsWith("=") || result.text.length > 2000) continue;
            value = { kind: "formula", formula: result.text };
            counts.formulasChanged += 1;
          } else {
            const parsed = cell.value.kind === "string" ? { value: { kind: "string", string: result.text } } : parseUserEntered(result.text);
            value = parsed.value;
            counts.valuesChanged += 1;
          }
          counts.occurrencesChanged += result.count;
          patchCell(book, sheet.sheetId, rowIndex, cell.columnIndex, { value });
          rowChanged = true;
          sheetCells += 1;
        }
        if (rowChanged) counts.rowsChanged += 1;
      }
      if (sheetCells > 0) {
        counts.sheetsChanged += 1;
        hooks.valuesChanged(sheet, grid, sheetCells, "findReplace");
      }
    }
    return { findReplace: counts };
  },

  sortRange(s, book, body, { fail, hooks }) {
    const { sheet, grid } = resolveGridRange(s, book, body.range, "Invalid requests.sortRange");
    const specs = body.sortSpecs;
    if (!Array.isArray(specs) || specs.length === 0 || specs.length > 10) fail("sortSpecs must contain between 1 and 10 entries");
    const parsedSpecs = specs.map((spec, index) => {
      if (!isObject(spec)) fail(`sortSpecs[${index}] must be an object`);
      const column = spec.dimensionIndex;
      if (!Number.isInteger(column) || column < grid.startColumn || column >= grid.endColumn) fail(`sortSpecs[${index}].dimensionIndex is outside the range`);
      const order = spec.sortOrder ?? "ASCENDING";
      if (order !== "ASCENDING" && order !== "DESCENDING") fail(`sortSpecs[${index}].sortOrder must be ASCENDING or DESCENDING`);
      return { column, descending: order === "DESCENDING" };
    });
    const rows = book.rowsOf(sheet.sheetId);
    const evaluator = makeEvaluator(s, book);
    const lastStored = Math.max(-1, ...[...rows.keys()].filter((key) => key >= grid.startRow && key < grid.endRow));
    const entries = guardEvaluation(s, () => {
      const out = [];
      for (let rowIndex = grid.startRow; rowIndex <= lastStored; rowIndex += 1) {
        const cells = rows.get(rowIndex) ?? [];
        const inside = cells.filter((cell) => cell.columnIndex >= grid.startColumn && cell.columnIndex < grid.endColumn);
        out.push({ rowIndex, inside, keys: parsedSpecs.map((spec) => comparableSortValue(evaluator.effective(sheet.sheetId, rowIndex, spec.column))) });
      }
      return out;
    });
    const sorted = entries
      .map((entry, position) => ({ ...entry, position }))
      .sort((a, b) => {
        for (let index = 0; index < parsedSpecs.length; index += 1) {
          const x = a.keys[index];
          const y = b.keys[index];
          if (x.rank === 3 || y.rank === 3) {
            if (x.rank !== y.rank) return x.rank === 3 ? 1 : -1;
            continue;
          }
          let comparison = x.rank !== y.rank ? x.rank - y.rank : x.value === y.value ? 0 : x.value < y.value ? -1 : 1;
          if (parsedSpecs[index].descending) comparison = -comparison;
          if (comparison !== 0) return comparison;
        }
        return a.position - b.position;
      });
    let moved = 0;
    sorted.forEach((entry, offset) => {
      const target = grid.startRow + offset;
      const cells = rows.get(target) ?? [];
      const outside = cells.filter((cell) => cell.columnIndex < grid.startColumn || cell.columnIndex >= grid.endColumn);
      const next = normalizeCells([...outside, ...entry.inside.map((cell) => JSON.parse(JSON.stringify(cell)))]);
      if (entry.rowIndex !== target) moved += entry.inside.length;
      if (next.length === 0) rows.delete(target);
      else rows.set(target, next);
    });
    hooks.valuesChanged(sheet, grid, moved, "sortRange");
    return {};
  },

  addNamedRange(s, book, body, { fail, hooks }) {
    const named = body.namedRange;
    if (!isObject(named)) fail("namedRange is required");
    const name = named.name;
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,249}$/.test(name) || parseReference(name) !== null || /^(true|false)$/i.test(name)) {
      fail(`Invalid name: ${JSON.stringify(name)}. Names must start with a letter or underscore, contain only letters, numbers and underscores, and not look like a cell reference.`);
    }
    const existing = book.namedRanges();
    if (existing.some((candidate) => candidate.name.toLowerCase() === name.toLowerCase())) fail(`A named range with the name ${name} already exists.`);
    if (existing.length >= s.limits.maxNamedRanges) {
      s.precondition(`the spreadsheet already has ${existing.length} named ranges, the supported bound`);
    }
    const { sheet } = resolveGridRange(s, book, named.range, "Invalid requests.addNamedRange");
    const range = named.range;
    const namedRangeId = named.namedRangeId ?? hooks.nextNamedRangeId();
    if (typeof namedRangeId !== "string" || !/^[a-z0-9]{12}$/.test(namedRangeId)) fail("namedRangeId must be 12 lower-case letters or digits");
    if (existing.some((candidate) => candidate.namedRangeId === namedRangeId)) fail(`A named range with id ${namedRangeId} already exists.`);
    const value = { spreadsheetId: book.id, namedRangeId, name, sheetId: sheet.sheetId };
    for (const key of ["startRowIndex", "endRowIndex", "startColumnIndex", "endColumnIndex"]) if (range[key] !== undefined) value[key] = range[key];
    existing.push(value);
    return { addNamedRange: { namedRange: namedRangeResource(value) } };
  },

  deleteNamedRange(s, book, body, { fail }) {
    if (typeof body.namedRangeId !== "string") fail("namedRangeId is required");
    const existing = book.namedRanges();
    const index = existing.findIndex((candidate) => candidate.namedRangeId === body.namedRangeId);
    if (index < 0) s.notFound(`No named range with id ${body.namedRangeId}.`);
    existing.splice(index, 1);
    return {};
  },
};
