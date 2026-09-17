// The stored block model, its flat index map and the Docs `Document` resource rendering.
//
// Stored model (see the `bodies` state schema):
//   blocks[0]           = { kind: "sectionBreak" }                      -- always present, occupies index 0 -> 1
//   { kind: "paragraph", style, bullet?, elements: [Element] }          -- occupies sum(elements) + 1 (the newline)
//   { kind: "table", rows, columns, cells: [[{ blocks: [paragraph] }]] }
//   Element = { type: "textRun", text, style } | { type: "pageBreak" }
//
// Index arithmetic follows the published "Structure of a Google Docs document" guide: text runs are measured in UTF-16
// code units (so an astral character counts 2), every paragraph owns a trailing newline, and a table occupies one unit
// for the table start, one per row, one per cell, the cell content, and one trailing newline. It is a faithful model of
// the documented structure, not a measurement of a live Google document.

export const NAMED_STYLE_TYPES = [
  "NORMAL_TEXT",
  "TITLE",
  "SUBTITLE",
  "HEADING_1",
  "HEADING_2",
  "HEADING_3",
  "HEADING_4",
  "HEADING_5",
  "HEADING_6",
];
export const ALIGNMENTS = ["START", "CENTER", "END", "JUSTIFIED"];
export const BASELINE_OFFSETS = ["NONE", "SUPERSCRIPT", "SUBSCRIPT"];
export const TEXT_STYLE_FIELDS = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "smallCaps",
  "baselineOffset",
  "fontSize",
  "weightedFontFamily",
  "foregroundColor",
  "backgroundColor",
  "link",
];
export const PARAGRAPH_STYLE_FIELDS = [
  "namedStyleType",
  "alignment",
  "indentStart",
  "indentFirstLine",
  "spaceAbove",
  "spaceBelow",
  "lineSpacing",
];
export const BULLET_PRESETS = [
  "BULLET_DISC_CIRCLE_SQUARE",
  "BULLET_DIAMONDX_ARROW3D_SQUARE",
  "BULLET_CHECKBOX",
  "BULLET_ARROW_DIAMOND_DISC",
  "BULLET_STAR_CIRCLE_SQUARE",
  "BULLET_ARROW3D_CIRCLE_SQUARE",
  "BULLET_LEFTTRIANGLE_DIAMOND_DISC",
  "BULLET_DIAMONDX_HOLLOWDIAMOND_SQUARE",
  "BULLET_DIAMOND_CIRCLE_SQUARE",
  "NUMBERED_DECIMAL_ALPHA_ROMAN",
  "NUMBERED_DECIMAL_ALPHA_ROMAN_PARENS",
  "NUMBERED_DECIMAL_NESTED",
  "NUMBERED_UPPERALPHA_ALPHA_ROMAN",
  "NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL",
  "NUMBERED_ZERODECIMAL_ALPHA_ROMAN",
  "BULLET_CHECKBOX_HOLLOW",
];

export function elementSize(element) {
  return element.type === "textRun" ? element.text.length : 1;
}

export function paragraphSize(paragraph) {
  let size = 1;
  for (const element of paragraph.elements) size += elementSize(element);
  return size;
}

export function blockSize(block) {
  if (block.kind === "sectionBreak") return 1;
  if (block.kind === "paragraph") return paragraphSize(block);
  let size = 2; // table start + trailing newline
  for (const row of block.cells) {
    size += 1;
    for (const cell of row) {
      size += 1;
      for (const paragraph of cell.blocks) size += paragraphSize(paragraph);
    }
  }
  return size;
}

export function documentSize(blocks) {
  let size = 0;
  for (const block of blocks) size += blockSize(block);
  return size;
}

export function blockCount(blocks) {
  let count = 0;
  for (const block of blocks) {
    count += 1;
    if (block.kind === "table") for (const row of block.cells) for (const cell of row) count += cell.blocks.length;
  }
  return count;
}

