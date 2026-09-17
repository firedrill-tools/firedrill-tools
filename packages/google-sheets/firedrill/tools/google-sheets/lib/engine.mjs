// The spreadsheet model shared by every handler: bounded loading of one spreadsheet's sheets, cell rows and named ranges
// (a "book"), a diff-based flush, the formula evaluator, value rendering, range resolution, grid data, and the
// structural engine (insert/delete rows and columns with formula and named-range adjustment).
//
// Nothing here keeps state between invocations; a book lives for one handler call. `s` is the handler session
// (`context`, `limits`, `nowSerial`, and the `invalid`/`precondition` failure helpers).

import { formatRange, indexToColumn, parseReference, quoteSheetName, resolveGrid, splitRange } from "./a1.mjs";
import { EvaluationBoundError, ERROR_TYPES, FormulaParseError, adjustFormula, evaluateFormula, isError, makeError, parseFormula } from "./formula.mjs";
import { formatValue, isDateType, NUMBER_FORMAT_TYPES } from "./format.mjs";
import { cellRowId, cellRowPrefix, namedRangeRowId, pad7, sheetRowId, spreadsheetUrlFor, stableJson } from "./ids.mjs";
import { project } from "./fields.mjs";
import { jsonBytes } from "./size.mjs";

const NO_BUDGET = { add() {} };

export const SCAN_STEP = 1000;
export const MAX_MUTATIONS = 9000;
export const MAX_INSERT = 5000;
/** Dependency levels one read may resolve (the visit budget of 20,000 is reached first in practice). */
export const MAX_DEPTH = 10_000;
/** Uncached formula cells one evaluation may recurse through before the driver takes over (see makeEvaluator). */
export const RECURSION_BUDGET = 16;

/** Thrown by the evaluator to suspend an evaluation until the named formula cell has been memoised. */
class Demand {
  constructor(sheetId, row, column) {
    this.sheetId = sheetId;
    this.row = row;
    this.column = column;
  }
}

