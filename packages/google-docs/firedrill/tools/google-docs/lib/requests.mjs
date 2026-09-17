// The `documents.batchUpdate` request subset: validation and application, in order, against a working copy of the
// stored block model. Sixteen kinds are implemented; every other documented Request field is rejected by name rather
// than accepted and ignored. Nothing here touches state: the caller writes the working copy back only if every request
// in the batch succeeded.

import {
  ALIGNMENTS,
  BASELINE_OFFSETS,
  BULLET_PRESETS,
  NAMED_STYLE_TYPES,
  PARAGRAPH_STYLE_FIELDS,
  TEXT_STYLE_FIELDS,
  blockCount,
  cloneStyle,
  compactElements,
  documentSize,
  indexMap,
  newParagraph,
  newTable,
  paragraphText,
  shiftRangesForDelete,
  shiftRangesForInsert,
  splitElements,
  styleAtOffset,
  tableCount,
} from "./doc-model.mjs";

export const SUPPORTED_REQUESTS = [
  "insertText",
  "deleteContentRange",
  "replaceAllText",
  "updateTextStyle",
  "updateParagraphStyle",
  "createParagraphBullets",
  "deleteParagraphBullets",
  "insertPageBreak",
  "insertTable",
  "insertTableRow",
  "insertTableColumn",
  "deleteTableRow",
  "deleteTableColumn",
  "createNamedRange",
  "deleteNamedRange",
  "replaceNamedRangeContent",
];

/** Documented Docs requests this Tool does not implement; naming one is an explicit failure, never a silent no-op. */
export const UNSUPPORTED_REQUESTS = [
  "insertInlineImage",
  "replaceImage",
  "deletePositionedObject",
  "insertInlineSheetsChart",
  "refreshSheetsChart",
  "createHeader",
  "createFooter",
  "createFootnote",
  "deleteHeader",
  "deleteFooter",
  "updateDocumentStyle",
  "updateSectionStyle",
  "insertSectionBreak",
  "mergeTableCells",
  "unmergeTableCells",
  "pinTableHeaderRows",
  "updateTableCellStyle",
  "updateTableRowStyle",
  "updateTableColumnProperties",
  "insertPerson",
  "insertRichLink",
  "insertDate",
  "createComment",
  "insertComment",
  "addCommentReply",
  "updateCommentPost",
  "deleteComment",
  "deleteCommentReply",
  "addDocumentTab",
  "deleteTab",
  "updateDocumentTabProperties",
];

export class RequestError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = "RequestError";
    this.code = code;
    this.field = field;
  }
}

const invalid = (field, message) => {
  throw new RequestError("INVALID_ARGUMENT", field, message);
};
const precondition = (field, message) => {
  throw new RequestError("FAILED_PRECONDITION", field, message);
};
const notFound = (field, message) => {
  throw new RequestError("NOT_FOUND", field, message);
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isInteger = (value) => typeof value === "number" && Number.isInteger(value);

// ---------------------------------------------------------------------------------------------
// Location and range resolution
// ---------------------------------------------------------------------------------------------

function checkSegment(value, field) {
  if (value === undefined) return;
  if (typeof value.segmentId === "string" && value.segmentId.length > 0) {
    invalid(`${field}.segmentId`, "Headers, footers and footnotes are not supported: segmentId must be empty.");
  }
  if (value.tabId !== undefined && value.tabId !== "" && value.tabId !== "t.0") {
    invalid(`${field}.tabId`, "This document has a single tab; unknown tabId.");
  }
}

function resolveLocation(request, field, map) {
  const location = request.location;
  const endOfSegment = request.endOfSegmentLocation;
  if (location !== undefined && endOfSegment !== undefined) {
    invalid(`${field}.location`, "Exactly one of location and endOfSegmentLocation must be set.");
  }
  if (location === undefined && endOfSegment === undefined) {
    invalid(`${field}.location`, "Exactly one of location and endOfSegmentLocation must be set.");
  }
  if (endOfSegment !== undefined) {
    if (!isObject(endOfSegment)) invalid(`${field}.endOfSegmentLocation`, "endOfSegmentLocation must be an object.");
    checkSegment(endOfSegment, `${field}.endOfSegmentLocation`);
    return map.end - 1;
  }
  if (!isObject(location)) invalid(`${field}.location`, "location must be an object.");
  checkSegment(location, `${field}.location`);
  if (!isInteger(location.index)) invalid(`${field}.location.index`, "location.index must be an integer.");
  return location.index;
}

function resolveRange(range, field, map, { allowFinalNewline = false } = {}) {
  if (!isObject(range)) invalid(field, "range must be an object.");
  checkSegment(range, field);
  if (!isInteger(range.startIndex)) invalid(`${field}.startIndex`, "startIndex must be an integer.");
  if (!isInteger(range.endIndex)) invalid(`${field}.endIndex`, "endIndex must be an integer.");
  const { startIndex, endIndex } = range;
  if (startIndex >= endIndex) invalid(`${field}.startIndex`, "startIndex must be less than endIndex.");
  if (startIndex < 1) invalid(`${field}.startIndex`, "The range cannot include the section break at index 0.");
  const limit = allowFinalNewline ? map.end : map.end - 1;
  if (endIndex > limit) {
    invalid(
      `${field}.endIndex`,
      allowFinalNewline
        ? `endIndex ${endIndex} is beyond the end of the document (${map.end}).`
        : "The range cannot include the newline character at the end of the segment.",
    );
  }
  return { startIndex, endIndex };
}

// ---------------------------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------------------------

function parseFieldMask(value, known, field) {
  if (typeof value !== "string" || value.trim().length === 0) invalid(field, "fields is required.");
  if (value.trim() === "*") return [...known];
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) invalid(field, "fields is required.");
  for (const name of names) {
    if (!known.includes(name)) invalid(field, `Unsupported style field: ${name}.`);
  }
  return names;
}