export function tableCount(blocks) {
  let count = 0;
  for (const block of blocks) if (block.kind === "table") count += 1;
  return count;
}

/**
 * Flat, ordered index map. Entries carry live references to the stored nodes and to the array holding them, so an
 * edit found through the map can splice its own container.
 */
export function indexMap(blocks) {
  const map = { end: 0, entries: [], paragraphs: [], tables: [] };
  map.end = walk(blocks, 0, map, null);
  return map;
}

function walk(blocks, start, map, cellRef) {
  let offset = start;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.kind === "sectionBreak") {
      map.entries.push({ type: "sectionBreak", start: offset, end: offset + 1, node: block, parent: blocks, index });
      offset += 1;
      continue;
    }
    if (block.kind === "paragraph") {
      const size = paragraphSize(block);
      const entry = { type: "paragraph", start: offset, end: offset + size, node: block, parent: blocks, index, cell: cellRef };
      map.entries.push(entry);
      map.paragraphs.push(entry);
      offset += size;
      continue;
    }
    const tableStart = offset;
    const table = { type: "table", start: tableStart, end: 0, node: block, parent: blocks, index, rows: [] };
    map.entries.push(table);
    map.tables.push(table);
    offset += 1;
    for (let r = 0; r < block.cells.length; r += 1) {
      const rowStart = offset;
      offset += 1;
      const cells = [];
      for (let c = 0; c < block.cells[r].length; c += 1) {
        const cell = block.cells[r][c];
        const cellStart = offset;
        offset += 1;
        offset = walk(cell.blocks, offset, map, { table, row: r, column: c, node: cell });
        cells.push({ start: cellStart, end: offset, node: cell, row: r, column: c });
      }
      table.rows.push({ start: rowStart, end: offset, cells });
    }
    offset += 1;
    table.end = offset;
  }
  return offset;
}

/** The paragraph that owns `index` for insertion purposes (index inside [start, end) of a paragraph). */
export function paragraphAt(map, index) {
  return map.paragraphs.find((entry) => index >= entry.start && index < entry.end) ?? null;
}

/** The table whose span contains `index`, or null. */
export function tableAt(map, index) {
  return map.tables.find((entry) => index >= entry.start && index < entry.end) ?? null;
}

export function lastParagraph(map) {
  return map.paragraphs[map.paragraphs.length - 1] ?? null;
}

/** Paragraph entries whose span intersects [start, end). */
export function paragraphsInRange(map, start, end) {
  return map.paragraphs.filter((entry) => entry.start < end && entry.end > start);
}

// ---------------------------------------------------------------------------------------------
// Text runs
// ---------------------------------------------------------------------------------------------

export function paragraphText(paragraph) {
  let text = "";
  for (const element of paragraph.elements) text += element.type === "textRun" ? element.text : "";
  return text;
}

export function cloneStyle(style) {
  return style === undefined ? {} : JSON.parse(JSON.stringify(style));
}

export function sameStyle(left, right) {
  return JSON.stringify(normalizeStyle(left)) === JSON.stringify(normalizeStyle(right));
}

function normalizeStyle(style) {
  const out = {};
  for (const key of Object.keys(style ?? {}).sort()) if (style[key] !== undefined) out[key] = style[key];
  return out;
}

/** Merges adjacent text runs carrying the same style and drops empty ones. */
export function compactElements(paragraph) {
  const out = [];
  for (const element of paragraph.elements) {
    if (element.type === "textRun") {
      if (element.text.length === 0) continue;
      const previous = out[out.length - 1];
      if (previous !== undefined && previous.type === "textRun" && sameStyle(previous.style, element.style)) {
        previous.text += element.text;
        continue;
      }
    }
    out.push(element);
  }
  paragraph.elements = out;
}