/** Scans every row whose id starts with `prefix`; fails FAILED_PRECONDITION past `limits.maxScanRows` (never truncates). */
export function scanPrefix(s, namespace, prefix) {
  const rows = [];
  let after = prefix;
  for (;;) {
    const batch = s.context.state.scan(namespace, after.length === 0 ? { limit: SCAN_STEP } : { afterRowId: after, limit: SCAN_STEP });
    if (batch.length === 0) return rows;
    for (const row of batch) {
      if (!row.rowId.startsWith(prefix)) return rows;
      rows.push(row);
      if (rows.length > s.limits.maxScanRows) {
        s.precondition(`state exceeds the supported bound of ${s.limits.maxScanRows} rows for a single read`);
      }
    }
    if (batch.length < SCAN_STEP) return rows;
    after = batch[batch.length - 1].rowId;
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isEmptyCell(cell) {
  return cell.value === undefined && (cell.format === undefined || Object.keys(cell.format).length === 0) && cell.note === undefined;
}

export function normalizeCells(cells) {
  return cells
    .filter((cell) => !isEmptyCell(cell))
    .map((cell) => {
      const out = { columnIndex: cell.columnIndex };
      if (cell.value !== undefined) out.value = cell.value;
      if (cell.format !== undefined && Object.keys(cell.format).length > 0) out.format = cell.format;
      if (cell.note !== undefined) out.note = cell.note;
      return out;
    })
    .sort((a, b) => a.columnIndex - b.columnIndex);
}

export function cellAt(cells, column) {
  if (cells === null || cells === undefined) return undefined;
  for (const cell of cells) {
    if (cell.columnIndex === column) return cell;
    if (cell.columnIndex > column) return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Book
// ---------------------------------------------------------------------------------------------

export class Book {
  constructor(s, spreadsheet, { fresh = false } = {}) {
    this.s = s;
    this.spreadsheet = clone(spreadsheet);
    this.originalSpreadsheet = fresh ? null : stableJson(spreadsheet);
    const sheetRows = fresh ? [] : scanPrefix(s, "sheets", `${spreadsheet.spreadsheetId}:`);
    this.sheets = sheetRows.map((row) => clone(row.value)).sort((a, b) => a.index - b.index);
    this.originalSheets = new Map(sheetRows.map((row) => [row.value.sheetId, stableJson(row.value)]));
    this.full = new Map();
    this.originalRows = new Map();
    this.points = new Map();
    this.rangeCache = new Map();
    this.named = fresh ? [] : null;
    this.originalNamed = new Map();
    this.fresh = fresh;
  }

  get id() {
    return this.spreadsheet.spreadsheetId;
  }

  sheetById(sheetId) {
    return this.sheets.find((sheet) => sheet.sheetId === sheetId) ?? null;
  }

  sheetByTitle(title) {
    const lower = String(title).toLowerCase();
    return this.sheets.find((sheet) => sheet.title.toLowerCase() === lower) ?? null;
  }

  firstSheet() {
    return this.sheets[0] ?? null;
  }

  reindex() {
    this.sheets.forEach((sheet, index) => {
      sheet.index = index;
    });
  }

  /** Loads every stored row of a sheet into memory (bounded). */
  rowsOf(sheetId) {
    if (!this.full.has(sheetId)) {
      const map = new Map();
      const original = new Map();
      if (!this.fresh) {
        for (const row of scanPrefix(this.s, "rows", cellRowPrefix(this.id, sheetId))) {
          map.set(row.value.rowIndex, clone(row.value.cells));
          original.set(row.value.rowIndex, stableJson(row.value.cells));
        }
      }
      this.full.set(sheetId, map);
      this.originalRows.set(sheetId, original);
    }
    return this.full.get(sheetId);
  }

  /** Adopts an in-memory sheet with no stored rows (a new or copied sheet). */
  adoptEmptySheet(sheetId) {
    this.full.set(sheetId, new Map());
    this.originalRows.set(sheetId, new Map());
    return this.full.get(sheetId);
  }

  cells(sheetId, rowIndex) {
    if (this.full.has(sheetId)) return this.full.get(sheetId).get(rowIndex) ?? null;
    const key = `${sheetId}:${rowIndex}`;
    if (!this.points.has(key)) {
      const row = this.s.context.state.get("rows", cellRowId(this.id, sheetId, rowIndex));
      this.points.set(key, row === null ? null : row.cells);
    }
    return this.points.get(key);
  }

  /** Stored rows with `startRow <= rowIndex < endRow`, in order, as `[rowIndex, cells]`; bounded by maxScanRows. */
  storedRows(sheetId, startRow, endRow) {
    if (this.full.has(sheetId)) {
      return [...this.full.get(sheetId).entries()]
        .filter(([rowIndex, cells]) => rowIndex >= startRow && rowIndex < endRow && cells.length > 0)
        .sort((a, b) => a[0] - b[0]);
    }
    const key = `${sheetId}:${startRow}:${endRow}`;
    if (this.rangeCache.has(key)) return this.rangeCache.get(key);
    const prefix = cellRowPrefix(this.id, sheetId);
    const out = [];
    let after = startRow === 0 ? prefix : `${prefix}${pad7(startRow - 1)}`;
    outer: for (;;) {
      const batch = this.s.context.state.scan("rows", { afterRowId: after, limit: SCAN_STEP });
      if (batch.length === 0) break;
      for (const row of batch) {
        if (!row.rowId.startsWith(prefix) || row.value.rowIndex >= endRow) break outer;
        out.push([row.value.rowIndex, row.value.cells]);
        if (out.length > this.s.limits.maxScanRows) {
          this.s.precondition(`state exceeds the supported bound of ${this.s.limits.maxScanRows} rows for a single read`);
        }
      }
      if (batch.length < SCAN_STEP) break;
      after = batch[batch.length - 1].rowId;
    }
    this.rangeCache.set(key, out);
    return out;
  }

  namedRanges() {
    if (this.named === null) {
      const rows = scanPrefix(this.s, "named-ranges", `${this.id}:`);
      this.named = rows.map((row) => clone(row.value));
      this.originalNamed = new Map(rows.map((row) => [row.value.namedRangeId, stableJson(row.value)]));
    }
    return this.named;
  }

  loadAllSheets() {
    for (const sheet of this.sheets) this.rowsOf(sheet.sheetId);
  }

  /** Writes the difference between the loaded state and the stored rows. Fails before writing when too large. */
  flush() {
    const state = this.s.context.state;
    const ops = [];
    const id = this.id;
    const spreadsheetJson = stableJson(this.spreadsheet);
    if (spreadsheetJson !== this.originalSpreadsheet) ops.push(["put", "spreadsheets", id, this.spreadsheet]);
    const currentIds = new Set(this.sheets.map((sheet) => sheet.sheetId));
    for (const [sheetId] of this.originalSheets) {
      if (!currentIds.has(sheetId)) ops.push(["delete", "sheets", sheetRowId(id, sheetId)]);
    }
    for (const sheet of this.sheets) {
      if (this.originalSheets.get(sheet.sheetId) !== stableJson(sheet)) ops.push(["put", "sheets", sheetRowId(id, sheet.sheetId), sheet]);
    }
    for (const [sheetId, map] of this.full) {
      const original = this.originalRows.get(sheetId);
      const alive = currentIds.has(sheetId);
      const indices = new Set([...map.keys(), ...original.keys()]);
      for (const rowIndex of indices) {
        const cells = alive ? normalizeCells(map.get(rowIndex) ?? []) : [];
        const rowId = cellRowId(id, sheetId, rowIndex);
        if (cells.length === 0) {
          if (original.has(rowIndex)) ops.push(["delete", "rows", rowId]);
        } else if (original.get(rowIndex) !== stableJson(cells)) {
          ops.push(["put", "rows", rowId, { spreadsheetId: id, sheetId, rowIndex, cells }]);
        }
      }
    }
    if (this.named !== null) {
      const current = new Map(this.named.map((named) => [named.namedRangeId, named]));
      for (const [namedRangeId] of this.originalNamed) {
        if (!current.has(namedRangeId)) ops.push(["delete", "named-ranges", namedRangeRowId(id, namedRangeId)]);
      }
      for (const [namedRangeId, named] of current) {
        if (this.originalNamed.get(namedRangeId) !== stableJson(named)) ops.push(["put", "named-ranges", namedRangeRowId(id, namedRangeId), named]);
      }
    }
    if (ops.length > MAX_MUTATIONS) {
      this.s.precondition(`the change would write ${ops.length} rows, over the supported bound of ${MAX_MUTATIONS} row writes per request`);
    }
    for (const op of ops) {
      if (op[0] === "put") state.put(op[1], op[2], op[3]);
      else state.delete(op[1], op[2]);
    }
    return ops.length;
  }
}

/** Sets (or clears, with `undefined`) parts of one cell in a fully loaded sheet. */
export function patchCell(book, sheetId, row, column, patch) {
  const rows = book.rowsOf(sheetId);
  const cells = rows.get(row) ?? [];
  let cell = cells.find((candidate) => candidate.columnIndex === column);
  if (cell === undefined) {
    cell = { columnIndex: column };
    cells.push(cell);
    cells.sort((a, b) => a.columnIndex - b.columnIndex);
  }
  if ("value" in patch) {
    if (patch.value === null || patch.value === undefined) delete cell.value;
    else cell.value = patch.value;
  }
  if ("format" in patch) {
    if (patch.format === null || patch.format === undefined || Object.keys(patch.format).length === 0) delete cell.format;
    else cell.format = patch.format;
  }
  rows.set(row, normalizeCells(cells));
  if (rows.get(row).length === 0) rows.delete(row);
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

export function sheetView(sheet) {
  return { sheetId: sheet.sheetId, title: sheet.title, rowCount: sheet.rowCount, columnCount: sheet.columnCount };
}

export function namedRangeGrid(named, sheet) {
  return {
    sheetId: named.sheetId,
    startRow: named.startRowIndex ?? 0,
    endRow: named.endRowIndex ?? sheet.rowCount,
    startColumn: named.startColumnIndex ?? 0,
    endColumn: named.endColumnIndex ?? sheet.columnCount,
  };
}

/**
 * A per-call evaluator: memoised, cycle-detecting, and bounded by `maxEvaluationVisits` cell evaluations and `MAX_DEPTH`
 * dependency levels. The dependency walk never recurses on the caller's chain: one formula recurses into at most
 * `RECURSION_BUDGET` uncached formula cells; a deeper dependency suspends the evaluation (a `Demand` unwinds it) and the
 * driver loop in `effective` evaluates that dependency from a fresh stack, then retries the suspended cell, whose
 * dependency is now memoised. The JavaScript stack therefore stays below a constant however long a running total is.
 */
export function makeEvaluator(s, book) {
  const cache = new Map();
  const inProgress = new Set();
  const parsed = new Map();
  let visits = 0;
  let depth = 0;

  const bound = (message) => {
    throw new EvaluationBoundError(message);
  };
  const keyOf = (sheetId, row, column) => `${sheetId}:${row}:${column}`;

  function resolveName(name) {
    const lower = name.toLowerCase();
    const named = book.namedRanges().find((candidate) => candidate.name.toLowerCase() === lower);
    if (named === undefined) return null;
    const sheet = book.sheetById(named.sheetId);
    if (sheet === null) return null;
    return namedRangeGrid(named, sheet);
  }

  function literal(value) {
    if (value.kind === "string") return value.string;
    if (value.kind === "number") return value.number;
    if (value.kind === "bool") return value.bool;
    return null;
  }

  /** Charged for every literal read and every formula evaluation attempt (memoised results are free). */
  function charge() {
    visits += 1;
    if (visits > s.limits.maxEvaluationVisits) {
      bound(`formula evaluation exceeds the supported bound of ${s.limits.maxEvaluationVisits} cell visits for a single read`);
    }
  }

  function inner(sheetId, row, column) {
    const sheet = book.sheetById(sheetId);
    if (sheet === null || row >= sheet.rowCount || column >= sheet.columnCount) return null;
    const cell = cellAt(book.cells(sheetId, row), column);
    if (cell === undefined || cell.value === undefined) return null;
    if (cell.value.kind !== "formula") {
      charge();
      return literal(cell.value);
    }
    const key = keyOf(sheetId, row, column);
    if (cache.has(key)) return cache.get(key);
    if (inProgress.has(key)) {
      return makeError("#REF!", "Circular dependency detected. To resolve with iterative calculation, see File > Settings.");
    }
    // Too deep to recurse further: hand the dependency to the driver instead of growing the stack.
    if (depth >= RECURSION_BUDGET) throw new Demand(sheetId, row, column);
    charge();
    depth += 1;
    inProgress.add(key);
    let result;
    try {
      let tree = parsed.get(cell.value.formula);
      if (tree === undefined) {
        try {
          tree = parseFormula(cell.value.formula);
        } catch (error) {
          if (!(error instanceof FormulaParseError)) throw error;
          tree = null;
        }
        parsed.set(cell.value.formula, tree);
      }
      if (tree === null) result = makeError("#ERROR!", "Formula parse error.");
      else {
        result = evaluateFormula(tree, {
          ownSheet: sheetView(sheet),
          resolveSheet: (name) => {
            const target = book.sheetByTitle(name);
            return target === null ? null : sheetView(target);
          },
          resolveName,
          cell: effective,
          storedCells,
          nowSerial: s.nowSerial,
        });
        if (result !== null && typeof result === "object" && !isError(result)) result = makeError("#VALUE!", "An array value could not be found.");
      }
    } finally {
      inProgress.delete(key);
      depth -= 1;
    }
    cache.set(key, result);
    return result;
  }

  /**
   * Effective value of one cell. Inside an evaluation this is the recursive path; at the top level it is the driver:
   * an explicit stack of suspended cells, each waiting for the dependency named by the `Demand` that unwound it.
   */
  function effective(sheetId, row, column) {
    if (depth > 0) return inner(sheetId, row, column);
    const suspended = [];
    let target = { sheetId, row, column };
    for (;;) {
      let value;
      try {
        value = inner(target.sheetId, target.row, target.column);
      } catch (error) {
        if (!(error instanceof Demand)) throw error;
        if (suspended.length >= MAX_DEPTH) bound(`formula evaluation exceeds the supported dependency depth of ${MAX_DEPTH} formula cells for a single read`);
        suspended.push(target);
        // A suspended cell counts as in progress, so a dependency that leads back to it is a circular reference.
        inProgress.add(keyOf(target.sheetId, target.row, target.column));
        target = error;
        continue;
      }
      if (suspended.length === 0) return value;
      target = suspended.pop();
      inProgress.delete(keyOf(target.sheetId, target.row, target.column));
    }
  }

  function storedCells(sheetId, startRow, endRow, startColumn, endColumn) {
    const out = [];
    for (const [rowIndex, cells] of book.storedRows(sheetId, startRow, endRow)) {
      for (const cell of cells) {
        if (cell.columnIndex < startColumn || cell.columnIndex >= endColumn || cell.value === undefined) continue;
        const value = effective(sheetId, rowIndex, cell.columnIndex);
        if (value !== null) out.push({ row: rowIndex, column: cell.columnIndex, value });
      }
    }
    return out;
  }

  return { effective, storedCells };
}

/** Runs a read and converts evaluation bounds into FAILED_PRECONDITION. */
export function guardEvaluation(s, run) {
  try {
    return run();
  } catch (error) {
    if (error instanceof EvaluationBoundError) s.precondition(error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

export const RENDER_OPTIONS = ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"];
export const DATE_TIME_OPTIONS = ["SERIAL_NUMBER", "FORMATTED_STRING"];

/** One `values` entry: string/number/boolean for the requested render options; "" for empty. */
export function renderCell(value, cell, renderOption, dateTimeOption) {
  const numberFormat = cell?.format?.numberFormat;
  if (renderOption === "FORMULA" && cell?.value?.kind === "formula") return cell.value.formula;
  if (value === null) return "";
  if (renderOption === "FORMATTED_VALUE") return formatValue(value, numberFormat);
  if (isError(value)) return value.error;
  if (typeof value === "number" && isDateType(numberFormat) && dateTimeOption === "FORMATTED_STRING") {
    return formatValue(value, numberFormat);
  }
  return value;
}

export function extendedValue(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return { numberValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "string") return { stringValue: value };
  return { errorValue: { type: ERROR_TYPES[value.error] ?? "ERROR", message: value.message } };
}

export function userEnteredValue(stored) {
  if (stored === undefined) return undefined;
  if (stored.kind === "string") return { stringValue: stored.string };
  if (stored.kind === "number") return { numberValue: stored.number };
  if (stored.kind === "bool") return { boolValue: stored.bool };
  return { formulaValue: stored.formula };
}

function hexToColor(hex) {
  const channel = (offset) => Math.round((Number.parseInt(hex.slice(offset, offset + 2), 16) / 255) * 10000) / 10000;
  const color = {};
  const red = channel(1);
  const green = channel(3);
  const blue = channel(5);
  if (red !== 0) color.red = red;
  if (green !== 0) color.green = green;
  if (blue !== 0) color.blue = blue;
  return color;
}

export function colorToHex(color) {
  if (color === null || typeof color !== "object" || Array.isArray(color)) return undefined;
  const parts = ["red", "green", "blue"].map((name) => {
    const value = color[name] ?? 0;
    if (typeof value !== "number" || value < 0 || value > 1) return undefined;
    return Math.round(value * 255).toString(16).padStart(2, "0");
  });
  if (parts.includes(undefined)) return undefined;
  return `#${parts.join("")}`;
}

/** Storage format → Sheets `CellFormat`. */
export function cellFormatResource(format) {
  if (format === undefined) return undefined;
  const out = {};
  if (format.numberFormat !== undefined) out.numberFormat = { ...format.numberFormat };
  if (format.backgroundColorRgb !== undefined) {
    out.backgroundColor = hexToColor(format.backgroundColorRgb);
    out.backgroundColorStyle = { rgbColor: hexToColor(format.backgroundColorRgb) };
  }
  if (format.horizontalAlignment !== undefined) out.horizontalAlignment = format.horizontalAlignment;
  if (format.wrapStrategy !== undefined) out.wrapStrategy = format.wrapStrategy;
  const text = {};
  if (format.foregroundColorRgb !== undefined) {
    text.foregroundColor = hexToColor(format.foregroundColorRgb);
    text.foregroundColorStyle = { rgbColor: hexToColor(format.foregroundColorRgb) };
  }
  for (const key of ["fontSize", "bold", "italic", "strikethrough", "underline"]) if (format[key] !== undefined) text[key] = format[key];
  if (Object.keys(text).length > 0) out.textFormat = text;
  return out;
}

/** Sheets `CellData` for one position. */
export function cellData(evaluator, sheetId, row, column, cell) {
  if (cell === undefined) return {};
  const out = {};
  if (cell.value !== undefined) {
    const value = evaluator.effective(sheetId, row, column);
    out.userEnteredValue = userEnteredValue(cell.value);
    const effective = extendedValue(value);
    if (effective !== undefined) out.effectiveValue = effective;
    out.formattedValue = renderCell(value, cell, "FORMATTED_VALUE");
  }
  if (cell.format !== undefined) out.userEnteredFormat = cellFormatResource(cell.format);
  if (cell.note !== undefined) out.note = cell.note;
  return out;
}

export function sheetProperties(sheet) {
  const gridProperties = { rowCount: sheet.rowCount, columnCount: sheet.columnCount };
  if (sheet.frozenRowCount > 0) gridProperties.frozenRowCount = sheet.frozenRowCount;
  if (sheet.frozenColumnCount > 0) gridProperties.frozenColumnCount = sheet.frozenColumnCount;
  const out = { sheetId: sheet.sheetId, title: sheet.title, index: sheet.index, sheetType: "GRID", gridProperties };
  if (sheet.hidden) out.hidden = true;
  if (sheet.tabColorRgb !== undefined) {
    out.tabColor = hexToColor(sheet.tabColorRgb);
    out.tabColorStyle = { rgbColor: hexToColor(sheet.tabColorRgb) };
  }
  return out;
}

export function namedRangeResource(named) {
  const range = { sheetId: named.sheetId };
  for (const key of ["startRowIndex", "endRowIndex", "startColumnIndex", "endColumnIndex"]) if (named[key] !== undefined) range[key] = named[key];
  return { namedRangeId: named.namedRangeId, name: named.name, range };
}

export function spreadsheetProperties(spreadsheet) {
  return {
    title: spreadsheet.title,
    locale: spreadsheet.locale,
    autoRecalc: "ON_CHANGE",
    timeZone: spreadsheet.timeZone,
  };
}

// ---------------------------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------------------------

/**
 * Resolves A1 text (or a named range) against a book. Returns `{ sheet, grid, bounded: { rows, columns }, single }`,
 * where `bounded` says whether the caller wrote an explicit end in each dimension and `single` a single-cell reference.
 */
export function resolveRange(s, book, text, label = "range") {
  const unparsable = () => s.invalid(`Unable to parse ${label}: ${text}`);
  let split;
  try {
    split = splitRange(text);
  } catch {
    unparsable();
  }
  let sheet;
  let reference;
  let referenceText = split.reference;
  if (split.sheetName !== undefined) {
    sheet = book.sheetByTitle(split.sheetName);
    if (sheet === null) unparsable();
    if (split.reference !== undefined) {
      reference = parseReference(split.reference);
      if (reference === null) unparsable();
    }
  } else {
    reference = parseReference(split.reference);
    if (reference !== null) sheet = book.firstSheet();
    else {
      sheet = book.sheetByTitle(split.reference);
      if (sheet === null) {
        const lower = split.reference.toLowerCase();
        const named = book.namedRanges().find((candidate) => candidate.name.toLowerCase() === lower);
        if (named === undefined) unparsable();
        sheet = book.sheetById(named.sheetId);
        if (sheet === null) unparsable();
        const grid = namedRangeGrid(named, sheet);
        return { sheet, grid, bounded: { rows: true, columns: true }, single: false };
      }
      reference = undefined;
    }
  }
  if (reference === undefined) {
    reference = { startRow: undefined, endRow: undefined, startColumn: undefined, endColumn: undefined };
    referenceText = undefined;
  }
  const grid = resolveGrid(reference, sheet, sheet.title, referenceText ?? "");
  if (grid.error !== undefined) s.invalid(grid.error);
  const single = reference.endRow !== undefined && reference.endRow - (reference.startRow ?? 0) === 1 && reference.endColumn !== undefined &&
    reference.endColumn - (reference.startColumn ?? 0) === 1 && reference.startRow !== undefined && reference.startColumn !== undefined;
  return {
    sheet,
    grid,
    bounded: { rows: reference.endRow !== undefined, columns: reference.endColumn !== undefined },
    single,
  };
}

/** A `GridRange` from a batch request; open sides resolve to the sheet's grid. */
export function resolveGridRange(s, book, range, prefix) {
  if (range === null || typeof range !== "object" || Array.isArray(range)) s.invalid(`${prefix}: range is required`);
  const sheetId = range.sheetId ?? 0;
  const sheet = Number.isInteger(sheetId) ? book.sheetById(sheetId) : null;
  if (sheet === null) s.invalid(`${prefix}: No grid with id: ${sheetId}`);
  const bound = (key, fallback, max) => {
    const value = range[key];
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 0 || value > max) s.invalid(`${prefix}: ${key} ${value} is outside the grid (max ${max})`);
    return value;
  };
  const grid = {
    startRow: bound("startRowIndex", 0, sheet.rowCount),
    endRow: bound("endRowIndex", sheet.rowCount, sheet.rowCount),
    startColumn: bound("startColumnIndex", 0, sheet.columnCount),
    endColumn: bound("endColumnIndex", sheet.columnCount, sheet.columnCount),
  };
  if (grid.endRow < grid.startRow || grid.endColumn < grid.startColumn) s.invalid(`${prefix}: start index must be less than or equal to end index`);
  return { sheet, grid };
}

/**
 * Values of a resolved range as a `ValueRange`. Trailing empty rows/cells are trimmed; an empty range has no `values`.
 * `budget` (see size.mjs) is charged the encoded bytes of every value and padding cell as the matrix is built.
 */
export function readValueRange(book, evaluator, target, majorDimension, renderOption, dateTimeOption, budget = NO_BUDGET) {
  const { sheet, grid } = target;
  const matrix = new Map();
  for (const [rowIndex, cells] of book.storedRows(sheet.sheetId, grid.startRow, grid.endRow)) {
    for (const cell of cells) {
      if (cell.columnIndex < grid.startColumn || cell.columnIndex >= grid.endColumn || cell.value === undefined) continue;
      const rendered = renderCell(evaluator.effective(sheet.sheetId, rowIndex, cell.columnIndex), cell, renderOption, dateTimeOption);
      if (rendered === "") continue;
      budget.add(jsonBytes(rendered) + 1);
      matrix.set(`${rowIndex - grid.startRow}:${cell.columnIndex - grid.startColumn}`, rendered);
    }
  }
  const out = { range: formatRange(sheet.title, grid), majorDimension };
  if (matrix.size === 0) return out;
  const lines = [];
  for (const [key, rendered] of matrix) {
    const [r, c] = key.split(":").map(Number);
    const [outer, inner] = majorDimension === "COLUMNS" ? [c, r] : [r, c];
    while (lines.length <= outer) {
      budget.add(3);
      lines.push([]);
    }
    const line = lines[outer];
    while (line.length < inner) {
      budget.add(3);
      line.push("");
    }
    line[inner] = rendered;
  }
  out.values = lines;
  return out;
}

/**
 * Grid data (`sheets[].data[]`) for one sheet window. `budget` is charged the bytes of the shape actually sent: `mask` is
 * the caller's `fields` sub-selection for one `GridData` (`null` = whole, `false` = not sent, or a parsed Map), and each
 * row and cell is charged as that mask projects it. `work` is charged the unmasked bytes, bounding what one request can
 * materialise even when the mask sends little of it.
 */
export function gridData(book, evaluator, sheet, grid, budget = NO_BUDGET, mask = null, work = NO_BUDGET) {
  const rowsMask = mask === null ? null : mask === false || !mask.has("rowData") ? false : mask.get("rowData");
  const cellsMask = rowsMask === null ? null : rowsMask === false || !rowsMask.has("values") ? false : rowsMask.get("values");
  const stored = book.storedRows(sheet.sheetId, grid.startRow, grid.endRow);
  let lastRow = -1;
  for (const [rowIndex, cells] of stored) {
    if (cells.some((cell) => cell.columnIndex >= grid.startColumn && cell.columnIndex < grid.endColumn)) lastRow = rowIndex;
  }
  const rowData = [];
  const byIndex = new Map(stored);
  for (let rowIndex = grid.startRow; rowIndex <= lastRow; rowIndex += 1) {
    const cells = byIndex.get(rowIndex) ?? [];
    const inWindow = cells.filter((cell) => cell.columnIndex >= grid.startColumn && cell.columnIndex < grid.endColumn);
    work.add(3);
    if (rowsMask !== false) budget.add(3);
    if (inWindow.length === 0) {
      rowData.push({});
      continue;
    }
    const last = inWindow[inWindow.length - 1].columnIndex;
    const values = [];
    for (let column = grid.startColumn; column <= last; column += 1) {
      const data = cellData(evaluator, sheet.sheetId, rowIndex, column, cellAt(cells, column));
      const bytes = jsonBytes(data) + 1;
      work.add(bytes);
      if (cellsMask !== false) budget.add(cellsMask === null ? bytes : jsonBytes(project(data, cellsMask)) + 1);
      values.push(data);
    }
    rowData.push({ values });
  }
  const out = {};
  if (grid.startRow > 0) out.startRow = grid.startRow;
  if (grid.startColumn > 0) out.startColumn = grid.startColumn;
  out.rowData = rowData;
  return out;
}

/** The used window of a sheet: from A1 to the last stored row/column. */
export function usedGrid(book, sheet) {
  let endRow = 0;
  let endColumn = 0;
  for (const [rowIndex, cells] of book.storedRows(sheet.sheetId, 0, sheet.rowCount)) {
    endRow = Math.max(endRow, rowIndex + 1);
    for (const cell of cells) endColumn = Math.max(endColumn, cell.columnIndex + 1);
  }
  return { startRow: 0, endRow, startColumn: 0, endColumn };
}

/** A Sheets `Spreadsheet` resource, optionally with grid data for `ranges` or every sheet's used window. */
export function spreadsheetResource(s, book, { includeGridData = false, ranges, budget = NO_BUDGET, dataMask = null, work = NO_BUDGET } = {}) {
  const evaluator = makeEvaluator(s, book);
  const windows = new Map();
  if (ranges !== undefined && ranges.length > 0) {
    for (const text of ranges) {
      const target = resolveRange(s, book, text);
      if (!windows.has(target.sheet.sheetId)) windows.set(target.sheet.sheetId, []);
      windows.get(target.sheet.sheetId).push(target.grid);
    }
  }
  return guardEvaluation(s, () => {
    const sheets = [];
    for (const sheet of book.sheets) {
      if (windows.size > 0 && !windows.has(sheet.sheetId)) continue;
      const entry = { properties: sheetProperties(sheet) };
      if (includeGridData) {
        const grids = windows.get(sheet.sheetId) ?? [usedGrid(book, sheet)];
        entry.data = grids.map((grid) => gridData(book, evaluator, sheet, grid, budget, dataMask, work));
      }
      sheets.push(entry);
    }
    const out = {
      spreadsheetId: book.id,
      properties: spreadsheetProperties(book.spreadsheet),
      sheets,
      spreadsheetUrl: spreadsheetUrlFor(book.id),
    };
    const named = book.namedRanges();
    if (named.length > 0) out.namedRanges = named.map(namedRangeResource);
    return out;
  });
}

// ---------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------

export function gridCells(book) {
  return book.sheets.reduce((total, sheet) => total + sheet.rowCount * sheet.columnCount, 0);
}

export function checkGridBounds(s, book) {
  for (const sheet of book.sheets) {
    if (sheet.rowCount > s.limits.maxRowCount) {
      s.precondition(`sheet ${sheet.title} would have ${sheet.rowCount} rows, over the supported bound of ${s.limits.maxRowCount} rows per sheet`);
    }
    if (sheet.columnCount > s.limits.maxColumnCount) {
      s.precondition(
        `sheet ${sheet.title} would have ${sheet.columnCount} columns, over the supported bound of ${s.limits.maxColumnCount} columns per sheet`,
      );
    }
  }
  const cells = gridCells(book);
  if (cells > s.limits.maxGridCells) {
    s.precondition(`the spreadsheet would have ${cells} grid cells, over the supported bound of ${s.limits.maxGridCells} cells`);
  }
  if (book.sheets.length > s.limits.maxSheets) {
    s.precondition(`the spreadsheet would have ${book.sheets.length} sheets, over the supported bound of ${s.limits.maxSheets} sheets`);
  }
}

/** Rewrites every stored formula in the book for a structural change. */
export function adjustAllFormulas(book, change) {
  book.loadAllSheets();
  for (const sheet of book.sheets) {
    const rows = book.rowsOf(sheet.sheetId);
    for (const cells of rows.values()) {
      for (const cell of cells) {
        if (cell.value?.kind !== "formula") continue;
        const next = adjustFormula(cell.value.formula, sheet.titleBeforeChange ?? sheet.title, change);
        if (next !== cell.value.formula) cell.value = { kind: "formula", formula: next };
      }
    }
  }
}

const FORMAT_ONLY = (cell) => (cell.format === undefined ? undefined : { columnIndex: cell.columnIndex, format: clone(cell.format) });

/**
 * Inserts `count` rows or columns at `start` in a sheet. New cells copy only formats, from the neighbour before
 * (`inheritFromBefore` true) or after (false); `null` inserts plain empty cells (used by INSERT_ROWS appends).
 */
export function insertDimension(s, book, sheet, dimension, start, count, inheritFromBefore) {
  const rows = book.rowsOf(sheet.sheetId);
  if (dimension === "ROWS") {
    const shifted = new Map();
    for (const [rowIndex, cells] of rows) shifted.set(rowIndex >= start ? rowIndex + count : rowIndex, cells);
    const templateIndex = inheritFromBefore ? start - 1 : start + count;
    const template = (shifted.get(templateIndex) ?? []).map(FORMAT_ONLY).filter((cell) => cell !== undefined);
    if (inheritFromBefore !== null && template.length > 0) {
      for (let offset = 0; offset < count; offset += 1) shifted.set(start + offset, clone(template));
    }
    rows.clear();
    for (const [rowIndex, cells] of shifted) rows.set(rowIndex, cells);
    sheet.rowCount += count;
    if (start < sheet.frozenRowCount) sheet.frozenRowCount += count;
  } else {
    for (const [rowIndex, cells] of rows) {
      const next = cells.map((cell) => (cell.columnIndex >= start ? { ...cell, columnIndex: cell.columnIndex + count } : cell));
      const source = next.find((cell) => cell.columnIndex === (inheritFromBefore ? start - 1 : start + count));
      if (inheritFromBefore !== null && source?.format !== undefined) {
        for (let offset = 0; offset < count; offset += 1) next.push({ columnIndex: start + offset, format: clone(source.format) });
      }
      rows.set(rowIndex, normalizeCells(next));
    }
    sheet.columnCount += count;
    if (start < sheet.frozenColumnCount) sheet.frozenColumnCount += count;
  }
  adjustAllFormulas(book, { kind: "insert", dimension, sheetTitle: sheet.title, start, count });
  for (const named of book.namedRanges()) {
    if (named.sheetId !== sheet.sheetId) continue;
    const [startKey, endKey] = dimension === "ROWS" ? ["startRowIndex", "endRowIndex"] : ["startColumnIndex", "endColumnIndex"];
    if (named[startKey] !== undefined && named[startKey] >= start) named[startKey] += count;
    if (named[endKey] !== undefined && named[endKey] > start) named[endKey] += count;
  }
  checkGridBounds(s, book);
}

/** Deletes rows or columns `[start, end)` from a sheet. */
export function deleteDimension(s, book, sheet, dimension, start, end) {
  const count = end - start;
  const rows = book.rowsOf(sheet.sheetId);
  if (dimension === "ROWS") {
    const shifted = new Map();
    for (const [rowIndex, cells] of rows) {
      if (rowIndex >= start && rowIndex < end) continue;
      shifted.set(rowIndex >= end ? rowIndex - count : rowIndex, cells);
    }
    rows.clear();
    for (const [rowIndex, cells] of shifted) rows.set(rowIndex, cells);
    sheet.rowCount -= count;
    if (sheet.frozenRowCount > start) sheet.frozenRowCount -= Math.min(count, sheet.frozenRowCount - start);
    if (sheet.frozenRowCount >= sheet.rowCount) sheet.frozenRowCount = 0;
  } else {
    for (const [rowIndex, cells] of rows) {
      const next = cells
        .filter((cell) => cell.columnIndex < start || cell.columnIndex >= end)
        .map((cell) => (cell.columnIndex >= end ? { ...cell, columnIndex: cell.columnIndex - count } : cell));
      if (next.length === 0) rows.delete(rowIndex);
      else rows.set(rowIndex, next);
    }
    sheet.columnCount -= count;
    if (sheet.frozenColumnCount > start) sheet.frozenColumnCount -= Math.min(count, sheet.frozenColumnCount - start);
    if (sheet.frozenColumnCount >= sheet.columnCount) sheet.frozenColumnCount = 0;
  }
  adjustAllFormulas(book, { kind: "delete", dimension, sheetTitle: sheet.title, start, count });
  const [startKey, endKey] = dimension === "ROWS" ? ["startRowIndex", "endRowIndex"] : ["startColumnIndex", "endColumnIndex"];
  const kept = [];
  for (const named of book.namedRanges()) {
    if (named.sheetId === sheet.sheetId) {
      const a = named[startKey] ?? 0;
      const b = named[endKey];
      const newStart = a < start ? a : a >= end ? a - count : start;
      let newEnd;
      if (b !== undefined) newEnd = b <= start ? b : b >= end ? b - count : start;
      if (newEnd !== undefined && newEnd <= newStart) continue;
      if (named[startKey] !== undefined) named[startKey] = newStart;
      if (b !== undefined) named[endKey] = newEnd;
    }
    kept.push(named);
  }
  book.named = kept;
}

/** Renames a sheet and re-qualifies every formula that names it. */
export function renameSheet(book, sheet, title) {
  const from = sheet.title;
  if (from === title) return;
  book.loadAllSheets();
  adjustAllFormulas(book, { kind: "rename", from, to: title });
  sheet.title = title;
}

export function isValidSheetTitle(title) {
  return typeof title === "string" && title.length >= 1 && title.length <= 100 && !/[ -]/.test(title);
}

export function uniqueTitle(book, base) {
  if (book.sheetByTitle(base) === null) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (book.sheetByTitle(candidate) === null) return candidate;
  }
}

export { NUMBER_FORMAT_TYPES, formatRange, indexToColumn, quoteSheetName };