function magnitude(value, field, low, high) {
  if (!isObject(value) || typeof value.magnitude !== "number") invalid(field, `${field} must be a Dimension.`);
  if (value.unit !== undefined && value.unit !== "PT") invalid(field, "Only the PT unit is supported.");
  if (value.magnitude < low || value.magnitude > high) invalid(field, `${field} is out of range.`);
  return value.magnitude;
}

function colorHex(value, field) {
  if (!isObject(value) || !isObject(value.color) || !isObject(value.color.rgbColor)) {
    invalid(field, `${field} must be an OptionalColor with an rgbColor.`);
  }
  const channel = (name) => {
    const raw = value.color.rgbColor[name] ?? 0;
    if (typeof raw !== "number" || raw < 0 || raw > 1) invalid(field, `${field}.${name} must be between 0 and 1.`);
    return Math.round(raw * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel("red")}${channel("green")}${channel("blue")}`;
}

function applyTextStyleFields(target, textStyle, fields, field) {
  for (const name of fields) {
    const value = textStyle[name];
    if (value === undefined) {
      delete target[
        {
          fontSize: "fontSize",
          weightedFontFamily: "fontFamily",
          foregroundColor: "foregroundColorRgb",
          backgroundColor: "backgroundColorRgb",
          link: "linkUrl",
        }[name] ?? name
      ];
      if (name === "weightedFontFamily") delete target.fontWeight;
      continue;
    }
    if (["bold", "italic", "underline", "strikethrough", "smallCaps"].includes(name)) {
      if (typeof value !== "boolean") invalid(`${field}.${name}`, `${name} must be a boolean.`);
      target[name] = value;
    } else if (name === "baselineOffset") {
      if (!BASELINE_OFFSETS.includes(value)) invalid(`${field}.baselineOffset`, `Unknown baselineOffset ${value}.`);
      target.baselineOffset = value;
    } else if (name === "fontSize") {
      target.fontSize = magnitude(value, `${field}.fontSize`, 1, 400);
    } else if (name === "weightedFontFamily") {
      if (!isObject(value) || typeof value.fontFamily !== "string" || value.fontFamily.length === 0) {
        invalid(`${field}.weightedFontFamily`, "weightedFontFamily.fontFamily is required.");
      }
      target.fontFamily = value.fontFamily.slice(0, 64);
      if (value.weight !== undefined) {
        if (!isInteger(value.weight) || value.weight < 100 || value.weight > 900) {
          invalid(`${field}.weightedFontFamily.weight`, "weight must be a multiple of 100 between 100 and 900.");
        }
        target.fontWeight = value.weight;
      }
    } else if (name === "foregroundColor") {
      target.foregroundColorRgb = colorHex(value, `${field}.foregroundColor`);
    } else if (name === "backgroundColor") {
      target.backgroundColorRgb = colorHex(value, `${field}.backgroundColor`);
    } else if (name === "link") {
      if (!isObject(value) || typeof value.url !== "string" || value.url.length === 0 || value.url.length > 2048) {
        invalid(`${field}.link`, "Only link.url is supported.");
      }
      target.linkUrl = value.url;
    }
  }
}

function applyParagraphStyleFields(target, style, fields, field, ctx) {
  for (const name of fields) {
    const value = style[name];
    if (value === undefined) {
      if (name === "namedStyleType") {
        target.namedStyleType = "NORMAL_TEXT";
        delete target.headingId;
      } else delete target[name];
      continue;
    }
    if (name === "namedStyleType") {
      if (!NAMED_STYLE_TYPES.includes(value)) invalid(`${field}.namedStyleType`, `Unknown namedStyleType ${value}.`);
      target.namedStyleType = value;
      if (value.startsWith("HEADING") || value === "TITLE" || value === "SUBTITLE") target.headingId = ctx.nextHeadingId();
      else delete target.headingId;
    } else if (name === "alignment") {
      if (!ALIGNMENTS.includes(value)) invalid(`${field}.alignment`, `Unknown alignment ${value}.`);
      target.alignment = value;
    } else if (name === "lineSpacing") {
      if (typeof value !== "number" || value < 50 || value > 400) invalid(`${field}.lineSpacing`, "lineSpacing must be between 50 and 400.");
      target.lineSpacing = value;
    } else {
      target[name] = magnitude(value, `${field}.${name}`, 0, 720);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Primitive edits
// ---------------------------------------------------------------------------------------------

function insertTextAt(doc, index, text, ctx, field) {
  const map = indexMap(doc.blocks);
  if (index < 1) invalid(field, "Nothing can be inserted before the section break at index 0.");
  const entry = map.paragraphs.find((candidate) => index >= candidate.start && index < candidate.end);
  if (entry === null || entry === undefined) {
    invalid(field, `Index ${index} is not inside the text of this document (valid indices are 1 to ${map.end - 1}).`);
  }
  const offset = index - entry.start;
  const style = styleAtOffset(entry.node, offset);
  const { before, after } = splitElements(entry.node, offset);
  const segments = text.split("\n");
  if (segments.length === 1) {
    entry.node.elements = [...before, { type: "textRun", text, style }, ...after];
    compactElements(entry.node);
  } else {
    entry.node.elements = [...before, { type: "textRun", text: segments[0], style: cloneStyle(style) }];
    compactElements(entry.node);
    const created = [];
    for (let i = 1; i < segments.length; i += 1) {
      const paragraph = newParagraph(entry.node.style, [{ type: "textRun", text: segments[i], style: cloneStyle(style) }]);
      if (entry.node.bullet !== undefined) paragraph.bullet = { ...entry.node.bullet };
      created.push(paragraph);
    }
    const last = created[created.length - 1];
    last.elements = [...last.elements, ...after];
    compactElements(last);
    for (const paragraph of created) compactElements(paragraph);
    entry.parent.splice(entry.index + 1, 0, ...created);
  }
  checkBounds(doc, ctx);
  doc.namedRanges = shiftRangesForInsert(doc.namedRanges, index, text.length);
}

function insertBlockAt(doc, index, block, ctx, field, { allowInTable = false } = {}) {
  const map = indexMap(doc.blocks);
  if (index < 1) invalid(field, `Index ${index} is not a valid insertion point.`);
  const entry = map.paragraphs.find((candidate) => index >= candidate.start && index < candidate.end);
  if (entry === undefined) invalid(field, `Index ${index} is not inside the text of this document.`);
  if (!allowInTable && entry.cell !== null) invalid(field, "This element cannot be inserted inside a table cell.");
  const before = documentSize(doc.blocks);
  const offset = index - entry.start;
  const split = splitElements(entry.node, offset);
  const tail = newParagraph(entry.node.style, split.after);
  if (entry.node.bullet !== undefined) tail.bullet = { ...entry.node.bullet };
  entry.node.elements = split.before;
  compactElements(entry.node);
  compactElements(tail);
  entry.parent.splice(entry.index + 1, 0, block, tail);
  checkBounds(doc, ctx);
  const after = documentSize(doc.blocks);
  doc.namedRanges = shiftRangesForInsert(doc.namedRanges, index, after - before);
}

function insertPageBreakAt(doc, index, ctx, field) {
  const map = indexMap(doc.blocks);
  const entry = map.paragraphs.find((candidate) => index >= candidate.start && index < candidate.end);
  if (entry === undefined) invalid(field, `Index ${index} is not inside the text of this document.`);
  if (entry.cell !== null) invalid(field, "A page break cannot be inserted inside a table cell.");
  const offset = index - entry.start;
  const split = splitElements(entry.node, offset);
  entry.node.elements = [...split.before, { type: "pageBreak" }, ...split.after];
  compactElements(entry.node);
  checkBounds(doc, ctx);
  doc.namedRanges = shiftRangesForInsert(doc.namedRanges, index, 1);
}

/** Deletes [start, end) across one container, merging paragraphs whose newline is removed. */
function deleteRange(doc, start, end, field) {
  const map = indexMap(doc.blocks);
  const insideTable = map.tables.find((table) => start > table.start && end <= table.end - 1);
  let container = doc.blocks;
  let entries = map.entries.filter((entry) => entry.parent === doc.blocks);
  if (insideTable !== undefined) {
    let found;
    for (const row of insideTable.rows) {
      for (const cell of row.cells) {
        if (start > cell.start && end <= cell.end) found = cell;
      }
    }
    if (found === undefined) {
      invalid(field, "A range that partially covers a table can only be deleted inside a single cell.");
    }
    container = found.node.blocks;
    entries = map.entries.filter((entry) => entry.parent === container);
    const last = entries[entries.length - 1];
    if (end > last.end - 1) invalid(field, "The range cannot include the newline character at the end of the segment.");
  }
  const affected = entries.filter((entry) => entry.start < end && entry.end > start);
  for (const entry of affected) {
    if (entry.type === "table" && (start > entry.start || end < entry.end)) {
      invalid(field, "A range that partially covers a table cannot be deleted.");
    }
    if (entry.type === "sectionBreak") invalid(field, "The section break at index 0 cannot be deleted.");
  }
  const result = [];
  let pending = null;
  for (const entry of entries) {
    const touched = entry.start < end && entry.end > start;
    if (entry.type === "table") {
      if (pending !== null) invalid(field, "The newline before a table cannot be deleted.");
      if (!touched) result.push(entry.node);
      continue;
    }
    if (entry.type === "sectionBreak") {
      result.push(entry.node);
      continue;
    }
    const node = entry.node;
    if (touched) {
      const textLength = entry.end - entry.start - 1;
      const from = Math.min(Math.max(start - entry.start, 0), textLength);
      const to = Math.min(Math.max(end - entry.start, 0), textLength);
      const head = splitElements(node, from).before;
      const tail = splitElements(node, to).after;
      node.elements = [...head, ...tail];
      compactElements(node);
      const newlineDeleted = end >= entry.end;
      if (pending !== null) {
        pending.elements = [...pending.elements, ...node.elements];
        compactElements(pending);
        if (!newlineDeleted) pending = null;
        continue;
      }
      result.push(node);
      if (newlineDeleted) pending = node;
      continue;
    }
    if (pending !== null) {
      pending.elements = [...pending.elements, ...node.elements];
      compactElements(pending);
      pending = null;
      continue;
    }
    result.push(node);
  }
  if (pending !== null) invalid(field, "The range cannot include the newline character at the end of the segment.");
  container.length = 0;
  container.push(...result);
  doc.namedRanges = shiftRangesForDelete(doc.namedRanges, start, end);
}

function checkBounds(doc, ctx) {
  const size = documentSize(doc.blocks);
  if (size > ctx.limits.maxTextLength) {
    precondition("requests", `state exceeds the supported bound of ${ctx.limits.maxTextLength} characters per document`);
  }
  if (blockCount(doc.blocks) > ctx.limits.maxBlocks) {
    precondition("requests", `state exceeds the supported bound of ${ctx.limits.maxBlocks} blocks per document`);
  }
  if (tableCount(doc.blocks) > ctx.limits.maxTables) {
    precondition("requests", `state exceeds the supported bound of ${ctx.limits.maxTables} tables per document`);
  }
  if (doc.namedRanges.length > ctx.limits.maxNamedRanges) {
    precondition("requests", `state exceeds the supported bound of ${ctx.limits.maxNamedRanges} named ranges per document`);
  }
}

function styleRuns(doc, start, end, apply) {
  const map = indexMap(doc.blocks);
  for (const entry of map.paragraphs) {
    if (entry.start >= end || entry.end <= start) continue;
    const textLength = entry.end - entry.start - 1;
    const from = Math.min(Math.max(start - entry.start, 0), textLength);
    const to = Math.min(Math.max(end - entry.start, 0), textLength);
    if (to <= from) continue;
    const head = splitElements(entry.node, from).before;
    const rest = splitElements(entry.node, from).after;
    const middleParagraph = { elements: rest };
    const middle = splitElements(middleParagraph, to - from).before;
    const tail = splitElements(middleParagraph, to - from).after;
    for (const element of middle) if (element.type === "textRun") apply(element.style);
    entry.node.elements = [...head, ...middle, ...tail];
    compactElements(entry.node);
  }
}

function paragraphsTouching(doc, start, end) {
  const map = indexMap(doc.blocks);
  return map.paragraphs.filter((entry) => entry.start < end && entry.end > start);
}

function tableFromLocation(doc, location, field) {
  if (!isObject(location)) invalid(field, "tableCellLocation is required.");
  const startLocation = location.tableStartLocation;
  if (!isObject(startLocation) || !isInteger(startLocation.index)) {
    invalid(`${field}.tableStartLocation.index`, "tableStartLocation.index must be an integer.");
  }
  checkSegment(startLocation, `${field}.tableStartLocation`);
  const map = indexMap(doc.blocks);
  const table = map.tables.find((candidate) => candidate.start === startLocation.index);
  if (table === undefined) invalid(`${field}.tableStartLocation.index`, `No table starts at index ${startLocation.index}.`);
  const rowIndex = location.rowIndex ?? 0;
  const columnIndex = location.columnIndex ?? 0;
  if (!isInteger(rowIndex) || rowIndex < 0 || rowIndex >= table.node.rows) {
    invalid(`${field}.rowIndex`, `rowIndex ${rowIndex} is outside the table.`);
  }
  if (!isInteger(columnIndex) || columnIndex < 0 || columnIndex >= table.node.columns) {
    invalid(`${field}.columnIndex`, `columnIndex ${columnIndex} is outside the table.`);
  }
  return { table, rowIndex, columnIndex };
}

// ---------------------------------------------------------------------------------------------
// Request application
// ---------------------------------------------------------------------------------------------

const HANDLERS = {
  insertText(doc, request, ctx, field) {
    const text = request.text;
    if (typeof text !== "string" || text.length === 0) invalid(`${field}.text`, "text must be a non-empty string.");
    if (text.length > 20000) invalid(`${field}.text`, "text is limited to 20000 characters per request.");
    if (/[\v\r\f\0]/.test(text)) invalid(`${field}.text`, "text may contain newlines but no other control characters.");
    const index = resolveLocation(request, field, indexMap(doc.blocks));
    insertTextAt(doc, index, text, ctx, `${field}.location.index`);
    return {};
  },

  deleteContentRange(doc, request, ctx, field) {
    const map = indexMap(doc.blocks);
    const range = resolveRange(request.range, `${field}.range`, map);
    deleteRange(doc, range.startIndex, range.endIndex, `${field}.range`);
    return {};
  },

  replaceAllText(doc, request, ctx, field) {
    const contains = request.containsText;
    if (!isObject(contains)) invalid(`${field}.containsText`, "containsText is required.");
    if (contains.searchByRegex === true) {
      invalid(`${field}.containsText.searchByRegex`, "Regular-expression search is not supported.");
    }
    const needle = contains.text;
    if (typeof needle !== "string" || needle.length === 0) invalid(`${field}.containsText.text`, "containsText.text is required.");
    if (needle.includes("\n")) invalid(`${field}.containsText.text`, "containsText.text cannot span paragraphs.");
    const replacement = request.replaceText ?? "";
    if (typeof replacement !== "string" || replacement.length > 20000) {
      invalid(`${field}.replaceText`, "replaceText must be a string of at most 20000 characters.");
    }
    const matchCase = contains.matchCase === true;
    const map = indexMap(doc.blocks);
    const hits = [];
    for (const entry of map.paragraphs) {
      const text = paragraphText(entry.node);
      const haystack = matchCase ? text : text.toLowerCase();
      const pattern = matchCase ? needle : needle.toLowerCase();
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(pattern, from);
        if (at < 0) break;
        hits.push({ entry, offset: at });
        from = at + pattern.length;
      }
    }
    for (let index = hits.length - 1; index >= 0; index -= 1) {
      const { entry, offset } = hits[index];
      const style = styleAtOffset(entry.node, offset + 1);
      const head = splitElements(entry.node, offset).before;
      const rest = splitElements(entry.node, offset).after;
      const tail = splitElements({ elements: rest }, needle.length).after;
      entry.node.elements =
        replacement.length === 0 ? [...head, ...tail] : [...head, { type: "textRun", text: replacement, style }, ...tail];
      compactElements(entry.node);
      const absolute = entry.start + offset;
      doc.namedRanges = shiftRangesForDelete(doc.namedRanges, absolute, absolute + needle.length);
      if (replacement.length > 0) doc.namedRanges = shiftRangesForInsert(doc.namedRanges, absolute, replacement.length);
    }
    checkBounds(doc, ctx);
    return { replaceAllText: { occurrencesChanged: hits.length } };
  },

  updateTextStyle(doc, request, ctx, field) {
    const map = indexMap(doc.blocks);
    const range = resolveRange(request.range, `${field}.range`, map, { allowFinalNewline: true });
    const textStyle = request.textStyle ?? {};
    if (!isObject(textStyle)) invalid(`${field}.textStyle`, "textStyle must be an object.");
    const fields = parseFieldMask(request.fields, TEXT_STYLE_FIELDS, `${field}.fields`);
    const probe = {};
    applyTextStyleFields(probe, textStyle, fields, `${field}.textStyle`);
    styleRuns(doc, range.startIndex, range.endIndex, (style) => {
      applyTextStyleFields(style, textStyle, fields, `${field}.textStyle`);
    });
    return {};
  },

  updateParagraphStyle(doc, request, ctx, field) {
    const map = indexMap(doc.blocks);
    const range = resolveRange(request.range, `${field}.range`, map, { allowFinalNewline: true });
    const style = request.paragraphStyle ?? {};
    if (!isObject(style)) invalid(`${field}.paragraphStyle`, "paragraphStyle must be an object.");
    const fields = parseFieldMask(request.fields, PARAGRAPH_STYLE_FIELDS, `${field}.fields`);
    for (const entry of paragraphsTouching(doc, range.startIndex, range.endIndex)) {
      applyParagraphStyleFields(entry.node.style, style, fields, `${field}.paragraphStyle`, ctx);
    }
    return {};
  },

  createParagraphBullets(doc, request, ctx, field) {
    const map = indexMap(doc.blocks);
    const range = resolveRange(request.range, `${field}.range`, map, { allowFinalNewline: true });
    const preset = request.bulletPreset ?? "BULLET_DISC_CIRCLE_SQUARE";
    if (!BULLET_PRESETS.includes(preset)) invalid(`${field}.bulletPreset`, `Unknown bulletPreset ${preset}.`);
    let list = doc.lists.find((entry) => entry.bulletPreset === preset);
    if (list === undefined) {
      list = { listId: ctx.nextListId(), bulletPreset: preset };
      doc.lists.push(list);
    }
    for (const entry of paragraphsTouching(doc, range.startIndex, range.endIndex)) {
      const indent = entry.node.style.indentStart ?? 0;
      entry.node.bullet = { listId: list.listId, nestingLevel: Math.min(8, Math.floor(indent / 18)) };
    }
    return {};
  },

  deleteParagraphBullets(doc, request, ctx, field) {
    const map = indexMap(doc.blocks);
    const range = resolveRange(request.range, `${field}.range`, map, { allowFinalNewline: true });
    for (const entry of paragraphsTouching(doc, range.startIndex, range.endIndex)) delete entry.node.bullet;
    const used = new Set();
    const collect = (blocks) => {
      for (const block of blocks) {
        if (block.kind === "paragraph" && block.bullet !== undefined) used.add(block.bullet.listId);
        else if (block.kind === "table") for (const row of block.cells) for (const cell of row) collect(cell.blocks);
      }
    };
    collect(doc.blocks);
    doc.lists = doc.lists.filter((entry) => used.has(entry.listId));
    return {};
  },

  insertPageBreak(doc, request, ctx, field) {
    const index = resolveLocation(request, field, indexMap(doc.blocks));
    if (index < 1) invalid(`${field}.location.index`, "Nothing can be inserted before the section break at index 0.");
    insertPageBreakAt(doc, index, ctx, `${field}.location.index`);
    return {};
  },

  insertTable(doc, request, ctx, field) {
    const rows = request.rows;
    const columns = request.columns;
    if (!isInteger(rows) || rows < 1 || rows > ctx.limits.maxTableRows) {
      invalid(`${field}.rows`, `rows must be between 1 and ${ctx.limits.maxTableRows}.`);
    }
    if (!isInteger(columns) || columns < 1 || columns > ctx.limits.maxTableColumns) {
      invalid(`${field}.columns`, `columns must be between 1 and ${ctx.limits.maxTableColumns}.`);
    }
    const index = resolveLocation(request, field, indexMap(doc.blocks));
    insertBlockAt(doc, index, newTable(rows, columns), ctx, `${field}.location.index`);
    return {};
  },

  insertTableRow(doc, request, ctx, field) {
    const { table, rowIndex } = tableFromLocation(doc, request.tableCellLocation, `${field}.tableCellLocation`);
    if (table.node.rows >= ctx.limits.maxTableRows) {
      precondition(`${field}.tableCellLocation`, `state exceeds the supported bound of ${ctx.limits.maxTableRows} table rows`);
    }
    const at = request.insertBelow === true ? rowIndex + 1 : rowIndex;
    const row = Array.from({ length: table.node.columns }, () => ({
      blocks: [newParagraph({ namedStyleType: "NORMAL_TEXT" })],
    }));
    const anchor = at >= table.node.rows ? table.end - 1 : table.rows[at].start;
    const before = documentSize(doc.blocks);
    table.node.cells.splice(at, 0, row);
    table.node.rows += 1;
    checkBounds(doc, ctx);
    doc.namedRanges = shiftRangesForInsert(doc.namedRanges, anchor, documentSize(doc.blocks) - before);
    return {};
  },

  insertTableColumn(doc, request, ctx, field) {
    const { table, columnIndex } = tableFromLocation(doc, request.tableCellLocation, `${field}.tableCellLocation`);
    if (table.node.columns >= ctx.limits.maxTableColumns) {
      precondition(`${field}.tableCellLocation`, `state exceeds the supported bound of ${ctx.limits.maxTableColumns} table columns`);
    }
    const at = request.insertRight === true ? columnIndex + 1 : columnIndex;
    const before = documentSize(doc.blocks);
    for (const row of table.node.cells) row.splice(at, 0, { blocks: [newParagraph({ namedStyleType: "NORMAL_TEXT" })] });
    table.node.columns += 1;
    checkBounds(doc, ctx);
    doc.namedRanges = shiftRangesForInsert(doc.namedRanges, table.start, documentSize(doc.blocks) - before);
    return {};
  },

  deleteTableRow(doc, request, ctx, field) {
    const { table, rowIndex } = tableFromLocation(doc, request.tableCellLocation, `${field}.tableCellLocation`);
    if (table.node.rows === 1) {
      deleteTable(doc, table);
      return {};
    }
    const row = table.rows[rowIndex];
    table.node.cells.splice(rowIndex, 1);
    table.node.rows -= 1;
    doc.namedRanges = shiftRangesForDelete(doc.namedRanges, row.start, row.end);
    return {};
  },

  deleteTableColumn(doc, request, ctx, field) {
    const { table, columnIndex } = tableFromLocation(doc, request.tableCellLocation, `${field}.tableCellLocation`);
    if (table.node.columns === 1) {
      deleteTable(doc, table);
      return {};
    }
    const before = documentSize(doc.blocks);
    for (const row of table.node.cells) row.splice(columnIndex, 1);
    table.node.columns -= 1;
    const removed = before - documentSize(doc.blocks);
    doc.namedRanges = shiftRangesForDelete(doc.namedRanges, table.start, table.start + removed);
    return {};
  },

  createNamedRange(doc, request, ctx, field) {
    const name = request.name;
    if (typeof name !== "string" || name.length === 0 || name.length > 256) {
      invalid(`${field}.name`, "name must be between 1 and 256 characters.");
    }
    const map = indexMap(doc.blocks);
    const range = resolveRange(request.range, `${field}.range`, map, { allowFinalNewline: true });
    const namedRangeId = ctx.nextNamedRangeId();
    doc.namedRanges.push({ namedRangeId, name, ranges: [{ startIndex: range.startIndex, endIndex: range.endIndex }] });
    checkBounds(doc, ctx);
    return { createNamedRange: { namedRangeId } };
  },

  deleteNamedRange(doc, request, ctx, field) {
    const hasId = typeof request.namedRangeId === "string" && request.namedRangeId.length > 0;
    const hasName = typeof request.name === "string" && request.name.length > 0;
    if (hasId === hasName) invalid(`${field}.namedRangeId`, "Exactly one of namedRangeId and name must be set.");
    if (hasId) {
      const found = doc.namedRanges.some((named) => named.namedRangeId === request.namedRangeId);
      if (!found) notFound(`${field}.namedRangeId`, `Named range ${request.namedRangeId} was not found.`);
      doc.namedRanges = doc.namedRanges.filter((named) => named.namedRangeId !== request.namedRangeId);
      return {};
    }
    doc.namedRanges = doc.namedRanges.filter((named) => named.name !== request.name);
    return {};
  },

  replaceNamedRangeContent(doc, request, ctx, field) {
    const text = request.text;
    if (typeof text !== "string" || text.length > 20000) invalid(`${field}.text`, "text must be a string of at most 20000 characters.");
    if (text.includes("\n")) invalid(`${field}.text`, "replaceNamedRangeContent cannot insert paragraph breaks.");
    const byId = typeof request.namedRangeId === "string" && request.namedRangeId.length > 0;
    const byName = typeof request.namedRangeName === "string" && request.namedRangeName.length > 0;
    if (byId === byName) invalid(`${field}.namedRangeId`, "Exactly one of namedRangeId and namedRangeName must be set.");
    const matches = (named) => (byId ? named.namedRangeId === request.namedRangeId : named.name === request.namedRangeName);
    const targets = doc.namedRanges.filter(matches);
    if (targets.length === 0) notFound(`${field}.namedRangeId`, "The named range was not found.");
    // The targets are taken out of the list first so the delete/insert pair does not collapse them, then put back
    // covering the replacement text — which is how the range survives its own replacement in Docs.
    doc.namedRanges = doc.namedRanges.filter((named) => !matches(named));
    const restored = targets.map((named) => ({ ...named, ranges: [] }));
    const spans = targets.flatMap((named, index) => named.ranges.map((range) => ({ ...range, owner: index })));
    spans.sort((left, right) => right.startIndex - left.startIndex);
    for (const span of spans) {
      deleteRange(doc, span.startIndex, span.endIndex, `${field}.namedRangeId`);
      if (text.length > 0) {
        insertTextAt(doc, span.startIndex, text, ctx, `${field}.text`);
        restored[span.owner].ranges.push({ startIndex: span.startIndex, endIndex: span.startIndex + text.length });
      }
    }
    for (const named of restored) if (named.ranges.length > 0) doc.namedRanges.push(named);
    checkBounds(doc, ctx);
    return {};
  },
};

function deleteTable(doc, table) {
  const before = documentSize(doc.blocks);
  table.parent.splice(table.index, 1);
  doc.namedRanges = shiftRangesForDelete(doc.namedRanges, table.start, table.start + (before - documentSize(doc.blocks)));
}

/**
 * Applies `requests` in order to the working copy `doc` ({ blocks, namedRanges, lists }). Throws RequestError on the
 * first failure; the caller discards the working copy so nothing is partially applied.
 */
export function applyRequests(doc, requests, ctx) {
  const replies = [];
  const kinds = [];
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const field = `requests[${index}]`;
    if (!isObject(request)) invalid(field, "Each request must be an object.");
    const names = Object.keys(request).filter((name) => request[name] !== undefined && request[name] !== null);
    if (names.length !== 1) invalid(field, "Each request must set exactly one request kind.");
    const kind = names[0];
    if (UNSUPPORTED_REQUESTS.includes(kind)) {
      invalid(`${field}.${kind}`, `The ${kind} request is not supported by this Tool.`);
    }
    if (!SUPPORTED_REQUESTS.includes(kind)) invalid(`${field}.${kind}`, `Unknown request kind ${kind}.`);
    replies.push(HANDLERS[kind](doc, request[kind], ctx, `${field}.${kind}`));
    kinds.push(kind);
  }
  checkStorageBounds(doc);
  return { replies, kinds };
}

// The `bodies` state schema's own bounds. A batch whose derived body would break them (for example 100 alternating
// 1-character updateTextStyle ranges splitting one paragraph into more than 500 runs, or one paragraph of more than
// 20,000 characters in a single style) would otherwise fail the state write with an opaque 500. Checked once per batch,
// after every request has been applied and before anything is committed, in time linear in the body.
const STORAGE_BOUNDS = { blocks: 2000, elementsPerParagraph: 500, charactersPerRun: 20_000, blocksPerCell: 100, lists: 50, namedRanges: 100, rangesPerNamedRange: 100 };

function checkParagraphStorage(paragraph) {
  const elements = paragraph.elements ?? [];
  if (elements.length > STORAGE_BOUNDS.elementsPerParagraph) {
    precondition("requests", `state exceeds the supported bound of ${STORAGE_BOUNDS.elementsPerParagraph} differently styled text runs per paragraph`);
  }
  for (const element of elements) {
    if (typeof element.text === "string" && element.text.length > STORAGE_BOUNDS.charactersPerRun) {
      precondition("requests", `state exceeds the supported bound of ${STORAGE_BOUNDS.charactersPerRun} characters per text run of one style in a paragraph`);
    }
  }
}

function checkStorageBounds(doc) {
  if (doc.blocks.length > STORAGE_BOUNDS.blocks) {
    precondition("requests", `state exceeds the supported bound of ${STORAGE_BOUNDS.blocks} blocks per document`);
  }
  for (const block of doc.blocks) {
    if (block.kind === "paragraph") checkParagraphStorage(block);
    if (block.kind !== "table") continue;
    for (const row of block.cells) {
      for (const cell of row) {
        if (cell.blocks.length > STORAGE_BOUNDS.blocksPerCell) {
          precondition("requests", `state exceeds the supported bound of ${STORAGE_BOUNDS.blocksPerCell} paragraphs per table cell`);
        }
        for (const inner of cell.blocks) checkParagraphStorage(inner);
      }
    }
  }
  if ((doc.lists ?? []).length > STORAGE_BOUNDS.lists) {
    precondition("requests", `state exceeds the supported bound of ${STORAGE_BOUNDS.lists} lists per document`);
  }
  const namedRanges = doc.namedRanges ?? [];
  if (namedRanges.length > STORAGE_BOUNDS.namedRanges) {
    precondition("requests", `state exceeds the supported bound of ${STORAGE_BOUNDS.namedRanges} named ranges per document`);
  }
  for (const namedRange of namedRanges) {
    if ((namedRange.ranges ?? []).length > STORAGE_BOUNDS.rangesPerNamedRange) {
      precondition("requests", `state exceeds the supported bound of ${STORAGE_BOUNDS.rangesPerNamedRange} ranges per named range`);
    }
  }
}
