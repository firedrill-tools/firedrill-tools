// A1 notation: column letters, sheet-name quoting, range parsing and Google-style printing. Pure functions.
//
// A parsed reference is `{ startRow, endRow, startColumn, endColumn }` with 0-based indices, exclusive ends, and
// `undefined` for an open side (`A:A` has no rows, `A2:C` has no end row). Resolution against a sheet's grid happens in
// `resolveGrid`, which reports Google's "exceeds grid limits" text for explicit bounds outside the sheet.

export class RangeError_ extends Error {
  constructor(message) {
    super(message);
    this.name = "A1RangeError";
  }
}

export const MAX_COLUMN_INDEX = 18_277; // ZZZ
const UNQUOTED_SHEET = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CELL_LIKE = /^[A-Za-z]{1,3}[0-9]+$/;
const R1C1_LIKE = /^[Rr][0-9]*[Cc][0-9]*$/;

export function columnToIndex(letters) {
  let index = 0;
  for (const character of letters.toUpperCase()) index = index * 26 + (character.charCodeAt(0) - 64);
  return index - 1;
}

export function indexToColumn(index) {
  let n = index + 1;
  let text = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    text = String.fromCharCode(65 + remainder) + text;
    n = Math.floor((n - 1) / 26);
  }
  return text;
}

/** Sheet names are quoted when they are not plain identifiers or when they could be read as a cell or R1C1 reference. */
export function quoteSheetName(title) {
  if (UNQUOTED_SHEET.test(title) && !CELL_LIKE.test(title) && !R1C1_LIKE.test(title) && !/^(TRUE|FALSE)$/i.test(title)) {
    return title;
  }
  return `'${title.replaceAll("'", "''")}'`;
}

export function cellA1(row, column) {
  return `${indexToColumn(column)}${row + 1}`;
}

/** `Sheet1!A1:B2`, or `Sheet1!A1` for a single cell. Every bound must be concrete. */
export function formatRange(title, grid) {
  const start = cellA1(grid.startRow, grid.startColumn);
  const end = cellA1(grid.endRow - 1, grid.endColumn - 1);
  const sheet = quoteSheetName(title);
  return grid.endRow - grid.startRow === 1 && grid.endColumn - grid.startColumn === 1 ? `${sheet}!${start}` : `${sheet}!${start}:${end}`;
}

/** Splits `'Q3 Budget'!A1:B2` into `{ sheetName, reference }`; either may be undefined. Throws on malformed quoting. */
export function splitRange(text) {
  if (typeof text !== "string") throw new RangeError_("range must be a string");
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 1024) throw new RangeError_("empty range");
  if (trimmed.startsWith("'")) {
    let index = 1;
    let name = "";
    for (;;) {
      if (index >= trimmed.length) throw new RangeError_("unterminated quote");
      const character = trimmed[index];
      if (character === "'") {
        if (trimmed[index + 1] === "'") {
          name += "'";
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      name += character;
      index += 1;
    }
    if (name.length === 0) throw new RangeError_("empty sheet name");
    if (index === trimmed.length) return { sheetName: name, reference: undefined };
    if (trimmed[index] !== "!") throw new RangeError_("expected ! after a quoted sheet name");
    const reference = trimmed.slice(index + 1);
    if (reference.length === 0 || reference.includes("!")) throw new RangeError_("malformed reference");
    return { sheetName: name, reference };
  }
  const parts = trimmed.split("!");
  if (parts.length > 2) throw new RangeError_("more than one !");
  if (parts.length === 2) {
    if (parts[0].length === 0 || parts[1].length === 0) throw new RangeError_("malformed reference");
    if (parts[0].includes("'")) throw new RangeError_("malformed quoting");
    return { sheetName: parts[0], reference: parts[1] };
  }
  return { sheetName: undefined, reference: trimmed };
}

const PART = /^(\$?([A-Za-z]{1,3}))?(\$?([0-9]{1,7}))?$/;

function parsePart(text) {
  const match = PART.exec(text);
  if (match === null || (match[2] === undefined && match[4] === undefined)) return null;
  const column = match[2] === undefined ? undefined : columnToIndex(match[2]);
  const rowNumber = match[4] === undefined ? undefined : Number.parseInt(match[4], 10);
  if (rowNumber !== undefined && rowNumber < 1) return null;
  if (column !== undefined && column > MAX_COLUMN_INDEX) return null;
  return { column, row: rowNumber === undefined ? undefined : rowNumber - 1 };
}

/** Parses the part after `!`: `A1`, `A1:B2`, `A:C`, `1:3`, `A2:C`, `A:C5`. Returns null when it is not an A1 reference. */
export function parseReference(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const pieces = text.split(":");
  if (pieces.length === 1) {
    const part = parsePart(pieces[0]);
    if (part === null || part.column === undefined || part.row === undefined) return null;
    return { startRow: part.row, endRow: part.row + 1, startColumn: part.column, endColumn: part.column + 1 };
  }
  if (pieces.length !== 2) return null;
  const a = parsePart(pieces[0]);
  const b = parsePart(pieces[1]);
  if (a === null || b === null) return null;
  const hasCol = (p) => p.column !== undefined;
  const hasRow = (p) => p.row !== undefined;
  // Whole rows (`1:3`) need rows on both sides; whole columns (`A:C`) need columns on both sides.
  if (!hasCol(a) && !hasCol(b)) {
    return { startRow: Math.min(a.row, b.row), endRow: Math.max(a.row, b.row) + 1, startColumn: undefined, endColumn: undefined };
  }
  if (!hasCol(a) || !hasCol(b)) return null;
  const startColumn = Math.min(a.column, b.column);
  const endColumn = Math.max(a.column, b.column) + 1;
  if (hasRow(a) && hasRow(b)) {
    return { startRow: Math.min(a.row, b.row), endRow: Math.max(a.row, b.row) + 1, startColumn, endColumn };
  }
  if (hasRow(a)) return { startRow: a.row, endRow: undefined, startColumn, endColumn };
  if (hasRow(b)) return { startRow: undefined, endRow: b.row + 1, startColumn, endColumn };
  return { startRow: undefined, endRow: undefined, startColumn, endColumn };
}

export function gridLimitMessage(title, reference, sheet) {
  return `Range (${quoteSheetName(title)}!${reference}) exceeds grid limits. Max rows: ${sheet.rowCount}, max columns: ${sheet.columnCount}`;
}

/**
 * Resolves a parsed reference against a sheet grid. Returns concrete `{startRow,endRow,startColumn,endColumn}` or
 * `{ error }` with Google's grid-limit message when an explicit bound lies outside the sheet.
 */
export function resolveGrid(reference, sheet, title, referenceText) {
  const startRow = reference.startRow ?? 0;
  const startColumn = reference.startColumn ?? 0;
  const endRow = reference.endRow ?? sheet.rowCount;
  const endColumn = reference.endColumn ?? sheet.columnCount;
  if (startRow >= sheet.rowCount || startColumn >= sheet.columnCount || endRow > sheet.rowCount || endColumn > sheet.columnCount) {
    return { error: gridLimitMessage(title, referenceText, sheet) };
  }
  return { startRow, endRow, startColumn, endColumn };
}