/**
 * Splits a paragraph's elements at `offset` (0-based, in UTF-16 units of its text+page-break content) and returns
 * `{ before, after }` element arrays. A split inside a text run keeps the run's style on both halves.
 */
export function splitElements(paragraph, offset) {
  const before = [];
  const after = [];
  let seen = 0;
  for (const element of paragraph.elements) {
    const size = elementSize(element);
    if (seen + size <= offset) {
      before.push(element);
    } else if (seen >= offset) {
      after.push(element);
    } else if (element.type === "textRun") {
      const cut = offset - seen;
      before.push({ type: "textRun", text: element.text.slice(0, cut), style: cloneStyle(element.style) });
      after.push({ type: "textRun", text: element.text.slice(cut), style: cloneStyle(element.style) });
    } else {
      after.push(element);
    }
    seen += size;
  }
  return { before, after };
}

/** The style a character inserted at `offset` inherits: the style of the preceding character, else of the following. */
export function styleAtOffset(paragraph, offset) {
  let seen = 0;
  let previous;
  for (const element of paragraph.elements) {
    const size = elementSize(element);
    if (element.type === "textRun") {
      if (offset > seen && offset <= seen + size) return cloneStyle(element.style);
      if (offset === seen && previous === undefined) previous = cloneStyle(element.style);
    }
    seen += size;
  }
  return previous ?? {};
}

export function newParagraph(style, elements = []) {
  return { kind: "paragraph", style: cloneStyle(style), elements };
}

export function emptyCell() {
  return { blocks: [newParagraph({ namedStyleType: "NORMAL_TEXT" })] };
}

export function newTable(rows, columns) {
  const cells = [];
  for (let r = 0; r < rows; r += 1) {
    const row = [];
    for (let c = 0; c < columns; c += 1) row.push(emptyCell());
    cells.push(row);
  }
  return { kind: "table", rows, columns, cells };
}

// ---------------------------------------------------------------------------------------------
// Named range transforms: every mutation reports its splice so ranges follow the text.
// ---------------------------------------------------------------------------------------------

export function shiftRangesForInsert(namedRanges, at, length) {
  for (const named of namedRanges) {
    for (const range of named.ranges) {
      if (range.startIndex >= at) range.startIndex += length;
      if (range.endIndex > at) range.endIndex += length;
    }
  }
  return dropEmptyRanges(namedRanges);
}

export function shiftRangesForDelete(namedRanges, start, end) {
  const length = end - start;
  const clip = (value) => (value <= start ? value : value >= end ? value - length : start);
  for (const named of namedRanges) {
    for (const range of named.ranges) {
      range.startIndex = clip(range.startIndex);
      range.endIndex = clip(range.endIndex);
    }
  }
  return dropEmptyRanges(namedRanges);
}

