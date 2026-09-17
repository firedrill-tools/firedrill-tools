// Chunking strategies basic / by_title / by_page over a partitioned element list.
import { gzipBase64Json } from "../gzip.mjs";
import { utf8Length } from "../util.mjs";

/** Response budget assumed when the caller passes none (`meta/limits.response_bytes` default). */
const DEFAULT_BUDGET = 921600;

const MERGED_ARRAYS = ["link_texts", "link_urls", "emphasized_text_contents", "emphasized_text_tags"];

/**
 * The metadata one chunk group shares: built once per group (its gzip included), measured once, and copied by reference into
 * every piece — the merged link/emphasis arrays, e-mail recipient lists and `orig_elements` are never rebuilt per piece.
 * @param includeOrig true to compute the gzip+base64 `orig_elements` of the group, false to omit it
 */
function chunkMetadata(originals, includeOrig, budget) {
  const first = originals[0].metadata;
  const metadata = { filename: first.filename, filetype: first.filetype, languages: first.languages, page_number: first.page_number, last_modified: first.last_modified };
  for (const key of ["parent_id", "sent_from", "sent_to", "cc_recipient", "bcc_recipient", "subject", "email_message_id"]) if (first[key] !== undefined) metadata[key] = first[key];
  // Merged arrays are copied item by item (never spread as call arguments) and stop at the response budget: every item costs
  // at least its characters plus a quote pair and a comma in each piece that carries it.
  let bytes = 0;
  for (const key of MERGED_ARRAYS) {
    const merged = [];
    for (const element of originals) {
      const values = element.metadata[key];
      if (!Array.isArray(values)) continue;
      for (let i = 0; i < values.length; i += 1) {
        const value = values[i];
        bytes += (typeof value === "string" ? value.length : 1) + 3;
        if (bytes > budget) return null;
        merged.push(value);
      }
    }
    if (merged.length > 0) metadata[key] = merged;
  }
  if (includeOrig) metadata.orig_elements = gzipBase64Json(originals);
  return metadata;
}

/** UTF-8 bytes one copy of a chunk group's metadata costs in the response. */
const metadataBytes = (metadata) => utf8Length(JSON.stringify(metadata));

/** Splits `text` into pieces of at most `max` characters, each after the first prefixed with the previous tail. */
function splitOversized(text, max, overlap) {
  const pieces = [];
  let start = 0;
  let prefix = "";
  while (start < text.length || pieces.length === 0) {
    const room = Math.max(1, max - prefix.length);
    const piece = prefix + text.slice(start, start + room);
    pieces.push(piece);
    start += room;
    prefix = overlap > 0 ? piece.slice(-overlap) : "";
  }
  return pieces;
}

/** Sections: element groups that never share a chunk. */
function sections(elements, options) {
  const out = [];
  let current = [];
  let lastPage = null;
  let lastTitleDepth = null;
  for (const element of elements) {
    if (element.type === "PageBreak") continue;
    const page = element.metadata.page_number;
    const pageChanged = lastPage !== null && page !== lastPage;
    let boundary = false;
    if (options.strategy === "by_title") boundary = element.type === "Title" || (pageChanged && !options.multipageSections);
    else if (options.strategy === "by_page") boundary = pageChanged;
    if (boundary && current.length > 0) {
      out.push(current);
      current = [];
    }
    current.push(element);
    lastPage = page;
    if (element.type === "Title") lastTitleDepth = element.metadata.category_depth ?? 0;
  }
  if (current.length > 0) out.push(current);
  if (options.strategy === "by_title" && options.combineUnderNChars > 0) {
    // Running length and table flag of the last combined section: O(total elements), never re-reduced.
    const combined = [];
    let prevLength = 0;
    let prevHasTable = false;
    for (const section of out) {
      const previous = combined.length > 0 ? combined[combined.length - 1] : null;
      let length = -2;
      let hasTable = false;
      for (const e of section) {
        length += e.text.length + 2;
        if (e.type === "Table") hasTable = true;
      }
      if (previous !== null && prevLength < options.combineUnderNChars && prevLength + 2 + length <= options.combineUnderNChars && !prevHasTable && !hasTable) {
        for (const element of section) previous.push(element);
        prevLength += 2 + length;
      } else {
        combined.push(section);
        prevLength = length;
        prevHasTable = hasTable;
      }
    }
    return combined;
  }
  void lastTitleDepth;
  return out;
}

/** @param metadata the table's shared chunk metadata (already accounted against the budget by the caller). */
function tableChunks(element, options, idOf, metadata) {
  const out = [];
  const max = options.maxCharacters;
  if (element.text.length <= max) {
    out.push({ type: "Table", element_id: idOf(element.text), text: element.text, metadata: { ...metadata, text_as_html: element.metadata.text_as_html } });
    return out;
  }
  const rows = element.text.split("\n");
  const htmlRows = typeof element.metadata.text_as_html === "string" ? element.metadata.text_as_html.replace(/^<table>|<\/table>$/g, "").split("</tr>").filter((r) => r.length > 0).map((r) => `${r}</tr>`) : [];
  let text = "";
  let html = "";
  let first = true;
  const emit = () => {
    const piece = { ...metadata };
    if (html.length > 0) piece.text_as_html = `<table>${html}</table>`;
    if (!first) piece.is_continuation = true;
    out.push({ type: "TableChunk", element_id: idOf(text), text, metadata: piece });
    first = false;
    text = "";
    html = "";
  };
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.length > max) {
      // A row longer than max_characters becomes its own run of pieces; its markup rides with the first piece.
      if (text.length > 0) emit();
      for (let start = 0; start < row.length; start += max) {
        text = row.slice(start, start + max);
        if (start === 0 && htmlRows[i] !== undefined) html = htmlRows[i];
        emit();
      }
      continue;
    }
    if (text.length > 0 && text.length + 1 + row.length > max) emit();
    text = text.length > 0 ? `${text}\n${row}` : row;
    if (htmlRows[i] !== undefined) html += htmlRows[i];
  }
  if (text.length > 0) emit();
  return out;
}