function dropEmptyRanges(namedRanges) {
  const out = [];
  for (const named of namedRanges) {
    const ranges = named.ranges.filter((range) => range.endIndex > range.startIndex);
    if (ranges.length > 0) out.push({ ...named, ranges });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Document resource rendering
// ---------------------------------------------------------------------------------------------

const POINTS = (magnitude) => ({ magnitude, unit: "PT" });

function rgb(hex) {
  const value = hex.slice(1);
  return {
    red: Number.parseInt(value.slice(0, 2), 16) / 255,
    green: Number.parseInt(value.slice(2, 4), 16) / 255,
    blue: Number.parseInt(value.slice(4, 6), 16) / 255,
  };
}

export function renderTextStyle(style) {
  const out = {};
  if (style === undefined) return out;
  for (const flag of ["bold", "italic", "underline", "strikethrough", "smallCaps"]) {
    if (typeof style[flag] === "boolean") out[flag] = style[flag];
  }
  if (typeof style.baselineOffset === "string") out.baselineOffset = style.baselineOffset;
  if (typeof style.fontSize === "number") out.fontSize = POINTS(style.fontSize);
  if (typeof style.fontFamily === "string") {
    out.weightedFontFamily = { fontFamily: style.fontFamily, weight: style.fontWeight ?? 400 };
  }
  if (typeof style.foregroundColorRgb === "string") out.foregroundColor = { color: { rgbColor: rgb(style.foregroundColorRgb) } };
  if (typeof style.backgroundColorRgb === "string") out.backgroundColor = { color: { rgbColor: rgb(style.backgroundColorRgb) } };
  if (typeof style.linkUrl === "string") out.link = { url: style.linkUrl };
  return out;
}

export function renderParagraphStyle(style) {
  const out = { namedStyleType: style.namedStyleType ?? "NORMAL_TEXT", direction: "LEFT_TO_RIGHT" };
  if (typeof style.alignment === "string") out.alignment = style.alignment;
  if (typeof style.indentStart === "number") out.indentStart = POINTS(style.indentStart);
  if (typeof style.indentFirstLine === "number") out.indentFirstLine = POINTS(style.indentFirstLine);
  if (typeof style.spaceAbove === "number") out.spaceAbove = POINTS(style.spaceAbove);
  if (typeof style.spaceBelow === "number") out.spaceBelow = POINTS(style.spaceBelow);
  if (typeof style.lineSpacing === "number") out.lineSpacing = style.lineSpacing;
  if (typeof style.headingId === "string") out.headingId = style.headingId;
  return out;
}

function renderParagraphElements(paragraph, start) {
  const elements = [];
  let offset = start;
  const source = paragraph.elements;
  for (let index = 0; index < source.length; index += 1) {
    const element = source[index];
    const last = index === source.length - 1;
    if (element.type === "textRun") {
      const content = last ? `${element.text}\n` : element.text;
      elements.push({
        startIndex: offset,
        endIndex: offset + content.length,
        textRun: { content, textStyle: renderTextStyle(element.style) },
      });
      offset += content.length;
    } else {
      elements.push({ startIndex: offset, endIndex: offset + 1, pageBreak: { textStyle: {} } });
      offset += 1;
      if (last) {
        elements.push({ startIndex: offset, endIndex: offset + 1, textRun: { content: "\n", textStyle: {} } });
        offset += 1;
      }
    }
  }
  if (source.length === 0) {
    elements.push({ startIndex: offset, endIndex: offset + 1, textRun: { content: "\n", textStyle: {} } });
  }
  return elements;
}

function renderParagraph(entry) {
  const paragraph = entry.node;
  const value = {
    elements: renderParagraphElements(paragraph, entry.start),
    paragraphStyle: renderParagraphStyle(paragraph.style ?? {}),
  };
  if (paragraph.bullet !== undefined) {
    value.bullet = { listId: paragraph.bullet.listId, nestingLevel: paragraph.bullet.nestingLevel, textStyle: {} };
  }
  return { startIndex: entry.start, endIndex: entry.end, paragraph: value };
}

function renderTable(entry) {
  const node = entry.node;
  const tableRows = entry.rows.map((row, r) => ({
    startIndex: row.start,
    endIndex: row.end,
    tableCells: row.cells.map((cell, c) => ({
      startIndex: cell.start,
      endIndex: cell.end,
      content: renderBlocks(cell.node.blocks, cell.start + 1),
      tableCellStyle: { rowSpan: 1, columnSpan: 1 },
    })),
    tableRowStyle: { minRowHeight: POINTS(0) },
  }));
  return {
    startIndex: entry.start,
    endIndex: entry.end,
    table: {
      rows: node.rows,
      columns: node.columns,
      tableRows,
      tableStyle: { tableColumnProperties: Array.from({ length: node.columns }, () => ({ widthType: "EVENLY_DISTRIBUTED" })) },
    },
  };
}

/** Renders one block array starting at `start` into StructuralElements (used for the body and for cell content). */
export function renderBlocks(blocks, start) {
  const map = { end: 0, entries: [], paragraphs: [], tables: [] };
  walk(blocks, start, map, null);
  return map.entries
    .filter((entry) => entry.parent === blocks)
    .map((entry) => {
      if (entry.type === "sectionBreak") {
        return {
          startIndex: entry.start,
          endIndex: entry.end,
          sectionBreak: {
            sectionStyle: { columnSeparatorStyle: "NONE", contentDirection: "LEFT_TO_RIGHT", sectionType: "CONTINUOUS" },
          },
        };
      }
      return entry.type === "paragraph" ? renderParagraph(entry) : renderTable(entry);
    });
}

const HEADING_SIZES = {
  TITLE: 26,
  SUBTITLE: 15,
  HEADING_1: 20,
  HEADING_2: 16,
  HEADING_3: 14,
  HEADING_4: 12,
  HEADING_5: 11,
  HEADING_6: 11,
  NORMAL_TEXT: 11,
};

export function renderNamedStyles() {
  return {
    styles: NAMED_STYLE_TYPES.map((namedStyleType) => ({
      namedStyleType,
      textStyle: {
        bold: namedStyleType.startsWith("HEADING") || namedStyleType === "TITLE",
        fontSize: POINTS(HEADING_SIZES[namedStyleType]),
        weightedFontFamily: { fontFamily: namedStyleType === "NORMAL_TEXT" ? "Arial" : "Arial", weight: 400 },
      },
      paragraphStyle: { namedStyleType, direction: "LEFT_TO_RIGHT" },
    })),
  };
}

export function renderNamedRanges(namedRanges) {
  const out = {};
  for (const named of namedRanges) {
    const bucket = out[named.name] ?? { name: named.name, namedRanges: [] };
    bucket.namedRanges.push({
      namedRangeId: named.namedRangeId,
      name: named.name,
      ranges: named.ranges.map((range) => ({ startIndex: range.startIndex, endIndex: range.endIndex, segmentId: "" })),
    });
    out[named.name] = bucket;
  }
  return out;
}

export function renderLists(lists) {
  const out = {};
  for (const list of lists) {
    out[list.listId] = {
      listProperties: {
        nestingLevels: Array.from({ length: 9 }, (unused, level) => ({
          bulletAlignment: "START",
          glyphType: list.bulletPreset.startsWith("NUMBERED") ? "DECIMAL" : "GLYPH_TYPE_UNSPECIFIED",
          glyphSymbol: list.bulletPreset.startsWith("NUMBERED") ? undefined : "●",
          glyphFormat: list.bulletPreset.startsWith("NUMBERED") ? "%0." : "%0",
          indentFirstLine: POINTS(18 * (level + 1) - 18),
          indentStart: POINTS(18 * (level + 1)),
          startNumber: 1,
          textStyle: {},
        })).map((level) => Object.fromEntries(Object.entries(level).filter(([, value]) => value !== undefined))),
      },
    };
  }
  return out;
}

export function documentStyle() {
  return {
    background: { color: {} },
    pageSize: { width: POINTS(612), height: POINTS(792) },
    marginTop: POINTS(72),
    marginBottom: POINTS(72),
    marginLeft: POINTS(72),
    marginRight: POINTS(72),
    pageNumberStart: 1,
    useCustomHeaderFooterMargins: false,
  };
}

/** The text covered by [start, end) in the document index space; paragraph boundaries become newlines. */
export function textBetween(blocks, start, end) {
  const map = indexMap(blocks);
  const parts = [];
  for (const entry of map.paragraphs) {
    if (entry.start >= end || entry.end <= start) continue;
    const textLength = entry.end - entry.start - 1;
    const from = Math.min(Math.max(start - entry.start, 0), textLength);
    const to = Math.min(Math.max(end - entry.start, 0), textLength);
    if (to > from) parts.push(paragraphText(entry.node).slice(from, to));
    else parts.push("");
  }
  return parts.join("\n");
}