/** Lower bound of the JSON bytes one chunk costs besides its text and metadata: `{"type":…,"element_id":"<32 hex>","text":"","metadata":},`. */
const CHUNK_OVERHEAD = 90;

/**
 * Size of the pieces `splitOversized(text, max, overlap)` would build, computed arithmetically before any piece exists:
 * the first piece holds `max` characters, every later one `max - overlap` new characters after an `overlap` prefix.
 */
export function splitSize(length, max, overlap) {
  const count = length <= max ? 1 : Math.ceil((length - max) / (max - overlap)) + 1;
  return { count, chars: length + (count - 1) * overlap };
}

/**
 * @param elements partitioned elements (PageBreak elements are dropped)
 * @param options { strategy, maxCharacters, newAfterNChars, overlap, overlapAll, combineUnderNChars, multipageSections, includeOrigElements, responseBudget, chunkSizing? }
 * @param idOf (text) => element id for a chunk
 * @returns { ok: true, elements } or { ok: false, code: "RESPONSE_TOO_LARGE", message } when the pieces of a chunk group (a
 *   lower bound of the response, settled before any piece of that group is built) would pass the response budget. Two things
 *   multiply: an overlap close to `max_characters` repeats the text up to `max_characters` times, and every piece carries a
 *   copy of the group's metadata (merged link and emphasis arrays, e-mail recipients, `orig_elements`). The text size is
 *   arithmetic; the metadata is built once per group — linear in that group's elements — measured once and multiplied by the
 *   piece count. Per group the work before the check is bounded by the group's input, never by the piece count.
 */
export function chunkElements(elements, options, idOf) {
  const out = [];
  const includeOrig = options.includeOrigElements;
  const budget = typeof options.responseBudget === "number" ? options.responseBudget : DEFAULT_BUDGET;
  // The running chunk size is shared across the files of one request when the caller passes `chunkSizing`, so 32 files
  // cannot each build a budget's worth of pieces before the response is measured.
  const sizing = options.chunkSizing ?? { chars: 0, count: 0 };
  let overflow = null;
  const account = (count, chars, metaBytes) => {
    sizing.count += count;
    sizing.chars += chars + count * metaBytes;
    const bytes = sizing.chars + sizing.count * CHUNK_OVERHEAD;
    if (bytes > budget) overflow = { ok: false, code: "RESPONSE_TOO_LARGE", message: `Partition output of at least ${bytes} bytes exceeds the ${budget} byte response limit; upload fewer or smaller files, raise max_characters or lower overlap` };
    return overflow === null;
  };
  const tooMany = () => {
    overflow = { ok: false, code: "RESPONSE_TOO_LARGE", message: `Partition output with merged link and emphasis metadata exceeds the ${budget} byte response limit; upload fewer or smaller files or raise max_characters` };
  };
  for (const section of sections(elements, options)) {
    if (overflow !== null) break;
    let texts = [];
    let originals = [];
    let currentLength = 0; // texts.join("\n\n").length, maintained incrementally
    let previousText = null;
    const flush = () => {
      if (originals.length === 0) return;
      const joined = texts.join("\n\n");
      const prefix = options.overlapAll && options.overlap > 0 && previousText !== null ? previousText.slice(-options.overlap) : "";
      const size = splitSize(prefix.length + joined.length, options.maxCharacters, options.overlap);
      const metadata = chunkMetadata(originals, includeOrig, budget);
      if (metadata === null) return tooMany();
      if (!account(size.count, size.chars, metadataBytes(metadata))) return;
      const pieces = splitOversized(prefix + joined, options.maxCharacters, options.overlap);
      for (let index = 0; index < pieces.length; index += 1) {
        const piece = { ...metadata };
        if (index > 0) piece.is_continuation = true;
        out.push({ type: "CompositeElement", element_id: idOf(pieces[index]), text: pieces[index], metadata: piece });
      }
      previousText = pieces[pieces.length - 1];
      texts = [];
      originals = [];
      currentLength = 0;
    };
    for (const element of section) {
      if (element.type === "Table") {
        flush();
        if (overflow !== null) break;
        // Table pieces never overlap (linear in the table text and its markup); at least one piece per max_characters window.
        const tableSize = splitSize(element.text.length, options.maxCharacters, 0);
        const metadata = chunkMetadata([element], includeOrig, budget);
        if (metadata === null) {
          tooMany();
          break;
        }
        const html = typeof element.metadata.text_as_html === "string" ? element.metadata.text_as_html.length : 0;
        if (!account(tableSize.count, tableSize.chars + html, metadataBytes(metadata))) break;
        for (const piece of tableChunks(element, options, idOf, metadata)) out.push(piece);
        previousText = null;
        continue;
      }
      if (texts.length > 0 && (currentLength >= options.newAfterNChars || currentLength + 2 + element.text.length > options.maxCharacters)) flush();
      if (overflow !== null) break;
      currentLength += (texts.length === 0 ? 0 : 2) + element.text.length;
      texts.push(element.text);
      originals.push(element);
    }
    if (overflow === null) flush();
  }
  if (overflow !== null) return overflow;
  return { ok: true, elements: out };
}
